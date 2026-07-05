




import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
const log = createLogger("hook");

// ─── Types ──────────────────────────────────────────

export interface HookContext {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface HookResult {

  action: "allow" | "deny" | "modify";

  reason?: string;

  updatedInput?: Record<string, unknown>;

  feedback?: string;
}

export interface PostHookContext extends HookContext {
  toolOutput: string;
  isError: boolean;
}

export interface PostHookResult {

  feedback?: string;
}

export type PreToolUseHook = (ctx: HookContext) => Promise<HookResult> | HookResult;
export type PostToolUseHook = (ctx: PostHookContext) => Promise<PostHookResult | void> | PostHookResult | void;

// ─── Runner ─────────────────────────────────────────

export class HookRunner {
  private readonly preHooks: Array<{ name: string; handler: PreToolUseHook }> = [];
  private readonly postHooks: Array<{ name: string; handler: PostToolUseHook }> = [];


  registerPreHook(name: string, handler: PreToolUseHook): void {
    this.preHooks.push({ name, handler });
  }


  registerPostHook(name: string, handler: PostToolUseHook): void {
    this.postHooks.push({ name, handler });
  }




  async runPreHooks(ctx: HookContext): Promise<HookResult> {
    let currentInput = { ...ctx.toolInput };
    const feedbacks: string[] = [];


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

        log.warn(`PreToolUse '${hook.name}' failed: %s`, (err as Error).message);
      }
    }

    return {
      action: modified ? "modify" : "allow",
      updatedInput: currentInput,
      feedback: feedbacks.length > 0 ? feedbacks.join("\n") : undefined,
    };
  }


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


  get preHookCount(): number { return this.preHooks.length; }
  get postHookCount(): number { return this.postHooks.length; }
}
