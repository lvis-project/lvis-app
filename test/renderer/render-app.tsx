/**
 * Phase 1 — renderApp helper.
 *
 * Stubs window.lvisApi / window.lvis with the provided overrides, renders
 * <App /> via @testing-library/react, returns the mock fns so tests can
 * assert IPC calls.
 */
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import {
  makeMockLvisApi,
  makeMockLvisNamespace,
  type MockLvisApi,
} from "./mock-lvis-api.js";

type RenderAppOpts = Parameters<typeof makeMockLvisApi>[0];

export type RenderAppReturn = {
  container: RenderResult["container"];
  rerender: RenderResult["rerender"];
  unmount: RenderResult["unmount"];
  api: MockLvisApi;
  emitChatStream: (ev: unknown) => void;
  emitRoutineCompleted: (r: unknown) => void;
  emitViewActivate: (v: string) => void;
  emitApproval: (r: unknown) => void;
};

export async function renderApp(opts: RenderAppOpts = {}): Promise<RenderAppReturn> {
  const { api, emitChatStream, emitRoutineCompleted, emitViewActivate } = makeMockLvisApi(opts);
  const { ns, emitApproval } = makeMockLvisNamespace();

  vi.stubGlobal("lvisApi", api);
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvisApi: MockLvisApi }).lvisApi = api;
  (window as unknown as { lvis: unknown }).lvis = ns;

  const { App } = await import("../../src/renderer.js");
  const result = render(<App />);

  return {
    container: result.container,
    rerender: result.rerender,
    unmount: result.unmount,
    api,
    emitChatStream,
    emitRoutineCompleted,
    emitViewActivate,
    emitApproval,
  };
}
