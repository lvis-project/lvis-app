import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { getLocale, setLocale, type Locale } from "../../i18n/index.js";
import { buildPolicyDenialGuidance } from "../invocation-runner.js";
import { findShellPathPolicyViolation } from "../shell-path-policy.js";
import { BashTool } from "../shell-tools.js";

let root: string;
let previousLocale: Locale;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shell-capability-guidance-"));
  previousLocale = getLocale();
});

afterEach(async () => {
  setLocale(previousLocale);
  await cleanupTmpDir(root);
});

function inspect(command: string, fencedReads = false) {
  return findShellPathPolicyViolation(command, root, root, [], fencedReads);
}

describe.each(["en", "ko"] as const)("shell capability guidance in %s", (locale) => {
  beforeEach(() => setLocale(locale));

  it.each(["-r", "-R", "--recursive", "-a", "--archive", "-av"])(
    "states the recursive copying limit for %s without promising a text transfer", (flag) => {
    const denial = inspect(`cp ${flag} ./source ./destination`);
    expect(denial?.kind).toBe("recursive-traversal");
    expect(denial?.reason).toContain(locale === "en"
      ? "Recursive copying is unavailable"
      : "재귀 복사를 지원하지 않습니다");
    expect(denial?.reason).toContain("cp");
    expect(denial?.reason).toContain(locale === "en" ? "single regular file" : "일반 파일 하나");
    expect(denial?.reason).not.toContain("read_file + write_file");
    expect(denial?.reason).not.toContain(locale === "en"
      ? "Recommended LVIS built-in tool"
      : "LVIS 내장 도구 권장");
  });

  it.each(["tar -xf ./archive.tar", "tar -cf ./archive.tar ./source"])(
    "states the archive capability limit for %s",
    (command) => {
      const denial = inspect(command);
      expect(denial?.kind).toBe("recursive-traversal");
      expect(denial?.reason).toContain(locale === "en"
        ? "Archive creation and extraction are unavailable"
        : "아카이브 생성과 압축 해제를 지원하지 않습니다");
      expect(denial?.reason).toContain("tar -tf");
      expect(denial?.reason).toContain(locale === "en" ? "listing only" : "목록 조회만");
      expect(denial?.reason).not.toContain("ls/cat");
      expect(denial?.reason).not.toContain(locale === "en"
        ? "Recommended LVIS built-in tool"
        : "LVIS 내장 도구 권장");
    },
  );

  it.each(["unzip ./archive.zip", "zip ./archive.zip ./source"])(
    "does not recommend a nonexistent builtin for %s",
    (command) => {
      const denial = inspect(command);
      expect(denial?.kind).toBe("recursive-traversal");
      expect(denial?.reason).toContain(locale === "en" ? "no built-in equivalent" : "내장 대안이 없습니다");
      expect(denial?.reason).toContain(locale === "en" ? "Report the operation as unavailable" : "해당 작업을 지원하지 않는다고 알리세요");
      expect(denial?.reason).not.toContain(locale === "en"
        ? "Recommended LVIS built-in tool"
        : "LVIS 내장 도구 권장");
    },
  );

  it("retains genuine builtin guidance for a fenced read traversal", () => {
    const denial = inspect("find ./source -type f", true);
    expect(denial?.kind).toBe("recursive-traversal");
    expect(denial?.reason).toContain("glob_files");
    expect(denial?.reason).toContain("list_files");
    expect(denial?.reason).toContain(locale === "en"
      ? "Recommended LVIS built-in tool"
      : "LVIS 내장 도구 권장");
  });

  it("makes generic restructuring guidance conditional on an actual supported operation", () => {
    const guidance = buildPolicyDenialGuidance({
      rule: "shell-path-policy/recursive-traversal",
      retry: "never",
      alternative: "restructure-command",
      allowedDirectories: [root],
    });
    expect(guidance).toContain(locale === "en"
      ? "only if it supports the requested operation"
      : "요청한 작업을 지원하는 경우에만");
    expect(guidance).toContain(locale === "en"
      ? "report that operation as unavailable"
      : "해당 작업을 지원하지 않는다고 알리세요");
    expect(guidance).not.toContain(root);
  });
});

describe("advertised shell operations retain their policy boundary", () => {
  it.each(["cp -- ./source.bin ./destination.bin", "tar -tf ./archive.tar"])(
    "keeps the distinct supported operation admitted: %s",
    (command) => expect(inspect(command)).toBeNull(),
  );

  it.each([
    "cp -- ./source.bin ../outside.bin",
    "cp -- ./source.bin ./.ssh/secret",
    "tar -tf ./archive.tar --checkpoint-action=exec=sh",
  ])("keeps the existing refusal for %s", (command) => {
    expect(inspect(command)).not.toBeNull();
  });

  it("advertises the unavailable shell capabilities before execution", () => {
    const description = new BashTool().description;
    expect(description).toContain("Recursive copying");
    expect(description).toContain("archive creation/extraction");
    expect(description).toContain("blocked");
  });
});
