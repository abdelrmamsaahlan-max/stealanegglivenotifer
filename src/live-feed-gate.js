export function shouldProcessLiveFeedCandidate({
  eventTime,
  fingerprint,
  primed = false,
  startupBaselineAt = null,
  processedEvents = new Map(),
  now = Date.now()
} = {}) {
  const ts = Number(eventTime);
  if (!Number.isFinite(ts)) {
    return { process: false, reason: "invalid_event_time" };
  }

  if (!primed) {
    return { process: false, reason: "startup_prime" };
  }

  if (fingerprint && processedEvents.has(fingerprint)) {
    return { process: false, reason: "already_processed" };
  }

  if (
    Number.isFinite(Number(startupBaselineAt)) &&
    ts <= Number(startupBaselineAt)
  ) {
    return { process: false, reason: "before_restart_baseline" };
  }

  return { process: true, reason: null, ageMs: Math.max(0, Number(now) - ts) };
}
