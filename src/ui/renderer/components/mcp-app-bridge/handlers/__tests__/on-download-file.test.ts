// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createOnDownloadFile } from "../on-download-file.js";
import type { McpUiDownloadOutcome } from "../../../../../../mcp/mcp-app-download.js";

type DownloadParams = { contents: Array<Record<string, unknown>> };
type Handler = (p: DownloadParams) => Promise<{ isError?: boolean }>;

function build(outcome: McpUiDownloadOutcome | Error) {
  const downloadFile = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { downloadFile, handler: createOnDownloadFile({ downloadFile }) as unknown as Handler };
}

const params: DownloadParams = {
  contents: [{ type: "resource", resource: { uri: "ui://card/a.csv", text: "a,b" } }],
};

describe("createOnDownloadFile — the app names no server and gets no reason back", () => {
  it("forwards ONLY the spec params to the bound sink", async () => {
    const { downloadFile, handler } = build({ ok: true, disposition: "saved" });

    await handler(params);

    // No serverId here: McpAppView bound it from the card.
    expect(downloadFile).toHaveBeenCalledWith(params);
  });

  it("saved → an EMPTY result", async () => {
    const { handler } = build({ ok: true, disposition: "saved" });

    await expect(handler(params)).resolves.toEqual({});
  });

  it("a user CANCEL is NOT an error — `{}`, never `{ isError: true }`", async () => {
    const { handler } = build({ ok: true, disposition: "cancelled" });

    const result = await handler(params);

    // Declining to save is not a failure: raising isError would tell the app to retry
    // or report a problem that never happened.
    expect(result).toEqual({});
    expect(result.isError).toBeUndefined();
  });

  it("a host rejection → `{ isError: true }` and nothing else", async () => {
    const { handler } = build({
      ok: false,
      error: "resource-link-unsupported",
      message: "the host does not fetch app-supplied URIs",
    });

    const result = await handler(params);

    expect(result).toEqual({ isError: true });
    // Not even the host's reason leaks back into the app frame.
    expect(JSON.stringify(result)).not.toContain("resource-link");
  });

  it("an over-cap payload → `{ isError: true }`", async () => {
    const { handler } = build({ ok: false, error: "too-large", message: "download exceeds cap" });

    await expect(handler(params)).resolves.toEqual({ isError: true });
  });

  it("turns an IPC failure (e.g. unauthorized frame throw) into an error RESULT, not a throw", async () => {
    const { handler } = build(new Error("unauthorized-frame"));

    await expect(handler(params)).resolves.toEqual({ isError: true });
  });
});
