/**
 * warmUpBackend: fires a fire-and-forget health request to wake the Render
 * free-tier backend, which sleeps after about 15 minutes idle and takes roughly
 * 50 to 60 seconds to wake. Calling this early (on page mount) lets the backend
 * start warming up before the user runs a simulation or import.
 *
 * The call is throttled: if a ping was fired within the last 30 seconds it does
 * nothing, so rapid navigation between pages does not spam the backend. It never
 * throws, never blocks, and ignores both the result and any errors.
 */

/** Minimum gap between warm-up pings, in milliseconds. */
const WARMUP_THROTTLE_MS = 30_000;

/** Module-level timestamp of the last ping we fired (0 means never). */
let lastPingAt = 0;

/**
 * Wakes the backend with a throttled, fire-and-forget health ping.
 * Safe to call on every page mount. Returns immediately.
 */
export function warmUpBackend(): void {
  const now = Date.now();
  if (now - lastPingAt < WARMUP_THROTTLE_MS) {
    // A ping was fired recently; skip this one to avoid redundant requests
    // during navigation.
    return;
  }
  lastPingAt = now;
  // Lazy-load the api client so this helper stays lightweight, then fire the
  // health ping. Result and errors are intentionally swallowed so this never
  // blocks rendering or surfaces an error.
  import("./apiClient")
    .then(({ apiRequest }) => apiRequest("GET", "/health"))
    .catch(() => {});
}
