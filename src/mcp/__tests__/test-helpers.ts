import { McpGovernance } from "../mcp-governance.js";
import type { McpGovernancePolicy } from "../types.js";

/**
 * Build a governance instance whose internal policy is swapped out to the
 * in-memory one we provide. Avoids any filesystem dependency.
 *
 * Constructing with a path that does not exist → default policy is loaded;
 * then we override via the untyped `policy` field. This mirrors how the
 * governance layer behaves when IT Admin updates the file in place.
 */
export function governanceWithPolicy(policy: McpGovernancePolicy): McpGovernance {
  const gov = new McpGovernance("/nonexistent/mcp-policy.json");
  (gov as unknown as { policy: McpGovernancePolicy }).policy = policy;
  return gov;
}
