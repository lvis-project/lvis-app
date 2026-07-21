# Release Process

한국어 운영 요약. 현재 영어 기준 문서는 [release process](../../development/release-process.md)이며, 이 문서는 실제 public unsigned release 순서를 빠르게 확인하기 위한 보조 문서다.

## 현재 public unsigned release 순서

1. **release PR을 먼저 머지한다.** `main` 직접 push는 금지한다. version, CHANGELOG, 그리고 `package.json#lvisRelease`의 `tagDistribution: public` / `signing: unsigned`을 PR에서 검토하고 CI가 clean인지 확인한다.
> **필수 사전 조건:** public tag를 push하기 전 active `v*` tag ruleset으로 creation/update/delete를 제한하고 지정된 release operator만 bypass할 수 있게 한다. workflow는 `github.ref_protected`와 publish 직전 annotated tag의 peeled commit == `github.sha`를 모두 확인한다.

2. **머지 commit에 annotated tag를 만든다.** PR을 `--merge`로 머지한 뒤 main의 merge SHA에 `git tag -a vX.Y.Z -m "LVIS vX.Y.Z"`를 만들고 push한다. PR merge 전에 tag를 push하지 않는다.
3. **tag workflow는 event SHA에 고정된다.** Build Installers는 `github.sha`를 checkout하고 `HEAD == github.sha`를 검증한다. public tag는 `--skip-code-sign`으로 macOS/Linux/Windows를 빌드한다.
4. **draft Release와 23개 asset을 검증한다.** versioned asset/update metadata 13개와 `LVIS-latest-*` alias 10개, 세 OS build log와 macOS unsigned smoke skip 사유를 확인한다.
5. **Release body의 disclosure를 유지한 채 record를 완성한다.** draft의 unsigned/SmartScreen/Gatekeeper/Linux checksum 경고를 보존하고, 두 `PENDING` 항목을 실제 unsigned 승인과 deferred signed-Windows evidence reference로 바꾼다. CHANGELOG는 그 아래에 합성해 추가한다. CHANGELOG만 `--notes-file`로 덮어써 disclosure를 삭제하면 안 된다.
6. **그 후에만 publish한다.** 완성된 body와 asset을 재확인한 후 `gh release edit vX.Y.Z --draft=false`를 실행한다.

## workflow 구조

- `release-profile`: tag/version/profile과 immutable source SHA를 fail-closed 검증한다.
- `installers`: 세 native OS matrix가 unsigned installer를 artifact로만 업로드한다. 이 job은 `contents: read`를 가진다.
- `publish-release`: 모든 artifact와 stable alias를 한 번에 draft GitHub Release에 붙인다. 이 job만 `contents: write`를 가진다.

## 향후 signed release

서명/notarization credential을 이 workflow에 추가하는 것으로 signed release가 되지 않는다. macOS codesign/notarization과 Windows Authenticode의 양성 검증을 포함하는 별도 reviewed workflow와 evidence gate가 추가되기 전까지 public tag profile은 `unsigned`만 허용한다.

## 주의

- annotated tag의 `git ls-remote` 기본 결과는 tag object SHA다. commit SHA가 필요하면 peeled `refs/tags/vX.Y.Z^{}`를 확인한다.
- multi-repo workspace에서는 모든 git 명령을 `git -C <absolute-path>`로 실행해 cwd drift를 피한다.
