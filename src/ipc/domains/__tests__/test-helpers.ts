export function invokeAppIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        frame: { url: "file:///app/index.html" },
        senderFrame: { url: "file:///app/index.html" },
      } as never,
      ...args,
    ),
  );
}

export function makeAppIpcInvoker(
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  return (channel: string, ...args: unknown[]): Promise<unknown> =>
    invokeAppIpcHandler(handlers, channel, ...args);
}

export function invokeFileIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      {
        frameId: 0,
        processId: 0,
        senderFrame: { url: "file:///app/index.html" },
      } as never,
      ...args,
    ),
  );
}
