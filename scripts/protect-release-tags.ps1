#requires -Version 5.1
<#
.SYNOPSIS
  Restore Veyra release-tag protection for organization ownership.

.DESCRIPTION
  Target design (post-transfer):
    * "Protect release tag creation" (new): tag ruleset, active, include
      exactly [refs/tags/v*] with an empty exclude list, only the
      `creation` rule, exactly one bypass actor - User -ActorLogin
      (default tang-vu), bypass_mode always.
    * "Protect release tags" (existing): keeps update/deletion/
      non_fast_forward, loses the `creation` rule, no bypass actors,
      same exact ref scope.

  Apply order avoids any protection gap: the creation ruleset is created
  (or verified) BEFORE `creation` is removed from the existing ruleset.
  During the overlap both rulesets enforce creation - union semantics keep
  creation denied for anyone except the bypass actor. The existing
  ruleset's update/deletion/non_fast_forward protection is never lifted.

  Default mode is DRY-RUN: snapshots host state, prints the planned diff,
  writes nothing. Pass -Apply to perform the changes (maintainer only).

  Safety model (what the script actually does):
    * A fresh snapshot is taken at the start of THIS run; the snapshot
      file written to disk is evidence for review, not a binding for any
      later run. A later -Apply run re-snapshots and re-plans from live
      state, so a stale dry-run file can never authorize a write.
    * If preflight cannot verify something it must know (ambiguous
      ruleset names, unreadable repository ruleset details, unreadable
      inherited rulesets that may scope release tags, or missing fields
      on the ruleset it would rewrite), the run is BLOCKED: dry-run
      prints the reason and -Apply throws before any POST/PUT.
    * Immediately before the first write, -Apply re-fetches the snapshot
      and refuses if the host changed since this run's snapshot.
    * Immediately before each PUT, that ruleset is re-fetched and
      compared against the snapshot version; drift refuses the write
      rather than overwriting somebody else's change.
    * Every written object is read back and validated against the target
      design before the next step runs.
    * The script never creates, moves, or deletes a tag and never touches
      "Protect main" or any other ruleset.

.EXAMPLE
  ./scripts/protect-release-tags.ps1                    # dry-run
  ./scripts/protect-release-tags.ps1 -Apply             # apply (maintainer)
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Repo = "Ontixa/veyra",
  [string]$ActorLogin = "tang-vu",
  [string]$ProtectTagsName = "Protect release tags",
  [string]$CreationName = "Protect release tag creation",
  [string]$TagPattern = "refs/tags/v*",
  [string]$SnapshotDir = ".",
  # Test transport: point at a fake GitHub CLI. Defaults keep the real gh.
  [string]$GhExe = "gh",
  [string[]]$GhPrefixArgs = @()
)

$ErrorActionPreference = "Stop"
$ApiHeaders = @(
  "-H", "Accept: application/vnd.github+json",
  "-H", "X-GitHub-Api-Version: 2026-03-10"
)

function Invoke-GhApi {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [string]$Method = "GET",
    [object]$Body = $null,
    [switch]$Optional
  )
  $args = @("api", "-X", $Method, $Path) + $ApiHeaders
  $tmp = $null
  if ($null -ne $Body) {
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, ($Body | ConvertTo-Json -Depth 20 -Compress),
      (New-Object System.Text.UTF8Encoding($false)))
    $args += @("--input", $tmp)
  }
  $errTmp = [IO.Path]::GetTempFileName()
  try {
    # PS 5.1 turns native stderr into a terminating NativeCommandError
    # under EAP=Stop, even when redirected. Relax EAP around the call so
    # $LASTEXITCODE and stdout stay accurate; stderr lands in the file.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $out = & $GhExe @GhPrefixArgs @args 2>$errTmp
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prev
    }
    $errText = (Get-Content $errTmp -Raw -ErrorAction SilentlyContinue)
    if ($code -ne 0) {
      if ($Optional) { return $null }
      throw "gh api $Method $Path failed (exit ${code}): $errText"
    }
    if ([string]::IsNullOrWhiteSpace($out)) { return $null }
    return ($out | ConvertFrom-Json)
  } finally {
    if ($tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
    Remove-Item -Force $errTmp -ErrorAction SilentlyContinue
  }
}

# Paginated list read: `api --paginate -q '.[]'` emits one JSON value per
# line across every page.
function Invoke-GhApiAll {
  param([Parameter(Mandatory)] [string]$Path)
  $args = @("api", "--paginate", "-q", ".[]", $Path) + $ApiHeaders
  $errTmp = [IO.Path]::GetTempFileName()
  try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $out = & $GhExe @GhPrefixArgs @args 2>$errTmp
      $code = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prev
    }
    $errText = (Get-Content $errTmp -Raw -ErrorAction SilentlyContinue)
    if ($code -ne 0) {
      throw "gh api --paginate $Path failed (exit ${code}): $errText"
    }
  } finally {
    Remove-Item -Force $errTmp -ErrorAction SilentlyContinue
  }
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($out)) {
    $text = "$line".Trim()
    if ($text.Length -gt 0) {
      $items.Add(($text | ConvertFrom-Json))
    }
  }
  return $items
}

# Full ruleset view: repository-source rulesets with detail, plus parent
# (Organization or higher) summaries that also apply. A parent detail is
# fetched through the org endpoint when readable; unreadable parents are
# recorded, never silently dropped.
function Get-RulesetSnapshot {
  param([string]$Repo)
  $owner = $Repo.Split('/')[0]
  $summaries = @(
    Invoke-GhApiAll "repos/$Repo/rulesets?includes_parents=true&per_page=100"
  )
  $repoRulesets = New-Object System.Collections.Generic.List[object]
  $inherited = New-Object System.Collections.Generic.List[object]
  $failed = New-Object System.Collections.Generic.List[string]
  foreach ($s in $summaries) {
    $sourceType = $s.source_type
    if ([string]::IsNullOrEmpty($sourceType)) { $sourceType = "Repository" }
    if ($sourceType -eq "Repository") {
      $d = Invoke-GhApi "repos/$Repo/rulesets/$($s.id)" -Optional
      if ($null -ne $d) {
        $repoRulesets.Add($d)
      } else {
        $failed.Add([string]$s.name)
      }
    } else {
      $d = $null
      if ($sourceType -eq "Organization") {
        $d = Invoke-GhApi "orgs/$owner/rulesets/$($s.id)" -Optional
      }
      $inherited.Add([PSCustomObject]@{
          id          = $s.id
          name        = $s.name
          target      = $s.target
          source_type = $sourceType
          detail      = $d
        })
    }
  }
  [PSCustomObject]@{
    TakenAt       = (Get-Date).ToUniversalTime().ToString("o")
    Repo          = $Repo
    Rulesets      = @($repoRulesets | Sort-Object id)
    Inherited     = @($inherited | Sort-Object id)
    FailedDetails = @($failed)
  }
}

function Resolve-ActorId {
  param([string]$Login)
  $user = Invoke-GhApi "users/$Login"
  if (-not $user.id) { throw "could not resolve numeric ID for user $Login" }
  return [int64]$user.id
}

function Test-FieldPresent {
  param($Obj, [string]$Name)
  return (
    $null -ne $Obj -and
    $Obj.PSObject.Properties.Name -contains $Name -and
    $null -ne $Obj.$Name
  )
}

# include must be exactly [Pattern] and exclude exactly empty.
function Test-RefScope {
  param($Ruleset, [string]$Pattern)
  if (-not (Test-FieldPresent $Ruleset "conditions")) { return $false }
  $ref = $Ruleset.conditions.ref_name
  if ($null -eq $ref) { return $false }
  $inc = @()
  if ($null -ne $ref.include) { $inc = @($ref.include) }
  $exc = @()
  if ($null -ne $ref.exclude) { $exc = @($ref.exclude) }
  return ($inc.Count -eq 1 -and $inc[0] -eq $Pattern -and $exc.Count -eq 0)
}

# Whether a ref_name include entry can match at least one refs/tags/v*
# ref (partial overlap still widens the ruleset's control).
function Test-IncludeOverlap {
  param($Entry, [string]$Pattern)
  if ($Entry -eq "~ALL") { return $true }
  $s = [string]$Entry
  if ([string]::IsNullOrEmpty($s) -or -not $s.StartsWith("refs/tags/")) {
    return $false
  }
  $g = $s.Substring("refs/tags/".Length)
  return ($g -eq "*" -or $g.StartsWith("v") -or $g.StartsWith("*"))
}

# Whether an exclude entry removes the ENTIRE v* scope.
function Test-ExcludeKillsAll {
  param($Entry, [string]$Pattern)
  return ($Entry -eq "~ALL" -or $Entry -eq "refs/tags/*" -or $Entry -eq $Pattern)
}

function New-CreationRulesetBody {
  param([int64]$ActorId, [string]$Name, [string]$Pattern)
  return [ordered]@{
    name          = $Name
    target        = "tag"
    enforcement   = "active"
    conditions    = @{
      ref_name = @{ include = @($Pattern); exclude = @() }
    }
    rules         = @(@{ type = "creation" })
    bypass_actors = @(
      @{
        actor_id    = $ActorId
        actor_type  = "User"
        bypass_mode = "always"
      }
    )
  }
}

function Test-CreationRuleset {
  param($Ruleset, [int64]$ActorId, [string]$Pattern)
  $types = @($Ruleset.rules | ForEach-Object { $_.type })
  $actors = @($Ruleset.bypass_actors)
  return (
    $Ruleset.target -eq "tag" -and
    $Ruleset.enforcement -eq "active" -and
    (Test-RefScope $Ruleset $Pattern) -and
    $types.Count -eq 1 -and $types[0] -eq "creation" -and
    $actors.Count -eq 1 -and
    $actors[0].actor_type -eq "User" -and
    [int64]$actors[0].actor_id -eq $ActorId -and
    $actors[0].bypass_mode -eq "always"
  )
}

function Test-ProtectTags {
  param($Ruleset, [string]$Pattern)
  $types = @($Ruleset.rules | ForEach-Object { $_.type } | Sort-Object)
  $expected = @("deletion", "non_fast_forward", "update")
  return (
    $Ruleset.target -eq "tag" -and
    $Ruleset.enforcement -eq "active" -and
    (Test-RefScope $Ruleset $Pattern) -and
    ($types -join ",") -eq ($expected -join ",") -and
    @($Ruleset.bypass_actors).Count -eq 0
  )
}

# Comparable fingerprint of the parts of a ruleset this script manages.
function Get-RulesetFingerprint {
  param($Ruleset)
  $inc = @()
  $exc = @()
  if ($null -ne $Ruleset.conditions.ref_name) {
    if ($null -ne $Ruleset.conditions.ref_name.include) {
      $inc = @($Ruleset.conditions.ref_name.include)
    }
    if ($null -ne $Ruleset.conditions.ref_name.exclude) {
      $exc = @($Ruleset.conditions.ref_name.exclude)
    }
  }
  return (@{
      target   = $Ruleset.target
      enf      = $Ruleset.enforcement
      inc      = @($inc | Sort-Object)
      exc      = @($exc | Sort-Object)
      rules    = @($Ruleset.rules | ForEach-Object { $_.type } | Sort-Object)
      bypass   = @(
        $Ruleset.bypass_actors | ForEach-Object {
          "$($_.actor_type):$($_.actor_id):$($_.bypass_mode)"
        } | Sort-Object
      )
    } | ConvertTo-Json -Depth 10 -Compress)
}

# ----------------------------- snapshot ------------------------------------
Write-Host "Snapshotting rulesets for $Repo ..."
$snap0 = Get-RulesetSnapshot -Repo $Repo
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$repoSlug = $Repo -replace "[^A-Za-z0-9_.-]", "-"
$snapFile = Join-Path $SnapshotDir "ruleset-snapshot-$repoSlug-$stamp.json"
[IO.File]::WriteAllText($snapFile,
  ($snap0 | ConvertTo-Json -Depth 20),
  (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  saved: $snapFile"

$actorId = Resolve-ActorId -Login $ActorLogin
Write-Host "  release account $ActorLogin -> user ID $actorId"

$protectAll = @($snap0.Rulesets | Where-Object { $_.name -eq $ProtectTagsName })
$creationAll = @($snap0.Rulesets | Where-Object { $_.name -eq $CreationName })

# ----------------------------- preflight ------------------------------------
# Anything the plan depends on but cannot verify blocks the run. BLOCKED
# is not a failure of the target design; it means no write may happen
# until a maintainer resolves the unknown.
$blocked = New-Object System.Collections.Generic.List[string]

foreach ($f in $snap0.FailedDetails) {
  $blocked.Add("unreadable repository ruleset detail: '$f'")
}
foreach ($n in @($ProtectTagsName, $CreationName)) {
  $count = @($snap0.Rulesets | Where-Object { $_.name -eq $n }).Count +
           @($snap0.Inherited | Where-Object { $_.name -eq $n }).Count
  if ($count -gt 1) {
    $blocked.Add("ambiguous: $count rulesets named '$n' across sources")
  }
}
foreach ($inh in $snap0.Inherited) {
  if ($inh.name -eq $ProtectTagsName -or $inh.name -eq $CreationName) {
    continue
  }
  $d = $inh.detail
  $target = $null
  if ($null -ne $d -and $null -ne $d.target) { $target = $d.target }
  elseif ($null -ne $inh.target) { $target = $inh.target }
  if ($target -ne "tag") {
    if ($null -eq $target -and $null -eq $d) {
      $blocked.Add(
        "inherited ruleset '$($inh.name)' ($($inh.source_type)) has unknown scope and unreadable detail")
    }
    continue
  }
  if ($null -eq $d) {
    $blocked.Add(
      "inherited ruleset '$($inh.name)' ($($inh.source_type)) targets tags but cannot be read")
    continue
  }
  if ($d.enforcement -ne "active") { continue }
  $ref = $d.conditions.ref_name
  if ($null -eq $ref -or $null -eq $ref.include -or $null -eq $ref.exclude) {
    $blocked.Add(
      "inherited ruleset '$($inh.name)' has unreadable ref scope")
    continue
  }
  $overlap = $false
  foreach ($e in @($ref.include)) {
    if (Test-IncludeOverlap $e $TagPattern) { $overlap = $true }
  }
  $killed = $false
  foreach ($e in @($ref.exclude)) {
    if (Test-ExcludeKillsAll $e $TagPattern) { $killed = $true }
  }
  if (-not $overlap -or $killed) { continue }
  if ($null -eq $d.rules) {
    $blocked.Add(
      "inherited ruleset '$($inh.name)' applies to $TagPattern but its rules are unreadable")
    continue
  }
  if (@($d.rules | Where-Object { $_.type -eq "creation" }).Count -gt 0) {
    $blocked.Add(
      "inherited ruleset '$($inh.name)' also governs release-tag creation")
  }
}

$protect = $null
if ($protectAll.Count -eq 0) {
  throw "ruleset '$ProtectTagsName' not found on $Repo"
}
if ($protectAll.Count -eq 1) {
  $protect = $protectAll[0]
  Write-Host "  found '$ProtectTagsName' (id $($protect.id)): rules=$(($protect.rules | ForEach-Object type) -join ','), bypass=$(@($protect.bypass_actors).Count) actor(s)"
  foreach ($f in @("target", "enforcement", "conditions", "rules", "bypass_actors")) {
    if (-not (Test-FieldPresent $protect $f)) {
      $blocked.Add(
        "ruleset '$ProtectTagsName' field '$f' is unreadable - refusing to reconstruct it")
    }
  }
}
$creation = $null
if ($creationAll.Count -eq 1) {
  $creation = $creationAll[0]
  Write-Host "  found '$CreationName' (id $($creation.id)) already exists"
}
if ($snap0.Inherited.Count -gt 0) {
  Write-Host "  $($snap0.Inherited.Count) inherited ruleset(s) also apply - reviewed above"
}

# ----------------------------- planned diff --------------------------------
$plan = New-Object System.Collections.Generic.List[string]

if ($null -eq $creation -and $creationAll.Count -eq 0) {
  $plan.Add("CREATE ruleset '$CreationName': tag/active/$TagPattern, rules=[creation], bypass=[User:$ActorLogin($actorId)/always]")
} elseif ($null -ne $creation -and -not (Test-CreationRuleset $creation $actorId $TagPattern)) {
  $plan.Add("UPDATE ruleset '$CreationName' (id $($creation.id)) to match target design")
} elseif ($null -ne $creation) {
  $plan.Add("KEEP ruleset '$CreationName' - already matches target design")
}

$protectTypes = @($protect.rules | ForEach-Object { $_.type })
if (($protectTypes -contains "creation") -or (@($protect.bypass_actors).Count -ne 0)) {
  $plan.Add("UPDATE ruleset '$ProtectTagsName' (id $($protect.id)): remove 'creation' rule, keep deletion/non_fast_forward/update, clear bypass actors")
} else {
  $plan.Add("KEEP ruleset '$ProtectTagsName' - already matches target design")
}

Write-Host "`nPlanned changes:"
$plan | ForEach-Object { Write-Host "  $_" }

if ($blocked.Count -gt 0) {
  Write-Host "`nBLOCKED - cannot verify safely:"
  $blocked | ForEach-Object { Write-Host "  $_" }
}

if (-not $Apply) {
  Write-Host "`nDRY-RUN - no writes performed. Re-run with -Apply to execute."
  return
}
if ($blocked.Count -gt 0) {
  throw "preflight is BLOCKED - no writes performed. Resolve the items above, then re-run."
}

# --------------------------- apply: guards ---------------------------------
Write-Host "`n-Apply: re-verifying host state has not changed since this run's snapshot ..."
$snapNow = Get-RulesetSnapshot -Repo $Repo
$before = (@($snap0.Rulesets) + @($snap0.Inherited) + @($snap0.FailedDetails)) |
  ConvertTo-Json -Depth 20 -Compress
$now = (@($snapNow.Rulesets) + @($snapNow.Inherited) + @($snapNow.FailedDetails)) |
  ConvertTo-Json -Depth 20 -Compress
if ($before -ne $now) {
  throw "host rulesets changed since this run's snapshot - refusing to write. Re-run to re-baseline."
}
Write-Host "  unchanged - proceeding"

# Re-fetch a ruleset and refuse to write when it drifted since snap0.
function Assert-NoDrift {
  param($SnapRuleset, [string]$Name)
  $fresh = Invoke-GhApi "repos/$Repo/rulesets/$($SnapRuleset.id)"
  if ((Get-RulesetFingerprint $SnapRuleset) -ne (Get-RulesetFingerprint $fresh)) {
    throw "ruleset '$Name' changed during apply - refusing to overwrite an unseen edit"
  }
  return $fresh
}

# ----------------------- step 1: creation ruleset --------------------------
if ($null -eq $creation) {
  $body = New-CreationRulesetBody -ActorId $actorId -Name $CreationName -Pattern $TagPattern
  Write-Host "creating '$CreationName' ..."
  $created = Invoke-GhApi "repos/$Repo/rulesets" -Method POST -Body $body
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($created.id)"
  if (-not (Test-CreationRuleset $readback $actorId $TagPattern)) {
    throw "read-back of '$CreationName' does not match target design - stopping before touching '$ProtectTagsName'"
  }
  Write-Host "  created + verified (id $($created.id))"
} elseif (-not (Test-CreationRuleset $creation $actorId $TagPattern)) {
  $freshCreation = Assert-NoDrift $creation $CreationName
  $body = New-CreationRulesetBody -ActorId $actorId -Name $CreationName -Pattern $TagPattern
  Invoke-GhApi "repos/$Repo/rulesets/$($freshCreation.id)" -Method PUT -Body $body | Out-Null
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($freshCreation.id)"
  if (-not (Test-CreationRuleset $readback $actorId $TagPattern)) {
    throw "read-back of '$CreationName' does not match target design"
  }
  Write-Host "  updated + verified '$CreationName'"
} else {
  Write-Host "'$CreationName' already correct"
}

# ----------------- step 2: strip creation from old ruleset ------------------
if (($protectTypes -contains "creation") -or (@($protect.bypass_actors).Count -ne 0)) {
  $freshProtect = Assert-NoDrift $protect $ProtectTagsName
  $newRules = @($freshProtect.rules | Where-Object { $_.type -ne "creation" })
  $body = [ordered]@{
    name          = $freshProtect.name
    target        = $freshProtect.target
    enforcement   = $freshProtect.enforcement
    conditions    = $freshProtect.conditions
    rules         = $newRules
    bypass_actors = @()
  }
  Write-Host "updating '$ProtectTagsName' (removing creation rule, clearing bypass actors) ..."
  Invoke-GhApi "repos/$Repo/rulesets/$($freshProtect.id)" -Method PUT -Body $body | Out-Null
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($freshProtect.id)"
  if (-not (Test-ProtectTags $readback $TagPattern)) {
    throw "read-back of '$ProtectTagsName' does not match target design"
  }
  Write-Host "  updated + verified"
} else {
  Write-Host "'$ProtectTagsName' already correct"
}

# ----------------------------- final snapshot -------------------------------
$snap1 = Get-RulesetSnapshot -Repo $Repo
$snap1File = $snapFile -replace "\.json$", "-after.json"
[IO.File]::WriteAllText($snap1File,
  ($snap1 | ConvertTo-Json -Depth 20),
  (New-Object System.Text.UTF8Encoding($false)))
Write-Host "`nDone. Snapshots: $snapFile -> $snap1File"
Write-Host "Verify with: node ./scripts/check-github.mjs"
