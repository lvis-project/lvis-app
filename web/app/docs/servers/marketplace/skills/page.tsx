import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { PageNav } from "@/components/docs/page-nav";
import { Callout } from "@/components/docs/callout";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Skills" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="Skills (plugin_type=skill)"
        description="키워드 + 도구 매핑 + 프롬프트 묶음의 재사용 가능한 'Skill' 패키지. 호스트의 keyword engine 이 등록된 키워드에 매칭될 때 사용자에게 Skill 카드를 추천합니다. 로컬 Skill 정의는 ~/.lvis/skills/<name>/SKILL.md 형식."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-skills")} caption={shots["mp-skills"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">Skill 의 구성 요소</h2>
      <ul>
        <li><strong>키워드</strong> — Skill 트리거 자연어 패턴. plugin 이라면 <code>hostApi.registerKeywords</code> 로 등록.</li>
        <li><strong>도구 매핑</strong> — 어떤 plugin 도구 / agent 를 사슬로 부를지.</li>
        <li><strong>프롬프트</strong> — SKILL.md 안의 system/user 메시지 템플릿.</li>
        <li><strong>RiskLevel meta</strong> — Skill 전체의 default. Tool RiskLevel 가 우선이긴 함.</li>
      </ul>

      <Callout tone="info" title="Skill 저장 위치">
        호스트는 등록된 Skill을 <code>~/.lvis/skills/&lt;name&gt;/SKILL.md</code> 에 저장합니다 (<code>skill-load.ts:57</code>).
        Skill 승인 메타는 <code>~/.lvis/skill-approvals.json</code>.
      </Callout>

      <PageNav />
    </article>
  );
}
