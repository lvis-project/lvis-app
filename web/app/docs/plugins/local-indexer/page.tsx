import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";
import { FolderOpen, Search, Cpu } from "lucide-react";

export const metadata = { title: "Local Indexer 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · Local Indexer"
        title="Local Indexer — 내 PC 자료를 LVIS 안에서 검색"
        description="지정한 폴더의 문서를 자동으로 분석해 LVIS 채팅에서 인용 가능한 검색 컨텍스트로 만들어 둡니다. 한국어 문서 / PDF / 마크다운에 최적화되어 있습니다."
        tags={["로컬 RAG", "한국어 최적화", "자동 동기화"]}
      />

      <ScreenshotGallery columns={3}>
        <ScreenshotCard src={shotUrl("local-indexer-home")} caption={shots["local-indexer-home"].caption} />
        <ScreenshotCard src={shotUrl("local-indexer-add-folder")} caption={shots["local-indexer-add-folder"].caption} />
        <ScreenshotCard src={shotUrl("local-indexer-indexing")} caption={shots["local-indexer-indexing"].caption} />
      </ScreenshotGallery>

      <FeatureGrid
        columns={3}
        items={[
          {
            icon: <FolderOpen className="h-5 w-5" />,
            title: "폴더 단위 자동 감시",
            body: <>지정한 폴더에 파일이 추가 / 수정 / 삭제될 때 자동으로 인덱스를 갱신합니다. 무거운 폴링이 없어 조용합니다.</>,
            tone: "teal",
          },
          {
            icon: <Cpu className="h-5 w-5" />,
            title: "한국어 문서에 최적화",
            body: <>한국어 형태소 분석을 거쳐 짧은 단어로도 잘 검색되도록 본문을 잘게 정리합니다. PDF · Markdown 모두 지원.</>,
          },
          {
            icon: <Search className="h-5 w-5" />,
            title: "여러 검색 결과를 함께",
            body: <>키워드 검색과 의미 기반 검색을 결합해 가장 적합한 후보를 골라냅니다. 단발 매칭이 아닌 다단계 결합.</>,
            tone: "citron",
          },
        ]}
      />

      <h2 id="add-folder">폴더 추가하기</h2>
      <StepList
        steps={[
          { title: "폴더 선택", body: <p>OS 의 파일 선택 다이얼로그에서 인덱싱할 폴더를 고릅니다.</p> },
          { title: "미리보기", body: <p>해당 폴더의 파일 수와 예상 분석 시간을 미리 보여줍니다.</p> },
          { title: "추가", body: <p>‘추가’ 를 누르면 백그라운드에서 초기 분석을 시작하고, 이후 폴더 안 변경은 자동으로 반영됩니다.</p>, badge: "자동 감시" },
        ]}
      />

      <h2 id="scenario">실전 시나리오 — “어디 저장해뒀더라?” 부터 발표 슬라이드까지</h2>
      <p>
        Local Indexer 의 진짜 가치는 단발 검색이 아니라 <strong>찾기 → 경로 확인 → 내용 정리 → 포맷 변환</strong> 의 사슬에서 나옵니다.
      </p>
      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("local-indexer-index-search")} caption={shots["local-indexer-index-search"].caption} />
        <ScreenshotCard src={shotUrl("local-indexer-search")} caption={shots["local-indexer-search"].caption} />
        <ScreenshotCard src={shotUrl("local-indexer-search-2")} caption={shots["local-indexer-search-2"].caption} />
        <ScreenshotCard src={shotUrl("local-indexer-search-3")} caption={shots["local-indexer-search-3"].caption} />
      </ScreenshotGallery>
      <StepList
        steps={[
          { title: "키워드로 파일 찾기", body: <p>“Detection step 관련 자료 어디 있었지?” 같은 자연어 검색에 가장 적합한 파일 후보와 근거를 함께 보여줍니다.</p>, badge: "찾기" },
          { title: "정확한 경로 확인", body: <p>UNC 경로까지 포함한 절대 경로가 그대로 출력되어 OS 파일 매니저에서 바로 열 수 있습니다.</p>, badge: "경로" },
          { title: "내용 자동 정리", body: <p>같은 파일의 핵심 내용만 골라 요약합니다. 재검색 없이 같은 매칭 결과를 재사용해서 빠르고 일관됩니다.</p>, badge: "요약" },
          { title: "발표용 한 장으로 재포맷", body: <p>같은 컨텐츠를 한 장짜리 발표용 포맷으로 다시 정리합니다.</p>, badge: "변환" },
        ]}
      />

      <Callout tone="security" title="자료는 내 PC 에만">
        모든 인덱스 / 임베딩 / 캐시는 사용자 PC 안에 보관됩니다. 외부 서버로 전송되지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
