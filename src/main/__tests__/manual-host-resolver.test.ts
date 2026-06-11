import { describe, expect, it } from "vitest";
import { parseHostsStyleText } from "../manual-host-resolver.js";

describe("parseHostsStyleText", () => {
  it("parses a single valid entry", () => {
    const result = parseHostsStyleText("10.182.192.174 host.example.com");
    expect(result).toEqual([["host.example.com", "10.182.192.174"]]);
  });

  it("parses multiple entries", () => {
    const raw = `10.1.2.3 api.example.com
10.4.5.6 cdn.example.com`;
    const result = parseHostsStyleText(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(["api.example.com", "10.1.2.3"]);
    expect(result[1]).toEqual(["cdn.example.com", "10.4.5.6"]);
  });

  it("skips blank lines", () => {
    const raw = `10.1.2.3 api.example.com

10.4.5.6 cdn.example.com`;
    const result = parseHostsStyleText(raw);
    expect(result).toHaveLength(2);
  });

  it("skips comment lines starting with #", () => {
    const raw = `# this is a comment
10.1.2.3 api.example.com
# another comment`;
    const result = parseHostsStyleText(raw);
    expect(result).toEqual([["api.example.com", "10.1.2.3"]]);
  });

  it("skips malformed entries with no whitespace separator", () => {
    const raw = `notanentry
10.1.2.3 valid.example.com`;
    const result = parseHostsStyleText(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(["valid.example.com", "10.1.2.3"]);
  });

  it("normalizes hostname to lowercase", () => {
    const result = parseHostsStyleText("10.1.2.3 HOST.EXAMPLE.COM");
    expect(result).toEqual([["host.example.com", "10.1.2.3"]]);
  });

  it("returns empty array for empty string", () => {
    expect(parseHostsStyleText("")).toEqual([]);
  });

  it("returns empty array for all-comment input", () => {
    const raw = `# comment one
# comment two`;
    expect(parseHostsStyleText(raw)).toEqual([]);
  });

  it("handles /etc/hosts-style tabs as whitespace separators", () => {
    const result = parseHostsStyleText("10.1.2.3\tapi.example.com");
    expect(result).toEqual([["api.example.com", "10.1.2.3"]]);
  });
});
