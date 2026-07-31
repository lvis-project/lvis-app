export { collectAsyncIterable as collectStreamEvents } from "../../../../__tests__/test-helpers.js";

export async function* streamFromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) yield item;
}
