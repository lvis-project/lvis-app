/**
 * Q12 Phase 4 — Layer 6 hook TOFU IPC bridge.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Boot-time orchestration needs to **await** the user's per-file accept /
 * reject decision before declaring the hook system ready, but the
 * decision arrives through IPC from the renderer (HookTrustModal).
 * This module is a thin promise registry that lets the boot pipeline
 * register a pending request, the renderer resolve it, and a single
 * timeout reject it (so a stuck UI doesn't pin the boot indefinitely).
 *
 * Atomic cutover (CLAUDE.md No-Fallback):
 *   - On reject / timeout, the boot wiring applies strict-deny — the
 *     resolver throws, hook-trust-prompt's outer try/catch turns that
 *     into "all rejected → all moved to .disabled/".
 */
import type { HookDiff } from "./hook-discovery.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("hook-trust-resolver");

export interface PendingTrustRequest {
  id: string;
  diff: HookDiff[];
  resolve(decisions: Array<{ fileName: string; trust: boolean }>): void;
  reject(err: Error): void;
}

export interface PendingTrustView {
  id: string;
  files: Array<{ fileName: string; state: HookDiff["state"]; previousSha256?: string; sha256: string }>;
}

class HookTrustResolverRegistry {
  private pending: PendingTrustRequest | null = null;
  private nextId = 1;

  /**
   * Register a new pending request. Returns the id the renderer should
   * use when calling back. Caller awaits the returned promise.
   *
   * Single-flight: a second registerRequest before the first resolves
   * rejects the first with "superseded" — boot only ever has one
   * outstanding TOFU prompt.
   */
  registerRequest(diff: HookDiff[]): {
    id: string;
    promise: Promise<Array<{ fileName: string; trust: boolean }>>;
  } {
    if (this.pending) {
      log.warn("hook-trust: superseding stale pending request id=%s", this.pending.id);
      this.pending.reject(new Error("superseded by newer trust request"));
      this.pending = null;
    }
    const id = `tr-${this.nextId++}-${Date.now()}`;
    let resolveFn: PendingTrustRequest["resolve"];
    let rejectFn: PendingTrustRequest["reject"];
    const promise = new Promise<Array<{ fileName: string; trust: boolean }>>(
      (resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      },
    );
    this.pending = { id, diff, resolve: resolveFn!, reject: rejectFn! };
    return { id, promise };
  }

  /**
   * Renderer-side accept: marks the named files as trusted. Files in
   * the pending diff but not listed in `fileNames` are treated as
   * implicit reject.
   */
  acceptFiles(id: string, fileNames: string[]): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    const trustedSet = new Set(fileNames);
    const decisions = this.pending.diff.map((d) => ({
      fileName: d.hook.fileName,
      trust: trustedSet.has(d.hook.fileName),
    }));
    this.pending.resolve(decisions);
    this.pending = null;
    return true;
  }

  /**
   * Renderer-side reject: marks everything as untrusted (auto-disable).
   */
  rejectAll(id: string): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    const decisions = this.pending.diff.map((d) => ({
      fileName: d.hook.fileName,
      trust: false,
    }));
    this.pending.resolve(decisions);
    this.pending = null;
    return true;
  }

  /** View of the current pending request (for late-mount renderers). */
  current(): PendingTrustView | null {
    if (!this.pending) return null;
    return {
      id: this.pending.id,
      files: this.pending.diff.map((d) => ({
        fileName: d.hook.fileName,
        state: d.state,
        sha256: d.hook.sha256,
        previousSha256: d.previousSha256,
      })),
    };
  }

  /** Test helper. */
  resetForTests(): void {
    if (this.pending) {
      try {
        this.pending.reject(new Error("registry reset"));
      } catch {
        /* ignore */
      }
    }
    this.pending = null;
    this.nextId = 1;
  }
}

/** Process-wide singleton. */
export const hookTrustResolverRegistry = new HookTrustResolverRegistry();
