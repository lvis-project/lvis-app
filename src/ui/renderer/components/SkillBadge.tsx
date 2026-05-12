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

/**
 * L2: cap rendered string length so a misbehaving (or malicious) skill
 * cannot blow up the badge's layout via a long name/description. The full
 * value is still available in the tooltip's title attribute fallback.
 */
const DISPLAY_CAP = 80;
function clip(value: string): string {
  return value.length > DISPLAY_CAP ? `${value.slice(0, DISPLAY_CAP)}…` : value;
}

export function SkillBadge({ name, description, source }: SkillBadgeProps) {
  const displayName = clip(name);
  const displayDescription = clip(description);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="skill-badge"
          className="inline-flex items-center gap-1 rounded-full border border-action-view/40 bg-action-view/10 px-2 py-0.5 text-[11px] text-action-view"
        >
          <Sparkles className="h-3 w-3" />
          Skill loaded: {displayName}
          <span className="text-[10px] opacity-60">({source})</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {displayDescription || `Skill ${displayName} loaded.`}
      </TooltipContent>
    </Tooltip>
  );
}
