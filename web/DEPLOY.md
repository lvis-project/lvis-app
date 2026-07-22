# 배포 — Cloudflare Pages

이 사이트는 **Cloudflare Pages**(프로젝트 `lvisai-xyz`)로 배포합니다.

## 자동 배포 (기본)

`.github/workflows/web-ci.yml`이 **`web/**` 변경이 main에 머지되면 자동으로 배포**합니다
(repo 시크릿 `CLOUDFLARE_API_TOKEN`, Cloudflare Pages: Edit 권한이 설정돼 있어야 발화 —
없으면 워크플로가 경고 후 스킵하고 아래 수동 방식이 폴백). 이제 별도 조치 없이 머지만으로 배포됩니다.

## 수동 배포 (폴백 / 로컬 검증)

git 미연동 direct-upload 방식이라 수동으로도 배포할 수 있습니다:

```bash
npm run build   # → out/
npx wrangler pages deploy out --project-name=lvisai-xyz --branch=main
```

- 프로젝트: `lvisai-xyz` (production 도메인: `lvisai.xyz`)
- wrangler 인증: `npx wrangler login` (OAuth)
- 배포 검증: 라이브 HTML의 `_next/static/chunks/app/page-<hash>.js`가 로컬 `out/`과 일치하는지 확인

## docs.lvisai.xyz 리다이렉트 심

레거시 docs 도메인은 구 프로젝트(`docs-lvisai-xyz`)가 `infra/docs-redirect/`의
`_redirects`로 `lvisai.xyz/docs/*` 301을 반환합니다. 심을 갱신할 일이 있으면:

```bash
npx wrangler pages deploy infra/docs-redirect --project-name=docs-lvisai-xyz --branch=main
```

## 롤백

Cloudflare 대시보드 → Workers & Pages → 프로젝트 → Deployments →
이전 배포의 `…` 메뉴 → **Rollback to this deployment**.

## 로컬 확인

```bash
npm run build
npm run preview   # 정적 out/을 :3000에서 서빙
```

## 엣지 라우터 (apex 트래픽)

`lvisai.xyz` DNS A/AAAA 레코드는 아직 구 GitHub Pages를 가리키지만, 존이 프록시
상태이므로 `infra/edge-router/`의 Worker(`lvisai-xyz-router`)가 `lvisai.xyz/*`,
`www.lvisai.xyz/*` 라우트에서 요청을 가로채 Pages 프로젝트로 프록시합니다
(www는 apex로 301). 갱신:

```bash
cd infra/edge-router && npx wrangler deploy
```

DNS를 CNAME `lvisai-xyz.pages.dev`(Proxied)로 바꾸면 이 Worker는 삭제해도 됩니다
(Pages 커스텀 도메인 바인딩은 이미 생성되어 있어 자동 활성화됨).
