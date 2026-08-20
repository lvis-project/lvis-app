import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "MCP Servers — Bringing In External Tool Sets" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · MCP"
        title="MCP Servers — External Tool Sets, Inside LVIS"
        description="MCP is the standard protocol that connects externally provided tool collections so they can be used inside LVIS chat. A registered server can offer more than tools — it can also publish resources (material to read) and prompts (questions prepared in advance), and LVIS surfaces each of the three in a different place."
        tags={["Standard for connecting external tools", "Tools · resources · prompts", "Registered only after user consent"]}
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

      <h2 id="beyond-tools">What else comes in besides tools</h2>
      <p>
        An MCP server can offer two more things beyond tools. LVIS does not blend the three — each is surfaced in its own place and handled differently.
      </p>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "Resources — material the server holds",
            body: <>Documents, logs, records: things the server publishes as "you may read this." They arrive by two routes — the user picks one by typing <code>@</code> in the composer, or the model finds and reads them itself with <code>mcp_resource_list</code> / <code>mcp_resource_read</code>.</>,
            tone: "teal",
          },
          {
            title: "Resource templates — material with blanks",
            body: <>"Give me an issue number and I'll give you that issue." Picking one from the <code>@</code> list opens a host dialog to fill the blanks, and <strong>the host</strong> — not the renderer — builds the filled-in address and reads it.</>,
          },
          {
            title: "Prompts — questions the server prepared",
            body: <>A set of questions the server prepared as "ask me this and I'll answer well." Pick one by typing <code>/</code> in the composer; if it takes arguments, a form appears first.</>,
            tone: "citron",
          },
          {
            title: "Server instructions",
            body: <>A note a connected server attaches saying how it wants to be used. It is passed to the model as reference material, <strong>never as instructions to follow</strong>.</>,
          },
        ]}
      />

      <Callout tone="security" title="What a server wrote is not what the user wrote">
        Resource bodies and prompt bodies are <strong>written by the server</strong>. The user chose to fetch them; the user did not write them.
        So LVIS does not drop that content in beside the user's own words — it wraps it in a labelled block that names its origin before handing it to the model.
        The host neutralizes the delimiter characters so a server cannot close that block or open a new one to pass itself off as the user, and there are length caps.
      </Callout>

      <Callout tone="security" title="External server tools ask every time">
        The host treats tools from an external MCP server at the lowest trust level. In the default modes that means <strong>they ask the user every time, regardless of risk band or category</strong> —
        read-only tools included. There is <strong>no mechanism today</strong> by which a tool you have grown comfortable with graduates to running automatically.
        The only way past that prompt is for the user to switch the permission mode itself to "allow all."
      </Callout>

      <PageNav />
    </article>
  );
}
