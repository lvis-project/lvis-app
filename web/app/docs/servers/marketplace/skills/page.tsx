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
        description="SKILL.md, 선택적 reference, 제한된 workflow로 구성한 재사용 가능한 지침 패키지. Skill은 도구 사용을 안내하지만 호출 가능한 메서드나 자연어 라우팅 alias가 아닙니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-skills")} caption={shots["mp-skills"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">Skill 의 구성 요소</h2>
      <ul>
        <li><strong>SKILL.md</strong> — 진입점 지침과 라우팅 가이드.</li>
        <li><strong>Reference와 asset</strong> — workflow가 사용하는 선택적 검증 파일.</li>
        <li><strong>Tool 안내</strong> — manifest Tool을 선택하는 지침이며 암묵 호출하지 않음.</li>
        <li><strong>보안 경계</strong> — Tool 권한은 호스트가 소유하고 호출 시점에 평가.</li>
      </ul>

      <Callout tone="info" title="Skill 저장 위치">
        호스트는 등록된 Skill을 <code>~/.lvis/skills/&lt;name&gt;/SKILL.md</code> 에 저장합니다 (<code>skill-load.ts:57</code>).
        Skill 승인 메타는 <code>~/.lvis/skill-approvals.json</code>.
      </Callout>

      <PageNav />
    </article>
  );
}
