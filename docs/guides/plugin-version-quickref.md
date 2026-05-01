# 플러그인 버전 관리 빠른 참조 (개발자용)

> **대상**: `lvis-plugin-*` 레포에서 플러그인을 개발하거나 release 하는 분
> **자세한 룰**: [`plugin-tool-schema-design.md` §2 SoT 박스](../references/plugin-tool-schema-design.md), [`marketplace-publishing.md` 채널 3](./marketplace-publishing.md)
> **레포별 운영 절차**: 각 plugin repo 루트의 `RELEASING.md`

---

## 1. 핵심 룰: `plugin.json.version` 은 **저자가 결정**한다

마켓플레이스 backend 는 version 을 **자동 bump 하지 않는다**. 다음 release 의 version 을 정하는 건 플러그인 저자.

- 새 plugin repo 시작 시: `plugin.json.version: "0.1.0"` 으로 시작
- 각 release 시 SemVer 규칙으로 직접 bump (patch / minor / major)
- branch push 만으로는 publish 트리거 안 됨 — **SemVer git tag 를 push** 해야 publish 일어남

> 이전 (deprecated) 워크플로우는 `bump_version.py` 가 catalog 의 latest +1 으로 자동 bump 했음. 그 결과 source `plugin.json` 과 catalog 가 갈라져서 사이드로드한 플러그인에 false-positive "업데이트 있음" 배너가 떴음. tag-as-SoT 도입으로 근본 해결.

---

## 2. 매 release 절차 (3 단계)

### Step 1 — version bump PR

release 브랜치에서 `plugin.json.version` (그리고 `package.json.version` 도 같이) 을 새 SemVer 로 올리고 PR.

```bash
git checkout -b release/0.2.0
# 직접 수정하든, 아래 스니펫이든 무방 — 핵심은 plugin.json.version 이 의도한 값
node -e 'const m=require("./plugin.json"); m.version="0.2.0"; require("fs").writeFileSync("plugin.json", JSON.stringify(m,null,2)+"\n")'
node -e 'const p=require("./package.json"); p.version="0.2.0"; require("fs").writeFileSync("package.json", JSON.stringify(p,null,2)+"\n")'
git commit -am "chore(release): 0.2.0"
git push origin release/0.2.0
# → PR → main 머지
```

### Step 2 — main pull + tag push

```bash
git checkout main && git pull
git tag v0.2.0 -m "release 0.2.0"
git push origin v0.2.0
```

이 tag-push 가 publish 트리거. 머지 자체는 publish 안 함.

### Step 3 — Actions 결과 확인

GitHub Actions 의 **Publish to Marketplace** 워크플로우가 다음 8 게이트를 차례로 실행:

1. trigger ref 가 `refs/tags/v*` 인지
2. tag 가 strict SemVer (`vMAJOR.MINOR.PATCH`) 인지 — `v1.2-rc1` / `v01.2.3` 거절
3. `plugin.json.version` 이 non-empty string 인지
4. **tag semver == `plugin.json.version`** — mismatch fail-fast
5. 태그된 commit 이 `origin/main` 에서 reachable
6. `bun install` + `bun run build`
7. `POST /api/v1/plugins/<slug>/versions` → 201
8. (409 일 때만) catalog 의 commit_hash 와 일치 검증

성공하면 catalog 에 새 version 진입.

---

## 3. SemVer 규칙 (이 프로젝트의 룰)

- `MAJOR.MINOR.PATCH` 만 허용 (pre-release / build metadata 미지원: `v1.2.3-rc1`, `v1.2.3+build123` 거절)
- leading zeros 금지 (`v01.2.3` 거절)
- 항상 strictly greater than catalog latest 여야 함 — 같은 version 재시도 또는 이전 version 으로의 회귀는 marketplace 가 거절
- bump 결정 가이드:
  - **patch** (`x.y.z+1`): 버그 수정, 내부 정리, 문서 변경, 의존성 patch
  - **minor** (`x.y+1.0`): 새 tool / event / capability 추가, 기존 기능의 호환되는 확장
  - **major** (`x+1.0.0`): manifest schema breaking change, tool signature 변경, capability 제거

---

## 4. 흔한 실수와 해결

### "tag vX.Y.Z does not match plugin.json version Y"
- 원인: tag 푸시 전에 `plugin.json.version` 을 main 에 머지 안 함
- 해결: Step 1 (version bump PR) 머지 → Step 2 (tag push) 순서 지키기. 잘못 푸시한 tag 는 `git push origin :v0.2.0` 으로 삭제 후 재시도.

### "tag commit X is not reachable from origin/main"
- 원인: tag 가 non-main 커밋 (브랜치 tip 등) 을 가리킴
- 해결: cherry-pick 또는 rebase 로 main 에 올리고 main HEAD 에 tag 다시.

### "tag vX.Y.Z was already published from <sha> — refusing silent re-publish"
- 원인: 동일 tag 가 다른 sha 로 publish 시도됨 (tag rewrite)
- 해결: catalog 는 같은 version 에 다른 artifact 받지 않음. `plugin.json.version` 을 새 값으로 bump 하고 새 tag.

### "tag must be vMAJOR.MINOR.PATCH SemVer"
- 원인: tag 형식이 `v1`, `v1.2`, `v1.2.3-rc1`, `v01.2.3` 등
- 해결: 정확히 `v<숫자>.<숫자>.<숫자>` (leading zero 없음).

### branch push 했는데 publish workflow 가 안 돌아감
- 정상 동작. branch push 는 더 이상 publish trigger 가 아님 — tag push 해야 함.

---

## 5. 새 플러그인 repo 시작 시 체크리스트

- [ ] `plugin.json.version: "0.1.0"`, `package.json.version: "0.1.0"` 로 시작
- [ ] `.github/workflows/publish.yml` 가 있고 trigger 가 `tags: ['v*.*.*']` 인지 (work-proactive 의 publish.yml 을 template 으로)
- [ ] `bump_version.py` (deprecated) 가 없는지 — 있으면 삭제
- [ ] `RELEASING.md` 가 있고 첫 release 의 catalog/source/next 값이 자기 repo 기준으로 적혀 있는지
- [ ] repo Secrets 에 `MARKETPLACE_API_KEY`, `MARKETPLACE_BASE_URL` 등록 여부 확인
- [ ] 첫 release 시 catalog latest +1 (또는 이미 catalog 보다 source 가 앞서면 source 값 그대로) 로 tag

---

## 6. FAQ

**Q. 매 commit 이 자동으로 publish 안 되면 dev 중 변경이 마켓플레이스에 어떻게 반영되나?**
A. 의도된 동작. dev 중에는 마켓플레이스에 publish 하지 않고, release 시점에만 의도적으로 tag 를 push. 사용자는 그 사이에 marketplace 의 stable version 을 받음. 사이드로드 (Settings → 로컬 폴더에서 설치) 로 dev 빌드를 직접 테스트.

**Q. 사이드로드 한 플러그인이 catalog 와 version 다르면 "업데이트 있음" 배너가 뜨나?**
A. 호스트는 카탈로그의 latest 를 비교 대상으로 본다. 따라서 사이드로드 manifest 가 catalog 와 같으면 배너 없음, 더 낮으면 배너 뜸 (= 진짜 업데이트 의미). tag-as-SoT 룰을 따르는 한 사이드로드와 마켓플레이스 install 이 같은 version 을 보장.

**Q. 실수로 tag 를 잘못 만들었으면?**
A. push 전이라면 `git tag -d v0.2.0` 으로 로컬에서 삭제. push 후라면 `git push origin :v0.2.0` 으로 원격에서 삭제. 하지만 catalog 에 이미 publish 됐다면 그 version 은 immutable — yank 만 가능 (admin), bump 후 새 tag 가 정공법.

**Q. catalog 에서 직전 version 을 yank 하고 같은 version 으로 다시 publish 가능한가?**
A. 불가. `(plugin_id, version)` 쌍은 유일성 제약 + immutable. yank 는 노출만 끄고 row 는 남음. 같은 sha 로 재시도는 idempotent (workflow 가 catalog 의 commit_hash 와 비교해서 매치 시 silently OK), 다른 sha 로는 거절.

---

## 자주 보는 링크

- 각 plugin repo 의 `RELEASING.md` — repo-specific 운영 절차
- [`marketplace-publishing.md` 채널 3](./marketplace-publishing.md) — 전체 마켓플레이스 publishing 흐름의 한 챕터
- [`plugin-tool-schema-design.md` §2 SoT 박스](../references/plugin-tool-schema-design.md) — 매니페스트 contract 설계
- [`local-plugin-development.md`](./local-plugin-development.md) — 마켓플레이스 우회 사이드로드 dev 플로우
