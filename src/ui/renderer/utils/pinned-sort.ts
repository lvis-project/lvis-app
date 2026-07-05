/**
 * Shared "pinned items float to the top" ordering — used by the sidebar's
 * Chats tab (pinned conversations), Projects tab (pinned conversations
 * within a project, and pinned projects themselves). One generic function so
 * all three call sites share identical tie-breaking semantics.
 *
 * Stable partition: pinned items keep their relative (already-recency-sorted)
 * order, followed by unpinned items in their relative order. `Array.prototype
 * .sort` has been a stable sort per the ES2019 spec, so a same-key comparator
 * (`0` vs `1`) never reorders items within a partition — this is what
 * preserves "핀 그룹 내에서는 기존 정렬(최신순) 유지".
 */
export function sortWithPinnedFirst<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
}
