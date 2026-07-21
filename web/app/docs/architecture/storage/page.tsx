import { PageHero } from "@/components/docs/page-hero";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "아키텍처 — 내 PC 안의 저장소" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="내 PC 안의 저장소 — 도메인 단위로 격리"
        description="LVIS는 사용자 데이터를 외부 서버가 아니라 사용자 PC 안의 LVIS 영역에 저장합니다. 같은 영역 안에서도 도메인 (세션 · 자동화 · 회의록 · 플러그인 데이터) 별로 폴더가 나뉘어 백업과 삭제가 깔끔합니다."
        tags={["내 PC 안에만", "도메인 단위 폴더", "다른 플러그인 영역 접근 금지"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          { title: "채팅 세션", body: <>오늘 / 어제 나눈 대화 기록. 사용자가 직접 검색 / 삭제할 수 있습니다.</>, tone: "teal" },
          { title: "자동화 기록", body: <>등록한 자동화 규칙 + 발사된 이력. 어떤 자동화가 언제 무엇을 했는지 모두 보존.</> },
          { title: "감사 기록", body: <>모든 도구 호출 한 줄씩. 날짜별로 분리되어 검색이 쉬움.</>, tone: "citron" },
          { title: "비밀값", body: <>외부 인증 토큰 / API 키. 운영체제의 보안 저장소에 암호화되어 보관.</>, tone: "coral" },
          { title: "각 플러그인 영역", body: <>플러그인이 자기 데이터를 저장하는 공간. 다른 플러그인은 접근할 수 없습니다.</> },
          { title: "메모리 · 스킬 · 에이전트", body: <>사용자가 LVIS에게 알려준 사실, 등록한 능력 묶음과 작업 단위.</> },
        ]}
      />

      <h2 id="rules">저장 규칙</h2>
      <ul>
        <li><strong>도메인 단위 폴더</strong> — 같은 종류의 데이터는 한 폴더 안에 모입니다. 폴더 하나를 비우면 그 도메인 전체가 리셋됩니다.</li>
        <li><strong>강한 파일 권한</strong> — 모든 폴더와 파일은 같은 사용자만 접근할 수 있도록 강한 권한이 적용됩니다.</li>
        <li><strong>플러그인 격리</strong> — 플러그인 데이터는 모두 ‘플러그인별 폴더’ 안에. 다른 플러그인 / 호스트 영역에 직접 접근할 수 없습니다.</li>
        <li><strong>일별 감사 분리</strong> — 감사 기록은 날짜별로 파일이 나뉘어 오래된 기록도 빠르게 검색 가능.</li>
      </ul>

      <Callout tone="info" title="백업 / 삭제 / 이전">
        도메인 단위로 폴더가 분리되어 있어 ‘회의록만 백업’, ‘자동화만 리셋’, ‘플러그인 X 의 데이터만 제거’ 같은 작업이 단순한 폴더 조작으로 됩니다.
        클라우드 백업 도구를 따로 쓰는 경우에도 어떤 폴더만 동기화할지 자유롭게 고를 수 있습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
