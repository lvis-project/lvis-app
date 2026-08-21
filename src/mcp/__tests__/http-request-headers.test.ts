import { describe, it, expect } from "vitest";
import {
  collectParamHeaderAnnotations,
  deriveStandardHeaders,
  encodeMcpHeaderValue,
  extractParamHeaders,
} from "../mcp-client.js";

describe("encodeMcpHeaderValue — spec Value Encoding table", () => {
  it("passes plain ASCII through", () => {
    expect(encodeMcpHeaderValue("us-west1")).toBe("us-west1");
  });

  it("Base64-sentinels non-ASCII", () => {
    expect(encodeMcpHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
  });

  it("Base64-sentinels leading/trailing whitespace", () => {
    expect(encodeMcpHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
  });

  it("Base64-sentinels embedded newlines (header-injection neutralized)", () => {
    expect(encodeMcpHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
  });

  it("Base64-sentinels a plain value that matches the sentinel pattern itself", () => {
    expect(encodeMcpHeaderValue("=?base64?literal?=")).toBe(
      "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
    );
  });

  it("Base64-sentinels CRLF", () => {
    const encoded = encodeMcpHeaderValue("evil\r\nx-injected: 1");
    expect(encoded.startsWith("=?base64?")).toBe(true);
    expect(encoded).not.toContain("\r");
    expect(encoded).not.toContain("\n");
  });
});

describe("deriveStandardHeaders", () => {
  const META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };

  it("stamps mcp-method + mcp-protocol-version + mcp-name for tools/call", () => {
    expect(
      deriveStandardHeaders({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_weather", arguments: {}, _meta: META },
      }),
    ).toEqual({
      "mcp-method": "tools/call",
      "mcp-protocol-version": "2026-07-28",
      "mcp-name": "get_weather",
    });
  });

  it("sources mcp-name from params.uri for resources/read", () => {
    const headers = deriveStandardHeaders({
      method: "resources/read",
      params: { uri: "file:///projects/config.json", _meta: META },
    });
    expect(headers["mcp-name"]).toBe("file:///projects/config.json");
  });

  it("omits mcp-protocol-version when the body carries no _meta version (legacy era)", () => {
    const headers = deriveStandardHeaders({
      method: "tools/list",
      params: {},
    });
    expect(headers).toEqual({ "mcp-method": "tools/list" });
  });

  it("omits mcp-name for methods without a defined source field", () => {
    const headers = deriveStandardHeaders({ method: "server/discover", params: { _meta: META } });
    expect(headers["mcp-name"]).toBeUndefined();
  });

  it("encodes a non-header-safe tool name", () => {
    const headers = deriveStandardHeaders({
      method: "tools/call",
      params: { name: "도구", _meta: META },
    });
    expect(headers["mcp-name"]!.startsWith("=?base64?")).toBe(true);
  });

  it("returns nothing for a response-shaped message", () => {
    expect(deriveStandardHeaders({ jsonrpc: "2.0", id: 3, result: {} })).toEqual({});
  });
});

describe("collectParamHeaderAnnotations — spec constraints", () => {
  const base = (props: Record<string, unknown>) => ({
    type: "object",
    properties: props,
  });

  it("collects a valid string annotation with its path", () => {
    const outcome = collectParamHeaderAnnotations(
      base({ region: { type: "string", "x-mcp-header": "Region" } }),
    );
    expect(outcome.reason).toBeUndefined();
    expect(outcome.annotations).toEqual([{ headerName: "Region", path: ["region"] }]);
  });

  it("collects nested annotations reachable via properties-only chains", () => {
    const outcome = collectParamHeaderAnnotations(
      base({
        options: {
          type: "object",
          properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } },
        },
      }),
    );
    expect(outcome.annotations).toEqual([{ headerName: "Tenant", path: ["options", "tenant"] }]);
  });

  it("rejects an empty or non-tchar header name", () => {
    expect(
      collectParamHeaderAnnotations(base({ a: { type: "string", "x-mcp-header": "" } })).reason,
    ).toMatch(/invalid/);
    expect(
      collectParamHeaderAnnotations(base({ a: { type: "string", "x-mcp-header": "bad name" } }))
        .reason,
    ).toMatch(/invalid/);
    expect(
      collectParamHeaderAnnotations(base({ a: { type: "string", "x-mcp-header": "bad\r\nname" } }))
        .reason,
    ).toMatch(/invalid/);
  });

  it("rejects case-insensitive duplicate names", () => {
    const outcome = collectParamHeaderAnnotations(
      base({
        a: { type: "string", "x-mcp-header": "Region" },
        b: { type: "string", "x-mcp-header": "region" },
      }),
    );
    expect(outcome.reason).toMatch(/duplicate/);
  });

  it("rejects annotations on number (and other non-primitive) types", () => {
    expect(
      collectParamHeaderAnnotations(base({ a: { type: "number", "x-mcp-header": "N" } })).reason,
    ).toMatch(/non-primitive/);
    expect(
      collectParamHeaderAnnotations(base({ a: { type: "object", "x-mcp-header": "O" } })).reason,
    ).toMatch(/non-primitive/);
  });

  it("rejects an annotation inside an array/composition/conditional subtree", () => {
    for (const schema of [
      base({ a: { type: "array", items: { type: "string", "x-mcp-header": "X" } } }),
      base({ a: { oneOf: [{ type: "string", "x-mcp-header": "X" }] } }),
      base({ a: { allOf: [{ type: "string", "x-mcp-header": "X" }] } }),
      base({ a: { if: { type: "string", "x-mcp-header": "X" } } }),
    ]) {
      expect(collectParamHeaderAnnotations(schema).reason).toMatch(/outside a properties-only/);
    }
  });

  it("accepts a schema with no annotations at all", () => {
    const outcome = collectParamHeaderAnnotations(base({ q: { type: "string" } }));
    expect(outcome.annotations).toEqual([]);
  });
});

describe("extractParamHeaders — mirroring + omission rules", () => {
  const ANNOTATIONS = [
    { headerName: "Region", path: ["region"] },
    { headerName: "Flag", path: ["flag"] },
    { headerName: "Count", path: ["count"] },
    { headerName: "Tenant", path: ["options", "tenant"] },
  ];

  it("mirrors present values with type conversion", () => {
    expect(
      extractParamHeaders(ANNOTATIONS, {
        region: "us-west1",
        flag: false,
        count: -7,
        options: { tenant: "acme" },
      }),
    ).toEqual({
      "mcp-param-region": "us-west1",
      "mcp-param-flag": "false",
      "mcp-param-count": "-7",
      "mcp-param-tenant": "acme",
    });
  });

  it("omits missing and null values (server MUST NOT expect the header)", () => {
    expect(extractParamHeaders(ANNOTATIONS, { region: null, options: {} })).toEqual({});
  });

  it("omits non-mirrorable runtime values (float where integer was declared)", () => {
    expect(extractParamHeaders([{ headerName: "Count", path: ["count"] }], { count: 1.5 })).toEqual(
      {},
    );
  });

  it("encodes values that are not header-safe", () => {
    const headers = extractParamHeaders([{ headerName: "Greeting", path: ["g"] }], {
      g: "Hello, 世界",
    });
    expect(headers["mcp-param-greeting"]).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
  });
});
