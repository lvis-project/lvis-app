/**
 * Approval Gate — §6.3 Layer 3 + §8 Agent Approval System
 *
 * Main process 서비스. "ask" 판정이 발생하면 렌더러에 요청을 보내고
 * 사용자 응답이 돌아올 때까지 ConversationLoop turn을 블로킹.
 *
 * - 동시 복수 요청: Map으로 격리 (requestId 키).
 * - 타임아웃: 기본 5분 → deny-once 반환.
 * - requireExplicit: PolicyFile.requireExplicitApproval을 그대로 렌더러로 전달,
 *   dismiss/Escape 동작을 renderer에서 분기.
 * - §A2: webContents 소멸 체크 + send 예외 처리 → deny-once + pending 정리.
 * - §S8: AuditLogger DI — requested/decided/timeout/send-failed 4개 phase 기록.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebContents } from "electron";
import type { PolicyFile } from "./policy-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import { isSensitivePath, canonicalizePathForMatch } from "./sensitive-paths.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";

// ─── §D1 args DLP masking ────────────────────────────
// Approval 모달에 전달되는 tool args 내 민감정보(API key, 이메일, 전화번호,
// 주민등록번호, 신용카드 등)를 UI 표시용으로만 마스킹한다. 원본 args 는
// executor 가 별도로 보유한 toolUse.input 을 그대로 사용하므로 실행 경로에는
// 영향이 없다.
function maskArgsForDisplay(value: unknown, detections: Set<string>): unknown {
  if (typeof value === "string") {
    const { masked, detections: hits } = maskSensitiveData(value);
    for (const h of hits) detections.add(h);
    return masked;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskArgsForDisplay(v, detections));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskArgsForDisplay(v, detections);
    }
    return out;
  }
  return value;
}

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
  category: "tool";
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
   * §S1 metadata hint. When the executor detected that `target.filePath`
   * matches a SENSITIVE_PATH_PATTERNS entry, this field carries the
   * matched pattern string for diagnostics, logging, and any non-blocking
   * consumers of the request payload. Remains `null`/omitted when the
   * path is not sensitive.
   *
   * Note: the authoritative hard-block is enforced inside
   * {@link ApprovalGate.requestAndWait} before any approval dialog is
   * shown, using the same {@link isSensitivePath} function. As a result,
   * the renderer should not rely on this field to display blocked-state UI
   * for the sensitive-path denial path.
   */
  sensitivePathPattern?: string | null;
  /**
   * §D2: Confused-deputy defense — random nonce bound to this request.
   * The renderer MUST echo this value back unchanged in the
   * {@link ApprovalDecision}. Paired with {@link hmac} for integrity.
   */
  nonce?: string;
  /**
   * §D2: HMAC-SHA256(sessionKey, `${id}|${nonce}|${canonicalArgs}`) —
   * hex encoded. The main process re-derives this from the stored pending
   * entry on receipt of the decision and rejects on mismatch.
   */
  hmac?: string;
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
  /**
   * §D2: Nonce originally issued with the {@link ApprovalRequest}. The
   * renderer echoes it back verbatim. Missing or mismatched values cause
   * the decision to be rejected and treated as deny-once.
   */
  nonce?: string;
  /**
   * §D2: HMAC originally issued with the {@link ApprovalRequest}. Echoed
   * back by the renderer. The main process re-computes the expected HMAC
   * from the pending entry and compares using timingSafeEqual.
   */
  hmac?: string;
}

// ─── IPC 채널 이름 (안정 상수) ────────────────────────

export const IPC_APPROVAL_REQUEST = "lvis:approval:request";
export const IPC_APPROVAL_RESPOND = "lvis:approval:respond";

// ─── Pending 항목 ────────────────────────────────────

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** §D2: nonce issued for this request (echoed back verbatim) */
  nonce: string;
  /** §D2: expected HMAC for this request */
  expectedHmac: string;
}

/**
 * §D2: Deterministic canonicalization of arbitrary tool args for HMAC input.
 * Sorts object keys recursively; stringifies with JSON. Non-JSON values
 * (undefined, functions) are skipped just like JSON.stringify.
 */
function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const stringify = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (seen.has(v as object)) return '"[Circular]"';
    seen.add(v as object);
    if (Array.isArray(v)) {
      return "[" + v.map((e) => stringify(e)).join(",") + "]";
    }
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stringify((v as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  };
  return stringify(value);
}

/**
 * §D2: constant-time comparison of the echoed (nonce, hmac) pair against
 * the pending entry's expected values. Returns false if either field is
 * missing or malformed; returns true only when both the nonce and HMAC
 * match byte-for-byte.
 */
function verifyApprovalIntegrity(
  entry: PendingEntry,
  decision: ApprovalDecision,
): boolean {
  const { nonce, hmac } = decision;
  if (typeof nonce !== "string" || typeof hmac !== "string") return false;
  if (nonce.length !== entry.nonce.length) return false;
  if (hmac.length !== entry.expectedHmac.length) return false;
  const nonceA = Buffer.from(nonce);
  const nonceB = Buffer.from(entry.nonce);
  const hmacA = Buffer.from(hmac);
  const hmacB = Buffer.from(entry.expectedHmac);
  if (nonceA.length !== nonceB.length || hmacA.length !== hmacB.length) {
    return false;
  }
  return timingSafeEqual(nonceA, nonceB) && timingSafeEqual(hmacA, hmacB);
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
  /**
   * Issue #260: optional NotificationService — when supplied, the gate fires
   * an `approval` system notification at the entry of `requestAndWait` so
   * the user sees the prompt even if the window is backgrounded.
   */
  private readonly notificationService?: NotificationService;
  /**
   * Optional callback invoked after each gate timeout (requestId, timeoutMs).
   * Used by `plugin-runtime.ts` to call
   * `approvalIssuerRegistry.purgeStalerThan(timeoutMs)` so stale issuer
   * registry entries from timed-out requests are cleaned up without the
   * registry needing to know about the gate's timeout policy.
   */
  private readonly onTimeout?: (requestId: string, timeoutMs: number) => void;
  /**
   * §D2: Per-instance HMAC secret. 32 random bytes generated at construction
   * time. Never leaves the main process — used only to sign/verify the nonce
   * that rides along with approval requests. A fresh key each boot naturally
   * scopes replay protection to the current ApprovalGate lifetime.
   */
  private readonly sessionKey: Buffer = randomBytes(32);

  constructor(
    webContents: WebContents,
    initialPolicy?: PolicyFile,
    timeoutMs = 5 * 60 * 1000,
    auditLogger?: AuditLogger,
    notificationService?: NotificationService,
    onTimeout?: (requestId: string, timeoutMs: number) => void,
  ) {
    this.webContents = webContents;
    this.timeoutMs = timeoutMs;
    this.auditLogger = auditLogger;
    this.notificationService = notificationService;
    this.onTimeout = onTimeout;
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
    // H3: canonicalize the path BEFORE matching via the shared
    // canonicalizePathForMatch() helper. This closes four bypass vectors:
    // `..` segments, NFD unicode forms, trailing spaces, mixed-case on
    // case-insensitive filesystems, and duplicate slashes.
    const rawCandidate = fullReq.target?.filePath;
    if (rawCandidate) {
      const caseFolded = canonicalizePathForMatch(rawCandidate);
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

    // Issue #260 — surface a system notification when an approval is about
    // to block the user. Approval is the most user-visible gate; default to
    // urgent so the OS toast plays sound even when window is backgrounded.
    try {
      this.notificationService?.fire({
        kind: "approval",
        title: "승인이 필요합니다",
        body: `${fullReq.toolName}: ${fullReq.reason}`,
        contextRef: { approvalId: fullReq.id },
        urgent: true,
      });
    } catch {
      // notification failure must never block approval flow
    }

    // §D2: mint nonce + HMAC, attach to outgoing request
    const nonce = randomBytes(16).toString("hex");
    const canonicalArgs = canonicalStringify(fullReq.args);
    const signingInput = `${fullReq.id}|${nonce}|${fullReq.toolName}|${canonicalArgs}`;
    const expectedHmac = createHmac("sha256", this.sessionKey)
      .update(signingInput)
      .digest("hex");
    const signedReq: ApprovalRequest = {
      ...fullReq,
      nonce,
      hmac: expectedHmac,
    };

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
        // Notify the issuer registry so it can purge stale entries that
        // accumulated from timed-out requests whose respond() was never called.
        this.onTimeout?.(fullReq.id, this.timeoutMs);
        resolve({
          requestId: fullReq.id,
          choice: "deny-once",
        });
      }, this.timeoutMs);

      this.pending.set(fullReq.id, {
        resolve,
        reject,
        timer,
        nonce,
        expectedHmac,
      });

      // 렌더러로 요청 발송 (main→renderer 단방향)
      // §D1: UI 표시용으로 args 의 민감정보를 마스킹. 원본 args 는 executor
      // 내부에 남아 tool 실행에는 그대로 사용됨.
      // §D2: 마스킹된 payload 에 nonce+hmac 을 덧붙여 confused-deputy 방어.
      const dlpHits = new Set<string>();
      const maskedSignedReq: ApprovalRequest = {
        ...signedReq,
        args: maskArgsForDisplay(fullReq.args, dlpHits),
      };
      if (dlpHits.size > 0) {
        this.auditLogger?.log({
          timestamp: new Date().toISOString(),
          sessionId: "approval-gate",
          type: "approval",
          output: `[approval:args-dlp-masked] ${fullReq.id} toolName=${fullReq.toolName} detections=${[...dlpHits].join(",")}`,
        });
      }
      // §F2: send 실패(webContents 소멸 race) 시 pending 정리 후 deny-once
      try {
        this.webContents.send(IPC_APPROVAL_REQUEST, maskedSignedReq);
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

    // §D2: Confused-deputy defense — verify nonce + HMAC BEFORE honoring the
    // decision. A mismatch indicates either a malicious/compromised renderer,
    // a replay of a stale decision, or a cross-request mix-up. Force
    // deny-once and audit the failure.
    if (!verifyApprovalIntegrity(entry, decision)) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        sessionId: "approval-gate",
        type: "approval",
        output: `[approval:nonce-mismatch] ${requestId} choice=${decision.choice} nonceProvided=${decision.nonce ? "yes" : "no"} hmacProvided=${decision.hmac ? "yes" : "no"} → deny-once (forced)`,
      });
      entry.resolve({
        requestId,
        choice: "deny-once",
        rememberPattern: "approval integrity check failed",
      });
      return;
    }

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
