import { config } from "../config.js";

/** "3h ago" / "2d ago" — timezone-agnostic, so this is safe everywhere. */
export function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Absolute times shown to the team (e.g. in the export) are rendered in
 * config.teamTimezone, not server UTC — everything is stored as timestamptz
 * (UTC) in Postgres regardless, this only affects display.
 *
 * ASSUMPTION: we don't actually know what timezone this team is in — the
 * brief never says. Defaulting to America/Los_Angeles; see ASSUMPTIONS.md.
 * This only matters today for display strings; nothing is scheduled by
 * time-of-day yet (no digest job), so getting this wrong costs readability,
 * not correctness.
 */
export function formatLocal(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.teamTimezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
