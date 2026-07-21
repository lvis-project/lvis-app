import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — 어드민" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Admin"
        title="어드민 콘솔 — 단일 페이지 4 탭"
        description="AdminPage.tsx 한 페이지 안에 Catalog · Approvals · Manage · API Keys 4 탭. 모든 admin 작업은 role guard <RequireRole role='admin'> 뒤에서 수행되고, 별도 ‘users’ 페이지는 없습니다. 통계는 /telemetry/summary + /dlp/stats 가 담당."
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
            <ScreenshotCard src={shotUrl("mp-admin")} caption={shots["mp-admin"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>admin이 직접 카탈로그를 검색 / 업로드 트리거 (<code>web/src/pages/AdminPage.tsx:36 useCatalog + apiRequest</code>).</p>
        </TabsContent>

        <TabsContent value="approvals">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("mp-admin-2")} caption={shots["mp-admin-2"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>
            대기 큐 — <code>GET /api/v1/publishes/pending</code> (<code>api/admin.py:295</code>) +
            <code> POST /publishes/{"{publish_id}"}/approve</code> (<code>:322</code>) / <code>/reject</code> (<code>:387</code>) / <code>/rollout</code> (<code>:449</code>).
          </p>
        </TabsContent>

        <TabsContent value="manage">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("mp-admin-3")} caption={shots["mp-admin-3"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>
            패키지 yank · 버전 yank · rollback · organization-allowed —
            <code> POST /plugins/{"{slug}"}/yank</code> (<code>:71</code>),
            <code> /versions/{"{version}"}/yank</code> (<code>:97</code>),
            <code> /rollback</code> (<code>:127</code>),
            <code> /organization-allowed</code> (<code>:179</code>).
          </p>
        </TabsContent>

        <TabsContent value="keys">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("mp-admin-4")} caption={shots["mp-admin-4"].caption} />
            <ScreenshotCard src={shotUrl("mp-admin-5")} caption={shots["mp-admin-5"].caption} />
          </ScreenshotGallery>
          <p>
            <code>POST /api-keys</code> (<code>:201</code>) · <code>GET /api-keys</code> (<code>:245</code>) ·
            <code> POST /api-keys/{"{key_id}"}/revoke</code> (<code>:268</code>) ·
            <code> DELETE /api-keys/{"{key_id}"}</code> (<code>:419</code>).
            사용자/조직 직접 관리 페이지는 별도로 없고, ApiKey 자체가 사용자/role 의 단위.
          </p>
        </TabsContent>
      </Tabs>

      <h2 id="audit">감사 로그</h2>
      <p>
        <code>AuditLog</code> 단일 테이블 (<code>models.py:138</code>) 이 모든 admin 액션을 기록. 별도 UI 가 없고
        직접 query 필요 시 DB 또는 alembic 마이그레이션 export 통해.
      </p>

      <Callout tone="security" title="API Key 보안">
        ApiKey 는 raw key를 저장하지 않고 sha256 hash + key_prefix 만 DB 에 보관 (<code>models.py:16-29</code>).
        verification: <code>secrets.compare_digest</code> (<code>security.py:61-72</code>). 회수 + 만료 + rotation grace 지원.
      </Callout>

      <PageNav />
    </article>
  );
}
