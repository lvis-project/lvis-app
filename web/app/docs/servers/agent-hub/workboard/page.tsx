import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Agent Hub — Workboard" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Agent Hub"
        title="Workboard — 팀 단위 업무 카드"
        description="개인 TODO 와 분리된, 팀이 공유하는 업무 카드 보드. 각 카드는 담당 / 상태 / 마감 / 만든 사람을 가지고 있고, 처리 이력은 변경 불가능한 사슬로 따로 보존됩니다."
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("ah-workboard")} caption={shots["ah-workboard"].caption} />
        <ScreenshotCard src={shotUrl("ah-worklog")} caption={shots["ah-worklog"].caption} />
      </ScreenshotGallery>

      <h2 id="board">보드 ↔ 로그 두 화면</h2>
      <ul>
        <li><strong>Workboard</strong> — 현재 진행 상태. ‘할 일 / 진행 중 / 완료’ 같은 컬럼.</li>
        <li><strong>Worklog</strong> — 같은 카드의 처리 이력. 변경 불가능한 사슬로 append-only 보존.</li>
        <li>두 화면은 같은 카드를 다른 각도로 보여줍니다 — 데이터는 하나, 시점이 둘.</li>
      </ul>

      <h2 id="lifecycle">카드의 한 사이클</h2>
      <ol>
        <li><strong>생성</strong> — 에이전트가 만들거나 사용자가 직접 등록. 담당자가 자동으로 채워질 수 있습니다.</li>
        <li><strong>전달</strong> — 다른 팀원이 ‘집어오기’ 누르면 담당이 옮겨지고 worklog 에 이력 추가.</li>
        <li><strong>완료 / 재오픈</strong> — 완료 후에도 worklog 는 사라지지 않고 그대로 보존.</li>
        <li><strong>알림</strong> — 마감 임박이면 알림이 자동 발사되어 담당자에게 전달.</li>
      </ol>

      <Callout tone="security" title="처리 이력은 안전한 사슬로">
        Worklog 는 누가 / 언제 / 어떤 동작을 했는지 변경 불가능한 사슬로 보존됩니다.
        ‘기록을 삭제한 것 같은 흔적’ 도 그대로 남아 감사가 가능합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
