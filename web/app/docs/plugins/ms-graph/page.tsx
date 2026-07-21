import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Microsoft 365 (Outlook) 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Microsoft 365"
        title="Microsoft 365 — Outlook 메일 + 캘린더"
        description="Microsoft 계정에 한 번 로그인하면 메일과 캘린더가 LVIS 안으로 들어옵니다. ‘회의 요청 정리’, ‘오늘 일정 보여줘’ 같은 자연어 요청을 채팅에서 바로 처리합니다."
        tags={["Outlook 메일", "Outlook 캘린더", "한 번 로그인"]}
      />

      <h2 id="login">로그인 흐름</h2>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("outlook-login-trigger")} caption={shots["outlook-login-trigger"].caption} />
        <ScreenshotCard src={shotUrl("outlook-login-window")} caption={shots["outlook-login-window"].caption} />
        <ScreenshotCard src={shotUrl("outlook-login-after")} caption={shots["outlook-login-after"].caption} />
        <ScreenshotCard src={shotUrl("outlook-logout")} caption={shots["outlook-logout"].caption} />
      </ScreenshotGallery>

      <ul>
        <li>“Microsoft 365 로그인” 카드 클릭 → 표준 Microsoft 로그인 창이 떠서 안전하게 동의를 받습니다.</li>
        <li>한 번 로그인하면 토큰이 LVIS 의 안전한 저장소에 암호화되어 보관됩니다.</li>
        <li>로그아웃을 누르면 토큰이 즉시 삭제되고 다음 사용 시 다시 로그인합니다.</li>
      </ul>

      <h2 id="features">제공 기능 요약</h2>
      <ul>
        <li><strong>메일</strong> — 받은편지함 조회, 검색, 답장 초안 생성, 발송 (사용자 확인 후), 새 메일 감시.</li>
        <li><strong>캘린더</strong> — 오늘 일정 보기, 빈 시간 찾기, 일정 등록 / 수정 / 삭제, 반복 패턴 감지, 충돌 감지.</li>
      </ul>

      <h2 id="scenario">실전 시나리오 — 회의 요청 메일 한 통이 일정 + 답장으로</h2>
      <StepList
        steps={[
          { title: "회의 요청 메일이 들어옴", body: <p>새 메일이 ‘회의’ / ‘meeting’ 키워드를 가지면 호스트가 메일 도착을 감지합니다.</p>, badge: "메일" },
          { title: "본문 분석 → 후보 시간 추출", body: <p>본문에서 제안 날짜 · 시간 · 참가자를 자동으로 정리합니다.</p>, badge: "분석" },
          { title: "빈 시간 검색", body: <p>제안된 시간대의 캘린더를 보고 비어 있으면 다음 단계로, 충돌이면 사용자 확인 카드.</p>, badge: "캘린더" },
          { title: "답장 초안 자동 생성", body: <p>채팅에 답장 초안이 카드 형태로 노출됩니다. 사용자가 ‘발송’ 을 누르는 순간에만 실제로 전송됩니다.</p>, badge: "확인 후 발송" },
        ]}
      />

      <Callout tone="security" title="발송 같은 위험한 동작은 매번 사용자 확인">
        메일 발송 / 일정 등록 같은 ‘쓰기’ 동작은 사용자 확인 카드 또는 다이얼로그를 거치고, 회수된 권한으로는 fallback 없이 즉시 멈춥니다.
      </Callout>

      <Callout tone="info" title="이전 두 플러그인의 통합">
        예전에는 메일과 캘린더가 각각 따로 있었습니다. 지금은 둘이 한 플러그인으로 합쳐져 한 번 로그인으로 둘 다 사용합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
