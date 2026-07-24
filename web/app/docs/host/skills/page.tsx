import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Skills — 재사용 가능한 능력 꾸러미" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Skills"
        title="Skills — 자주 쓰는 작업을 한 줄로 부르기"
        description="Skill 은 플러그인이 함께 제공하는 지침 묶음입니다. 호스트가 명시적 lifecycle로 읽어 모델에 필요한 작업 맥락을 제공하지만, Skill 자체가 플러그인을 활성화하거나 Tool 을 선택·호출하지는 않습니다."
        tags={["지침 번들", "Host 선택 도구 범위", "사용자 승인 후에만 실행"]}
      />

      <h2 id="what">Skill 한 장 안에 무엇이 들어 있나요?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "지침", body: <>LLM 이 작업을 어떤 맥락·순서·형식으로 다룰지 설명하는 문장 묶음.</>, tone: "teal" },
          { title: "번들 선언", body: <>플러그인이 <code>manifest.skills</code>로 artifact 안의 Skill 경로를 선언합니다.</> },
          { title: "도구 발견", body: <>호스트가 선택한 범위와 <code>tool_search</code>가 호출 가능한 Tool 을 모델에 제공합니다.</>, tone: "citron" },
          { title: "권한 경계", body: <>실행 권한과 위험도 판단은 Skill 이 아니라 각 Tool 과 호스트 정책이 담당합니다.</> },
        ]}
      />

      <h2 id="where">어디에 저장되나요?</h2>
      <p>
        플러그인이 제공하는 Skill 은 서명된 플러그인 artifact의 <code>skills/</code> 아래에 저장됩니다. 호스트는 설치 시 선언된 경로와
        <code>SKILL.md</code> 존재를 확인하고 메타데이터와 본문을 읽어 lifecycle에 투영합니다. Skill 은 실행 권한이나 별도 자동 실행 상태를 갖지 않습니다.
      </p>

      <h2 id="get-skill">Skill 은 어떻게 얻나요?</h2>
      <StepList
        steps={[
          {
            title: "플러그인 설치 시 함께 따라옴",
            body: <p>플러그인은 필요한 Skill 지침을 함께 번들할 수 있습니다. 예: Meeting 플러그인은 회의 작업에 필요한 맥락을 설명하는 Skill 을 제공합니다.</p>,
          },
          {
            title: "플러그인 업데이트로 갱신",
            body: <p>검증된 플러그인 업데이트가 Skill 지침도 함께 갱신합니다. 호스트는 변경된 artifact를 다시 검증합니다.</p>,
          },
          {
            title: "플러그인 작성자가 선언",
            body: <p>플러그인 작성자는 artifact 안에 Skill 을 작성하고 manifest 경로로 선언합니다. 호스트는 선언된 contribution 경로와 호출 가능한 Tool 을 별도 계약으로 검증합니다.</p>,
          },
        ]}
      />

      <Callout tone="security" title="실행은 항상 사용자 동의 후">
        Skill 을 읽었다고 해서 Tool 이 자동으로 선택·호출되지는 않습니다. 호출 가능한 Tool 은 Host-selected scope와
        <code>tool_search</code>로 발견되며, 메일 발송·파일 삭제 같은 동작은 각 Tool의 권한 흐름에서 사용자 확인을 받습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
