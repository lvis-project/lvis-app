/**
 * URI templates: what the host will catalogue, and what filling one can produce.
 *
 * The property that matters is not "does it parse" — it is that **nothing a user types
 * can move the URI off the path the server published**. Level 1 expansion percent-
 * encodes, so the tests that earn their keep are the ones that try to escape the
 * segment: traversal, a scheme change, an injected query, a second variable's worth of
 * structure.
 */
import { describe, expect, it } from "vitest";
import {
  expandResourceUriTemplate,
  isUsableResourceUriTemplate,
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
  resourceTemplateVariables,
} from "../mcp-resource-template-bounds.js";
import { isUsableResourceUri, MCP_RESOURCE_URI_MAX_CHARS } from "../mcp-resource-bounds.js";

describe("isUsableResourceUriTemplate", () => {
  it("accepts Level 1 templates over schemes a resource may use", () => {
    for (const template of [
      "file:///project/{path}",
      "git://repo/{ref}",
      "github://repos/{owner}/{repo}/issues/{number}",
      "schema://users/{id}",
      "acme-internal://records/{recordId}",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(true);
    }
  });

  it("refuses every RFC 6570 operator and modifier", () => {
    // This is the load-bearing case. `{+path}` is RESERVED expansion — it does not
    // encode `/`, so accepting it would hand the server a user-supplied traversal. The
    // rest are refused for the same reason in weaker forms: anything that is not plain
    // substitution changes what the user's characters can do to the URI's structure.
    for (const template of [
      "file:///project/{+path}", // reserved expansion — the traversal one
      "file:///project/{#frag}",
      "file:///project{/segments}",
      "file:///project{?query}",
      "file:///project{&more}",
      "file:///project/{path*}", // explode
      "file:///project/{path:3}", // prefix modifier
      "file:///project/{}", // empty name
      "file:///project/{a b}", // space in name
      "file:///project/{", // unmatched
      "file:///project/}",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(false);
    }
  });

  it("refuses a MIXED template — one good variable plus one operator", () => {
    // The realistic hostile shape, and the only one where the two counts actually differ
    // while a strict match exists. A predicate that checked "is there at least one Level 1
    // expression" would accept every one of these.
    for (const template of [
      "file:///project/{ok}/{+path}",
      "file:///project/{ok}{?query}",
      "file:///project/{ok}/{path*}",
      "file:///project/{ok}/{",
    ]) {
      expect(isUsableResourceUriTemplate(template), template).toBe(false);
    }
    // Nested braces are the case where the COUNTS agree (one loose run, one strict match)
    // — the skeleton is what refuses it, because a leftover brace is not a legal URI
    // character. Every fixture above dies at the skeleton too; this one isolates it, and
    // nothing here isolates the count check, which the module comment says outright is
    // redundant in practice and kept for the reason stated there.
    expect(isUsableResourceUriTemplate("file:///{a{b}")).toBe(false);
  });

  it("refuses a template whose LITERAL part already contains a dot segment", () => {
    // Not a security rule — the expansion refuses these anyway — but a dead-row one. A
    // plain resource may legitimately be published as `file:///a/../b` and
    // `isUsableResourceUri` allows it; a TEMPLATE shaped that way would catalogue and
    // then have every read refused, which is a picker entry that exists only to fail.
    expect(isUsableResourceUriTemplate("file:///project/../{path}")).toBe(false);
    expect(isUsableResourceUriTemplate("file:///project/./{path}")).toBe(false);
    // The ordinary URI predicate does NOT share this rule, and should not: that one
    // answers a question about a URI the SERVER chose in full.
    expect(isUsableResourceUri("file:///project/../secret")).toBe(true);
  });

  it("refuses a template with no variable at all", () => {
    // A concrete URI is not a template. Accepting one would give the same resource two
    // code paths — a listed URI and a zero-variable template — with different gates.
    expect(isUsableResourceUriTemplate("file:///project/README.md")).toBe(false);
  });

  it("holds the skeleton to the SAME rules a plain URI must pass", () => {
    // Written by removing the expressions and validating what is left, so a template
    // cannot smuggle in something a URI could not. If these ever diverge, a server gets
    // two different answers to "may I publish this scheme".
    expect(isUsableResourceUriTemplate("ui://widget/{id}")).toBe(false); // reserved scheme
    expect(isUsableResourceUriTemplate("javascript:alert({x})")).toBe(false);
    expect(isUsableResourceUriTemplate("no-scheme/{path}")).toBe(false);
    expect(isUsableResourceUriTemplate("file:///a b/{path}")).toBe(false); // raw space
    expect(isUsableResourceUriTemplate(`file:///${"a".repeat(MCP_RESOURCE_URI_MAX_CHARS)}/{p}`))
      .toBe(false);
    // …and the invisible-character class the URI rule refuses, via the shared predicate.
    expect(isUsableResourceUriTemplate(`file:///poli${String.fromCodePoint(0x200b)}cy/{p}`))
      .toBe(false);
  });

  it("bounds how many variables a form may ask for", () => {
    const ok = Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES },
      (_, i) => `{v${i}}`).join("/");
    const tooMany = Array.from({ length: MCP_RESOURCE_TEMPLATE_MAX_VARIABLES + 1 },
      (_, i) => `{v${i}}`).join("/");
    expect(isUsableResourceUriTemplate(`file:///${ok}`)).toBe(true);
    expect(isUsableResourceUriTemplate(`file:///${tooMany}`)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const value of [42, null, undefined, {}, ["file:///{p}"]]) {
      expect(isUsableResourceUriTemplate(value as unknown), String(value)).toBe(false);
    }
  });
});

describe("resourceTemplateVariables", () => {
  it("lists names in declaration order, once each", () => {
    // One field per name, and the order the dialog renders. A repeated variable is one
    // field substituted at every occurrence, which is what RFC 6570 says and what a user
    // filling `{owner}/{repo}/{owner}` expects.
    expect(resourceTemplateVariables("github://repos/{owner}/{repo}/tree/{owner}"))
      .toEqual(["owner", "repo"]);
    expect(resourceTemplateVariables("file:///{path}")).toEqual(["path"]);
  });
});

describe("expandResourceUriTemplate", () => {
  const values = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("fills a template and produces a URI the ordinary predicate accepts", () => {
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "README.md" })))
      .toBe("file:///project/README.md");
    expect(expandResourceUriTemplate(
      "github://repos/{owner}/{repo}/issues/{number}",
      values({ owner: "acme", repo: "widgets", number: "42" }),
    )).toBe("github://repos/acme/widgets/issues/42");
  });

  it("substitutes a repeated variable at every occurrence", () => {
    expect(expandResourceUriTemplate("git://{ref}/diff/{ref}", values({ ref: "HEAD" })))
      .toBe("git://HEAD/diff/HEAD");
  });

  it("cannot be typed out of the segment the server published", () => {
    // THE case. Level 1 percent-encodes, so traversal, a scheme change, an injected
    // query and an injected fragment all become ordinary characters inside one segment.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "../../etc/passwd" })))
      .toBe("file:///project/..%2F..%2Fetc%2Fpasswd");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "a/b" })))
      .toBe("file:///project/a%2Fb");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "x?q=1" })))
      .toBe("file:///project/x%3Fq%3D1");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "x#frag" })))
      .toBe("file:///project/x%23frag");
    // And a value that looks like a whole other URI stays a value.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "javascript:alert(1)" })))
      .toBe("file:///project/javascript%3Aalert(1)");
  });

  it("cannot be typed into a DOT SEGMENT, which encoding does not touch", () => {
    // Found in review, and the case the traversal test above missed for the most
    // embarrassing reason: `../../etc/passwd` is neutralized by its SLASHES, and bare
    // `..` has none. `.` is unreserved, so `encodeURIComponent` returns it verbatim and
    // the server receives a real dot segment — `new URL()` and `fileURLToPath` both
    // resolve it, for non-special schemes too.
    expect(expandResourceUriTemplate(
      "file:///project/{dir}/{name}",
      values({ dir: "..", name: "id_rsa" }),
    )).toBeNull();
    // One level up is enough on its own, and `.` is refused with it — a value that means
    // "here" is not a resource name either.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: ".." }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "." }))).toBeNull();
    // Trimmed first, so padding buys nothing.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "  ..  " })))
      .toBeNull();
    // The accept case from the very first test in this describe — with `..` it escapes
    // `repos/` and names another repository's issue.
    expect(expandResourceUriTemplate(
      "github://repos/{owner}/{repo}/issues/{number}",
      values({ owner: "..", repo: "widgets", number: "42" }),
    )).toBeNull();
    // Checked on the FINISHED string, so a literal dot next to the variable cannot
    // compose one either — neither half is a dot segment on its own.
    expect(expandResourceUriTemplate("file:///project/.{x}/y", values({ x: "." }))).toBeNull();

    // WHATWG counts `.%2e`, `%2e.` and `%2e%2e` as double-dot segments too, case-
    // insensitively, and all of them resolve. A value cannot produce one alone — a typed
    // `%` becomes `%25` — so each needs a server LITERAL `%` beside the variable, which
    // is the same literal-plus-value composition as the case above, one encoding down.
    expect(expandResourceUriTemplate("file:///project/%{x}/id_rsa", values({ x: "2e." })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/%{x}/id_rsa", values({ x: "2E." })))
      .toBeNull();
    expect(expandResourceUriTemplate("file:///project/.%2{x}/id_rsa", values({ x: "e" })))
      .toBeNull();
    // …including when the whole segment is a server literal, which the discovery-time
    // check below also refuses — belt and braces on different sides of the same rule.
    expect(expandResourceUriTemplate("file:///project/%2e%2e/{name}", values({ name: "x" })))
      .toBeNull();
    // A SINGLE `%2e` is a plain `.` segment, which resolves to nothing at all — refused
    // with the bare `.` case for the same reason, not treated as traversal.
    expect(expandResourceUriTemplate("file:///project/%2{x}/id_rsa", values({ x: "e" })))
      .toBeNull();

    // …and a name that merely CONTAINS dots is still perfectly ordinary.
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "..hidden" })))
      .toBe("file:///project/..hidden");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "v1.2.3" })))
      .toBe("file:///project/v1.2.3");
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "..." })))
      .toBe("file:///project/...");
  });

  it("refuses a lone surrogate instead of throwing", () => {
    // `encodeURIComponent` RAISES on an unpaired surrogate, so without this the function
    // breaks the contract its own signature states. Reachable from the dialog, whose
    // `maxLength` clips a pasted string at 512 UTF-16 units and can cut an emoji in half.
    const clipped = `${"x".repeat(511)}😀`.slice(0, 512);
    expect(clipped.endsWith("\uD83D")).toBe(true);
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: clipped }))).toBeNull();
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: "\uDC00" }))).toBeNull();
    // The paired form is fine — this refuses broken input, not non-ASCII.
    expect(expandResourceUriTemplate("file:///p/{path}", values({ path: "😀" })))
      .toBe("file:///p/%F0%9F%98%80");
  });

  it("cannot be typed into a scheme the host reserves", () => {
    // The sharpest case, and it is REACHABLE: a variable in scheme position catalogues,
    // because the skeleton `x://host/x` is a legal server-custom scheme. Percent-encoding
    // does not help here — `javascript` and `ui` are already unreserved characters — so
    // the only thing standing between this and `javascript:alert(1)` is the final
    // re-validation of the EXPANSION with the ordinary URI predicate. These pin that it
    // is doing the work.
    expect(isUsableResourceUriTemplate("{scheme}://example.com/{path}")).toBe(true);
    expect(isUsableResourceUriTemplate("{scheme}:alert(1)")).toBe(true);

    expect(expandResourceUriTemplate("{scheme}:alert(1)", values({ scheme: "javascript" })))
      .toBeNull();
    expect(expandResourceUriTemplate("{scheme}://widget/{id}", values({ scheme: "ui", id: "x" })))
      .toBeNull();
    expect(expandResourceUriTemplate("{scheme}:x", values({ scheme: "data" }))).toBeNull();
    // `https:` is not reserved — it is LISTED and then refused at fetch time, by the
    // client, from the expansion. So the expansion itself must succeed, or that refusal
    // would never be the thing doing the work.
    expect(expandResourceUriTemplate("{scheme}://example.com/{path}",
      values({ scheme: "https", path: "r.pdf" }))).toBe("https://example.com/r.pdf");
  });

  it("refuses rather than substituting nothing", () => {
    // An empty expansion silently points at the directory above — a different resource
    // than the user asked for, and one they cannot see they asked for.
    expect(expandResourceUriTemplate("file:///project/{path}", values({}))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "" }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/{path}", values({ path: "   " }))).toBeNull();
    expect(expandResourceUriTemplate(
      "file:///project/{path}",
      values({ path: "x".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS + 1) }),
    )).toBeNull();
  });

  it("refuses to expand a template it would not have catalogued", () => {
    // The gate is not "was this string listed" — it is re-checked here, so a caller that
    // reached this function with an unlisted or malformed template gets nothing.
    expect(expandResourceUriTemplate("file:///project/{+path}", values({ path: "x" }))).toBeNull();
    expect(expandResourceUriTemplate("ui://widget/{id}", values({ id: "x" }))).toBeNull();
    expect(expandResourceUriTemplate("file:///project/README.md", values({}))).toBeNull();
  });

  it("refuses an expansion that outgrows the URI bound", () => {
    const long = "x".repeat(MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS);
    const template = `file:///${Array.from({ length: 8 }, (_, i) => `{v${i}}`).join("/")}`;
    const filled = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`v${i}`, long]),
    );
    expect(expandResourceUriTemplate(template, values(filled))).toBeNull();
  });
});
