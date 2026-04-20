import { describe, expect, it, vi } from "vitest";
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

const { filterCookiesByHost, isCompletionUrl } = await import(
  "../auth-window-service.js"
);

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
      cookie({ name: "a", domain: ".sso.lge.com" }),
      cookie({ name: "b", domain: ".other.com" }),
      cookie({ name: "c", domain: "newep.lge.com" }),
    ];
    const result = filterCookiesByHost(cookies, ["sso.lge.com", "newep.lge.com"]);
    expect(result.map((c) => c.name).sort()).toEqual(["a", "c"]);
  });

  it("선행 점이 있는 domain과 없는 domain을 모두 정규화해 비교한다", () => {
    const cookies = [
      cookie({ name: "dotted", domain: ".space.lge.com" }),
      cookie({ name: "plain", domain: "space.lge.com" }),
    ];
    const result = filterCookiesByHost(cookies, ["space.lge.com"]);
    expect(result).toHaveLength(2);
  });

  it("서브도메인 매칭: a.b.host는 host의 suffix로 인정", () => {
    const cookies = [cookie({ name: "sub", domain: "a.newep.lge.com" })];
    const result = filterCookiesByHost(cookies, ["newep.lge.com"]);
    expect(result).toHaveLength(1);
  });

  it("부분 문자열 매칭은 거부 (evil-lge.com ≠ lge.com)", () => {
    const cookies = [cookie({ name: "evil", domain: "evil-lge.com" })];
    const result = filterCookiesByHost(cookies, ["lge.com"]);
    expect(result).toHaveLength(0);
  });

  it("domain 필드가 없으면 제외", () => {
    const cookies = [cookie({ name: "no-domain", domain: undefined })];
    const result = filterCookiesByHost(cookies, ["lge.com"]);
    expect(result).toHaveLength(0);
  });

  it("allowedHosts가 비어있으면 전부 제외", () => {
    const cookies = [cookie({ name: "a", domain: ".lge.com" })];
    expect(filterCookiesByHost(cookies, [])).toHaveLength(0);
  });

  it("allowedHosts의 선행 점·공백·대소문자를 정규화해 비교한다", () => {
    const cookies = [cookie({ name: "n", domain: "space.lge.com" })];
    // ".LGE.com" (선행 점 + 대문자) + " space.lge.com " (공백 포함) 모두 매칭되어야 함
    expect(filterCookiesByHost(cookies, [".LGE.com"])).toHaveLength(1);
    expect(filterCookiesByHost(cookies, [" space.lge.com "])).toHaveLength(1);
  });

  it("AuthCookie 직렬화: name/value/domain/path/secure/httpOnly/expirationDate", () => {
    const cookies = [cookie({
      name: "n", value: "v", domain: ".lge.com", path: "/p",
      secure: true, httpOnly: true, expirationDate: 1700000000,
    })];
    const [c] = filterCookiesByHost(cookies, ["lge.com"]);
    expect(c).toEqual({
      name: "n", value: "v", domain: ".lge.com", path: "/p",
      secure: true, httpOnly: true, expirationDate: 1700000000,
    });
  });
});

describe("isCompletionUrl", () => {
  it("패턴 중 하나라도 substring으로 포함되면 true", () => {
    expect(isCompletionUrl("https://newep.lge.com/portal", ["newep.lge.com", "space.lge.com"])).toBe(true);
  });

  it("어느 패턴에도 포함되지 않으면 false", () => {
    expect(isCompletionUrl("https://sso.lge.com/login", ["newep.lge.com"])).toBe(false);
  });

  it("빈 패턴 배열은 항상 false", () => {
    expect(isCompletionUrl("https://newep.lge.com", [])).toBe(false);
  });

  it("query/hash 는 매칭 대상에서 제외 — IdP RelayState spoofing 방지", () => {
    // IdP 가 아직 sso.lge.com 에 있는데 RelayState 에 newep.lge.com 을 담고 있는 경우.
    const idpUrlWithRelay =
      "https://sso.lge.com/saml/callback?RelayState=https%3A%2F%2Fnewep.lge.com%2F";
    expect(isCompletionUrl(idpUrlWithRelay, ["newep.lge.com"])).toBe(false);
    // 진짜로 newep.lge.com 으로 navigate 된 경우는 true
    expect(isCompletionUrl("https://newep.lge.com/portal?foo=bar", ["newep.lge.com"])).toBe(true);
    // hash 도 제외
    expect(isCompletionUrl("https://sso.lge.com/login#newep.lge.com", ["newep.lge.com"])).toBe(false);
  });
});
