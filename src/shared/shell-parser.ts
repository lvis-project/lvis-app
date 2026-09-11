import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

interface ParserRuntime {
  importObject: WebAssembly.Imports;
  exited?: boolean;
  run(instance: WebAssembly.Instance): Promise<void>;
}
interface ParserLimits { sourceBytes: number; nodes: number; depth: number; outputBytes: number }
type ParseFunction = (source: string) => string;
const runtimeGlobal = globalThis as typeof globalThis & {
  Go?: new () => ParserRuntime;
  _lvisShellParserBridge?: { ready: (parse: ParseFunction, limits: ParserLimits) => void };
};
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(require.resolve("@lvis/shell-parser-runtime/manifest.json"), "utf8")) as { wasmSha256: string; runtimeSha256: string };
const wasmBytes = readFileSync(require.resolve("@lvis/shell-parser-runtime/parser.wasm"));
const runtimeBytes = readFileSync(require.resolve("@lvis/shell-parser-runtime/wasm_exec.cjs"));
if (createHash("sha256").update(wasmBytes).digest("hex") !== manifest.wasmSha256
  || createHash("sha256").update(runtimeBytes).digest("hex") !== manifest.runtimeSha256) throw new Error("Shell parser asset integrity check failed");
require("@lvis/shell-parser-runtime/wasm_exec.cjs");
if (!runtimeGlobal.Go || runtimeGlobal._lvisShellParserBridge) throw new Error("Shell parser initialization conflict");
const runtime = new runtimeGlobal.Go();
let parseFunction: ParseFunction | undefined;
let limits: Readonly<ParserLimits> | undefined;
let runtimeFailure: Error | undefined;
runtimeGlobal._lvisShellParserBridge = {
  ready(parse, suppliedLimits) {
    if (parseFunction || typeof parse !== "function" || !suppliedLimits
      || !["sourceBytes", "nodes", "depth", "outputBytes"].every((key) => Number.isSafeInteger(suppliedLimits[key as keyof ParserLimits]) && suppliedLimits[key as keyof ParserLimits] > 0)) {
      throw new Error("Invalid shell parser initialization");
    }
    parseFunction = parse;
    limits = Object.freeze({ ...suppliedLimits });
  },
};
try {
  const { instance } = await WebAssembly.instantiate(wasmBytes, runtime.importObject);
  // Starting the runtime registers its synchronous callback before yielding.
  // The lifetime promise stays pending while that callback remains callable.
  void runtime.run(instance).then(() => { runtimeFailure = new Error("Shell parser runtime exited"); }, (error: unknown) => {
    runtimeFailure = error instanceof Error ? error : new Error("Shell parser runtime failed");
  });
  // An immediately settled runtime is not ready, even if it called ready first.
  await Promise.resolve();
  if (runtimeFailure) throw runtimeFailure;
  if (runtime.exited) throw new Error("Shell parser runtime exited during initialization");
  if (!parseFunction || !limits) throw new Error("Shell parser did not become ready");
} finally {
  delete runtimeGlobal._lvisShellParserBridge;
}
const parse = parseFunction;
export const SHELL_ANALYSIS_LIMITS = Object.freeze({ ...limits, states: 64 });
export class ShellAnalysisError extends Error {}

export interface ShellSyntaxNode {
  Type?: string;
  Pos?: { Offset: number; Line: number; Col: number };
  End?: { Offset: number; Line: number; Col: number };
  [field: string]: unknown;
}

/** Every call uses the initialized grammar; no source or syntax cache is kept. */
export function parseShellSyntax(source: string): ShellSyntaxNode {
  if (runtime.exited && !runtimeFailure) runtimeFailure = new Error("Shell parser runtime exited");
  if (runtimeFailure) throw runtimeFailure;
  if (Buffer.byteLength(source, "utf8") > SHELL_ANALYSIS_LIMITS.sourceBytes) throw new ShellAnalysisError("Shell analysis source limit exceeded");
  const bytes = Buffer.from(source, "utf8");
  try {
    const serialized = parse(source);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > SHELL_ANALYSIS_LIMITS.outputBytes) throw new Error("Invalid shell parser output");
    const result: unknown = JSON.parse(serialized);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid shell parser result");
    const keys = Object.keys(result);
    if ("error" in result) {
      if (keys.length !== 1 || typeof result.error !== "string" || !result.error) throw new Error("Invalid shell parser failure");
      throw new ShellAnalysisError(result.error);
    }
    if (keys.length !== 3 || !("tree" in result) || !result.tree || typeof result.tree !== "object" || Array.isArray(result.tree)
      || !("Type" in result.tree) || result.tree.Type !== "File"
      || !("braceWords" in result) || !Array.isArray(result.braceWords)
      || !("escapedStrings" in result) || !result.escapedStrings || typeof result.escapedStrings !== "object" || Array.isArray(result.escapedStrings)) throw new Error("Missing shell syntax tree");
    const validRange = (range: unknown): boolean => Array.isArray(range) && range.length === 2
      && range.every((offset) => Number.isSafeInteger(offset) && offset >= 0 && offset <= bytes.length
        && (offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80))
      && range[0] <= range[1];
    if (result.braceWords.length > SHELL_ANALYSIS_LIMITS.nodes || !result.braceWords.every(validRange)) throw new Error("Invalid shell brace annotations");
    const strings = Object.entries(result.escapedStrings);
    if (strings.length > SHELL_ANALYSIS_LIMITS.nodes || strings.some(([range, value]) => !validRange(JSON.parse(range)) || typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid shell string annotations");
    return { ...result.tree, BraceWords: result.braceWords, EscapedStrings: result.escapedStrings } as ShellSyntaxNode;
  } catch (error) {
    if (error instanceof ShellAnalysisError) throw error;
    // A trap or broken ABI may leave Go's runtime unusable. Never re-enter it.
    runtimeFailure = error instanceof Error ? error : new Error("Shell parser runtime failed");
    throw runtimeFailure;
  }
}
