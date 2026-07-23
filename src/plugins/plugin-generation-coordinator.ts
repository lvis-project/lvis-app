import type { MaterializedPluginContribution } from "./plugin-contributions.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface PluginGenerationIdentity {
  pluginId: string;
  pluginVersion: string;
  /** Stable signed-content identity used by contribution trust decisions. */
  artifactGenerationId: string;
  /** Unique runtime activation identity used by leases and retirement. */
  generationId: string;
  manifestSha256: string;
  receiptSha256: string;
}

/**
 * One immutable view of every plugin-owned projection. Subsystem-specific
 * objects are prepared while hidden and must never be mutated after publish.
 */
export interface ActivePluginGeneration<TState = unknown> extends PluginGenerationIdentity {
  contributions: readonly MaterializedPluginContribution[];
  state: TState;
}

export interface PluginGenerationLease<TState = unknown> {
  readonly generation: ActivePluginGeneration<TState>;
  release(): void;
}

export interface PublishedPluginGenerationTransition {
  /** Completes after predecessor leases drain and exact-generation cleanup finishes. */
  readonly retired: Promise<void>;
}

interface GenerationState<TState> {
  active?: ActivePluginGeneration<TState>;
  pendingTransitions: number;
  transitionWaiters: Array<() => void>;
  leaseCounts: Map<string, number>;
  drainWaiters: Map<string, Array<() => void>>;
  transitionTail: Promise<void>;
}

function freezeGeneration<TState>(candidate: ActivePluginGeneration<TState>): ActivePluginGeneration<TState> {
  if (!candidate.pluginId || !candidate.pluginVersion || !candidate.generationId) {
    throw new Error("plugin generation identity must be complete");
  }
  if (
    !/^[a-f0-9]{64}$/.test(candidate.artifactGenerationId) ||
    !/^[a-f0-9]{64}$/.test(candidate.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(candidate.receiptSha256)
  ) {
    throw new Error("plugin generation artifact, manifest, and receipt identities must be SHA-256 digests");
  }
  return Object.freeze({
    ...candidate,
    contributions: Object.freeze([...candidate.contributions]),
  });
}

/**
 * Owns the in-process linearization seam for plugin generations.
 *
 * Candidate construction happens before `commit`. `durableCommit` is the last
 * fallible pre-linearization operation. Once it resolves, publishing is one
 * synchronous pointer assignment; retirement happens only after old leases
 * drain. This class deliberately performs no filesystem or provider work.
 */
export class PluginGenerationCoordinator<TState = unknown> {
  private readonly plugins = new Map<string, GenerationState<TState>>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly admittedGenerations = new AsyncLocalStorage<
    ReadonlyMap<string, ActivePluginGeneration<TState>>
  >();

  private stateFor(pluginId: string): GenerationState<TState> {
    let state = this.plugins.get(pluginId);
    if (!state) {
      state = {
        pendingTransitions: 0,
        transitionWaiters: [],
        leaseCounts: new Map(),
        drainWaiters: new Map(),
        transitionTail: Promise.resolve(),
      };
      this.plugins.set(pluginId, state);
    }
    return state;
  }

  getActive(pluginId: string): ActivePluginGeneration<TState> | undefined {
    return this.stateFor(pluginId).active;
  }

  listActive(): readonly ActivePluginGeneration<TState>[] {
    return Object.freeze(
      [...this.plugins.values()]
        .map((state) => state.active)
        .filter((generation): generation is ActivePluginGeneration<TState> => Boolean(generation)),
    );
  }

  async acquire(pluginId: string): Promise<PluginGenerationLease<TState>> {
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    if (admitted) {
      return Object.freeze({ generation: admitted, release: () => undefined });
    }
    const state = this.stateFor(pluginId);
    while (state.pendingTransitions > 0) {
      await new Promise<void>((resolve) => state.transitionWaiters.push(resolve));
    }
    const generation = state.active;
    if (!generation) throw new Error(`plugin '${pluginId}' has no active generation`);
    state.leaseCounts.set(generation.generationId, (state.leaseCounts.get(generation.generationId) ?? 0) + 1);
    let released = false;
    return Object.freeze({
      generation,
      release: () => {
        if (released) return;
        released = true;
        const next = (state.leaseCounts.get(generation.generationId) ?? 1) - 1;
        if (next > 0) {
          state.leaseCounts.set(generation.generationId, next);
          return;
        }
        state.leaseCounts.delete(generation.generationId);
        for (const resolve of state.drainWaiters.get(generation.generationId) ?? []) resolve();
        state.drainWaiters.delete(generation.generationId);
      },
    });
  }

  async acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<TState>> {
    const admitted = this.admittedGenerations.getStore()?.get(pluginId);
    if (admitted) {
      if (admitted.generationId !== generationId) {
        throw new Error(`plugin '${pluginId}' generation '${generationId}' is not admitted`);
      }
      return Object.freeze({ generation: admitted, release: () => undefined });
    }
    const lease = await this.acquire(pluginId);
    if (lease.generation.generationId === generationId) return lease;
    lease.release();
    throw new Error(`plugin '${pluginId}' generation '${generationId}' is not active`);
  }

  /**
   * Carry one already-counted lease through approval, Hook, runtime, MCP, and
   * audit awaits. Nested exact acquisitions reuse the admitted immutable view,
   * including after the active pointer advances, so an invocation can never
   * switch generations midway through its pipeline.
   */
  runWithLease<T>(
    lease: PluginGenerationLease<TState>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const next = new Map(this.admittedGenerations.getStore() ?? []);
    next.set(lease.generation.pluginId, lease.generation);
    return this.admittedGenerations.run(
      Object.freeze(next) as ReadonlyMap<string, ActivePluginGeneration<TState>>,
      operation,
    );
  }

  async commit(
    candidate: ActivePluginGeneration<TState> | undefined,
    durableCommit: () => Promise<void>,
    retire?: (predecessor: ActivePluginGeneration<TState>) => Promise<void>,
    pluginId = candidate?.pluginId,
    publish: () => void = () => undefined,
  ): Promise<PublishedPluginGenerationTransition> {
    if (!pluginId) throw new Error("pluginId is required for an inactive generation transition");
    if (candidate && candidate.pluginId !== pluginId) throw new Error("candidate plugin identity mismatch");
    const prepared = candidate ? freezeGeneration(candidate) : undefined;
    const state = this.stateFor(pluginId);

    const priorTail = state.transitionTail;
    let releaseTail!: () => void;
    state.transitionTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    // Close the admission barrier synchronously. An acquire requested in the
    // same turn must not slip into the predecessor while this transition waits
    // for its serialized durable-commit slot.
    state.pendingTransitions += 1;
    await priorTail;

    let predecessor: ActivePluginGeneration<TState> | undefined;
    try {
      try {
        predecessor = state.active;
        await durableCommit();
        // Linearization point: durable state and the immutable generation
        // pointer are now inseparable. No projection work may be inserted here.
        state.active = prepared;
        // Synchronous in-process projections publish in the same turn as the
        // pointer assignment. Every publication closure was fully prepared and
        // is assignment-only; the admission barrier remains closed throughout.
        publish();
      } finally {
        state.pendingTransitions -= 1;
        if (state.pendingTransitions === 0) {
          for (const resolve of state.transitionWaiters.splice(0)) resolve();
        }
      }

    } finally {
      releaseTail();
    }
    const retired = predecessor && predecessor.generationId !== prepared?.generationId
      ? (async () => {
          await this.waitForDrain(state, predecessor.generationId);
          await retire?.(predecessor);
        })()
      : Promise.resolve();
    this.retirements.add(retired);
    void retired.finally(() => this.retirements.delete(retired)).catch(() => undefined);
    return Object.freeze({ retired });
  }

  /**
   * Run an in-place projection transition for the current immutable runtime
   * generation. New admissions are blocked and every already-admitted lease is
   * drained before `publish` runs, so resources may be hidden or re-exposed
   * without replacing (and therefore stopping) the runtime instance.
   */
  async quiesce(
    pluginId: string,
    expectedGenerationId: string,
    prepare: () => Promise<void>,
    publish: () => void,
  ): Promise<void> {
    const state = this.stateFor(pluginId);
    const priorTail = state.transitionTail;
    let releaseTail!: () => void;
    state.transitionTail = new Promise<void>((resolve) => { releaseTail = resolve; });
    state.pendingTransitions += 1;
    await priorTail;

    try {
      try {
        const active = state.active;
        if (!active || active.generationId !== expectedGenerationId) {
          throw new Error(`plugin '${pluginId}' generation changed before projection transition`);
        }
        await this.waitForDrain(state, expectedGenerationId);
        await prepare();
        publish();
      } finally {
        state.pendingTransitions -= 1;
        if (state.pendingTransitions === 0) {
          for (const resolve of state.transitionWaiters.splice(0)) resolve();
        }
      }
    } finally {
      releaseTail();
    }
  }

  async waitForRetirements(): Promise<void> {
    await Promise.all([...this.retirements]);
  }

  private async waitForDrain(state: GenerationState<TState>, generationId: string): Promise<void> {
    if ((state.leaseCounts.get(generationId) ?? 0) === 0) return;
    await new Promise<void>((resolve) => {
      const waiters = state.drainWaiters.get(generationId) ?? [];
      waiters.push(resolve);
      state.drainWaiters.set(generationId, waiters);
    });
  }
}
