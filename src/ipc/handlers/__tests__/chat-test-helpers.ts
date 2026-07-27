/**
 * Extract the `runTurn` options object passed through the shared chat-stream
 * boundary. Keep this in one test fixture so focused chat handler suites do
 * not re-implement the same positional-call inspection.
 */
export function turnOptions(runTurn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = runTurn.mock.calls[0] as unknown[];
  return call[3] as Record<string, unknown>;
}
