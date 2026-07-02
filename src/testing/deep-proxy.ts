/**
 * Shared test helper — recursive callable Proxy used to stand in for the full
 * AppServices bag when driving `registerIpcHandlers` without constructing real
 * services. Consolidated here (single source) so the channel-inventory and
 * contract-version-freeze snapshot tests share one implementation.
 *
 * Any property access returns the same nested callable proxy (never `undefined`);
 * any call returns the proxy too — so a registrar can traverse
 * `deps.foo.bar.baz(...)` freely. `getSessionId` is special-cased to a string
 * because `registerIpcHandlers` eagerly calls
 * `deps.conversationLoop.getSessionId()` at wiring time. `ownKeys` reports the
 * given `serviceKeys` so the `{ ...services }` spread inside `registerIpcHandlers`
 * carries live nested proxies for every AppServices field.
 */
export function makeDeepProxy(serviceKeys: readonly (string | symbol)[]): unknown {
  const target = (): void => undefined;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "getSessionId") return () => "test-session-id";
      if (prop === "then") return undefined; // never a thenable
      if (prop === "toString" || prop === "valueOf") return () => "mock";
      if (prop === Symbol.toPrimitive) return () => "mock";
      if (prop === Symbol.iterator || prop === Symbol.asyncIterator) return undefined;
      if (prop === Symbol.toStringTag) return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
    ownKeys() {
      return serviceKeys as (string | symbol)[];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true, writable: true, value: proxy };
    },
    has() {
      return true;
    },
  });
  return proxy;
}
