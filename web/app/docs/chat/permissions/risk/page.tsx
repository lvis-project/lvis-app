import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "권한 — 위험 관리" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Permissions"
        title="위험 관리 — 위험도 × 도구 종류"
        description="LVIS의 권한 모델은 두 축이 만나는 격자입니다. 도구의 위험도(낮음/중간/높음) 와 도구 종류(읽기/쓰기/실행/네트워크) 가 만나서 자동 실행할지 / 인라인 확인을 띄울지 / 다이얼로그를 띄울지 정해집니다."
        tags={["3단계 위험도", "5종 도구 카테고리", "추가 동의 chain"]}
      />

      <ScreenshotGallery columns={1}>
        <ScreenshotCard src={shotUrl("chat-permission-risk")} caption={shots["chat-permission-risk"].caption} aspect="wide" />
      </ScreenshotGallery>

      <h2 id="grid">결정 격자</h2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className="border border-border p-2.5">위험도 \ 종류</th>
              <th className="border border-border p-2.5">읽기</th>
              <th className="border border-border p-2.5">쓰기</th>
              <th className="border border-border p-2.5">실행</th>
              <th className="border border-border p-2.5">네트워크</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="border border-border p-2.5 font-semibold text-teal-dark">낮음</td><td className="border border-border p-2.5">자동</td><td className="border border-border p-2.5">자동</td><td className="border border-border p-2.5">카드 확인</td><td className="border border-border p-2.5">자동</td></tr>
            <tr><td className="border border-border p-2.5 font-semibold text-coral">중간</td><td className="border border-border p-2.5">자동</td><td className="border border-border p-2.5">카드 확인</td><td className="border border-border p-2.5">다이얼로그</td><td className="border border-border p-2.5">카드 확인</td></tr>
            <tr><td className="border border-border p-2.5 font-semibold text-coral">높음</td><td className="border border-border p-2.5">카드 확인</td><td className="border border-border p-2.5">다이얼로그</td><td className="border border-border p-2.5">다이얼로그 + 추가 동의</td><td className="border border-border p-2.5">다이얼로그</td></tr>
          </tbody>
        </table>
      </div>
      <p className="text-[12.5px] text-muted-foreground">엄격 모드에서는 중간/높음 모두 다이얼로그로 격상됩니다.</p>

      <Callout tone="security" title="추가 동의 chain">
        높은 위험도의 작업은 사용자 동의가 변경 불가능한 기록 사슬로 보존됩니다. 누가 / 언제 / 어떤 범위로 동의했는지 나중에 그대로 다시 확인할 수 있어, 자동화가 ‘몰래’ 일어나는 것을 방지합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
