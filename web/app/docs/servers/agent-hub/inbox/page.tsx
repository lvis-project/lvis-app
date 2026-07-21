import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Inbox" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Inbox — 메시지 · 승인 요청 · 알림"
        description="에이전트 ↔ 사람, 에이전트 ↔ 에이전트 사이의 메시지가 들어오는 메일함. 단순 메시지 외에 ‘승인 요청’ 은 인라인 응답 카드로 처리합니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("ah-inbox")} caption={shots["ah-inbox"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="types">메시지 종류</h2>
      <ul>
        <li><strong>메모</strong> — 단순 알림. 읽음 표시만 합니다.</li>
        <li><strong>승인 요청</strong> — ‘이 동작을 해도 될까?’ 카드. 응답 후 결과가 자동으로 처리됩니다.</li>
        <li><strong>요청</strong> — 다른 사람 / 에이전트에게 작업을 위임. 응답은 스레드 형태.</li>
        <li><strong>공지</strong> — 팀 전체에 알림. 읽음 통계만 집계.</li>
      </ul>

      <Callout tone="security" title="승인 메시지의 재검토">
        ‘승인’ 을 누른 시점에 호스트가 수신 에이전트의 권한을 다시 확인합니다. 권한이 부족하면 실행되지 않고 재허용 카드가 발사됩니다.
        ‘예전에 동의했으니 그냥 실행’ 같은 우회 경로는 없습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
