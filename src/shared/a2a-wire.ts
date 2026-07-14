import type { A2AJsonObject, A2AJsonValue, A2AMessage, A2ATask } from "./a2a.js";
export type { A2AJsonObject, A2AJsonValue } from "./a2a.js";

/** Vendored A2A v1.0 JSON-RPC wire contracts (types only; no SDK runtime). */
export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const A2A_JSONRPC_VERSION = "2.0" as const;
export const A2A_VERSION_HEADER = "a2a-version" as const;
export const A2A_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo" as const;
export const A2A_ERROR_INFO_DOMAIN = "a2a-protocol.org" as const;
export const A2A_HOST_ERROR_INFO_DOMAIN = "lvis-project.github.io" as const;

export const A2AJsonRpcMethod = {
  SEND_MESSAGE: "SendMessage",
  SEND_STREAMING_MESSAGE: "SendStreamingMessage",
  GET_TASK: "GetTask",
  LIST_TASKS: "ListTasks",
  CANCEL_TASK: "CancelTask",
  SUBSCRIBE_TO_TASK: "SubscribeToTask",
  CREATE_TASK_PUSH_NOTIFICATION_CONFIG: "CreateTaskPushNotificationConfig",
  GET_TASK_PUSH_NOTIFICATION_CONFIG: "GetTaskPushNotificationConfig",
  LIST_TASK_PUSH_NOTIFICATION_CONFIGS: "ListTaskPushNotificationConfigs",
  DELETE_TASK_PUSH_NOTIFICATION_CONFIG: "DeleteTaskPushNotificationConfig",
  GET_EXTENDED_AGENT_CARD: "GetExtendedAgentCard",
} as const;

export type A2AJsonRpcMethod = (typeof A2AJsonRpcMethod)[keyof typeof A2AJsonRpcMethod];

export const A2A_DIRECT_JSONRPC_METHODS = [
  A2AJsonRpcMethod.SEND_MESSAGE,
  A2AJsonRpcMethod.GET_TASK,
  A2AJsonRpcMethod.LIST_TASKS,
  A2AJsonRpcMethod.CANCEL_TASK,
] as const;
export type A2ADirectJsonRpcMethod = (typeof A2A_DIRECT_JSONRPC_METHODS)[number];

export const A2A_PUSH_JSONRPC_METHODS = [
  A2AJsonRpcMethod.CREATE_TASK_PUSH_NOTIFICATION_CONFIG,
  A2AJsonRpcMethod.GET_TASK_PUSH_NOTIFICATION_CONFIG,
  A2AJsonRpcMethod.LIST_TASK_PUSH_NOTIFICATION_CONFIGS,
  A2AJsonRpcMethod.DELETE_TASK_PUSH_NOTIFICATION_CONFIG,
] as const;

export type A2AJsonRpcId = string | number | null;

export interface A2AJsonRpcRequest {
  jsonrpc: typeof A2A_JSONRPC_VERSION;
  id: A2AJsonRpcId;
  method: string;
  params?: A2AJsonObject;
}

export interface A2AJsonRpcSuccess<TResult = A2AJsonValue> {
  jsonrpc: typeof A2A_JSONRPC_VERSION;
  id: A2AJsonRpcId;
  result: TResult;
}

export interface A2AErrorInfo {
  "@type": typeof A2A_ERROR_INFO_TYPE;
  reason: A2AErrorReason;
  domain: typeof A2A_ERROR_INFO_DOMAIN;
  metadata?: Record<string, string>;
}

export interface A2AJsonRpcErrorObject {
  code: number;
  message: string;
  data?: A2AJsonValue;
}

export interface A2AJsonRpcFailure {
  jsonrpc: typeof A2A_JSONRPC_VERSION;
  id: A2AJsonRpcId;
  error: A2AJsonRpcErrorObject;
}

export type A2AJsonRpcResponse<TResult = A2AJsonValue> =
  | A2AJsonRpcSuccess<TResult>
  | A2AJsonRpcFailure;

export const A2AJsonRpcErrorDefinition = {
  TASK_NOT_FOUND: { code: -32001, message: "Task not found", reason: "TASK_NOT_FOUND" },
  TASK_NOT_CANCELABLE: {
    code: -32002,
    message: "Task cannot be canceled",
    reason: "TASK_NOT_CANCELABLE",
  },
  PUSH_NOTIFICATION_NOT_SUPPORTED: {
    code: -32003,
    message: "Push notifications are not supported",
    reason: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  },
  UNSUPPORTED_OPERATION: {
    code: -32004,
    message: "Operation is not supported",
    reason: "UNSUPPORTED_OPERATION",
  },
  CONTENT_TYPE_NOT_SUPPORTED: {
    code: -32005,
    message: "Content type is not supported",
    reason: "CONTENT_TYPE_NOT_SUPPORTED",
  },
  INVALID_AGENT_RESPONSE: {
    code: -32006,
    message: "Agent returned an invalid response",
    reason: "INVALID_AGENT_RESPONSE",
  },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: {
    code: -32007,
    message: "Extended Agent Card is not configured",
    reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  },
  EXTENSION_SUPPORT_REQUIRED: {
    code: -32008,
    message: "Required extension is not supported",
    reason: "EXTENSION_SUPPORT_REQUIRED",
  },
  VERSION_NOT_SUPPORTED: {
    code: -32009,
    message: "A2A protocol version is not supported",
    reason: "VERSION_NOT_SUPPORTED",
  },
} as const;

export type A2AErrorDefinition =
  (typeof A2AJsonRpcErrorDefinition)[keyof typeof A2AJsonRpcErrorDefinition];
export type A2AErrorReason = A2AErrorDefinition["reason"];

/**
 * Host policy errors outside the vendored A2A v1.0 error registry.
 *
 * These remain JSON-RPC server errors, but must not be presented as protocol
 * definitions supplied by the A2A specification.
 */
export const A2AHostJsonRpcErrorDefinition = {
  OPERATION_REJECTED: {
    code: -32010,
    message: "Operation rejected",
    reason: "OPERATION_REJECTED",
  },
} as const;

export type A2AHostErrorDefinition =
  (typeof A2AHostJsonRpcErrorDefinition)[keyof typeof A2AHostJsonRpcErrorDefinition];
export type A2AHostErrorReason = A2AHostErrorDefinition["reason"];

/** Error definitions the host router may safely project onto the A2A wire. */
export type A2ARouterErrorDefinition = A2AErrorDefinition | A2AHostErrorDefinition;

export const StandardJsonRpcErrorDefinition = {
  PARSE_ERROR: { code: -32700, message: "Parse error" },
  INVALID_REQUEST: { code: -32600, message: "Invalid request" },
  METHOD_NOT_FOUND: { code: -32601, message: "Method not found" },
  INVALID_PARAMS: { code: -32602, message: "Invalid params" },
  INTERNAL_ERROR: { code: -32603, message: "Internal error" },
} as const;

export type StandardJsonRpcErrorDefinition =
  (typeof StandardJsonRpcErrorDefinition)[keyof typeof StandardJsonRpcErrorDefinition];

export interface A2AAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: A2AJsonObject;
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extendedAgentCard?: boolean;
  extensions?: A2AAgentExtension[];
}

export interface A2AAgentInterface {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | string;
  protocolVersion: string;
  tenant?: string;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AHttpAuthSecurityScheme {
  httpAuthSecurityScheme: {
    scheme: string;
    description?: string;
    bearerFormat?: string;
  };
}

export interface A2ASecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  capabilities: A2AAgentCapabilities;
  skills: A2AAgentSkill[];
  supportedInterfaces: [A2AAgentInterface, ...A2AAgentInterface[]];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  securitySchemes?: Record<string, A2AHttpAuthSecurityScheme>;
  securityRequirements?: A2ASecurityRequirement[];
}

export type A2AAgentCardTemplate = Omit<A2AAgentCard, "supportedInterfaces">;

export type A2ASendMessageResult =
  | { task: A2ATask; message?: never }
  | { message: A2AMessage; task?: never };

export interface A2AListTasksResult {
  tasks: A2ATask[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export type A2ADirectJsonRpcResult = A2ASendMessageResult | A2ATask | A2AListTasksResult;
