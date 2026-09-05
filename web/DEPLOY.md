# 배포 — Cloudflare Pages

이 사이트는 **Cloudflare Pages**(프로젝트 `lvisai-xyz`)로 배포합니다.

## 자동 배포 (기본)

`.github/workflows/web-deploy.yml`이 **`web/**` 변경이 main에 머지되면 자동으로 배포**합니다.
`repository_dispatch`(type `deploy-web`)로도 같은 워크플로를 돌릴 수 있습니다.

배포하는 워크플로는 `web-ci.yml`이 **아니라** `web-deploy.yml`입니다. `web-ci.yml`은 스크린샷
출처 검사와 static export 빌드만 하고 배포 단계가 없으므로, 그 런이 `success`여도 사이트는
바뀌지 않습니다. 배포 여부는 `web-deploy.yml` 런에서 확인하세요:

```bash
gh run list --workflow="web-deploy.yml" --limit 10 \
  --json databaseId,status,conclusion,headSha
```

`deploy` job은 `web-production` 환경에서 실행됩니다. 이 환경에는 **사람 승인 규칙이 없어**
머지만으로 끝까지 배포됩니다(2026-09-05 제거 — 승인 대기 런이 조용히 15건까지 쌓여 사이트가
일주일치 구 콘텐츠를 서비스한 뒤). 남아 있는 보호는 **보호 브랜치에서만 배포** 정책 하나이며,
아티팩트 무결성은 승인과 무관하게 deploy job 안에서 강제됩니다 — artifact digest, 번들
SHA-256, source SHA 일치, tar 경로 traversal 차단, 파일별 체크섬.

승인 규칙을 되돌리려면:

```bash
printf '{"reviewers":[{"type":"User","id":42824840}],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}' \
  | gh api repos/lvis-project/lvis-app/environments/web-production -X PUT --input -
```

배포에는 repo 시크릿 `CLOUDFLARE_API_TOKEN`(Cloudflare Pages: Edit)이 필요합니다. 없으면
워크플로는 스킵이 아니라 **실패**하므로, 실패한 런은 아래 수동 방식으로 폴백하세요.

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
