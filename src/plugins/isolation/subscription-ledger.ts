/**
 * The two-sided lifetime primitive shared by every hostApi member that outlives
 * its own reply (`docs/blueprints/plugin-process-isolation.md` §3.1, §9).
 *
 * Four members hand the plugin a disposer — `onEvent`, `config.onChange`,
 * `onPluginsChanged` and `onShutdown` — and two more hand it a live handle
 * (`spawnWorker`, `resolveApiKey`). In one heap that costs nothing: the closure
 * and the thing it disposes are the same objects, and when the plugin is
 * collected so is the registration. Across a process boundary they are two
 * independent registrations in two independent heaps, and there are FOUR ways
 * to end, not one:
 *
 *   1. the child disposes            → the host must be told, or the host leaks;
 *   2. the child dies without disposing → the host must release anyway;
 *   3. the host revokes (plugin retired) → the child must drop its handler, or
 *      the child leaks a closure over the whole plugin instance;
 *   4. the host dies                 → the child must drop its handler AND must
 *      NOT try to tell anyone.
 *
 * Case 4 is why {@link SubscriptionCloseReason} reaches the release callback:
 * a release that always notifies turns case 3 into a ping-pong and case 4 into
 * a write on a closed pipe. Handlers do not each decide this — they call
 * `close`/`end` with the reason and the release reads it.
 *
 * This is deliberately ONE mechanism rather than six. Six handlers inventing
 * six lifetimes is six chances to leak, and a leak here is invisible: everything
 * keeps working, memory grows, and a retired plugin's callbacks keep firing.
 */
import { randomUUID } from "node:crypto";
import type { SubscriptionCloseReason } from "./host-api-wire.js";

/**
 * What to run when one registration ends. Called EXACTLY once per registration.
 * `reason` decides whether the peer still needs to be told; `subscriptionId` is
 * passed rather than closed over so a caller that lets the ledger ALLOCATE the
 * id can still name it in the message it sends.
 */
export type SubscriptionRelease<T> = (
  value: T,
  reason: SubscriptionCloseReason,
  subscriptionId: string,
) => void;

interface LedgerEntry<T> {
  readonly value: T;
  readonly release: SubscriptionRelease<T>;
}

/** Thrown when a registration is opened on a ledger whose peer is already gone. */
export class SubscriptionLedgerEndedError extends Error {
  constructor(label: string, subscriptionId: string) {
    super(
      `[${label}] cannot open subscription '${subscriptionId}': the ledger has ended`,
    );
    this.name = "SubscriptionLedgerEndedError";
  }
}

/** Thrown when an id is registered twice. A silent overwrite would drop a release. */
export class DuplicateSubscriptionError extends Error {
  constructor(label: string, subscriptionId: string) {
    super(`[${label}] subscription '${subscriptionId}' is already open`);
    this.name = "DuplicateSubscriptionError";
  }
}

/**
 * One side's registry of live registrations. The host owns one per plugin
 * incarnation; the child owns one per process. They are the same class because
 * the obligations are symmetric — only the release callbacks differ.
 */
export class SubscriptionLedger<T> {
  private readonly entries = new Map<string, LedgerEntry<T>>();
  private ended = false;

  /**
   * @param label Prefix for the errors this ledger throws, so a failure names
   *   the side it happened on rather than "a ledger somewhere".
   */
  constructor(private readonly label: string) {}

  /** Live registrations. The number a leak test asserts is zero. */
  get openCount(): number {
    return this.entries.size;
  }

  /** True once the peer is gone and no further registration may be opened. */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Register under a HOST-ALLOCATED id and return it (handles, leases). */
  open(value: T, release: SubscriptionRelease<T>): string {
    const subscriptionId = randomUUID();
    this.adopt(subscriptionId, value, release);
    return subscriptionId;
  }

  /**
   * Register under an id the PEER allocated (a subscription the child opened).
   *
   * Child-allocated ids remove the race that host-allocated ones create: the
   * child must have its handler registered before the first event can arrive,
   * and if it waited for a reply to learn the id there would be a window where
   * an event has nowhere to go. A colliding id is refused loudly rather than
   * overwriting a registration whose release would then never run.
   */
  adopt(subscriptionId: string, value: T, release: SubscriptionRelease<T>): void {
    if (this.ended) {
      throw new SubscriptionLedgerEndedError(this.label, subscriptionId);
    }
    if (this.entries.has(subscriptionId)) {
      throw new DuplicateSubscriptionError(this.label, subscriptionId);
    }
    this.entries.set(subscriptionId, { value, release });
  }

  /** The registered value, or `undefined` when nothing is open under that id. */
  get(subscriptionId: string): T | undefined {
    return this.entries.get(subscriptionId)?.value;
  }

  /**
   * End ONE registration. Idempotent by construction: the entry is removed
   * BEFORE its release runs, so a release that re-enters `close` (a disposer
   * that disposes itself) finds nothing and returns `false` instead of running
   * the release twice.
   *
   * @returns whether a registration was actually ended.
   */
  close(subscriptionId: string, reason: SubscriptionCloseReason): boolean {
    const entry = this.entries.get(subscriptionId);
    if (!entry) return false;
    this.entries.delete(subscriptionId);
    entry.release(entry.value, reason, subscriptionId);
    return true;
  }

  /**
   * End EVERY registration and refuse further ones. This is what each side
   * calls when its peer dies — the child on transport close, the host on child
   * exit — and it is the half that makes "leaks on neither side" true rather
   * than aspirational.
   *
   * @returns how many registrations were ended.
   */
  end(reason: SubscriptionCloseReason): number {
    this.ended = true;
    let closed = 0;
    // Snapshot: a release may open nothing (the ledger has ended) but may still
    // close siblings, so iterating the live map would be iterating under mutation.
    for (const subscriptionId of [...this.entries.keys()]) {
      if (this.close(subscriptionId, reason)) closed += 1;
    }
    return closed;
  }
}
