import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LvisPageIndexService } from "../src/pageIndexService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const fixturesDir = resolve(projectRoot, "fixtures");
const workspace = resolve(projectRoot, ".pageindex-workspace-test");

async function main() {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(fixturesDir, { recursive: true });

  const sampleDocPath = resolve(fixturesDir, "sample-company-doc.md");
  await writeFile(
    sampleDocPath,
    [
      "# LVIS Company Handbook",
      "",
      "## Security Policy",
      "사내 문서는 최소 권한 원칙으로 접근합니다.",
      "",
      "## Product Roadmap",
      "Q2 목표는 검색 기반 업무 자동화입니다.",
      "",
      "## Support Guide",
      "문제 발생 시 플랫폼팀으로 문의합니다.",
      "",
    ].join("\n"),
    "utf-8",
  );

  const service = new LvisPageIndexService({
    scanFolders: [fixturesDir],
    workspace,
    testMode: true,
  });

  try {
    await service.start();
    const scan = await service.forceScan();
    const docs = await service.listDocuments();
    const preview = await service.getKnowledgePreview("보안 정책 핵심 알려줘");

    if (docs.length < 1) {
      throw new Error("문서 목록이 비어 있습니다.");
    }
    if (scan.indexed < 1 && docs.length < 1) {
      throw new Error(`인덱싱 결과가 비어 있습니다. scan=${JSON.stringify(scan)}`);
    }
    if (!preview.preview || preview.preview.length === 0) {
      throw new Error("미리보기 텍스트를 가져오지 못했습니다.");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          scan,
          documents: docs.map((doc) => ({ id: doc.id, name: doc.doc_name })),
          preview: preview.preview,
        },
        null,
        2,
      ),
    );
  } finally {
    await service.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
