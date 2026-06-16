/**
 * Work-flow memory for the host Work Board (Hermes "Memory" pillar).
 *
 * Two markdown files under `memories/` in the work-board namespace
 * (`~/.lvis/work-board/memories/`):
 *   - `USER.md`   — who the user is (role, focus). Seeded once, never
 *                   auto-overwritten; the user edits it freely.
 *   - `MEMORY.md` — learned work-flow patterns (recurring topics, throughput,
 *                   deadline-slip tendencies). Bounded by a HARD LINE CAP with
 *                   NO auto-compaction (Hermes rule): once the cap is hit the
 *                   oldest *body* lines are dropped (FIFO), but nothing is
 *                   summarised or rewritten behind the user's back.
 *
 * All reads/writes go through the host {@link WorkBoardStorage} seam — no `fs`,
 * no fallback paths. This is the same module the agent-hub plugin shipped at
 * v0.9.0, re-aimed at the host storage surface now that the board is a
 * first-class host domain (architecture.md §10.0.3).
 */
import type { WorkBoardStorage } from "./storage.js";

export const MEMORIES_DIR = "memories";
export const USER_FILE = "memories/USER.md";
export const MEMORY_FILE = "memories/MEMORY.md";

/**
 * Hard cap on `MEMORY.md` length. When an append would exceed this, the oldest
 * body lines are dropped to fit (FIFO) — no compaction/summarisation.
 */
export const MEMORY_LINE_CAP = 200;

/** Seed contents for `USER.md` on first run. User-editable thereafter. */
export const USER_MD_SEED = `# 사용자 프로필

> 이 파일은 개인 업무 보드가 사용자의 업무 흐름을 이해하기 위한 메모입니다.
> 자유롭게 수정하세요. 자동으로 덮어쓰지 않습니다.

- 역할:
- 주요 업무 영역:
- 반복 업무:
`;

const MEMORY_MD_HEADER = `# 업무 흐름 메모리

> 보드 활동에서 학습된 업무 패턴(반복 주제, 처리량, 마감 지연 경향).
> 하드 라인 캡 적용 — 오래된 줄부터 제거되며 자동 요약/압축은 하지 않습니다.
`;

/**
 * Narrow slice of {@link WorkBoardStorage} this module depends on. `mkdir`
 * ensures the `memories/` subdir exists before the first write.
 */
export type MemoryStorage = Pick<
  WorkBoardStorage,
  "readText" | "write" | "exists" | "mkdir"
>;

/**
 * Read `USER.md`, seeding it on first run. The seed is written once; subsequent
 * calls return whatever the user has since edited.
 */
export async function readOrSeedUser(storage: MemoryStorage): Promise<string> {
  if (await storage.exists(USER_FILE)) {
    return storage.readText(USER_FILE);
  }
  await storage.mkdir(MEMORIES_DIR);
  await storage.write(USER_FILE, USER_MD_SEED);
  return USER_MD_SEED;
}

/** Read `MEMORY.md`, returning the header-only baseline when absent. */
export async function readMemory(storage: MemoryStorage): Promise<string> {
  if (await storage.exists(MEMORY_FILE)) {
    return storage.readText(MEMORY_FILE);
  }
  return MEMORY_MD_HEADER;
}

/**
 * Append one or more memory lines, then enforce the hard line cap. The header
 * block is always preserved; only the oldest *body* lines are dropped (FIFO)
 * when the total would exceed {@link MEMORY_LINE_CAP}. No summarisation.
 */
export async function appendMemory(
  storage: MemoryStorage,
  lines: string | string[],
): Promise<void> {
  const incoming = (Array.isArray(lines) ? lines : [lines])
    .flatMap((l) => l.split("\n"))
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  if (incoming.length === 0) return;

  const existing = await readMemory(storage);
  const allLines = existing.split("\n");
  // Split off the header block so caps only ever evict learned body lines,
  // never the legend.
  const headerLines = MEMORY_MD_HEADER.replace(/\n$/, "").split("\n");
  const headerLen = headerLines.length;
  const head = allLines.slice(0, headerLen);
  const body = allLines.slice(headerLen).filter((l) => l.trim().length > 0);

  const merged = [...body, ...incoming];
  const bodyCap = Math.max(0, MEMORY_LINE_CAP - headerLen);
  const capped = merged.length > bodyCap ? merged.slice(merged.length - bodyCap) : merged;

  await storage.mkdir(MEMORIES_DIR);
  const out = [...head, "", ...capped].join("\n") + "\n";
  await storage.write(MEMORY_FILE, out);
}

/**
 * Render a short, prompt-ready work-flow context string for report prompts:
 * the user profile followed by the learned memory body. Bounded by `maxLines`
 * (default 40) so it never blows the report prompt budget.
 */
export async function renderWorkContext(
  storage: MemoryStorage,
  maxLines = 40,
): Promise<string> {
  const user = (await readOrSeedUser(storage)).trim();
  const memory = (await readMemory(storage)).trim();
  const block = `## 사용자\n${user}\n\n## 업무 흐름 메모리\n${memory}`;
  const lines = block.split("\n");
  if (lines.length <= maxLines) return block;
  return lines.slice(0, maxLines).join("\n");
}
