import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "../shared/subagent-policy.js";
import {
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  SIDEBAR_DEFAULT_WIDTH,
} from "../shared/side-panel.js";
import {
  DEFAULT_LLM_VENDOR,
  freshVendorBlocks,
} from "../shared/llm-vendor-defaults.js";
import { DEFAULT_BUNDLE_ID } from "../shared/theme-bundles.js";
import { DEFAULT_LOCALE } from "../i18n/index.js";
import { DEFAULT_APP_MODE } from "../shared/initial-app-mode.js";
import { DEFAULT_SIDEBAR_TAB } from "../shared/sidebar-tab.js";
import { normalizeSettingsTab } from "../shared/settings-tabs.js";
import { LOG_RETENTION_DAYS } from "../shared/log-retention.js";
import type { AppSettings } from "./settings-store.js";

export const DEFAULT_SETTINGS: AppSettings = {
  llm: {
    activeChatRuntime: { kind: "api" },
    provider: DEFAULT_LLM_VENDOR,
    vendors: freshVendorBlocks(),
    streamSmoothing: "none",
    fallbackChain: [],
    modelListCache: {},
  },
  chat: {
    systemPrompt:
      "You are LVIS, a local knowledge assistant. You provide accurate, helpful answers grounded in the user's documents and context. Respond in the user's language.",
    autoCompact: true,
    // Tool rounds a sub-agent may run before it hits `round-cap` and suspends.
    // Run as configured — no ceiling narrows it. Exposed because the right
    // budget depends on the work: a deep multi-repo review needs far more
    // rounds than a single-file lookup, and guessing wrong shows up as an
    // agent that stops mid-investigation with partial output.
    subAgentMaxRounds: SUBAGENT_MAX_ROUNDS_DEFAULT,
  },
  a2aRemote: {
    routeControlBaseUrl: "",
    receiverPublicOrigin: "",
    outboundCallerGenerationId: "",
    receiverCallerGenerationId: "",
    extensionSpecDigestSha256: "",
    targets: [],
    receiverMaxKeysPerGeneration: 100,
  },
  webSearch: {
    provider: "duckduckgo",
  },
  marketplace: {
    // Defaults — single source: marketplace server. Default
    // points at the production tunnel so a fresh install lands on the live
    // catalog without any post-install configuration. Operators running a
    // local marketplace (http://localhost:8000) can override via Settings →

    // No fallback to a local catalog file — the only way to populate the
    // host's plugin layout is through the marketplace API.
    backend: "real-cloud",
    cloudBaseUrl: "https://marketplace.lvisai.xyz",
    cloudAllowPrivateNetwork: false,
    installedProviderIds: [],
    installedProviderPresets: [],
    installedThemeBundleIds: [],
    installedLanguagePacks: [],
    // Both default ON, which is what the pre-setting env-only resolvers did
    // when their variables were unset — i.e. on every packaged install.
    updateCheckEnabled: true,
    offlineCacheEnabled: true,
  },
  routine: {},
  privacy: {
    piiRedactEnabled: false,
  },
  updates: {
    autoCheckEnabled: true,
  },
  telemetry: {
    enabled: false,
    crashReportingEnabled: false,
  },
  audit: {
    auditRotationMaxBytes: 10 * 1024 * 1024, // 10 MB
    auditRetentionDays: 30,
  },
  diagnostics: {
    // Raw crash-dump binaries excluded by default — metadata-only in the bundle.
    includeCrashDumps: false,
    // From the fs-free retention SOT (src/shared/log-retention.ts), the same
    // constant log-file-sink re-exports as LOG_RETENTION_DAYS — one literal, no
    // drift between the boot-time prune window and this default.
    logRetentionDays: LOG_RETENTION_DAYS,
  },
  appearance: {
    schemaVersion: 2,
    bundleId: DEFAULT_BUNDLE_ID,
    language: DEFAULT_LOCALE,
  },
  webView: {
    preferredFlow: "in-app",
  },
  system: {
    closeBehavior: "hide-to-tray",
    appMode: DEFAULT_APP_MODE,
    // Opt-in loopback API server — OFF by default (also enabled by env
    // LVIS_LOCAL_API=1). #1409/#1436.
    localApiServer: false,
    // Staged by platform, matching the pre-setting behaviour exactly: the GPU
    // process is what crashes on restricted Windows/Linux corp+VDI drivers, and
    // macOS has never shown that failure. The setting exists so a user whose
    // machine is fine is not stuck with the safe default forever.
    hardwareAcceleration: process.platform !== "win32" && process.platform !== "linux",
    sidePanelWidth: SIDE_PANEL_DEFAULT_WIDTH,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    sidePanelSplitFilePercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidePanelSplitPreviewPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidePanelSplitSubagentPercent: SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
    sidebarActiveTab: DEFAULT_SIDEBAR_TAB,
    // `home` is the only built-in that is inline-only and always present.
    activeView: "home",
    // Ask the normalizer what an absent tab means rather than restating it.
    settingsTab: normalizeSettingsTab(undefined),
    pinnedProjectRoots: [],
    // E4 — auto-launch defaults OFF (opt-in). Only applied on packaged builds.
    launchAtStartup: false,
    launchMinimized: false,
  },
  // E4 — global shortcuts default OFF with no accelerator chosen.
  shortcuts: {
    toggleWindow: null,
    enabled: false,
  },
  plugins: {},
  pluginConfigs: {},
  features: {
    // Profile changes affect every future prompt, so background refresh is explicit opt-in.
    idlePreferenceRefresh: false,
    // Derived long-term overviews send eligible active notes to the configured model only on opt-in.
    idleMemoryConsolidation: false,
    // Existing installs do not start a new provider-backed capture path until
    // the user chooses review or auto in Settings.
    memoryCaptureMode: "off",
    // A background child that finishes must be able to reach its parent. With
    // wake off, its message lands in the mailbox and waits there until the
    // user happens to type another message in that session (the next user
    // turn drains the mailbox as guidance) — the result is not lost, but the
    // parent never acts on it autonomously, and nothing tells the user a
    // result is waiting. Since `background` is the model's per-spawn choice,
    // the host cannot know in advance whether a given run needs autonomous
    // delivery, so wake has to be on for the channel to be trustworthy.
    //
    // Wake is not a new authority path: it runs the normal parent `runTurn` and
    // is still subject to the fail-closed UserPromptSubmit gate, exactly as a
    // user-typed message is.
    subAgentAutonomousWake: true,
    // A child ask that the automatic reviewer left at `ask` goes to the child's
    // own parent agent before it goes to the user. Ships ON: the parent wrote
    // the child's task and is the only party besides the user who knows whether
    // a given call serves it, and a user who delegated the work did not ask to
    // arbitrate each step of it. The lane can only narrow to a ONE-SHOT allow,
    // under a host-enforced verdict ceiling, after every hard check in the
    // approval gate — and anything it cannot decide still becomes the same user
    // modal as before.
    subAgentParentAdjudication: true,
    // External A2A wire routes are independently opt-in and default OFF.
    a2aLoopbackServer: false,
    a2aRemoteRouting: false,
    a2aRemoteReceiver: false,

    // Fresh installs may start the optional first-boot tour. Persisting an
    // explicit `false` (instead of relying on `undefined`) keeps the
    // contract obvious: the flag flips to `true` exactly once, from
    // `markOnboardingCompleted` after the user finishes (or skips) the
    // chain. Any other path that wants to suppress the chain must set
    // this to `true` deliberately — no "missing key === skipped" trap.
    onboardingCompleted: false,
    // Permission policy host-classifies-risk migration gate. Ships ON — the
    // host derives the effective category from host-owned signals (foreground
    // plugin read-relaxation included) instead of trusting the plugin-declared
    // category. Shadow mode reconciliation completed before this flip; users
    // can still opt out in Settings.
    hostClassifiesRisk: true,
    // OS tool sandbox — STAGED rollout. Default ON on `darwin` (the
    // live-verified-active platform) ONLY. `win32` + `linux` stay OFF (opt-in).
    //
    // Windows install-time provisioning (NSIS customInstall, issue #1608) makes
    // opt-in work out of the box, BUT default-on win32 is DEFERRED: Windows
    // srt-win is only PARTIALLY confined (filesystem + network, no PROCESS
    // isolation), and the shell-containment gate (`isActiveSandboxShellContained`,
    // used by bash.ts / powershell.ts) requires full fs+process confinement.
    //
    // The shell tools DO handle that partial case now: `buildHostShellExecutionPlan`
    // routes win32+ASRT to an honest plain host child (`fallbackReason:
    // "windows-partial-shell-acl-unsafe"`) authorized per invocation by a one-shot
    // host permit, rather than erroring. So default-on would run; it is withheld
    // for what it would COST, not what it would break — every bash/powershell call
    // would take an allow-once approval while gaining no shell isolation, and the
    // win32 substrate has no live QA evidence (the Windows CI job exercises the
    // logic, not a provisioned srt-win machine). Flip win32 to `true` after live
    // Windows QA. `linux` stays OFF until C/D-series QA is green.
    //
    // Computed from `process.platform` at default-construction; stable per-process.
    //
    // Safe to stage independently of `hostClassifiesRisk` (which stays ON on all
    // platforms): on a non-sandbox (or non-filesystem-confined) platform the
    // foreground read-relaxation is coupled to the active sandbox FILESYSTEM-
    // CONTAINING the host (ToolExecutor.sandboxFsContainedProvider), so it falls
    // back to the pre-exec ask there. When ON, boot activates ASRT if the platform
    // sandbox can run, else the default/settings path DEGRADES gracefully (loud
    // warning, non-bricking); the explicit `LVIS_SANDBOX_ENABLED=1` env opt-in
    // stays fail-closed. See boot.ts + boot/steps/sandbox-gate.ts.
    osToolSandbox: process.platform === "darwin",
  },
};
