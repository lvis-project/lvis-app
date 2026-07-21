import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub 서버 개요" };

const subs = [
  { href: "/docs/servers/agent-hub/workboard", title: "Workboard", desc: "work-items + 보드 derived view." },
  { href: "/docs/servers/agent-hub/inbox", title: "Inbox", desc: "DirectMessage · ApprovalRequest · Notification 3 모델." },
  { href: "/docs/servers/agent-hub/report", title: "Report", desc: "/reports/personal · /reports/team/{team_code}." },
  { href: "/docs/servers/agent-hub/subscription", title: "팀 피드 구독", desc: "Subscription = team-feed opt-in (플랜/라이선스 모델 없음)." },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Server · Agent Hub"
        title="Agent Hub — FastAPI + asyncpg + alembic 서버"
        description="My Work / Team Work / 직접 메시지 / 승인 요청 / 운영 리포트를 모은 비동기 메시지 보드 서버. WorkLog 는 append-only + signed chain. React 19 + Vite 6 web admin SPA 별도."
        tags={[
          "FastAPI 0.115+",
          "asyncpg + alembic",
          "HTTPBearer + ApiKey sha256",
          "agent-hub.lvisai.xyz",
        ]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-dashboard")} caption={shots["ah-dashboard"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="auth">인증</h2>
      <ul>
        <li><strong>Scheme</strong> — HTTPBearer (<code>security.py:24</code>). <code>Actor = (api_key, employee)</code>.</li>
        <li><strong>Token storage</strong> — sha256 hash 만. revoke / rotation_grace / expiry 지원.</li>
        <li><strong>Roles</strong> — <code>ApiKeyRole = EMPLOYEE | ADMIN</code> (<code>models.py:137</code>).</li>
        <li><strong>Token exchange</strong> — <code>POST /auth/exchange/issue</code> + <code>/redeem</code> (PKCE-like, web SPA 로그인).</li>
      </ul>

      <h2 id="org">조직 모델</h2>
      <p>
        <code>Department</code> (<code>models.py:149</code>) 가 self-ref parent_id + materialized path (트리). <code>Employee</code> (<code>:169</code>) 가
        <code>department_id</code> + 선택적 <code>manager_id</code> (승인 routing). 멀티-테넌트 분리는 없음 — 단일 organization 가정.
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

      <Callout tone="info" title="동기화 모델 — polling pull">
        호스트의 agent-hub 플러그인은 5분 간격 polling 으로 inbox 를 가져옵니다 (push 아님).
        idempotency_key 가 일관성 키 — 동일 (author_id, idempotency_key) 중복 POST 는 기존 row 반환.
      </Callout>

      <PageNav />
    </article>
  );
}
