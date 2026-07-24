import * as React from "react";

/** Shared SVG defs (markers) */
function Defs() {
  return (
    <defs>
      <marker
        id="arrow-slate"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#4b5573" />
      </marker>
      <marker
        id="arrow-gray"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#9aa0ab" />
      </marker>
      <marker
        id="arrow-ink"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M0,0 L10,5 L0,10 z" fill="#14161d" />
      </marker>
    </defs>
  );
}

const baseSvgClass = "block h-auto w-full select-none";

/* ────────────────────────────────────────────────────────────────
   1. STACK DIAGRAM — 4 layers (사용자 톤, 코드 경로 없음)
   ──────────────────────────────────────────────────────────────── */
export function StackDiagram({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const layersByLocale = {
    ko: [
      {
        y: 16,
        h: 120,
        fill: "#f6f7fb",
        stroke: "#4b5573",
        title: "데스크톱 앱",
        sub: "사용자가 마주하는 첫 화면. 채팅 · 큐 · TODO · 권한 검토.",
        nodes: ["채팅", "메시지 큐", "TODO 패널", "권한 검토", "도구 목록"],
        eyebrow: "Layer 1",
      },
      {
        y: 152,
        h: 120,
        fill: "#eef0f6",
        stroke: "#c3ccdf",
        title: "플러그인",
        sub: "도메인 기능을 가져오는 모듈. 호스트는 플러그인 코드를 직접 모른다.",
        nodes: ["Microsoft 365", "Local Indexer", "Meeting", "업무 보드", "사내 EP"],
        eyebrow: "Layer 2",
      },
      {
        y: 288,
        h: 120,
        fill: "#f3f4f6",
        stroke: "#14161d",
        title: "내 PC 안의 저장소",
        sub: "세션 · 자동화 · 감사 기록을 도메인별로 안전하게 격리.",
        nodes: ["세션", "자동화", "감사 기록", "각 플러그인 영역", "비밀값"],
        eyebrow: "Layer 3",
      },
      {
        y: 424,
        h: 120,
        fill: "#fafafa",
        stroke: "#9aa0ab",
        title: "서버 · 외부",
        sub: "Marketplace · 업무 보드 · 외부 도구 · 사내 시스템.",
        nodes: ["Marketplace", "업무 보드 서버", "외부 도구", "외부 API"],
        eyebrow: "Layer 4",
      },
    ],
    en: [
      {
        y: 16,
        h: 120,
        fill: "#f6f7fb",
        stroke: "#4b5573",
        title: "Desktop app",
        sub: "The first screen users see. Chat, queue, TODO, permission review.",
        nodes: ["Chat", "Message queue", "TODO panel", "Permission review", "Tool list"],
        eyebrow: "Layer 1",
      },
      {
        y: 152,
        h: 120,
        fill: "#eef0f6",
        stroke: "#c3ccdf",
        title: "Plugins",
        sub: "Modules that bring in domain features. The host has no direct knowledge of plugin code.",
        nodes: ["Microsoft 365", "Local Indexer", "Meeting", "Work board", "Internal EP"],
        eyebrow: "Layer 2",
      },
      {
        y: 288,
        h: 120,
        fill: "#f3f4f6",
        stroke: "#14161d",
        title: "Storage on my PC",
        sub: "Safely isolates sessions, automations, and audit records by domain.",
        nodes: ["Sessions", "Automations", "Audit records", "Per-plugin area", "Secrets"],
        eyebrow: "Layer 3",
      },
      {
        y: 424,
        h: 120,
        fill: "#fafafa",
        stroke: "#9aa0ab",
        title: "Server · external",
        sub: "Marketplace, work board, external tools, internal systems.",
        nodes: ["Marketplace", "Work board server", "External tools", "External APIs"],
        eyebrow: "Layer 4",
      },
    ],
  };
  const layers = layersByLocale[locale];

  return (
    <svg viewBox="0 0 960 570" className={baseSvgClass} role="img" aria-label="LVIS 4 layer stack">
      <Defs />
      {layers.map((l) => (
        <g key={l.title}>
          <rect x={20} y={l.y} width={920} height={l.h} rx={10} fill={l.fill} stroke={l.stroke} strokeOpacity={0.55} />
          <text x={40} y={l.y + 22} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11} fontWeight={700} letterSpacing={1.8} fill="#3a3d47">
            {l.eyebrow.toUpperCase()}
          </text>
          <text x={40} y={l.y + 44} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={18} fontWeight={700} fill="#14161d">
            {l.title}
          </text>
          <text x={40} y={l.y + 62} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fill="#676b76">
            {l.sub}
          </text>
          {l.nodes.map((n, i) => {
            const cols = 5;
            const gap = 8;
            const totalGap = (cols - 1) * gap;
            const cellW = (920 - 40 - totalGap) / cols;
            const x = 40 + i * (cellW + gap);
            const y = l.y + 82;
            return (
              <g key={n}>
                <rect x={x} y={y} width={cellW} height={28} rx={6} fill="#ffffff" stroke="#e6e7ec" />
                <text
                  x={x + cellW / 2}
                  y={y + 18}
                  textAnchor="middle"
                  fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif"
                  fontSize={12.5}
                  fill="#14161d"
                >
                  {n}
                </text>
              </g>
            );
          })}
        </g>
      ))}

      {/* connector arrows */}
      <path d="M480 136 V 152" stroke="#4b5573" strokeWidth={1.8} markerEnd="url(#arrow-slate)" />
      <path d="M480 272 V 288" stroke="#14161d" strokeWidth={1.8} markerEnd="url(#arrow-ink)" />
      <path d="M480 408 V 424" stroke="#9aa0ab" strokeWidth={1.8} markerEnd="url(#arrow-gray)" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   2. DATA FLOW — single message turn
   ──────────────────────────────────────────────────────────────── */
export function DataFlowDiagram({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const stepsByLocale = {
    ko: [
      { x: 20, label: "사용자 입력", sub: "채팅 본문" },
      { x: 175, label: "호스트 입력 분류", sub: "slash command만" },
      { x: 340, label: "도구 발견", sub: "선택 scope + tool_search" },
      { x: 500, label: "권한 검토", sub: "위험도 × 종류 × 동의" },
      { x: 665, label: "실행", sub: "결과를 채팅으로" },
      { x: 820, label: "감사 기록", sub: "한 줄로 저장" },
    ],
    en: [
      { x: 20, label: "User input", sub: "Chat body" },
      { x: 175, label: "Host input classification", sub: "Slash commands only" },
      { x: 340, label: "Tool discovery", sub: "Selected scope + tool_search" },
      { x: 500, label: "Permission review", sub: "Risk × type × consent" },
      { x: 665, label: "Execute", sub: "Result back to chat" },
      { x: 820, label: "Audit record", sub: "Saved as one line" },
    ],
  };
  const steps = stepsByLocale[locale];
  const dict = {
    ko: {
      ariaLabel: "단일 메시지 턴의 데이터 흐름",
      denial: "거절 → 다시 사용자에게 (우회 없음)",
      footer: "모든 단계는 한 줄 기록으로 안전한 저장소에 남습니다",
    },
    en: {
      ariaLabel: "Data flow of a single message turn",
      denial: "Denied → back to the user (no bypass)",
      footer: "Every step is recorded as one line in secure storage",
    },
  }[locale];
  const w = 130;
  return (
    <svg viewBox="0 0 990 220" className={baseSvgClass} role="img" aria-label={dict.ariaLabel}>
      <Defs />
      {steps.map((s, i) => (
        <g key={i}>
          <rect x={s.x} y={60} width={w} height={70} rx={9} fill="#ffffff" stroke="#4b5573" strokeOpacity={0.55} />
          <text x={s.x + w / 2} y={90} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill="#14161d">
            {s.label}
          </text>
          <text x={s.x + w / 2} y={110} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">
            {s.sub}
          </text>
          {i < steps.length - 1 ? (
            <path
              d={`M${s.x + w + 4} 95 H ${steps[i + 1].x - 4}`}
              stroke="#4b5573"
              strokeWidth={1.6}
              markerEnd="url(#arrow-slate)"
            />
          ) : null}
        </g>
      ))}
      {/* denial loop-back */}
      <path d="M565 60 C 565 16, 200 16, 85 16 L 85 60" stroke="#9aa0ab" strokeWidth={1.4} strokeDasharray="4 4" fill="none" markerEnd="url(#arrow-gray)" />
      <text x={320} y={36} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={locale === "en" ? 11 : 12} fill="#9aa0ab" fontWeight={700}>
        {dict.denial}
      </text>
      <text x={500} y={180} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fill="#676b76">
        {dict.footer}
      </text>
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   3. PERMISSION DECISION TREE — RiskLevel × Category → outcome
   ──────────────────────────────────────────────────────────────── */
export function PermissionTree({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const decisionsByLocale = {
    ko: [
      { riskKey: "low", risk: "낮음 (low)", color: "#4b5573", outcomes: ["읽기 · 자동", "쓰기 · 자동", "실행 · 카드 확인", "네트워크 · 자동", "내부 · 자동"] },
      { riskKey: "medium", risk: "중간 (medium)", color: "#b7791f", outcomes: ["읽기 · 자동", "쓰기 · 카드 확인", "실행 · 다이얼로그", "네트워크 · 카드", "내부 · 자동"] },
      { riskKey: "high", risk: "높음 (high)", color: "#b3401f", outcomes: ["읽기 · 카드 확인", "쓰기 · 다이얼로그", "실행 · 다이얼로그 + 추가 동의", "네트워크 · 다이얼로그", "내부 · 카드"] },
    ],
    en: [
      { riskKey: "low", risk: "Low", color: "#4b5573", outcomes: ["Read · Auto", "Write · Auto", "Execute · Card confirm", "Network · Auto", "Internal · Auto"] },
      { riskKey: "medium", risk: "Medium", color: "#b7791f", outcomes: ["Read · Auto", "Write · Card confirm", "Execute · Dialog", "Network · Card", "Internal · Auto"] },
      { riskKey: "high", risk: "High", color: "#b3401f", outcomes: ["Read · Card confirm", "Write · Dialog", "Execute · Dialog + extra consent", "Network · Dialog", "Internal · Card"] },
    ],
  };
  const decisions = decisionsByLocale[locale];
  const dict = {
    ko: { ariaLabel: "권한 결정 트리", toolCall: "도구 호출", caller: "사용자 / Skill / 에이전트", riskPrefix: "위험도 · " },
    en: { ariaLabel: "Permission decision tree", toolCall: "Tool call", caller: "User / Skill / Agent", riskPrefix: "Risk · " },
  }[locale];
  return (
    <svg viewBox="0 0 960 380" className={baseSvgClass} role="img" aria-label={dict.ariaLabel}>
      <Defs />
      {/* root */}
      <rect x={390} y={10} width={180} height={50} rx={9} fill="#ffffff" stroke="#14161d" />
      <text x={480} y={32} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill="#14161d">{dict.toolCall}</text>
      <text x={480} y={48} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">{dict.caller}</text>

      {decisions.map((d, idx) => {
        const baseX = 30 + idx * 310;
        return (
          <g key={d.riskKey}>
            <rect x={baseX} y={90} width={290} height={42} rx={8} fill={d.color} fillOpacity={0.12} stroke={d.color} />
            <text x={baseX + 16} y={117} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill={d.color}>
              {dict.riskPrefix}{d.risk}
            </text>
            {/* connector from root */}
            <path d={`M480 60 C 480 80, ${baseX + 145} 80, ${baseX + 145} 90`} stroke={d.color} strokeWidth={1.6} fill="none" />
            {/* outcomes */}
            {d.outcomes.map((o, i) => (
              <g key={i}>
                <rect x={baseX} y={142 + i * 40} width={290} height={32} rx={6} fill="#ffffff" stroke={d.color} strokeOpacity={0.4} />
                <text x={baseX + 16} y={162 + i * 40} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={o.length > 25 ? 11.5 : 12.5} fill="#14161d">
                  {o}
                </text>
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   5. CAPABILITY PACK — single publishing unit (vision)
   ──────────────────────────────────────────────────────────────── */
export function CapabilityPackDiagram({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const cellsByLocale = {
    ko: [
      { label: "플러그인", hint: "기능 모듈", color: "#4b5573" },
      { label: "Agent", hint: "자율 작업", color: "#9aa0ab" },
      { label: "MCP", hint: "외부 도구 서버", color: "#14161d" },
      { label: "Skill", hint: "지침 묶음", color: "#c3ccdf" },
    ],
    en: [
      { label: "Plugin", hint: "Feature module", color: "#4b5573" },
      { label: "Agent", hint: "Autonomous task", color: "#9aa0ab" },
      { label: "MCP", hint: "External tool server", color: "#14161d" },
      { label: "Skill", hint: "Instruction bundle", color: "#c3ccdf" },
    ],
  };
  const cells = cellsByLocale[locale];
  const dict = {
    ko: {
      ariaLabel: "Capability Pack 구성도",
      publisher: "발행자",
      publisherHint: "서명 + 업로드",
      packSub: "한 묶음으로 발행 → 한 번에 설치",
      host: "사용자 호스트",
      hostHint: "한 번 클릭으로 설치",
      publishArrow: "발행",
      installArrow: "설치",
      footer: "지금: 네 가지가 따로 발행 / 따로 설치 → 다음: 한 묶음 발행, 한 번 설치",
    },
    en: {
      ariaLabel: "Capability Pack composition",
      publisher: "Publisher",
      publisherHint: "Sign + upload",
      packSub: "Publish as one bundle → install in one step",
      host: "User host",
      hostHint: "Install with one click",
      publishArrow: "Publish",
      installArrow: "Install",
      footer: "Now: four things published/installed separately → Next: one bundle, one install",
    },
  }[locale];
  return (
    <svg viewBox="0 0 980 380" className={baseSvgClass} role="img" aria-label={dict.ariaLabel}>
      <Defs />
      {/* Publisher */}
      <rect x={20} y={150} width={160} height={80} rx={9} fill="#ffffff" stroke="#14161d" />
      <text x={100} y={184} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill="#14161d">{dict.publisher}</text>
      <text x={100} y={204} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">{dict.publisherHint}</text>

      {/* Pack outer */}
      <rect x={250} y={40} width={500} height={300} rx={14} fill="#eef0f6" stroke="#c3ccdf" strokeDasharray="3 3" />
      <text x={500} y={72} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={16} fontWeight={700} fill="#3a3d47">
        Capability Pack
      </text>
      <text x={500} y={92} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">
        {dict.packSub}
      </text>

      {cells.map((c, i) => {
        const x = 275 + (i % 2) * 230;
        const y = 115 + Math.floor(i / 2) * 105;
        return (
          <g key={i}>
            <rect x={x} y={y} width={210} height={85} rx={9} fill="#ffffff" stroke={c.color} strokeOpacity={0.7} />
            <text x={x + 16} y={y + 30} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={15} fontWeight={700} fill={c.color}>
              {c.label}
            </text>
            <text x={x + 16} y={y + 54} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fill="#676b76">
              {c.hint}
            </text>
          </g>
        );
      })}

      {/* Host */}
      <rect x={820} y={150} width={140} height={80} rx={9} fill="#ffffff" stroke="#4b5573" />
      <text x={890} y={184} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill="#14161d">{dict.host}</text>
      <text x={890} y={204} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">{dict.hostHint}</text>

      {/* arrows */}
      <path d="M180 190 L 250 190" stroke="#14161d" strokeWidth={1.8} markerEnd="url(#arrow-ink)" />
      <text x={188} y={182} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fontWeight={700} fill="#14161d">{dict.publishArrow}</text>

      <path d="M750 190 L 820 190" stroke="#4b5573" strokeWidth={1.8} markerEnd="url(#arrow-slate)" />
      <text x={760} y={182} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fontWeight={700} fill="#4b5573">{dict.installArrow}</text>

      <text x={500} y={365} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={locale === "en" ? 11 : 12} fill="#676b76">
        {dict.footer}
      </text>
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   6. SUB-AGENT DELEGATE — sequence (vision)
   ──────────────────────────────────────────────────────────────── */
export function SubAgentSequence({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const lanesByLocale = {
    ko: [
      { label: "사용자", x: 100, color: "#14161d" },
      { label: "호스트", x: 290, color: "#4b5573" },
      { label: "권한 검토", x: 480, color: "#b7791f" },
      { label: "Sub-agent", x: 670, color: "#9aa0ab" },
      { label: "플러그인 도구", x: 850, color: "#14161d" },
    ],
    en: [
      { label: "User", x: 100, color: "#14161d" },
      { label: "Host", x: 290, color: "#4b5573" },
      { label: "Permission review", x: 480, color: "#b7791f" },
      { label: "Sub-agent", x: 670, color: "#9aa0ab" },
      { label: "Plugin tool", x: 850, color: "#14161d" },
    ],
  };
  const lanes = lanesByLocale[locale];
  const ariaLabel = locale === "en" ? "Sub-agent delegation sequence" : "Sub-agent 위임 시퀀스";
  const messagesByLocale = {
    ko: [
      { from: 0, to: 1, y: 95, label: "복합 요청 (예: 주간 회고 정리)", color: "#14161d" },
      { from: 1, to: 2, y: 135, label: "위임해도 될까요?", color: "#b7791f" },
      { from: 2, to: 1, y: 170, label: "사용자 확인 카드", color: "#b7791f", dashed: true },
      { from: 1, to: 0, y: 205, label: "‘위임하시겠어요?’", color: "#14161d", dashed: true },
      { from: 0, to: 1, y: 240, label: "허가", color: "#4b5573" },
      { from: 1, to: 3, y: 280, label: "위임 (범위 + 한도)", color: "#9aa0ab" },
      { from: 3, to: 4, y: 320, label: "도구 여러 번 자율 호출", color: "#9aa0ab" },
      { from: 4, to: 3, y: 350, label: "결과", color: "#9aa0ab", dashed: true },
      { from: 3, to: 1, y: 385, label: "완료 + 사용 도구 정리", color: "#9aa0ab", dashed: true },
      { from: 1, to: 0, y: 420, label: "최종 응답", color: "#14161d" },
    ],
    en: [
      { from: 0, to: 1, y: 95, label: "Complex request (e.g., organize weekly retro)", color: "#14161d" },
      { from: 1, to: 2, y: 135, label: "OK to delegate?", color: "#b7791f" },
      { from: 2, to: 1, y: 170, label: "User confirmation card", color: "#b7791f", dashed: true },
      { from: 1, to: 0, y: 205, label: "‘Delegate this?’", color: "#14161d", dashed: true },
      { from: 0, to: 1, y: 240, label: "Approve", color: "#4b5573" },
      { from: 1, to: 3, y: 280, label: "Delegate (scope + limits)", color: "#9aa0ab" },
      { from: 3, to: 4, y: 320, label: "Autonomously calls tools repeatedly", color: "#9aa0ab" },
      { from: 4, to: 3, y: 350, label: "Result", color: "#9aa0ab", dashed: true },
      { from: 3, to: 1, y: 385, label: "Done + summary of tools used", color: "#9aa0ab", dashed: true },
      { from: 1, to: 0, y: 420, label: "Final response", color: "#14161d" },
    ],
  };
  return (
    <svg viewBox="0 0 970 470" className={baseSvgClass} role="img" aria-label={ariaLabel}>
      <Defs />
      {lanes.map((l, i) => (
        <g key={i}>
          <rect x={l.x - 70} y={20} width={140} height={36} rx={6} fill="#ffffff" stroke={l.color} />
          <text x={l.x} y={43} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={13.5} fontWeight={700} fill={l.color}>
            {l.label}
          </text>
          <line x1={l.x} y1={60} x2={l.x} y2={440} stroke={l.color} strokeOpacity={0.25} strokeDasharray="2 4" />
        </g>
      ))}

      {messagesByLocale[locale].map((m, i) => {
        const a = lanes[m.from].x;
        const b = lanes[m.to].x;
        const dir = b - a >= 0 ? 1 : -1;
        const dashed = m.dashed ? "4 4" : undefined;
        return (
          <g key={i}>
            <line
              x1={a + 4 * dir}
              y1={m.y}
              x2={b - 8 * dir}
              y2={m.y}
              stroke={m.color}
              strokeWidth={1.5}
              strokeDasharray={dashed}
              markerEnd={`url(#${m.color === "#4b5573" ? "arrow-slate" : m.color === "#9aa0ab" ? "arrow-gray" : "arrow-ink"})`}
            />
            <text
              x={(a + b) / 2}
              y={m.y - 5}
              textAnchor="middle"
              fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif"
              fontSize={m.label.length > 26 ? 10.5 : 11.5}
              fontWeight={600}
              fill={m.color}
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   7. FEDERATION — host ↔ host work-item delegation (vision)
   ──────────────────────────────────────────────────────────────── */
export function FederationSequence({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const colsByLocale = {
    ko: [
      { label: "사용자 A", x: 100, color: "#14161d" },
      { label: "업무 보드 A", x: 350, color: "#4b5573" },
      { label: "업무 보드 B", x: 600, color: "#4b5573" },
      { label: "사용자 B", x: 850, color: "#14161d" },
    ],
    en: [
      { label: "User A", x: 100, color: "#14161d" },
      { label: "Work board A", x: 350, color: "#4b5573" },
      { label: "Work board B", x: 600, color: "#4b5573" },
      { label: "User B", x: 850, color: "#14161d" },
    ],
  };
  const cols = colsByLocale[locale];
  const dict = {
    ko: { ariaLabel: "Federation cross-host 위임", trust: "키 교환 + 권한 범위로 신뢰 표현" },
    en: { ariaLabel: "Federation cross-host delegation", trust: "Trust expressed via key exchange + permission scope" },
  }[locale];
  const messagesByLocale = {
    ko: [
      { from: 0, to: 1, y: 140, label: "작업 생성 (담당 = 외부 사용자)", color: "#14161d" },
      { from: 1, to: 2, y: 180, label: "다른 호스트로 작업 전달", color: "#4b5573" },
      { from: 2, to: 3, y: 220, label: "위임 도착 알림", color: "#4b5573" },
      { from: 3, to: 2, y: 260, label: "수락 / 거절", color: "#9aa0ab" },
      { from: 2, to: 1, y: 300, label: "응답 전달", color: "#4b5573", dashed: true },
      { from: 1, to: 0, y: 340, label: "원 사용자에게 알림", color: "#4b5573", dashed: true },
      { from: 0, to: 1, y: 380, label: "이후 진행 상황 양방향 동기화", color: "#14161d" },
    ],
    en: [
      { from: 0, to: 1, y: 140, label: "Create task (assignee = external user)", color: "#14161d" },
      { from: 1, to: 2, y: 180, label: "Forward task to the other host", color: "#4b5573" },
      { from: 2, to: 3, y: 220, label: "Delegation arrival notice", color: "#4b5573" },
      { from: 3, to: 2, y: 260, label: "Accept / decline", color: "#9aa0ab" },
      { from: 2, to: 1, y: 300, label: "Forward response", color: "#4b5573", dashed: true },
      { from: 1, to: 0, y: 340, label: "Notify original user", color: "#4b5573", dashed: true },
      { from: 0, to: 1, y: 380, label: "Two-way sync on progress from here on", color: "#14161d" },
    ],
  };
  return (
    <svg viewBox="0 0 970 460" className={baseSvgClass} role="img" aria-label={dict.ariaLabel}>
      <Defs />
      {cols.map((c, i) => (
        <g key={i}>
          <rect x={c.x - 90} y={20} width={180} height={36} rx={6} fill="#ffffff" stroke={c.color} />
          <text x={c.x} y={43} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={13.5} fontWeight={700} fill={c.color}>
            {c.label}
          </text>
          <line x1={c.x} y1={60} x2={c.x} y2={440} stroke={c.color} strokeOpacity={0.25} strokeDasharray="2 4" />
        </g>
      ))}

      <rect x={380} y={74} width={240} height={30} rx={6} fill="#eef0f6" stroke="#4b5573" strokeOpacity={0.5} />
      <text x={500} y={94} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={locale === "en" ? 11 : 12} fontWeight={700} fill="#3a3d47">
        {dict.trust}
      </text>

      {messagesByLocale[locale].map((m, i) => {
        const a = cols[m.from].x;
        const b = cols[m.to].x;
        const dir = b - a >= 0 ? 1 : -1;
        const dashed = m.dashed ? "4 4" : undefined;
        return (
          <g key={i}>
            <line
              x1={a + 4 * dir}
              y1={m.y}
              x2={b - 8 * dir}
              y2={m.y}
              stroke={m.color}
              strokeWidth={1.5}
              strokeDasharray={dashed}
              markerEnd={`url(#${m.color === "#4b5573" ? "arrow-slate" : m.color === "#9aa0ab" ? "arrow-gray" : "arrow-ink"})`}
            />
            <text
              x={(a + b) / 2}
              y={m.y - 5}
              textAnchor="middle"
              fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif"
              fontSize={m.label.length > 26 ? 10.5 : 11.5}
              fontWeight={600}
              fill={m.color}
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────
   4. PLUGIN LIFECYCLE — current + future hooks
   ──────────────────────────────────────────────────────────────── */
export function LifecycleDiagram({ locale = "ko" }: { locale?: "ko" | "en" }) {
  const currentByLocale = {
    ko: [
      { x: 20, label: "매니페스트 검증", sub: "패키지 + 서명 확인" },
      { x: 215, label: "초기화", sub: "플러그인 생성" },
      { x: 410, label: "시작", sub: "구독 / 준비" },
      { x: 600, label: "도구 호출", sub: "사용자 요청 응답" },
      { x: 800, label: "정지", sub: "종료 / 제거" },
    ],
    en: [
      { x: 20, label: "Manifest check", sub: "Verify package + signature" },
      { x: 215, label: "Initialize", sub: "Create plugin" },
      { x: 410, label: "Start", sub: "Subscribe / prepare" },
      { x: 600, label: "Tool call", sub: "Respond to user request" },
      { x: 800, label: "Stop", sub: "Shut down / remove" },
    ],
  };
  const current = currentByLocale[locale];
  const futureByLocale = {
    ko: [
      { x: 20, label: "onInstall", at: "매니페스트 검증 직후", color: "#9aa0ab" },
      { x: 215, label: "onActivate", at: "초기화 직후", color: "#9aa0ab" },
      { x: 410, label: "onTokenRefresh", at: "외부 인증 만료 시", color: "#b7791f" },
      { x: 600, label: "pre / postToolCall", at: "도구 호출 전후", color: "#9aa0ab" },
      { x: 800, label: "onDeactivate", at: "정지 직후", color: "#9aa0ab" },
    ],
    en: [
      { x: 20, label: "onInstall", at: "Right after manifest check", color: "#9aa0ab" },
      { x: 215, label: "onActivate", at: "Right after initialize", color: "#9aa0ab" },
      { x: 410, label: "onTokenRefresh", at: "When external auth expires", color: "#b7791f" },
      { x: 600, label: "pre / postToolCall", at: "Before/after tool calls", color: "#9aa0ab" },
      { x: 800, label: "onDeactivate", at: "Right after stop", color: "#9aa0ab" },
    ],
  };
  const future = futureByLocale[locale];
  const dict = {
    ko: {
      ariaLabel: "플러그인 라이프사이클 + 향후 hook 지점",
      nowHeader: "지금 — 시작 · 정지 두 단계",
      futureHeader: "앞으로 추가 — 더 많은 단계",
      footer: "점선 = 새 단계가 현재 어디에 끼어드는지 표시",
    },
    en: {
      ariaLabel: "Plugin lifecycle + future hook points",
      nowHeader: "Now — two stages: start and stop",
      futureHeader: "Coming later — more stages",
      footer: "Dotted line = where the new stage hooks into the current flow",
    },
  }[locale];

  return (
    <svg viewBox="0 0 970 330" className={baseSvgClass} role="img" aria-label={dict.ariaLabel}>
      <Defs />
      <text x={20} y={26} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fontWeight={700} fill="#3a3d47" letterSpacing={1.4}>
        {dict.nowHeader}
      </text>
      {current.map((c, i) => (
        <g key={i}>
          <rect x={c.x} y={40} width={150} height={66} rx={9} fill="#ffffff" stroke="#4b5573" />
          <text x={c.x + 75} y={68} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={14} fontWeight={700} fill="#14161d">
            {c.label}
          </text>
          <text x={c.x + 75} y={88} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={11.5} fill="#676b76">
            {c.sub}
          </text>
          {i < current.length - 1 ? (
            <path d={`M${c.x + 154} 73 H ${current[i + 1].x - 4}`} stroke="#4b5573" strokeWidth={1.6} markerEnd="url(#arrow-slate)" />
          ) : null}
        </g>
      ))}

      <line x1={20} y1={148} x2={950} y2={148} stroke="#e6e7ec" strokeDasharray="4 4" />

      <text x={20} y={174} fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fontWeight={700} fill="#9aa0ab" letterSpacing={1.4}>
        {dict.futureHeader}
      </text>
      {future.map((f, i) => (
        <g key={i}>
          <rect x={f.x} y={188} width={150} height={66} rx={9} fill={f.color} fillOpacity={0.08} stroke={f.color} strokeDasharray="3 3" />
          <text x={f.x + 75} y={216} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={13.5} fontWeight={700} fill={f.color}>
            {f.label}
          </text>
          <text x={f.x + 75} y={236} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={f.at.length > 24 ? 10.5 : 11.5} fill="#676b76">
            {f.at}
          </text>
          <path d={`M${f.x + 75} 188 V 148 V 106`} stroke={f.color} strokeWidth={1.2} strokeDasharray="3 3" fill="none" />
        </g>
      ))}

      <text x={485} y={300} textAnchor="middle" fontFamily="'Pretendard Variable', Pretendard, -apple-system, 'Segoe UI', sans-serif" fontSize={12} fill="#676b76">
        {dict.footer}
      </text>
    </svg>
  );
}
