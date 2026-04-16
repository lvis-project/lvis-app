/**
 * Approval Gate — §6.3 Layer 3 + §8 Agent Approval System
 *
 * Main process 서비스. "ask" 판정이 발생하면 렌더러에 요청을 보내고
 * 사용자 응답이 돌아올 때까지 ConversationLoop turn을 블로킹.
 *
 * - 동시 복수 요청: Map으로 격리 (requestId 키).
 * - 타임아웃: 기본 5분 → deny-once 반환.
 * - category "tool" | "agent-action": 동일 UX, 타이틀만 분기.
 * - requireExplicit: PolicyFile.requireExplicitApproval을 그대로 렌더러로 전달,
 *   dismiss/Escape 동작을 renderer에서 분기.
 * - §A2: webContents 소멸 체크 + send 예외 처리 → deny-once + pending 정리.
 * - §S8: AuditLogger DI — requested/decided/timeout/send-failed 4개 phase 기록.
 */
import { resolve as pathResolve } from "node:path";
import type { WebContents } from "electron";
import type { PolicyFile } from "./policy-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { isSensitivePath } from "./sensitive-paths.js";

// ─── 공개 타입 ────────────────────────────────────────

/**
 * Permission mode hint passed alongside an ApprovalRequest. Drives the
 * §S4 isReadOnly short-circuit: in "plan" mode even read-only tools must
 * still be blocked (plan mode is a dry-run / review stance).
 *
 * `undefined` → treat as "default" (standard read-only auto-approve).
 */
export type ApprovalMode = "default" | "plan" | "full_auto";

export interface ApprovalRequest {
  id: string;
  category: "tool" | "agent-action";
  toolName: string;
  args: unknown;
  reason: string;
  source?: "builtin" | "plugin" | "mcp";
  createdAt: number;
  /** PolicyFile.requireExplicitApproval — renderer가 dismiss 동작을 분기하는 데 사용 */
  requireExplicit: boolean;
  /**
   * §S1: absolute filesystem path the tool intends to touch. When set and
   * matched against SENSITIVE_PATH_PATTERNS, the request is hard-blocked
   * BEFORE the user dialog is shown. Cannot be overridden.
   */
  target?: {
    filePath?: string;
  };
  /**
   * §S4: tool self-declares it does not mutate state. When true and the
   * current mode is not "plan", the dialog is skipped and the call is
   * auto-approved with reason "read-only auto-approve".
   */
  isReadOnly?: boolean;
  /**
   * §S4: current permission mode. Drives the isReadOnly short-circuit:
   *   - "default" / "full_auto" / undefined → read-only tools auto-approve
   *   - "plan" → still block (plan mode inspects without executing)
   */
  mode?: ApprovalMode;
  /**
   * §S1 renderer hint. When the executor detected that `target.filePath`
   * matches a SENSITIVE_PATH_PATTERNS entry, this field carries the
   * matched pattern string so the dialog can surface a prominent warning.
   * Remains `null`/omitted when the path is not sensitive.
   *
   * Note: this is a user-facing hint only. The authoritative hard-block
   * is enforced inside {@link ApprovalGate.requestAndWait} before the
   * dialog is shown, using the same {@link isSensitivePath} function.
   */
  sensitivePathPattern?: string | null;
}

export type ApprovalChoice =
  | "allow-once"
  | "allow-always"
  | "deny-once"
  | "deny-always";

export interface ApprovalDecision {
  requestId: string;
  choice: ApprovalChoice;
  /** allow-always / deny-always 일 때 영구화 패턴 (기본: 도구 이름 exact) */
  rememberPattern?: string;
}

// ─── IPC 채널 이름 (안정 상수) ────────────────────────

export const IPC_APPROVAL_REQUEST = "lvis:approval:request";
export const IPC_APPROVAL_RESPOND = "lvis:approval:respond";

// ─── Pending 항목 ────────────────────────────────────

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── ApprovalGate ────────────────────────────────────

export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly webContents: WebContents;
  /** 타임아웃(ms). 기본 5분. */
  private readonly timeoutMs: number;
  /** 현재 활성 policy. setPolicy()로 런타임 교체 가능. */
  private currentPolicy: PolicyFile;
  /** §S8: 감사 로거 (optional — 미주입 시 silent) */
  private readonly auditLogger?: AuditLogger;

  constructor(
    webContents: WebContents,
    initialPolicy?: PolicyFile,
    timeoutMs = 5 * 60 * 1000,
    auditLogger?: AuditLogger,
  ) {
    this.webContents = webContents;
    this.timeoutMs = timeoutMs;
    this.auditLogger = auditLogger;
    this.currentPolicy = initialPolicy ?? {
      version: 1,
      requireExplicitApproval: true,
      managed: false,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 런타임 policy 교체 — lvis:policy:set IPC 핸들러에서 즉시 반영.
   */
  setPolicy(p: PolicyFile): void {
    this.currentPolicy = p;
  }

  /**
   * 승인 요청을 렌더러로 전송하고 응답을 기다린다.
   * ConversationLoop의 executeOne()에서 await하여 turn을 블로킹.
   * requireExplicit 필드로 renderer dismiss 동작을 제어.
   */
  async requestAndWait(
    req: Omit<ApprovalRequest, "requireExplicit">,
  ): Promise<ApprovalDecision> {
    const fullReq: ApprovalRequest = {
      ...req,
      requireExplicit: this.currentPolicy.requireExplicitApproval,
    };

    // §S1: sensitive-path hard-block — runs BEFORE anything else so that
    // not even full_auto / user-approval paths can bypass it. Cannot be
    // overridden by user approval, admin policy, or permission mode.
    //
    // H3: canonicalize the path BEFORE matching. Pure string matching is
    // bypassable via `..` segments, NFD unicode forms, trailing spaces,
    // mixed-case on case-insensitive filesystems, and duplicate slashes.
    // All four vectors are closed below before invoking isSensitivePath().
    const rawCandidate = fullReq.target?.filePath;
    if (rawCandidate) {
      // 1. Resolve `..` / `.` segments + make absolute
      let canonical = pathResolve(rawCandidate);
      // 2. Collapse duplicate slashes (///Users → /Users)
      canonical = canonical.replace(/\/+/g, "/");
      // 3. Unicode NFC normalize (folds NFD-decomposed forms, e.g.
      //    ".\u0073\u0073h" → ".ssh")
      canonical = canonical.normalize("NFC");
      // 4. Case-fold on case-insensitive filesystems (macOS / Windows) so
      //    `/Users/Ken/.SSH/ID_rsa` matches `**/.ssh/*` — the underlying
      //    filesystem treats them as the same file, so the block must too.
      const caseFolded =
        process.platform === "darwin" || process.platform === "win32"
          ? canonical.toLowerCase()
          : canonical;
      const matchedPattern = isSensitivePath(caseFolded);
      if (matchedPattern) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:sensitive-path-blocked] ${fullReq.id} toolName=${fullReq.toolName} raw=${rawCandidate} canonical=${caseFolded} pattern=${matchedPattern} → deny-once (hard-block)`,
        });
        return {
          requestId: fullReq.id,
          choice: "deny-once",
          rememberPattern: `Sensitive credential path blocked: ${matchedPattern}`,
        };
      }
    }

    // §S4: isReadOnly short-circuit — if the tool self-declares read-only
    // and we are NOT in plan mode, skip the confirmation dialog. Plan
    // mode still blocks (plan = dry-run / inspect only).
    if (fullReq.isReadOnly === true && fullReq.mode !== "plan") {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:read-only-auto-approve] ${fullReq.id} toolName=${fullReq.toolName} mode=${fullReq.mode ?? "default"} → allow-once`,
      });
      return {
        requestId: fullReq.id,
        choice: "allow-once",
        rememberPattern: "read-only auto-approve",
      };
    }

    // §A2: webContents 소멸 체크 — 렌더러가 이미 닫혔으면 즉시 deny-once
    if (this.webContents.isDestroyed()) {
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:send-failed] ${fullReq.id} toolName=${fullReq.toolName} — webContents already destroyed → deny-once`,
      });
      return { requestId: fullReq.id, choice: "deny-once" };
    }

    // §S8 phase: requested
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gate",
      type: "approval",
      input: `[approval:requested] ${fullReq.id} toolName=${fullReq.toolName} category=${fullReq.category} source=${fullReq.source ?? "unknown"}`,
    });

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(fullReq.id);
        // 타임아웃: deny-once로 처리 (보안 우선)
        // §S8 phase: timeout
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:timeout] ${fullReq.id} toolName=${fullReq.toolName} → deny-once`,
        });
        resolve({
          requestId: fullReq.id,
          choice: "deny-once",
        });
      }, this.timeoutMs);

      this.pending.set(fullReq.id, { resolve, reject, timer });

      // 렌더러로 요청 발송 (main→renderer 단방향)
      // §F2: send 실패(webContents 소멸 race) 시 pending 정리 후 deny-once
      try {
        this.webContents.send(IPC_APPROVAL_REQUEST, fullReq);
      } catch (sendErr) {
        clearTimeout(timer);
        this.pending.delete(fullReq.id);
        // §S8 phase: send-failed
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:send-failed] ${fullReq.id} toolName=${fullReq.toolName} error=${sendErr instanceof Error ? sendErr.message : String(sendErr)} → deny-once`,
        });
        resolve({ requestId: fullReq.id, choice: "deny-once" });
      }
    });
  }

  /**
   * 렌더러 응답 수신 시 IPC 핸들러에서 호출.
   * 매칭되는 pending 항목이 없으면 무시(이중 응답 안전).
   */
  resolve(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    // §S8 phase: decided
    this.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: "approval-gate",
      type: "approval",
      output: `[approval:decided] ${requestId} choice=${decision.choice} rememberPattern=${decision.rememberPattern ?? "none"}`,
    });
    entry.resolve(decision);
  }

  /** 정리: 앱 종료 시 모든 대기 중인 요청을 거부 */
  disposeAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ requestId: id, choice: "deny-once" });
    }
    this.pending.clear();
  }

  /** 현재 대기 중인 요청 수 (테스트용) */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 현재 적용 중인 policy 조회 (테스트용) */
  get policy(): PolicyFile {
    return this.currentPolicy;
  }
}
