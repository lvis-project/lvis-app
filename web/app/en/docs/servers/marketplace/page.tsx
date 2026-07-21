import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

const sections = [
  { href: "/en/docs/servers/marketplace/plugins", title: "Plugin Catalog", desc: "List of installable plugins." },
  { href: "/en/docs/servers/marketplace/agents", title: "Agents", desc: "Smaller, single-task packages." },
  { href: "/en/docs/servers/marketplace/mcp", title: "MCP Servers", desc: "Directory of external tool sets." },
  { href: "/en/docs/servers/marketplace/skills", title: "Skills", desc: "Reusable capability bundles." },
  { href: "/en/docs/servers/marketplace/publisher", title: "Publisher", desc: "Package upload / version management." },
  { href: "/en/docs/servers/marketplace/admin", title: "Admin", desc: "Approval · revocation · key management." },
];

export const metadata = { title: "Marketplace Overview" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Server · Marketplace"
        title="LVIS Marketplace — One Catalog, Four Package Types"
        description="A marketplace for discovering and installing Plugins · Agents · MCP servers · Skills in one place. Every package's origin is verified through the publisher's signature and installed directly to the user's host via deeplink."
        tags={["Origin-verified packages", "Single install flow", "Publisher + admin separation"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("mp-login")} caption={shots["mp-login"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="audience">User Personas</h2>
      <ul>
        <li><strong>General users</strong> — pick the package you want from the catalog and install it to your host.</li>
        <li><strong>Publishers</strong> — upload their own packages and manage versions.</li>
        <li><strong>Admins</strong> — handle publish approval / revocation / user key management / operational statistics.</li>
      </ul>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="group rounded-lg border border-border bg-white p-4 transition hover:border-teal/40 hover:shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-semibold text-ink group-hover:text-teal">{s.title}</p>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-teal" />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{s.desc}</p>
          </Link>
        ))}
      </div>

      <Callout tone="info" title="Four types, one catalog">
        Plugins · Agents · MCP servers · Skills appear as separate tabs in the user-facing UI, but the publish / install
        flow is unified on a single system underneath. Publishers, too, handle every package type with one tool.
      </Callout>

      <PageNav />
    </article>
  );
}
