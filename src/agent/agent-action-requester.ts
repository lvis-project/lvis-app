/**
 * Agent Action Requester — §8 Agent Hub Approval Caller Skeleton
 *
 * AgentHub이 에이전트 자율 행동(파일 공유, 작업 위임, 외부 API 호출)을
 * 실행하기 전에 ApprovalGate를 통해 사용자 승인을 요청하는 계약 레이어.
 *
 * - AgentAction 유니온: 3가지 행동 타입 (Phase 2 골격, Phase 3 확장 예정)
 * - AgentActionRequester 인터페이스: 호출자 계약
 * - DefaultAgentActionRequester: ApprovalGate DI 구현체
 * - isAllowed(): ApprovalChoice → boolean 헬퍼
 *
 * @internal Phase 2 stub — Phase 3에서 ConversationLoop 연동
 */
import { randomUUID } from "node:crypto";
import type { ApprovalGate, ApprovalDecision, ApprovalChoice } from "../core/approval-gate.js";

// ─── AgentAction 유니온 ───────────────────────────────

/** 에이전트가 파일을 외부 수신자에게 공유하는 행동 */
export interface AgentFileShareAction {
  type: "file-share";
  /** 공유할 파일의 절대 경로 */
  filePath: string;
  /** 수신자 식별자 (이메일, 슬랙 ID 등) */
  recipient: string;
  /** 공유 이유 (사용자에게 표시) */
  reason: string;
}

/** 에이전트가 하위 에이전트 또는 플러그인에 작업을 위임하는 행동 */
export interface AgentTaskDelegateAction {
  type: "task-delegate";
  /** 위임 대상 에이전트/플러그인 ID */
  targetAgentId: string;
  /** 위임할 작업 설명 */
  taskDescription: string;
  /** 위임 이유 (사용자에게 표시) */
  reason: string;
}

/** 에이전트가 외부 API를 호출하는 행동 */
export interface AgentExternalApiCallAction {
  type: "external-api-call";
  /** 호출할 엔드포인트 (host + path, 자격증명 제외) */
  endpoint: string;
  /** HTTP 메서드 */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** 호출 이유 (사용자에게 표시) */
  reason: string;
}

/** §8 에이전트 행동 유니온 */
export type AgentAction =
  | AgentFileShareAction
  | AgentTaskDelegateAction
  | AgentExternalApiCallAction;

// ─── 승인 결과 헬퍼 ──────────────────────────────────

/**
 * ApprovalChoice를 boolean으로 변환.
 * allow-once / allow-always → true, 나머지 → false.
 */
export function isAllowed(choice: ApprovalChoice): boolean {
  return choice === "allow-once" || choice === "allow-always";
}

// ─── AgentActionRequester 인터페이스 ─────────────────

export interface AgentActionRequester {
  /**
   * 에이전트 행동 실행 전 사용자 승인을 요청한다.
   * ApprovalGate.requestAndWait()를 통해 렌더러 다이얼로그를 트리거.
   * ConversationLoop turn을 블로킹 (await).
   */
  request(action: AgentAction): Promise<ApprovalDecision>;
}

// ─── DefaultAgentActionRequester ─────────────────────

/**
 * ApprovalGate를 사용하는 기본 구현체.
 * category "agent-action"으로 고정하여 렌더러 ToolApprovalDialog에서
 * "작업 승인 필요" 타이틀로 분기됨 (renderer.tsx:676).
 */
export class DefaultAgentActionRequester implements AgentActionRequester {
  private readonly gate: ApprovalGate;

  constructor(gate: ApprovalGate) {
    this.gate = gate;
  }

  async request(action: AgentAction): Promise<ApprovalDecision> {
    const id = randomUUID();
    const createdAt = Date.now();

    // action.type → toolName (언더스코어 변환)
    const toolName = action.type.replace(/-/g, "_");

    return this.gate.requestAndWait({
      id,
      category: "agent-action",
      toolName,
      args: action,
      reason: action.reason,
      source: "builtin",
      createdAt,
    });
  }
}
