import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { expect, test, type Page } from "@playwright/test";
import { mergeEvidenceFile } from "../evidence-file.js";
import {
  approvePendingPlugin,
  postMarketplace,
  publishPlugin,
  requireExactLoopbackMarketplaceOrigin,
} from "../marketplace-e2e-fixture.js";
import {
  buildE2eBaseSettings,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron.js";
import { openSettingsWindow } from "./settings-window.js";

const E2E_ENABLED = process.env.M4_E2E === "1";
const BASE_URL = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, "");
const PUBLISHER_KEY = process.env.MARKETPLACE_PUBLISHER_KEY ?? "";
const ADMIN_KEY = process.env.MARKETPLACE_ADMIN_KEY ?? "";
const EP_BUNDLE_PATH = process.env.EP_API_BUNDLE_PATH ?? "";
const EVIDENCE_PATH = process.env.BUNDLE_E2E_EVIDENCE_PATH ?? "";
const EP_PLUGIN_ID = "ep-api";
const ATTENDANCE_SKILL_ID = "attendance";
const TEST_DATE = "2026-07-24";
const TEST_START_TIME = "09:15";

type BundleSnapshot = {
  ok: true;
  active: {
    version: string;
    generationId: string;
    artifactGenerationId: string;
  } | null;
  skill: {
    name: string;
    body: string;
    owner: {
      pluginId: string;
      pluginVersion: string;
      generationId: string;
      localId: string;
      fingerprint: string;
    };
  } | null;
  tools: Array<{
    name: string;
    source: "plugin" | "mcp";
    pluginId?: string;
    generationId?: string;
  }>;
  hooks: {
    probeToolName: string;
    registered: Array<{
      id: string;
      event: "pre";
      matcher?: string;
      owner: {
        pluginId: string;
        pluginVersion: string;
        activationId: string;
        generationId: string;
        localId: string;
        fingerprint: string;
      };
    }>;
    matchingPreToolUse: string[];
  };
};

type GuestResult<T = unknown> =
  | { state: "pending" }
  | { state: "fulfilled"; value: T }
  | { state: "rejected"; error: string };

type RuntimeCounts = { tools: number; plugins: number; mcps: number };

type FakeAttendanceProvider = {
  origin: string;
  requests: Array<{ method: string; pathname: string; body?: Record<string, unknown> }>;
  current: { workStartHm: string; workEndHm: string };
  close(): Promise<void>;
};

function jsonResponse(
  response: ServerResponse,
  body: Record<string, unknown>,
  status = 200,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fake attendance provider received a non-object JSON body");
  }
  return parsed as Record<string, unknown>;
}

async function startFakeAttendanceProvider(): Promise<FakeAttendanceProvider> {
  const requests: FakeAttendanceProvider["requests"] = [];
  const current = { workStartHm: "0830", workEndHm: "" };
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/auth/v1/auth" && method === "GET") {
        requests.push({ method, pathname: url.pathname });
        jsonResponse(response, {
          successOrNot: "Y",
          statusCode: "SUCCESS",
          data: {
            sessionId: "ep-attendance-e2e-session",
            langCd: "KO",
            empNo: "100000",
            empNm: "E2E Attendance",
          },
        });
        return;
      }
      if (url.pathname === "/api/calendar/v1/my-calendar" && method === "GET") {
        requests.push({ method, pathname: url.pathname });
        jsonResponse(response, {
          successOrNot: "Y",
          statusCode: "SUCCESS",
          data: {
            myCalendar: [{
              tnaDt: url.searchParams.get("tnaYmd") ?? TEST_DATE.replaceAll("-", ""),
              workStartHm: current.workStartHm,
              workEndHm: current.workEndHm,
            }],
          },
        });
        return;
      }
      if (url.pathname === "/api/calendar/v1/my-calendar" && method === "POST") {
        const body = await readJsonBody(request);
        requests.push({ method, pathname: url.pathname, body });
        if (typeof body.startTm === "string") current.workStartHm = body.startTm;
        if (typeof body.endTm === "string") current.workEndHm = body.endTm;
        jsonResponse(response, {
          successOrNot: "Y",
          statusCode: "SUCCESS",
          data: { saved: true },
        });
        return;
      }
      requests.push({ method, pathname: url.pathname });
      jsonResponse(response, { successOrNot: "N", statusCode: "NOT_FOUND" }, 404);
    } catch (error) {
      jsonResponse(response, {
        successOrNot: "N",
        statusCode: "FIXTURE_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fake attendance provider did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    current,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function inspectExactEpBundle(): {
  bytes: Buffer;
  manifest: Record<string, unknown>;
  version: string;
  sha256: string;
  contributionCounts: { skills: number; hooks: number; mcpServers: number };
} {
  if (!EP_BUNDLE_PATH) throw new Error("EP_API_BUNDLE_PATH is required");
  const bytes = readFileSync(EP_BUNDLE_PATH);
  const zip = new AdmZip(bytes);
  const manifestEntry = zip.getEntry("plugin.json");
  if (!manifestEntry) throw new Error("exact EP bundle is missing plugin.json");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as Record<string, unknown>;
  if (manifest.id !== EP_PLUGIN_ID || typeof manifest.version !== "string") {
    throw new Error("exact EP bundle manifest identity is invalid");
  }
  if (typeof manifest.entry !== "string" || !zip.getEntry(manifest.entry)) {
    throw new Error("exact EP bundle is missing its declared runtime entry");
  }
  const listCount = (value: unknown) => Array.isArray(value) ? value.length : 0;
  return {
    bytes,
    manifest,
    version: manifest.version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contributionCounts: {
      skills: listCount(manifest.skills),
      hooks: listCount(manifest.hooks),
      mcpServers: listCount(manifest.mcpServers),
    },
  };
}

async function adminPost(path: string): Promise<Response> {
  return postMarketplace(BASE_URL, ADMIN_KEY, path);
}

async function bundleSnapshot(page: Page): Promise<BundleSnapshot> {
  return page.evaluate(async ({ pluginId, skillLocalId, hookProbeToolName }) => {
    const api = globalThis as unknown as {
      lvisApi: {
        e2ePluginBundleSnapshot(
          id: string,
          localId: string,
          hookProbeToolName: string,
        ): Promise<BundleSnapshot>;
      };
    };
    return api.lvisApi.e2ePluginBundleSnapshot(
      pluginId,
      skillLocalId,
      hookProbeToolName,
    );
  }, {
    pluginId: EP_PLUGIN_ID,
    skillLocalId: ATTENDANCE_SKILL_ID,
    hookProbeToolName: "ep_attendance_write",
  });
}

async function setPluginEnabled(page: Page, enabled: boolean): Promise<unknown> {
  return page.evaluate(async ({ pluginId, enabledState }) => {
    const api = globalThis as unknown as {
      lvisApi: { setPluginEnabled(id: string, active: boolean): Promise<unknown> };
    };
    return api.lvisApi.setPluginEnabled(pluginId, enabledState);
  }, { pluginId: EP_PLUGIN_ID, enabledState: enabled });
}

async function runtimeCounts(page: Page): Promise<RuntimeCounts> {
  return page.evaluate(async () => {
    const api = globalThis as unknown as {
      lvisApi: { getRuntimeCounts(): Promise<RuntimeCounts> };
    };
    return api.lvisApi.getRuntimeCounts();
  });
}

async function activateEpWebview(ctx: SeededElectronContext): Promise<number> {
  const viewKey = await ctx.page.evaluate(async () => {
    const views = await (globalThis as unknown as {
      lvisApi: {
        listPluginUiExtensions(): Promise<Array<{
          pluginId: string;
          extension: { id: string; slot: string };
        }>>;
      };
    }).lvisApi.listPluginUiExtensions();
    const ep = views.find((view) =>
      view.pluginId === EP_PLUGIN_ID &&
      view.extension.id === "lge-control" &&
      view.extension.slot === "sidebar"
    );
    return ep ? `plugin:${ep.pluginId}:${ep.extension.id}` : null;
  });
  expect(viewKey).toBe("plugin:ep-api:lge-control");
  await ctx.app.evaluate(({ BrowserWindow }, key) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.webContents.send("lvis:view:activate", { viewKey: key });
  }, viewKey!);
  await expect(ctx.page.locator("webview")).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(
    () => ctx.app.evaluate(({ webContents }) => {
      const guest = webContents.getAllWebContents().find((candidate) =>
        candidate.getType() === "webview" &&
        /plugin-ui-shell\.html$/i.test(candidate.getURL())
      );
      return guest?.id ?? null;
    }),
    { timeout: 15_000 },
  ).not.toBeNull();
  const guestId = await ctx.app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((candidate) =>
      candidate.getType() === "webview" &&
      /plugin-ui-shell\.html$/i.test(candidate.getURL())
    );
    return guest?.id ?? null;
  });
  if (guestId === null) throw new Error("EP plugin webview guest is missing");
  await expect.poll(
    () => ctx.app.evaluate(({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript(
        "typeof globalThis.lvisPlugin?.requestOperationGrant === 'function'",
        true,
      ), guestId),
    { timeout: 15_000 },
  ).toBe(true);
  return guestId;
}

async function executeInGuest<T>(
  ctx: SeededElectronContext,
  guestId: number,
  source: string,
): Promise<T> {
  return ctx.app.evaluate(async ({ webContents }, { id, script }) => {
    const guest = webContents.fromId(id);
    if (!guest || guest.isDestroyed()) throw new Error("EP plugin webview guest retired");
    return await guest.executeJavaScript(script, true);
  }, { id: guestId, script: source }) as Promise<T>;
}

function startGuestToolCallSource(
  toolName: string,
  args: Record<string, unknown>,
  operationGrantToken?: string,
): string {
  return `globalThis.__epAttendanceInvocation={state:"pending"};` +
    `void globalThis.lvisPlugin.callTool(` +
    `${JSON.stringify(toolName)},${JSON.stringify(args)},` +
    `${JSON.stringify(operationGrantToken ? { operationGrantToken } : {})}` +
    `).then(value=>{globalThis.__epAttendanceInvocation={state:"fulfilled",value}},` +
    `error=>{globalThis.__epAttendanceInvocation={state:"rejected",error:String(error?.message??error)}});` +
    `"started"`;
}

async function readGuestToolCall<T>(
  ctx: SeededElectronContext,
  guestId: number,
): Promise<GuestResult<T>> {
  return executeInGuest(ctx, guestId, "globalThis.__epAttendanceInvocation");
}

async function invokeGuestTool<T>(
  ctx: SeededElectronContext,
  guestId: number,
  page: Page,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    operationGrantToken?: string;
    approval: "allow-if-requested" | "forbid";
    approvalReason?: string;
  },
): Promise<GuestResult<T>> {
  expect(await executeInGuest<string>(
    ctx,
    guestId,
    startGuestToolCallSource(toolName, args, options.operationGrantToken),
  )).toBe("started");
  const approvalDialog = page.getByTestId("tool-approval-dialog");
  const terminalOrApproval = async () => {
    const result = await readGuestToolCall<T>(ctx, guestId);
    if (result.state !== "pending") return "terminal" as const;
    return await approvalDialog.isVisible().catch(() => false)
      ? "approval" as const
      : "pending" as const;
  };
  await expect.poll(terminalOrApproval, { timeout: 10_000 }).not.toBe("pending");
  if (await terminalOrApproval() === "approval") {
    if (options.approval === "forbid") {
      const deny = page.getByTestId("deny-button");
      if (await deny.isVisible().catch(() => false)) await deny.click();
      throw new Error(`${toolName} reached a forbidden approval`);
    }
    await approveVisibleToolDialog(
      page,
      options.approvalReason ?? `Allow the exact EP E2E invocation of ${toolName}.`,
    );
  }
  await expect.poll(
    () => readGuestToolCall<T>(ctx, guestId),
    { timeout: 30_000 },
  ).not.toMatchObject({ state: "pending" });
  return readGuestToolCall<T>(ctx, guestId);
}

async function startGuestGrant(
  ctx: SeededElectronContext,
  guestId: number,
  args: Record<string, unknown>,
): Promise<void> {
  const source = `globalThis.__epAttendanceGrant={state:"pending"};` +
    `void globalThis.lvisPlugin.requestOperationGrant(` +
    `${JSON.stringify("ep_attendance_write")},${JSON.stringify(args)}` +
    `).then(value=>{globalThis.__epAttendanceGrant={state:"fulfilled",value}},` +
    `error=>{globalThis.__epAttendanceGrant={state:"rejected",error:String(error?.message??error)}});` +
    `"started"`;
  expect(await executeInGuest<string>(ctx, guestId, source)).toBe("started");
}

async function readGuestGrant(
  ctx: SeededElectronContext,
  guestId: number,
): Promise<GuestResult<{ operationGrantToken: string; grantId: string; expiresAt: number }>> {
  return executeInGuest(ctx, guestId, "globalThis.__epAttendanceGrant");
}

async function approveVisibleToolDialog(page: Page, reason: string): Promise<void> {
  const dialog = page.getByTestId("tool-approval-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const justification = page.getByTestId("nl-justification-input");
  if (await justification.isVisible().catch(() => false)) {
    await justification.fill(reason);
  }
  const approve = page.getByTestId("approve-button");
  await expect(approve).toBeEnabled();
  await approve.click();
}

test.skip(!E2E_ENABLED, "set M4_E2E=1 to run the exact EP attendance lifecycle");
test.skip(!builtMainExists(), "build the Electron app before running this spec");

test("exact EP attendance bundle reads, confirms one write, verifies readback, and retires", async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  requireExactLoopbackMarketplaceOrigin(BASE_URL);
  if (!PUBLISHER_KEY || !ADMIN_KEY) {
    throw new Error("MARKETPLACE_PUBLISHER_KEY and MARKETPLACE_ADMIN_KEY are required");
  }
  const bundle = inspectExactEpBundle();
  const fake = await startFakeAttendanceProvider();
  let ctx: SeededElectronContext | null = null;
  try {
    await publishPlugin(BASE_URL, ADMIN_KEY, EP_PLUGIN_ID, bundle.version, bundle.bytes);
    const approval = await approvePendingPlugin(
      BASE_URL,
      ADMIN_KEY,
      EP_PLUGIN_ID,
      bundle.version,
    );
    expect(approval.approval_state).toBe("approved");

    const settings = buildE2eBaseSettings(true, "en");
    settings.marketplace = {
      backend: "real-cloud",
      cloudBaseUrl: BASE_URL,
      cloudAllowPrivateNetwork: true,
      updateCheckEnabled: false,
      updateCheckIntervalMs: 0,
    };
    ctx = await launchSeededElectron({
      historyRows: [],
      settings,
      userDataPrefix: "lvis-ep-attendance-user-data-",
      homePrefix: "lvis-ep-attendance-home-",
      launchEnv: {
        LVIS_SANDBOX_ENABLED: "0",
        LVIS_EP_ATTENDANCE_E2E_ORIGIN: fake.origin,
      },
    });

    await expect.poll(
      async () => (await ctx!.page.evaluate(async () => {
        const api = globalThis as unknown as {
          lvisApi: { listPluginCards(): Promise<Array<{ id: string; version: string; runtimeLoaded: boolean }>> };
        };
        return api.lvisApi.listPluginCards();
      })).find((card) => card.id === EP_PLUGIN_ID),
      { timeout: 30_000 },
    ).toMatchObject({
      id: EP_PLUGIN_ID,
      version: bundle.version,
      runtimeLoaded: true,
    });

    const pluginDataDir = join(ctx.lvisHome, "plugins", EP_PLUGIN_ID, "data");
    mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
    const snapshotPath = join(pluginDataDir, "session-snapshot.json");
    writeFileSync(snapshotPath, `${JSON.stringify({
      v: 1,
      cookies: [{
        name: "ssolgenet",
        value: "id=e2e.attendance&empno=100000",
        domain: ".lge.com",
        path: "/",
      }],
      lastLoginAt: new Date().toISOString(),
      lastLoginFinalUrl: "https://space.lge.com/",
      attendanceCookies: [],
      attendanceLastLoginAt: new Date().toISOString(),
      parkingCookies: [],
      savedAt: new Date().toISOString(),
      e2eAuth: {
        v: 1,
        account: "ep-attendance-e2e@localhost",
      },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(snapshotPath, 0o600);

    await expect(setPluginEnabled(ctx.page, false)).resolves.toMatchObject({
      ok: true,
      enabled: false,
    });
    await expect(setPluginEnabled(ctx.page, true)).resolves.toMatchObject({
      ok: true,
      enabled: true,
    });

    const installed = await bundleSnapshot(ctx.page);
    expect(installed.active).toMatchObject({ version: bundle.version });
    expect(installed.skill).toMatchObject({
      name: "plugin:ep-api:attendance",
      owner: {
        pluginId: EP_PLUGIN_ID,
        pluginVersion: bundle.version,
        localId: ATTENDANCE_SKILL_ID,
      },
    });
    expect(installed.skill?.owner.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ep_attendance_read", pluginId: EP_PLUGIN_ID }),
      expect.objectContaining({ name: "ep_attendance_write", pluginId: EP_PLUGIN_ID }),
    ]));
    expect(installed.hooks).toMatchObject({
      probeToolName: "ep_attendance_write",
      registered: [],
      matchingPreToolUse: [],
    });
    const installedCounts = await runtimeCounts(ctx.page);
    const trustRows = await ctx.page.evaluate(async () => {
      const api = globalThis as unknown as {
        lvisApi: {
          listPluginContributionTrust(id: string): Promise<{ ok: boolean; rows: unknown[] }>;
        };
      };
      return api.lvisApi.listPluginContributionTrust(EP_PLUGIN_ID);
    });
    expect(trustRows).toMatchObject({ ok: true, rows: [] });

    const guestId = await activateEpWebview(ctx);
    const status = await invokeGuestTool<Record<string, unknown>>(
      ctx,
      guestId,
      ctx.page,
      "ep_status",
      {},
      { approval: "allow-if-requested" },
    );
    expect(status).toMatchObject({
      state: "fulfilled",
      value: {
        authenticated: true,
        account: "ep-attendance-e2e@localhost",
      },
    });

    const readArgs = { operation: "today", date: TEST_DATE };
    const before = await invokeGuestTool<{
      status?: string;
      data?: { date?: string; startTime?: string; endTime?: string };
    }>(
      ctx,
      guestId,
      ctx.page,
      "ep_attendance_read",
      readArgs,
      {
        approval: "allow-if-requested",
        approvalReason: "Read the deterministic attendance state before writing.",
      },
    );
    expect(before).toMatchObject({
      state: "fulfilled",
      value: {
        status: "success",
        data: { date: TEST_DATE, startTime: "08:30" },
      },
    });

    const writeArgs = {
      operation: "clock",
      date: TEST_DATE,
      startTime: TEST_START_TIME,
      submit: true,
      confirmed: true,
    };
    const missingGrant = await invokeGuestTool(
      ctx,
      guestId,
      ctx.page,
      "ep_attendance_write",
      writeArgs,
      { approval: "forbid" },
    );
    expect(missingGrant.state).toBe("rejected");
    expect(missingGrant.error).toMatch(/operation grant|grant/i);
    const forgedGrant = await invokeGuestTool(
      ctx,
      guestId,
      ctx.page,
      "ep_attendance_write",
      writeArgs,
      {
        operationGrantToken: "forged-operation-grant",
        approval: "forbid",
      },
    );
    expect(forgedGrant.state).toBe("rejected");
    expect(forgedGrant.error).toMatch(/operation grant|grant/i);
    expect(fake.requests.filter((entry) => entry.method === "POST")).toHaveLength(0);

    await startGuestGrant(ctx, guestId, writeArgs);
    await approveVisibleToolDialog(
      ctx.page,
      "Confirm the exact EP attendance clock write against the loopback fixture.",
    );
    await expect.poll(
      () => readGuestGrant(ctx!, guestId),
      { timeout: 10_000 },
    ).toMatchObject({ state: "fulfilled" });
    const grant = await readGuestGrant(ctx, guestId);
    if (grant.state !== "fulfilled") throw new Error("operation grant was not issued");
    expect(grant.value.operationGrantToken).toBeTruthy();
    expect(grant.value.grantId).toMatch(/^[0-9a-f-]{16,}$/i);

    const write = await invokeGuestTool<{
      status?: string;
      data?: { submitted?: boolean; startTime?: string };
      providerEvidence?: { verification?: { verified?: boolean; reason?: string } };
    }>(
      ctx,
      guestId,
      ctx.page,
      "ep_attendance_write",
      writeArgs,
      {
        operationGrantToken: grant.value.operationGrantToken,
        approval: "forbid",
      },
    );
    expect(write).toMatchObject({
      state: "fulfilled",
      value: {
        status: "success",
        data: { submitted: true, startTime: "09:15" },
        providerEvidence: { verification: { verified: true } },
      },
    });
    await expect(ctx.page.getByTestId("tool-approval-dialog")).toBeHidden();
    expect(fake.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);

    const after = await invokeGuestTool<{
      status?: string;
      data?: { date?: string; startTime?: string; endTime?: string };
    }>(
      ctx,
      guestId,
      ctx.page,
      "ep_attendance_read",
      readArgs,
      {
        approval: "allow-if-requested",
        approvalReason: "Read back the deterministic attendance state after writing.",
      },
    );
    expect(after).toMatchObject({
      state: "fulfilled",
      value: {
        status: "success",
        data: { date: TEST_DATE, startTime: "09:15" },
      },
    });

    await expect(setPluginEnabled(ctx.page, false)).resolves.toMatchObject({
      ok: true,
      enabled: false,
    });
    const disabled = await bundleSnapshot(ctx.page);
    expect(disabled).toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
      hooks: {
        registered: [],
        matchingPreToolUse: [],
      },
    });
    const disabledCounts = await runtimeCounts(ctx.page);
    expect(disabledCounts.plugins).toBe(installedCounts.plugins - 1);
    expect(disabledCounts.mcps).toBe(installedCounts.mcps);

    const settingsWindow = await openSettingsWindow(ctx.app, ctx.page, "marketplace");
    const packageAction = settingsWindow.getByTestId(`marketplace:action:${EP_PLUGIN_ID}`);
    await expect(packageAction).toBeVisible();
    const yank = await adminPost(`/api/v1/admin/plugins/${EP_PLUGIN_ID}/yank`);
    expect(yank.status).toBe(200);
    await packageAction.click();
    await expect.poll(async () => {
      const cards = await ctx!.page.evaluate(async () => {
        const api = globalThis as unknown as {
          lvisApi: { listPluginCards(): Promise<Array<{ id: string }>> };
        };
        return api.lvisApi.listPluginCards();
      });
      return cards.some((card) => card.id === EP_PLUGIN_ID);
    }).toBe(false);

    const uninstalled = await bundleSnapshot(ctx.page);
    expect(uninstalled).toMatchObject({
      ok: true,
      active: null,
      skill: null,
      tools: [],
      hooks: {
        registered: [],
        matchingPreToolUse: [],
      },
    });
    const generationRoot = join(
      ctx.lvisHome,
      "plugins",
      ".cache",
      EP_PLUGIN_ID,
      "generations",
    );
    const retainedGenerations = existsSync(generationRoot)
      ? readdirSync(generationRoot)
      : [];
    expect(retainedGenerations).toEqual([]);
    expect(existsSync(join(ctx.lvisHome, "plugins", EP_PLUGIN_ID))).toBe(false);
    const uninstalledCounts = await runtimeCounts(ctx.page);
    expect(uninstalledCounts).toEqual(disabledCounts);

    mergeEvidenceFile(EVIDENCE_PATH, {
      actualEpAttendance: {
        hostSha: process.env.HOST_SHA ?? null,
        marketplaceSha: process.env.MARKETPLACE_SHA ?? null,
        sdkSha: process.env.SDK_SHA ?? null,
        epApiSha: process.env.EP_API_SHA ?? null,
        artifact: {
          pluginId: EP_PLUGIN_ID,
          version: bundle.version,
          sha256: bundle.sha256,
          exactSourceArchive: true,
          contributionCounts: bundle.contributionCounts,
        },
        marketplace: {
          target: "loopback:8765",
          approvalState: approval.approval_state,
          installMode: "host-managed-bootstrap",
          pluginYankedBeforeUninstall: true,
          productionWriteExecuted: false,
        },
        provider: {
          target: "loopback",
          productionCredentialsUsed: false,
          requestCount: fake.requests.length,
          authReads: fake.requests.filter((entry) => entry.pathname === "/api/auth/v1/auth").length,
          calendarReads: fake.requests.filter((entry) =>
            entry.pathname === "/api/calendar/v1/my-calendar" && entry.method === "GET"
          ).length,
          calendarWrites: fake.requests.filter((entry) =>
            entry.pathname === "/api/calendar/v1/my-calendar" && entry.method === "POST"
          ).length,
        },
        install: {
          generationId: installed.active?.generationId,
          artifactGenerationId: installed.active?.artifactGenerationId,
          skillFingerprint: installed.skill?.owner.fingerprint,
          toolCount: installed.tools.length,
          hookTrustRows: trustRows.rows.length,
          hookRegistryRows: installed.hooks.registered.length,
          hookMatches: installed.hooks.matchingPreToolUse.length,
          mcpRuntimeDelta: 0,
        },
        attendance: {
          date: TEST_DATE,
          before: before.value?.data,
          missingGrantRejected: missingGrant.state === "rejected",
          forgedGrantRejected: forgedGrant.state === "rejected",
          explicitConfirmation: true,
          grantId: grant.value.grantId,
          writeStatus: write.value?.status,
          providerVerified: write.value?.providerEvidence?.verification?.verified === true,
          readback: after.value?.data,
        },
        retirement: {
          disabled: {
            skillRetired: disabled.skill === null,
            toolsRetired: disabled.tools.length === 0,
            hookRegistryRows: disabled.hooks.registered.length,
            hookMatches: disabled.hooks.matchingPreToolUse.length,
            runtimeRetired: disabledCounts.plugins === installedCounts.plugins - 1,
            mcpCountStable: disabledCounts.mcps === installedCounts.mcps,
          },
          uninstalled: {
            skillRetired: uninstalled.skill === null,
            toolsRetired: uninstalled.tools.length === 0,
            hookRegistryRows: uninstalled.hooks.registered.length,
            hookMatches: uninstalled.hooks.matchingPreToolUse.length,
            runtimeRetired: uninstalledCounts.plugins === disabledCounts.plugins,
            retainedGenerations: retainedGenerations.length,
            pluginRootExists: existsSync(join(ctx.lvisHome, "plugins", EP_PLUGIN_ID)),
          },
          hookAndMcpAbsenceMatchesExactManifest:
            bundle.contributionCounts.hooks === installed.hooks.registered.length &&
            bundle.contributionCounts.mcpServers ===
              installedCounts.mcps - disabledCounts.mcps,
          zeroOrphans:
            uninstalled.skill === null &&
            uninstalled.tools.length === 0 &&
            uninstalled.hooks.registered.length === 0 &&
            uninstalled.hooks.matchingPreToolUse.length === 0 &&
            retainedGenerations.length === 0 &&
            !existsSync(join(ctx.lvisHome, "plugins", EP_PLUGIN_ID)),
        },
      },
    });
  } finally {
    if (ctx) await teardownSeededElectron(ctx);
    await fake.close();
  }
});
