# 플러그인 버전 관리 한 장 가이드

## 한 줄 요약

`plugin.json` 의 `version` 을 직접 올리고 같은 값으로 **git tag 푸시** 하면 마켓플레이스에 release 됩니다. 그 외 (그냥 main 머지 등) 는 release 안 됩니다.

## release 하는 법 (3 줄)

```bash
# 1. plugin.json 의 version 을 새 값으로 PR + 머지
# 2. 그 다음:
git checkout main && git pull
git tag v0.2.0 -m "release 0.2.0"
git push origin v0.2.0
```

`v` 다음 숫자가 `plugin.json.version` 과 정확히 같아야 합니다. 다르면 publish 가 fail.

## 어떤 숫자로 올리지?

`MAJOR.MINOR.PATCH` (예: `0.2.0`).

| 변경 | 올릴 자리 |
|---|---|
| 버그 수정 / 내부 정리 | **PATCH** (`0.2.0` → `0.2.1`) |
| 새 기능 추가 (호환됨) | **MINOR** (`0.2.0` → `0.3.0`) |
| 깨지는 변경 (tool 시그니처 변경 등) | **MAJOR** (`0.2.0` → `1.0.0`) |

마켓플레이스의 catalog 보다 **반드시 더 큰 숫자**여야 합니다 (같거나 작으면 거절).

## 안 되는 것들

- `v1.2` / `v1.2.3-rc1` / `v01.2.3` — 형식 안 맞음
- branch push 만 하고 tag 안 보냄 — release 안 일어남
- main 이 아닌 commit 에 tag — 거절
- 같은 tag 를 다른 commit 으로 다시 push — 거절 (silent rewrite 차단)

## 드리프트 자동 감지 (PR 시점)

`validate-plugin-manifest.yml` (centralized in `lvis-project/.github`) 가 PR 단계에서 source `plugin.json.version` 을 marketplace catalog 의 `latest_stable_version` 과 비교해서, source 가 catalog **이하**일 때 `::warning::` 으로 surface 합니다. 다음 release 때 어디서 bump 시작해야하는지 PR 단에서 보임 — catalog 수동 조회 불필요.

워크플로 자체는 fail 시키지 않습니다 (실제 release-blocker 는 `publish.yml` 의 tag-vs-source check). 정보 제공 목적.

## 첫 release 할 때

`plugin.json` 의 version 이 catalog `latest_stable_version` 과 같거나 뒤쳐진 상태면 source bump PR 부터. 위 드리프트 warning 이 PR CI 에 그대로 떠 있어서 어디로 bump 해야하는지 보임 — `catalog latest + 1` 이 안전한 기본값. 정확한 값은 각 plugin repo 의 `RELEASING.md` 참고.

## 더 알고 싶을 때

- 각 plugin repo 의 `RELEASING.md` — 그 repo 만의 first-release 값 + 트러블슈팅
- [`marketplace-publishing.md` 채널 3](./marketplace-publishing.md) — 마켓플레이스 publish 흐름 전체
- [`plugin-tool-schema-design.md` §2 SoT 박스](../references/plugin-tool-schema-design.md) — 매니페스트 contract

## FAQ 두 개

**Q. 매번 dev 마다 publish 되면 부담스러운데?**
A. 안 됩니다. dev 중에는 마켓플레이스 그대로. release 의도 시점에만 tag 를 push 하세요. 사이드로드 (Settings → 로컬 폴더에서 설치) 로 dev 빌드를 직접 테스트할 수 있습니다.

**Q. tag 잘못 보냈어요.**
A. `git push origin :v0.2.0` 으로 원격에서 삭제 후 다시. 단 catalog 에 이미 publish 됐다면 그 version 은 immutable — yank 만 가능 (admin), bump 후 새 tag 가 정공법.
