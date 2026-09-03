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

/**
 * A clock that advances one second per read, as an ISO string.
 *
 * The A2A stores stamp every state change, and their suites assert on the
 * ORDER of those stamps rather than on any instant, so a monotonic tick is the
 * contract; a real clock makes two events in the same millisecond look
 * simultaneous.
 */
export function monotonicIsoClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++)).toISOString();
}
