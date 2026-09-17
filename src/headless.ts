import { configureHeadlessRuntimeIdentity } from "./main/headless-runtime-identity.js";
import { projectRoot } from "./main/main-paths.js";

configureHeadlessRuntimeIdentity(projectRoot);
await import("./headless-host.js");
