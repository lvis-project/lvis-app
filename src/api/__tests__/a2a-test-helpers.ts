import { vi } from "vitest";
import type { LocalApi } from "../local-api.js";

export function makeStubLocalApi(): LocalApi {
  return { dispatch: vi.fn(async () => ({ ok: true, data: {} })) };
}

/** The frozen "now" the a2a remote-store suites share so persisted stamps compare exactly. */
const A2A_FIXED_NOW_ISO = "2026-07-16T00:00:00.000Z";

export function fixedNow(): Date {
  return new Date(A2A_FIXED_NOW_ISO);
}

/** A JSON-RPC 2.0 request body for the A2A router. */
export function a2aRpcRequestJson(
  method: string,
  params: unknown,
  id: string | number | null = 1,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}
