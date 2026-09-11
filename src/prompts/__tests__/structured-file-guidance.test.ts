import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLocale, setLocale, type Locale } from "../../i18n/index.js";
import { createFileTools } from "../../tools/file-tools.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { makePromptMemorySource } from "./test-helpers.js";

let previousLocale: Locale;

beforeEach(() => {
  previousLocale = getLocale();
});

afterEach(() => setLocale(previousLocale));

function buildFileToolPrompt() {
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerBatch(createFileTools());
  const prompt = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource(),
    toolRegistry,
  }).build();
  return { prompt, toolRegistry };
}

describe.each(["en", "ko"] as const)("structured file guidance in %s", (locale) => {
  beforeEach(() => setLocale(locale));

  it.each([
    { name: "copy_path", sourceField: "sourcePath" },
    { name: "extract_archive", sourceField: "archivePath" },
  ])("advertises the registered builtin and its real input fields for $name", ({ name, sourceField }) => {
    const { prompt, toolRegistry } = buildFileToolPrompt();
    const tool = toolRegistry.findByName(name);

    expect(tool, `${name} must be registered before guidance advertises it`).toMatchObject({
      name,
      source: "builtin",
      category: "write",
    });
    expect(tool!.toJsonSchema()).toMatchObject({
      properties: {
        [sourceField]: expect.any(Object),
        destinationPath: expect.any(Object),
      },
    });
    expect(prompt).toContain(`${name}({${sourceField}, destinationPath})`);
    expect(prompt).toContain(`**${name}**`);
    expect(prompt).toContain(tool!.description);
  });

  it("states transfer scope, unsupported operations and completion limits in the composed prompt", () => {
    const { prompt } = buildFileToolPrompt();

    expect(prompt).toContain(locale === "en"
      ? "complete directory tree, including hidden ordinary entries"
      : "숨김 항목을 포함한 전체 디렉터리 트리");
    expect(prompt).toContain(locale === "en"
      ? "tar or gzip-compressed tar extraction only"
      : "tar 또는 gzip으로 압축한 tar의 압축을 해제할 때만");
    expect(prompt).toContain(locale === "en"
      ? "ZIP extraction and archive creation have no built-in equivalent"
      : "ZIP 압축 해제와 아카이브 생성에는 내장 대안이 없습니다");
    expect(prompt).toContain(locale === "en"
      ? "Both paths must be within admitted roots and pass existing write approvals"
      : "두 경로 모두 허용된 루트 안에 있어야 하며 기존 쓰기 승인을 거칩니다");
    expect(prompt).toContain(locale === "en"
      ? "tool never appends a source basename"
      : "도구가 원본 이름을 자동으로 덧붙이지 않습니다");
    expect(prompt).toContain(locale === "en"
      ? "first determine the intended new child path"
      : "최종적으로 생성할 하위 경로를 먼저 확인하세요");
    expect(prompt).toContain(locale === "en"
      ? "destination must be absent and its parent must already exist"
      : "대상 경로는 존재하지 않아야 하고 상위 디렉터리는 이미 존재해야 합니다");
    expect(prompt).toContain(locale === "en"
      ? "do not overwrite or merge"
      : "덮어쓰기와 병합을 지원하지 않습니다");
    expect(prompt).toContain(locale === "en"
      ? "report completion only after a successful result"
      : "성공 결과를 받은 뒤에만 완료했다고 알리세요");
    expect(prompt).toContain(locale === "en"
      ? "report any incomplete cleanup and residual paths"
      : "남은 경로와 정리 상태를 알리고");
  });
});
