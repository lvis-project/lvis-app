import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Permissions — Risk Management" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="Risk Management — Risk Level × Tool Category"
        description="LVIS's permission model is a grid where two axes intersect. The tool's risk level (low/medium/high) and its category (read/write/execute/network) meet to determine whether it runs automatically, shows an inline confirmation, or opens a dialog."
        tags={["3 risk levels", "5 tool categories", "additional-consent chain"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-permission-risk")} caption={shots["chat-permission-risk"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="grid">Decision grid</h2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className="border border-border p-2.5">Risk \ Category</th>
              <th className="border border-border p-2.5">Read</th>
              <th className="border border-border p-2.5">Write</th>
              <th className="border border-border p-2.5">Execute</th>
              <th className="border border-border p-2.5">Network</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="border border-border p-2.5 font-semibold text-teal-dark">Low</td><td className="border border-border p-2.5">Auto</td><td className="border border-border p-2.5">Auto</td><td className="border border-border p-2.5">Card confirm</td><td className="border border-border p-2.5">Auto</td></tr>
            <tr><td className="border border-border p-2.5 font-semibold text-coral">Medium</td><td className="border border-border p-2.5">Auto</td><td className="border border-border p-2.5">Card confirm</td><td className="border border-border p-2.5">Dialog</td><td className="border border-border p-2.5">Card confirm</td></tr>
            <tr><td className="border border-border p-2.5 font-semibold text-coral">High</td><td className="border border-border p-2.5">Card confirm</td><td className="border border-border p-2.5">Dialog</td><td className="border border-border p-2.5">Dialog + additional consent</td><td className="border border-border p-2.5">Dialog</td></tr>
          </tbody>
        </table>
      </div>
      <p className="text-[12.5px] text-muted-foreground">In strict mode, both medium and high are escalated to a dialog.</p>

      <Callout tone="security" title="Additional-consent chain">
        High-risk actions preserve user consent as an immutable record chain. You can later verify exactly who consented, when, and with what scope — preventing automation from happening "quietly."
      </Callout>

      <PageNav />
    </article>
  );
}
