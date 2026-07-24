import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Permissions — LLM Autonomous Review" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="LLM Autonomous Review Mode"
        description="The 'llm' mode among 4 reviewer modes. The LLM assists in evaluating risk patterns that are hard to catch with simple static rules — natural-language reasons, argument context, cross-tool chains. Its evaluation is only a recommendation — the host makes the actual decision by combining it with the user's grant + RiskLevel."
        tags={["src/permissions/reviewer/risk-classifier.ts", "modes: disabled · rule · llm · strict"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-permission-llm-review")} caption={shots["chat-permission-llm-review"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={2}
        items={[
          { title: "disabled", body: <>LLM review off. Only static rules (RiskLevel × Category × grant) apply.</> },
          { title: "rule", body: <>Recommendations based on static rules. No LLM call → fast.</>, tone: "teal" },
          { title: "llm", body: <>The LLM examines arguments + reason + context and issues a recommendation. Active on medium/high-risk tool calls.</>, tone: "citron" },
          { title: "strict", body: <>Forces a user dialog for every medium/high action. Minimizes automation.</>, tone: "coral" },
        ]}
      />

      <h2 id="when">When does LLM review fire?</h2>
      <ul>
        <li>At tool-call time, when the reviewer classifies RiskLevel as <code>medium</code> or higher.</li>
        <li>In a cross-plugin <code>callTool</code> chain, to check that permission scope matches the manifest's <code>pluginAccess</code>.</li>
        <li>For cross-plugin risky actions where <code>hostApi.agentApproval.request</code> was called — the LLM reviews the reason + scope.</li>
      </ul>

      <h2 id="limits">What the LLM cannot change directly</h2>
      <ul>
        <li>A tool's RiskLevel — fixed as metadata. Cannot be downgraded by an LLM result.</li>
        <li>A tool's risk classification — derived by the Host from its schema and execution path. Plugin metadata can strengthen policy but cannot lower it.</li>
        <li>User grants — only the user can change these.</li>
      </ul>

      <Callout tone="warn" title="The no-fallback rule">
        Even if the LLM recommends allowing auto-run, a static rule that blocks it always takes priority. We never write bypass/fallback code that lets a risky action run anyway.
        The correct fix instead is to revise the risk metadata itself, split the tool into read/write, or route explicitly through the agentApproval flow.
      </Callout>

      <PageNav />
    </article>
  );
}
