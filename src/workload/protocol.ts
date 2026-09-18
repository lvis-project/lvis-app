import { isAbsolute, posix } from "node:path";
import { z } from "zod";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

const WORKLOAD_BROKER_CAPABILITY_VERSION =
  "lvis-workload-broker-capability/v1" as const;
export const WORKLOAD_BROKER_REQUEST_VERSION = "lvis-workload-request/v2" as const;
const WORKLOAD_BROKER_RESPONSE_VERSION = "lvis-workload-response/v2" as const;
const WORKLOAD_BROKER_CORRELATION_VERSION =
  "lvis-workload-correlation/v1" as const;

export const WORKLOAD_BROKER_OPERATIONS = [
  "handshake",
  "shell.run",
  "shell.start",
  "shell.read",
  "shell.kill",
  "file.read",
  "file.read_binary",
  "file.list",
  "file.glob",
  "file.grep",
  "file.write",
  "file.edit",
  "file.patch",
  "file.move",
  "file.copy",
  "file.extract",
  "file.delete",
] as const;

export type WorkloadBrokerOperation = typeof WORKLOAD_BROKER_OPERATIONS[number];

export const WORKLOAD_BROKER_LIMITS = Object.freeze({
  capabilityBytes: 64 * 1_024,
  minimumRequestBytes: 1_024,
  maximumRequestBytes: 16 * 1_024 * 1_024,
  minimumResponseBytes: 1_024,
  maximumResponseBytes: 40 * 1_024 * 1_024,
  maximumBinaryInputBytes: 25 * 1_024 * 1_024,
  maximumCommandBytes: 512 * 1_024,
  maximumTextBytes: 2 * 1_024 * 1_024,
  maximumShellOutputBytes: 1 * 1_024 * 1_024,
  maximumFileOutputBytes: 4 * 1_024 * 1_024,
  maximumPathBytes: 4 * 1_024,
  maximumTimeoutMs: 60 * 60 * 1_000,
  maximumWaitMs: 60_000,
  // The broker revalidates the exact Docker identity during admission. Its
  // bounded inspect may legitimately consume 10s on a loaded daemon, so the
  // client must leave room for that proof and response framing.
  handshakeTimeoutMs: TOOL_TIMEOUT_POLICY.workloadBrokerPreEffectHandshakeMs,
} as const);

const SHA256_HEX = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,95}$/;
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function byteLengthAtMost(value: string, bytes: number): boolean {
  return Buffer.byteLength(value, "utf8") <= bytes;
}

function isCleanAbsoluteGuestPath(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && posix.isAbsolute(value)
    && posix.normalize(value) === value
    && byteLengthAtMost(value, WORKLOAD_BROKER_LIMITS.maximumPathBytes);
}

const GuestPathSchema = z.string().refine(isCleanAbsoluteGuestPath, "invalid guest path");
const TimeoutSchema = z.number().int().min(1).max(WORKLOAD_BROKER_LIMITS.maximumTimeoutMs);
const OptionalTimeoutShape = { timeoutMs: TimeoutSchema.optional() } as const;

const WorkloadIdentitySchema = z.object({
  id: z.string().regex(SHA256_HEX),
  generation: z.string().regex(GENERATION),
  boundaryFingerprint: z.string().regex(SHA256_HEX),
  imageDigest: z.string().regex(IMAGE_DIGEST),
  cwd: GuestPathSchema,
  home: GuestPathSchema,
  platform: z.literal("linux"),
}).strict();

export type WorkloadIdentity = z.infer<typeof WorkloadIdentitySchema>;

const ExpirySchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return false;
  const canonical = new Date(epoch).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}, "invalid UTC expiry");

const OperationSchema = z.enum(WORKLOAD_BROKER_OPERATIONS);
const Sha256HexSchema = z.string().regex(SHA256_HEX);
const RequestIdSchema = z.string().regex(REQUEST_ID);
const ToolUseIdSchema = z.string().min(1).refine(
  (value) => byteLengthAtMost(value, 256) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  "invalid tool use id",
);
const ToolNameSchema = z.string().regex(TOOL_NAME).refine(
  (value) => byteLengthAtMost(value, 128),
  "tool name too large",
);

export const WorkloadExecutionGrantProjectionSchema = z.object({
  identity: Sha256HexSchema,
  effectDigest: Sha256HexSchema,
  action: z.enum(["shell", "builtin-tool"]),
  planIdentity: Sha256HexSchema.nullable(),
}).strict();

export type WorkloadExecutionGrantProjection = Readonly<
  z.infer<typeof WorkloadExecutionGrantProjectionSchema>
>;

const ToolInvocationCorrelationSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_CORRELATION_VERSION),
  kind: z.literal("tool-invocation"),
  toolUseId: ToolUseIdSchema,
  toolName: ToolNameSchema,
  grant: WorkloadExecutionGrantProjectionSchema,
  payloadDigest: Sha256HexSchema,
  operation: z.enum([
    "shell.run",
    "shell.start",
    "file.read",
    "file.read_binary",
    "file.list",
    "file.glob",
    "file.grep",
    "file.write",
    "file.edit",
    "file.patch",
    "file.move",
    "file.copy",
    "file.extract",
    "file.delete",
  ]),
}).strict();

const BackgroundParentSchema = z.object({
  clientRequestId: RequestIdSchema,
  brokerRequestId: RequestIdSchema,
  brokerInstanceId: RequestIdSchema,
  correlationDigest: Sha256HexSchema,
  payloadDigest: Sha256HexSchema,
  admittedReceiptDigest: Sha256HexSchema,
  terminalReceiptDigest: Sha256HexSchema,
  executionId: z.string().regex(EXECUTION_ID),
}).strict();

const BackgroundToolActorSchema = z.object({
  kind: z.literal("tool-invocation"),
  toolUseId: ToolUseIdSchema,
  toolName: ToolNameSchema,
  operation: z.enum(["shell.read", "shell.kill"]),
  grant: WorkloadExecutionGrantProjectionSchema,
}).strict();

const BackgroundCleanupActorSchema = z.object({
  kind: z.literal("host-cleanup"),
  reason: z.enum(["session-disposal", "application-shutdown"]),
}).strict();

const BackgroundLifecycleCorrelationSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_CORRELATION_VERSION),
  kind: z.literal("background-lifecycle"),
  parent: BackgroundParentSchema,
  actor: z.discriminatedUnion("kind", [
    BackgroundToolActorSchema,
    BackgroundCleanupActorSchema,
  ]),
  payloadDigest: Sha256HexSchema,
  operation: z.enum(["shell.read", "shell.kill"]),
}).strict();

const WorkloadBrokerCorrelationSchema = z.discriminatedUnion("kind", [
  ToolInvocationCorrelationSchema,
  BackgroundLifecycleCorrelationSchema,
]);

export type WorkloadBrokerCorrelation = Readonly<
  z.infer<typeof WorkloadBrokerCorrelationSchema>
>;

export const WorkloadBrokerCapabilityDocumentSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_CAPABILITY_VERSION),
  socketPath: z.string().refine((value) =>
    isAbsolute(value) && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 107,
  "invalid Unix socket path"),
  token: z.string().min(43).max(684).regex(BASE64URL).refine((value) => {
    try {
      const decoded = Buffer.from(value, "base64url");
      return decoded.byteLength >= 32 && decoded.toString("base64url") === value;
    } catch {
      return false;
    }
  }, "token must contain at least 32 bytes"),
  expiresAt: ExpirySchema,
  workload: WorkloadIdentitySchema,
  allowedOperations: z.array(OperationSchema)
    .min(1)
    .max(WORKLOAD_BROKER_OPERATIONS.length)
    .refine((operations) => new Set(operations).size === operations.length, "duplicate operation")
    .refine((operations) => operations.includes("handshake"), "handshake must be allowed"),
  maxRequestBytes: z.number().int()
    .min(WORKLOAD_BROKER_LIMITS.minimumRequestBytes)
    .max(WORKLOAD_BROKER_LIMITS.maximumRequestBytes),
  maxResponseBytes: z.number().int()
    .min(WORKLOAD_BROKER_LIMITS.minimumResponseBytes)
    .max(WORKLOAD_BROKER_LIMITS.maximumResponseBytes),
}).strict();

type ParsedWorkloadBrokerCapabilityDocument = z.infer<
  typeof WorkloadBrokerCapabilityDocumentSchema
>;
export type WorkloadBrokerCapabilityDocument = Readonly<
  Omit<ParsedWorkloadBrokerCapabilityDocument, "workload" | "allowedOperations"> & {
    readonly workload: Readonly<WorkloadIdentity>;
    readonly allowedOperations: readonly WorkloadBrokerOperation[];
  }
>;

const CommandSchema = z.string().min(1).refine(
  (value) => byteLengthAtMost(value, WORKLOAD_BROKER_LIMITS.maximumCommandBytes),
  "command too large",
);
const TextSchema = z.string().refine(
  (value) => byteLengthAtMost(value, WORKLOAD_BROKER_LIMITS.maximumTextBytes),
  "text too large",
);
const ExecutionIdSchema = z.string().regex(EXECUTION_ID);
/**
 * Shell cursors are UTF-8 byte offsets, never JavaScript string indices.
 * Four bytes is the largest encoded Unicode scalar, so a conforming broker can
 * always return at least one complete code point when output remains.
 */
const ShellByteOffsetSchema = z.number().int().nonnegative();
const ShellReadMaxBytesSchema = z.number().int().min(4)
  .max(WORKLOAD_BROKER_LIMITS.maximumResponseBytes);
const ShellOutputSchema = z.string()
  .refine(
    (value) => byteLengthAtMost(value, WORKLOAD_BROKER_LIMITS.maximumShellOutputBytes),
    "shell output too large",
  )
  .refine(
    (value) => Buffer.from(value, "utf8").toString("utf8") === value,
    "shell output must contain complete Unicode code points",
  );
const FileOutputSchema = z.string().refine(
  (value) => byteLengthAtMost(value, WORKLOAD_BROKER_LIMITS.maximumFileOutputBytes),
  "file output too large",
);

export const WorkloadOperationPayloadSchemas = Object.freeze({
  handshake: z.object({ workload: WorkloadIdentitySchema }).strict(),
  "shell.run": z.object({
    command: CommandSchema,
    cwd: GuestPathSchema.optional(),
    timeoutMs: TimeoutSchema,
  }).strict(),
  "shell.start": z.object({
    command: CommandSchema,
    cwd: GuestPathSchema.optional(),
    timeoutMs: TimeoutSchema,
  }).strict(),
  "shell.read": z.object({
    executionId: ExecutionIdSchema,
    offset: ShellByteOffsetSchema,
    maxBytes: ShellReadMaxBytesSchema,
    waitMs: z.number().int().min(0).max(WORKLOAD_BROKER_LIMITS.maximumWaitMs),
    waitFor: z.enum(["output", "completion"]),
  }).strict(),
  "shell.kill": z.object({
    executionId: ExecutionIdSchema,
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).optional(),
    timeoutMs: TimeoutSchema,
  }).strict(),
  "file.read": z.object({
    path: GuestPathSchema,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(5_000),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.read_binary": z.object({
    path: GuestPathSchema,
    maxBytes: z.number().int().min(1).max(WORKLOAD_BROKER_LIMITS.maximumBinaryInputBytes),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.list": z.object({
    path: GuestPathSchema,
    depth: z.number().int().min(1).max(8),
    limit: z.number().int().min(1).max(1_000),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.glob": z.object({
    path: GuestPathSchema,
    pattern: z.string().min(1).max(8_192),
    limit: z.number().int().min(1).max(1_000),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.grep": z.object({
    path: GuestPathSchema,
    pattern: z.string().min(1).max(64 * 1_024),
    include: z.string().min(1).max(8_192).optional(),
    caseSensitive: z.boolean(),
    limit: z.number().int().min(1).max(1_000),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.write": z.object({
    path: GuestPathSchema,
    content: TextSchema,
    ...OptionalTimeoutShape,
  }).strict(),
  "file.edit": z.object({
    path: GuestPathSchema,
    oldText: TextSchema,
    newText: TextSchema,
    replaceAll: z.boolean().optional(),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.patch": z.object({
    path: GuestPathSchema,
    replacements: z.array(z.object({
      oldText: TextSchema.refine((value) => value.length > 0, "oldText is empty"),
      newText: TextSchema,
      replaceAll: z.boolean().optional(),
    }).strict()).min(1).max(50),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.move": z.object({
    sourcePath: GuestPathSchema,
    destinationPath: GuestPathSchema,
    overwrite: z.boolean().optional(),
    ...OptionalTimeoutShape,
  }).strict(),
  "file.copy": z.object({
    sourcePath: GuestPathSchema,
    destinationPath: GuestPathSchema,
    ...OptionalTimeoutShape,
  }).strict(),
  "file.extract": z.object({
    archivePath: GuestPathSchema,
    destinationPath: GuestPathSchema,
    ...OptionalTimeoutShape,
  }).strict(),
  "file.delete": z.object({
    path: GuestPathSchema,
    ...OptionalTimeoutShape,
  }).strict(),
} satisfies Record<WorkloadBrokerOperation, z.ZodType>);

export type WorkloadOperationPayloads = {
  [K in WorkloadBrokerOperation]: z.infer<(typeof WorkloadOperationPayloadSchemas)[K]>;
};

export interface WorkloadBrokerRequest<K extends WorkloadBrokerOperation = WorkloadBrokerOperation> {
  readonly version: typeof WORKLOAD_BROKER_REQUEST_VERSION;
  readonly id: string;
  readonly token: string;
  readonly operation: K;
  readonly payload: WorkloadOperationPayloads[K];
  readonly correlation?: WorkloadBrokerCorrelation;
}

const WorkloadBrokerRequestEnvelopeSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_REQUEST_VERSION),
  id: z.string().regex(REQUEST_ID),
  token: z.string().min(43).max(684).regex(BASE64URL),
  operation: OperationSchema,
  payload: z.unknown(),
  correlation: WorkloadBrokerCorrelationSchema.optional(),
}).strict();

export function parseWorkloadBrokerRequest(value: unknown): WorkloadBrokerRequest {
  const envelope = WorkloadBrokerRequestEnvelopeSchema.parse(value);
  if (envelope.operation === "handshake" ? envelope.correlation !== undefined
    : envelope.correlation === undefined || envelope.correlation.operation !== envelope.operation) {
    throw new Error("workload broker correlation does not match operation");
  }
  const payload = WorkloadOperationPayloadSchemas[envelope.operation].parse(envelope.payload);
  return { ...envelope, payload } as WorkloadBrokerRequest;
}

const MetadataSchema = z.record(z.string(), z.unknown());

const BrokerToolResultSchema = z.object({
  output: FileOutputSchema,
  isError: z.boolean(),
  metadata: MetadataSchema.optional(),
}).strict();

const BrokerToolErrorResultSchema = z.object({
  output: FileOutputSchema,
  isError: z.literal(true),
  metadata: MetadataSchema.optional(),
}).strict();

const WorkloadFileReadResultSchema = z.union([
  z.object({
    output: FileOutputSchema,
    isError: z.literal(false),
    metadata: z.object({
      path: GuestPathSchema,
      startLine: z.number().int().min(1),
      endLine: z.number().int().nonnegative(),
      lineCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }).strict(),
  }).strict(),
  BrokerToolErrorResultSchema,
]);

const Base64Schema = z.string().min(1).refine((value) =>
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
"invalid base64");

const WorkloadFileReadBinaryResultSchema = z.union([
  z.object({
    output: FileOutputSchema,
    isError: z.literal(false),
    path: GuestPathSchema,
    data: Base64Schema,
    bytes: z.number().int().positive().max(WORKLOAD_BROKER_LIMITS.maximumBinaryInputBytes),
  }).strict(),
  BrokerToolErrorResultSchema,
]);

const TerminalStatusSchema = z.enum([
  "exited",
  "signaled",
  "timed-out",
  "cancelled",
  "oom-killed",
  "transport-failed",
  "cleanup-unproven",
]);
const ExitCodeSchema = z.number().int().nullable();
const SignalSchema = z.string().min(1).max(64).nullable();
const ReceiptDigestSchema = z.string().regex(SHA256_HEX);
const TerminalFieldsShape = {
  status: TerminalStatusSchema,
  exitCode: ExitCodeSchema,
  signal: SignalSchema,
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  oomDelta: z.number().int().nonnegative(),
  ownedResourcesZero: z.boolean(),
  receiptDigest: ReceiptDigestSchema,
} as const;

interface TerminalEvidenceValue {
  readonly status: z.infer<typeof TerminalStatusSchema>;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly oomDelta: number;
  readonly ownedResourcesZero: boolean;
}

function terminalEvidenceIssues(
  value: TerminalEvidenceValue,
  report: (message: string) => void,
): void {
  if (value.status === "exited" && (value.exitCode === null || value.signal !== null)) {
    report("exited status requires exitCode and no signal");
  }
  if (value.status === "signaled" && value.signal === null) {
    report("signaled status requires signal");
  }
  if (value.status === "timed-out" && !value.timedOut) {
    report("timedOut flag does not match status");
  }
  if (value.status !== "timed-out" && value.status !== "cleanup-unproven" && value.timedOut) {
    report("timedOut flag does not match status");
  }
  if (value.status === "cancelled" && !value.cancelled) {
    report("cancelled flag does not match status");
  }
  if (value.status !== "cancelled" && value.status !== "cleanup-unproven" && value.cancelled) {
    report("cancelled flag does not match status");
  }
  if (value.status === "oom-killed" ? value.oomDelta < 1
    : value.status !== "cleanup-unproven" && value.oomDelta !== 0) {
    report("oomDelta does not match status");
  }
  if (value.status === "cleanup-unproven" ? value.ownedResourcesZero : !value.ownedResourcesZero) {
    report("ownedResourcesZero does not match terminal cleanup status");
  }
}

function withTerminalEvidenceChecks<T extends z.ZodType>(schema: T): T {
  return schema.superRefine((value, context) => {
    terminalEvidenceIssues(value as TerminalEvidenceValue, (message) => {
      context.addIssue({ code: "custom", message });
    });
  }) as T;
}

export const WorkloadShellRunResultSchema = withTerminalEvidenceChecks(z.object({
  output: ShellOutputSchema,
  isError: z.boolean(),
  ...TerminalFieldsShape,
}).strict());

const WorkloadShellStartSuccessResultSchema = z.object({
  output: ShellOutputSchema,
  isError: z.literal(false),
  executionId: ExecutionIdSchema,
  offset: z.literal(0),
  status: z.literal("running"),
}).strict();
const WorkloadShellStartResultSchema = z.union([
  WorkloadShellStartSuccessResultSchema,
  BrokerToolErrorResultSchema,
]);

const WorkloadShellReadRunningResultSchema = z.object({
  executionId: ExecutionIdSchema,
  offset: ShellByteOffsetSchema,
  nextOffset: ShellByteOffsetSchema,
  output: ShellOutputSchema,
  isError: z.literal(false),
  running: z.literal(true),
  truncated: z.boolean(),
  status: z.literal("running"),
}).strict();

const WorkloadShellReadTerminalResultSchema = withTerminalEvidenceChecks(z.object({
  executionId: ExecutionIdSchema,
  offset: ShellByteOffsetSchema,
  nextOffset: ShellByteOffsetSchema,
  output: ShellOutputSchema,
  isError: z.boolean(),
  running: z.literal(false),
  truncated: z.boolean(),
  ...TerminalFieldsShape,
}).strict());

export const WorkloadShellReadResultSchema = z.union([
  WorkloadShellReadRunningResultSchema,
  WorkloadShellReadTerminalResultSchema,
]).refine(
  (value) => value.nextOffset === value.offset + Buffer.byteLength(value.output, "utf8"),
  "nextOffset must advance by the UTF-8 byte length of output",
);

export const WorkloadShellKillResultSchema = withTerminalEvidenceChecks(z.object({
  executionId: ExecutionIdSchema,
  nextOffset: ShellByteOffsetSchema,
  output: ShellOutputSchema,
  isError: z.boolean(),
  truncated: z.boolean(),
  ...TerminalFieldsShape,
}).strict().refine(
  (value) => value.nextOffset === Buffer.byteLength(value.output, "utf8"),
  "shell.kill returns the full retained output and its UTF-8 byte length",
));

export interface WorkloadBrokerSuccessResults {
  readonly handshake: z.infer<typeof WorkloadHandshakeResultSchema>;
  readonly "shell.run": z.infer<typeof WorkloadShellRunResultSchema>;
  readonly "shell.start": z.infer<typeof WorkloadShellStartResultSchema>;
  readonly "shell.read": z.infer<typeof WorkloadShellReadResultSchema>;
  readonly "shell.kill": z.infer<typeof WorkloadShellKillResultSchema>;
  readonly "file.read": z.infer<typeof WorkloadFileReadResultSchema>;
  readonly "file.read_binary": z.infer<typeof WorkloadFileReadBinaryResultSchema>;
  readonly "file.list": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.glob": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.grep": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.write": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.edit": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.patch": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.move": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.copy": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.extract": z.infer<typeof BrokerToolResultSchema>;
  readonly "file.delete": z.infer<typeof BrokerToolResultSchema>;
}

const WorkloadHandshakeResultSchema = z.object({
  workload: WorkloadIdentitySchema,
  allowedOperations: z.array(OperationSchema),
  maxRequestBytes: z.number().int(),
  maxResponseBytes: z.number().int(),
  expiresAt: ExpirySchema,
}).strict();

const SuccessResponseSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_RESPONSE_VERSION),
  id: z.string().regex(REQUEST_ID),
  brokerRequestId: RequestIdSchema,
  brokerInstanceId: RequestIdSchema,
  payloadDigest: Sha256HexSchema,
  admittedReceiptDigest: Sha256HexSchema,
  terminalReceiptDigest: Sha256HexSchema,
  correlation: WorkloadBrokerCorrelationSchema.optional(),
  correlationDigest: Sha256HexSchema.optional(),
  ok: z.literal(true),
  result: z.unknown(),
}).strict();

const ErrorResponseSchema = z.object({
  version: z.literal(WORKLOAD_BROKER_RESPONSE_VERSION),
  id: z.string().regex(REQUEST_ID),
  brokerRequestId: RequestIdSchema,
  brokerInstanceId: RequestIdSchema,
  payloadDigest: Sha256HexSchema,
  admittedReceiptDigest: Sha256HexSchema,
  terminalReceiptDigest: Sha256HexSchema,
  correlation: WorkloadBrokerCorrelationSchema.optional(),
  correlationDigest: Sha256HexSchema.optional(),
  ok: z.literal(false),
  error: z.object({
    code: z.string().regex(ERROR_CODE),
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const WorkloadBrokerResponseSchema = z.union([
  SuccessResponseSchema,
  ErrorResponseSchema,
]);


export function parseWorkloadBrokerSuccessResult<K extends WorkloadBrokerOperation>(
  operation: K,
  value: unknown,
): WorkloadBrokerSuccessResults[K] {
  const schema: z.ZodType = operation === "handshake"
    ? WorkloadHandshakeResultSchema
    : operation === "shell.run"
      ? WorkloadShellRunResultSchema
      : operation === "shell.start"
        ? WorkloadShellStartResultSchema
        : operation === "shell.read"
          ? WorkloadShellReadResultSchema
          : operation === "shell.kill"
            ? WorkloadShellKillResultSchema
            : operation === "file.read"
              ? WorkloadFileReadResultSchema
              : operation === "file.read_binary"
                ? WorkloadFileReadBinaryResultSchema
                : BrokerToolResultSchema;
  return schema.parse(value) as WorkloadBrokerSuccessResults[K];
}
