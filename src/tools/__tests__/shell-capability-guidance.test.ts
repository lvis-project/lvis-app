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

  it.each(["-r", "-R", "--recursive", "-a", "--archive", "-av", "--suffix -- -a"])(
    "routes the denied recursive copy for %s to the structured copy tool",
    (flag) => {
      const denial = inspect(`cp ${flag} ./source ./destination`);
      expect(denial?.kind).toBe("recursive-traversal");
      expect(denial?.reason).toContain("copy_path({sourcePath, destinationPath})");
      expect(denial?.reason).toContain(locale === "en" ? "binary/text file" : "바이너리·텍스트 파일");
      expect(denial?.reason).toContain(locale === "en" ? "complete directory tree" : "전체 디렉터리 트리");
      expect(denial?.reason).toContain(locale === "en" ? "hidden ordinary entries" : "숨김 항목");
      expect(denial?.reason).toContain(locale === "en"
        ? "tool does not append the source basename"
        : "도구가 원본 이름을 자동으로 덧붙이지 않습니다");
      expect(denial?.reason).toContain(locale === "en" ? "UTF-8 text only" : "UTF-8 텍스트만");
      expect(denial?.reason).not.toContain("read_file + write_file");
      expect(denial?.reason).not.toContain(locale === "en" ? "no built-in equivalent" : "내장 대안이 없습니다");
      expect(denial?.reason).toContain(locale === "en"
        ? "Recommended LVIS built-in tool"
        : "LVIS 내장 도구 권장");
    },
  );

  it.each(["tar -xf ./archive.tar", "tar -xzf ./archive.tar.gz", "tar -cf ./archive.tar ./source"])(
    "scopes the shared tar guidance to supported extraction for %s",
    (command) => {
      const denial = inspect(command);
      expect(denial?.kind).toBe("recursive-traversal");
      expect(denial?.reason).toContain("extract_archive({archivePath, destinationPath})");
      expect(denial?.reason).toContain(locale === "en"
        ? "tar or gzip-compressed tar extraction only"
        : "tar 또는 gzip으로 압축한 tar의 압축을 해제할 때만");
      expect(denial?.reason).toContain(locale === "en"
        ? "Archive creation and ZIP extraction have no built-in equivalent"
        : "아카이브 생성과 ZIP 압축 해제에는 내장 대안이 없으므로");
      expect(denial?.reason).toContain(locale === "en"
        ? "report those operations as unavailable"
        : "해당 작업을 지원하지 않는다고 알리세요");
      expect(denial?.reason).toContain("tar -tf");
      expect(denial?.reason).toContain(locale === "en" ? "listing only" : "목록 조회만");
      expect(denial?.reason).not.toContain("ls/cat");
      expect(denial?.reason).not.toContain(locale === "en"
        ? "Recommended LVIS built-in tool"
        : "LVIS 내장 도구 권장");
    },
  );

  it.each(["cp -R ./source ./destination", "tar -xf ./archive.tar"])(
    "keeps the destination and authority conditions in returned guidance for %s",
    (command) => {
      const denial = inspect(command);
      expect(denial?.kind).toBe("recursive-traversal");
      expect(denial?.reason).toContain(locale === "en" ? "must be absent" : "존재하지 않아야");
      expect(denial?.reason).toContain(locale === "en" ? "parent must already exist" : "상위 디렉터리는 이미 존재해야");
      expect(denial?.reason).toContain(locale === "en" ? "no overwrite or merge" : "덮어쓰기와 병합은 지원하지 않습니다");
      expect(denial?.reason).toContain(locale === "en" ? "write-scope checks and approval" : "기존 쓰기 범위 검사와 승인");
      expect(denial?.reason).toContain(locale === "en"
        ? "Keep the original target path and requested scope"
        : "원래 대상 경로와 요청한 작업 범위를 그대로 유지");
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
      expect(denial?.reason).not.toContain("extract_archive");
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
  it.each([
    "cp -- ./source.bin ./destination.bin",
    "cp -- -a ./destination.bin",
    "cp -- --archive ./destination.bin",
    "tar -tf ./archive.tar",
  ])(
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

  it("advertises structured transfers without relaxing shell capabilities", () => {
    const description = new BashTool().description;
    expect(description).toContain("Recursive copying");
    expect(description).toContain("archive creation/extraction");
    expect(description).toContain("remain blocked in this shell");
    expect(description).toContain("copy_path");
    expect(description).toContain("extract_archive");
    expect(description).toContain("tar or gzip-compressed tar extraction");
    expect(description).toContain("absent exact destination with an existing parent");
    expect(description).toContain("no overwrite or merge");
    expect(description).toContain("ZIP extraction and archive creation have no built-in equivalent");
  });
});
