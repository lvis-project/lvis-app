import { useCallback, useEffect, useState } from "react";
import type { AssistantAgentSummary, AssistantSkillSummary } from "../../../shared/assistant-context.js";
import type { LvisApi } from "../types.js";

export function useAssistantContextOptions(api: LvisApi): {
  agents: AssistantAgentSummary[];
  skills: AssistantSkillSummary[];
  refresh: () => Promise<void>;
} {
  const [agents, setAgents] = useState<AssistantAgentSummary[]>([]);
  const [skills, setSkills] = useState<AssistantSkillSummary[]>([]);

  const refresh = useCallback(async () => {
    const [agentResult, skillResult] = await Promise.all([
      api.listAgentProfiles(),
      api.listSkills(),
    ]);
    setAgents(agentResult.agents ?? []);
    setSkills(skillResult.skills ?? []);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribers = [
      api.onAgentInstallResult?.(() => void refresh()),
      api.onAgentUninstallResult?.(() => void refresh()),
      api.onSkillInstallResult?.(() => void refresh()),
      api.onSkillUninstallResult?.(() => void refresh()),
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [api, refresh]);

  return { agents, skills, refresh };
}
