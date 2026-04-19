import { spawnSync } from "node:child_process";
import electronPath from "electron";

const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Unpackaged dev runs: bypass plugin signature verification for locally-built
// managed plugins AND allow plugin manifest `entry` paths to traverse into
// ../../../node_modules/@lvis/... (which normally would be rejected by the
// plugin-root confinement check). Both switches reflect the same intent —
// "this is a developer workstation running against sibling-linked plugin
// repos" — and are gated off in packaged builds (app.isPackaged === true).
if (!env.LVIS_DEV_SKIP_SIG) {
  env.LVIS_DEV_SKIP_SIG = "1";
}
if (!env.LVIS_DEV) {
  env.LVIS_DEV = "1";
}

const result = spawnSync(electronPath, args, {
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
