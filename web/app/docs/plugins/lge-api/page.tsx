import { PageHero } from "@/components/docs/page-hero";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "LGE EP 플러그인" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugin · LGE EP"
        title="LGE EP — 사내 포털을 LVIS 안으로"
        description="사내 포털 EP 의 한 번 로그인으로 근태 · 결재 · 주차 · 회의실 예약 · 화상회의 · 사내 검색 LGenie 까지 LVIS 채팅 안에서 처리합니다. 사내망에서만 동작합니다."
        tags={["사내 전용", "EP 통합 SSO"]}
      />

      <Tabs defaultValue="login" className="my-6">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="login">로그인</TabsTrigger>
          <TabsTrigger value="attendance">근태</TabsTrigger>
          <TabsTrigger value="approval">결재</TabsTrigger>
          <TabsTrigger value="parking">주차</TabsTrigger>
          <TabsTrigger value="facility">회의실</TabsTrigger>
          <TabsTrigger value="video">화상회의</TabsTrigger>
          <TabsTrigger value="lgenie">LGenie</TabsTrigger>
        </TabsList>

        <TabsContent value="login">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-login")} caption={shots["ep-login"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>EP 한 번 로그인이면 이후 모든 도메인이 같은 세션을 공유합니다. 비밀번호는 LVIS 가 저장하지 않습니다.</p>
        </TabsContent>

        <TabsContent value="attendance">
          <ScreenshotGallery columns={3}>
            <ScreenshotCard src={shotUrl("ep-attendance")} caption={shots["ep-attendance"].caption} />
            <ScreenshotCard src={shotUrl("ep-attendance-2")} caption={shots["ep-attendance-2"].caption} />
            <ScreenshotCard src={shotUrl("ep-attendance-3")} caption={shots["ep-attendance-3"].caption} />
          </ScreenshotGallery>
          <p>일 / 주 / 월간 근태를 채팅에서 바로 확인하고, 출퇴근 / 원격근무 / 휴가 신청을 한 화면에서 처리합니다.</p>
        </TabsContent>

        <TabsContent value="approval">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-approval")} caption={shots["ep-approval"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>결재 대기 / 진행 / 완료를 한 줄로 보여줍니다. “결재 대기 몇 건이야?” 같은 자연어 질문에도 즉시 답합니다.</p>
        </TabsContent>

        <TabsContent value="parking">
          <ScreenshotGallery columns={1}>
            <ScreenshotCard src={shotUrl("ep-parking")} caption={shots["ep-parking"].caption} aspect="wide" />
          </ScreenshotGallery>
          <p>차량 등록, 잔여 슬롯 확인, 방문자 주차 신청을 한 화면에서 처리합니다.</p>
        </TabsContent>

        <TabsContent value="facility">
          <ScreenshotGallery columns={3}>
            <ScreenshotCard src={shotUrl("ep-meeting-room")} caption={shots["ep-meeting-room"].caption} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-2")} caption={shots["ep-meeting-room-2"].caption} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-3")} caption={shots["ep-meeting-room-3"].caption} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-4")} caption={shots["ep-meeting-room-4"].caption} />
            <ScreenshotCard src={shotUrl("ep-meeting-room-5")} caption={shots["ep-meeting-room-5"].caption} />
          </ScreenshotGallery>
          <p>회의실 검색 → 가용 시간 확인 → 예약 확정까지 한 흐름. 업무도우미와 함께 쓰면 “3명 모두 가능한 시간에 본관 회의실” 같은 자연어 요청도 가능합니다.</p>
        </TabsContent>

        <TabsContent value="video">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("ep-video-call")} caption={shots["ep-video-call"].caption} />
            <ScreenshotCard src={shotUrl("ep-video-call-2")} caption={shots["ep-video-call-2"].caption} />
            <ScreenshotCard src={shotUrl("ep-video-call-3")} caption={shots["ep-video-call-3"].caption} />
            <ScreenshotCard src={shotUrl("ep-video-call-4")} caption={shots["ep-video-call-4"].caption} />
          </ScreenshotGallery>
          <p>참가자 · 옵션 · 종료까지 화상회의 흐름. 회의 플러그인의 STT 와 연결하면 자동으로 회의록과 요약이 생성됩니다.</p>
        </TabsContent>

        <TabsContent value="lgenie">
          <ScreenshotGallery columns={2}>
            <ScreenshotCard src={shotUrl("ep-lgenie")} caption={shots["ep-lgenie"].caption} />
            <ScreenshotCard src={shotUrl("ep-lgenie-2")} caption={shots["ep-lgenie-2"].caption} />
          </ScreenshotGallery>
          <p>사내 검색 LGenie 의 결과를 LVIS 채팅 컨텍스트로 가져옵니다. 사내 정책 · 규정 · 양식 같은 질문에 인용과 함께 답합니다.</p>
        </TabsContent>
      </Tabs>

      <Callout tone="security" title="사내망 전용">
        외부망에서는 로그인이 자동 차단됩니다. 세션은 플러그인 자기 영역 안에서만 보존되고, 다른 플러그인이 가져갈 수 없습니다.
      </Callout>

      <h2 id="scenario">실전 시나리오 — 출근 한 줄로 시작하는 아침</h2>
      <ul>
        <li>채팅에 “출근” 한 줄 → 근태 등록 + 오늘 일정 미리보기 카드.</li>
        <li>첫 회의 30분 전 → 빈 회의실 후보 카드, 한 번에 예약.</li>
        <li>외부 참가자가 섞인 회의 → 화상회의가 자동 생성되어 일정에 링크가 붙음.</li>
      </ul>

      <PageNav />
    </article>
  );
}
