import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Admin" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Admin"
        title="Admin Console — Four Tabs on a Single Page"
        description="AdminPage.tsx is one page with four tabs: Catalog · Approvals · Manage · API Keys. Every admin action runs behind the role guard <RequireRole role='admin'>, and there is no separate 'users' page. Statistics are handled by /telemetry/summary + /dlp/stats."
      />

      <Tabs defaultValue="catalog" className="my-6">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="manage">Manage</TabsTrigger>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("mp-admin")} caption={shots["mp-admin"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>Admins can search the catalog directly / trigger uploads (<code>web/src/pages/AdminPage.tsx:36 useCatalog + apiRequest</code>).</p>
        </TabsContent>

        <TabsContent value="approvals">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("mp-admin-2")} caption={shots["mp-admin-2"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>
            Pending queue — <code>GET /api/v1/publishes/pending</code> (<code>api/admin.py:295</code>) +
            <code> POST /publishes/{"{publish_id}"}/approve</code> (<code>:322</code>) / <code>/reject</code> (<code>:387</code>) / <code>/rollout</code> (<code>:449</code>).
          </p>
        </TabsContent>

        <TabsContent value="manage">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("mp-admin-3")} caption={shots["mp-admin-3"].captionEn} aspect="wide" />
          </ScreenshotGallery>
          <p>
            Package yank · version yank · rollback · organization-allowed —
            <code> POST /plugins/{"{slug}"}/yank</code> (<code>:71</code>),
            <code> /versions/{"{version}"}/yank</code> (<code>:97</code>),
            <code> /rollback</code> (<code>:127</code>),
            <code> /organization-allowed</code> (<code>:179</code>).
          </p>
        </TabsContent>

        <TabsContent value="keys">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("mp-admin-4")} caption={shots["mp-admin-4"].captionEn} />
            <ScreenshotCard src={shotUrl("mp-admin-5")} caption={shots["mp-admin-5"].captionEn} />
          </ScreenshotGallery>
          <p>
            <code>POST /api-keys</code> (<code>:201</code>) · <code>GET /api-keys</code> (<code>:245</code>) ·
            <code> POST /api-keys/{"{key_id}"}/revoke</code> (<code>:268</code>) ·
            <code> DELETE /api-keys/{"{key_id}"}</code> (<code>:419</code>).
            There is no separate page for managing users/organizations directly — the ApiKey itself is the unit of user/role.
          </p>
        </TabsContent>
      </Tabs>

      <h2 id="audit">Audit Log</h2>
      <p>
        A single <code>AuditLog</code> table (<code>models.py:138</code>) records every admin action. There is no dedicated UI;
        querying directly requires the DB or exporting via an alembic migration.
      </p>

      <Callout tone="security" title="API Key Security">
        ApiKey never stores the raw key — only the sha256 hash + key_prefix are kept in the DB (<code>models.py:16-29</code>).
        Verification uses <code>secrets.compare_digest</code> (<code>security.py:61-72</code>). Supports revocation + expiry + rotation grace.
      </Callout>

      <PageNav />
    </article>
  );
}
