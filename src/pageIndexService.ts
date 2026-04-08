import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FolderAutoIndexer,
  LvisPageIndexPlugin,
  type PageIndexDocumentMeta,
} from "@lvis/plugin-pageindex";

export interface LvisPageIndexServiceOptions {
  scanFolders: string[];
  workspace: string;
  pageIndexRoot?: string;
  apiKey?: string;
  testMode?: boolean;
}

export class LvisPageIndexService {
  private readonly plugin: LvisPageIndexPlugin;
  private readonly autoIndexer: FolderAutoIndexer;
  private readonly workspace: string;
  private started = false;

  constructor(private readonly options: LvisPageIndexServiceOptions) {
    this.workspace = resolve(options.workspace);
    this.plugin = new LvisPageIndexPlugin({
      workspace: this.workspace,
      pageIndexRoot: options.pageIndexRoot,
      apiKey: options.apiKey,
      testMode: options.testMode,
      onWorkerStdout: (line) => {
        if (process.env.LVIS_VERBOSE === "1") {
          console.log(`[pageindex-worker] ${line}`);
        }
      },
      onWorkerStderr: (line) => {
        console.error(`[pageindex-worker:error] ${line}`);
      },
    });

    this.autoIndexer = new FolderAutoIndexer({
      client: this.plugin,
      folders: options.scanFolders,
      intervalMs: 30_000,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await mkdir(this.workspace, { recursive: true });
    await this.plugin.start();
    await this.autoIndexer.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.autoIndexer.stop();
    await this.plugin.stop();
    this.started = false;
  }

  async forceScan() {
    return this.autoIndexer.scanOnce();
  }

  async listDocuments(): Promise<PageIndexDocumentMeta[]> {
    return this.plugin.listDocuments();
  }

  async getKnowledgePreview(question: string): Promise<{
    question: string;
    documentCount: number;
    documentName?: string;
    preview: string;
  }> {
    const docs = await this.plugin.listDocuments();
    if (docs.length === 0) {
      return {
        question,
        documentCount: 0,
        preview: "인덱싱된 문서가 없습니다.",
      };
    }

    const target = docs[0];
    const structure = await this.plugin.getDocumentStructure(target.id);
    let pages = "1";
    if (Array.isArray(structure) && structure.length > 0) {
      const first = structure[0] as Record<string, unknown>;
      const start = Number(first.start_index ?? first.line_num ?? 1);
      if (Number.isFinite(start) && start > 0) {
        pages = String(start);
      }
    }

    const pageContent = await this.plugin.getPageContent(target.id, pages);
    const preview = pageContent.map((item) => item.content).join("\n").slice(0, 1200);
    return {
      question,
      documentCount: docs.length,
      documentName: target.doc_name,
      preview,
    };
  }
}
