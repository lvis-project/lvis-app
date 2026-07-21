"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";
import type { Locale } from "@/lib/i18n";

interface Moment {
  time: string;
  railTitle: string;
  plugins: string;
  title: string;
  body: React.ReactNode;
  mock: React.ReactNode;
}

/* ── Compact mock cards (static, aria-hidden) ─────────────────── */

function MockShell({ kicker, meta, children }: { kicker: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-xl border border-border bg-white p-4 shadow-sm" aria-hidden>
      <div className="flex items-center justify-between">
        <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">{kicker}</p>
        {meta ? <span className="text-[11px] font-medium text-muted-foreground">{meta}</span> : null}
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function PillButton({ primary, children }: { primary?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11.5px] font-medium",
        primary ? "bg-ink text-white" : "border border-border bg-white text-ink"
      )}
    >
      {children}
    </span>
  );
}

function getMoments(locale: Locale): Moment[] {
  if (locale === "en") {
    return [
      {
        time: "08:00",
        railTitle: "Today's briefing",
        plugins: "work-assistant · ms-graph",
        title: "Before your day begins, today's briefing is ready.",
        body: (
          <>
            LVIS combines yesterday's mail, today's schedule, and still-open tasks into a{" "}
            <em className="not-italic font-semibold text-ink">morning briefing</em>. See what to
            prepare before meetings and which emails need a reply, at a glance.
          </>
        ),
        mock: (
          <MockShell kicker="Today's briefing · 08:00" meta="Tuesday">
            <p className="text-[13.5px] font-semibold text-ink">3 meetings and 3 emails need your reply.</p>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
              <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">10:00</b> Exec report · B201</li>
              <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">14:00</b> Product review · Video call</li>
              <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">17:00</b> 1:1 · Jisoo Kim</li>
            </ul>
            <div className="mt-3 flex gap-4 border-t border-border pt-2.5 text-[11.5px] text-muted-foreground">
              <span><b className="text-ink">3</b> need replies</span>
              <span><b className="text-ink">2</b> decisions</span>
              <span><b className="text-ink">5</b> tasks in progress</span>
            </div>
          </MockShell>
        ),
      },
      {
        time: "09:14",
        railTitle: "New email → meeting detected",
        plugins: "ms-graph · work-assistant",
        title: "Before an email becomes a meeting.",
        body: (
          <>
            LVIS reads a new email's headers and body to identify a{" "}
            <em className="not-italic font-semibold text-ink">meeting request</em>. It checks
            open time slots and rooms too, so you can reply, book, and add it to your calendar in
            one click.
          </>
        ),
        mock: (
          <MockShell kicker="Suggestion · work-assistant" meta="Just now">
            <p className="text-[13.5px] font-semibold text-ink">Meeting request detected. How about Tuesday at 14:00?</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-ink px-2.5 py-1 text-[11px] font-medium text-white">B201 · seats 6 · open</span>
              <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft">B302 · seats 8 · open at 14:30</span>
              <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft">A105 · seats 4 · open</span>
            </div>
            <div className="mt-3 flex gap-2">
              <PillButton primary>Book + draft reply</PillButton>
              <PillButton>Dismiss</PillButton>
            </div>
          </MockShell>
        ),
      },
      {
        time: "10:55",
        railTitle: "Meeting approaching → prep card",
        plugins: "meeting · work-assistant",
        title: "Right before a meeting, a prep card opens first.",
        body: (
          <>
            15 minutes before a scheduled meeting, a{" "}
            <em className="not-italic font-semibold text-ink">prep card</em> automatically surfaces
            the schedule, agenda, video link, and a summary of the last meeting. It never exposes
            the body text, and the OS notification stays a short one-liner.
          </>
        ),
        mock: (
          <MockShell kicker="Meeting · prep" meta="in 15 min">
            <p className="text-[13.5px] font-semibold text-ink">2026 Q3 Product Review</p>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
              <li><b className="font-semibold text-ink-soft">11:10 – 11:55</b> · B201 · seats 6</li>
              <li>Teams video link · auto-join ready</li>
              <li>3 past meeting summaries · 2 open actions</li>
            </ul>
            <div className="mt-3 flex gap-2">
              <PillButton primary>Record when meeting starts</PillButton>
              <PillButton>View agenda</PillButton>
            </div>
          </MockShell>
        ),
      },
      {
        time: "11:47",
        railTitle: "Meeting ends → summary and actions",
        plugins: "meeting · agent-hub",
        title: "When a meeting ends, the summary is ready first.",
        body: (
          <>
            LVIS detects the meeting's end, transcribes it, and automatically organizes a summary
            and action items. It estimates owners and deadlines and moves them straight to Agent
            Hub's kanban board.
          </>
        ),
        mock: (
          <MockShell kicker="Meeting · auto summary" meta="48 min">
            <p className="text-[13.5px] font-semibold text-ink">2026 Q3 Product Review</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Agreed to finalize the release scope and sort out the SDK migration schedule and QA
              resource allocation by next week.
            </p>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
              <li>✓ SDK migration guide draft · <em className="not-italic text-ink-soft">Jisoo Kim</em> · 5/27</li>
              <li>✓ QA schedule & staffing · <em className="not-italic text-ink-soft">Seoyeon Park</em> · 5/26</li>
              <li>✓ Release notes draft · <em className="not-italic text-ink-soft">Minho Lee</em> · 5/28</li>
            </ul>
            <div className="mt-3 flex items-center gap-3">
              <PillButton primary>Send to kanban board</PillButton>
              <span className="text-[11.5px] text-muted-foreground">3 actions · owners auto-estimated</span>
            </div>
          </MockShell>
        ),
      },
      {
        time: "14:32",
        railTitle: "Daily signals → kanban board",
        plugins: "work-assistant · agent-hub",
        title: "One more check with you before it runs.",
        body: (
          <>
            LVIS combines the afternoon's signals into kanban cards for tomorrow's to-dos. Writing
            to the board also has to pass an{" "}
            <em className="not-italic font-semibold text-ink">approval dialog</em>. The
            higher the risk, the clearer it's shown.
          </>
        ),
        mock: (
          <MockShell kicker="Approval request" meta="agent_hub_add_cards">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-bold text-amber-700">Medium risk</span>
            </div>
            <p className="mt-2 text-[13.5px] font-semibold text-ink">Add 3 to-do cards to my kanban board?</p>
            <dl className="mt-2.5 grid gap-1 font-mono text-[11.5px] text-muted-foreground">
              <div className="flex gap-2"><dt className="text-ink-soft">board</dt><dd>personal · my work</dd></div>
              <div className="flex gap-2"><dt className="text-ink-soft">column</dt><dd>To do</dd></div>
              <div className="flex gap-2"><dt className="text-ink-soft">cards</dt><dd>SDK guide · QA staffing · release notes</dd></div>
            </dl>
            <div className="mt-3 flex gap-2">
              <PillButton><kbd className="font-mono text-[10px]">D</kbd> Deny</PillButton>
              <PillButton primary><kbd className="font-mono text-[10px]">A</kbd> Approve & run</PillButton>
            </div>
          </MockShell>
        ),
      },
      {
        time: "15:30",
        railTitle: "Weekly report draft suggestion",
        plugins: "work-assistant · meeting",
        title: "Want help putting together your weekly report?",
        body: (
          <>
            LVIS gathers this week's meeting summaries, completed actions, and next week's
            schedule into a{" "}
            <em className="not-italic font-semibold text-ink">weekly report draft</em>. The draft
            follows your team template's tone and length, and whether to send it is always your
            call.
          </>
        ),
        mock: (
          <MockShell kicker="Weekly report draft · 15:30" meta="auto-generated">
            <p className="text-[13.5px] font-semibold text-ink">Want help drafting this week's report?</p>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
              <li className="flex justify-between"><b className="font-semibold text-ink-soft">Meeting summaries</b><span>4 · 9 actions</span></li>
              <li className="flex justify-between"><b className="font-semibold text-ink-soft">Completed work</b><span>7 items</span></li>
              <li className="flex justify-between"><b className="font-semibold text-ink-soft">Next week's schedule</b><span>5 items</span></li>
            </ul>
            <div className="mt-3 flex gap-2">
              <PillButton primary>Get the draft</PillButton>
              <PillButton>Later</PillButton>
            </div>
          </MockShell>
        ),
      },
      {
        time: "17:00",
        railTitle: "End-of-day check",
        plugins: "work-assistant",
        title: "Ready to wrap up the day?",
        body: (
          <>
            LVIS walks you through checking tomorrow's schedule, tidying up unfinished tasks, and
            writing follow-up notes in one flow. Once the wrap-up check is done, LVIS goes quiet
            too.
          </>
        ),
        mock: (
          <MockShell kicker="End of day · 17:00">
            <p className="text-[13.5px] font-semibold text-ink">Start your end-of-day wrap-up?</p>
            <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
              <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />Clear up unfinished tasks (3)</li>
              <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />Check tomorrow's schedule (5)</li>
              <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />Write today's follow-up notes</li>
            </ul>
            <div className="mt-3 flex items-center gap-3">
              <PillButton primary>Start wrap-up</PillButton>
              <span className="text-[11.5px] text-muted-foreground">~3 min</span>
            </div>
          </MockShell>
        ),
      },
      {
        time: "20:00",
        railTitle: "Autonomous indexing",
        plugins: "local-indexer · work-assistant",
        title: "While you're away, LVIS keeps working.",
        body: (
          <>
            When idle time is detected, LVIS quietly handles new document indexing, meeting summary
            enrichment, and email sorting. It yields the moment you return — closer to{" "}
            <em className="not-italic font-semibold text-ink">background cleanup</em> than active
            work.
          </>
        ),
        mock: (
          <MockShell kicker="Autonomous mode · 20:00" meta="idle work">
            <p className="text-[13.5px] font-semibold text-ink">In progress while you're away</p>
            <div className="mt-2.5 grid gap-2.5">
              {[
                { label: "Indexing new documents", meta: "42 / 68", p: 62 },
                { label: "Enriching meeting summaries", meta: "3 / 3", p: 100 },
                { label: "Sorting mail (read · priority)", meta: "18 / 24", p: 75 },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between text-[12px] text-muted-foreground">
                    <span>{row.label}</span>
                    <span className="font-mono">{row.meta}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                    <span className="block h-full rounded-full bg-ink/60" style={{ width: `${row.p}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] text-muted-foreground">Runs only when the CPU is idle · yields instantly when you're back</p>
          </MockShell>
        ),
      },
    ];
  }

  return [
    {
      time: "08:00",
      railTitle: "오늘 브리핑",
      plugins: "work-assistant · ms-graph",
      title: "하루를 시작하기 전에, 오늘의 브리핑이 준비됩니다.",
      body: (
        <>
          어제 받은 메일·오늘 일정·아직 닫히지 않은 작업을 종합해 <em className="not-italic font-semibold text-ink">아침 브리핑</em>으로
          요약합니다. 회의 전 준비할 항목과 응답이 필요한 메일을 한눈에 보여줍니다.
        </>
      ),
      mock: (
        <MockShell kicker="오늘의 브리핑 · 08:00" meta="화요일">
          <p className="text-[13.5px] font-semibold text-ink">회의 3건, 응답이 필요한 메일 3건이 기다리고 있어요.</p>
          <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
            <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">10:00</b> 임원 보고 · B201</li>
            <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">14:00</b> 제품 리뷰 · 화상</li>
            <li className="flex gap-2"><b className="font-mono font-semibold text-ink-soft">17:00</b> 1:1 · 김지수</li>
          </ul>
          <div className="mt-3 flex gap-4 border-t border-border pt-2.5 text-[11.5px] text-muted-foreground">
            <span><b className="text-ink">3</b> 응답 필요</span>
            <span><b className="text-ink">2</b> 결정 사항</span>
            <span><b className="text-ink">5</b> 작업 진행 중</span>
          </div>
        </MockShell>
      ),
    },
    {
      time: "09:14",
      railTitle: "새 메일 → 회의 감지",
      plugins: "ms-graph · work-assistant",
      title: "메일 한 통이 회의가 되기 전에.",
      body: (
        <>
          LVIS는 새 메일의 헤더와 본문을 읽고 <em className="not-italic font-semibold text-ink">회의 요청</em>을 판별합니다.
          빈 시간과 회의실까지 확인해, 사용자가 클릭 한 번에 응답·예약·일정 등록을 이어가도록 준비합니다.
        </>
      ),
      mock: (
        <MockShell kicker="제안 · work-assistant" meta="방금">
          <p className="text-[13.5px] font-semibold text-ink">회의 요청을 감지했습니다. 화요일 14:00 어떠세요?</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-ink px-2.5 py-1 text-[11px] font-medium text-white">B201 · 6인실 · 비어 있음</span>
            <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft">B302 · 8인실 · 14:30 가능</span>
            <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-ink-soft">A105 · 4인실 · 비어 있음</span>
          </div>
          <div className="mt-3 flex gap-2">
            <PillButton primary>예약 + 답장 초안</PillButton>
            <PillButton>닫기</PillButton>
          </div>
        </MockShell>
      ),
    },
    {
      time: "10:55",
      railTitle: "회의 임박 → 준비 카드",
      plugins: "meeting · work-assistant",
      title: "회의 직전, 준비 카드가 먼저 열립니다.",
      body: (
        <>
          예정된 회의 15분 전, 일정·안건·화상 링크·지난 회의 요약을 <em className="not-italic font-semibold text-ink">준비 카드</em>로
          자동으로 띄웁니다. 본문은 노출하지 않고, OS 알림은 짧은 한국어 한 줄로만 알립니다.
        </>
      ),
      mock: (
        <MockShell kicker="Meeting · prep" meta="15분 후">
          <p className="text-[13.5px] font-semibold text-ink">2026 Q3 제품 리뷰</p>
          <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
            <li><b className="font-semibold text-ink-soft">11:10 – 11:55</b> · B201 · 6인실</li>
            <li>Teams 화상 링크 · 자동 참여 준비</li>
            <li>지난 회의 요약 3건 · 남은 액션 2건</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <PillButton primary>회의 시작과 함께 녹음</PillButton>
            <PillButton>안건 보기</PillButton>
          </div>
        </MockShell>
      ),
    },
    {
      time: "11:47",
      railTitle: "회의 종료 → 요약과 액션",
      plugins: "meeting · agent-hub",
      title: "회의가 끝나면, 요약이 먼저 준비됩니다.",
      body: (
        <>
          회의 종료를 감지해 내용을 텍스트로 옮기고, 요약과 액션 아이템을 자동으로 정리합니다.
          담당자와 마감을 추정해 Agent Hub의 칸반 보드에 그대로 옮깁니다.
        </>
      ),
      mock: (
        <MockShell kicker="Meeting · 자동 요약" meta="48분">
          <p className="text-[13.5px] font-semibold text-ink">2026 Q3 제품 리뷰</p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
            릴리스 범위를 확정하고, SDK 마이그레이션 일정과 QA 리소스 배분을 다음 주까지 정리하기로 했습니다.
          </p>
          <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
            <li>✓ SDK 마이그레이션 가이드 초안 · <em className="not-italic text-ink-soft">김지수</em> · 5/27</li>
            <li>✓ QA 일정·인원 배분 · <em className="not-italic text-ink-soft">박서연</em> · 5/26</li>
            <li>✓ 릴리스 노트 초안 · <em className="not-italic text-ink-soft">이민호</em> · 5/28</li>
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <PillButton primary>칸반 보드로 보내기</PillButton>
            <span className="text-[11.5px] text-muted-foreground">액션 3건 · 담당자 자동 추정</span>
          </div>
        </MockShell>
      ),
    },
    {
      time: "14:32",
      railTitle: "일일 신호 → 칸반 보드",
      plugins: "work-assistant · agent-hub",
      title: "실행 전, 다시 한 번 당신에게.",
      body: (
        <>
          오후의 신호를 종합해 내일 할 일을 칸반 보드 카드로 정리합니다. 보드에 쓰는 작업도{" "}
          <em className="not-italic font-semibold text-ink">승인 다이얼로그</em>를 통과해야만 진행됩니다.
          위험도가 높은 호출일수록 더 명확하게 보여줍니다.
        </>
      ),
      mock: (
        <MockShell kicker="승인 요청" meta="agent_hub_add_cards">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-bold text-amber-700">위험도 보통</span>
          </div>
          <p className="mt-2 text-[13.5px] font-semibold text-ink">내 칸반 보드에 할 일 카드 3건을 추가할까요?</p>
          <dl className="mt-2.5 grid gap-1 font-mono text-[11.5px] text-muted-foreground">
            <div className="flex gap-2"><dt className="text-ink-soft">board</dt><dd>personal · 내 작업</dd></div>
            <div className="flex gap-2"><dt className="text-ink-soft">column</dt><dd>할 일</dd></div>
            <div className="flex gap-2"><dt className="text-ink-soft">cards</dt><dd>SDK 가이드 · QA 배분 · 릴리스 노트</dd></div>
          </dl>
          <div className="mt-3 flex gap-2">
            <PillButton><kbd className="font-mono text-[10px]">D</kbd> 거부</PillButton>
            <PillButton primary><kbd className="font-mono text-[10px]">A</kbd> 승인하고 실행</PillButton>
          </div>
        </MockShell>
      ),
    },
    {
      time: "15:30",
      railTitle: "주간보고 초안 제안",
      plugins: "work-assistant · meeting",
      title: "주간보고, 함께 정리해드릴까요?",
      body: (
        <>
          이번 주 회의 요약·완료된 액션·다음 주 일정을 모아 <em className="not-italic font-semibold text-ink">주간보고 초안</em>을
          만듭니다. 초안은 팀 템플릿의 톤과 길이를 따르고, 전송 여부는 항상 사용자가 직접 결정합니다.
        </>
      ),
      mock: (
        <MockShell kicker="주간보고 초안 · 15:30" meta="자동 생성">
          <p className="text-[13.5px] font-semibold text-ink">이번 주 보고서를 함께 작성해드릴까요?</p>
          <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
            <li className="flex justify-between"><b className="font-semibold text-ink-soft">회의 요약</b><span>4건 · 액션 9건</span></li>
            <li className="flex justify-between"><b className="font-semibold text-ink-soft">완료한 작업</b><span>7건</span></li>
            <li className="flex justify-between"><b className="font-semibold text-ink-soft">다음 주 일정</b><span>5건</span></li>
          </ul>
          <div className="mt-3 flex gap-2">
            <PillButton primary>초안 받아보기</PillButton>
            <PillButton>나중에</PillButton>
          </div>
        </MockShell>
      ),
    },
    {
      time: "17:00",
      railTitle: "하루 마무리 체크",
      plugins: "work-assistant",
      title: "오늘을 마무리할까요?",
      body: (
        <>
          내일 일정 확인, 미완료 작업 정리, 후속 메모를 한 흐름으로 안내합니다.
          마무리 체크가 끝나면 LVIS도 조용해집니다.
        </>
      ),
      mock: (
        <MockShell kicker="하루 마무리 · 17:00">
          <p className="text-[13.5px] font-semibold text-ink">업무 마무리 작업을 시작할까요?</p>
          <ul className="mt-2.5 grid gap-1.5 text-[12.5px] text-muted-foreground">
            <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />오늘 미완료 작업 정리 (3건)</li>
            <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />내일 일정 확인 (5건)</li>
            <li className="flex items-center gap-2"><span className="h-3.5 w-3.5 rounded border border-border bg-white" />오늘의 후속 메모 작성</li>
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <PillButton primary>마무리 시작</PillButton>
            <span className="text-[11.5px] text-muted-foreground">예상 3분</span>
          </div>
        </MockShell>
      ),
    },
    {
      time: "20:00",
      railTitle: "자율 인덱싱",
      plugins: "local-indexer · work-assistant",
      title: "당신이 자리를 비울 때, LVIS는 계속 일합니다.",
      body: (
        <>
          유휴 시간이 감지되면 새 문서 인덱싱·회의 요약 보강·메일 분류를 조용히 처리합니다.
          사용자가 돌아오면 즉시 양보합니다. <em className="not-italic font-semibold text-ink">백그라운드 정리</em>에 가까운 방식입니다.
        </>
      ),
      mock: (
        <MockShell kicker="자율 모드 · 20:00" meta="유휴 작업">
          <p className="text-[13.5px] font-semibold text-ink">자리를 비운 사이 진행 중</p>
          <div className="mt-2.5 grid gap-2.5">
            {[
              { label: "새 문서 인덱싱", meta: "42 / 68", p: 62 },
              { label: "회의 요약 보강", meta: "3 / 3", p: 100 },
              { label: "메일 분류 (읽음·우선순위)", meta: "18 / 24", p: 75 },
            ].map((row) => (
              <div key={row.label}>
                <div className="flex justify-between text-[12px] text-muted-foreground">
                  <span>{row.label}</span>
                  <span className="font-mono">{row.meta}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-ink/60" style={{ width: `${row.p}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] text-muted-foreground">CPU 유휴 시에만 동작 · 사용자 복귀 시 즉시 양보</p>
        </MockShell>
      ),
    },
  ];
}

/* ── Section head (shared by both renderings) ─────────────────── */
const headCopy = {
  ko: {
    heading: "하루의 흐름을 함께 따라갑니다.",
    lead: "신호가 들어올 때마다 조용히 살피고, 정확한 순간에만 모습을 드러냅니다.",
    timelineLabel: "하루 타임라인",
  },
  en: {
    heading: "Follow the flow of a day, together.",
    lead: "It quietly watches every signal as it comes in, and only shows itself at the right moment.",
    timelineLabel: "Day timeline",
  },
} as const;

function SectionHead({ locale }: { locale: Locale }) {
  const t = headCopy[locale];
  return (
    <>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">A Day with LVIS</p>
      <h2 className="mt-2 text-[clamp(1.75rem,3.5vw,2.5rem)] font-semibold tracking-[-0.02em] text-ink">
        {t.heading}
      </h2>
      <p className="mt-4 text-[15.5px] leading-relaxed text-muted-foreground">
        {t.lead}
      </p>
    </>
  );
}

/**
 * Pinned-stage scrollytelling (desktop, motion-ok): the viewport locks while
 * scroll advances through the eight moments — rail on the left, a single
 * crossfading stage on the right. Falls back to a stacked list on mobile,
 * reduced-motion, and no-JS (stacked is the SSR default, so content is never
 * trapped inside a scroll runway without JS).
 */
export function Workday({ locale = "ko" }: { locale?: Locale }) {
  const moments = getMoments(locale);
  const [pinned, setPinned] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPinned(mqLg.matches && !mqReduce.matches);
    update();
    mqLg.addEventListener("change", update);
    mqReduce.addEventListener("change", update);
    return () => {
      mqLg.removeEventListener("change", update);
      mqReduce.removeEventListener("change", update);
    };
  }, []);

  React.useEffect(() => {
    if (!pinned) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = wrapRef.current;
        if (!el) return;
        const total = el.offsetHeight - window.innerHeight;
        if (total <= 0) return;
        const y = Math.min(Math.max(-el.getBoundingClientRect().top, 0), total);
        setActive(Math.min(moments.length - 1, Math.floor((y / total) * moments.length)));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pinned, moments.length]);

  const jump = (i: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const total = el.offsetHeight - window.innerHeight;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + ((i + 0.5) / moments.length) * total, behavior: "smooth" });
  };

  if (!pinned) {
    // Stacked fallback — mobile / reduced motion / SSR & no-JS default.
    return (
      <section id="workday" className="scroll-mt-20 border-y border-border/60">
        <div className="mx-auto max-w-[760px] px-6 py-24">
          <Reveal>
            <SectionHead locale={locale} />
          </Reveal>
          <div className="mt-10 grid gap-6">
            {moments.map((m) => (
              <Reveal key={m.time}>
                <article className="rounded-2xl border border-border bg-white p-6" aria-label={`${m.time} ${m.railTitle}`}>
                  <div className="flex items-baseline gap-3">
                    <p className="font-mono text-[13px] font-bold text-ink">{m.time}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{m.plugins}</p>
                  </div>
                  <h3 className="mt-2 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-ink">{m.title}</h3>
                  <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">{m.body}</p>
                  {m.mock}
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section id="workday" className="scroll-mt-20 border-y border-border/60">
      <div ref={wrapRef} style={{ height: `${moments.length * 85}vh` }}>
        <div className="sticky top-[3.75rem] flex h-[calc(100dvh-3.75rem)] items-center overflow-hidden">
          <div className="mx-auto grid w-full max-w-[1120px] items-center gap-16 px-6 lg:grid-cols-[380px_1fr]">
            {/* Left — head + rail */}
            <div>
              <SectionHead locale={locale} />
              <ol className="mt-8 grid gap-0.5" aria-label={headCopy[locale].timelineLabel}>
                {moments.map((m, i) => (
                  <li key={m.time}>
                    <button
                      type="button"
                      onClick={() => jump(i)}
                      aria-current={active === i ? "step" : undefined}
                      className={cn(
                        "flex w-full items-baseline gap-3 rounded-lg border-l-2 px-3 py-[7px] text-left transition-colors",
                        active === i ? "border-ink bg-secondary/70" : "border-border hover:bg-secondary/40"
                      )}
                    >
                      <span className={cn("font-mono text-[12px] font-semibold", active === i ? "text-ink" : "text-muted-foreground")}>
                        {m.time}
                      </span>
                      <span className={cn("truncate text-[13.5px]", active === i ? "font-semibold text-ink" : "text-ink-soft")}>
                        {m.railTitle}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
              <p className="mt-5 pl-3 font-mono text-[12px] text-muted-foreground">
                {String(active + 1).padStart(2, "0")} / {String(moments.length).padStart(2, "0")}
              </p>
            </div>

            {/* Right — crossfading stage */}
            <div className="relative min-h-[480px]">
              {moments.map((m, i) => (
                <article
                  key={m.time}
                  aria-hidden={active !== i}
                  className={cn(
                    "absolute inset-0 flex flex-col justify-center transition-all duration-500 ease-out",
                    active === i ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"
                  )}
                >
                  <div className="flex items-baseline gap-3">
                    <p className="font-mono text-[13px] font-bold text-ink">{m.time}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{m.plugins}</p>
                  </div>
                  <h3 className="mt-2 max-w-xl text-[21px] font-semibold leading-snug tracking-[-0.01em] text-ink">{m.title}</h3>
                  <p className="mt-2.5 max-w-xl text-[14px] leading-relaxed text-muted-foreground">{m.body}</p>
                  <div className="max-w-xl">{m.mock}</div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
