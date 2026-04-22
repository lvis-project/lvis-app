import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../../plugins/runtime.js";
import { createRoutineEngine } from "../routine.js";
import { emitEvent } from "../types.js";
import { registerPluginEventBridge } from "../steps/ipc-bridge.js";

describe("RoutineEngine startup ordering", () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("receives startup routine.snapshot.calendar events after subscriptions are registered", async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-routine-order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const pluginDir = join(testDir, "plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {},
    async start() {
      ctx.hostApi.emitEvent("routine.snapshot.calendar", {
        events: [
          {
            subject: "Startup sync",
            start: "2026-04-23T09:00:00+09:00",
            end: "2026-04-23T09:30:00+09:00"
          }
        ]
      });
    }
  };
}
`,
      "utf-8",
    );

    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "startup-calendar",
        name: "Startup Calendar",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [],
        deployment: "bundled",
        eventSubscriptions: ["routine.snapshot.calendar"],
      }),
      "utf-8",
    );

    const runtime = new PluginRuntime({
      hostRoot: testDir,
      manifestPaths: [join(pluginDir, "plugin.json")],
      createHostApi: () => ({
        registerKeywords: () => {},
        emitEvent: (eventType, data) => emitEvent(eventType, data),
        onEvent: () => () => {},
        getCalendarSnapshot: async () => {
          throw new Error("not used");
        },
        addTask: () => {},
        saveNote: async () => {},
        getSecret: () => null,
        getMsGraphToken: async () => null,
        startMsGraphAuth: async () => {},
        isMsGraphAuthenticated: () => false,
        getMsGraphAccount: () => null,
        onMsGraphAuthChange: () => {},
        withMsGraphRetry: async () => {
          throw new Error("not used");
        },
        callLlm: async () => "",
        logEvent: () => {},
        onShutdown: () => {},
        openAuthWindow: async () => {
          throw new Error("not used");
        },
      }),
    });

    await runtime.load();

    const routineEngine = createRoutineEngine({
      taskService: { getPendingByPriority: () => [] } as never,
      memoryManager: {
        listNotes: () => [],
        listSessions: () => [],
        readRecentBriefingFeedback: () => [],
      } as never,
      pluginRuntime: runtime,
    });
    const calendarSpy = vi.spyOn(routineEngine, "updateCalendarEvents");

    await runtime.startAll();

    expect(calendarSpy).toHaveBeenCalledWith([
      {
        subject: "Startup sync",
        start: "2026-04-23T09:00:00+09:00",
        end: "2026-04-23T09:30:00+09:00",
      },
    ]);
  });

  it("forwards startup routine.snapshot.calendar to the renderer bridge when attached before plugin start", async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-routine-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const pluginDir = join(testDir, "plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {},
    async start() {
      ctx.hostApi.emitEvent("routine.snapshot.calendar", {
        events: [
          {
            subject: "Renderer startup sync",
            start: "2026-04-23T09:00:00+09:00",
            end: "2026-04-23T09:30:00+09:00"
          }
        ]
      });
    }
  };
}
`,
      "utf-8",
    );

    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "startup-calendar-renderer",
        name: "Startup Calendar Renderer",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [],
        deployment: "bundled",
        emittedEvents: ["routine.snapshot.calendar"],
      }),
      "utf-8",
    );

    const runtime = new PluginRuntime({
      hostRoot: testDir,
      manifestPaths: [join(pluginDir, "plugin.json")],
      createHostApi: () => ({
        registerKeywords: () => {},
        emitEvent: (eventType, data) => emitEvent(eventType, data),
        onEvent: () => () => {},
        getCalendarSnapshot: async () => {
          throw new Error("not used");
        },
        addTask: () => {},
        saveNote: async () => {},
        getSecret: () => null,
        getMsGraphToken: async () => null,
        startMsGraphAuth: async () => {},
        isMsGraphAuthenticated: () => false,
        getMsGraphAccount: () => null,
        onMsGraphAuthChange: () => {},
        withMsGraphRetry: async () => {
          throw new Error("not used");
        },
        callLlm: async () => "",
        logEvent: () => {},
        onShutdown: () => {},
        openAuthWindow: async () => {
          throw new Error("not used");
        },
      }),
    });

    await runtime.load();

    const sent: Array<{ channel: string; eventType: string; data: unknown }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, eventType: string, data: unknown) => {
          sent.push({ channel, eventType, data });
        },
      },
      once: () => {},
    } as unknown as import("electron").BrowserWindow;

    const dispose = registerPluginEventBridge(runtime, win);
    await runtime.startAll();

    expect(sent).toContainEqual({
      channel: "lvis:plugin:event",
      eventType: "routine.snapshot.calendar",
      data: {
        events: [
          {
            subject: "Renderer startup sync",
            start: "2026-04-23T09:00:00+09:00",
            end: "2026-04-23T09:30:00+09:00",
          },
        ],
      },
    });
    dispose();
  });
});
