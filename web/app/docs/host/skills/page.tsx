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
        description="‘회의록 정리’, ‘주차 신청’, ‘오늘 일정 보여줘’ 같은 자주 하는 작업을 한 묶음으로 저장해 둔 게 Skill 입니다. 채팅에 등록된 키워드가 들어오면 호스트가 가장 적합한 Skill 을 자동으로 추천합니다."
        tags={["키워드 기반 자동 추천", "내 PC 안에 저장", "사용자 승인 후에만 실행"]}
      />

      <h2 id="what">Skill 한 장 안에 무엇이 들어 있나요?</h2>
      <FeatureGrid
        columns={2}
        items={[
          { title: "트리거 키워드", body: <>‘회의록 정리해줘’, ‘주차 신청’ 처럼 사용자가 자주 말하는 표현.</>, tone: "teal" },
          { title: "프롬프트", body: <>LLM 이 이 작업을 어떤 톤과 형식으로 처리해야 하는지 정리해 둔 문장 묶음.</> },
          { title: "도구 매핑", body: <>이 Skill 을 실행할 때 어떤 플러그인의 어떤 도구를 호출할지.</>, tone: "citron" },
          { title: "위험도", body: <>실행 시 사용자 확인이 필요한지, 자동으로 끝낼 수 있는지의 기본 설정.</> },
        ]}
      />

      <h2 id="where">어디에 저장되나요?</h2>
      <p>
        등록된 Skill 은 사용자 PC 의 안전한 LVIS 영역 안에 한 줄짜리 텍스트 파일 형태로 저장됩니다. 외부 서버로 전송되지 않으며,
        도메인 단위로 삭제 / 백업이 자유롭습니다. Skill 의 승인 상태 (자동 실행 허용 / 매번 확인 / 차단) 도 같은 영역에 함께 관리됩니다.
      </p>

      <h2 id="get-skill">Skill 은 어떻게 얻나요?</h2>
      <StepList
        steps={[
          {
            title: "플러그인 설치 시 함께 따라옴",
            body: <p>대부분의 플러그인은 기본 Skill 묶음을 가지고 들어옵니다. 예: Meeting 플러그인을 설치하면 ‘회의 녹음 시작’ Skill 이 자동 등록.</p>,
          },
          {
            title: "Marketplace 에서 추가",
            body: <p>플러그인과 별도로 Skill 묶음만 골라 설치할 수 있습니다. 다른 사용자가 만든 “주간 회고 정리” 같은 묶음을 그대로 받아 옵니다.</p>,
          },
          {
            title: "직접 작성",
            body: <p>고급 사용자는 자기만의 Skill 을 직접 작성해 저장할 수 있습니다. 호스트가 형식을 검증하고 위험도가 적절한지 확인합니다.</p>,
          },
        ]}
      />

      <Callout tone="security" title="실행은 항상 사용자 동의 후">
        Skill 에 등록되었다고 해서 자동으로 위험한 작업까지 실행되지 않습니다. 메일 발송 · 파일 삭제 같은 동작은
        Skill 의 위험도 설정과 별개로 호스트의 권한 흐름을 거쳐 사용자 확인을 받습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
