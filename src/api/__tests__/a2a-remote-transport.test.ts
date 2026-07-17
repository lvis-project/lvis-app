import { EventEmitter } from "node:events";
import type { request as HttpsRequest } from "node:https";
import { describe, expect, it } from "vitest";
import { createA2AStrictTransport } from "../a2a-remote-transport.js";

type Step = "connect-fail" | "post-write-fail" | "success" | "lookup-twice";
function fakeRequest(steps: Step[], onAttempt?: (index: number) => void, onBody?: (body: Buffer) => void): { request: typeof HttpsRequest; calls: () => number } {
  let calls = 0;
  const request = ((options: any, callback: (response: any) => void) => {
    const step = steps[calls++] ?? "connect-fail"; onAttempt?.(calls);
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => queueMicrotask(() => req.emit("error", error));
    req.end = (body: Buffer) => {
      onBody?.(body);
      req.emit("finish");
      if (step === "post-write-fail") { queueMicrotask(() => req.emit("error", new Error("dropped"))); return; }
      const response = new EventEmitter() as any;
      response.statusCode = 200; response.headers = { "content-type": "application/json", "content-length": "2" };
      response.rawHeaders = ["Content-Type", "application/json", "Content-Length", "2"];
      response.destroy = (error: Error) => queueMicrotask(() => response.emit("error", error)); response.resume = () => undefined;
      callback(response); queueMicrotask(() => { response.emit("data", Buffer.from("{}")); response.emit("end"); });
    };
    req.flushHeaders = () => {
      const socket = new EventEmitter();
      req.emit("socket", socket);
      const lookupCallback = (error: Error | null) => {
        if (error) { queueMicrotask(() => req.emit("error", error)); return; }
        if (step === "connect-fail") { queueMicrotask(() => req.emit("error", new Error("connect"))); return; }
        queueMicrotask(() => socket.emit("secureConnect"));
      };
      options.lookup("agent.example.test", { all: false }, lookupCallback);
      if (step === "lookup-twice") options.lookup("agent.example.test", { all: false }, lookupCallback);
    };
    return req;
  }) as unknown as typeof HttpsRequest;
  return { request, calls: () => calls };
}

const input = { url: "https://agent.example.test/a2a", body: Buffer.from("{}"), bearer: "secret", activateExactReplay: true } as const;
const answers = [{ address: "8.8.8.8", family: 4 as const }, { address: "1.1.1.1", family: 4 as const }];

describe("A2A strict pinned transport", () => {
  it("tries the next pinned address only after a pre-body connection failure", async () => {
    const fake = fakeRequest(["connect-fail", "success"]);
    await expect(createA2AStrictTransport({ lookup: async () => answers, request: fake.request }).invoke(input)).resolves.toMatchObject({ status: 200 });
    expect(fake.calls()).toBe(2);
  });
  it("reports all pre-body failures and enforces the shared deadline", async () => {
    const all = fakeRequest(["connect-fail", "connect-fail"]);
    await expect(createA2AStrictTransport({ lookup: async () => answers, request: all.request }).invoke(input)).rejects.toThrow("connect");
    expect(all.calls()).toBe(2);
    let clock = 0; const deadline = fakeRequest(["connect-fail", "success"], () => { clock = 100; });
    await expect(createA2AStrictTransport({ lookup: async () => answers, request: deadline.request, now: () => clock }).invoke({ ...input, timeoutMs: 50 })).rejects.toThrow("a2a-remote-timeout");
    expect(deadline.calls()).toBe(1);
  });
  it("never retries another address after body commit, even for exact replay", async () => {
    const fake = fakeRequest(["post-write-fail", "success"]);
    await expect(createA2AStrictTransport({ lookup: async () => answers, request: fake.request }).invoke(input)).rejects.toThrow("dropped");
    expect(fake.calls()).toBe(1);
  });
  it("rejects a transport that asks the pinned lookup seam twice", async () => {
    const fake = fakeRequest(["lookup-twice"]);
    await expect(createA2AStrictTransport({ lookup: async () => [answers[0]!], request: fake.request }).invoke(input)).rejects.toThrow();
    expect(fake.calls()).toBe(1);
  });
  it.each(["success", "post-write-fail"] as const)("zeroizes its owned request body after %s", async (step) => {
    let owned: Buffer | undefined;
    const fake = fakeRequest([step], undefined, (body) => { owned = body; });
    const result = createA2AStrictTransport({ lookup: async () => [answers[0]!], request: fake.request }).invoke(input);
    if (step === "success") await expect(result).resolves.toMatchObject({ status: 200 });
    else await expect(result).rejects.toThrow("dropped");
    expect(owned).toBeDefined();
    expect([...owned!]).toEqual(Array(owned!.length).fill(0));
    expect(input.body.toString()).toBe("{}");
  });
});
