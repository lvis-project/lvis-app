import type { PublishedPluginGenerationTransition } from "./plugin-generation-coordinator.js";
import type { CommittedPluginGeneration } from "./plugin-host-generation.js";

/** A generation committed durably but failed synchronous in-process publication. */
export class CommittedPluginGenerationPublicationError<T = unknown> extends Error {
  readonly code = "PLUGIN_GENERATION_PUBLICATION_FAILED_AFTER_COMMIT";
  readonly outcome:
    | Readonly<{ state: "active"; generationId: string }>
    | Readonly<{ state: "inactive" }>;

  constructor(
    readonly pluginId: string,
    readonly generationId: string | undefined,
    readonly publicationCause: unknown,
    readonly transition: PublishedPluginGenerationTransition,
    readonly committed?: CommittedPluginGeneration<T>,
  ) {
    super(
      generationId
        ? `plugin '${pluginId}' generation '${generationId}' publication failed after durable commit`
        : `plugin '${pluginId}' inactive generation publication failed after durable commit`,
      { cause: publicationCause },
    );
    this.name = "CommittedPluginGenerationPublicationError";
    this.outcome = generationId
      ? Object.freeze({ state: "active", generationId })
      : Object.freeze({ state: "inactive" });
  }

  withCommitted<TResult>(
    committed: CommittedPluginGeneration<TResult>,
  ): CommittedPluginGenerationPublicationError<TResult> {
    return new CommittedPluginGenerationPublicationError(
      this.pluginId,
      this.generationId,
      this.publicationCause,
      this.transition,
      committed,
    );
  }
}

export function isCommittedPluginGenerationPublicationError(
  error: unknown,
): error is CommittedPluginGenerationPublicationError {
  return error instanceof CommittedPluginGenerationPublicationError;
}
