/**
 * Hook Runner — LVIS in-process tool interception
 *
 * 도구 실행 전후에 인터셉션 포인트를 제공.
 * Hook은 deny(차단), modify(입력 변경), feedback(결과에 메시지 추가) 가능.
 *
 * In-memory hook registration.
 * 향후: 플러그인이 훅을 등록하여 거버넌스/감사/변환 수행
 *
 * Permission policy: this runner is now in-process only. Production script hooks use
 * `ScriptHookManager` + discrete `pre/post/perm-*.sh` files so every external
 * hook goes through the TOFU lockfile/quarantine path.
 */

import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
const log = createLogger("hook");

// ─── Types ──────────────────────────────────────────

export interface HookContext {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface HookResult {
  /** deny: 도구 실행 차단, allow: 계속, modify: 입력 변경 */
  action: "allow" | "deny" | "modify";
  /** deny 시 사유 */
  reason?: string;
  /** modify 시 변경된 입력 */
  updatedInput?: Record<string, unknown>;
  /** 도구 결과에 추가할 피드백 메시지 */
  feedback?: string;
}

export interface PostHookContext extends HookContext {
  toolOutput: string;
  isError: boolean;
}

export interface PostHookResult {
  /** 도구 결과에 추가할 피드백 */
  feedback?: string;
}

export type PreToolUseHook = (ctx: HookContext) => Promise<HookResult> | HookResult;
export type PostToolUseHook = (ctx: PostHookContext) => Promise<PostHookResult | void> | PostHookResult | void;

// ─── Runner ─────────────────────────────────────────

export class HookRunner {
  private readonly preHooks: Array<{ name: string; handler: PreToolUseHook }> = [];
  private readonly postHooks: Array<{ name: string; handler: PostToolUseHook }> = [];

  /** PreToolUse 훅 등록 */
  registerPreHook(name: string, handler: PreToolUseHook): void {
    this.preHooks.push({ name, handler });
  }

  /** PostToolUse 훅 등록 */
  registerPostHook(name: string, handler: PostToolUseHook): void {
    this.postHooks.push({ name, handler });
  }

  /**
   * PreToolUse 훅 실행 — 순차 실행, deny 시 즉시 중단
   * @returns 최종 결과 (allow/deny/modify + 합산된 feedback)
   */
  async runPreHooks(ctx: HookContext): Promise<HookResult> {
    let currentInput = { ...ctx.toolInput };
    const feedbacks: string[] = [];
    // Copilot review fix: 기존엔 `Object.keys().length` 비교로 modify 여부를 판정해서
    // 같은 키 수의 값 변경 (e.g. {path:"/old"}→{path:"/new"}) 이 "allow" 로 분류돼
    // tool-executor.ts Step 4 에서 updatedInput 이 무시되는 silent bug 가 있었다.
    // 훅이 실제로 modify 결과를 반환했는지 explicit flag 로 추적한다.
    let modified = false;

    for (const hook of this.preHooks) {
      try {
        const result = await hook.handler({ toolName: ctx.toolName, toolInput: currentInput });

        if (result.action === "deny") {
          return { action: "deny", reason: result.reason ?? t("be_hookRunner.blockedByHook", { name: hook.name }) };
        }

        if (result.action === "modify" && result.updatedInput) {
          currentInput = result.updatedInput;
          modified = true;
        }

        if (result.feedback) {
          feedbacks.push(result.feedback);
        }
      } catch (err) {
        // 훅 실행 실패 시 경고 로그, 실행은 계속
        log.warn(`PreToolUse '${hook.name}' failed: %s`, (err as Error).message);
      }
    }

    return {
      action: modified ? "modify" : "allow",
      updatedInput: currentInput,
      feedback: feedbacks.length > 0 ? feedbacks.join("\n") : undefined,
    };
  }

  /** PostToolUse 훅 실행 — 성공/실패 양쪽 모두 postHooks 를 실행 (`ctx.isError` 로 구분 가능) */
  async runPostHooks(ctx: PostHookContext): Promise<string | undefined> {
    const feedbacks: string[] = [];

    for (const hook of this.postHooks) {
      try {
        const result = await hook.handler(ctx);
        if (result?.feedback) feedbacks.push(result.feedback);
      } catch (err) {
        log.warn(`PostToolUse '${hook.name}' failed: %s`, (err as Error).message);
      }
    }

    return feedbacks.length > 0 ? feedbacks.join("\n") : undefined;
  }

  /** 등록된 훅 수 */
  get preHookCount(): number { return this.preHooks.length; }
  get postHookCount(): number { return this.postHooks.length; }
}
