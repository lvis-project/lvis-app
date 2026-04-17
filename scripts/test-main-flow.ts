import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime } from "../src/plugins/runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const fixturesDir = resolve(projectRoot, "fixtures");
const workspace = resolve(projectRoot, ".pageindex-workspace-main-flow");

async function main() {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(fixturesDir, { recursive: true });

  const sampleDocPath = resolve(fixturesDir, "sample-main-flow.md");
  await writeFile(sampleDocPath, "# Main Flow\n\n통합 플로우 테스트 문서입니다.\n", "utf-8");

  const runtime = new PluginRuntime({
    hostRoot: projectRoot,
    registryPath: resolve(projectRoot, "plugins/registry.json"),
    configOverrides: {
      pageindex: {
        scanFolders: ["fixtures"],
        workspace: ".pageindex-workspace-main-flow",
        testMode: true,
      },
    },
  });
  const sessionId = `main-flow-${Date.now()}`;

  try {
    await runtime.startAll();
    const scan = (await runtime.call("index_scan")) as { scanned: number; indexed: number };
    const docs = (await runtime.call("index_documents")) as Array<{ id: string }>;
    const preview = (await runtime.call("chat_preview", { question: "문서 요약" })) as { preview: string };

    await runtime.call("meeting_start", {
      sessionId,
      context: { locale: "ko", contextHint: "main process integration flow" },
    });
    await runtime.call("meeting_push_chunk", {
      sessionId,
      chunk: {
        pcm16leMono: [0x00, 0x01],
        sampleRate: 16000,
        startSec: 0,
        endSec: 1.1,
      },
    });
    const finalSummary = (await runtime.call("meeting_stop", { sessionId })) as { title: string; summary: string };
    const transcript = (await runtime.call("meeting_transcript", { sessionId })) as Array<{ id: string }>;

    if (scan.scanned < 1) throw new Error("index scan이 수행되지 않았습니다.");
    if (docs.length < 1) throw new Error("index documents가 비어 있습니다.");
    if (!preview.preview) throw new Error("chat preview가 비어 있습니다.");
    if (transcript.length < 1) throw new Error("meeting transcript가 비어 있습니다.");
    if (!finalSummary.summary) throw new Error("meeting final summary가 비어 있습니다.");

    console.log(
      JSON.stringify(
        {
          ok: true,
          pageindex: {
            scan,
            documentCount: docs.length,
            preview: preview.preview.slice(0, 120),
          },
          meeting: {
            sessionId,
            transcriptCount: transcript.length,
            finalTitle: finalSummary.title,
            finalSummary: finalSummary.summary,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.stopAll();
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
