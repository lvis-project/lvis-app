import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MEMORY — 사용자가 LVIS에게 알려준 것들" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Memory"
        title="MEMORY — LVIS가 사용자에 대해 기억하는 것"
        description="‘내 직책 / 자주 쓰는 일정 패턴 / 선호하는 회의 시간 / 자주 만나는 동료’ 같은 정보를 LVIS가 한 곳에 모아 둔 메모입니다. 사용자가 LVIS에게 한번 알려주면 이후 모든 대화에서 그 사실을 자연스럽게 참고합니다."
        tags={["사용자가 직접 관리", "내 PC 안에만 저장", "언제든 보고 / 수정 가능"]}
      />

      <h2 id="what">어떤 것들이 저장되나요?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "역할 / 책임", body: <>‘나는 백엔드 개발자이고 OOO 팀 리더야’ 같은 단순 사실.</>, tone: "teal" },
          { title: "선호와 습관", body: <>회의는 오후 3시 이후, 보고서는 한 페이지 요약 우선 같은 습관.</> },
          { title: "자주 다루는 사람들", body: <>주 1회 이상 메일을 주고받는 팀원, 직접 보고선 등.</>, tone: "citron" },
          { title: "안 했으면 하는 것", body: <>‘메일 자동 답장은 절대 보내지 말 것’ 같은 제한 사항.</>, tone: "coral" },
        ]}
      />

      <h2 id="how">어떻게 추가하나요?</h2>
      <ul>
        <li>대화 도중 “이건 기억해 둬” 라고 말하면 호스트가 메모 후보를 카드로 띄웁니다. 확인 누르면 저장.</li>
        <li>설정 화면에서 직접 한 줄씩 추가하거나 편집할 수 있습니다.</li>
        <li>플러그인이 새 사실을 발견했을 때도 자동으로 저장되지 않고, 항상 사용자 확인 카드를 거칩니다.</li>
      </ul>

      <h2 id="where">어디에 저장되나요?</h2>
      <p>
        모든 메모리는 사용자 PC 의 LVIS 영역 안에만 보관됩니다. 외부 서버 / Marketplace / Agent Hub 어디로도 전송되지 않습니다.
        한 줄짜리 텍스트 파일이라 사용자가 파일을 직접 열어 보거나 수정할 수도 있습니다.
      </p>

      <Callout tone="security" title="잊는 것도 명시적으로">
        ‘이건 잊어 줘’ 라고 말하면 호스트가 해당 메모 후보를 보여주고 사용자 확인 후 제거합니다. 자동으로 사라지는 메모는 없습니다.
      </Callout>

      <Callout tone="info" title="첫 사용 시점의 메모 시드">
        LVIS 첫 실행 시 호스트가 메모리 시드 입력 화면을 띄워, 가장 기본적인 사실 (역할 / 팀 / 자주 쓰는 도구) 을 한 번에 입력할 수 있게 도와줍니다.
      </Callout>

      <PageNav />
    </article>
  );
}
