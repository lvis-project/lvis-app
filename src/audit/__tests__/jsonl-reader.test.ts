import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { inspectFile } from "../../__tests__/test-helpers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRecordFile, parseJsonlLines } from "../jsonl-reader.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

describe("parseJsonlLines", () => {
  it("drops blank lines and a trailing CR, and keeps line bytes otherwise", () => {
    expect(parseJsonlLines('{"a":1}\r\n\n   \n {"b":2} \n{"c":3}')).toEqual([
      '{"a":1}',
      ' {"b":2} ',
      '{"c":3}',
    ]);
    expect(parseJsonlLines("")).toEqual([]);
  });
});

describe("JsonlRecordFile", () => {
  interface Row { id: string }
  let dir: string;
  let path: string;
  let malformed: string[];
  let readFailures: unknown[];
  let file: JsonlRecordFile<Row>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-record-file-"));
    path = join(dir, "nested", "rows.jsonl");
    malformed = [];
    readFailures = [];
    file = new JsonlRecordFile<Row>(path, {
      accept: (parsed): parsed is Row =>
        typeof parsed === "object" && parsed !== null && typeof (parsed as Row).id === "string",
      onMalformedLine: (line) => malformed.push(line),
      onReadFailure: (err) => readFailures.push(err),
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(dir);
  });

  it("reads a missing file as empty", () => {
    expect(file.loadSync()).toEqual([]);
    expect(readFailures).toEqual([]);
  });

  it("keeps accepted records, drops rejected ones, reports malformed lines", async () => {
    await file.append({ id: "a" });
    await file.append({ id: "b" });
    writeFileSync(path, `${readFileSync(path, "utf-8")}not json\n{"id":7}\n`, "utf-8");
    expect(file.loadSync()).toEqual([{ id: "a" }, { id: "b" }]);
    expect(malformed).toEqual(["not json"]);
  });

  it("rewrite lands through temp+rename and leaves no temp file behind", async () => {
    await file.append({ id: "a" });
    const before = statSync(path);
    await file.rewrite([{ id: "z" }]);
    const after = inspectFile(path);
    expect(after.ino).not.toBe(before.ino);
    expect(after.text).toBe('{"id":"z"}\n');
    expect(readdirSync(join(dir, "nested"))).toEqual(["rows.jsonl"]);
    await file.rewrite([]);
    expect(inspectFile(path).text).toBe("");
  });

  it("creates the file owner-only", async () => {
    await file.append({ id: "a" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

  });
});
