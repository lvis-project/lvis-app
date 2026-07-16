const REMOTE_A2A_TASK_HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export function isValidRemoteA2ATargetAgentId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isValidRemoteA2ATaskHandle(value: unknown): value is string {
  return typeof value === "string" && REMOTE_A2A_TASK_HANDLE_PATTERN.test(value);
}
