/**
 * web_search provider-response validation.
 *
 * The external search-provider boundary is untrusted. These tests pin the
 * shape guards that replaced the previous `as any` + `?? []` parsing: a
 * well-formed response normalizes to `{title,snippet,url}` hits, and a
 * shape-mismatched response throws {@link WebSearchShapeError} so the tool can
 * surface `isError:true` with a diagnostic instead of a silent empty result.
 */
import { describe, it, expect } from "vitest";
import {
  parseTavilyResponse,
  parseSerperResponse,
  WebSearchShapeError,
} from "../tools.js";

describe("parseTavilyResponse", () => {
  it("normalizes a well-formed Tavily response", () => {
    const results = parseTavilyResponse({
      results: [
        { title: "T", content: "C", url: "https://e.com" },
        { title: "T2", content: "C2", url: "https://e2.com" },
      ],
    });
    expect(results).toEqual([
      { title: "T", snippet: "C", url: "https://e.com" },
      { title: "T2", snippet: "C2", url: "https://e2.com" },
    ]);
  });

  it("coerces missing string fields to empty strings", () => {
    const results = parseTavilyResponse({ results: [{ url: "https://e.com" }] });
    expect(results).toEqual([{ title: "", snippet: "", url: "https://e.com" }]);
  });

  it("throws when `results` is absent (shape change)", () => {
    expect(() => parseTavilyResponse({ answer: "no results key" })).toThrowError(
      WebSearchShapeError,
    );
  });

  it("throws when `results` is not an array", () => {
    expect(() => parseTavilyResponse({ results: "oops" })).toThrowError(WebSearchShapeError);
  });

  it("throws when the body is not an object", () => {
    expect(() => parseTavilyResponse("not json object")).toThrowError(WebSearchShapeError);
    expect(() => parseTavilyResponse(null)).toThrowError(WebSearchShapeError);
  });
});

describe("parseSerperResponse", () => {
  it("normalizes a well-formed Serper response", () => {
    const results = parseSerperResponse({
      organic: [{ title: "T", snippet: "S", link: "https://e.com" }],
    });
    expect(results).toEqual([{ title: "T", snippet: "S", url: "https://e.com" }]);
  });

  it("throws when `organic` is absent (shape change)", () => {
    expect(() => parseSerperResponse({ results: [] })).toThrowError(WebSearchShapeError);
  });

  it("throws when `organic` is not an array", () => {
    expect(() => parseSerperResponse({ organic: 42 })).toThrowError(WebSearchShapeError);
  });

  it("throws when the body is not an object", () => {
    expect(() => parseSerperResponse(undefined)).toThrowError(WebSearchShapeError);
  });
});
