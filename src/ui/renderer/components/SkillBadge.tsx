/**
 * SkillBadge — small chip rendered inline in the chat at the call site of
 * the `skill_load` LLM tool. Visualizes "🎯 Skill loaded: <name>" with a
 * tooltip showing the description.
 */
import { Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export interface SkillBadgeProps {
  name: string;
  description: string;
  source: "user" | "builtin";
}

export function SkillBadge({ name, description, source }: SkillBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="skill-badge"
          className="inline-flex items-center gap-1 rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-[11px] text-purple-700 dark:text-purple-300"
        >
          <Sparkles className="h-3 w-3" />
          Skill loaded: {name}
          <span className="text-[10px] opacity-60">({source})</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {description || `Skill ${name} loaded.`}
      </TooltipContent>
    </Tooltip>
  );
}
