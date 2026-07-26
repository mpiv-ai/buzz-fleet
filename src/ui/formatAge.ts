/**
 * Human-readable "how long ago" string for a `lastSeenAt` epoch, or
 * `"never"` when the agent has no recorded sighting.
 *
 * Clamps a `lastSeenAt` after `nowMs` (clock skew, stale re-render) to
 * `"0s ago"` rather than a negative duration.
 */
export function formatAge(lastSeenAtMs: number | null, nowMs: number): string {
  if (lastSeenAtMs === null) {
    return "never";
  }

  const deltaMs = Math.max(0, nowMs - lastSeenAtMs);
  const seconds = Math.floor(deltaMs / 1000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
