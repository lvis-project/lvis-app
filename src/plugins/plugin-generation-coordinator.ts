import type { MaterializedPluginContribution } from "./plugin-contributions.js";

export interface PluginGenerationIdentity {
  pluginId: string;
  pluginVersion: string;
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
  if (!/^[a-f0-9]{64}$/.test(candidate.manifestSha256) || !/^[a-f0-9]{64}$/.test(candidate.receiptSha256)) {
    throw new Error("plugin generation manifest and receipt identities must be SHA-256 digests");
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

  async acquire(pluginId: string): Promise<PluginGenerationLease<TState>> {
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

  async commit(
    candidate: ActivePluginGeneration<TState> | undefined,
    durableCommit: () => Promise<void>,
    retire?: (predecessor: ActivePluginGeneration<TState>) => Promise<void>,
    pluginId = candidate?.pluginId,
  ): Promise<void> {
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
        // Linearization point: no fallible work may be inserted between the
        // durable commit above and this preallocated pointer assignment.
        state.active = prepared;
      } finally {
        state.pendingTransitions -= 1;
        if (state.pendingTransitions === 0) {
          for (const resolve of state.transitionWaiters.splice(0)) resolve();
        }
      }

      if (predecessor && predecessor.generationId !== prepared?.generationId) {
        await this.waitForDrain(state, predecessor.generationId);
        await retire?.(predecessor);
      }
    } finally {
      releaseTail();
    }
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
