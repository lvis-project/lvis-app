import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "미팅 종료 → 자동 작업" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Event-driven flow"
        title="미팅 종료 → 액션 아이템 추출 (Routine 아님)"
        description="이 흐름은 RoutineEngineV2 가 아닌 work-assistant 의 meeting-summary detector 가 담당합니다 — meeting plugin이 meeting.summary.created 를 emit 하면 detector가 surface 결정 후 사용자 카드로 노출합니다."
        tags={["event-driven", "meeting.summary.created", "meeting-summary-detector"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].caption} />
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].caption} />
      </ScreenshotGallery>

      <h2 id="flow">한 사이클</h2>
      <StepList
        steps={[
          { title: "회의 종료 감지", body: <p>meeting plugin이 사용자 stop / floating window 종료에서 <code>meeting.ended</code> emit → 모든 transcript 가 SessionStore 에 저장.</p>, badge: "meeting" },
          { title: "요약 생성", body: <p>meeting plugin이 호스트 LLM (<code>callLlm</code>) 으로 transcript 요약 + <code>actionItems</code> 추출. 결과를 <code>meeting.summary.created</code> 로 emit.</p> },
          { title: "Work Assistant detector 진입", body: <p><code>src/decision/meeting-summary-detector.ts</code> 가 이벤트 구독. 정책 평가 (allow-list 도메인 등) 후 surface 여부 결정.</p>, badge: "work-assistant" },
          { title: "Proactive card", body: <p>surface 결정 시 <code>hostApi.triggerConversation</code> 또는 <code>showOverlay</code> 로 채팅 본문/오버레이에 카드 노출. 사용자 선택지 표시 (TODO/메일/요약 저장).</p> },
          { title: "후속 액션", body: <p>사용자가 선택하면 work-assistant 가 ms-graph / agent-hub 도구로 실제 작업 수행 (예: 캘린더 등록, work-item 생성).</p>, badge: "최종" },
        ]}
      />

      <Callout tone="tip" title="이 흐름을 끄려면">
        <ul className="my-1 list-disc pl-5">
          <li><strong>plugin 단</strong>: meeting <code>autoSummarize=false</code> 로 요약 자체 차단.</li>
          <li><strong>detector 단</strong>: <code>work_assistant_set_detector_enabled({"{ id: 'meeting-summary', enabled: false }"})</code></li>
          <li><strong>config 단</strong>: <code>meetingDetectorAllowedSenderDomains</code> 빈 배열 = fail-closed.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
