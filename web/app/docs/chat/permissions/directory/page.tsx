import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "권한 — 디렉토리" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="디렉토리 / 파일 권한"
        description="LVIS가 사용자 PC의 파일에 손을 댈 때는 항상 사용자가 명시적으로 허용한 폴더 안에서만 동작합니다. 권한은 폴더 단위로 부여되며, 범위 / 유효기간을 사용자가 직접 정합니다."
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-permission-directory")} caption={shots["chat-permission-directory"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="plugin-sandbox">플러그인은 자기 영역만 자유롭게</h2>
      <p>
        각 플러그인은 호스트가 따로 만들어 준 자기 영역만 자유롭게 읽고 쓸 수 있습니다. 다른 플러그인의 영역에는 절대 접근할 수 없고,
        사용자의 홈 디렉토리 같은 외부 폴더에는 사용자 허용을 받은 다음에만 들어갈 수 있습니다.
      </p>

      <h2 id="host-grant">호스트가 외부 폴더에 접근해야 할 때</h2>
      <StepList
        steps={[
          { title: "요청 트리거", body: <p>호스트의 내장 도구 또는 외부 도구가 사용자 홈 폴더 같은 외부 영역에 파일을 쓰려고 시도 → 권한 카드 발사.</p> },
          { title: "권한 카드", body: <p>읽기만 / 읽기+쓰기 중 선택 + 적용 범위 (이 폴더만 / 하위 포함) + 유효 기간 (1시간 / 24시간 / 영구).</p> },
          { title: "권한 보존", body: <p>부여된 권한은 사용자 PC 안의 LVIS 영역에 기록됩니다. 누가 / 언제 / 어떤 범위로 부여했는지 함께 보존.</p>, badge: "감사 추적" },
          { title: "사용", body: <p>이후 같은 도구 호출은 권한 안에서 자동 실행됩니다. 범위 밖 접근 시 즉시 거절되고 우회 경로 없이 사용자에게 재허용을 요청합니다.</p> },
        ]}
      />

      <Callout tone="security" title="두 단계 안전선">
        플러그인 도구는 (1) 자기 영역 sandbox + (2) 권한 검토 두 단계를 모두 통과해야 동작합니다.
        호스트 내장 도구나 외부 MCP 도구는 (2) 단계만 거치므로 권한 검토가 더 보수적입니다.
      </Callout>

      <PageNav />
    </article>
  );
}
