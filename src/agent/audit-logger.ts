/**
 * Audit Logger — §4.5.5 Post-Turn Audit Hook
 *
 * 매 턴마다 구조화된 JSON 로그를 기록.
 * 향후 Governance Layer (§14.2) Elasticsearch 연동 대비.
 * 현재는 ~/.lvis/audit/ 디렉토리에 JSONL 파일로 저장.
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  type: "turn" | "tool_call" | "approval" | "error";
  input?: string;
  output?: string;
  toolCalls?: Array<{ name: string; isError: boolean }>;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  route?: string;
}

export class AuditLogger {
  private readonly auditDir: string;
  private readonly logFile: string;

  constructor() {
    this.auditDir = join(homedir(), ".lvis", "audit");
    if (!existsSync(this.auditDir)) {
      mkdirSync(this.auditDir, { recursive: true });
    }
    // 일별 로그 파일
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(this.auditDir, `${date}.jsonl`);
  }

  log(entry: AuditEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.logFile, line, "utf-8");
    } catch {
      // Audit 실패가 앱 동작을 차단하면 안 됨
    }
  }

  logTurn(params: {
    sessionId: string;
    input: string;
    output: string;
    toolCalls: Array<{ name: string; isError: boolean }>;
    tokenUsage?: { inputTokens: number; outputTokens: number };
    route: string;
  }): void {
    this.log({
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId,
      type: "turn",
      input: params.input.slice(0, 500),
      output: params.output.slice(0, 500),
      toolCalls: params.toolCalls,
      tokenUsage: params.tokenUsage,
      route: params.route,
    });
  }
}
