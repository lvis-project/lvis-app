import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { Callout } from "@/components/docs/callout";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Tool & Thinking Display" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Chat"
        title="Tool Execution and Thinking Display"
        description="LVIS visually surfaces tool calls and what the LLM is thinking through. Every tool call branches into auto-run / confirmation card / dialog based on its risk level and category."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-tool-thinking")} caption={shots["chat-tool-thinking"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={2}
        items={[
          { title: "Thinking block", body: <>Shows what the LLM is "thinking" while composing an answer, in a light quote block. Click to collapse / expand.</>, tone: "ink" },
          { title: "Tool execution card", body: <>Tool name · a summary of the inputs used · the result, all in one card. Long results expand into a larger view via "See more."</>, tone: "teal" },
        ]}
      />

      <h2 id="tool-source">Three sources of tools</h2>
      <ul>
        <li><strong>Built-in host tools</strong> — tools provided by LVIS itself. The most trusted.</li>
        <li><strong>Plugin tools</strong> — tools registered by an installed plugin. Operate within their own domain.</li>
        <li><strong>External MCP tools</strong> — tools from an external MCP server registered by the user. Treated at the lowest trust level, so they <a href="/docs/host/mcp#beyond-tools">ask every time in the default modes</a>.</li>
      </ul>

      <h2 id="long-running">Long-running commands, and images</h2>
      <ul>
        <li><strong>Background execution</strong> — a long-running shell command can be sent to the background. The conversation is not blocked until it finishes, and its output can be read while it runs or the command killed partway.</li>
        <li><strong>Viewing an image</strong> — an image file on the PC (png · jpeg · gif · webp) can be loaded so the model actually <em>sees</em> it. There is a size cap, and a file that is not an image is refused.</li>
        <li><strong>When the tool list gets long</strong> — as installed plugins and MCP servers accumulate, the host stops handing the model every tool at once and switches to searching for the ones it needs.</li>
      </ul>

      <Callout tone="security" title="Every tool call is logged">
        Whether it succeeds or fails, every tool call leaves a one-line record in secure storage. External code execution is logged separately and retained longer.
      </Callout>

      <PageNav />
    </article>
  );
}
