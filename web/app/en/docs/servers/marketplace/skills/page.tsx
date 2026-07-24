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
        description="A reusable instruction package built around SKILL.md, optional references, and bounded workflows. Skills guide tool use but are not callable methods or natural-language routing aliases."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-skills")} caption={shots["mp-skills"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">Components of a Skill</h2>
      <ul>
        <li><strong>SKILL.md</strong> — the entrypoint instructions and routing guidance.</li>
        <li><strong>References and assets</strong> — optional verified files used by the workflow.</li>
        <li><strong>Tool guidance</strong> — instructions for selecting manifest Tools without invoking them implicitly.</li>
        <li><strong>Security boundary</strong> — Tool permissions remain Host-owned and are evaluated at invocation time.</li>
      </ul>

      <Callout tone="info" title="Where Skills are stored">
        The host stores a registered Skill at <code>~/.lvis/skills/&lt;name&gt;/SKILL.md</code> (<code>skill-load.ts:57</code>).
        Skill approval metadata lives at <code>~/.lvis/skill-approvals.json</code>.
      </Callout>

      <PageNav />
    </article>
  );
}
