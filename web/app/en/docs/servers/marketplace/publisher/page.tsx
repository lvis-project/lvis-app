import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Marketplace — Publisher" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Publisher"
        title="Publisher — The Screen for Uploading Your Own Packages"
        description="A dashboard for anyone publishing plugins · agents · MCP servers · skills to the Marketplace. Upload new versions · review change history · check download statistics · respond to user reviews, all in one place."
        tags={["Publisher signature", "Immutable per version", "Awaiting admin approval"]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("mp-publisher")} caption={shots["mp-publisher"].captionEn} />
        <ScreenshotCard src={shotUrl("mp-publisher-2")} caption={shots["mp-publisher-2"].captionEn} />
      </ScreenshotGallery>

      <h2 id="upload">Package Upload Flow</h2>
      <StepList
        steps={[
          { title: "Log in to publishing", body: <p>Log in to your account with the publishing tool. Your publisher key gets registered.</p>, badge: "one-time" },
          { title: "Build + sign the package", body: <p>Build the package locally and sign it with your publisher key. The signature is bundled into the package.</p>, badge: "signing" },
          { title: "Upload → awaiting approval", body: <p>After upload, it enters the admin approval queue. Not yet visible to regular users.</p> },
          { title: "Admin approval → published", body: <p>Once an admin confirms it, it appears in the catalog. A published version is immutable — you cannot re-upload the same (id, version).</p>, badge: "published" },
        ]}
      />

      <Callout tone="info" title="If something goes wrong: new version + yank">
        You cannot "overwrite" a version once it's published. If an issue is found, upload a new version, or ask an admin to "yank" (revoke) the previous version.
      </Callout>

      <PageNav />
    </article>
  );
}
