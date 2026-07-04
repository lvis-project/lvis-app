/**
 * Work-flow memory for the host Work Board (Hermes "Memory" pillar).
 *
 * Markdown files under `memories/` in the work-board namespace
 * (`~/.lvis/work-board/memories/`), with per-project copies under
 * `memories/projects/<project-key>/` when a project root is supplied:
 *   - `USER.md`   — who the user is (role, focus). Seeded once, never
 *                   auto-overwritten; the user edits it freely.
 *   - `MEMORY.md` — learned work-flow patterns (recurring topics, throughput,
 *                   deadline-slip tendencies). Bounded by a HARD LINE CAP with
 *                   NO auto-compaction (Hermes rule): once the cap is hit the
 *                   oldest *body* lines are dropped (FIFO), but nothing is
 *                   summarised or rewritten behind the user's back.
 *
 * All reads/writes go through the host {@link WorkBoardStorage} seam — no `fs`,
 * no fallback paths. This is the same module the legacy board plugin shipped,
 * re-aimed at the host storage surface now that the board is a first-class
 * host domain (architecture.md §10.0.3).
 */
import type { WorkBoardStorage } from "./storage.js";
import { workBoardProjectStorageKey } from "./project-storage.js";

export const MEMORIES_DIR = "memories";
export const USER_FILE = "memories/USER.md";
export const MEMORY_FILE = "memories/MEMORY.md";
const PROJECT_MEMORIES_DIR = "memories/projects";

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

export interface WorkMemoryProjectOptions {
  projectRoot?: string;
  includeUnscoped?: boolean;
}

function projectMemoryDir(projectRoot: string | undefined): string | undefined {
  const key = workBoardProjectStorageKey(projectRoot);
  return key ? `${PROJECT_MEMORIES_DIR}/${key}` : undefined;
}

function memoryPaths(options?: WorkMemoryProjectOptions): { dir: string; userFile: string; memoryFile: string } {
  const dir = projectMemoryDir(options?.projectRoot);
  if (!dir) return { dir: MEMORIES_DIR, userFile: USER_FILE, memoryFile: MEMORY_FILE };
  return {
    dir,
    userFile: `${dir}/USER.md`,
    memoryFile: `${dir}/MEMORY.md`,
  };
}

async function readOrSeedUserAt(storage: MemoryStorage, dir: string, userFile: string): Promise<string> {
  if (await storage.exists(userFile)) {
    return storage.readText(userFile);
  }
  await storage.mkdir(dir);
  await storage.write(userFile, USER_MD_SEED);
  return USER_MD_SEED;
}

async function readMemoryAt(storage: MemoryStorage, memoryFile: string): Promise<string> {
  if (await storage.exists(memoryFile)) {
    return storage.readText(memoryFile);
  }
  return MEMORY_MD_HEADER;
}

/**
 * Read `USER.md`, seeding it on first run. The seed is written once; subsequent
 * calls return whatever the user has since edited.
 */
export async function readOrSeedUser(storage: MemoryStorage): Promise<string> {
  return readOrSeedUserAt(storage, MEMORIES_DIR, USER_FILE);
}

/** Read `MEMORY.md`, returning the header-only baseline when absent. */
export async function readMemory(storage: MemoryStorage): Promise<string> {
  return readMemoryAt(storage, MEMORY_FILE);
}

/**
 * Append one or more memory lines, then enforce the hard line cap. The header
 * block is always preserved; only the oldest *body* lines are dropped (FIFO)
 * when the total would exceed {@link MEMORY_LINE_CAP}. No summarisation.
 */
export async function appendMemory(
  storage: MemoryStorage,
  lines: string | string[],
  options?: WorkMemoryProjectOptions,
): Promise<void> {
  const incoming = (Array.isArray(lines) ? lines : [lines])
    .flatMap((l) => l.split("\n"))
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.length > 0);
  if (incoming.length === 0) return;

  const paths = memoryPaths(options);
  const existing = await readMemoryAt(storage, paths.memoryFile);
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

  await storage.mkdir(paths.dir);
  const out = [...head, "", ...capped].join("\n") + "\n";
  await storage.write(paths.memoryFile, out);
}

/**
 * Render a short, prompt-ready work-flow context string for report prompts:
 * the user profile followed by the learned memory body. Bounded by `maxLines`
 * (default 40) so it never blows the report prompt budget.
 */
export async function renderWorkContext(
  storage: MemoryStorage,
  maxLines = 40,
  options?: WorkMemoryProjectOptions,
): Promise<string> {
  if (!options?.projectRoot) {
    const user = (await readOrSeedUser(storage)).trim();
    const memory = (await readMemory(storage)).trim();
    const block = `## 사용자\n${user}\n\n## 업무 흐름 메모리\n${memory}`;
    const lines = block.split("\n");
    return lines.length <= maxLines ? block : lines.slice(0, maxLines).join("\n");
  }
  const paths = memoryPaths(options);
  const blocks: string[] = [];
  if (options.includeUnscoped === true) {
    blocks.push(
      `## 사용자\n${(await readOrSeedUser(storage)).trim()}`,
      `## 기존 업무 흐름 메모리\n${(await readMemory(storage)).trim()}`,
    );
  }
  blocks.push(
    `## 프로젝트 사용자\n${(await readOrSeedUserAt(storage, paths.dir, paths.userFile)).trim()}`,
    `## 프로젝트 업무 흐름 메모리\n${(await readMemoryAt(storage, paths.memoryFile)).trim()}`,
  );
  const block = blocks.join("\n\n");
  const lines = block.split("\n");
  if (lines.length <= maxLines) return block;
  return lines.slice(0, maxLines).join("\n");
}
