/**
 * One connection, as one line that opens.
 *
 * Settings has two lists of the same shape — the model providers and the
 * remote connections — and a reader scanning either one is asking the same
 * question: what can reach this desktop, is it working, and where is it. Two
 * row renderers answer that question in two visual languages, and the second
 * one always drifts: a state word gets a different tone here than there, a
 * badge moves to the other side of the name, and the reader has to relearn the
 * page. So the row lives once, and each list contributes what only it knows
 * through the slots below.
 *
 * The head is the whole disclosure — the row IS the connection, so opening it
 * must not require finding a particular control on it. Anything the embedding
 * list wants pressable sits in `action`, BESIDE the head and never inside it:
 * a button nested in a button is not a control the browser can give anyone.
 */
import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * The one state vocabulary every connection row is worded in.
 *
 * Deliberately coarser than any single connection's own state machine: this
 * word answers "can I be reached here right now, and if not is that on me?" so
 * that the column can be read straight down. The detail — which handshake
 * failed, which approval expired — belongs to the body the row opens.
 */
export type ConnectionRowState =
  | "connected"
  | "paused"
  | "needs-setup"
  | "attention"
  /** Installed or declared, but this build carries nothing that can drive it. */
  | "unavailable"
  /** No answer yet from the surface that owns the real state. */
  | "checking";

/**
 * The catalog key for each state word.
 *
 * One mapping, inside the component that draws the column, so no embedding
 * list can word the same state differently from the row beside it.
 */
function connectionStateLabelKey(state: ConnectionRowState): string {
  switch (state) {
    case "connected": return "connectionRow.stateConnected";
    case "paused": return "connectionRow.statePaused";
    case "needs-setup": return "connectionRow.stateNeedsSetup";
    case "attention": return "connectionRow.stateAttention";
    case "unavailable": return "connectionRow.stateUnavailable";
    case "checking": return "connectionRow.stateChecking";
  }
}

/** Only a state the owner can do nothing about, or must, gets a colour. */
const STATE_DOT: Record<ConnectionRowState, string> = {
  connected: "bg-success",
  paused: "bg-muted-foreground",
  "needs-setup": "bg-muted-foreground/(--opacity-half)",
  attention: "bg-destructive",
  unavailable: "bg-muted-foreground/(--opacity-half)",
  checking: "bg-muted-foreground/(--opacity-half)",
};

export interface ConnectionRowProps {
  /** The name a reader would say out loud — the vendor, not the runtime. */
  label: string;
  state: ConnectionRowState;
  /**
   * The address that makes the row concrete: an origin, a bot handle, a
   * loopback host. Omitted when the connection genuinely has none, rather than
   * filled with a placeholder.
   */
  endpoint?: string | null;
  /** Contributed beside the name — what only the embedding list knows. */
  badges?: ReactNode;
  /** Contributed at the row's right edge, outside the disclosure button. */
  action?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Whether a row precedes this one in the list. The separator is a prop
   * rather than a `first:` rule because the list groups its rows — a group
   * wrapper would make its first row look like the top of the list.
   */
  separated?: boolean;
  /** Stem for this row's test ids and for the body's `aria-controls` id. */
  testId: string;
  children?: ReactNode;
}

export function ConnectionRow({
  label,
  state,
  endpoint = null,
  badges,
  action,
  expanded,
  onToggle,
  separated = false,
  testId,
  children,
}: ConnectionRowProps) {
  const { t } = useTranslation();
  const bodyId = `connection-row-body-${testId.replace(/[^\w-]/g, "-")}`;
  const stateWord = t(connectionStateLabelKey(state));

  return (
    <div
      className={cn("min-w-0 bg-card", separated && "border-t border-border")}
      data-connection-row={testId}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 text-left"
          aria-expanded={expanded}
          {...(expanded ? { "aria-controls": bodyId } : {})}
          onClick={onToggle}
          data-testid={`${testId}:toggle`}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{label}</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-[11px]",
                  state === "attention" ? "text-destructive" : "text-muted-foreground",
                )}
                data-state={state}
                data-testid={`${testId}:state`}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden={true} />
                {stateWord}
              </span>
              {badges}
            </span>
            {endpoint === null || endpoint === "" ? null : (
              <span
                className="block truncate font-mono text-[11px] text-muted-foreground"
                title={endpoint}
                data-testid={`${testId}:endpoint`}
              >
                {endpoint}
              </span>
            )}
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden={true}
          />
        </button>
        {action}
      </div>

      {expanded ? (
        <div
          id={bodyId}
          className="border-t border-border/(--opacity-medium) px-3 py-3"
          data-testid={`${testId}:detail`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
