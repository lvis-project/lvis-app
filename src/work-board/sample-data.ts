/**
 * First-run sample-data seed for the Work Board (user-guide onboarding).
 *
 * A brand-new install opens to an empty board, which makes the agentic flow
 * (create → approve → sub-agent executes → output) hard to discover. This step
 * seeds a small set of clearly-labelled example items on the FIRST boot of the
 * work-board domain so the board demonstrates itself — including one item that
 * is already `completed` with a captured plan + output, so the columns show the
 * full lifecycle, not just empty lanes.
 *
 * Idempotency is keyed by a one-time marker file (`sample-seeded.json`), NOT by
 * the board being empty: once the decision is recorded, deleting the demo items
 * never makes them reappear. The seed is skipped (and the marker still written)
 * when the board was migrated from a legacy plugin or already has items — a real
 * board is never polluted with examples.
 *
 * Non-fatal: any failure logs and leaves the board untouched (boot continues).
 */
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemCreateInput,
  WorkItemCreateResult,
  WorkItemListResult,
} from "../shared/work-board-types.js";

/** Marker recording that the first-run seed decision was already made. */
export const SAMPLE_SEEDED_FILE = "sample-seeded.json";

/** Narrow store surface the seed needs (satisfied by WorkBoardStore). */
export interface SampleSeedStore {
  list(): Promise<WorkItemListResult>;
  create(input: WorkItemCreateInput): Promise<WorkItemCreateResult>;
  setRunResult(
    id: number,
    patch: {
      runStatus: "completed";
      plan?: string | null;
      output?: string | null;
      runSessionId?: string | null;
    },
  ): Promise<unknown>;
}

export interface SampleSeedDeps {
  store: SampleSeedStore;
  marker: Pick<WorkBoardStorage, "readJson" | "writeJson">;
  /** True when boot migrated a legacy plugin board this run — never seed over real data. */
  alreadyMigrated: boolean;
  /** Injectable clock so due dates / timestamps are deterministic in tests. */
  now: () => number;
}

export interface SampleSeedResult {
  seeded: boolean;
  reason?: string;
  count?: number;
}

interface SampleSeededMarker {
  seeded: boolean;
  decidedAt: string;
  count?: number;
}

/**
 * Build the sample items. `now` anchors the due dates so the high-priority
 * planned item lands inside the due-soon window (demonstrating the nudge) and
 * the completed item reads as finished recently.
 */
function sampleItems(nowMs: number): Array<{
  input: WorkItemCreateInput;
  run?: { plan: string; output: string };
}> {
  const inHours = (h: number) => new Date(nowMs + h * 60 * 60_000).toISOString();
  return [
    {
      input: {
        title: "[예시] 주간 업무 보고서 초안 작성",
        detail:
          "이번 주 완료/진행 항목을 모아 주간 보고 초안을 만든다. 카드를 열고 '실행'을 누르면 에이전트가 계획을 세워 승인을 요청하고, 승인하면 초안을 자동 작성한다.",
        priority: "high",
        status: "planned",
        // 약 20시간 뒤 — due-soon(24h) 알림 데모.
        due_at: inHours(20),
      },
    },
    {
      input: {
        title: "[예시] 경쟁 제품 리서치 정리",
        detail:
          "에이전트가 자료를 조사해 비교표 초안을 만드는 중입니다. 진행 중 칸에서 실시간 진행 상태를 확인할 수 있습니다.",
        priority: "medium",
        status: "in_progress",
        due_at: inHours(3 * 24),
      },
    },
    {
      input: {
        title: "[예시] 2분기 회고 핵심 정리",
        detail: "승인 후 서브에이전트가 자율 실행하여 결과를 남긴 완료 항목 예시입니다.",
        priority: "medium",
        status: "completed",
      },
      run: {
        plan:
          "1) 2분기 완료 업무 목록 수집  2) 성과/이슈/배운 점 3개 축으로 분류  3) 다음 분기 액션 아이템 도출  4) 한 페이지로 요약",
        output:
          "## 2분기 회고 요약\n\n**성과** — 핵심 기능 3건 출시, 응답 지연 28% 개선.\n**이슈** — 리뷰 사이클 지연이 반복 → 체크리스트 도입.\n**다음 분기** — (1) 자동화 커버리지 확대 (2) 온보딩 문서 정비 (3) 주간 회고 정례화.\n\n_이 결과는 예시 데이터입니다._",
      },
    },
  ];
}

/**
 * Seed the sample board exactly once. Returns whether items were created.
 * Writes the marker on every terminal decision (seeded or deliberately skipped)
 * so the choice is made at most once per install.
 */
export async function seedSampleWorkBoard(deps: SampleSeedDeps): Promise<SampleSeedResult> {
  const { store, marker, alreadyMigrated, now } = deps;

  // The marker — not board emptiness — is the idempotency key.
  const existing = await marker.readJson<SampleSeededMarker>(SAMPLE_SEEDED_FILE);
  if (existing) return { seeded: false, reason: "already-decided" };

  const decidedAt = new Date(now()).toISOString();

  // Never seed over real data: a migrated or already-populated board.
  if (alreadyMigrated) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "migrated" };
  }
  const listed = await store.list();
  if (listed.status === "ok" && listed.items.length > 0) {
    await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: false, decidedAt });
    return { seeded: false, reason: "non-empty" };
  }

  let count = 0;
  for (const sample of sampleItems(now())) {
    const created = await store.create(sample.input);
    if (created.status !== "created") continue;
    count += 1;
    if (sample.run) {
      await store.setRunResult(created.itemId, {
        runStatus: "completed",
        plan: sample.run.plan,
        output: sample.run.output,
        runSessionId: `sample:${created.itemId}`,
      });
    }
  }

  await marker.writeJson(SAMPLE_SEEDED_FILE, { seeded: true, decidedAt, count });
  return { seeded: true, count };
}
