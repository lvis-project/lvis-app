import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MCP 서버 — 외부 도구 셋 가져오기" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · MCP"
        title="MCP 서버 — 외부 도구 셋을 LVIS 안으로"
        description="외부에서 제공하는 도구 모음을 LVIS 채팅 안에서 쓸 수 있게 연결하는 표준 프로토콜이 MCP 입니다. 등록한 서버는 도구만 주는 것이 아니라 리소스(읽을 자료) 와 프롬프트(미리 짜둔 질문) 도 함께 제공할 수 있고, LVIS 는 그 셋을 각각 다른 자리에서 보여줍니다."
        tags={["외부 도구 연결 표준", "도구 · 리소스 · 프롬프트", "사용자 동의 후 등록"]}
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

      <h2 id="beyond-tools">도구 말고 또 무엇이 들어오나</h2>
      <p>
        MCP 서버는 도구 외에 두 가지를 더 내놓을 수 있습니다. LVIS 는 셋을 섞지 않고, 각각 다른 자리에서 다르게 다룹니다.
      </p>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "리소스 — 서버가 가진 자료",
            body: <>문서 · 로그 · 레코드처럼 서버가 “읽어갈 수 있다” 고 내놓는 자료입니다. 두 갈래로 들어옵니다 — 사용자가 입력창에서 <code>@</code> 를 눌러 직접 고르거나, 모델이 <code>mcp_resource_list</code> / <code>mcp_resource_read</code> 로 직접 찾아 읽습니다.</>,
            tone: "teal",
          },
          {
            title: "리소스 템플릿 — 빈칸이 있는 자료",
            body: <>“이슈 번호를 넣으면 그 이슈를 준다” 처럼 빈칸이 있는 형태입니다. <code>@</code> 목록에서 고르면 호스트가 빈칸을 채우는 창을 띄우고, 채워진 주소를 <strong>호스트가</strong> 만들어 읽습니다.</>,
          },
          {
            title: "프롬프트 — 서버가 미리 짜둔 질문",
            body: <>서버가 “이런 걸 물어보면 잘 답한다” 고 미리 준비해 둔 질문 묶음입니다. 입력창에서 <code>/</code> 를 눌러 고르고, 인자가 필요하면 입력 창이 먼저 뜹니다.</>,
            tone: "citron",
          },
          {
            title: "서버 안내문",
            body: <>연결된 서버가 “나를 이렇게 쓰라” 고 붙여 보내는 설명입니다. 모델에게 참고 자료로 전달되지만 <strong>지시로 취급되지 않습니다</strong>.</>,
          },
        ]}
      />

      <Callout tone="security" title="서버가 쓴 글은 사용자가 쓴 글이 아닙니다">
        리소스 본문과 프롬프트 본문은 <strong>서버가 쓴 글</strong> 입니다. 사용자가 그것을 가져오기로 선택했을 뿐, 내용을 쓴 것은 사용자가 아닙니다.
        그래서 LVIS 는 이 내용을 사용자의 말과 같은 자리에 그냥 붙이지 않고, 출처가 표시된 별도 블록으로 감싸 모델에게 전달합니다.
        서버가 그 블록을 스스로 닫거나 새로 열어 사용자의 말인 척할 수 없도록 경계 문자를 호스트가 무력화하고, 길이에도 상한을 둡니다.
      </Callout>

      <Callout tone="security" title="외부 서버 도구는 기본적으로 확인을 거칩니다">
        호스트는 도구의 출처를 세 등급으로 나누고 (내장 · 플러그인 · 외부 MCP), 외부 MCP 서버를 그중 가장 낮은 등급에 둡니다.
        그래서 <strong>위험도나 카테고리로 자동 허용되는 경로에서는 외부 MCP 도구가 걸러져 확인 카드로 갑니다</strong> — 읽기만 하는 도구도 마찬가지입니다.
      </Callout>

      <Callout tone="info" title="다만 사용자가 허용한 것은 기억됩니다">
        확인이 생략되는 경우로 문서화된 것은 세 가지이고, 셋 다 사용자가 직접 한 행동입니다.
        <strong>① 확인 카드에서 ‘항상 허용’ 을 누른 경우</strong> — 그 선택은 <em>같은 도구 · 같은 인자 조합</em> 에 대해서만 저장되고, 인자가 더 위험한 쪽으로 바뀌면 저장된 선택이 적용되지 않고 다시 물어봅니다.
        <strong>② 설정에서 그 도구에 대한 허용 규칙을 직접 추가한 경우.</strong>
        <strong>③ 권한 모드를 ‘전부 허용’ 으로 바꾼 경우.</strong>
        위 세 가지 중에, 호스트가 사용 빈도를 보고 도구를 스스로 자동 실행으로 올려 주는 항목은 없습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
