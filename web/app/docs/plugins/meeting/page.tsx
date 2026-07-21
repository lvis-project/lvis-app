import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Meeting 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Meeting"
        title="Meeting — 회의 녹음 · 자동 받아쓰기 · 요약"
        description="작은 위젯으로 회의 녹음을 시작하고, 음성이 실시간으로 글자로 옮겨집니다. 회의가 끝나면 자동으로 회의록과 요약이 생성되고, 액션 아이템은 업무 보드로 흘러갑니다."
        tags={["실시간 STT", "자동 요약", "후속 작업 자동화"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-upcoming")} caption={shots["meeting-upcoming"].caption} />
        <ScreenshotCard src={shotUrl("meeting-record")} caption={shots["meeting-record"].caption} />
        <ScreenshotCard src={shotUrl("meeting-record-stt")} caption={shots["meeting-record-stt"].caption} />
        <ScreenshotCard src={shotUrl("meeting-minutes")} caption={shots["meeting-minutes"].caption} />
      </ScreenshotGallery>

      <h2 id="minutes">자동 생성된 회의록</h2>
      <p>
        회의가 끝나면 호스트 LLM 이 한 페이지짜리 회의록을 자동으로 만들어 줍니다. 사용자가 매번 정리하지 않아도 같은 형식으로 보존됩니다.
        발화자 단위 transcript · 액션 아이템 · 메모 · 공유까지 한 화면에서 처리합니다.
      </p>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-minutes-2")} caption={shots["meeting-minutes-2"].caption} />
        <ScreenshotCard src={shotUrl("meeting-minutes-3")} caption={shots["meeting-minutes-3"].caption} />
      </ScreenshotGallery>

      <h2 id="record">녹음 시작에서 회의록까지</h2>
      <ul>
        <li><strong>위젯에서 한 번 클릭</strong> → 마이크 권한 요청 후 녹음 시작.</li>
        <li><strong>실시간 받아쓰기</strong> → 음성이 짧은 단위로 글자로 옮겨져 화면에 즉시 표시.</li>
        <li><strong>종료 → 회의록 + 요약 자동 생성</strong> → 회의록 전체는 안전한 자기 영역에 저장.</li>
        <li><strong>floating window</strong> → 다른 창 위에 작게 띄워두고 회의 중 메모.</li>
      </ul>

      <h2 id="scenario">실전 시나리오 — “회의 시작” 한 번이 30분 흐름을 무인 처리</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].caption} />
        <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].caption} />
      </ScreenshotGallery>
      <StepList
        steps={[
          { title: "회의 시작", body: <p>위젯의 ‘녹음 시작’ → 마이크 권한 → 회의 진행 중 실시간 받아쓰기.</p>, badge: "녹음" },
          { title: "받아쓰기 실시간 표시", body: <p>음성이 짧은 청크 단위로 화면에 흘러옵니다. 사용자는 진행 중에도 마킹 / 북마크 가능.</p>, badge: "STT" },
          { title: "회의 종료 → 요약 자동 생성", body: <p>사용자가 ‘종료’ 누르거나 호스트가 종료를 감지하면, 회의 전체가 한 단락으로 요약되고 액션 아이템이 함께 추출됩니다.</p>, badge: "요약" },
          { title: "업무 보드 / 메일로 후속 자동화", body: <p>업무도우미가 액션 아이템을 사용자 확인 카드로 띄우고, 승인하면 업무 보드와 호스트 TODO 에 동시 등록.</p>, badge: "후속" },
        ]}
      />

      <Callout tone="info" title="STT 모델은 호스트가 선택">
        받아쓰기에 사용하는 음성 인식 모델은 호스트 설정에서 고를 수 있습니다. 키와 비용은 호스트가 일괄 관리하고, 플러그인은 단순히 “받아쓰기 좀” 이라고 요청만 합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
