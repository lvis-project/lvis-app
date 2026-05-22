import type { StreamEvent } from "../../types.js";

export async function collectStreamEvents(
  iter: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

export async function* streamFromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) yield item;
}
