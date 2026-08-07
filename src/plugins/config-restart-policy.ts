/**
 * Single authority for "does this plugin-config write need a runtime restart?".
 *
 * Four sites share the same 3-step config-write core
 * (`settingsService.setPluginConfig` -> `pluginRuntime.setConfigOverride` ->
 * `emitPluginConfigChange`) and used to make four different restart decisions:
 *
 *   1. `lvis:plugins:config:set`        (src/ipc/domains/plugins.ts)   — always restart
 *   2. `lvis:plugins:config:secret:set` (src/ipc/domains/plugins.ts)   — never restart
 *   3. `bridge.config.set`              (src/ipc/domains/plugins.ts)   — never restart
 *   4. `hostApi.config.set`             (src/boot/steps/plugin-runtime/host-api-factory.ts)
 *                                                                     — conditional
 *
 * WHY A RESTART EXISTS AT ALL
 * ---------------------------
 * A plugin can read its configuration through four surfaces, and only ONE of
 * them goes stale on a write:
 *
 *   - `PluginRuntimeContext.config` — a SNAPSHOT built at plugin start from
 *     `configOverrides`. Goes stale on any cleartext write; only a restart
 *     rebuilds it. **This is the sole reason restart is ever needed.**
 *   - `hostApi.config.get(key)`     — reads `settingsService.getPluginConfig`
 *     live at call time. Never stale.
 *   - `hostApi.config.onChange(key)`— pushed by `emitPluginConfigChange`, which
 *     all four sites call. Never stale.
 *   - `hostApi.getSecret(key)`      — reads `settingsService.getSecret` live at
 *     call time. Never stale.
 *
 * Secrets NEVER enter `PluginRuntimeContext.config`: sites 1 and 3 run the
 * payload through `stripSecretFields`, site 4 rejects `format: "secret"` keys
 * outright, and `buildPluginConfigOverrides` (src/boot/plugins.ts) deliberately
 * injects no secret into the wildcard slot. A secret write therefore cannot
 * stale the snapshot, and restarting after one would be pure disruption.
 *
 * THE RULE
 * --------
 * Restart iff the write mutated the CLEARTEXT plugin-config record (which is
 * what staled `PluginRuntimeContext.config`) AND restarting is safe from this
 * caller. "Unsafe" is not a preference — it means the restart would destroy the
 * caller or re-enter the lifecycle mutation that is currently being awaited.
 *
 * Applying the rule to the four sites:
 *
 *   1. config:set        — mutates cleartext, caller is host IPC (safe)
 *                          -> restart. MATCHES (unchanged).
 *   2. config:secret:set — pure secret write does NOT mutate cleartext
 *                          -> no restart. MATCHES.
 *                          BUT it also deletes a stray cleartext copy of the
 *                          key when one exists, and that branch DOES mutate
 *                          cleartext with no safety hazard -> must restart.
 *                          **OUTLIER — this is the behaviour change.**
 *   3. bridge.config.set — mutates cleartext, but the caller IS the plugin
 *                          webview a restart would tear down (unsafe)
 *                          -> no restart. MATCHES (unchanged).
 *   4. hostApi.config.set— mutates cleartext; unsafe exactly when the write
 *                          comes from inside a lifecycle hook or a restart is
 *                          already pending -> conditional. MATCHES (unchanged).
 *
 * Sites 1 and 3 pin their inputs statically (always-restart / never-restart), so
 * routing them through this predicate would only add a branch that can never go
 * the other way. They carry a comment pointing here instead; sites 2 and 4 make
 * a genuine runtime decision and call this function.
 */

export interface PluginConfigWriteRestartInput {
  /**
   * True iff this write changed the cleartext `pluginConfigs` record for the
   * plugin — the record that feeds `PluginRuntimeContext.config`. A write that
   * only touched keychain-backed secrets is false.
   */
  mutatedCleartextConfig: boolean;
  /**
   * True iff restarting from this caller would destroy the caller or re-enter
   * an in-flight lifecycle mutation (nested lifecycle hook, restart already
   * pending, or a plugin webview issuing the write about itself).
   */
  restartUnsafe: boolean;
}

/**
 * The rule, as one expression. See the module doc for why each site supplies
 * the inputs it does.
 */
export function shouldRestartAfterPluginConfigWrite(
  input: PluginConfigWriteRestartInput,
): boolean {
  return input.mutatedCleartextConfig && !input.restartUnsafe;
}
