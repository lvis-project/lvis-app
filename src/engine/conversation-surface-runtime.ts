/**
 * Host-owned composition for the active main conversation's surface adapters.
 *
 * This is intentionally created once by the Electron main-process composition
 * root, then injected into every local transport. It is not an AppService yet:
 * the existing app has one mutable ConversationLoop, and this focused seam lets
 * us unify its display/command paths before moving broader boot ownership.
 */
import {
  createConversationActivityCoordinator,
  type ConversationActivityCoordinator,
} from "./conversation-activity-coordinator.js";
import {
  createConversationTurnRegistry,
  type ConversationTurnRegistry,
} from "./conversation-turn-registry.js";
import {
  createSharedConversationProjectionStore,
  type SharedConversationProjectionStore,
} from "./shared-conversation-projection.js";
import {
  createPlatformConversationTimeline,
  type PlatformConversationTimeline,
} from "./conversation-platform-protocol.js";

export interface ConversationSurfaceRuntime {
  /** Ordered, semantic event source for every platform surface adapter. */
  readonly timeline: PlatformConversationTimeline;
  /** Derived safe state used only by explicitly authorized shared surfaces. */
  readonly sharedProjection: SharedConversationProjectionStore;
  /** One shared lease and compatibility correlation-id allocator for the active main loop. */
  readonly activity: ConversationActivityCoordinator;
  /** Live public-turn ownership; only a matching host actor/share can cancel. */
  readonly turns: ConversationTurnRegistry;
}

/** Create one main-process runtime for Electron, Local API, and future adapters. */
export function createConversationSurfaceRuntime(): ConversationSurfaceRuntime {
  const timeline = createPlatformConversationTimeline();
  const sharedProjection = createSharedConversationProjectionStore(timeline);
  // Runtime ownership prevents one optional transport from silencing another.
  sharedProjection.start();
  return {
    timeline,
    sharedProjection,
    activity: createConversationActivityCoordinator(),
    turns: createConversationTurnRegistry(),
  };
}
