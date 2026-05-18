/**
 * Live Auto-play — composite view (banner + scripted entries + take-over footer).
 *
 * Mockup SOT: `/tmp/login-lvis/index.html` O-X1.
 * Proposal: `docs/architecture/proposals/live-autoplay.md`.
 *
 * Mounted ChatView-side when `useDemoAutoplay()` reports active. Owns the
 * full scripted-turn lifecycle: it instantiates a single `ScriptedTurnEngine`,
 * feeds events into local view-state, and aborts on user takeover. The
 * scripted entries live ONLY here — they never reach `ConversationLoop` or
 * `ChatHistory` (proposal §5 R4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScriptedTurnEngine } from "../../../engine/demo-autoplay/scripted-turn-engine.js";
import type {
  ScriptedAbortReason,
  ScriptedSink,
  ScriptedToolCall,
  ScriptedTurn,
} from "../../../engine/demo-autoplay/types.js";
import { Button } from "../../../components/ui/button.js";
import { DemoAutoplayBanner } from "./DemoAutoplayBanner.js";

interface DemoEntry {
  id: string;
  kind: "user" | "tool-call" | "tool-result" | "assistant";
  text: string;
  status?: "running" | "done";
  toolName?: string;
  labelKo?: string;
  isFinal?: boolean;
}

export interface DemoAutoplayViewProps {
  turn: ScriptedTurn;
  /**
   * Called when the engine reports a terminal state. The host (ChatView /
   * App.tsx) should flip `features.demoAutoplayEnabled = false`, clear
   * its view-only state, and let the normal chat surface take over.
   */
  onFinished: (reason: ScriptedAbortReason) => void;
  /**
   * Called for every emitted event so the host can stream audit-log
   * entries with the `[demo-autoplay]` prefix (proposal §8).
   */
  onAuditEvent?: (event: DemoAuditEvent) => void;
}

export interface DemoAuditEvent {
  scriptId: string;
  phase: "start" | "user" | "tool-call" | "tool-result" | "assistant" | "aborted";
  detail?: string;
}

export function DemoAutoplayView({ turn, onFinished, onAuditEvent }: DemoAutoplayViewProps) {
  const [entries, setEntries] = useState<DemoEntry[]>([]);
  const engineRef = useRef<ScriptedTurnEngine | null>(null);
  const auditRef = useRef(onAuditEvent);
  auditRef.current = onAuditEvent;

  const upsertEntry = useCallback((next: DemoEntry) => {
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === next.id);
      if (idx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  const sink = useMemo<ScriptedSink>(
    () => ({
      emitUserMessage(text, isFinal) {
        upsertEntry({ id: "user-1", kind: "user", text, isFinal });
        auditRef.current?.({ scriptId: turn.id, phase: "user", detail: isFinal ? "final" : "delta" });
      },
      emitToolCall(call, status) {
        upsertEntry({
          id: `tool-call:${call.toolName}`,
          kind: "tool-call",
          text: call.labelKo,
          toolName: call.toolName,
          labelKo: call.labelKo,
          status,
        });
        auditRef.current?.({ scriptId: turn.id, phase: "tool-call", detail: `${call.toolName}:${status}` });
      },
      emitToolResult(call, resultKo) {
        upsertEntry({
          id: `tool-result:${call.toolName}`,
          kind: "tool-result",
          text: resultKo,
          toolName: call.toolName,
          labelKo: call.labelKo,
        });
        auditRef.current?.({ scriptId: turn.id, phase: "tool-result", detail: call.toolName });
      },
      emitAssistantDelta(text, isFinal) {
        upsertEntry({ id: "assistant-1", kind: "assistant", text, isFinal });
        auditRef.current?.({
          scriptId: turn.id,
          phase: "assistant",
          detail: isFinal ? "final" : "delta",
        });
      },
      onAborted(reason) {
        auditRef.current?.({ scriptId: turn.id, phase: "aborted", detail: reason });
        onFinished(reason);
      },
    }),
    [turn.id, upsertEntry, onFinished],
  );

  // Bootstrap engine. Effect runs once per (turn, sink) — sink is stable
  // because upsertEntry is stable and onFinished is wrapped in useCallback
  // by the parent (App.tsx).
  useEffect(() => {
    const engine = new ScriptedTurnEngine();
    engineRef.current = engine;
    auditRef.current?.({ scriptId: turn.id, phase: "start" });
    void engine.start(turn, sink).catch(() => {
      // Abort path already routes through sink.onAborted; engine throws
      // only on misuse (start twice). Swallow here so React doesn't see
      // an unhandled rejection from an unmounted view.
    });
    return () => {
      // Component unmounted before completion → treat as external abort.
      engine.abort("external");
    };
  }, [turn, sink]);

  const handleTakeOver = useCallback(() => {
    engineRef.current?.abort("user-takeover");
  }, []);

  // Take-over also fires on the first keystroke anywhere inside the
  // demo surface (proposal §5). The composer is rendered by the host
  // ChatView, so the wrapper element here listens once at capture phase.
  useEffect(() => {
    function onKeyDownCapture(ev: KeyboardEvent) {
      // Ignore modifier-only keys so a stray Shift doesn't kill the demo.
      if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta") {
        return;
      }
      engineRef.current?.abort("user-input");
    }
    document.addEventListener("keydown", onKeyDownCapture, true);
    return () => document.removeEventListener("keydown", onKeyDownCapture, true);
  }, []);

  return (
    <div
      data-testid="demo-autoplay-view"
      className="flex h-full flex-col"
    >
      <DemoAutoplayBanner titleKo={turn.titleKo} onTakeOver={handleTakeOver} />
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-[12px]">
        {entries.map((entry) => (
          <DemoEntryView key={entry.id} entry={entry} />
        ))}
      </div>
      <div
        className="border-t p-2.5"
        style={{
          borderColor: "hsl(var(--border))",
          background:
            "linear-gradient(180deg, transparent, hsl(var(--action-view) / 0.10))",
        }}
      >
        <div
          className="flex items-center gap-2 rounded-md p-2"
          style={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--action-view) / 0.5)",
          }}
        >
          <span className="text-base" aria-hidden="true">👋</span>
          <div className="flex-1 text-[11.5px]">
            <div>이런 식으로 동작해요. 직접 해보시겠어요?</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              언제든 키를 잡으면 demo 가 중단되고 일반 대화로 전환됩니다.
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="demo-autoplay-view:take-over-footer"
            onClick={handleTakeOver}
            className="text-[11px]"
            style={{
              background: "hsl(var(--action-view))",
              color: "white",
            }}
          >
            키 잡기 →
          </Button>
        </div>
      </div>
    </div>
  );
}

function DemoEntryView({ entry }: { entry: DemoEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end gap-2" data-testid="demo-entry:user">
        <div
          className="max-w-[80%] rounded-lg rounded-tr-sm px-3 py-2"
          style={{ background: "hsl(217 91% 60%)", color: "white" }}
        >
          {entry.text}
          {entry.isFinal === false && <CursorBlink />}
        </div>
      </div>
    );
  }
  if (entry.kind === "tool-call") {
    return (
      <div className="flex gap-2" data-testid="demo-entry:tool-call">
        <BotAvatar />
        <div
          className="flex-1 rounded-lg rounded-tl-sm px-3 py-2"
          style={{ background: "hsl(var(--card))" }}
        >
          <div className="mb-1 text-[10.5px] text-muted-foreground">🛠 도구 사용 요청 (데모)</div>
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-[11px] rounded px-1.5 py-0.5"
              style={{ background: "hsl(217 33% 17%)", color: "hsl(217 91% 75%)" }}
            >
              {entry.toolName}
            </span>
            <span className="text-[10.5px] text-muted-foreground">{entry.labelKo}</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[10.5px]">
            <span
              className="rounded px-2 py-1 text-white"
              style={{ background: "hsl(142 71% 45%)" }}
            >
              {entry.status === "done" ? "승인됨 ✓" : "승인 (자동) ✓"}
            </span>
            <span className="text-muted-foreground">데모: 시연을 위해 자동 승인</span>
          </div>
        </div>
      </div>
    );
  }
  if (entry.kind === "tool-result") {
    return (
      <div className="flex gap-2" data-testid="demo-entry:tool-result">
        <BotAvatar invisible />
        <div
          className="flex-1 rounded-lg rounded-tl-sm px-3 py-2 font-mono text-[10.5px] text-muted-foreground"
          style={{ background: "hsl(var(--card))" }}
        >
          📄 데모: {entry.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2" data-testid="demo-entry:assistant">
      <BotAvatar invisible />
      <div
        className="flex-1 whitespace-pre-wrap rounded-lg rounded-tl-sm px-3 py-2 leading-relaxed"
        style={{ background: "hsl(var(--card))" }}
      >
        {entry.text}
        {entry.isFinal === false && <CursorBlink />}
      </div>
    </div>
  );
}

function BotAvatar({ invisible = false }: { invisible?: boolean }) {
  return (
    <div
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[11px] text-white"
      style={{
        background: invisible
          ? "transparent"
          : "linear-gradient(135deg, hsl(var(--action-view)), hsl(217 91% 60%))",
        visibility: invisible ? "hidden" : "visible",
      }}
      aria-hidden="true"
    >
      ✦
    </div>
  );
}

function CursorBlink() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-3 w-1 align-middle demo-autoplay-cursor"
      style={{ background: "currentColor" }}
    />
  );
}

export type { ScriptedToolCall };
