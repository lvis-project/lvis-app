import { describe, expect, it, vi } from "vitest";
import { createA2AHttpRouter, type A2ARequestHandler } from "../a2a-router.js";

const handler: A2ARequestHandler = {
  id: "receiver",
  card: { name: "receiver", description: "receiver", version: "1", capabilities: {}, skills: [], defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"] },
  handle: vi.fn(),
};

async function readCard(advertisedOrigin?: string, spoof = "evil.example.test") {
  const router = createA2AHttpRouter({ handlers: [handler], advertisedOrigin });
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const req = { headers: { host: spoof, "x-forwarded-host": spoof, "x-forwarded-proto": "http" }, socket: { localPort: 45678 } };
  const res = {
    writeHead: (nextStatus: number, nextHeaders: Record<string, string>) => { status = nextStatus; headers = nextHeaders; },
    end: (value: string) => { body = value; },
  };
  await router.tryHandle(req as never, res as never, "/a2a/receiver/.well-known/agent-card.json", "GET");
  return { status, headers, card: JSON.parse(body) as any };
}

describe("A2A advertised public origin", () => {
  it("uses only the fixed canonical HTTPS origin and keeps the Card digest stable across spoofed headers", async () => {
    const first = await readCard("https://receiver.lvis.ai/", "first-evil.test");
    const second = await readCard("https://receiver.lvis.ai/", "second-evil.test");
    expect(first.status).toBe(200);
    expect(first.card.supportedInterfaces[0].url).toBe("https://receiver.lvis.ai/a2a/receiver");
    expect(JSON.stringify(first.card)).not.toContain("evil.test");
    expect(second.card).toEqual(first.card);
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it("preserves the ph3 local interface default when no public origin is supplied", async () => {
    const local = await readCard(undefined, "spoofed.example.test");
    expect(local.card.supportedInterfaces[0].url).toBe("http://127.0.0.1:45678/a2a/receiver");
  });

  it.each([
    "http://receiver.example.test/",
    "https://receiver.example.test/path",
    "https://receiver.example.test:8443/",
    "https://user@receiver.example.test/",
    "https://receiver/",
    "https://receiver.lvis.ai./",
    "https://receiver.local/",
    "https://receiver.internal/",
    "https://receiver.home.arpa/",
    "https://receiver.test/",
    "https://receiver.invalid/",
    "https://receiver.example/",
  ])("rejects invalid advertised origin %s", (origin) => {
    expect(() => createA2AHttpRouter({ handlers: [handler], advertisedOrigin: origin })).toThrow("a2a-advertised-origin-invalid");
  });
});
