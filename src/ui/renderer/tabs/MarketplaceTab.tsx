import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import type { LvisApi } from "../types.js";

const DEFAULT_MARKETPLACE_BASE_URL = "https://marketplace.lvisai.xyz";

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

  const openMarketplace = () => {
    const raw = baseUrl.trim() || DEFAULT_MARKETPLACE_BASE_URL;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      url = new URL(DEFAULT_MARKETPLACE_BASE_URL);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      url = new URL(DEFAULT_MARKETPLACE_BASE_URL);
    }
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-4 pt-4">
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
        마켓플레이스 설정은 다음 앱 부팅부터 적용됩니다. URL 변경은 부트스트랩 배너의 “다시 시도” 버튼으로 즉시 재시도할 수 있고, API 키 변경은 fetcher 재구성을 위해 앱 재시작이 필요합니다.
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="text-sm font-medium">마켓플레이스 서버 URL</label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={openMarketplace}
            title="현재 설정된 마켓플레이스를 시스템 브라우저로 엽니다"
          >
            마켓플레이스로 이동
          </Button>
        </div>
        <Input
          type="url"
          placeholder={DEFAULT_MARKETPLACE_BASE_URL}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          lvis-marketplace REST API 엔드포인트. 사내 배포 시 사내 호스트로 변경하세요. 비워두면 마켓플레이스 기능이 비활성화됩니다.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">API 키 (선택)</label>
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
        <button
          type="button"
          role="checkbox"
          aria-checked={allowPrivateNetwork}
          aria-labelledby="marketplace-allow-private-network-label"
          className={`relative mt-0.5 h-5 w-5 flex-shrink-0 rounded border-2 transition-colors cursor-pointer hover:border-primary/60 ${
            allowPrivateNetwork ? "border-primary bg-primary" : "border-muted-foreground"
          }`}
          onClick={() => setAllowPrivateNetwork(!allowPrivateNetwork)}
        >
          {allowPrivateNetwork && (
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-primary-foreground">
              ✓
            </span>
          )}
        </button>
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
