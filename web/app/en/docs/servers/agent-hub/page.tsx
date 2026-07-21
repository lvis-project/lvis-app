import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub Server Overview" };

const subs = [
  { href: "/en/docs/servers/agent-hub/workboard", title: "Workboard", desc: "work-items + board derived view." },
  { href: "/en/docs/servers/agent-hub/inbox", title: "Inbox", desc: "Three models: DirectMessage · ApprovalRequest · Notification." },
  { href: "/en/docs/servers/agent-hub/report", title: "Report", desc: "/reports/personal · /reports/team/{team_code}." },
  { href: "/en/docs/servers/agent-hub/subscription", title: "Team Feed Subscription", desc: "Subscription = team-feed opt-in (no plan/license model)." },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Server · Agent Hub"
        title="Agent Hub — FastAPI + asyncpg + alembic Server"
        description="An asynchronous message board server combining My Work / Team Work / direct messages / approval requests / operational reports. WorkLog is an append-only + signed chain. The React 19 + Vite 6 web admin SPA is separate."
        tags={[
          "FastAPI 0.115+",
          "asyncpg + alembic",
          "HTTPBearer + ApiKey sha256",
          "agent-hub.lvisai.xyz",
        ]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-dashboard")} caption={shots["ah-dashboard"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="auth">Authentication</h2>
      <ul>
        <li><strong>Scheme</strong> — HTTPBearer (<code>security.py:24</code>). <code>Actor = (api_key, employee)</code>.</li>
        <li><strong>Token storage</strong> — sha256 hash only. Supports revoke / rotation_grace / expiry.</li>
        <li><strong>Roles</strong> — <code>ApiKeyRole = EMPLOYEE | ADMIN</code> (<code>models.py:137</code>).</li>
        <li><strong>Token exchange</strong> — <code>POST /auth/exchange/issue</code> + <code>/redeem</code> (PKCE-like, web SPA login).</li>
      </ul>

      <h2 id="org">Organization Model</h2>
      <p>
        <code>Department</code> (<code>models.py:149</code>) is a self-referencing parent_id + materialized path (a tree). <code>Employee</code> (<code>:169</code>) has a
        <code>department_id</code> + an optional <code>manager_id</code> (approval routing). There is no multi-tenant separation — a single organization is assumed.
      </p>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {subs.map((s) => (
          <Link key={s.href} href={s.href} className="group rounded-lg border border-border bg-white p-4 transition hover:border-teal/40 hover:shadow-sm">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-semibold text-ink group-hover:text-teal">{s.title}</p>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-teal" />
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{s.desc}</p>
          </Link>
        ))}
      </div>

      <Callout tone="info" title="Sync model — polling pull">
        The host's agent-hub plugin fetches the inbox via polling every 5 minutes (not push).
        idempotency_key is the consistency key — a duplicate POST with the same (author_id, idempotency_key) returns the existing row.
      </Callout>

      <PageNav />
    </article>
  );
}
