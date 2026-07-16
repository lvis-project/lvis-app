import { useEffect, useMemo, useState } from "react";
import { RadioTower, RefreshCw, RotateCcw, Send, Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect } from "../../../components/ui/native-select.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Textarea } from "../../../components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import type { RemoteA2AActionStatus } from "../types.js";

type Target = { targetAgentId: number; label: string };

function statusCopy(status: RemoteA2AActionStatus | null): string {
  if (!status || status.state === "idle") return "Ready for a direct send";
  if (status.taskState === "TASK_STATE_AUTH_REQUIRED") return "Authentication required remotely · complete it out of band";
  if (status.state === "awaiting-approval") return "Allow once to send this request";
  if (status.state === "sent") return `Sent to ${status.targetLabel ?? "remote agent"}`;
  return `Not sent · ${status.outcome ?? "request failed"}`;
}

export function RemoteA2AActionButton() {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [selected, setSelected] = useState("");
  const [intent, setIntent] = useState("");
  const [status, setStatus] = useState<RemoteA2AActionStatus | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    const api = window.lvisApi?.remoteA2a;
    if (!api) { setTargets([]); return; }
    void Promise.all([api.targets(), api.status()]).then(([targetResult, statusResult]) => {
      if (!live) return;
      const nextTargets = targetResult.ok ? targetResult.targets : [];
      setTargets(nextTargets);
      setSelected(nextTargets[0] ? String(nextTargets[0].targetAgentId) : "");
      if (statusResult.ok) setStatus(statusResult.status);
    }).catch(() => { if (live) setTargets([]); });
    return () => { live = false; };
  }, []);

  const targetId = Number(selected);
  const canSend = useMemo(() => Number.isSafeInteger(targetId) && targetId > 0
    && intent.trim() === intent && intent.length > 0 && intent.length <= 8_192 && !sending, [intent, sending, targetId]);
  const taskHandle = status?.taskHandle;
  const terminal = status?.taskState === "TASK_STATE_COMPLETED"
    || status?.taskState === "TASK_STATE_FAILED"
    || status?.taskState === "TASK_STATE_CANCELED"
    || status?.taskState === "TASK_STATE_REJECTED";

  if (targets === null || targets.length === 0) return null;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setStatus({ state: "awaiting-approval", targetAgentId: targetId, targetLabel: targets.find((target) => target.targetAgentId === targetId)?.label, updatedAt: new Date().toISOString() });
    try {
      const result = await window.lvisApi.remoteA2a.send(targetId, intent);
      if ("status" in result) {
        setStatus(result.status);
        if (result.ok) setIntent("");
      } else {
        setStatus({ state: "failed", targetAgentId: targetId, outcome: result.error, updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      setStatus({ state: "failed", targetAgentId: targetId, outcome: error instanceof Error ? error.message : "a2a-remote-send-failed", updatedAt: new Date().toISOString() });
    } finally {
      setSending(false);
    }
  };

  const runTaskAction = async (action: "get" | "resume" | "cancel" | "replay") => {
    if (!taskHandle || sending || (action === "resume" && !canSend)) return;
    setSending(true);
    try {
      const result = action === "get"
        ? await window.lvisApi.remoteA2a.task(taskHandle)
        : await window.lvisApi.remoteA2a.action(action, taskHandle, action === "resume" ? intent : undefined);
      if ("status" in result) {
        setStatus(result.status);
        if (action === "resume" && result.ok) setIntent("");
      } else {
        setStatus({ state: "failed", taskHandle, outcome: result.error, updatedAt: new Date().toISOString() });
      }
    } catch (error) {
      setStatus({ state: "failed", taskHandle, outcome: error instanceof Error ? error.message : "a2a-remote-task-action-failed", updatedAt: new Date().toISOString() });
    } finally {
      setSending(false);
    }
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[10.5px] text-muted-foreground hover:text-foreground"
              data-testid="remote-a2a-trigger"
              aria-label="Send directly to a remote agent"
            >
              <RadioTower className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Direct agent</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Send directly to an approved A2A agent</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80 p-0" data-testid="remote-a2a-panel">
        <div className="border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <span className="relative flex h-2 w-5 items-center" aria-hidden="true">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span className="h-px flex-1 bg-primary/(--opacity-half)" />
              <span className="h-1.5 w-1.5 rounded-full border border-primary bg-background" />
            </span>
            Direct agent route
          </div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">The app resolves credentials and route policy. You choose only the agent and message.</p>
        </div>
        <div className="space-y-3 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="remote-a2a-target" className="text-[11px]">Agent</Label>
            <NativeSelect id="remote-a2a-target" value={selected} onChange={(event) => setSelected(event.target.value)} data-testid="remote-a2a-target">
              {targets.map((target) => <option key={target.targetAgentId} value={target.targetAgentId}>{target.label}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="remote-a2a-intent" className="text-[11px]">Message</Label>
            <Textarea id="remote-a2a-intent" value={intent} onChange={(event) => setIntent(event.target.value)} maxLength={8_192} rows={4} placeholder="What should the agent do?" data-testid="remote-a2a-intent" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground" data-testid="remote-a2a-status" data-state={status?.state ?? "idle"}>{statusCopy(status)}</p>
            <Button type="button" size="sm" className="h-7 shrink-0 gap-1.5" disabled={!canSend} onClick={() => void send()} data-testid="remote-a2a-send">
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {sending ? "Waiting" : "Send"}
            </Button>
          </div>
          {taskHandle && (status?.taskAvailable || status?.recoveryEligible) ? (
            <div className="flex items-center gap-1.5 border-t border-border pt-2" data-testid="remote-a2a-task-actions">
              {status?.taskAvailable ? <>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[10.5px]" disabled={sending} onClick={() => void runTaskAction("get")} data-testid="remote-a2a-get">
                  <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[10.5px]" disabled={!canSend || status.taskState !== "TASK_STATE_INPUT_REQUIRED"} onClick={() => void runTaskAction("resume")} data-testid="remote-a2a-resume">
                  <Send className="h-3 w-3" aria-hidden="true" /> Resume
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[10.5px]" disabled={sending || terminal} onClick={() => void runTaskAction("cancel")} data-testid="remote-a2a-cancel">
                  <Square className="h-3 w-3" aria-hidden="true" /> Cancel
                </Button>
              </> : null}
              {status?.recoveryEligible ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[10.5px]" disabled={sending} onClick={() => void runTaskAction("replay")} data-testid="remote-a2a-replay">
                  <RotateCcw className="h-3 w-3" aria-hidden="true" /> Replay
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
