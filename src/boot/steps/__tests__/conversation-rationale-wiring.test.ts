import { describe, expect, it, vi } from "vitest";
import type { ConversationLoop } from "../../../engine/conversation-loop.js";
import type { RationaleCoordinatorFactory } from "../../../engine/turn/rationale-conversation-orchestration.js";
import type { RationaleHostService } from "../../../tools/pipeline/rationale-host-service.js";
import { createLoopRationaleBindings } from "../conversation-wiring.js";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

describe("createLoopRationaleBindings", () => {
  it("creates distinct main and side factories with live policy and session scope", () => {
    const mainFactory = vi.fn() as unknown as RationaleCoordinatorFactory;
    const sideFactory = vi.fn() as unknown as RationaleCoordinatorFactory;
    const scopes: Array<{
      getRationalePolicyEpoch: () => string;
      isSessionCurrent: (sessionId: string) => boolean;
    }> = [];
    const createCoordinatorFactory = vi.fn((scope) => {
      scopes.push(scope);
      return scopes.length === 1 ? mainFactory : sideFactory;
    });
    const closeSession = vi.fn();
    const service = {
      createCoordinatorFactory,
      closeSession,
    } as unknown as RationaleHostService;

    let mainSession = "main-1";
    let sideSession = "side-1";
    let mainDirectories: readonly string[] = ["C:\\main"];
    let sideDirectories: readonly string[] = ["/side"];
    const mainLoop = {
      getSessionId: () => mainSession,
      getTurnAdditionalDirectories: () => mainDirectories,
    } as unknown as ConversationLoop;
    const sideLoop = {
      getSessionId: () => sideSession,
      getTurnAdditionalDirectories: () => sideDirectories,
    } as unknown as ConversationLoop;
    const shared = {
      service,
      permissionManager: { getPolicyEpoch: () => "permission-1" } as never,
      hookRunner: { getGeneration: () => "hook-1" } as never,
      scriptHookManager: { getGeneration: () => "script-1" } as never,
    };

    const main = createLoopRationaleBindings({
      ...shared,
      getLoop: () => mainLoop,
    });
    const side = createLoopRationaleBindings({
      ...shared,
      getLoop: () => sideLoop,
    });

    expect(main.rationaleCoordinatorFactory).toBe(mainFactory);
    expect(side.rationaleCoordinatorFactory).toBe(sideFactory);
    expect(main.rationaleCoordinatorFactory).not.toBe(
      side.rationaleCoordinatorFactory,
    );
    expect(createCoordinatorFactory).toHaveBeenCalledTimes(2);

    expect(scopes[0]!.isSessionCurrent("main-1")).toBe(true);
    expect(scopes[0]!.isSessionCurrent("side-1")).toBe(false);
    mainSession = "main-2";
    expect(scopes[0]!.isSessionCurrent("main-1")).toBe(false);
    expect(scopes[0]!.isSessionCurrent("main-2")).toBe(true);

    const mainEpoch = scopes[0]!.getRationalePolicyEpoch();
    mainDirectories = ["C:\\main", "D:\\new"];
    expect(scopes[0]!.getRationalePolicyEpoch()).not.toBe(mainEpoch);
    const sideEpoch = scopes[1]!.getRationalePolicyEpoch();
    sideDirectories = ["/side", "/side/new"];
    expect(scopes[1]!.getRationalePolicyEpoch()).not.toBe(sideEpoch);

    main.closeRationaleSession?.("main-1");
    side.closeRationaleSession?.("side-1");
    expect(closeSession).toHaveBeenNthCalledWith(1, "main-1");
    expect(closeSession).toHaveBeenNthCalledWith(2, "side-1");
  });

  it("returns no injectable authority for routine or subagent deps that omit the service", () => {
    const bindings = createLoopRationaleBindings({
      service: undefined,
      permissionManager: {} as never,
      hookRunner: {} as never,
      scriptHookManager: {} as never,
      getLoop: vi.fn(),
    });

    expect(bindings).toEqual({});
  });
});
