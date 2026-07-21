import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MCP 서버 — 외부 도구 셋 가져오기" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · MCP"
        title="MCP 서버 — 외부 도구 셋을 LVIS 안으로"
        description="외부에서 제공하는 도구 모음을 LVIS 채팅 안에서 쓸 수 있게 연결하는 표준 프로토콜이 MCP 입니다. 한번 등록하면 그 서버가 제공하는 도구들이 LVIS 의 도구 목록에 들어와 LLM 이 자연스럽게 사용할 수 있습니다."
        tags={["외부 도구 연결 표준", "Marketplace 에서 발견", "사용자 동의 후 등록"]}
      />

      <h2 id="why">언제 쓰나요?</h2>
      <ul>
        <li>회사 내부 데이터베이스 / API 를 LVIS 채팅에서 호출하고 싶을 때.</li>
        <li>유료 외부 서비스 (예: 검색 / 번역 / 코드 분석) 를 LVIS 에 가져오고 싶을 때.</li>
        <li>다른 팀이 만든 도구 모음을 그대로 빌려 쓰고 싶을 때.</li>
      </ul>

      <h2 id="register">등록 흐름</h2>
      <StepList
        steps={[
          {
            title: "Marketplace 에서 발견",
            body: <p>Marketplace 의 MCP 탭에서 사용 가능한 서버 목록을 확인합니다. 평점과 사용 통계가 함께 표시됩니다.</p>,
          },
          {
            title: "등록 deeplink 누름",
            body: <p>‘등록’ 버튼을 누르면 LVIS 호스트로 등록 요청이 전달됩니다. 직접 URL 을 입력해도 됩니다.</p>,
          },
          {
            title: "도구 목록 확인 + 동의",
            body: <p>그 서버가 제공할 도구 목록을 호스트가 미리 가져와 사용자에게 보여줍니다. 이때 위험도와 범위를 함께 검토합니다.</p>,
            badge: "사용자 확인",
          },
          {
            title: "도구 목록에 합류",
            body: <p>동의 후 그 서버의 도구들이 LVIS 의 도구 목록에 들어옵니다. 채팅에서 자연어로 호출 가능.</p>,
          },
        ]}
      />

      <Callout tone="security" title="처음에는 보수적으로 분류">
        외부 MCP 서버의 도구는 기본적으로 ‘중간 위험도’ 로 분류됩니다. 자동 실행 (낮은 위험도) 로 강등되려면 운영자의 추가 검토가 필요합니다.
        사용자 입장에서는 처음에 매번 확인 카드가 뜨고, 익숙해진 도구만 점차 자동 실행됩니다.
      </Callout>

      <PageNav />
    </article>
  );
}
