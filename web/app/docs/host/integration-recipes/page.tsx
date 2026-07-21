import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { ScreenshotCard, ScreenshotGallery } from "@/components/docs/screenshot-card";
import { PageNav } from "@/components/docs/page-nav";
import { shotUrl, shots } from "@/lib/screenshots";

export const metadata = { title: "Integration Recipes — 플러그인 결합 시나리오" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Host · Integration Recipes"
        title="플러그인 결합 시나리오 모음"
        description="단일 플러그인 사용법보다 더 중요한 건 ‘여러 플러그인이 함께 일하는 사슬’ 입니다. 본 페이지는 자주 쓰이는 결합 시나리오 네 가지를 짧은 흐름으로 정리했습니다. 모든 사슬은 사용자 동의 카드를 거치며, 자동 실행되는 단계는 명시적으로 표시합니다."
        tags={["Meeting + Work Assistant + MS-Graph", "Local Indexer + Meeting + Agent Hub", "MS-Graph + LGE EP", "Agent Hub + Meeting + EP"]}
      />

      <h2 id="recipe-1">레시피 1 — 회의 → 액션 → 일정 → 답장</h2>
      <p>가장 자주 일어나는 사슬. 회의에서 결정된 사항이 일정과 답장으로 자연스럽게 이어집니다.</p>
      <StepList
        steps={[
          { title: "회의 종료", body: <p><strong>Meeting</strong> 플러그인이 녹음 종료 → 자동 회의록 + 액션 아이템 후보 추출.</p>, badge: "Meeting" },
          { title: "후속 카드 노출", body: <p><strong>Work Assistant</strong> 가 액션 아이템 후보를 사용자 확인 카드로 띄움. ‘TODO 로 추가 / 메일 답장 / 일정 등록’ 중 선택.</p>, badge: "Work Assistant" },
          { title: "일정 등록 + 답장 초안", body: <p>사용자가 ‘일정 + 답장’ 선택 → <strong>Microsoft 365</strong> 의 캘린더에 일정 등록, 메일 답장 초안 채팅에 표시. ‘발송’ 누르는 순간에만 실제 전송.</p>, badge: "MS-Graph" },
          { title: "기록 보존", body: <p>모든 단계가 감사 기록에 남고, 추출된 액션 아이템은 업무 보드 카드로도 동기화됩니다.</p> },
        ]}
      />

      <ScreenshotGallery columns={2}>
        <ScreenshotCard src={shotUrl("meeting-outlook-mail")} caption={shots["meeting-outlook-mail"].caption} />
        <ScreenshotCard src={shotUrl("meeting-outlook-mail-2")} caption={shots["meeting-outlook-mail-2"].caption} />
      </ScreenshotGallery>

      <h2 id="recipe-2">레시피 2 — “자료 어디 있더라” 에서 발표 자료까지</h2>
      <p>로컬 인덱서가 핵심 — 검색 → 경로 확인 → 내용 정리 → 발표용 1장 변환 까지 한 흐름.</p>
      <StepList
        steps={[
          { title: "자연어 검색", body: <p>채팅에 ‘OOO 관련 자료 어디 있었지?’ → <strong>Local Indexer</strong> 가 후보 파일과 근거를 함께 답합니다.</p>, badge: "Local Indexer" },
          { title: "경로 확인", body: <p>‘정확한 파일경로’ 요청 → 절대 경로 (NAS 마운트 포함) 그대로 출력. OS 파일 매니저에서 바로 열기.</p> },
          { title: "내용 요약 + 재포맷", body: <p>같은 파일 기준 ‘발표용 1장으로 정리’ → 호스트 LLM 이 동일한 매칭 결과를 재사용해 발표용 포맷으로 다시 정리.</p>, badge: "재사용" },
          { title: "업무 보드 카드로 보내기", body: <p>요약 결과를 <strong>Agent Hub</strong> 업무 보드에 ‘발표 자료 준비’ 카드로 등록해 팀원과 공유.</p>, badge: "Agent Hub" },
        ]}
      />

      <h2 id="recipe-3">레시피 3 — 사내 회의실까지 자동으로</h2>
      <p>일반 회의 일정과 사내 포털을 잇는 사슬. 사내망 안에서만 동작합니다.</p>
      <StepList
        steps={[
          { title: "회의 요청 메일 도착", body: <p><strong>Microsoft 365</strong> 가 새 회의 요청을 감지. 본문에서 시간 후보 추출.</p>, badge: "MS-Graph" },
          { title: "빈 회의실 추천", body: <p><strong>Work Assistant</strong> 가 사용자의 캘린더 + 사내 시스템의 회의실 가용 시간을 함께 보고 후보 카드를 띄움.</p>, badge: "Work Assistant" },
          { title: "회의실 예약 + 화상회의 추가", body: <p>선택한 회의실은 <strong>LGE EP</strong> 의 회의실 예약 도구로 확정. 외부 참가자가 있으면 화상회의 링크가 자동 생성되어 일정 본문에 첨부.</p>, badge: "LGE EP" },
          { title: "답장 발송", body: <p>회의 요청자에게 ‘예약 완료 + 회의실 + 화상회의 링크’ 가 채팅 카드로 표시 → 사용자가 ‘답장’ 을 누르는 순간에만 실제 발송.</p>, badge: "확인 후 발송" },
        ]}
      />

      <h2 id="recipe-4">레시피 4 — 화상회의 → 자동 회의록 → 팀 보드</h2>
      <p>외부 참가자 회의의 일과 정리. 회의록 + 액션 아이템 + 팀 공유까지 한 번에.</p>
      <StepList
        steps={[
          { title: "화상회의 진입", body: <p>일정에 첨부된 링크로 화상회의 시작 — <strong>LGE EP</strong> 의 화상회의 흐름.</p>, badge: "LGE EP" },
          { title: "자동 회의록", body: <p>회의 중 <strong>Meeting</strong> 플러그인이 받아쓰기를 실시간으로 진행. 종료 시 회의록 + 요약 + 액션 아이템 자동 생성.</p>, badge: "Meeting" },
          { title: "팀 보드로 분배", body: <p><strong>Agent Hub</strong> 업무 보드에 액션 아이템 카드 자동 등록. 담당자 후보가 자동 채워지고, 마감 임박 카드는 알림으로 전달.</p>, badge: "Agent Hub" },
          { title: "회의록은 자기 영역에", body: <p>회의록 원본은 Meeting 플러그인 자기 영역 안에만 보관. 외부 서버로 자동 전송되지 않습니다.</p>, badge: "내 PC 안에만" },
        ]}
      />

      <Callout tone="info" title="레시피를 자기 것으로 만들기">
        각 레시피는 ‘자동화 규칙’ 으로 등록할 수 있습니다. 회의 종료 / 새 메일 도착 / 특정 시각 같은 트리거가 들어오면 호스트가 같은 흐름을 자동으로 발사하고, 사용자는 결과 카드만 확인합니다.
      </Callout>

      <Callout tone="security" title="모든 사슬은 동의 카드를 거칩니다">
        ‘자동화’ 라는 단어와 별개로, 위험한 단계 (메일 발송 · 외부 호출 · 결재 제출) 는 매번 동의 카드를 거칩니다.
        한 번 자동화에 등록했다고 해서 그 후 위험한 단계까지 묻지 않고 처리되지 않습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
