import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "질문 카드" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="질문 카드 — 더 묻거나 선택지를 제시할 때"
        description="에이전트가 사용자에게 ‘더 물어봐야 하는 상황’ 이거나 ‘여러 선택지 중 골라야 하는 상황’ 에서 인라인 카드로 띄웁니다. 추천 선택지가 강조되고, 비슷하게 좋은 대안도 함께 표시됩니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-question-card")} caption={shots["chat-question-card"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="when">언제 질문 카드가 나오나요?</h2>
      <ul>
        <li>사용자 의도가 모호할 때 — 「어떤 메일을 정리할까요?」</li>
        <li>여러 후보 중 골라야 할 때 — 「세 곳의 회의실 중 어디로?」</li>
        <li>위험한 액션 직전에 — 「이 파일을 덮어쓸까요?」</li>
        <li>플러그인이 후속 액션을 제안할 때 — 「액션 아이템을 TODO 로 추가할까요?」</li>
      </ul>

      <h2 id="features">카드가 가진 작은 친절</h2>
      <ul>
        <li><strong>추천 선택지</strong> 는 색상으로 강조됩니다.</li>
        <li><strong>비슷하게 좋은 대안</strong> 도 함께 표시되어 사용자가 빠르게 비교할 수 있습니다.</li>
        <li><strong>자유 입력</strong> 이 허용되면 옆에 입력 박스가 함께 나옵니다.</li>
        <li><strong>다중 선택</strong> 이 허용되면 체크박스 형태로 변합니다.</li>
        <li>이미 선택한 카드는 잠긴 상태로 대화 기록에 보존되어 어떤 선택이 어떤 결과를 만들었는지 추적할 수 있습니다.</li>
      </ul>

      <Callout tone="info" title="요점">
        질문 카드는 ‘에이전트가 더 똑똑해 보이는 마법’ 이 아니라, 사용자에게 결정 권한을 명확히 돌려주는 장치입니다.
      </Callout>

      <PageNav />
    </article>
  );
}
