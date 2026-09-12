import { bootstrap } from "../boot.js";
import type { BootHost } from "../boot/host-runtime.js";
import { createConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import { createConversationCommandPort } from "./conversation-command-port.js";
import { maybeStartLocalApiServer } from "./local-api-server.js";
import { createA2ALoopbackRuntime } from "./a2a-loopback-runtime.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { setServices } from "./app-state.js";
import { maybeStartTailnetObserverServer } from "./tailnet-surface-server.js";

/** One service graph, command owner and event timeline for every attached client. */
export async function createWindowlessHost(projectRoot: string, host: BootHost) {
  const services = await bootstrap(projectRoot, null, () => null, "headless", host);
  setServices(services);
  const conversationSurfaceRuntime = createConversationSurfaceRuntime();
  const deps = {
    ...services,
    getMainWindow: () => null,
    getAppWindows: () => [],
    conversationSurfaceRuntime,
  };
  const conversationCommandPort = createConversationCommandPort(deps, conversationSurfaceRuntime);
  return {
    services,
    conversationSurfaceRuntime,
    conversationCommandPort,
    startTailnetSurface: () => maybeStartTailnetObserverServer({
      encryption: host.encryption,
      conversationSurfaceRuntime,
      conversationCommandPort,
      getCurrentConversationId: () => services.conversationLoop.getSessionId(),
      isConversationBusy: () => conversationSurfaceRuntime.activity.isBusy(),
      auditLogger: services.auditLogger,
    }),
    startLocalApi: () => maybeStartLocalApiServer({
      services,
      getMainWindow: deps.getMainWindow,
      getAppWindows: deps.getAppWindows,
      conversationSurfaceRuntime,
      conversationCommandPort,
      createA2ARouter: ({ approveAgentAction }) => {
        const project = services.conversationLoop.getSessionProjectContext();
        return createA2ALoopbackRuntime({
          services,
          project: {
            root: project.projectRoot ?? services.conversationLoop.getSessionExecutionCwd(),
            ...(project.projectName ? { name: project.projectName } : {}),
          },
          appVersion: getLvisAppVersion(),
          approveAgentAction,
        });
      },
    }),
  };
}
