import { describe, expect, it } from "vitest";
import type { Cookie } from "electron";

import { filterCookiesByHost, isCompletionUrl } from "../auth-window-service.js";

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
});
