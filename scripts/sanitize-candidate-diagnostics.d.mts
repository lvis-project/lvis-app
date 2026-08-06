// Type declarations for scripts/sanitize-candidate-diagnostics.mjs.
// Kept separate because the workflow consumes the sanitizer as plain Node JS.

export interface CandidateDiagnosticsSummary {
  readonly directories: number;
  readonly files: number;
  readonly bytes: number;
}

export function sanitizeCandidateDiagnostics(
  inputArgument: string,
  outputArgument: string,
): CandidateDiagnosticsSummary;
