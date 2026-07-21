import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { PageNav } from "@/components/docs/page-nav";
import { Clock, PowerOff } from "lucide-react";

export const metadata = { title: "루틴 등록과 트리거 흐름" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Routines"
        title="RoutineEngineV2 — 두 가지 트리거"
        description="LVIS의 routine 엔진은 src/routines/v2/routine-engine-v2.ts 의 단일 구현 (v2-only). 트리거는 'shutdown' 과 'schedule' 두 가지만 존재. 각 루틴 발사는 dedicated ConversationLoop 인스턴스를 새로 만들어 interactive 메인 루프와 isolation."
        tags={["src/routines/v2/routine-engine-v2.ts", "trigger: shutdown | schedule", "per-fire fresh loop"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          { icon: <Clock className="h-5 w-5" />, title: "schedule", body: <>cron-like 식 사용. evaluator: <code>src/routines/cron-evaluator.ts</code>. 예: 매일 09:00, 매주 금요일 17:00.</>, tone: "teal" },
          { icon: <PowerOff className="h-5 w-5" />, title: "shutdown", body: <>호스트가 종료 직전에 발사. 일일 정리 / 데일리 백업 / 보고용으로 활용.</>, tone: "citron" },
        ]}
      />

      <Callout tone="info" title="이벤트/조합 트리거는 routine 이 아니라 detector 가 담당">
        이메일 도착 · 미팅 종료 같은 이벤트 기반 자동화는 routine 이 아니라 <a href="/docs/plugins/work-assistant">Work Assistant</a> 의 detector 가 담당합니다.
        Routine 은 “시간 또는 종료 시점” 두 가지 트리거만 갖는 단순한 엔진.
      </Callout>

      <h2 id="register">루틴 등록 (목업)</h2>
      <MockupFrame title="Routine — schedule type 예시" tone="white">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-teal">Trigger</p>
            <div className="mt-2 grid gap-1.5 text-[13px]">
              <div className="rounded border border-teal/30 bg-white px-2.5 py-1.5 font-mono">trigger: "schedule"</div>
              <div className="rounded border border-border bg-white px-2.5 py-1.5 font-mono">cron: "0 9 * * 1-5"</div>
            </div>
          </div>
          <div className="rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-coral">Conversation seed</p>
            <ol className="mt-2 grid gap-1.5 text-[13px]">
              <li className="rounded border border-border bg-white px-2.5 py-1.5">user: “데일리 브리핑 정리해줘”</li>
              <li className="rounded border border-border bg-white px-2.5 py-1.5 text-muted-foreground">→ work_assistant_generate_daily_briefing</li>
              <li className="rounded border border-border bg-white px-2.5 py-1.5 text-muted-foreground">→ 결과를 채팅 본문 카드로 표시</li>
            </ol>
          </div>
        </div>
      </MockupFrame>

      <h2 id="lifecycle">발사 단계</h2>
      <StepList
        steps={[
          { title: "등록 — UI 또는 plugin manifest", body: <p>사용자가 RoutinePanel 에서 추가하거나, plugin manifest 가 capability <code>routine-provider</code> + 추천 routine 을 함께 제공.</p> },
          { title: "Scheduler 등록", body: <p><code>src/main/routines-scheduler.ts</code> 가 시간 트리거를 OS timer 로 예약. shutdown 트리거는 호스트 lifecycle hook 에 등록.</p> },
          { title: "Per-fire fresh ConversationLoop", body: <p>발사 시점에 새 ConversationLoop 인스턴스 생성. interactive 메인 루프와 메모리 / 권한 / TODO 가 isolation.</p>, badge: "isolation" },
          { title: "세션 기록", body: <p><code>{"~/.lvis/routine/sessions/<routineId>/<firedAt>.jsonl"}</code> 에 한 발사의 message stream + tool calls JSONL 로 append.</p> },
          { title: "결과 노출", body: <p>완료 시 채팅 본문에 “루틴 실행 완료” 카드. 실패 시 audit log + 다음 발사는 정상.</p> },
        ]}
      />

      <Callout tone="warn" title="‘Q9 isolation lock’ 이름은 코드에 없다">
        과거 문서 / CLAUDE.md 가 “Q9 isolation lock” 이라고 부르는 개념은 코드의 “per-fire fresh ConversationLoop” 패턴 (<code>routine-engine-v2.ts:5-7</code> 주석) 으로 구현되어 있습니다.
        리터럴 <code>Q9</code> 라는 식별자는 소스에 등장하지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
