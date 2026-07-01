import type { ChatEntry } from "../../../lib/chat-stream-state.js";

/** True for entries that start a turn: user messages and imported overlay prompts. */
export function isTurnStartEntry(entry: ChatEntry | undefined): boolean {
  return entry?.kind === "user" || entry?.kind === "imported_trigger";
}

export type EntryClass = "intermediate" | "live" | "final";

export interface TurnEntryClassification {
  /** Index of the last turn-start entry (-1 if none). */
  lastTurnStartIdx: number;
  /** classified entry idx → its class. */
  entryClassMap: Map<number, EntryClass>;
  /** final entry idx → its owning turn-start idx. */
  finalTurnStartMap: Map<number, number>;
  /** classified entry idx → its owning turn-start idx. */
  entryTurnStartMap: Map<number, number>;
}

/**
 * Three-way entry classification eliminates retroactive-reclassification flicker.
 *
 * "intermediate" — non-final work inside a user turn. This includes
 *                  reasoning, tools, and mid-turn assistant text.
 *                  Once the final assistant answer lands, all prior
 *                  work collapses into one WorkGroup.
 * "live"         — standalone non-final edge entry.
 * "final"        — last assistant entry outside the active streaming turn
 *                  → shown with TurnActionBar (turn truly complete)
 *
 * TurnActionBar therefore appears ONLY when the whole turn is done, never during it.
 *
 * Pure — extracted from ChatView.tsx (C14) so the classification pass can be
 * unit-tested independently of rendering. Byte-identical to the original.
 */
export function classifyTurnEntries(
  activeEntries: ChatEntry[],
  streaming: boolean,
): TurnEntryClassification {
  // Last turn-start index: user messages and imported overlay prompts both
  // own the assistant/tool/summary output that follows them.
  let lastTurnStartIdx = -1;
  for (let k = activeEntries.length - 1; k >= 0; k--) {
    if (isTurnStartEntry(activeEntries[k])) { lastTurnStartIdx = k; break; }
  }

  const entryClassMap = new Map<number, EntryClass>();
  const finalTurnStartMap = new Map<number, number>(); // final idx → turn-start idx
  const entryTurnStartMap = new Map<number, number>(); // classified idx → turn-start idx

  let turnStart = -1;
  for (let i = 0; i < activeEntries.length; i++) {
    const e = activeEntries[i];
    if (!e) continue;
    if (isTurnStartEntry(e)) { turnStart = i; continue; }
    if (e.kind !== "assistant" && e.kind !== "reasoning" && e.kind !== "tool_group" && e.kind !== "permission_review") continue;

    let nextTurnStartIdx = activeEntries.length;
    for (let j = i + 1; j < activeEntries.length; j++) {
      if (isTurnStartEntry(activeEntries[j])) { nextTurnStartIdx = j; break; }
    }

    const subsequentTurnEntries = activeEntries.slice(i + 1, nextTurnStartIdx);
    const hasSubsequent = subsequentTurnEntries.some(
      (ne) => ne.kind === "assistant" || ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );
    const hasSubsequentWork = subsequentTurnEntries.some(
      (ne) => ne.kind === "tool_group" || ne.kind === "reasoning" || ne.kind === "permission_review",
    );

    const myTurnStart = turnStart >= 0 ? turnStart : 0;
    entryTurnStartMap.set(i, myTurnStart);
    const isActiveTurnEntry = myTurnStart === lastTurnStartIdx && streaming;
    const hasPriorWork = activeEntries.slice(myTurnStart + 1, i).some(
      (pe) => pe.kind === "tool_group" || pe.kind === "reasoning" || pe.kind === "permission_review",
    );

    if (e.kind === "assistant") {
      if (e.phase === "work") {
        entryClassMap.set(i, "intermediate");
      } else if (e.phase === "final" && !isActiveTurnEntry) {
        entryClassMap.set(i, "final");
        finalTurnStartMap.set(i, myTurnStart);
      } else if (!hasSubsequent && !isActiveTurnEntry) {
        entryClassMap.set(i, "final");
        finalTurnStartMap.set(i, myTurnStart);
      } else if (isActiveTurnEntry || hasSubsequentWork || hasPriorWork) {
        entryClassMap.set(i, "intermediate");
      } else {
        entryClassMap.set(i, "live");
      }
    } else if (hasSubsequent || isActiveTurnEntry) {
      entryClassMap.set(i, "intermediate");
    } else {
      entryClassMap.set(i, "live");
    }
  }

  return { lastTurnStartIdx, entryClassMap, finalTurnStartMap, entryTurnStartMap };
}
