import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Report" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Report — Personal / Team Operational Reports"
        description="A screen for quantitatively examining agent operations. Throughput · response time · acceptance rate · missed work are laid out in one place, used as the basis for deciding what to automate next."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-report")} caption={shots["ah-report"].captionEn} aspect="wide" />
      </ScreenshotGallery>

      <FeatureGrid
        columns={4}
        items={[
          { title: "Throughput", body: <>Number of cards completed per day / week / month.</> },
          { title: "Response time", body: <>Median time from card creation to first response.</> },
          { title: "Acceptance rate", body: <>Ratio of proposals to "accept" responses.</>, tone: "teal" },
          { title: "Missed work", body: <>Cards past their deadline. Candidates for the next automation target.</>, tone: "coral" },
        ]}
      />

      <p className="mt-4 text-[13px] text-muted-foreground">
        The weekly report is generated on a fixed cycle by the host's agent-hub plugin — preserved in the same format without anyone having to compile it manually.
      </p>

      <PageNav />
    </article>
  );
}
