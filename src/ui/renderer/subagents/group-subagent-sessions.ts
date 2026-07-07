/**
 * groupSubAgentSessions — unify a flat `SubAgentSpawn[]` into one entry per
 * logical sub-agent, concatenating a spawn and its resume(s) into a single
 * transcript.
 *
 * Why: a resume is a SEPARATE `agent_spawn` call — its own `spawnId` and
 * `toolUseId` — so the flat live event list renders a spawn and each of its
 * resumes as distinct cards/rows. The user's requirement is a UNIFIED
 * transcript. The JOIN KEY is `childSessionId`: a resume shares the
 * original spawn's `childSessionId` (it IS the `resumeId` it was called with),
 * so all segments of one logical agent carry the same value.
 *
 * Grouping is keyed on `childSessionId ?? "solo:" + spawnId`: a spawn without a
 * `childSessionId` forms its own singleton group and renders exactly as today.
 * First-seen order is preserved so the event-stream input order (which is transcript
 * order: original, then resume1, then resume2) is the concat order.
 */
import type { SubAgentSpawn } from "./types.js";

export function groupSubAgentSessions(spawns: SubAgentSpawn[]): SubAgentSpawn[] {
  const buckets = new Map<string, SubAgentSpawn[]>();
  const order: string[] = [];
  for (const spawn of spawns) {
    const key = spawn.childSessionId ?? `solo:${spawn.spawnId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(spawn);
  }
  return order.map((key) => {
    const segments = buckets.get(key)!;
    // A singleton group is returned verbatim — no allocation, and reference
    // identity is preserved so React can bail out of re-rendering unchanged rows.
    if (segments.length === 1) return segments[0];
    const first = segments[0];
    const last = segments[segments.length - 1];
    // Identity (spawnId / title / childSessionId) comes from the FIRST segment
    // (one logical agent = one row + one name); live status / summary / error
    // come from the LATEST segment (`...last`); the transcript is the ordered
    // concat and the tool-call count is the sum across segments.
    return {
      ...last,
      spawnId: first.spawnId,
      title: first.title,
      ...(first.instructions ? { instructions: first.instructions } : {}),
      childSessionId: first.childSessionId,
      entries: segments.flatMap((segment) => segment.entries),
      toolCallCount: segments.reduce((sum, segment) => sum + segment.toolCallCount, 0),
    };
  });
}
