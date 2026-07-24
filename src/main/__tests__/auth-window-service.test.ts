import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Cookie } from "electron";

// auth-window-service imports `electron` at module load time. Vitest's default
// node environment can't resolve it, so stub the module to just the shapes
// the service references. The test only exercises pure helpers —
// BrowserWindow / Session are never constructed.
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  session: {},
  app: {},
  ipcMain: {},
}));

const {
  filterCookiesByHost,
  isCompletionUrl,
  shouldGraceCollectClosedAuthWindow,
  sanitizeUrlForLog,
  buildAuthResult,
  buildAuthWindowShellHtml,
  wirePluginAuthPartitionPersistence,
  seedPluginAuthPartitions,
  rememberPluginAuthPartition,
  getTrackedPluginAuthPartitions,
  forgetTrackedPluginAuthPartitions,
} = await import("../auth-window-service.js");

function cookie(overrides: Partial<Cookie>): Cookie {
  return {
    name: "x",
    value: "y",
    domain: ".example.com",
    path: "/",
    secure: false,
    httpOnly: false,
    session: false,
    hostOnly: false,
    sameSite: "unspecified",
    ...overrides,
  } as Cookie;
}

describe("filterCookiesByHost", () => {
  it("허용된 호스트의 쿠키만 통과시킨다", () => {
    const cookies = [
      cookie({ name: "a", domain: ".sso.example.com" }),
      cookie({ name: "b", domain: ".other.com" }),
      cookie({ name: "c", domain: "portal.example.com" }),
    ];
    const result = filterCookiesByHost(cookies, ["sso.example.com", "portal.example.com"]);
    expect(result.map((c) => c.name).sort()).toEqual(["a", "c"]);
  });

  it("선행 점이 있는 domain과 없는 domain을 모두 정규화해 비교한다", () => {
    const cookies = [
      cookie({ name: "dotted", domain: ".space.example.com" }),
      cookie({ name: "plain", domain: "space.example.com" }),
    ];
    const result = filterCookiesByHost(cookies, ["space.example.com"]);
    expect(result).toHaveLength(2);
  });

  it("서브도메인 매칭: a.b.host는 host의 suffix로 인정", () => {
    const cookies = [cookie({ name: "sub", domain: "a.portal.example.com" })];
    const result = filterCookiesByHost(cookies, ["portal.example.com"]);
    expect(result).toHaveLength(1);
  });

  it("부분 문자열 매칭은 거부 (evil-example.com ≠ example.com)", () => {
    const cookies = [cookie({ name: "evil", domain: "evil-example.com" })];
    const result = filterCookiesByHost(cookies, ["example.com"]);
    expect(result).toHaveLength(0);
  });

  it("domain 필드가 없으면 제외", () => {
    const cookies = [cookie({ name: "no-domain", domain: undefined })];
    const result = filterCookiesByHost(cookies, ["example.com"]);
    expect(result).toHaveLength(0);
  });

  it("allowedHosts가 비어있으면 전부 제외", () => {
    const cookies = [cookie({ name: "a", domain: ".example.com" })];
    expect(filterCookiesByHost(cookies, [])).toHaveLength(0);
  });

  it("allowedHosts의 선행 점·공백·대소문자를 정규화해 비교한다", () => {
    const cookies = [cookie({ name: "n", domain: "space.example.com" })];
    // ".EXAMPLE.com" (선행 점 + 대문자) + " space.example.com " (공백 포함) 모두 매칭되어야 함
    expect(filterCookiesByHost(cookies, [".EXAMPLE.com"])).toHaveLength(1);
    expect(filterCookiesByHost(cookies, [" space.example.com "])).toHaveLength(1);
  });

  it("AuthCookie 직렬화: name/value/domain/path/secure/httpOnly/expirationDate", () => {
    const cookies = [cookie({
      name: "n", value: "v", domain: ".example.com", path: "/p",
      secure: true, httpOnly: true, expirationDate: 1700000000,
    })];
    const [c] = filterCookiesByHost(cookies, ["example.com"]);
    expect(c).toEqual({
      name: "n", value: "v", domain: ".example.com", path: "/p",
      secure: true, httpOnly: true, expirationDate: 1700000000,
    });
  });
});

describe("isCompletionUrl", () => {
  it("패턴 중 하나라도 substring으로 포함되면 true", () => {
    expect(isCompletionUrl("https://portal.example.com/portal", ["portal.example.com", "space.example.com"])).toBe(true);
  });

  it("어느 패턴에도 포함되지 않으면 false", () => {
    expect(isCompletionUrl("https://sso.example.com/login", ["portal.example.com"])).toBe(false);
  });

  it("빈 패턴 배열은 항상 false", () => {
    expect(isCompletionUrl("https://portal.example.com", [])).toBe(false);
  });

  it("query/hash 는 매칭 대상에서 제외 — IdP RelayState spoofing 방지", () => {
    // IdP 가 아직 sso.example.com 에 있는데 RelayState 에 portal.example.com 을 담고 있는 경우.
    const idpUrlWithRelay =
      "https://sso.example.com/saml/callback?RelayState=https%3A%2F%2Fportal.example.com%2F";
    expect(isCompletionUrl(idpUrlWithRelay, ["portal.example.com"])).toBe(false);
    // 진짜로 portal.example.com 으로 navigate 된 경우는 true
    expect(isCompletionUrl("https://portal.example.com/portal?foo=bar", ["portal.example.com"])).toBe(true);
    // hash 도 제외
    expect(isCompletionUrl("https://sso.example.com/login#portal.example.com", ["portal.example.com"])).toBe(false);
  });

  it("빈 문자열 패턴은 service 가 trim+filter 후 거부 — 하지만 isCompletionUrl 단독 호출 시 조기 true 위험", () => {
    // isCompletionUrl 자체는 방어적이지 않음 — 빈 문자열이 있으면 모든 URL 매칭.
    // (따라서 openAuthWindow 가 호출 전에 normalize 하는 것이 핵심 방어선.)
    expect(isCompletionUrl("https://anywhere.example.com", [""])).toBe(true);
    // normalize 후 빈 배열이 되면 false.
    expect(isCompletionUrl("https://anywhere.example.com", [])).toBe(false);
  });
});

describe("shouldGraceCollectClosedAuthWindow", () => {
  it("allows closed-event grace collect only after a trusted committed completion URL", () => {
    expect(
      shouldGraceCollectClosedAuthWindow({
        webviewAttached: true,
        lastCommittedUrl: "https://portal.example.com/portal",
        completionPatterns: ["portal.example.com/portal"],
      }),
    ).toBe(true);
  });

  it("rejects pre-attach closes even if a completion URL is known", () => {
    expect(
      shouldGraceCollectClosedAuthWindow({
        webviewAttached: false,
        lastCommittedUrl: "https://portal.example.com/portal",
        completionPatterns: ["portal.example.com/portal"],
      }),
    ).toBe(false);
  });

  it("does not use uncommitted last-seen URLs for the closed-event grace path", () => {
    expect(
      shouldGraceCollectClosedAuthWindow({
        webviewAttached: true,
        lastCommittedUrl: null,
        completionPatterns: ["portal.example.com/portal"],
      }),
    ).toBe(false);
  });

  it("keeps RelayState/query spoofing out of the trusted closed-event grace path", () => {
    expect(
      shouldGraceCollectClosedAuthWindow({
        webviewAttached: true,
        lastCommittedUrl:
          "https://sso.example.com/saml/callback?RelayState=https%3A%2F%2Fportal.example.com%2Fportal",
        completionPatterns: ["portal.example.com/portal"],
      }),
    ).toBe(false);
  });
});

describe("sanitizeUrlForLog", () => {
  it("strips query and hash so callback tokens are never surfaced", () => {
    expect(
      sanitizeUrlForLog("https://hub.example.com/login/callback?code=secret#access_token=token"),
    ).toBe("https://hub.example.com/login/callback");
    expect(sanitizeUrlForLog("not-a-url?token=secret#hash")).toBe("not-a-url");
  });
});

describe("buildAuthResult", () => {
  const cookies = [
    { name: "session", value: "v", domain: ".example.com", path: "/" },
  ];

  it("returnFinalUrl=false: returns the cookies array directly (legacy contract)", () => {
    const result = buildAuthResult(cookies, "https://hub.example.com/login/callback#access_token=t", false);
    expect(result).toEqual(cookies);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returnFinalUrl=true: returns the {cookies, finalUrl} envelope so OAuth fragments survive", () => {
    const finalUrl = "https://hub.example.com/login/callback#access_token=t&token_type=Bearer";
    const result = buildAuthResult(cookies, finalUrl, true);
    expect(result).toEqual({ cookies, finalUrl });
    expect(Array.isArray(result)).toBe(false);
  });
});

describe("buildAuthWindowShellHtml", () => {
  it("Win/Linux: renders HTML titlebar with min/max/close (no native frame)", () => {
    const html = buildAuthWindowShellHtml({
      title: "Login <unsafe>",
      url: "https://sso.example.com/login",
      partition: "persist:plugin-auth:example",
      platform: "win32",
    });
    expect(html).toContain("titlebar-btn");
    expect(html).toContain("id=\"minimize\"");
    expect(html).toContain("id=\"maximize\"");
    expect(html).toContain("id=\"close\"");
    expect(html).toContain("<webview");
    expect(html).toContain("window.lvisWindow");
    expect(html).toContain("https://sso.example.com/login");
    expect(html).toContain("persist:plugin-auth:example");
    expect(html).toContain("<title>Login &lt;unsafe&gt;</title>");
  });

  it("macOS: suppresses HTML titlebar buttons + title text so OS traffic lights aren't duplicated", () => {
    const html = buildAuthWindowShellHtml({
      title: "Login",
      url: "https://sso.example.com/login",
      partition: "persist:plugin-auth:example",
      platform: "darwin",
    });
    expect(html).not.toContain("id=\"minimize\"");
    expect(html).not.toContain("id=\"maximize\"");
    expect(html).not.toContain("id=\"close\"");
    // No <button class="titlebar-btn"> elements should be rendered. The CSS
    // class itself stays in the <style> block (harmless dead rule) — only
    // the DOM rendering is suppressed.
    expect(html).not.toContain("<button class=\"titlebar-btn");
    expect(html).toContain("titlebar-mac");
    expect(html).toContain("<webview");
    // Drag region must remain so users can still move the window.
    expect(html).toContain("-webkit-app-region: drag");
  });

  it("devConsole=true: inlines eruda init script in the shell", () => {
    const html = buildAuthWindowShellHtml({
      title: "Login",
      url: "https://sso.example.com/login",
      partition: "persist:plugin-auth:example",
      platform: "win32",
      devConsole: true,
    });
    // eruda is bundled in node_modules; if it's resolvable we should see init.
    // If absent (CI env quirk) we tolerate empty injection — script must not throw.
    if (html.includes("eruda.init")) {
      expect(html).toContain("__lvis_eruda_booted");
    }
  });

  it("devConsole=false (default): does NOT inline eruda", () => {
    const html = buildAuthWindowShellHtml({
      title: "Login",
      url: "https://sso.example.com/login",
      partition: "persist:plugin-auth:example",
      platform: "win32",
    });
    expect(html).not.toContain("__lvis_eruda_booted");
  });
});

describe("seedPluginAuthPartitions", () => {
  it("seeds in-memory tracker from persisted map", async () => {
    seedPluginAuthPartitions({
      "seed.plugin": [
        "persist:plugin-auth:seed.plugin",
        "persist:plugin-auth:seed.plugin:sub",
      ],
    });
    const partitions = getTrackedPluginAuthPartitions("seed.plugin");
    expect(partitions).toContain("persist:plugin-auth:seed.plugin");
    expect(partitions).toContain("persist:plugin-auth:seed.plugin:sub");
    // Cleanup
    await forgetTrackedPluginAuthPartitions("seed.plugin");
  });

  it("merges with existing in-memory entries (additive)", async () => {
    rememberPluginAuthPartition("persist:plugin-auth:merge.plugin:a");
    seedPluginAuthPartitions({
      "merge.plugin": ["persist:plugin-auth:merge.plugin:b"],
    });
    const partitions = getTrackedPluginAuthPartitions("merge.plugin");
    expect(partitions).toContain("persist:plugin-auth:merge.plugin:a");
    expect(partitions).toContain("persist:plugin-auth:merge.plugin:b");
    // Cleanup
    await forgetTrackedPluginAuthPartitions("merge.plugin");
  });
});

describe("wirePluginAuthPartitionPersistence + rememberPluginAuthPartition", () => {
  beforeEach(() => {
    // Reset to unwired state between tests by wiring no-op stubs.
    wirePluginAuthPartitionPersistence({
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });
  });

  it("calls write callback when a new partition is observed", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    wirePluginAuthPartitionPersistence({
      write,
      delete: vi.fn().mockResolvedValue(undefined),
      onError,
    });

    rememberPluginAuthPartition("persist:plugin-auth:wired.plugin:session");
    // Fire-and-forget — flush microtask queue.
    await Promise.resolve();

    expect(write).toHaveBeenCalledOnce();
    const [map] = write.mock.calls[0] as [Map<string, Set<string>>];
    expect(map.get("wired.plugin")?.has("persist:plugin-auth:wired.plugin:session")).toBe(true);
    // Cleanup
    await forgetTrackedPluginAuthPartitions("wired.plugin");
  });

  it("calls delete callback when forgetTrackedPluginAuthPartitions is called", async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    wirePluginAuthPartitionPersistence({
      write: vi.fn().mockResolvedValue(undefined),
      delete: deleteFn,
      onError: vi.fn(),
    });

    rememberPluginAuthPartition("persist:plugin-auth:forget.plugin");
    await forgetTrackedPluginAuthPartitions("forget.plugin");

    expect(deleteFn).toHaveBeenCalledWith("forget.plugin");
  });

  it("routes write errors to onError callback, does not throw", async () => {
    const onError = vi.fn();
    wirePluginAuthPartitionPersistence({
      write: vi.fn().mockRejectedValue(new Error("disk full")),
      delete: vi.fn().mockResolvedValue(undefined),
      onError,
    });

    rememberPluginAuthPartition("persist:plugin-auth:err.plugin");
    // Flush microtask queue so the rejection handler runs.
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    // Cleanup
    await forgetTrackedPluginAuthPartitions("err.plugin");
  });

  it("keeps retry ownership and rejects when durable tracker deletion fails", async () => {
    wirePluginAuthPartitionPersistence({
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error("disk locked")),
      onError: vi.fn(),
    });
    rememberPluginAuthPartition("persist:plugin-auth:retry.plugin:tenant");

    await expect(
      forgetTrackedPluginAuthPartitions("retry.plugin"),
    ).rejects.toThrow("disk locked");
    expect(getTrackedPluginAuthPartitions("retry.plugin")).toContain(
      "persist:plugin-auth:retry.plugin:tenant",
    );
    wirePluginAuthPartitionPersistence({
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    });
    await forgetTrackedPluginAuthPartitions("retry.plugin");
  });
});
