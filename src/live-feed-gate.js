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


export function mergeNearDuplicateFeedCandidates(
  candidates,
  { toleranceMs = 20_000 } = {}
) {
  const input = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const groups = [];

  const normalize = value => String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const semanticKey = item => [
    normalize(item?.candidate?.rarity || item?.rarity),
    normalize(item?.candidate?.eggName || item?.eggName),
    normalize(item?.candidate?.biome || item?.biome || "unknown")
  ].join("|");

  const sorted = [...input].sort((a, b) => {
    const at = Number(a?.eventTime ?? 0);
    const bt = Number(b?.eventTime ?? 0);
    return at - bt || Number(b?.candidate?.score ?? b?.score ?? 0) - Number(a?.candidate?.score ?? a?.score ?? 0);
  });

  for (const item of sorted) {
    const key = semanticKey(item);
    const eventTime = Number(item?.eventTime);
    if (!key || !Number.isFinite(eventTime)) {
      groups.push({ representative: item, items: [item], key });
      continue;
    }

    let target = null;
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (group.key !== key) continue;

      const groupTime = Number(group.representative?.eventTime);
      if (!Number.isFinite(groupTime)) continue;

      const sameEndpoint = group.representative?.index === item?.index;
      const sameSourceId =
        String(group.representative?.candidate?.sourceEventId || "") !== "" &&
        String(group.representative?.candidate?.sourceEventId || "") ===
          String(item?.candidate?.sourceEventId || "");

      const withinTolerance = Math.abs(eventTime - groupTime) <= toleranceMs;

      // Different feed endpoints are alternate observations of the same spawn.
      // Merge them even when their payload timestamps drift slightly. On the same
      // endpoint, only merge when the source explicitly supplied the same ID.
      if (sameSourceId || (!sameEndpoint && withinTolerance)) {
        target = group;
        break;
      }

      if (eventTime - groupTime > toleranceMs) break;
    }

    if (!target) {
      groups.push({ representative: item, items: [item], key });
      continue;
    }

    target.items.push(item);

    const currentScore = Number(
      target.representative?.candidate?.score ??
      target.representative?.score ??
      0
    );
    const nextScore = Number(
      item?.candidate?.score ??
      item?.score ??
      0
    );

    if (nextScore > currentScore) {
      target.representative = item;
    }
  }

  return groups.map(group => group.representative);
}
