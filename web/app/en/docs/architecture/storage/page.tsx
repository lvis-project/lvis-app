import { PageHero } from "@/components/docs/page-hero";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "Architecture — Storage on Your PC" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="Storage on your PC — isolated by domain"
        description="LVIS stores user data in an LVIS area on the user's own PC, not on an external server. Even within that area, folders are split by domain (sessions · automation · minutes · plugin data) so backup and deletion stay clean."
        tags={["stays on your PC", "per-domain folders", "no cross-plugin access"]}
      />

      <FeatureGrid
        columns={2}
        items={[
          { title: "Chat sessions", body: <>Today's and yesterday's conversation history. Users can search or delete it themselves.</>, tone: "teal" },
          { title: "Automation records", body: <>Registered automation rules plus their fire history. Preserves what each automation did and when.</> },
          { title: "Audit log", body: <>One line per tool call. Split by date, so searching is easy.</>, tone: "citron" },
          { title: "Secrets", body: <>External auth tokens / API keys. Stored encrypted in the OS's secure storage.</>, tone: "coral" },
          { title: "Each plugin's own area", body: <>The space where a plugin stores its own data. No other plugin can access it.</> },
          { title: "Memory · Skills · Agents", body: <>Facts the user has told LVIS, plus registered capability bundles and units of work.</> },
        ]}
      />

      <h2 id="rules">Storage rules</h2>
      <ul>
        <li><strong>Per-domain folders</strong> — data of the same kind lives in one folder. Emptying a single folder resets that entire domain.</li>
        <li><strong>Strong file permissions</strong> — every folder and file has strong permissions applied so only the same user can access it.</li>
        <li><strong>Plugin isolation</strong> — all plugin data lives inside a "per-plugin folder." No direct access to other plugins' or the host's area.</li>
        <li><strong>Daily audit separation</strong> — audit logs are split into files by date, so even old records stay quickly searchable.</li>
      </ul>

      <Callout tone="info" title="Backup / delete / migrate">
        Because folders are separated by domain, operations like "back up only the meeting minutes," "reset only automation," or "remove only plugin X's data" become simple folder operations.
        If you use a separate cloud backup tool, you can freely choose which folders to sync.
      </Callout>

      <PageNav />
    </article>
  );
}
