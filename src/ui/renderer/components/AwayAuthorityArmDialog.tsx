import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import {
  NativeSelect,
  NativeSelectOption,
} from "../../../components/ui/native-select.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import {
  AWAY_AUTHORITY_BUDGET_PRESETS,
  AWAY_AUTHORITY_DURATION_PRESETS,
  AWAY_AUTHORITY_MAX_DIRECTORIES,
  type AwayAuthorityBudgetPreset,
  type AwayAuthorityDurationPreset,
  type AwayAuthorityMode,
} from "../../../shared/away-authority-arm.js";
import { formatIpcError } from "../format-ipc-error.js";
import type { LvisApi } from "../types.js";

export interface AwayAuthorityArmDialogProps {
  api: LvisApi;
  /**
   * The tile the away-authority grant would bind to — the focused conversation.
   * Threaded from the window because settings has no conversation of its own,
   * and main refuses a grant that names no tile.
   */
  chatGroupId: string;
  open: boolean;
  onCancel: () => void;
  /** Called after main confirms the arming, so the caller can refetch status. */
  onArmed: () => void;
}

function durationLabel(
  value: AwayAuthorityDurationPreset,
  t: (key: string) => string,
): string {
  switch (value) {
    case "30m": return t("awayAuthority.duration30m");
    case "1h": return t("awayAuthority.duration1h");
    case "2h": return t("awayAuthority.duration2h");
    case "4h": return t("awayAuthority.duration4h");
  }
}

/**
 * The whole scope disclosure for the away answerer, in one surface.
 *
 * It is deliberately not split across a tooltip, an info icon, and a help page:
 * this dialog is the only moment the owner sees what arming actually authorizes,
 * and a disclosure the owner has to go looking for is a disclosure that was not
 * made. Every paragraph below states something the code enforces — see
 * `src/i18n/messages/generated/awayAuthority.ts` for the rule that each one is
 * checked against.
 *
 * The dialog also refuses to let `write` be armed absent-mindedly, in four
 * independent ways rather than one:
 *
 *   1. `read-only` is the initial mode and the owner must move off it.
 *   2. Choosing `read-write` reveals an acknowledgement that names the
 *      consequence, and the arm button stays disabled until it is ticked.
 *   3. That acknowledgement is cleared by changing the mode OR the folder
 *      selection, because it is a statement about a specific set of folders and
 *      a changed set is a statement the owner has not made.
 *   4. The primary button says which mode it is arming, so the last thing the
 *      owner reads before clicking is the answer to "am I arming writes".
 *
 * Directories come from the owner's existing project roots rather than a text
 * field. A grant may only bound itself with folders the owner already trusts
 * this app in, and a free-text path is an invitation to type one they do not.
 */
export function AwayAuthorityArmDialog({
  api,
  chatGroupId,
  open,
  onCancel,
  onArmed,
}: AwayAuthorityArmDialogProps) {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<AwayAuthorityMode>("read-only");
  const [duration, setDuration] = useState<AwayAuthorityDurationPreset>("1h");
  const [budget, setBudget] = useState<AwayAuthorityBudgetPreset>(10);
  const [writeAcknowledged, setWriteAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Re-read on every open, and reset every choice with it. A dialog that
    // reopened holding the previous session's folders and a ticked write
    // acknowledgement is exactly the hurried second arming this guards against.
    setSelected([]);
    setMode("read-only");
    setWriteAcknowledged(false);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        // The project roots the owner already granted this app, read from the
        // same surface the sidebar and composer read. Offering anything else
        // would mean offering to arm a folder the app is not otherwise allowed
        // in, which `sanitizeAllowedDirectories` would refuse anyway.
        const result = await window.lvis?.workspace?.listRoots?.();
        if (cancelled) return;
        const roots = result?.ok && Array.isArray(result.roots) ? result.roots : [];
        setRoots(roots
          .map((root) => root.path)
          .filter((path) => typeof path === "string" && path.length > 0)
          .slice(0, AWAY_AUTHORITY_MAX_DIRECTORIES));
      } catch {
        if (!cancelled) setRoots([]);
      }
    })();
    return () => { cancelled = true; };
  }, [api, open]);

  const toggleDirectory = useCallback((path: string) => {
    setSelected((current) => current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [...current, path]);
    // The acknowledgement below names "these folders". Change the folders and
    // it no longer describes what would be armed, so it is withdrawn.
    setWriteAcknowledged(false);
  }, []);

  const changeMode = useCallback((next: AwayAuthorityMode) => {
    setMode(next);
    setWriteAcknowledged(false);
  }, []);

  const writable = mode === "read-write";
  const canArm = useMemo(
    () => selected.length > 0 && (!writable || writeAcknowledged) && !busy,
    [busy, selected.length, writable, writeAcknowledged],
  );

  const arm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.awayAuthority.arm({
        chatGroupId,
        mode,
        directories: selected,
        duration,
        budget,
      });
      if (!result.ok) {
        setError(formatIpcError(result.error, undefined));
        return;
      }
      onArmed();
    } catch {
      setError(t("awayAuthority.operationFailed"));
    } finally {
      setBusy(false);
    }
  }, [api, budget, chatGroupId, duration, mode, onArmed, selected, t]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent size="lg" data-testid="away-authority-arm-dialog">
        <DialogHeader>
          <DialogTitle>{t("awayAuthority.dialogTitle")}</DialogTitle>
          <DialogDescription data-testid="away-authority-scope">
            {t("awayAuthority.dialogScope")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground" data-testid="away-authority-pathless">
            {t("awayAuthority.dialogPathless")}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="away-authority-never-armed">
            {t("awayAuthority.dialogNeverArmed")}
          </p>
          <p
            className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
            data-testid="away-authority-impersonation"
          >
            {t("awayAuthority.dialogImpersonation")}
          </p>
          <p
            className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning"
            data-testid="away-authority-injection"
          >
            {t("awayAuthority.dialogInjection")}
          </p>
          {/*
            Stated in the same breath as the two warnings above, not on a
            separate screen. An owner who reads only the risks is being told
            the answerer is less bounded than it is, which is its own defect.
          */}
          <p className="text-xs text-muted-foreground" data-testid="away-authority-still-blocked">
            {t("awayAuthority.dialogStillBlocked")}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="away-authority-retirement">
            {t("awayAuthority.dialogRetirement")}
          </p>

          <fieldset className="grid gap-2">
            <legend className="text-xs font-medium">{t("awayAuthority.modeLabel")}</legend>
            <RadioGroup
              value={mode}
              onValueChange={(next) => changeMode(next as AwayAuthorityMode)}
            >
              <label className="flex items-center gap-2 text-xs">
                <RadioGroupItem value="read-only" data-testid="away-authority-mode-read-only" />
                <span>{t("awayAuthority.modeReadOnly")}</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <RadioGroupItem value="read-write" data-testid="away-authority-mode-read-write" />
                <span>{t("awayAuthority.modeReadWrite")}</span>
              </label>
            </RadioGroup>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="text-xs font-medium">{t("awayAuthority.foldersLabel")}</legend>
            <p className="text-[11px] text-muted-foreground">{t("awayAuthority.foldersHint")}</p>
            {roots.length === 0 ? (
              <p className="text-[11px] text-muted-foreground" data-testid="away-authority-folders-empty">
                {t("awayAuthority.foldersEmpty")}
              </p>
            ) : (
              <ul className="max-h-32 space-y-1 overflow-y-auto rounded border border-border p-2">
                {roots.map((path) => (
                  <li key={path}>
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={selected.includes(path)}
                        disabled={busy}
                        onCheckedChange={() => toggleDirectory(path)}
                        data-testid={`away-authority-folder-${path}`}
                      />
                      <span className="break-all font-mono">{path}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs font-medium">
              <span>{t("awayAuthority.durationLabel")}</span>
              <NativeSelect
                size="sm"
                value={duration}
                disabled={busy}
                onChange={(event) => setDuration(event.target.value as AwayAuthorityDurationPreset)}
                data-testid="away-authority-duration"
              >
                {AWAY_AUTHORITY_DURATION_PRESETS.map((preset) => (
                  <NativeSelectOption key={preset} value={preset}>
                    {durationLabel(preset, t)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="grid gap-1 text-xs font-medium">
              <span>{t("awayAuthority.budgetLabel")}</span>
              <NativeSelect
                size="sm"
                value={String(budget)}
                disabled={busy}
                onChange={(event) =>
                  setBudget(Number(event.target.value) as AwayAuthorityBudgetPreset)}
                data-testid="away-authority-budget"
              >
                {AWAY_AUTHORITY_BUDGET_PRESETS.map((preset) => (
                  <NativeSelectOption key={preset} value={String(preset)}>
                    {t("awayAuthority.budgetCalls", { count: preset })}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          </div>

          {writable ? (
            <label
              className="flex items-start gap-2 rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
            >
              <Checkbox
                checked={writeAcknowledged}
                disabled={busy}
                onCheckedChange={(next) => setWriteAcknowledged(next === true)}
                data-testid="away-authority-write-acknowledge"
              />
              <span>{t("awayAuthority.writeAcknowledge")}</span>
            </label>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-xs text-destructive" data-testid="away-authority-arm-error">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" disabled={busy} onClick={onCancel} data-testid="away-authority-cancel">
            {t("awayAuthority.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!canArm}
            onClick={() => void arm()}
            data-testid="away-authority-confirm-arm"
          >
            {writable ? t("awayAuthority.armReadWrite") : t("awayAuthority.armReadOnly")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
