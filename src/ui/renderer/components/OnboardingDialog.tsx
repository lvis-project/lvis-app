/**
 * OnboardingDialog (#893) — first-boot vendor-credential choice.
 *
 * Shown when LLM `apiKey` is unset for every vendor *and*
 * `features.onboardingCompleted` is not yet true. Offers two paths:
 *
 *   - "API 키 입력" → opens Settings → LLM (the renderer already has an
 *     `openSettingsWindow(tab)` IPC).
 *   - "로그인" → opens the mockup LoginModal pre-targeted at the active vendor.
 *
 * Either path flips `features.onboardingCompleted = true` so the dialog is
 * never re-shown on subsequent boots, even if the user closes the Settings
 * window without persisting a key.
 */
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";

export interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseApiKey: () => void;
  onChooseLogin: () => void;
}

export function OnboardingDialog({
  open,
  onOpenChange,
  onChooseApiKey,
  onChooseLogin,
}: OnboardingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-testid="onboarding-dialog">
        <DialogHeader>
          <DialogTitle>LVIS 시작하기</DialogTitle>
          <DialogDescription>
            대화를 시작하려면 LLM 인증이 필요합니다. 두 가지 방법 중 하나를 선택하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 pt-2">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            data-testid="onboarding-dialog:choose-api-key"
            onClick={onChooseApiKey}
          >
            <span className="font-medium">API 키 입력</span>
            <span className="ml-2 text-xs text-muted-foreground">
              직접 발급받은 키를 설정에 붙여 넣습니다.
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            data-testid="onboarding-dialog:choose-login"
            onClick={onChooseLogin}
          >
            <span className="font-medium">로그인</span>
            <span className="ml-2 text-xs text-muted-foreground">
              데모 자격 증명으로 키를 자동 발급받습니다.
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
