import { vi } from "vitest";
import type { LocalApi } from "../local-api.js";

export function makeStubLocalApi(): LocalApi {
  return { dispatch: vi.fn(async () => ({ ok: true, data: {} })) };
}
