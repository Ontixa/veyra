#requires -Version 5.1
<#
.SYNOPSIS
  Restore Veyra release-tag protection for organization ownership.

.DESCRIPTION
  Target design (post-transfer):
    * "Protect release tag creation" (new): tag ruleset, active,
      refs/tags/v*, only the `creation` rule, exactly one bypass actor -
      User -ActorLogin (default tang-vu), bypass_mode always.
    * "Protect release tags" (existing): keeps update/deletion/
      non_fast_forward, loses the `creation` rule, no bypass actors.

  Apply order avoids any protection gap: the creation ruleset is created
  (or verified) BEFORE `creation` is removed from the existing ruleset.
  During the overlap both rulesets enforce creation - union semantics keep
  creation denied for anyone except the bypass actor. The existing
  ruleset's update/deletion/non_fast_forward protection is never lifted.

  Default mode is DRY-RUN: snapshots host state, prints the planned diff,
  writes nothing. Pass -Apply to perform the changes (maintainer only).

  Before any write, the script re-fetches the snapshot and refuses if the
  host changed since the dry-run snapshot. Every change is read back.
  The script never creates, moves, or deletes a tag and never touches
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
  [string]$SnapshotDir = "."
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
    [object]$Body = $null
  )
  $args = @("api", "-X", $Method, $Path) + $ApiHeaders
  $tmp = $null
  if ($null -ne $Body) {
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, ($Body | ConvertTo-Json -Depth 20 -Compress),
      (New-Object System.Text.UTF8Encoding($false)))
    $args += @("--input", $tmp)
  }
  try {
    $out = & gh @args 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "gh api $Method $Path failed (exit $LASTEXITCODE): $out"
    }
    if ([string]::IsNullOrWhiteSpace($out)) { return $null }
    return ($out | ConvertFrom-Json)
  } finally {
    if ($tmp) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
  }
}

function Get-RulesetSnapshot {
  param([string]$Repo)
  $summaries = @(Invoke-GhApi "repos/$Repo/rulesets?includes_parents=false")
  $details = foreach ($s in $summaries) {
    Invoke-GhApi "repos/$Repo/rulesets/$($s.id)"
  }
  [PSCustomObject]@{
    TakenAt  = (Get-Date).ToUniversalTime().ToString("o")
    Repo     = $Repo
    Rulesets = @($details | Sort-Object id)
  }
}

function Resolve-ActorId {
  param([string]$Login)
  $user = Invoke-GhApi "users/$Login"
  if (-not $user.id) { throw "could not resolve numeric ID for user $Login" }
  return [int64]$user.id
}

function Find-Ruleset {
  param($Snapshot, [string]$Name)
  return $Snapshot.Rulesets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
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
    @($Ruleset.conditions.ref_name.include) -contains $Pattern -and
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
    @($Ruleset.conditions.ref_name.include) -contains $Pattern -and
    ($types -join ",") -eq ($expected -join ",") -and
    @($Ruleset.bypass_actors).Count -eq 0
  )
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

# Org-level rulesets may also apply; token needs admin:org to enumerate.
try {
  $orgRulesets = @(Invoke-GhApi "orgs/$($Repo.Split('/')[0])/rulesets")
  if ($orgRulesets.Count -gt 0) {
    Write-Warning "$($orgRulesets.Count) org-level ruleset(s) exist and also apply - review them before applying."
  }
} catch {
  Write-Warning "cannot enumerate org-level rulesets (needs admin:org scope): coverage UNKNOWN"
}

$protect = Find-Ruleset $snap0 $ProtectTagsName
$creation = Find-Ruleset $snap0 $CreationName

if (-not $protect) { throw "ruleset '$ProtectTagsName' not found on $Repo" }
Write-Host "  found '$ProtectTagsName' (id $($protect.id)): rules=$(($protect.rules | ForEach-Object type) -join ','), bypass=$(@($protect.bypass_actors).Count) actor(s)"
if ($creation) {
  Write-Host "  found '$CreationName' (id $($creation.id)) already exists"
}

# ----------------------------- planned diff --------------------------------
$plan = New-Object System.Collections.Generic.List[string]

if (-not $creation) {
  $plan.Add("CREATE ruleset '$CreationName': tag/active/$TagPattern, rules=[creation], bypass=[User:$ActorLogin($actorId)/always]")
} elseif (-not (Test-CreationRuleset $creation $actorId $TagPattern)) {
  $plan.Add("UPDATE ruleset '$CreationName' (id $($creation.id)) to match target design")
} else {
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

if (-not $Apply) {
  Write-Host "`nDRY-RUN - no writes performed. Re-run with -Apply to execute."
  return
}

# --------------------------- apply: guard ----------------------------------
Write-Host "`n-Apply: re-verifying host state has not changed since snapshot ..."
$snapNow = Get-RulesetSnapshot -Repo $Repo
$before = $snap0.Rulesets | ConvertTo-Json -Depth 20 -Compress
$now = $snapNow.Rulesets | ConvertTo-Json -Depth 20 -Compress
if ($before -ne $now) {
  throw "host rulesets changed since snapshot - refusing to write. Re-run to re-baseline."
}
Write-Host "  unchanged - proceeding"

# ----------------------- step 1: creation ruleset --------------------------
if (-not $creation) {
  $body = New-CreationRulesetBody -ActorId $actorId -Name $CreationName -Pattern $TagPattern
  Write-Host "creating '$CreationName' ..."
  $created = Invoke-GhApi "repos/$Repo/rulesets" -Method POST -Body $body
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($created.id)"
  if (-not (Test-CreationRuleset $readback $actorId $TagPattern)) {
    throw "read-back of '$CreationName' does not match target design - stopping before touching '$ProtectTagsName'"
  }
  Write-Host "  created + verified (id $($created.id))"
} elseif (-not (Test-CreationRuleset $creation $actorId $TagPattern)) {
  $body = New-CreationRulesetBody -ActorId $actorId -Name $CreationName -Pattern $TagPattern
  Invoke-GhApi "repos/$Repo/rulesets/$($creation.id)" -Method PUT -Body $body | Out-Null
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($creation.id)"
  if (-not (Test-CreationRuleset $readback $actorId $TagPattern)) {
    throw "read-back of '$CreationName' does not match target design"
  }
  Write-Host "  updated + verified '$CreationName'"
} else {
  Write-Host "'$CreationName' already correct"
}

# ----------------- step 2: strip creation from old ruleset ------------------
if (($protectTypes -contains "creation") -or (@($protect.bypass_actors).Count -ne 0)) {
  $newRules = @($protect.rules | Where-Object { $_.type -ne "creation" })
  $body = [ordered]@{
    name          = $protect.name
    target        = $protect.target
    enforcement   = $protect.enforcement
    conditions    = $protect.conditions
    rules         = $newRules
    bypass_actors = @()
  }
  Write-Host "updating '$ProtectTagsName' (removing creation rule, clearing bypass actors) ..."
  Invoke-GhApi "repos/$Repo/rulesets/$($protect.id)" -Method PUT -Body $body | Out-Null
  $readback = Invoke-GhApi "repos/$Repo/rulesets/$($protect.id)"
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
