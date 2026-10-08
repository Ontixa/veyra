import type { AuditEvent } from "@veyra/sdk";

export const AUDIT_PAGE_SIZE = 200;

export interface AuditViewSnapshot {
  events: AuditEvent[];
  loadedEvents: AuditEvent[];
  query: string;
  hasMore: boolean;
  loadedAt: string;
}

function sequenceRange(events: AuditEvent[]) {
  if (events.length === 0) return null;
  return events.reduce(
    (range, event) => ({
      first: Math.min(range.first, event.sequence),
      last: Math.max(range.last, event.sequence),
    }),
    { first: events[0]!.sequence, last: events[0]!.sequence },
  );
}

/** A local view snapshot, separate from the daemon's audit export/anchor formats. */
export function auditViewExport(snapshot: AuditViewSnapshot, now = new Date()) {
  const exportedAt = now.toISOString();
  return {
    filename: `veyra-audit-view-${exportedAt.replaceAll(/[:.]/g, "-")}.json`,
    content:
      JSON.stringify(
        {
          schema_version: "veyra.desktop-audit-view/v1",
          exported_at: exportedAt,
          scope: "visible_loaded_events",
          notice:
            "This is a filtered view of loaded events, not a complete audit archive, verified chain, or authenticated audit anchor. Records are preserved as returned by the API; no additional client redaction is applied.",
          filter: {
            query: snapshot.query,
            matching: "case_insensitive_substring",
            fields: ["event_type", "transaction_id", "causal_parent"],
          },
          window: {
            page_size: AUDIT_PAGE_SIZE,
            last_loaded_at: snapshot.loadedAt,
            loaded_event_count: snapshot.loadedEvents.length,
            visible_event_count: snapshot.events.length,
            has_more_older_events: snapshot.hasMore,
            loaded_sequence_range: sequenceRange(snapshot.loadedEvents),
            visible_sequence_range: sequenceRange(snapshot.events),
            order: "newest_first",
          },
          events: snapshot.events.slice().reverse(),
        },
        null,
        2,
      ) + "\n",
  };
}

export function downloadAuditView(snapshot: AuditViewSnapshot) {
  const { filename, content } = auditViewExport(snapshot);
  const link = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json;charset=utf-8" }),
  );
  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Keep the URL alive until the browser has begun handling the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
