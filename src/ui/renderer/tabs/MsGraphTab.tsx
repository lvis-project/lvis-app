import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";

type Environment = "external" | "corporate";

interface EnvironmentInfo {
  id: Environment;
  label: string;
  description: string;
  configured: boolean;
}

interface MsGraphState {
  environment: Environment;
  isAuthenticated: boolean;
  account: string | null;
  configured: boolean;
  label: string;
  environments: EnvironmentInfo[];
}

interface Api {
  msGraphGetState: () => Promise<MsGraphState>;
  msGraphSwitchEnvironment: (
    env: Environment,
  ) => Promise<{ ok: boolean; state?: unknown }>;
  msGraphSignIn: () => Promise<{ ok: boolean; error?: string; state?: unknown }>;
  msGraphSignOut: () => Promise<{ ok: boolean; state?: unknown }>;
}

/**
 * Microsoft Graph 로그인 환경 택1 + 현재 계정 관리.
 *
 * 외부/사내 두 app registration 중 사용할 것을 선택. 환경별 토큰은 별개 파일에
 * 저장되므로 전환해도 이전 환경 로그인은 유지되고, 다시 돌아오면 재로그인 불필요.
 *
 * 미구성 환경(`__FILL_IN__` placeholder 남아있는 경우) 는 선택 불가 + 안내 노출.
 */
export function MsGraphTab({ api }: { api: Api }) {
  const [state, setState] = useState<MsGraphState | null>(null);
  const [busy, setBusy] = useState<null | "switch" | "sign-in" | "sign-out">(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await api.msGraphGetState();
      setState(s);
      setError(null);
    } catch (err) {
      setError(`상태 조회 실패: ${(err as Error).message}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!state) {
    return <div className="p-4 text-sm text-muted-foreground">로딩 중...</div>;
  }

  const onSwitch = async (env: Environment) => {
    if (env === state.environment) return;
    setBusy("switch");
    setError(null);
    try {
      const r = await api.msGraphSwitchEnvironment(env);
      if (!r.ok) setError("환경 전환 실패");
      await refresh();
    } catch (err) {
      setError(`전환 실패: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onSignIn = async () => {
    setBusy("sign-in");
    setError(null);
    try {
      const r = await api.msGraphSignIn();
      if (!r.ok) setError(r.error ?? "로그인 실패");
      await refresh();
    } catch (err) {
      setError(`로그인 실패: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onSignOut = async () => {
    setBusy("sign-out");
    setError(null);
    try {
      await api.msGraphSignOut();
      await refresh();
    } catch (err) {
      setError(`로그아웃 실패: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 p-2">
      <div>
        <h3 className="text-sm font-semibold">Microsoft 계정 환경</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          외부 Microsoft / LG 사내 테넌트 중 하나를 골라 로그인합니다. 환경별
          토큰이 별도로 저장되어 서로 간섭하지 않습니다.
        </p>
      </div>

      <div className="space-y-2">
        {state.environments.map((env) => {
          const active = env.id === state.environment;
          return (
            <label
              key={env.id}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${
                active ? "border-primary bg-primary/5" : "border-border hover:bg-accent/30"
              } ${!env.configured ? "opacity-50" : ""}`}
            >
              <input
                type="radio"
                name="msgraph-env"
                value={env.id}
                checked={active}
                disabled={!env.configured || busy !== null}
                onChange={() => void onSwitch(env.id)}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{env.label}</span>
                  {!env.configured && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                      미구성
                    </span>
                  )}
                  {active && (
                    <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px]">
                      현재 선택
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {env.description}
                </p>
                {!env.configured && env.id === "corporate" && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    사내 IT 에서 받은 tenant ID 를 <code>src/main/ms-graph-auth-config.ts</code> 에 입력 필요.
                  </p>
                )}
              </div>
            </label>
          );
        })}
      </div>

      <div className="rounded-md border bg-muted/30 p-3 space-y-2">
        <div className="text-xs text-muted-foreground">현재 상태</div>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{state.label}</span>
          <span className="text-muted-foreground">·</span>
          {state.isAuthenticated ? (
            <>
              <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[11px] text-green-700 dark:text-green-300">
                로그인 됨
              </span>
              <span className="text-xs text-muted-foreground">
                {state.account ?? "-"}
              </span>
            </>
          ) : (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              로그인 필요
            </span>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            size="sm"
            disabled={!state.configured || busy !== null || state.isAuthenticated}
            onClick={() => void onSignIn()}
          >
            {busy === "sign-in" ? "로그인 중..." : "로그인"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!state.isAuthenticated || busy !== null}
            onClick={() => void onSignOut()}
          >
            {busy === "sign-out" ? "로그아웃 중..." : "로그아웃"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}
