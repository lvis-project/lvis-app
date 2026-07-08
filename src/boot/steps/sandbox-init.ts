



import { app } from "electron";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function initSandboxGate(ctx: BootContext): Promise<void> {
  const { settingsService, bootAuditLogger, pluginRuntime, buildSandboxUnionDomains } = ctx;

  // Platform policy (ALL platforms share the SAME gate — there is no separate
  // Windows opt-in):
  //   - macOS / Linux: initialize ASRT when the gate is on and deps are present.
  //     If the gate is on but `checkDependencies()` reports errors (Linux: bwrap
  //     / socat / ripgrep missing) the branch depends on the on-signal: the
  //     EXPLICIT env opt-in FAIL-CLOSES (THROW, no unsandboxed plain spawn —
  //     no-fallback rule), while the DEFAULT/settings-on path DEGRADES gracefully
  //     (loud warn + unsandboxed, non-bricking). A throw on the staged default
  //     path would brick hosts before they can repair missing deps.
  //   - Windows (srt-win.exe): filesystem + network sandbox (dedicated
  //     `srt-sandbox` user ACL backend + WFP; no process isolation). srt-win is
  //     BUNDLED (asarUnpack vendor/**), so there is no download — but it needs a
  //     one-time UAC install before the sandbox user and WFP filter set are ready.
  //     Windows does NOT hard-throw on deps-missing: a throw would BRICK the
  //     first run (the user cannot complete the install before boot even
  //     reaches the prompt). Instead we keep `isAsrtSandboxActive()` FALSE (host
  //     shell tools run UNSANDBOXED — isolation=none) and emit a LOUD signal so
  //     the gap is visible. When win32 IS ready → initialize ASRT normally and
  //     publish a PARTIAL capability (filesystem + network, process=false).
  {
    const { initializeAsrtSandbox, checkAsrtDependencies } = await import(
      "../../permissions/asrt-sandbox.js"
    );
    const { setActiveSandboxCapability } = await import(
      "../../permissions/sandbox-capability.js"
    );
    const { sandboxConfinementForPlatform } = await import(
      "../../shared/sandbox-capability-info.js"
    );
    const { decideSandboxGate, shouldWarnHostClassifyInterlock } = await import(
      "./sandbox-gate.js"
    );

    // Two independent on-signals. `explicitEnv` (LVIS_SANDBOX_ENABLED=1) is the
    // deliberate "I really mean it" override; `settingOn` is the shipped default
    // (now true) / Settings toggle. The DISTINCTION drives degrade-vs-abort: see
    // decideSandboxGate.
    const explicitEnv = process.env["LVIS_SANDBOX_ENABLED"] === "1";
    const settingOn = settingsService.get("features")?.osToolSandbox ?? false;
    const sandboxOptIn = settingOn || explicitEnv;

    // Activation telemetry — which on-signal drove the gate. ONE event per boot
    // is emitted (below) at the terminal outcome so real-world activate/degrade/
    // abort/skip rates can be monitored before the Linux/Windows osToolSandbox
    // default is flipped on (the staged rollout). explicit-env takes precedence
    // (it is the fail-closed signal); else the default/settings flag; else off.
    const sandboxGateOnSignal: "explicit-env" | "default-settings" | "off" =
      explicitEnv ? "explicit-env" : settingOn ? "default-settings" : "off";

    // Tracks whether ASRT genuinely activated this boot. The interlock warning
    // below keys on THIS (not on `sandboxOptIn`), so the degraded path (gate ON,
    // sandbox inactive) still fires it. See shouldWarnHostClassifyInterlock.
    let sandboxActive = false;

    if (sandboxOptIn) {
      const deps = await checkAsrtDependencies();
      const decision = decideSandboxGate({
        settingOn,
        explicitEnv,
        platform: process.platform,
        depsOk: deps.errors.length === 0,
      });

      if (decision.action === "abort") {
        // EXPLICIT opt-in (LVIS_SANDBOX_ENABLED=1) on mac/linux + the sandbox
        // cannot activate (bwrap/socat/ripgrep missing). The operator demanded
        // the sandbox by name; the no-fallback rule forbids silently dropping to
        // an unsandboxed plain spawn — that would honor the opt-in name while
        // delivering isolation=none. Throw so boot aborts loudly. Reachable ONLY
        // for the explicit env opt-in: the DEFAULT/settings-on path degrades
        // instead (decideSandboxGate), and Windows never aborts (a throw would
        // brick first-run before the install can happen).
        const message =
          "boot: OS tool sandbox is ON via LVIS_SANDBOX_ENABLED=1 but its dependencies are missing — refusing to start. " +
          "Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) or unset LVIS_SANDBOX_ENABLED. " +
          `Missing: ${deps.errors.join("; ")}`;
        log.error(message);
        bootAuditLogger.logSandboxGate({
          platform: process.platform,
          onSignal: sandboxGateOnSignal,
          outcome: "abort",
          reason: decision.reason,
        });
        throw new Error(message);
      } else if (decision.action === "degrade") {
        // DEFAULT / settings-on (NOT the explicit env) + the sandbox cannot
        // activate (Linux deps missing, or Windows srt-win not installed).
        // GRACEFUL, non-bricking: keep the sandbox INACTIVE (isAsrtSandboxActive()
        // stays false → host shell tools run via the plain spawn path,
        // isolation=none) and never publish a capability, so the reviewer/UI SOT
        // honestly reports kind="none". This is the SAME runtime posture as
        // sandbox-OFF, a known-safe state. We do NOT abort on staged/default
        // settings paths: a host missing deps must degrade, not brick. LOUD on
        // purpose so the gap is never silent. (Set LVIS_SANDBOX_ENABLED=1 to
        // make mac/linux fail-closed instead.)
        const detail = deps.errors.join("; ");
        if (process.platform === "win32") {
          log.warn(
            "boot: OS tool sandbox is ON but the Windows sandbox (srt-win) is NOT ready — " +
              "tools run with NO OS isolation until setup completes. " +
              "Complete the one-time administrator install, then restart the app. " +
              "Windows confines filesystem + network, but not process isolation. " +
              `Detail: ${detail}`,
          );
        } else {
          log.warn(
            "boot: OS tool sandbox is ON by default but its dependencies are missing — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) until the deps are installed. " +
              "Install the sandbox dependencies (Linux: bwrap, socat, ripgrep) to activate it, or turn it off " +
      "in Settings → Permissions 'OS tool sandbox'. (Set LVIS_SANDBOX_ENABLED=1 to make this fail-closed instead.) " +
              `Missing: ${detail}`,
          );
        }
        bootAuditLogger.logSandboxGate({
          platform: process.platform,
          onSignal: sandboxGateOnSignal,
          outcome: "degrade",
          reason: decision.reason,
        });
      } else {
        // decision.action === "activate" — deps present, initialize ASRT. Wrapped
        // so a runtime init FAILURE degrades-or-aborts by the SAME explicit-vs-
        // default rule (see the catch below), not an unconditional boot abort.
        try {
          if (deps.warnings.length > 0) {
            log.warn("boot: ASRT dependency warnings: %s", deps.warnings.join("; "));
          }
          // ENFORCED network model (corrects WIRING-A #1356 — see asrt-sandbox.ts
          // NETWORK ENFORCEMENT MODEL header). ASRT's filterNetworkRequest
          // reads ONLY the SHARED config; the per-command customConfig.network is
          // inert for allow/deny. So we set the SHARED config here to:
          //   strictAllowlist: true  ⇒ GLOBAL hard-deny on any out-of-allow-list
          //                            host, with NO askCb fallthrough (strict
          //                            bypasses the callback entirely). The
          //                            WIRING-A interactive askCb prompt cannot
          //                            coexist with strict and is removed.
          //   allowedDomains: UNION  ⇒ every loaded, host-validated plugin's
          //                            manifest.networkAccess.allowedDomains
          //                            (∪ an optional trusted host baseline,
          //                            empty by default). Computed from the
          //                            trusted plugin-runtime seam.
          // Because filterNetworkRequest reads this shared config, egress is
          // genuinely ENFORCED for BOTH workers and host tools.
          //
          // TRADE-OFF (honest): this is a UNION allow-list, not per-worker
          // isolation — a sandboxed process may reach any domain declared by ANY
          // loaded plugin. Acceptable under LVIS's 1st-party plugin trust model;
          // true per-worker isolation needs a future ASRT with per-process
          // proxies. See asrt-sandbox.ts header.
          //
          // Manifests are already loaded here (this block runs AFTER
          // initPluginRuntime), so the union is computed once at init — no
          // deferred updateConfig needed.
          //
          // Build the enforced allow-list via the SAME builder the live-refresh
          // closure uses (buildSandboxUnionDomains): manifest UNION ∪ host-
          // resolved DYNAMIC endpoint hostnames (user-configured vendor baseUrls
          // a worker reaches — e.g. local-indexer's Azure OpenAI resource, whose
          // null manifest networkAccess contributes nothing static and would be
          // hard-denied without this). Trusted host baseline stays empty.
          // normalizeUnionForAsrt (inside the builder) emits both `d` and `*.d`
          // so the sandbox enforces the SAME hosts the hostFetch path advertises.
          // Plugin count for the log — buildSandboxUnionDomains computes the
          // actual union internally; this one-liner only supplies the count.
          const manifestAllowLists = pluginRuntime
            .listPluginIds()
            .map((id) => pluginRuntime.getPluginManifest(id)?.networkAccess?.allowedDomains ?? []);
          const unionAllowedDomains = await buildSandboxUnionDomains();
          // Trust boundary: WEAKENING flags are NOT set here (deny-by-default,
          // no Apple events / weaker isolation / unix-socket opening). Only the
          // enforced allow-list + strict flag. Per-command filesystem scoping
          // (write-jail + HOME read-deny) is applied at the call site via the
          // narrow `filesystem` option, never here as a weakening channel.
          await initializeAsrtSandbox({
            allowedDomains: unionAllowedDomains,
            strictAllowlist: true,
            // Thread the REAL Electron userData path so the deny-list is exact
            // (handles --user-data-dir, XDG_CONFIG_HOME, future renames).
            // Safe: boot.ts is main-process only and already imports electron.
            userDataDir: app.getPath("userData"),
          });
          // Publish the active capability to the SOT now that ASRT is
          // genuinely initialized (gate ON, deps present). detectSandboxCapability
          // + the reviewer/UI consumers read this; the reviewer's per-category
          // relaxation (sandboxRelaxesCategory) reads the `confines` we publish
          // here. When the gate is OFF — or on the Windows-not-ready / mac-linux
          // deps-missing paths above where ASRT is NOT initialized — we never
          // call this, so the SOT stays kind="none" (isolation=none), matching
          // reality.
          //
          // Per-platform confinement (HONEST, not hardcoded full):
          //   - macOS (Seatbelt) / Linux (bwrap): full — fs + process + network.
          //   - Windows (srt-win): partial — filesystem + network, no process.
          const asrtBackend =
            process.platform === "darwin"
              ? "Seatbelt"
              : process.platform === "win32"
                ? "srt-win"
                : "bwrap";
          const confinementKind = process.platform === "win32" ? "partial" : "full";
          const confines = sandboxConfinementForPlatform(
            process.platform,
            confinementKind,
          );
          const reason =
            process.platform === "win32"
              ? `ASRT (${asrtBackend}) active — filesystem + network contained, process isolation unavailable`
              : `ASRT (${asrtBackend}) active — fs+process+network contained`;
          setActiveSandboxCapability({
            kind: "asrt",
            confidence: "verified",
            platform: process.platform,
            reason,
            // Machine-checkable confinement for the host-shell substrate. Full
            // on mac/linux; partial on Windows — see sandboxConfinementForPlatform.
            confines,
          });
          log.info(
            "boot: ASRT OS tool sandbox initialized (%s, %s, strict allow-list enforced, %d union domains across %d plugins)",
            process.platform,
            asrtBackend,
            unionAllowedDomains.length,
            manifestAllowLists.length,
          );
          sandboxActive = true;
          bootAuditLogger.logSandboxGate({
            platform: process.platform,
            onSignal: sandboxGateOnSignal,
            outcome: "activate",
            reason: decision.reason,
          });
        } catch (initErr) {
          // Init FAILURE (initializeAsrtSandbox threw despite deps present) is the
          // SAME "cannot activate" condition as deps-missing — re-decide with
          // depsOk:false so the explicit-vs-default branch lives in one place.
          // initializeAsrtSandbox flips its active flag ONLY on success, so a
          // throw leaves isAsrtSandboxActive() false and no capability published.
          const failDecision = decideSandboxGate({
            settingOn,
            explicitEnv,
            platform: process.platform,
            depsOk: false,
          });
          const cause = initErr instanceof Error ? initErr.message : String(initErr);
          if (failDecision.action === "abort") {
            // EXPLICIT opt-in — fail-closed even on init failure.
            log.error(
              "boot: OS tool sandbox is ON via LVIS_SANDBOX_ENABLED=1 but ASRT initialization failed — refusing to start. " +
                `Cause: ${cause}`,
            );
            bootAuditLogger.logSandboxGate({
              platform: process.platform,
              onSignal: sandboxGateOnSignal,
              outcome: "abort",
              reason: failDecision.reason,
            });
            throw initErr;
          }
          // DEFAULT / settings-on (or Windows) — GRACEFUL degrade, non-bricking.
          log.warn(
            "boot: OS tool sandbox is ON by default but ASRT initialization failed — " +
              "tools run with NO OS isolation (unsandboxed, isolation=none) this session. " +
              "(Set LVIS_SANDBOX_ENABLED=1 to make this fail-closed instead.) " +
              `Cause: ${cause}`,
          );
          bootAuditLogger.logSandboxGate({
            platform: process.platform,
            onSignal: sandboxGateOnSignal,
            outcome: "degrade",
            reason: failDecision.reason,
          });
          // sandboxActive stays false.
        }
      }
    } else {
      // Gate OFF (neither on-signal set) → skip. On the staged rollout this is
      // the Linux/Windows default-off path. Log the enable hint on darwin (where
      // off is now a deliberate opt-out); emit the skip telemetry on EVERY
      // platform so the off-rate is monitorable alongside activate/degrade/abort.
      if (process.platform === "darwin") {
        log.info(
    "boot: OS tool sandbox gated off (enable via Settings → Permissions 'OS tool sandbox' or LVIS_SANDBOX_ENABLED=1)",
        );
      }
      bootAuditLogger.logSandboxGate({
        platform: process.platform,
        onSignal: sandboxGateOnSignal,
        outcome: "skip",
        reason: "gate-off",
      });
    }

    // Flag-interlock warning (no hard interlock — the flags stay independent).
    // Keyed on the ACTUAL sandbox-active state so it fires on EVERY
    // sandbox-inactive path: gate off, OR the new DEGRADED path (gate ON by
    // default but the sandbox could not activate). The explicit-abort path never
    // reaches here (boot already threw). `hostClassifiesRisk` gates plugin tools
    // at the effect boundary, which does NOT contain off-hostApi mutations
    // (direct node:fs / bare fetch / detached async frames) — only the OS sandbox
    // does. Warn LOUDLY once so the operator sees the uncontained residual; we
    // deliberately do NOT block (the flags remain independently togglable).
    if (
      shouldWarnHostClassifyInterlock({
        hostClassifiesRisk: settingsService.get("features")?.hostClassifiesRisk ?? false,
        sandboxActive,
      })
    ) {
      log.warn(
        "boot: hostClassifiesRisk is ON but the OS tool sandbox (osToolSandbox / LVIS_SANDBOX_ENABLED) is NOT active — " +
          "effect-boundary classification does NOT contain off-hostApi mutations (direct node:fs, bare fetch, " +
          "detached async frames) without the OS sandbox. For that residual, host-classify WITHOUT the sandbox is " +
          "weaker than the pre-exec ask it replaces. Install/enable the OS sandbox to contain it, or keep the " +
          "pre-exec ask (turn hostClassifiesRisk off) until the sandbox is active.",
      );
    }
  }
}
