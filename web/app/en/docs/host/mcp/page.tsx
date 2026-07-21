import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MCP Servers — Bringing In External Tool Sets" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · MCP"
        title="MCP Servers — External Tool Sets, Inside LVIS"
        description="MCP is the standard protocol that connects externally provided tool collections so they can be used inside LVIS chat. Once registered, the tools that server provides join LVIS's tool list, ready for the LLM to use naturally."
        tags={["Standard for connecting external tools", "Discovered via the Marketplace", "Registered only after user consent"]}
      />

      <h2 id="why">When would you use it?</h2>
      <ul>
        <li>When you want to call your company's internal database or API from LVIS chat.</li>
        <li>When you want to bring a paid external service (e.g. search / translation / code analysis) into LVIS.</li>
        <li>When you want to borrow a tool collection another team built, as-is.</li>
      </ul>

      <h2 id="register">Registration flow</h2>
      <StepList
        steps={[
          {
            title: "Discover in the Marketplace",
            body: <p>Check the list of available servers in the Marketplace's MCP tab. Ratings and usage stats are shown alongside each one.</p>,
          },
          {
            title: "Press the registration deeplink",
            body: <p>Pressing "Register" sends a registration request to the LVIS host. You can also enter a URL directly.</p>,
          },
          {
            title: "Review the tool list + consent",
            body: <p>The host fetches the list of tools that server will provide and shows it to the user in advance. Risk level and scope are reviewed at this point.</p>,
            badge: "User confirmation",
          },
          {
            title: "Joins the tool list",
            body: <p>After consent, that server's tools join LVIS's tool list. They can be called with natural language from chat.</p>,
          },
        ]}
      />

      <Callout tone="security" title="Classified conservatively at first">
        Tools from an external MCP server are classified as "medium risk" by default. Downgrading to auto-run (low risk) requires additional review by an operator.
        From the user's side, a confirmation card appears every time at first, and only tools you've grown comfortable with gradually move to auto-run.
      </Callout>

      <PageNav />
    </article>
  );
}
