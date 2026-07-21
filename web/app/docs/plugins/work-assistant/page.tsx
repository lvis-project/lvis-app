import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Work Assistant 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Work Assistant"
        title="Work Assistant — 일정 · 회의 · 메일을 조용히 거들기"
        description="명시적으로 부르지 않아도 일정 충돌 · 사전 알림 · 회의 후속 액션 같은 상황을 자동으로 감지하고, 사용자가 가장 도움이 될 만한 순간에 조용한 카드 한 장으로 제안합니다."
        tags={["조용한 제안", "일정 · 회의 · 메일 통합"]}
      />

      <h2 id="screens">자동 감지 → 카드 시퀀스</h2>
      <Tabs defaultValue="conflict" className="my-6">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="conflict">일정 겹침</TabsTrigger>
          <TabsTrigger value="reminder">사전 알림</TabsTrigger>
          <TabsTrigger value="meeting-end">회의 종료 → 액션</TabsTrigger>
        </TabsList>
        <TabsContent value="conflict">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-conflict")} caption={shots["work-assistant-conflict"].caption} />
            <ScreenshotCard src={shotUrl("work-assistant-conflict-2")} caption={shots["work-assistant-conflict-2"].caption} />
          </ScreenshotGallery>
          <p>새 일정이 기존 일정과 겹치면 카드 알림이 떠서 ‘재조정 / 거절 / 무시’ 중 선택할 수 있습니다.</p>
        </TabsContent>
        <TabsContent value="reminder">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-reminder")} caption={shots["work-assistant-reminder"].caption} />
            <ScreenshotCard src={shotUrl("work-assistant-reminder-2")} caption={shots["work-assistant-reminder-2"].caption} />
          </ScreenshotGallery>
          <p>회의 시작 N 분 전, 회의실 위치 / 화상회의 링크 / 안건 요약을 카드 한 장으로 보여줍니다.</p>
        </TabsContent>
        <TabsContent value="meeting-end">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger")} caption={shots["work-assistant-meeting-end-trigger"].caption} />
            <ScreenshotCard src={shotUrl("work-assistant-meeting-end-trigger-2")} caption={shots["work-assistant-meeting-end-trigger-2"].caption} />
          </ScreenshotGallery>
          <p>회의가 끝나면 회의록에서 자동 추출된 액션 아이템을 카드 한 장으로 제안 → 사용자 확인 후 보드로 이동.</p>
        </TabsContent>
      </Tabs>

      <h2 id="detectors">자동으로 살펴보는 신호들</h2>
      <ul>
        <li><strong>메일</strong> — 결재 요청 / 회의 요청 / 답장 필요 / 일반 액션 아이템</li>
        <li><strong>캘린더</strong> — 다가오는 회의 / 새 일정 추가 / 일정 충돌</li>
        <li><strong>회의</strong> — 회의록 작성 완료</li>
        <li><strong>업무 보드</strong> — 마감이 다가오는 작업</li>
        <li><strong>회의실 · 화상회의</strong> — 빈 회의실 추천 / 화상 링크 누락 감지</li>
      </ul>

      <h2 id="scenario">실전 시나리오 — 데일리 브리핑</h2>
      <StepList
        steps={[
          { title: "하루 한 번 자동 발사", body: <p>매일 같은 시각에 한 번만 작동합니다. 같은 날에 두 번 발사되지 않도록 마지막 실행 시각을 자기 영역에 기록해 둡니다.</p>, badge: "1회/일" },
          { title: "오늘의 신호 모으기", body: <p>오늘 일정 · 최근 회의 · 미처리 메일 · 활성 작업 항목을 한 번에 모아 짧은 단락 후보를 만듭니다.</p>, badge: "수집" },
          { title: "한국어 3~5문장으로 요약", body: <p>너무 길면 본문 길이를 자동으로 줄이고, 토큰이 부족하면 평문 리스트로 대체합니다.</p>, badge: "요약" },
          { title: "‘오늘의 브리핑’ 카드", body: <p>채팅 본문에 부드럽게 등장. 사용자가 자리에 없었다면 다음 active 상태에서 우선 노출됩니다.</p>, badge: "조용한 제안" },
        ]}
      />

      <Callout tone="security" title="허용 도메인은 사용자가 정함">
        ‘이 도메인 메일만 회의로 인식하라’ 같은 규칙은 코드에 박혀 있지 않고 사용자 설정에서 직접 바꿀 수 있습니다.
        기본값은 비어 있어 의도치 않은 동작을 막습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
