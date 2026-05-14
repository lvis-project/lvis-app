import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import type { LvisApi } from "../types.js";

export interface MarketplaceTabProps {
  api: LvisApi;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  allowPrivateNetwork: boolean;
  setAllowPrivateNetwork: (v: boolean) => void;
  hasApiKey: boolean;
  setHasApiKey: (v: boolean) => void;
  apiKeyInput: string;
  setApiKeyInput: (v: string) => void;
  onSaved: () => void;
}

export function MarketplaceTab(props: MarketplaceTabProps) {
  const {
    api,
    baseUrl,
    setBaseUrl,
    allowPrivateNetwork,
    setAllowPrivateNetwork,
    hasApiKey,
    setHasApiKey,
    apiKeyInput,
    setApiKeyInput,
    onSaved,
  } = props;

  return (
    <div className="space-y-4 pt-4">
      <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-[11px] text-warning">
        마켓플레이스 설정은 다음 앱 부팅부터 적용됩니다. URL 변경은 부트스트랩 배너의 “다시 시도” 버튼으로 즉시 재시도할 수 있고, API 키 변경은 fetcher 재구성을 위해 앱 재시작이 필요합니다.
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">마켓플레이스 서버 URL</Label>
        <div className="flex items-center gap-2">
          <Input
            type="url"
            placeholder="https://marketplace.your-corp.example"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!baseUrl.trim()}
            onClick={() => {
              const url = baseUrl.trim();
              if (url) void api.openExternalUrl(url);
            }}
            aria-label="마켓플레이스 웹페이지 열기"
            title="설정된 마켓플레이스 URL을 시스템 브라우저로 엽니다"
          >
            마켓플레이스 열기 ↗
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          lvis-marketplace REST API 엔드포인트. 사내 배포 시 사내 호스트로 변경하세요. 비워두면 마켓플레이스 기능이 비활성화됩니다.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">API 키 (선택)</Label>
        <div className="flex items-center gap-2">
          {hasApiKey
            ? <Badge variant="default" className="text-xs">설정됨</Badge>
            : <Badge variant="secondary" className="text-xs">미설정</Badge>}
          {hasApiKey && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              onClick={() => void api.deleteMarketplaceApiKey().then(() => {
                setHasApiKey(false);
                onSaved();
              })}
            >
              삭제
            </Button>
          )}
        </div>
        <Input
          type="password"
          placeholder={hasApiKey ? "새 키로 교체" : "Bearer token (서버가 요구하는 경우)"}
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          서버가 인증을 요구할 때만 입력하세요. 키는 OS 키체인에 암호화되어 저장됩니다.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-md border px-3 py-2.5">
        <Checkbox
          checked={allowPrivateNetwork}
          aria-labelledby="marketplace-allow-private-network-label"
          className="mt-0.5 size-5"
          onCheckedChange={(checked) => setAllowPrivateNetwork(checked === true)}
        />
        <div className="space-y-0.5">
          <p id="marketplace-allow-private-network-label" className="text-sm font-medium">
            사설 네트워크 허용 (loopback / RFC1918)
          </p>
          <p className="text-[11px] text-muted-foreground">
            로컬 또는 사내 마켓플레이스 서버에 접속할 때 활성화합니다. SSRF 가드를 우회하므로 외부 호스트(prod) 환경에서는 끄세요.
          </p>
        </div>
      </div>
    </div>
  );
}
