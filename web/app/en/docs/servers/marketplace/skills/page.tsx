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
        description="A reusable 'Skill' package bundling keywords + tool mappings + prompts. When the host's keyword engine matches a registered keyword, it recommends the Skill card to the user. Local Skill definitions follow the ~/.lvis/skills/<name>/SKILL.md format."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-skills")} caption={shots["mp-skills"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="what">Components of a Skill</h2>
      <ul>
        <li><strong>Keywords</strong> — natural-language trigger patterns for the Skill. For a plugin, registered via <code>hostApi.registerKeywords</code>.</li>
        <li><strong>Tool mapping</strong> — which plugin tools / agents to chain-call.</li>
        <li><strong>Prompts</strong> — system/user message templates inside SKILL.md.</li>
        <li><strong>RiskLevel meta</strong> — the default for the Skill as a whole. Tool RiskLevel still takes priority.</li>
      </ul>

      <Callout tone="info" title="Where Skills are stored">
        The host stores a registered Skill at <code>~/.lvis/skills/&lt;name&gt;/SKILL.md</code> (<code>skill-load.ts:57</code>).
        Skill approval metadata lives at <code>~/.lvis/skill-approvals.json</code>.
      </Callout>

      <PageNav />
    </article>
  );
}
