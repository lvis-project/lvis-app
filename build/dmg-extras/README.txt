LVIS 설치 안내 / LVIS Installation Guide
========================================

[한국어]
1. 왼쪽의 'LVIS.app' 을 오른쪽 'Applications' 폴더로 드래그하세요.
2. 'setup.command' 를 더블클릭하세요.
   ⚠️ "확인할 수 없는 개발자" 경고가 뜨면:
      - Finder 에서 'setup.command' 를 우클릭 → "열기"
      - 확인 창에서 다시 "열기" 클릭
3. Terminal 이 열리고 LVIS 가 자동으로 실행됩니다.

[English]
1. Drag 'LVIS.app' on the left to the 'Applications' folder on the right.
2. Double-click 'setup.command'.
   ⚠️ If macOS shows "cannot be verified" warning:
      - In Finder, right-click 'setup.command' → "Open"
      - Click "Open" again to confirm
3. Terminal opens and LVIS launches automatically.

----

왜 이 단계가 필요한가요? / Why this extra step?

이 빌드는 Apple Developer ID 로 서명되지 않은 내부 빌드입니다.
macOS Gatekeeper 는 다운로드된 앱에 quarantine 속성을 부여해 자동 차단하는데,
'setup.command' 가 이 속성을 제거하여 정상 실행되도록 합니다.

This is an internal build not signed with an Apple Developer ID.
macOS attaches a 'quarantine' attribute to downloaded apps and Gatekeeper
blocks them by default. 'setup.command' removes that attribute so LVIS
can launch normally.
