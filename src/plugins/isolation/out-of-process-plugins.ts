/**
 * Which plugins load in their own process.
 *
 * Populated one id at a time, which is how the isolated path gets exercised by
 * real plugins before an untrusted one is ever admitted to it.
 *
 * NO CONFIGURATION READS THIS. Not an environment variable, not a settings key,
 * not a manifest field. A plugin moves out-of-process when a reviewed commit
 * adds its id here, which means the move is visible in a diff and revertable by
 * a revert. An env-var switch would let the boundary change under a user with
 * no record of it, and a manifest field would let the PLUGIN choose whether it
 * is isolated — which is the one party that must not have a say.
 *
 * This is a routing decision, not a fallback: a call never retries in-process
 * when the child fails. A failed child fails the call
 * (`docs/blueprints/plugin-process-isolation.md` §9, "A note on the coexistence
 * question").
 */

/**
 * Plugin ids served by a child process instead of an in-main dynamic import.
 *
 * Frozen so an id cannot be added at runtime — the set a plugin is checked
 * against must be the set that was reviewed.
 *
 * `work-assistant` is first because it is the least entangled first-party
 * plugin, and that was measured rather than assumed. Across the six, its
 * production sources reach ten hostApi members — `callLlm`, `config.get`,
 * `config.set`, `emitEvent`, `getInstalledPluginIds`, `hasRoutineBySource`,
 * `logEvent`, `onEvent`, `onPluginsChanged`, `triggerConversation` — and none
 * of the ones whose marshalling §3.2 calls out as lossy or stateful: no
 * `getSecret`, no `hostFetch`, no `resolveApiKey`, no `spawnWorker`, no
 * `storage.*`, no auth window. It declares three tools, no `uiResources[]`, and
 * no `networkAccess`, so nothing about it depends on a grant this boundary
 * cannot express. `meeting` (32 tools, `getSecret` + `hostFetch` +
 * `resolveApiKey`) and `local-indexer` (`spawnWorker`, whose grandchild is
 * explicitly outside a plugin child's authority per §3.2) are the far end of
 * that scale and are deliberately not first.
 */
export const OUT_OF_PROCESS_PLUGIN_IDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["work-assistant"]),
);

/** Whether `pluginId` loads out-of-process. */
export function isOutOfProcessPlugin(pluginId: string): boolean {
  return OUT_OF_PROCESS_PLUGIN_IDS.has(pluginId);
}

/**
 * Whether the in-process loader still has a reason to exist.
 *
 * The removal trigger for `importPluginFactory` is a STATE, not a date: every
 * installed plugin is out-of-process. Exposing it as a predicate is what makes
 * that trigger mechanically checkable instead of a note someone has to remember.
 */
export function allPluginsAreOutOfProcess(
  installedPluginIds: readonly string[],
): boolean {
  return (
    installedPluginIds.length > 0
    && installedPluginIds.every((pluginId) => isOutOfProcessPlugin(pluginId))
  );
}
