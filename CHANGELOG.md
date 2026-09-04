# Changelog

## Unreleased

- **확인 카드는 그 대화가 있는 판 안에 나타나고, 창 하단 띠는 사라졌습니다.** 도구 승인
  카드와 모델의 질문 카드는 그 대화가 열린 판이 워크보드·설정·플러그인 화면을 보여주는
  동안에도 그 판의 아래쪽에 그대로 나타납니다(어느 대화가 기다리는지 카드가 알려줍니다).
  사이드 챗의 승인과 질문도 사이드 챗 안에서 답합니다. 대화에 속하지 않은 호스트·플러그인
  요청은 포커스된 판의 오른쪽 위에 답변 카드로 뜨고 포커스를 따라옵니다. 창 하단에 카드를
  모아 두던 띠는 없어졌습니다.

- **답을 기다리는 대화는 사이드바에 노란 점으로 표시됩니다.** 승인이나 질문에 멈춘 대화는
  카드가 화면에 보이든 아니든 사이드바의 그 대화 줄(사이드 챗이면 부모 대화 줄에도)에
  노란 점이 붙습니다. 카드가 다른 판에 가려지거나 닫힌 작업 패널·다른 탭 뒤에 있으면
  가린 판의 최대화 버튼, 작업 패널 토글과 사이드 챗 탭에도 같은 점이 붙고, 대화를
  지목하지 않은 플러그인 요청은 플러그인 메뉴에 붙습니다.

- **창 알림은 한 번만, 대화 알림은 그 대화의 타일에만 보입니다.** 호스트 알림·플러그인
  설치 진행·앱 업데이트 안내처럼 창 전체에 관한 알림이 열린 타일마다 작성창 위에
  반복해서 그려졌고, 공급자 자동 전환 안내는 실제로 전환된 타일이 아니라 포커스된
  타일 기준으로만 표시되었습니다. 이제 창 알림·마켓플레이스 공지·승인 기억 안내는
  타일 격자 위의 알림 띠에 한 번만 흐름 안에 놓이고(타일의 우상단 카드 레인을 덮지
  않음), 첨부 거부·공급자 전환·사전 압축 같은 대화 알림은 해당 타일의 작성창 위에만
  표시됩니다. 권한 설정의 감사 로그도 창 오른쪽에 고정되던 패널 대신 설정 섹션 안에
  펼쳐져 옆 타일과 제목 표시줄을 가리지 않습니다.

- **플러그인 알림 카드는 지금 보고 있는 판에만 나타납니다.** 판이 워크보드·설정·플러그인
  화면을 보여주는 동안 도착한 플러그인 알림 카드(예: 메일 작업 제안)가 판 바깥의 창
  하단 띠에 나타났고, 판을 여러 개 열어 두면 카드가 도착할 때 포커스가 있던 판마다
  하나씩 남았습니다. 이제 대화에 속하지 않은 카드는 포커스된 판의 오른쪽 위에 하나만
  떠 있고, 다른 판을 누르면 그 판으로 따라옵니다. 판이 무엇을 보여주든 같은 자리이며,
  카드의 확인은 그 판에서 실행됩니다. 원래 대화가 화면에서 사라진 카드는 그 대화의
  사이드바 줄에 노란 점으로 표시되고, 대화를 다시 열면 그 판에 나타납니다.

- **앱이 강제 종료되거나 충돌해도 플러그인 워커가 남지 않습니다.** 플러그인의 장기 실행
  워커(예: 문서 인덱서)는 앱이 정상 종료 절차를 밟을 때만 함께 정리되었고, 앱이 강제
  종료되거나 충돌하면 그대로 남아 앱을 다시 켤 때마다 하나씩 쌓였습니다. 이제 호스트는
  워커의 표준 입력을 열어 둔 채 아무것도 쓰지 않으며, 그 통로는 호스트 프로세스가
  사라질 때만 닫힙니다. 워커는 그 닫힘을 종료 신호로 읽으므로 호스트가 어떤 방식으로
  끝나든 함께 끝납니다.

- **모든 대화가 사이드바 대화 탭에 나타납니다.** 지금까지 대화 탭은 본 채팅 저장소만
  읽었기 때문에, 루틴이 실행한 대화와 워크보드 작업의 실행 대화, 워크스페이스 사이드
  챗은 사이드바에서 볼 길이 없었습니다. 이제 본 대화·루틴 실행·워크보드 실행이 각각
  알맞은 아이콘과 함께 한 줄씩 나타나고, 사이드 챗은 그 대화가 시작된 본 대화 아래에
  들여쓰기로 붙습니다. 누르면 루틴 실행은 대화로 열리고, 워크보드 실행은 그 작업의
  상세와 가장 최근 실행 기록으로, 사이드 챗은 그 대화를 연 뒤 그 타일의 사이드 챗
  탭으로 열립니다. 본 대화가 아닌 줄은 열기만 되며 이름 바꾸기·보관·고정·끌어
  옮기기는 되지 않습니다. 서브에이전트와 브리핑 실행은 이미 그 대화 안의 서브에이전트
  탭에서 볼 수 있으므로 목록에 따로 나타나지 않습니다.

- **루틴 화면의 실행 목록이 사이드바와 같은 줄을 보여 줍니다.** 같은 실행 대화인데도
  루틴 화면은 절대 시각(`2026년 5월 16일 오후 9:00`)으로, 사이드바는 상대 시각
  (`3분 전`)으로 적어 두 화면이 같은 실행을 다르게 읽히게 했습니다. 이제 두 목록이
  한 곳에서 만든 같은 줄을 읽고 같은 시각 표기를 씁니다.

- **플러그인 설치를 건너뛴 까닭도 화면 낭독기에 읽힙니다.** 창 위쪽 띠의 부트스트랩
  알약은 설치를 건너뛴 까닭을 마우스를 올려야 보이는 설명 상자에만 적어 두었습니다.
  설명 상자의 글은 접근성 정보에 들어가지 않으므로, 화면 낭독기를 쓰는 사용자에게는
  "알림 닫기" 라는 말만 읽히고 무엇을 왜 건너뛰었는지는 전해지지 않았습니다. 이제
  실패 알약과 마찬가지로 그 까닭이 알약의 이름에도 함께 들어갑니다.
- **플러그인 설치를 건너뛴 까닭이 한국어로 읽힙니다.** 부트스트랩 알약은 건너뛴 까닭을
  영어 문장 그대로 한국어 안내문 안에 끼워 넣었고, 앞머리에는 언제나 "마켓플레이스
  부트스트랩 건너뜀" 이라고 적었습니다. 그래서 마켓플레이스와 무관한 격리 테스트
  모드에서 건너뛴 경우에도 마켓플레이스 문제인 것처럼 읽혔습니다. 이제 건너뛴 까닭은
  정해진 세 가지(격리 테스트 모드, 마켓플레이스 주소 미설정, 카탈로그 연결 실패) 로
  전달되고 화면에서 번역되며, 연결 실패일 때만 그 요청이 돌려준 원래 메시지가 뒤에
  덧붙습니다.

- **개발자용 Dev 단추가 옆에 선 다른 상태 알약과 같은 모양이 되었습니다.** 개발 빌드에서만
  보이는 단추라 혼자 다른 글꼴과 다른 여백을 쓰고 있었습니다. 이제 같은 띠에 놓인 앱
  업데이트·플러그인 업데이트·부트스트랩 알약과 같은 알약 모양을 씁니다. 누르면 열리는
  것과 ⇧⌘D 단축키는 그대로입니다.
- **계획 단계 에이전트는 이제 웹 문서 가져오기(web_fetch)를 쓰지 않습니다.** 작업 보드가
  계획을 세울 때 붙여 주는 도구 목록은 손으로 적어 둔 이름 목록이었는데, 이제 도구가
  스스로 밝힌 권한 등급에서 읽기 등급만 골라 만듭니다. 목록을 고치지 않아도 새로 설치한
  플러그인의 읽기 도구가 곧바로 계획 단계에 들어오고, 반대로 바깥으로 나가는 요청을
  보내는 web_fetch 는 읽기 등급이 아니므로 빠집니다. 웹 검색(web_search)과 파일 읽기는
  그대로 쓰입니다.
- **설정으로 데려다주는 단추가 탭이 아니라 옵션 자리까지 갑니다.** 마켓플레이스 공지의
  단추와 플러그인이 처음 켤 때 띄우는 안내 카드는 지금까지 설정 탭까지만 데려다주었고,
  정작 켜야 할 스위치는 그 탭에 있는 여러 항목 가운데 하나여서 사용자가 다시 찾아야
  했습니다. 이제 목적지를 `<탭>/<섹션>` 으로 적을 수 있고, 도착하면 그 항목까지
  화면이 내려가 잠깐 테두리가 생기고 키보드 초점도 그리로 옮겨집니다. 움직임을 줄이는
  설정을 쓰는 분에게는 스크롤과 테두리가 애니메이션 없이 곧바로 적용됩니다. 이 빌드에
  없는 탭이나 섹션을 가리키는 단추는 예전처럼 아예 그리지 않고, 플러그인이 없는 자리를
  가리키면 매니페스트를 읽는 단계에서 거부합니다.
- **앱을 처음 켤 때 일어난 플러그인 설치 실패가 이제 위쪽 띠의 상태 알약에 뜹니다.** 앱은
  처음 켤 때 관리 대상 플러그인을 내려받아 설치합니다. 그런데 마켓플레이스에 닿지 못하거나
  일부 플러그인의 설치가 실패해도 화면에는 아무것도 뜨지 않았습니다. 설치가 모두 끝난
  다음에야 화면이 열렸고, 그래서 실패를 알리는 신호가 아직 아무도 듣지 않는 화면으로
  갔기 때문입니다. 상태 알약이 있는 이유가 바로 이 실패를 보여 주는 것인데, 정작 그
  실패만 보이지 않았습니다. 이제 화면은 열리는 순간 마지막 상태를 직접 물어서 가져오므로,
  처음 켤 때 일어난 실패도 상태 알약에 그대로 뜨고 거기서 곧바로 다시 시도할 수 있습니다.

- **일하는 중인 상태 알약도 마우스를 올리거나 탭 키로 옮기면 설명이 열립니다.** 창 위쪽 띠에
  뜨는 상태 알약은 내려받기나 설치가 진행되는 동안 눌리지 않게 막혀 있었고, 그 바람에 지금
  몇 퍼센트인지와 어느 판을 받는 중인지를 적어 둔 설명 상자까지 함께 열리지 않았습니다.
  이제 진행 중에도 설명 상자는 열리며, 눌러도 아무 일이 일어나지 않는 것은 그대로입니다.
  플러그인 업데이트가 실패했을 때는 어느 플러그인이 왜 실패했는지를 설명 상자뿐 아니라
  알약의 이름에도 넣어, 화면 낭독기를 쓰는 사용자에게도 실패가 읽힙니다.
- **남아 있던 확인 창 두 개를 없앴습니다.** 설정 › 권한에서 저장해 둔 권한
  결정을 지울 때 확인 창이 떴습니다. 결정을 지운다고 잃는 것은 없고 다음 요청
  때 다시 물어볼 뿐이므로, 이제 누르는 즉시 지웁니다. 이미지를 읽지 못하는
  모델에 이미지를 붙여 보낼 때는 "이미지를 빼고 보낼까요" 를 물었습니다. 이제
  묻지 않고 전송 자체를 막습니다. 입력창 아래에 지금 모델이 이미지를 받지
  않는다고 적히고, 이미지를 빼거나 이미지를 읽는 모델로 바꾸면 그대로
  보내집니다. 쓰던 글과 첨부는 그대로 남습니다.

- **마켓플레이스 공지가 앱 안의 자리를 가리킬 수 있습니다.** 새 기능을 알리는 공지에
  단추가 최대 세 개까지 붙습니다. 단추를 누르면 그 기능이 있는 설정 탭으로 가거나,
  안내 문서를 브라우저에서 엽니다. 단추는 데려다주기만 하고 설정을 바꾸지 않습니다.
  공지는 마켓플레이스에서 받아 온 글이므로, 단추가 설정을 바꿀 수 있다면 바깥에서
  쓴 글이 이 컴퓨터의 설정을 바꾸는 통로가 됩니다. 기능을 켜는 것은 도착한 자리에서
  사용자가 직접 합니다. 지금 쓰는 앱에 없는 자리를 가리키는 단추는 아예 그리지
  않습니다.

- **플러그인이 권하는 첫 작업을 카드로 물어보고, 답을 기억합니다.** 투어를 마치면
  플러그인이 권하는 첫 작업이 떴는데, 지금까지는 화면 오른쪽 아래에 뜨는 별도
  카드였고 닫으면 그것으로 끝이라 다음에 켜면 또 떴습니다. 이제 그 제안이 다른
  플러그인 알림과 같은 자리, 곧 타일 오른쪽 위 카드로 들어옵니다. 카드에는
  "승인", "다음에 다시 보기", "그만 보기" 세 답이 있고, 고른 답을 앱이 기억합니다.
  "그만 보기" 는 다시 묻지 않고, "다음에 다시 보기" 는 다음 실행 때 한 번 더
  물어봅니다. 한 번에 한 장만 뜨고, 답을 해야 다음 제안이 나옵니다. 플러그인은 첫
  작업 외에 기능 소개와 새 기능 안내를 최대 다섯 건까지 같은 방식으로 제안할 수
  있습니다.
- **질문 카드에 답을 직접 적을 수 있습니다.** 모델이 묻는 질문에 보기만 고를 수
  있어서, 적어 내야 하는 답은 모델이 "입력" 이라는 이름의 보기를 하나 만들어 두는
  식이었습니다. 그 보기는 단추로 그려졌고, 단추에는 적을 수가 없었습니다. 이제
  적어 내는 질문은 입력칸으로 나옵니다. 입력칸은 도구가 그렇게 묻겠다고 밝힌
  질문에만 생기며, 빈 답과 길이를 넘긴 답은 받지 않습니다.
- **미뤄 둔 승인을 질문 카드로 묻습니다.** 도구 호출이 승인 대기열로 밀리면
  지금까지는 입력창 위에 작은 띠가 떴습니다. 그 띠는 승인 문구를 먼저 입력해야
  나타났고, 창에 하나만 떠서 어느 대화의 요청인지 알 수 없었습니다. 이제 다른
  질문과 같은 카드로 묻습니다. 카드는 그 요청을 낸 대화에만 나타나고, 허용 ·
  거절 · 나중에 결정 중에서 고르면 됩니다. 허용은 대기열 항목이 열어 줄 범위를
  기록해 둔 경우에만 나타나며, 그 범위는 이 대화로 한정됩니다.
- **원격 제어 공유를 물을 때 브라우저 대화상자를 쓰지 않습니다.** 페어링한
  계정에 현재 대화의 제어 권한을 넘길 때 앱 전체를 멈추는 창이 떴습니다. 이제
  해당 줄에서 한 번 더 확인합니다. 확인 문구와 결과는 이전과 같습니다.

- **권한 검증 전환 제안이 승인 카드 안으로 들어왔습니다.** 짧은 시간에 승인을
  여러 번 하거나 "항상 허용"을 고르면 LLM 권한 검증으로 바꾸겠느냐고 물어보는데,
  지금까지는 화면 오른쪽 위에 잠깐 떴다가 사라지는 알림이었습니다. 이제 그 제안이
  승인 카드 안에 띠로 붙습니다. 승인을 판단하는 자리에서 바로 전환하거나 나중으로
  미룰 수 있고, 제안이 올라온 순간에 카드가 없으면 다음 승인 카드까지 기다립니다.
- **플러그인 업데이트와 플러그인 설치 상태를 상단 바에서 알립니다.** 화면 오른쪽 위에
  떠서 대화를 가리던 알림 두 개를 없앴습니다. 두 알림은 앱 업데이트 표시가 있던 자리,
  곧 상단 바의 같은 줄에 같은 모양으로 들어갑니다. 알릴 내용이 없으면 아무것도
  그리지 않으므로, 평소 상단 바 모습은 이전과 같습니다.

- **`~/.lvis` 문서 업그레이드를 설정에서 처리합니다.** 배포본 문서가 바뀌면 그동안은
  `AGENTS.md.new` 안내 파일이 생기고 부팅 알림이 한 번 뜰 뿐, 답하려면 디렉토리를
  열어 손으로 비교해야 했습니다. 이제 설정 > 역할의 AGENTS.md 섹션이 밀린 안내를
  목록으로 보여 주고, 항목마다 **차이 보기 / 배포본 적용 / 내 것 유지**를 고를 수
  있습니다. 스킬·프롬프트 문서의 안내는 경로만 함께 보여 줍니다.
- **"항상 최신 내용 유지"를 켜면 배포본을 따라가면서 내 내용이 남습니다.** 배포본을
  적용할 때 사용자가 쓴 내용이 `~/.lvis/agents.custom.md` 로 옮겨지고, `AGENTS.md`
  는 배포본이 됩니다. 매 턴 시스템 프롬프트가 `AGENTS.md` 다음에
  `agents.custom.md` 를 읽으므로 두 내용이 어긋나면 사용자가 쓴 쪽을 따릅니다.
  이때부터 설정의 편집기는 `agents.custom.md` 를 편집하고 배포본은 읽기 전용으로
  나란히 보입니다.
- **갱신하기 — 모델이 두 문서를 합쳐 줍니다.** 배포본과 사용자가 쓴 내용을 모델에게
  넘겨 하나로 합치고, 결과를 `~/.lvis/AGENTS.md.merged` 에 먼저 씁니다. 확인한 뒤
  **적용**을 눌러야 실제 문서에 반영되며, 병합을 기다리는 동안 문서가 바뀌었으면
  덮어쓰지 않고 알려 줍니다.

## v0.9.1 — 2026-09-03

v0.9.0 을 잇는 패치입니다. 한동안 꺼져 있던 **유휴 시간 작업**이 돌아오고,
문서 검색 도구의 주인이 인덱서 플러그인으로 정리됩니다.

- **유휴 시간 작업이 다시 돕니다** (#2397). 선호도 갱신과 기억 정리는 유휴 스케줄러가
  알려 줄 때만 움직이는데, 그 스케줄러가 플러그인 조회 결과에 매달려 있어서
  한동안 아예 만들어지지 않았습니다. 이제 플러그인과 무관하게 켜집니다.
- **문서 검색 도구는 인덱서 플러그인이 가집니다** (#2397). 호스트가 따로 들고 있던
  문서 검색·목록·본문 도구를 없앴습니다. 같은 일을 local-indexer 플러그인의
  `index_search`, `index_documents`, `index_get_document` 가 합니다.
- **문서 업그레이드 안내 파일이 버전당 하나만 남습니다** (#2395). 사용자가
  고친 `~/.lvis/AGENTS.md` 와 배포본이 다를 때 내려 두는 `AGENTS.md.new`
  안내 파일이, 빌드가 바뀔 때마다 날짜 붙은 사본을 하나씩 더 만들어 수백 개까지
  쌓일 수 있었습니다. 이제 같은 배포본은 한 번만 안내하고, 이미 배포됐던 내용과
  똑같은 예전 사본은 치웁니다.

## v0.9.0 — 2026-09-03

타일이 **대화 전용이 아니게 되었습니다.** v0.8.0 에서 들어온 타일 워크벤치는
타일마다 대화 하나만 담을 수 있었는데, 이제 업무 보드·루틴·인사이트·설정·
플러그인 화면이 모두 자기 타일 안에 그려집니다. 왼쪽에서 대화를 이어가면서
오른쪽에 업무 보드를 띄워 두는 식입니다.

여기에 더해 **다른 기기의 브라우저에서 이 데스크탑의 대화를 보고 조종할 수
있게** 되었고, 업무 보드가 **일간/주간 브리핑**으로 할 일을 직접 채웁니다.

### 타일에 무엇이든 담깁니다

- **모든 화면이 같은 패널 프레임을 씁니다** (#2368, #2373, #2374, #2375,
  #2376). 업무 보드·루틴·인사이트·설정·플러그인 화면이 대화와 똑같이 테두리와
  자기 헤더를 갖고, 그 헤더가 예전의 전역 헤더를 대신합니다. 화면마다 제각각
  이던 레이아웃 시작점이 하나로 합쳐졌습니다.
- **뷰는 그 뷰를 연 타일 안에 그려집니다** (#2382). 예전에는 사이드바에서
  업무 보드를 고르면 대화 영역 전체를 덮었습니다. 이제 포커스된 타일만
  바뀌고 옆 타일은 자기 대화를 계속 그립니다.
- **새 타일에서 열기, 그리고 뒤로/앞으로** (#2378). 사이드바 항목을 새
  타일에서 열 수 있고, 뒤로·앞으로는 포커스된 타일의 경로만 움직입니다.
- **닫기가 무엇을 닫는지 말합니다** (#2386). 업무 보드를 든 패널의 버튼은
  "업무 보드 닫기"(= 그 패널을 자기 대화로 되돌림)라고 하고, 대화 패널은
  "패널 닫기"라고 합니다. 예전에는 둘 다 "채팅 영역 닫기"였습니다.

### Tailnet 접근 — 다른 기기에서 보기

- **이 데스크탑의 Tailscale 상태를 직접 읽습니다** (#2377). 예전에는 사용자가
  테일넷 이름과 기기 이름을 손으로 입력해야 했습니다.
- **인증 경계를 고릅니다** (#2383). 기본값은 "테일넷 신원 + 페어링" 으로,
  테일넷 안의 Tailscale 계정이면 일회용 초대 코드로 페어링을 요청할 수 있고
  승인은 항상 이 데스크탑에서 합니다. 관리자 정책 파일이 필요한 app capability
  방식은 고급 선택지로 남았습니다.
- **같은 계정의 기기는 코드를 옮겨 적지 않습니다** (#2385). 이 데스크탑이
  로그인한 것과 같은 테일넷 계정이면 초대 코드 없이 페어링을 요청하고,
  승인 단계는 그대로 남습니다.
- **Serve 는 버튼으로 실행합니다.** 리스너는 127.0.0.1 에만 바인드하고,
  테일넷에 올리는 `tailscale serve` 는 앱이 대신 실행합니다.

### 업무 보드

- **일간 / 주간 브리핑** (#2384). 버튼 하나로 업무 전반을 살펴보는 시퀀스가
  돌고, 나온 액션 아이템이 추천 카드로 보드에 쌓입니다. 이미 보드에 올라온
  내용을 요약하는 "리포트" 와는 다른 방향이라, 두 묶음이 구분되어 있습니다.
- **플러그인이 할 일을 제안할 수 있습니다** (#2381). 플러그인 → 호스트
  추천-작업 채널이 생겼습니다. 데이터를 가진 플러그인이 직접 보드에 카드를
  올립니다.
- **마감일이 옮겨 다니지 않습니다.** 고정 시간대의 자정으로 찍힌 마감일을
  한 번 바로잡고, 이 코드가 쓴 마감일은 다시 재계산하지 않습니다.

### 세션

- **세션 목표** (#2380). 목표를 걸어 두면 그 목표가 충족될 때까지 세션이
  계속 일합니다.
- **도는 대화가 다른 대화를 잠그지 않습니다.** 턴이 진행 중이어도 사이드바에서
  다른 대화로 옮겨 갈 수 있습니다.
- **승인·질문 카드가 물어본 타일에 뜹니다** (#2117). 숨은 타일이 낸 질문도
  답할 수 있고, 어느 타일이 승인을 기다리는지 창 밴드가 말해 줍니다. 재로드
  뒤에도 그대로입니다.

### 컴포저와 사이드바

- **커맨드 메뉴를 OS 가 그립니다.** 페르소나 선택이 그 메뉴의 첫 하위 메뉴로
  들어갔고, 메뉴는 "메시지에 들어갈 것" 만 담습니다(이동은 사이드바 몫).
- **사고 수준이 전구 안의 게이지**로 보입니다. 경고색 위에 얹혀 있던 사다리를
  떼어냈습니다.
- **권한 카드가 상태 행에** 있습니다. 도구 행에는 권한 검토 칩과 근거
  툴팁이 인라인으로 붙습니다.
- **빈 입력창은 한 줄**이고, 힌트는 세 토큰(`typing`, `⌘+V`, `/`)입니다.
  제안 답변은 정확히 하나만 보여 줍니다.
- **사이드바가 기능/플러그인 두 그룹**으로 접히고, 그룹은 플라이아웃으로
  열립니다. 채팅 모드에서는 대화 영역을 밀어내지 않고 **위에 떠서** 펼쳐집니다.
- **도구 활동이 헤더에서 작업 패널 탭으로** 옮겨졌습니다.

### 설정

- **공급자 카드의 모든 점이 자기 단어를 답니다.** 빨강/초록 점만으로는 무슨
  뜻인지 알 수 없던 것을 모델 목록 동기화 상태 칩으로 바꿨습니다.
- **두 경로를 가진 공급자**는 상태 칩마다 어느 경로인지 이름이 붙습니다
  (#2312). 선택기 행은 카탈로그의 provider 필드가 아니라 카드 제목으로
  이름 붙고 (#2311), 자격증명 확인 실패는 요청한 행에 보고됩니다.
- **Codex OAuth 토큰이 격리된 `CODEX_HOME`** 에 저장됩니다 — 시스템 키체인이
  아닙니다.

### 플러그인과 저장소

- **설치 루트가 바뀌어도 플러그인 데이터가 따라갑니다** (#2288). 귀속을 알 수
  없는 상태는 지우지 않고 따로 보관하며, 어디로 옮겼는지 알려 줍니다.
- **손상된 백업 파일**은 임의 접미사를 붙여 비켜 두고, 옮기기가 실패하면
  기록을 남긴 뒤 빈 상태로 시작합니다.

### 수정

- **Windows: `~/` 로 시작하는 명령 훅의 신뢰를 한 번 다시 확인하게 됩니다.**
  훅 신뢰 해시가 스크립트 경로를 구분자와 무관한 형태(`\` → `/`)로 접도록
  바뀌었습니다. 예전 빌드는 `C:\Users\me/hooks/run.sh` 처럼 섞인 형태를
  해시했기 때문에, 업그레이드 후 첫 부팅에서 해당 훅이 "변경됨" 으로 한 번
  격리되고 다시 승인하면 이후에는 반복되지 않습니다. macOS/Linux 의 일반적인
  `~/…` 훅은 영향이 없습니다.
- **샌드박스가 꺼져 있어도 플러그인이 뜹니다 — 모든 플랫폼에서 같은 규칙입니다.**
  Windows 와 Linux 설치본에서 플러그인 4종이 전부 시작에 실패하고 있었습니다.
  OS 샌드박스 설정(`설정 → 권한`)이 그 플랫폼에서는 기본으로 꺼져 있는데,
  플러그인을 별도 프로세스로 띄우는 경로가 샌드박스를 **필수**로 요구해서
  내부 오류로 죽었고, 화면에는 아무 설명도 나오지 않았습니다. macOS 만 기본값이
  켜져 있어 멀쩡했습니다.

  이제 설정 하나가 호스트·워커·플러그인을 같은 방식으로 다룹니다. 샌드박스는
  **모든 플랫폼에서 기본 꺼짐**이고, 꺼져 있으면 플러그인도 호스트와 같은 수준
  (별도 프로세스, OS 격리 없음)으로 동작합니다. 켜면 — Windows 는 `설정 → 권한`
  의 일회성 설치를 거쳐 — 플러그인 자식도 함께 격리됩니다. 기존에 macOS 에서
  샌드박스를 켜 두셨다면 그 설정은 그대로 유지됩니다.
- **Windows 와 Linux 에서 붙여넣기 안내가 그 키보드의 키를 말합니다.** 입력창
  안내 문구가 플랫폼과 무관하게 macOS 의 `⌘+V` 를 보여 주고 있었습니다. 이제
  macOS 에서는 `⌘+V`, 나머지 플랫폼에서는 `Ctrl+V` 로 나옵니다.
- **설치된 것보다 낮은 버전을 업데이트로 권하지 않습니다.** v0.9.0 설치본이
  배포 피드의 v0.8.0 을 "업데이트 있음" 으로 띄우는 경우가 있었습니다. 이제
  호스트가 실행 중인 버전과 직접 비교해서, 더 높은 버전이 아니면 알리지
  않습니다.
- **감사 로그**가 최신순으로 정렬되고, 날짜 범위를 UTC 가 아니라 이 기기의
  날짜로 읽습니다 (#2313). 검증되지 않은 행은 읽기에서 빠집니다.
- **로그인 창이 수확한 세션 쿠키가 앱 재시작 뒤에도 남습니다.**
- **`agent_status` 가 자기가 하는 읽기를 선언**해서, 상태 확인이 턴을 막지
  않습니다.
- 루틴 일정 예시에서 `+09:00` 표기를 걷어냈고, 인사이트는 해석할 수 없는
  저장 시각을 날짜 색인에서 제외합니다.

### 안쪽 정리

사용자 화면에는 보이지 않지만 다음 릴리즈의 결함을 줄이는 변경들입니다.

- **로케일을 ko / en 두 개로 정리했습니다** (#2362). 제거된 로케일들은 모듈
  헤더와 반대 순서로 병합해서, 두 번역 중 어느 쪽이 화면에 닿는지가 로케일마다
  달랐습니다. 같은 PR 에서 "같은 사실이 여러 곳에 복사되는 것" 을 막는 게이트가
  들어왔습니다.
- **던져진 값을 문자열로 바꾸는 코드가 한 곳으로 모였습니다** (#2387).
  32 개 파일에 흩어져 있던 72 벌의 사본이 사라졌습니다.

## v0.8.0 — 2026-08-29

대화 영역이 **타일 워크벤치**가 되었습니다. 업무 모드에서 화면을 최대 네 개의
타일로 나누고, 타일마다 다른 대화를 열어 두고, 각 타일이 자기 작업 패널을
갖습니다. 여기에 맞춰 사이드바·컴포저·설정의 공급자 화면과 내 메시지 카드의
동작이 함께 정리되었습니다.

### 타일 워크벤치

- **VS Code 워크벤치 모델을 채택했습니다** (#2290). 대화 그룹이 프레임을
  갖고, 행 액션과 타일링이 들어왔습니다. 업무 모드는 최대 4 타일, 채팅 모드는
  1 타일입니다.
- **분할한 타일은 자기 대화를 시작합니다** (#2294). 한 세션은 한 번에 한
  타일에서만 열립니다 — 사이드바에서 대화를 고르면 그 대화를 들고 있는 타일이
  포커스됩니다. 메인 프로세스도 그룹마다 독립된 대화 루프를 돌립니다.
- **분할 방향을 고릅니다** (#2296). 분할 버튼이 "좌우로 분할 / 위아래로
  분할" 팝업을 열고, 공간이 모자라는 방향은 비활성으로 표시됩니다. 상단
  밴드와 사이드바 클러스터는 글꼴 크기와 무관하게 px 로 고정되어 신호등
  라인과 어긋나지 않습니다.
- **모든 타일을 닫거나 하나만 크게 볼 수 있습니다** (#2295). 분할된 뒤에는
  첫 타일도 닫을 수 있고, 최대화 토글은 나머지 타일을 닫지 않고 숨깁니다.
  기본 글꼴 사다리는 한 단계 내려갔습니다 (0.875).

### 작업 패널

- **어느 폭에서든 같은 카드 모양**입니다 (#2295). 타일 전체 높이를 덮고,
  좁아지면 대화 위에 떠서 열립니다 (#2296). 빈 런처에는 이 대화의 도구 활동
  스트립이 보입니다.
- **패널 데이터가 실제 세션을 반영합니다** (#2297). 브라우저 탭은 도구
  입력과 결과 양쪽의 웹 출처를 모으고, 파일 탭은 어떤 작업(읽기/쓰기/검색)이
  그 파일을 건드렸는지 표시하며, 플러그인·MCP 호출 집계는 재로드 뒤에도
  남습니다. 질문 카드는 그 질문을 낸 대화의 타일에만 뜹니다.
- **밀어넣기 표면이 타일 단위로 묶였습니다** (#2299). 오버레이 카드, MCP
  카드, 토스트, 부재 권한, 세션 TODO 가 자기 대화의 타일에만 나타나고, 카드의
  기본 액션도 그 대화에서 실행됩니다.

### 사이드바와 컴포저

- **응답 중 점과 안 읽은 턴 표시** (#2292). 보관/미확인 상태가 세션 목록을
  따라갑니다.
- **대화 목록이 스크롤로 이어집니다** (#2298). 클릭되지 않던 "N개 더 보기"
  텍스트 대신 화면에 가까워지면 다음 묶음이 드러나고, 프로젝트 그룹은 실제
  버튼으로 넘깁니다.
- **거절된 전송을 보여줍니다** (#2293). 턴 진행 중 Enter 는 큐에 넣고,
  ⌘↩ 이 한 번의 호출로 중단합니다. 셀프 호스팅 모델에는 스트림 상한을
  둡니다.

### 내 메시지 카드

- **"여기로 되돌아가기"** (#2301). 카드에 마우스를 올리면 편집 · 분기 ·
  되돌아가기 세 동작이 있고, 되돌아가기는 그 메시지의 원문을 컴포저에 되돌려
  놓고 그 이후 대화를 폐기합니다. 메시지 단위 핀은 사라졌고(대화 핀은
  그대로), 보낸 시간이 카드 아래에 보입니다.

  이를 위해 모든 대화 행에 영구 식별자가 붙었습니다. 되감기·편집 후 재전송·
  분기는 이제 행을 세어서가 아니라 식별자로 대상을 찾습니다. 렌더러와 호스트가
  세는 단위가 달라(도구만 돈 라운드, 압축 경계) 세 번째 질문의 되감기가 두
  번째에서 잘리던 문제가 근본적으로 사라졌습니다. 되감기가 압축 체크포인트를
  같이 정리하므로, 재로드 뒤에 폐기한 메시지가 되살아나지 않습니다.

### 설정 — 모델 공급자

- **공급자 카드가 정리되었습니다** (#2300). 저장 버튼이 편집 중인 카드 안에
  있고, 엔드포인트 입력은 사용자가 직접 주는 공급자(커스텀 OpenAI 호환,
  Azure Foundry, 셀프 호스팅)에만 보입니다. OpenAI 행은 "브라우저에서 로그인 /
  디바이스 코드 사용 / API 키 사용" 세 버튼이 한 줄이고, API 키 사용을 눌러야
  키 입력이 나타납니다. "공급자 추가"는 새 카드를 버튼 바로 위에 붙입니다.
  모델 목록은 공급자에서 가져오며, 실패 시 캐시 사용/실패/키 필요를 있는
  그대로 표시합니다.
- **모델 목록이 공급자를 바꾸는 유일한 자리입니다** (#2309). 카드를 열거나
  키를 저장해도 채팅이 도는 공급자는 바뀌지 않습니다 — 처음 키를 넣은 뒤에도
  카드는 "모델 목록에서 고르세요"라고만 안내합니다. 목록에는 자격증명이 있는
  모든 공급자의 모델이 그룹별로 실리고, 하나를 고르면 공급자와 모델이 함께
  저장됩니다. 마켓플레이스 프리셋과 커스텀 OpenAI 호환 행은 이제 엔드포인트와
  모델을 따로 가집니다. 모델 목록은 캐시되어 앱을 켤 때 한 번, 그리고 카드의
  새로고침을 눌렀을 때만 다시 받습니다. 큐레이션 목록을 쓰는 공급자(Azure
  Foundry 등)에는 동기화가 없습니다.

### 저장소와 플러그인

- **도메인 루트 파일 두 개를 기능 네임스페이스로 옮겼습니다** (#2287).
- **한 플러그인의 시작 실패가 다른 플러그인의 디스패치를 닫지 않습니다**
  (#2285).
- 의존성 갱신 통합 (#2286).

## v0.7.3 — 2026-08-27

v0.7.2 에서 문서 인덱서가 시작되기 시작하자, 그때까지 도달할 수 없던 자리가
드러났습니다. 인덱서를 쓰려면 이 버전이 필요합니다.

### 두 번째 부팅에서 인덱서가 통째로 거부됐습니다 (#2283)

```
local-indexer rejected — install receipt integrity failed
reason: installed payload contains unsupported entry: sockets/egress.sock
```

설치 영수증 검증은 플러그인 루트를 훑으면서 `data/` 와 `run/` 만 제외했습니다.
`run/` 은 호스트가 워커 제어 소켓을 할당하는 곳이고, `sockets/` 는 **플러그인
자신이** 바인드하는 곳입니다 — 남아 있는 소켓을 누가 만들었는지 구분하려고
일부러 나눠 둔 두 디렉토리입니다. 그 분리 때문에, 한쪽에 쓴 예외가 다른 쪽으로
따라가지 않았습니다.

인덱서의 egress broker 가 `sockets/egress.sock` 을 바인드합니다. 앱을 종료하면
그 파일이 남고, 다음 부팅의 payload 스캔이 일반 파일이 아닌 항목을 만나 멀쩡한
플러그인을 거부했습니다.

v0.7.2 이전에는 닿을 수 없던 경로입니다. 플러그인이 broker 를 살려둘 만큼
진행되지 못해 소켓이 항상 다음 부팅 전에 사라졌기 때문입니다. 워커를 고친 것이
**두 번째 부팅을 처음 성사시켰습니다.**

## v0.7.2 — 2026-08-27

문서 인덱서가 부팅할 때마다 시작에 실패하던 문제를 고쳤습니다. 함께, 격리된
플러그인이 남기는 로그가 어디에도 도달하지 않던 것을 고쳤습니다 — 이 결함이
없었다면 앞의 문제는 출시되지 못했을 것입니다.

### 인덱서 워커가 매 부팅 시작에 실패했습니다 (#2281)

`local-indexer` 의 워커는 30초 헬스체크를 매번 넘기지 못했고, 그 뒤로는 그
세션 동안 인덱서의 **모든 도구**가 거부됐습니다. 패널에는 문서 목록 대신
호스트의 영문 오류 문구가 떴습니다.

워커는 자기 제어 소켓을 정상적으로 bind 하고 있었습니다 — 샌드박스 밖의
프로브는 그 소켓에 문제없이 연결됩니다. 연결하지 못한 쪽은 **플러그인 자신의
격리 자식 프로세스**, 즉 클라이언트였습니다.

호스트는 `run/<workerId>/` 디렉토리를 등록해 **워커가 bind** 하도록 해줍니다.
반대쪽이 왜 불필요한지도 코드에 적혀 있었습니다 — "호스트는 샌드박스 밖에서
연결한다". v0.7.0 에서 모든 플러그인이 별도 프로세스로 옮겨가면서 그 전제가
깨졌고, 클라이언트가 격리 자식이 됐습니다.

자식의 envelope 이 이제 플러그인의 `run/` 루트를 포함하며, 자식을 감싸기 전에
등록됩니다. 쓰기가 아니라 **읽기** 입니다 — 자식은 연결만 하고, 그 아래에
무언가를 만드는 것은 호스트의 몫입니다.

### 격리된 플러그인의 로그가 전부 버려지고 있었습니다 (#2281)

자식이 `log` 알림을 보내고 wire 타입이 그것을 선언하는데, 호스트의 알림
처리기는 등록을 끝내는 두 종류만 다루고 `log` 는 그냥 통과시켰습니다.
별도 프로세스로 도는 플러그인 5종 **전부**의 `context.log` 가 사라지고
있었습니다.

인덱서는 워커의 stderr 를 바로 이 경로로 넘기고 있었습니다. 운영자가 실패
이유를 읽으라고 만든 통로가 존재하지 않는 곳으로 이어져 있었던 것입니다.

로그 sink 는 이제 선택이 아니라 **필수** 인자입니다. 로그를 놓을 곳이 없는
디스패처는 만들어질 수 없어야 합니다.

## v0.7.1 — 2026-08-26

플러그인 패널이 메인 페인의 전체 폭을 쓰도록 바뀌었고, 플러그인 UI 들이
패널 폭을 따라 레이아웃을 바꿉니다.

### 플러그인 패널 폭 클램프 제거

패널은 채팅 대화 컬럼 폭(약 928px)에 고정돼 있었습니다. 이 고정값은 보정이었고
코드 주석이 그 사실을 적어두고 있었습니다 — 플러그인 UI 들이 예전의 약 800px
분리 창 기준으로 작성돼 전체 폭에서 늘어지니, 호스트가 패널을 좁게 붙들어
둔 것입니다.

증상을 가린 대가로 폭을 버렸습니다. 2200px 창에서 셸에 1960px 가 있는데 웹뷰는
912px 로 렌더됐고, 창을 약 1180px 이상으로 넓혀도 화면은 그대로였습니다.

플러그인들이 각자 콘텐츠 컬럼을 캡하도록 고쳐졌으므로(meeting 860,
local-indexer 900, ms-graph·work-assistant 720) 클램프는 가릴 것이 없어졌습니다.
이제 패널은 페인 전체를 받고, 웹뷰 폭이 창을 따라갑니다.

- 플러그인 UI 작성 규약을 `docs/guides/plugin-development.md` 에 명시했습니다:
  고정 `width` 대신 `max-width` 로 캡할 것, `@media` 보다 `@container` 를 쓸 것,
  넓은 표는 자기 컨테이너 안에서 가로 스크롤할 것.

이 버전과 함께 배포되는 플러그인 버전: meeting 0.8.1, local-indexer 0.6.1,
ep-api 0.21.1, ms-graph 0.5.1, work-assistant 0.11.1.

## v0.7.0 — 2026-08-26

플러그인 프로세스 격리가 **설치되는 플러그인 전부(5/5)** 로 확대되어 완결되었고,
플러그인 매니페스트가 Agent Plugins 1.0.0 표준 문서 형식으로 전환되었습니다.
매니페스트 형식 변경은 하위 호환되지 않으므로, 이 버전부터 배포되는 플러그인은
`minAppVersion: 0.7.0` 을 요구합니다.

v0.6.3 은 배포되지 않았습니다. v0.6.2 에서 올라오는 경우 아래 v0.6.3 항목의
변경도 함께 포함됩니다.

### 플러그인 프로세스 격리 — 전 플러그인 적용 완료

v0.6.3 에서 `work-assistant` 하나였던 격리 대상이 이번 릴리즈에서 다섯 개
전부로 확대되었습니다. 각 승격은 해당 플러그인이 자식 프로세스 경계를 실제로
넘을 수 있는지 실측한 뒤에만 이루어졌습니다.

- **`ms-graph` 격리 실행** (#2257)
- **`local-indexer` 격리 실행** (#2264)
- **`meeting` 격리 실행** (#2268)
- **`ep-api` 격리 실행** (#2272) — 마지막 관문이었던 브라우저 의존을 제거한
  플러그인 0.20.0 과 짝을 이룹니다.

경계를 넘기 위해 필요했던 호스트 쪽 기반:

- **자식마다 독립된 임시 디렉토리**를 부여합니다 (#2258).
- **유닉스 도메인 소켓 경로**로 호스트↔자식 통신을 넓혔습니다 (#2260).
- **호스트가 관리하는 경로를 플러그인 컨텍스트로 전달**합니다 (#2262).
- **매핑된 네트워크 드라이브를 루트로 인정**합니다 (#2263).
- **경로 없는 쓰기를 미상으로 분류**해 조용히 통과하지 않도록 했습니다 (#2255).

### 플러그인 매니페스트 — Agent Plugins 1.0.0

- **`plugin.json` 이 표준 문서 형식이 되었습니다** (#2273). 최상위에는 표준이
  정한 필드만 남고, LVIS 고유 필드는 `extensions["xyz.lvisai"]` 아래로
  이동했습니다. 호스트는 디스크의 문서를 검증한 뒤 내부 형태로 투영하므로
  매니페스트를 읽는 기존 코드는 그대로입니다.
- **표준 메타데이터 문자열에 상한을 둡니다** (#2274). `author`/`homepage`/
  `repository`/`license`/`keywords` 의 길이와 개수를 제한하고 개행을 금지합니다.

**이전 형식의 플러그인은 이 버전에서 로드되지 않습니다.** 마켓플레이스에서 각
플러그인의 최신 버전으로 갱신해 주세요.

### 플러그인 인증·자격증명

- **EP 세션 쿠키를 호스트 볼트에 보관**합니다 (#2254). 파티션 자체가 볼트가
  되어 플러그인이 쿠키 값을 직접 들고 있지 않습니다.
- **인증 리다이렉트를 호스트가 받아냅니다** (#2256).

### 호스트 기능

- **폴더 선택기**를 플러그인에 제공합니다 (#2259).
- **오디오 캡처 엔진**이 호스트로 들어왔습니다 (#2265).
- **플로팅 독** (#2267).

## v0.6.3 — 2026-08-24

플러그인을 별도 프로세스에서 실행하는 격리 체계가 실제로 가동을 시작했고,
호스트가 중개하는 플러그인 네트워크 경로(hostFetch)가 리다이렉트와 사내망까지
정책으로 다루게 되었습니다. 설정 표면 정리와 이름·중복 정리 스윕도 포함됩니다.

### 플러그인 프로세스 격리

- **첫 플러그인이 격리된 자식 프로세스에서 실행됩니다.** 호스트↔자식 IPC 경로
  (상호작용·스토리지·설정 구독·서비스 경로)를 완성하고, 파일럿을 거쳐 실운영으로
  전환했습니다.
- **자식 프로세스의 권한 봉투를 호스트가 계산**합니다. 호스트가 부여한 읽기
  루트는 쓰기 목록에서 빠지고, 각 grant 의 실제 디렉토리가 상한에서 차감됩니다.
- **루프백 바인드를 실측해 판정**합니다. 자식이 루프백에 바인드할 수 있는지를
  가정이 아니라 측정으로 확인하고, 통과하지 못한 플러그인은 승격하지 않습니다.
- **샌드박스 게이트가 플러그인 시작 전에 초기화됩니다.** 격리 대상 플러그인의
  팩토리가 자식을 띄우는 시점에 샌드박스가 아직 준비되지 않아 로드가 매 부팅
  실패하던 부트 순서 결함을 바로잡았습니다. Doctor 재설치도 같은 원인으로
  실패했습니다.
- **격리된 자식에서 실행되는 도구를 승인 심사가 인정합니다.** 격리 플러그인의
  도구가 "OS 격리 없음 · 높은 위험"으로 매번 승인을 요구하던 문제를 바로잡았
  습니다. 커널이 이미 플러그인 자기 영역으로 가두는 쓰기에는 낮은 위험이
  매겨지고, 규칙 판정이 이미 '높음'이면 LLM 심사 왕복을 생략해 승인 카드가
  즉시 뜹니다.

### 플러그인 네트워크 (hostFetch)

- **리다이렉트를 홉 단위로 게이트**합니다. 전송 계층은 항상 한 홉만 수행하고,
  `follow` 는 홉마다 전체 egress 정책을 다시 통과해야 하며(최대 5홉), 교차
  출처 홉에서는 인증 헤더를 제거합니다. `manual` 은 3xx 를 그대로 돌려줘 SSO
  바운스 감지에 쓸 수 있습니다.
- **사내망 전용 호스트에 한해 http 를 허용**합니다. 허용 목록에 있고, 사설망
  옵트인이 있으며, 모든 DNS 응답이 사설 대역임이 증명될 때만입니다. 공인 주소가
  하나라도 섞이면 거부합니다.
- **루프백 엔드포인트 선언**을 별도 권한으로 다룹니다.

### 마켓플레이스·설치 신뢰

- 서명된 승인 카탈로그를 도입하고, 설치본 해시를 핀에 대조해 검증합니다.
- 렌더러→호스트 IPC 의 발신자 검증을 강화했습니다.

### 설정 표면 정리

- 로컬 API·텔레메트리·가격 오버라이드·하드웨어 가속·종료 타임아웃·사내 CA·
  마켓플레이스 갱신 캐시가 설정 화면에 정식 항목으로 들어왔고, 환경변수 표면은
  게이트로 봉인했습니다.

### 정리

- 이름 스윕(도메인 명사화), 중복 로직 수렴, 단일 개념 파일 통합, 사용하지 않는
  코드 제거(knip 하향 랫칫) 등 유지보수 스윕이 여러 PR 에 걸쳐 진행되었습니다.
- 복구·가시성: 조용히 사라지던 플러그인 드롭 경로와 설정 저장 손상이 카드로
  표면화됩니다.

## v0.6.2 — 2026-08-19

보안 감사에서 나온 수정과, 플러그인을 별도 프로세스로 옮기기 위한 준비 작업이
중심입니다. 마켓플레이스 신뢰 앵커가 하나로 정리되었고, 셸 명령의 경로 봉쇄가
`cd` 를 추적하도록 바뀌었습니다.

### 마켓플레이스 신뢰

- **유출된 `poc-v1` 서명 키를 신뢰 앵커에서 제거**했습니다. 개인키가 공개된
  상태였고 서명 검증은 등록된 아무 키나 통과시키므로, 앵커 하나가 뚫리면 전체가
  뚫리는 구조였습니다. 카탈로그를 `prod-v1` 로 재서명한 뒤 제거했습니다.
- **플러그인 폐기 수단**을 추가했습니다. 서명된 폐기 문서로 특정 `slug@version`
  의 설치와 로드를 차단하고, 최소 버전을 고정할 수 있습니다. 문서를 한 번도 받지
  못한 상태에서는 전체를 허용해 오프라인이 모든 플러그인을 막지 않도록 했습니다.
- **설치된 플러그인이 쓸 수 있는 디렉토리를 `<플러그인>/data` 로 좁혔습니다.**

### 셸 권한

- **`cd` 이후의 상대경로를 실제 이동한 디렉토리 기준으로 검사**합니다. 이전에는
  모든 경로를 세션 작업 디렉토리 기준으로 풀어서, `cd /tmp && cat ../../etc/passwd`
  가 경계 안으로 보였습니다.
- **폴더 이동·읽기 전용 명령이 승인을 요구하지 않습니다.** `cd`, `git log -S<검색어>`,
  `rg 'foo$'` 처럼 같은 동작인데 철자만 다르면 갈리던 프롬프트를 정리했습니다.

### 플러그인 격리 준비

- 플러그인 `<webview>` 의 격리 설정을 **메인 프로세스에서 강제**합니다. 렌더러
  속성은 오타 한 글자로 조용히 기본값으로 떨어질 수 있었습니다.
- 호스트↔플러그인 경계가 **실제 전송처럼 JSON 왕복**하며, 왕복이 값을 바꾸는
  경우를 거부합니다.
- `hostApi.getSecret` 이 **비동기**가 되었습니다. 프로세스 경계를 넘을 수 없는
  동기 계약을 정리하는 작업이며, 플러그인은 `await` 만 추가하면 됩니다.

### 승인·알림

- Telegram 에서 **인라인 키보드로 도구 실행을 승인**할 수 있습니다.
- 승인 카드 형식을 한 가지로 통일했습니다.

### MCP

- `2026-07-28` 스키마에 맞춰 요청 헤더·서버 알림 라우팅·구독을 정비했습니다.

## v0.5.10 — 2026-07-24

Adds signed atomic plugin contributions, tightens governed domain writes, and
ships the dependency refresh accumulated after v0.5.9. Public tags remain
unsigned.

### Plugin bundles and governed operations

- **One signed plugin artifact can own Skills, Hooks, and loopback MCP
  servers.** Install, activation, update, rollback, disable, and removal publish
  or retire all contributions as one generation, with journaled cleanup and no
  orphaned ownership.
- **Failed reads cannot authorize writes.** A governed read can explicitly
  declare its successful structured-result statuses. Missing or unsuccessful
  status values remain visible to the caller but fail closed, and every new
  read attempt invalidates older freshness receipts and grants.
- **Governed operations are isolated from extension hooks.** PreToolUse,
  PostToolUse, PostToolUseFailure, and PermissionDenied hooks are not dispatched
  for manifest-governed operations because arbitrary commands cannot be part of
  the provider-state proof. A Host-private stable account scope now serializes
  execution and auth status/login/logout transitions across reauthentication,
  update, and rollback while authority stays bound to a revocable
  per-generation principal. Governed audit rows use the invocation-time
  governance snapshot, so generation replacement cannot restore payload logging
  or lifecycle-hook dispatch.
- **Retired contracts stay retired.** The Host-owned manifest and public API do
  not restore keyword dispatch, UI-action tool aliases, or plugin-specific Host
  branches; the SDK remains a generated projection of the app contract.

### Build

- **`better-sqlite3` upgraded to 13 (N-API prebuilds).** v13 is N-API (ABI-stable) and ships per-platform prebuilds (`prebuilds/<platform>-<arch>.node`) instead of a per-Electron-ABI `build/Release/better_sqlite3.node` compiled by `electron-rebuild`. The postinstall native rebuild is now scoped to `node-pty` only, and the packaged-build asserts follow the binary to its prebuild path. The installer drops the `bindings`/`file-uri-to-path` resolver dependencies (no longer used) and prunes the 7 non-target prebuilds at pack time (~14 MB smaller). The Electron-ABI self-heal that used to rebuild `better-sqlite3` on load failure now fails fast with reinstall guidance, since a rebuild cannot fix a shipped prebuild.

## v0.5.9 — 2026-07-23

Re-ships the v0.5.8 plugin-integrity fixes with a working Windows installer. Public tags remain unsigned.

### Build

- **Windows installers build again.** The packaged-footprint audit read the main bundle manifest from the app archive with POSIX separators, but electron-builder keys asar entries with the OS separator on Windows, so every lookup missed its backslash-keyed entry and the release build failed with a spurious "bundle manifest not found." The audit now resolves entries with the archive's own separator; macOS and Linux are unaffected. (v0.5.8's release build failed this audit and was never published; v0.5.9 carries the same fixes.)

## v0.5.8 — 2026-07-23

Fixes a v0.5.7 regression where stateful and Python-backed plugins could stop loading after first use, and lands the startup-bundle split with hardened version resolution. Public tags remain unsigned.

### Plugin integrity

- **Plugins no longer fail their integrity check after first run.** v0.5.7's strict install-receipt scan treated a plugin's own runtime state as unlisted payload and dropped the plugin to the Doctor picker. Validation now excludes a plugin's writable `data/` directory and Python bytecode cache (`__pycache__/*.pyc`) — runtime artifacts that were never part of the signed install — at a single chokepoint, while still rejecting any other unlisted file, including a non-bytecode file hidden inside a `__pycache__/` directory.

### Startup and boot

- **Smaller initial load.** The main-process bundle is split so startup pulls in only the statically reachable boot path. Version resolution was made depth-agnostic so the split cannot leave the app reporting an unknown version — which would otherwise fail-closed every version-gated plugin.
- **Boot composition is bounded and acyclic.** Plugin preflight is time-bounded and skips healthy re-scans, and boot ordering is enforced as an acyclic typed composition.

## v0.5.7 — 2026-07-23

Hardens local state and plugin lifecycle recovery, self-heals Electron native-module ABI drift, and adds a strict declarative first-task contract for plugins. Public tags remain unsigned.

### Reliability and local data

- **`better-sqlite3` self-heals before launch.** Startup detects its Electron ABI mismatch, serializes rebuilds, recovers interrupted rebuild state, and retries with the Electron ABI instead of leaving the app in a repeated non-fatal error loop.
- **Plugin registry and Marketplace mutations are crash-atomic.** Install, update, removal, receipt, artifact, and boot-recovery state now use serialized, fail-consistent transitions with durable recovery ownership.
- **Secrets are stored atomically and strictly.** Provider credentials and other secret documents use their own locked atomic store, eliminating partial settings writes and silent plaintext fallback.

### Plugins and onboarding

- **Plugins can declare their first post-tour task.** The host validates bounded localized copy and mandatory priority, orders proposals deterministically, and surfaces rejected plugin declarations as retryable UI errors instead of inventing fallback content. Plugins using this field require `lvis-app >= 0.5.7`.
- **Plugin views stay inline in chat mode.** Opening a plugin panel no longer detaches it from the active conversation layout.

### Tools and runtime

- Added `view_image`, model-directed `memory_write`, and managed background-shell tools with bounded history and end-of-session cleanup.
- Image tool results age out of persisted and wire histories, reducing long-session context and storage growth without waiting for token pressure.
- Web search, web fetch, plugin request, and tool search now live in their owning tool modules, reducing boot coupling without changing their public contracts.

### Build and UI

- Removed the unused Storybook toolchain and moved local Git hooks into the app repository with the same validation policies used by CI.
- Added common hook events for subagent lifecycle, session end, and notifications; improved settings-cache synchronization and Radix selected-state styling.

## v0.5.6 — 2026-07-22

Adds self-hosted model discovery, completes the reviewer negotiation flow, and trims the Windows installer. Public tags remain unsigned.

### Models

- **Sync models from a saved self-hosted OpenAI-compatible endpoint.** A saved Custom (OpenAI-compatible) private HTTP endpoint can now sync its model list with credentials, locked to the configured origin. Commercial providers and Marketplace presets are never relaxed to private HTTP; keyless Marketplace loopback discovery is unchanged.

### Permissions and approval review

- **Reviewer negotiation can auto-approve aligned escalations.** When the audit reviewer re-evaluates a main-model privilege-escalation request and finds it in scope for the original user request and not intrinsically high-risk, the action proceeds with a full audit record instead of a modal. Every other outcome still routes to the approval dialog (fail-closed).

### UI

- **Left sidebar collapse/expand now animates**, matching the right side panel.

### Downloads and packaging

- **Smaller Windows installer (~27 MB).** Removed the unused WebGPU DirectX shader compilers (`dxcompiler.dll`, `dxil.dll`) from the Windows package — the app disables hardware acceleration and renders without them.
- **Versioned release assets only.** Assets are published as `LVIS-<version>-*`; the download site resolves the latest version dynamically instead of via static `LVIS-latest-*` aliases.

### Build

- Faster CI and local builds — incremental typecheck, CI dependency caching + run cancellation, matched esbuild target — with no change to the shipped app.

## v0.5.5 — 2026-07-19

Hardening release for marketplace recovery, permission review, Windows shell safety, and A2A interoperability. Windows OS sandboxing remains opt-in.

> **Public distribution safety:** release tags build as `public` and never receive an embedded internal demo activation key. This release is intentionally unsigned.

### Security

- Updated `adm-zip` to `0.6.0` to remediate GHSA-xcpc-8h2w-3j85 / CVE-2026-39244 (crafted ZIP memory-exhaustion denial of service).

### Plugin Doctor and Marketplace

- **Doctor now reports the real runtime outcome.** A completed diagnostic is shown as success only after the refreshed plugin is loaded and callable; an unresolved failed/not-runnable plugin remains a warning with its actionable failure state.
- **Marketplace grants now fail closed.** The host verifies that an artifact's network and runtime capability grants exactly match the catalog-approved grant instead of silently widening authority.

> **Marketplace publisher note:** a catalog/artifact grant mismatch cannot be repaired on the device. Publish a matching artifact first; then have affected users remove and reinstall the plugin.

### Permissions and approval review (#17)

- **One medium-risk rule across foreground actions.** When **Auto-approve medium risk** is selected, the same policy now applies uniformly to sub-agent spawning, file writes, shell, network, and metadata actions. High-risk actions still require confirmation.
- **Explainable foreground review.** The guarded rationale flow presents host-sealed scope, effects, resources, authority, and risk context in the approval UI, preserves provenance in audit records, and safely falls back to the normal approval dialog when a rationale cannot be trusted or produced.

### Windows OS sandbox and shell safety (#19)

- **ASRT updated to 0.0.66.** Windows NSIS installs provision the `srt-win` sandbox at install time under the existing per-machine elevation flow; repair/re-provision remains available from Permissions when a machine is not ready.
- **Honest handling of Windows partial sandboxing.** A partial Windows ASRT state is not shell containment. LVIS identifies the host-shell fallback and requires a single-use confirmation bound to the exact command and execution context; it never retries an ASRT failure as an unreviewed plain shell command.
- **Windows stays opt-in.** `OS Tool Sandbox` remains off by default on Windows because srt-win does not provide process isolation.

### A2A messaging and interoperability

- **Sub-agent communication uses A2A-compatible task and message semantics.** Background results can reach the parent, eligible sub-agents can communicate through the host, and resumable work is shown as `waiting` rather than incorrectly completed.
- **Optional A2A endpoints and direct-agent routing** provide Agent Cards, durable task operations, exact-send replay, and a direct-agent action UI; route policy and credentials remain host-controlled.
- **Delegation authority is unchanged.** A2A messages stay DLP-filtered, tool actions still pass the receiving agent's approval gate, and sub-agent creation remains capped at depth one.

### Windows OS sandbox (ASRT srt-win) — installer provisioned, Windows opt-in (#1608)

- **The Windows OS execution sandbox is now provisioned by the NSIS installer instead of a runtime "Install now" button.** A bundled `srt-win.exe` being present is not the same as the OS sandbox being provisioned — provisioning creates a hidden `srt-sandbox` Windows user + user-SID-keyed WFP network-filter rules + filesystem ACLs, which needs a one-time admin elevation. A new `customInstall` macro in `build/installer.nsh` runs `srt-win.exe install --proxy-port-range 60080-60089` after the app files are extracted, so ASRT is ready at first launch. Provisioning is **non-fatal in every branch** (exit 0 = ok; 13 = already provisioned with a different config, left as-is with no auto `--force`; 10/12/14/other = logged warning) — it never aborts the app install, matching the existing non-bricking sandbox posture. The uninstaller's `customUnInstall` now runs `srt-win.exe uninstall` on a genuine uninstall (skipped on upgrade via the existing `isUpdated`/`KEEP_APP_DATA`/`--updated` guards) to remove the `srt-sandbox` user + WFP rules before the app files are deleted.
- **`osToolSandbox` stays OFF (opt-in) on `win32`** (`src/data/settings-store.ts`); default remains ON on `darwin` only. Default-on win32 is **deferred**: Windows srt-win is only partially confined (filesystem + network, no process isolation), so it cannot relax shell risk. Canonical Bash/PowerShell now follows the sealed Plan B host-shell path: it is reported as `plain`/`kind=none` and runs only after an exact one-time user approval; it never claims partial shell isolation. If a host with the sandbox opted-on reaches first launch without a working sandbox, win32-not-ready still does not hard-throw — the boot gate degrades gracefully and the runtime panel is the repair fallback.
- **The Settings → 권한 Windows panel is reframed from first-time "install" to "re-provision / repair"** — since provisioning happens at install time, the panel now only appears as a fallback when the sandbox is somehow not ready. The button ("지금 설치" → "재설정") stays wired to the same `sandboxWindowsInstall` IPC (manual repair path); no handler was removed.
- **Port-range drift guard** — a new vitest (`src/permissions/__tests__/installer-nsh-proxy-port-drift.test.ts`) parses `--proxy-port-range` out of `build/installer.nsh` and pins it to both the host SOT constant and ASRT's real `DEFAULT_WINDOWS_PROXY_PORT_RANGE`, so an upstream range change fails CI instead of silently desyncing the install-time WFP permit from the runtime proxy bind.
- **The NSIS target ships `oneClick:true` + `perMachine:true`** — an all-users Program Files install that self-elevates once, so the `srt-win.exe` provisioning runs in the already-elevated context (no separate UAC), and because Program Files grants Users read+execute by default, `srt-sandbox` can reach the packaged `srt-win.exe`.
- **File-ACL grant (root-cause fix).** The sandbox runs its egress probe / tool runner AS the low-privilege `srt-sandbox` user, which cannot read/execute `srt-win.exe` (or the ASRT package files) under a path whose ACL does not grant it — the real cause of the `CreateProcessWithLogonW(srt-sandbox)` `0x80070005` access-denied observed on a per-user / workspace checkout (not a logon-right or GPO issue). `customInstall` now also runs `icacls … /grant "sandbox-runtime-users:(OI)(CI)(RX)" /T /C` on the packaged ASRT dir so the sandbox actually initializes, not just provisions. Dev/workspace checkouts that hit this apply the same grant manually — see README → "ASRT sandbox access denied".
- **⚠️ Cannot be fully verified in CI** — the install-time provisioning + ACL grant need a real elevated Windows install run.

### Plugin contract — the transitional `xyz.lvis/*` `_meta` legacy read is removed (fail-closed + Doctor-repaired)

- **Removed the legacy dual-read AND the schema property (fail-closed, never fail-open).** The `_meta` vendor-namespace rename (`xyz.lvis/* → lvisai/*`, #1601) shipped a transitional dual-read + `observeLegacyMetaKey` telemetry so the removal could be timed by evidence. Both are now deleted: the three read fallbacks (`plugin-server-projection.ts` forward `xyz.lvis/pathFields`, `plugin-tool-from-mcp.ts` reverse `xyz.lvis/pathFields`, `plugin-mcp-host.ts` `xyz.lvis/rawResult`), the `legacy-meta-telemetry.ts` module, and the schema's `xyz.lvis/pathFields` property. Because tool `_meta` is `additionalProperties:false`, dropping the property makes an installed pre-rename manifest **fail schema validation** — it is rejected loudly, NOT silently accepted with its security-bearing `pathFields` ignored (that would be fail-open: the permission gate would stop seeing the plugin's filesystem effects). `xyz.lvis/pathFields` drives host-side filesystem-path extraction for the permission gate, so the terminal state must be broken-until-repaired, never silently-ungated.
- **Recovery is update-first via the existing Plugin Doctor / managed bootstrap.** A legacy-manifest rejection classifies as the reinstall-fixable `manifest-validation-error` kind. The only plugin that ever used the legacy key — `local-indexer` — is `installPolicy:"admin"` (managed), so the boot-time managed bootstrap (`ensureManagedInstalled` → `restartAll`) proactively auto-updates it to the migrated marketplace version (v0.5.24, `lvisai/pathFields`) within the same boot, with no user click and no broken window. The host install path is a clean artifact replace, so "update in place" and "uninstall + reinstall" are the same operation; the sole terminal fallback (when a plugin cannot be auto-migrated) is the surfaced Doctor remove-recommendation on the failed plugin card.
- **A Doctor banner is only green for a usable runtime.** A finished diagnostic with an unresolved catalog-grant mismatch or another non-runnable state remains failed/not-runnable instead of presenting a false success.
- **`local-indexer` was republished as v0.5.24 first** (with `lvisai/pathFields`), verified published to the marketplace, so the Doctor/managed-bootstrap reinstall target exists before this removal ships.
- **Companion PRs required** (orchestrator): the `@lvis/plugin-sdk` mirror + the marketplace schema still carry the legacy alias and must drop it separately.

## v0.5.2 — 2026-07-12

Completes the MCP Apps program and renames the vendor `_meta` namespace. A patch release — the wire contract is unchanged and the rename is transitionally dual-read, so installed plugins keep working. It also republishes the host so plugins pinned at `requires.minAppVersion` `0.5.2` (ms-graph / ep / git) become installable again.

### MCP Apps — plugin `ui://` cards, the full app→host surface (#1600)

- **A plugin can now ship an interactive `ui://` card.** #1593 delivered the host render path for external MCP servers; the plugin arm did not exist (`readUiResource` resolved only against external servers, and the loopback delegate never lifted a handler's `_meta.ui` onto the wire). Both are built: a plugin declares a card in `plugin.json`'s `uiResources[]` ("declared policy, served content" — the manifest declares the `ui://` uri + its CSP, the plugin serves the bytes from `RuntimePlugin.readUiResource`), and returns `_meta.ui.resourceUri` from a tool to trigger it. Author guide: `docs/guides/mcp-app-authoring.md`.
- **The full app→host handler surface is wired** from one handlers-table SoT (`mcp-app-bridge.ts`): `oncalltool`, `onmessage`, `onopenlink`, `onsizechange`, `onrequestdisplaymode` (`inline` / `fullscreen` / in-page `pip`), `ondownloadfile`, `onupdatemodelcontext`, plus the sandbox/read-resource handshake. A capability cannot be advertised without its handler.
- **A card is not privileged.** An app-initiated tool call takes the same `inspectHostRisk` → reviewer → approval → audit path a model call takes; the app can never name a different server; a card cannot wake the model (a `ui/message` with no active turn raises a user-gated staging card, matching VS Code). `_meta.ui.visibility: ["app"]` tools are registered so their card call runs governed, and are hidden from the model at one exposure boundary — including from the model's own execution path. A card cannot invoke the plugin's manifest auth trio (`loginTool` spawns a credentialed window).
- **`HostContext`** carries theme / locale / timeZone / displayMode to the card as the standard `McpUiStyleVariableKey` vocabulary — no `--lvis-*` key leaks.

### Plugin contract — `_meta` vendor namespace rename (#1601)

- **`_meta` key prefix `xyz.lvis/*` → `lvisai/*`** — the reverse-DNS prefix didn't match the real domain (lvisai.xyz); the sole LVIS-proprietary `_meta` key is now `_meta["lvisai/pathFields"]`, a plain vendor prefix (same style as OpenAI's `openai/*` `_meta` keys). The host's forward (write) projection emits only the new key. The reverse (read) path is transitionally dual-read: it prefers `lvisai/*` and falls back to the legacy `xyz.lvis/*` so already-published out-of-process plugins and the SDK keep working unmigrated.
- **Follow-up required, and its removal gate is observable, not a date** — `@lvis/plugin-sdk` and published plugin manifests still emit `xyz.lvis/*` and need a separate migration. The removal gate is NOT "the rename is done": an installed plugin's manifest is a file on the user's disk that keeps saying `xyz.lvis/*` until *that* user updates *that* plugin, and the host cannot observe roll-forward directly. So each legacy read is instrumented (`observeLegacyMetaKey`, once per plugin+key per process): the forward-projection hit reports an **installed manifest** that has not rolled forward (the gate for the schema's legacy property), and the two wire-read hits report an **out-of-process plugin** still emitting the old key (a population that does not exist in production yet). Ship one instrumented release; delete the fallback — and the schema property — only when that warning has gone quiet across the installed base, not on a schedule.

## v0.5.1 — 2026-07-10

Follow-up to the v0.5.0 Plugin Contract v6 release: the legacy manifest readers are removed (brought forward from the originally-planned `0.6.0`), a self-healing Plugin Doctor replaces the migration time-gate, and several LLM provider call paths are fixed. This is a patch release — the legacy-reader removal is dead-code excision, not a contract change; the v6 wire contract is unchanged from v0.5.0.

### Plugin contract — legacy readers removed (#1572)

- **`normalizeManifest` is now a pure-form materializer, not a legacy compiler** — the old `tools[]` (name strings) + `toolSchemas` + `uiActions` reader is deleted. A manifest declares tools only as pure MCP `Tool[]`; `normalizeManifest` just materializes an absent `_meta.ui.visibility` to the safe `["model","app"]` default and rejects an explicit empty visibility. A pre-v6 manifest now fails closed at load with an actionable "upgrade to `@lvis/plugin-sdk` v6" message that names the offending tool index, instead of being silently compiled forward.
- **Why this is safe ahead of the planned `0.6.0` window** — the v0.5.0 note deferred this removal until every installed plugin had migrated. The new Plugin Doctor (below) makes that time-gate unnecessary: a plugin that fails to load on the pure-v6 reader is diagnosed and auto-reinstalled from the marketplace at its latest (v6) version, so there is no broken-plugin window to wait out.
- **Vocabulary sweep** — the `uiActions` / `toolSchemas` terms are gone from code, error strings, and documentation. Per-tool surface visibility lives only in `_meta.ui.visibility` (SEP-1865) and the sole LVIS-proprietary key is `_meta["lvisai/pathFields"]`.

### Plugin Doctor — cause-aware auto-repair (#1573)

- **A failed plugin diagnoses itself and attempts a fix** — on load failure the host classifies the cause (`manifest-validation-error`, `catalog-grant-mismatch`, `incompatible-app-version`) and, for reinstall-fixable causes, automatically reinstalls the plugin from the marketplace at its latest version. Non-fixable causes (e.g. an app-version floor the current host cannot satisfy) surface the specific cause instead of a blind retry, and leave the manual Remove path in place.

### LLM providers (#1575)

- **OpenAI-compatible model list is handshake-only** — the custom OpenAI-compatible vendor no longer ships a hardcoded seed model id (it previously advertised an internal cluster model before any endpoint address was entered, which 400/404'd against arbitrary endpoints). The model dropdown now populates only from a live `GET <baseUrl>/models` handshake; an unconfigured endpoint is treated as "not configured" rather than sending a fabricated model id. The sub-agent model-complexity map drops the same seed so tier resolution falls back to the parent loop's active model.
- **Stop leaking vLLM `chat_template_kwargs` to commercial gateways** — the per-request `chat_template_kwargs.enable_thinking` flag is now scoped to the self-hosted vLLM class (openai-compatible / ollama / lmstudio / litellm) instead of every openai-compatible-shaped vendor, so requests to OpenRouter and other commercial gateways no longer carry a field that 400/422'd the strict ones. `finish_reason=length` continuation support is widened to the same self-hosted class from a single shared predicate, keeping the request-shaping and capability sides from drifting.
- **No bearer token on plaintext-local endpoints** — a keyless-capable provider pointed at an `http://` (non-TLS) endpoint no longer attaches a stored or placeholder API key.

## v0.5.0 — 2026-07-10

**Plugin Contract v6** (#885) — plugin manifests move to a pure Model Context Protocol `Tool[]` surface, external MCP servers gain per-server isolation, and the host derives every governance signal itself instead of trusting a plugin self-claim. This release is the `minAppVersion` floor for the v6 contract — the marketplace publishes v6 plugins as `requires.minAppVersion: 0.5.0`. Already-installed legacy plugins keep working across the upgrade: the host still reads the legacy manifest shape and compiles it forward at load time. The legacy readers are removed in a later `0.6.0` release, after the migration window — bundling that removal here would break plugins installed before the upgrade.

### Plugin contract

- **Pure MCP `Tool[]` manifest** (`@lvis/plugin-sdk` v6.0.0; host PR #1562, #1563, #1564) — a manifest declares tools as `{name, title?, description?, inputSchema, outputSchema?, icons?, _meta?}`. Per-tool surface visibility is `_meta.ui.visibility: Array<"model"|"app">` (SEP-1865); the one LVIS-proprietary key is `_meta["lvisai/pathFields"]`. `normalizeManifest` is the single legacy-shape reader — it compiles the old `tools[]` + `toolSchemas` + `uiActions` triple into pure `Tool[]`, materializes an absent visibility to the safe `["model","app"]` default, and rejects an explicit empty visibility.
- **Host-derived governance** (PR #1564) — tool ownership, `writesToOwnSandbox`, and model-vs-app routing are computed by the host from the manifest, never read from a plugin self-claim; the ownership map is built from model-visible tools only, so the auth trio can never widen access control.
- **First-party plugins republished** on the pure v6 shape, with per-surface set-equality proven against each plugin's legacy manifest.

### MCP isolation

- **Per-server partition + teardown** (PR #1565) — each external MCP server renders in an isolated `mcp-app:<hex>:<cardId>` partition backed by an injective, fail-closed server-id encoding; detached MCP windows are swept on kill-switch / config-removal / disconnect-all, and their storage is cleared on teardown.
- **Execution-parity regression lock** (PR #1566) — external MCP tools and in-process plugin loopback tools traverse the one `ToolExecutor` pipeline and converge at the same governed chokepoints (Layer-1 deny, ApprovalGate, audit, effect-ledger). A low-trust foreign MCP peer is categorically excluded from the reviewer auto-approve lane and escalates straight to the ApprovalGate — it is never silently auto-approved.

## v0.4.7 — 2026-07-09

Packaging fix-forward for the failed `v0.4.5` and `v0.4.6` tags. Ships the entire `v0.4.6` payload (see below) — neither of those tags produced a GitHub Release, so `v0.4.4` was the last published build.

### Packaging

- **`node-pty` `spawn-helper` assertion scoped to macOS** — `scripts/electron-after-pack.cjs` required `spawn-helper` for every non-Windows platform, but it is a macOS-only artifact: node-pty's `binding.gyp` declares that target under `['OS=="mac"', ...]` (the `OS!="win"` branch builds only `pty`), and `src/unix/pty.cc` uses `helperPath` solely inside `#if defined(__APPLE__)` — Linux calls `forkpty()` directly. The Linux installer job therefore failed at `afterPack` on every tag build, and because `publish-release` is `needs: installers`, the atomic publish was skipped and no Release was ever created. A regression assertion in `packaging-discipline-source.test.ts` now pins the `darwin`-only scoping.

### 검증

- `v0.4.5` and `v0.4.6` tag-push installer runs: macOS + Windows succeeded, Linux failed at `assertNodePtyBinary`, publish skipped.
- Fix verified before tagging via a `workflow_dispatch` run of `build-installers.yml` (publish is gated on `github.event_name == 'push'`, so nothing was released): macOS, Windows, and Linux installers all built successfully.

## v0.4.6 — 2026-07-08

Marketplace asset platform, the desktop-gaps program (E1–E7), sub-agent lifecycle, and permission/sandbox hardening release. Bundles everything merged after the `v0.4.5` tag.

### Marketplace / provider catalog

- **Marketplace re-architected around installable assets** (PR #1513, #1516, #1517, #1515, #1522, #1521, #1514) — a lightweight marketplace core, an asset registry, local candidate resolution, and explicit asset-catalog / settings boundaries; the provider default split moves provider metadata out of the app bundle.
- **Catalog-owned provider metadata + dynamic model catalog** (PR #1538, #1539, #1529, #1533) — providers and reference models are described by the catalog, the model list is cached and persisted, and the model-catalog UI is driven from that data.
- **Custom provider presets + typed catalog sections** (PR #1534, #1535).
- **Lazy loading for marketplace payloads** (PR #1540, #1520, #1523) — theme bundles, language-pack catalogs, and provider settings all load on demand.
- **Asset-state UX** (PR #1525, #1524, #1526) — installed-asset badges, package trust labels, and an explicit unsupported-asset state.
- **Lifecycle hardening + e2e coverage** (PR #1536, #1527, #1528, #1532).

### Desktop gaps program (E1–E7)

- **E1 — keyless value experience** (PR #1508, #1530) — public-build embedded-key guard, Ollama fallback (localhost probe + login chip), endpoint-unreachable UX, keyless LLM readiness.
- **E2 — diagnostics bundle + production logs** (PR #1503, #1510) — rotating file log sink, dual DLP chokepoint, deny-by-default settings allowlist, opt-in crash dumps, an AuditTab diagnostics section, and log rotation / total-size caps.
- **E3 — conversation import + FTS search** (PR #1509) — whitelist-validated `lvis:chat:import`, SQLite FTS5 trigram + 2-character CJK `LIKE` hybrid, and a better-sqlite3 packaging guard.
- **E4 — global shortcuts + launch-at-startup** (PR #1506), including a hidden-window deep-link fix.
- **E5 — plugin update e2e + partial-failure UX** (PR #1504).
- **E7 — onboarding look & feel** (PR #1507) plus the no-key composer lift (PR #1541).

### Sub-agents

- **Resume + session isolation** (PR #1476, #1478, #1480, #1474) — resume metadata, same-instance resume, UI continuity across resume, and a dedicated sub-agent session namespace.
- **Parallel runs and fan-out cap** (PR #1543, #1519) — governed parallel sub-agent runs with Doctor recovery, and a fan-out limit of 10.

### Permissions / sandbox

- **Graduated grant tiers** (PR #1481) and a shared shell tokenizer for permission matching (PR #1472).
- **PermissionManager owns its own state** (PR #1475, #1477, #1479) — reviewer decision, meta override, and path scope moved behind the manager.
- **Windows ASRT plugin workers** (PR #1546, #1548) — worker isolation preserved until Windows ASRT can scope grants; plugin workers now run through per-worker ASRT ACL grants.
- **`sed` risk classification fix** (PR #1491).

### Plugins / SDK

- **SDK manifest schema is the only host validator** (PR #1547) — `@lvis/plugin-sdk` is now pinned at `v5.22.0` (PR #1549), aligned across every plugin repo.
- **Windows plugin install/update no longer fails with `EPERM`** (PR #1549) — the atomic install directory swap retries transient Windows lock contention, and a locked previous install is no longer misread as a first install. Fixes `lvis-plugin-meeting#154`.
- **Plugin Doctor** (PR #1495, #1544) — actionable manifest Doctor failures.

### Security

- **DLP token-prefix coverage** (PR #1545) — unmarked vendor tokens can no longer enter diagnostics.

### Packaging / deps

- **Branded NSIS installer** (PR #1492) and a lighter Electron locale footprint (PR #1518).
- **Electron 43** (PR #1490), `@types/node` 26 (PR #1487), `actions/cache` v6 (PR #1369).

### UI

- **Shell refinements + depth tokens** (PR #1489, #1486) and multi-project insights (PR #1482).

### Docs / hygiene

- English-default docs with a Korean mirror (PR #1488), README metadata templates (PR #1531), and a hygiene bundle (PR #1494).

## v0.4.5 — 2026-07-03

Workspace rail, chat-rendering unification, side-chat, and permission/sub-agent hardening release. Bundles everything merged after the `v0.4.4` tag.

### UI / Workspace rail

- **Chat side panel rebuilt as a workspace rail** (PR #1428, #1430, #1433, #1434, #1437, #1439, #1440) — content-driven tabs with an empty-state launcher, workspace state lifted to a store (survives session switch/tab unmount), preview rail docked beside the composer, side-panel toggle moved into the toolbar, and floating action-activity panel top-aligned.
- **Workspace rail redesign batch** (PR #1443, #1447, #1448, #1460, #1461) — header-count removal, vertical/panel resize, in-app routing with a "시스템 앱으로 열기" context menu, ephemeral↔pinned tabs, md/mermaid file preview, a real PTY terminal, file-content preview, tab-bar scroll/drag, project-path selection, browser de-nest + search popover, a file-source segment, and a sub-agent viewer.
- **Project directory browser completeness** (PR #1457) — remove-root, context menu (Reveal in Finder / Copy Path), keyboard navigation + a11y, and session-file inclusion aligned to VS Code / JetBrains / Zed references.

### Chat rendering unification

- **Single shared transcript renderer across all three chat surfaces** (PR #1464, #1465, #1467, #1468, #1463) — main, sub-agent, and side-chat now render through one `TranscriptRenderer` (tool/thinking parity); chat-mode side panel docks without a modal blur; the sub-agent tab shows the full conversation-loop transcript inline (tool-call-style) plus history from loaded sessions.

### Side-chat engine

- **Dedicated side-chat engine** (PR #1462) — a second conversation loop over a dedicated internal IPC channel with a lightweight surface, monotonic stale-frame guard, and abort-on-unmount isolation.

### Sub-agent / Permissions

- **Host-assigned sub-agent round budget** (PR #1470) — the LLM no longer self-selects `maxTurns`; the host assigns a mode-based round budget, and round-cut-off now emits a `round-cap` stop reason + `incomplete` signal with preserved partial output.
- **`agent_spawn` honors allow-all mode** (PR #1469) — no approval popup for sub-agent spawns when the mode is "모두 허용" (allow-all).

### Permissions / Sandbox / API

- **ASRT Windows sandbox support + audit-gap closure** (PR #1450, #1456, #1459) — Windows srt-win readiness/consent flow refinements and post-audit sandbox hardening (workerId producer, verdict-cache TOCTOU, drag-drop).
- **Local API surface** (PR #1435, #1438, #1441) — SDK/API/CLI boundary + mega-file decomposition, a loopback HTTP+SSE local API server with a thin CLI, and approval-gate-mediated external mutation authorization.
- **MCP + plugin hardening** (PR #1429, #1431, #1432) — closed app CSP/elicitation gaps, separated plugin UI actions from LLM tools, and hardened `hostFetch` follow-ups.

## v0.4.4 — 2026-07-01

Packaging fix-forward for the failed `v0.4.3` tag.

### Packaging

- **Installer footprint guard follows supported Electron locales** — package footprint validation now reads `build.electronLanguages` from `package.json` as the allowed Electron locale set, while still requiring the base English/Korean runtime locales. This keeps the guard aligned with the seven-locale UI build and prevents `de`, `es`, `fr`, `ja`, and `zh-CN` Electron runtime locale files from being treated as leaks.

### 검증

- `v0.4.3` tag-push installer run failed in `scripts/check-package-footprint.mjs` after all three platform builds detected newly included Electron locale assets.
- Fix-forward release target: `v0.4.4`.

## v0.4.3 — 2026-07-01

UI shell, localization, navigation, and action-panel polish release. This patch ships the post-v0.4.2 page-shell reconstruction and mode/control refinements that were merged after the v0.4.2 tag.

### UI / Navigation

- **Shared page shell reconstruction** (PR #1406) — plugin-host pages now use the shared page chrome, flatter plugin host surfaces, page back navigation, and restored scroll position when moving away and returning.
- **Sidebar and action-panel chrome cleanup** (PR #1407, #1408) — sidebar collapse and right action-panel controls use simpler chevron affordances without nested box chrome, with chat-mode visibility and collapsed defaults aligned to the intended layout.
- **Right action panel expansion** (PR #1403) — adds the right-side action activity panel foundation and refines collapsed counts, floating action activity interactions, opacity token usage, and duplicate prop/content cleanup.

### i18n / Settings

- **Seven-locale catalog support** (PR #1401, #1405) — UI strings were tokenized and full seven-locale catalogs were added, with generated sentinel leak protection.
- **Work mode and provider control alignment** (PR #1405) — app mode naming and provider controls are aligned around Work mode, reducing action/work naming drift.
- **ASRT setting persistence** (PR #1405) — ASRT opt-in now remains enabled after installer abort paths instead of immediately reverting.

### Plugins / Routines

- **Work assistant routine cleanup** (PR #1404) — removes the legacy work-assistant wakeup fixture and aligns the briefing routine path with the current plugin behavior.

### 검증

- Remote main (`7d1a1ca3`): CI / CodeQL green.
- Local release prep: `package.json` bumped to `0.4.3`; changelog records `v0.4.2..HEAD` user-facing changes.

## v0.4.2 — 2026-06-29

사용자 가시성 높은 안정화 릴리즈 — Windows 알림 활성화, 업데이트 설치 fallback, slash picker 레이아웃, 플러그인/권한 경계, Windows 로컬 검증 경로를 함께 정리했다.

### 앱 안정성 / Windows

- **Windows 시스템 알림 클릭 경로 복구** (PR #1398) — Windows toast activation 이 새 Electron error 창으로 열리지 않고 기존 앱 activation 경로로 처리되도록 정렬했다.
- **unsigned updater fallback 복구** (PR #1379) — 서명되지 않은 내부 빌드에서 업데이트 적용 버튼이 dead-end 가 되지 않도록 수동 설치 fallback 경로를 제공한다.
- **Windows 로컬 검증 경로 복구** (PR #1399) — symlink 권한이 없는 Windows 계정에서도 junction 기반 reparse-point 테스트로 실제 path escape 방어를 검증한다. pre-push hook 의 `typecheck` / 전체 `test` / `build` 가 Windows 로컬에서 통과한다.

### UI / 입력 경험

- **Slash picker root / 2-depth 레이아웃 정렬** (PR #1324) — 1-depth category row 와 command/shortcut/plugin/skills 2-depth row 의 icon slot, text stack, count badge, heading spacing 을 통일했다.
- **preload blank-screen 회귀 수정** (PR #1324) — preload 가 main-process logger/pino transport 를 renderer sandbox 로 끌어오지 않도록 appearance font guard import 를 preload-safe shared module 로 이동했다.
- **플러그인 text icon clipping 방지** (PR #1324) — `iconText` 기반 플러그인 배지가 slash picker row 안에서 잘리지 않도록 작은 slot 에 맞춰 스케일하고, caller style override 는 `fontSize` 로 제한했다.

### 플러그인 / 루틴 / 권한

- **루틴 source marker + on-demand plugin activation** (PR #1397) — 루틴이 어떤 source 에서 활성화됐는지 추적하고, 세션 단위로 필요한 disabled plugin 을 안전하게 on-demand 활성화할 수 있게 했다.
- **local-indexer eager indexing 정리** (PR #1396) — boot 경로에서 local-indexer 를 idle scheduler 에 묶지 않도록 정리해 indexing 시작 조건을 더 예측 가능하게 했다.
- **plugin SDK v5.18.0 반영** (PR #1395) — manifest compatibility host patch 일부를 제거하고 SDK 네이티브 동작으로 정렬했다.
- **notificationEvents self-emitted warning 정리** (PR #1394) — 플러그인이 자체 emit 한 notification event 에 대해 불필요한 warning 을 내지 않도록 했다.
- **plugin read auto-allow / sandbox coupling 보강** (PR #1388–#1393) — host-observed effect boundary, read relaxation, sandbox containment, hostFetch verb snapshot, plugin tool category propagation 을 정렬해 권한 relaxation 이 비격리 경로로 새지 않게 했다.

### LLM / 업데이트

- **OpenAI-compatible vendor 확장** (PR #1380–#1382) — OpenAI-compatible provider, Nemotron model option, full quantized model name 표시를 추가했다.
- **finish_reason=length auto-continue** (PR #1384) — vLLM 계열 provider 에서 길이 제한으로 중단된 응답을 자동 continuation 할 수 있게 했다.
- **AI SDK v7 계열 업데이트** (PR #1385) — provider SDK major 업데이트를 반영했다.

### 검증

- Local Windows (`pwsh`): `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test` (557 files / 7090 pass / 31 skipped), `bun run build`, `bun run check:test-quality` 통과.
- PR #1399 pre-push hook: `typecheck`, 전체 `test`, `build` 우회 없이 통과.
- Remote main (`d2463003`): CI / CodeQL green.
- PR #1324: CDP runtime + visual verification 완료 (`window.lvisApi` 노출, `#root` 렌더링, slash picker root/2-depth screenshots, preload SharedArrayBuffer/lvisApi initialization error 없음).

## v0.4.1 — 2026-06-26

전부 **default-OFF** 인 OS 샌드박스 인프라 릴리즈 — `LVIS_SANDBOX_ENABLED`(또는 features.osToolSandbox)를 켜기 전에는 런타임 동작이 v0.4.0 과 동일하다.

### OS 샌드박스 — ASRT 마이그레이션

- **`@anthropic-ai/sandbox-runtime`(ASRT)로 교체** (PR #1355, #1356, #1357, #1358) — 구 per-OS 샌드박스 러너(`sandbox-exec-runner`/`bwrap-runner`)를 제거하고 호스트 도구·워커 spawn 을 ASRT 로 재배선했다. macOS Seatbelt / Linux bwrap(full FS+network+process) / Windows srt-win(network-only). strict-union egress enforcement(`strictAllowlist` + 로드된 플러그인 매니페스트 allow-list 의 union), parentProxy 직결 차단, 호스트 secret-dir read deny-floor.
- **동적 endpoint + 외부 MCP 워커 egress** (PR #1363, #1364) — 신뢰설정의 Azure/임베딩 endpoint hostname 을 egress union 에 live-feed; 외부 MCP stdio 서버를 ASRT 로 래핑(crash-시 cleanup 포함).
- **secret-dir read deny-list 중앙화** (PR #1365) — `~/.lvis/secrets`/`~/.ssh`/`~/.aws` 등을 boot config + 워커 wrap 에 일관 적용.
- **substrate-aware reviewer relaxation** (PR #1359, #1360) — per-category relaxation 이 `confines`(fs/process/network) 를 읽어, 비-샌드박스 워커로의 relaxation 누수를 차단.

### Windows 샌드박스

- **Windows ASRT 네트워크 샌드박스 + 동의 UX** (PR #1361, #1362) — srt-win(WFP machine-wide filter + 그룹 SID + restricted-token job)로 network-only 격리, 1회 UAC 설치 + 재로그인 동의 플로우(silent 금지), per-platform 패키징 prune.
- **Windows FS-jail shim (dormant)** (PR #1368) — srt-win.exe 의 `acl` deny-list + `exec --holder-pid` fence 를 구동하는 호스트 shim. default-OFF·dormant(confines 미플립), 실 enforcement 는 수동 Windows QA 게이트.

### 플러그인 워커 격리 (worker-confinement)

- **host-mediated `spawnWorker` + bind-mount UDS** (PR #1366) — 플러그인이 워커를 직접 spawn 하지 않고 호스트가 ASRT-confined 로 wrap+spawn 하는 `hostApi.spawnWorker` 도입. HTTP 워커의 inbound 제어채널을 bind-mount Unix-domain-socket 으로(Linux bwrap `--unshare-net` loopback 차단 해소), 3-OS 균일. reviewer no-leak 레지스트리, FS jail, 토큰 인증.
- **워커 crash 감지(`onExit`)** (PR #1375) — `SpawnedPluginWorker.onExit` 추가로 소비자가 워커 crash 를 감지해 재시작할 수 있게 함.

### 검증

- macOS gate-ON 실런타임 스모크(실 Seatbelt: 도구 confine + egress deny + FS jail) + 단위 스위트 green. Linux bwrap = Linux CI, Windows srt-win = windows-latest CI + 수동 QA(darwin 검증 불가).
- 각 보안 PR 3-에이전트 적대 클러스터 리뷰 통과.

## v0.4.0 — 2026-06-25

### 채팅 / 작업 진행 UI

- **즉시 WorkGroup 진행 표시** (PR #1351) — 사용자가 메시지를 보내면 모델의 `thinking`/status 이벤트를 기다리지 않고 기존 WorkGroup 진행 헤더(`작업 중...`)가 바로 표시된다. 별도 assistant placeholder 나 standalone `Thinking...` 본문은 만들지 않는다.
- **reasoning / 중간 작업 묶음 복구** (PR #1348, #1349, #1351) — 최종 응답 전에 생성되는 reasoning, 도구 호출, 중간 assistant round 가 다시 WorkGroup 안에 묶이도록 정렬했다. 모델 응답 전 `Thinking...` 텍스트가 본문에 먼저 뜨던 회귀도 제거했다.
- **질문 카드 키보드 흐름 복구** (PR #1350) — ask-user-question 카드 페이지 전환 후에도 첫 번째 질문으로 포커스가 돌아가고 방향키 선택 흐름이 유지되도록 했다.

### 플러그인 / 인증 / 토스트

- **host-managed 플러그인 인증 경로 정렬** (PR #1343, #1346, #1351) — 플러그인 인증 실패는 silent fail 이 아니라 채팅 입력 영역 위 토스트로 노출하고, 로그인 실패 시 플러그인 창을 열지 않도록 순서를 정렬했다.
- **토스트 위치와 형태 개선** (PR #1351) — 토스트를 입력창 위의 별도 floating card 가 아니라 composer 뒤에서 올라오는 겹침 형태로 배치하고, severity 별 색상과 긴 메시지 흐름 표시를 추가했다.
- **플러그인 UI action manifest 허용** (PR #1344) — UI action tool schema 가 host validation 에서 정상 통과하도록 manifest 검증 경로를 보강했다.

### 권한 / 설정

- **권한 설정 단순화와 Auto-verify 프롬프트 표시 정렬** (PR #1347, #1350) — Permission Reviewing 탭이 다시 노출되는 회귀를 정리하고, reviewer prompt 는 Auto-verify 영역 안의 read-only collapse 로 확인할 수 있게 했다.
- **내장 slash command 권한 요청 회귀 수정** (PR #1350) — 내부 slash command 는 권한 팝업을 띄우지 않고 telemetry/audit 경로만 남기도록 정렬했다.

### 레이아웃 / 창

- **Detached Work Board / 창 레이아웃 보강** (PR #1340, #1341, #1342) — 분리 창의 work board 컬럼 레이아웃과 폰트 초기화 경로를 안정화했다.
- **ScrollArea / overflow 정리** (PR #1337, #1338, #1339) — imported trigger card, memory panel, scroll area 계열의 잘림/overflow 회귀를 정리했다.

### 알려진 후속 작업

- 토스트 후속 이슈는 별도 추적한다: #1352 (`자세히 알아보기` 미동작, marquee 정지, X 영역 경계 fade 처리).
- Auto-review 진행 카드가 빠른 리뷰 경로에서 사용자가 보기 전에 사라질 수 있다: #1353.

### 검증

- PR #1351: local `bun run test` 전체 535 files / 6825 pass / 35 skipped, `bun run typecheck`, `bun run build`, remote build-and-test / Windows permission path / CodeQL / naming-gate / cluster-detector green.
- Release baseline: `main@b029aa74` 에서 `bun run build` green 후 릴리즈 준비.

## v0.3.1 — 2026-06-16

### 권한 자동검증

- **LLM 권한 자동검증 기본값** (PR #1254) — fresh install 의 권한 검증 기본 모드를 LLM reviewer 로 두고, provider 가 아직 구성되지 않은 경우에는 rule classifier 로 명확히 degrade 한다.
- **명시 승인 상태 재사용** (PR #1253) — 사용자가 이미 `session` / `always` 로 승인해 저장된 동일 tool/input/source 조합은 foreground 권한 모달을 다시 띄우지 않고 저장된 명시 승인 상태를 먼저 확인한다. 저장 당시 verdict 보다 현재 rule verdict 가 높아진 경우에는 fail-closed 로 다시 프롬프트한다.
- **background adjudicator 정렬** (PR #1258) — 자동 검증 모드에서 reviewer 는 foreground 차단 UI 가 아니라 background adjudicator 로 동작한다. LOW 는 audit-only auto 진행, MED/HIGH 는 명시 승인 경로로 에스컬레이션한다.

### 플러그인 / 마켓플레이스

- **마켓플레이스 공지 배너 및 marquee 표시** (PR #1259) — Marketplace `GET /api/v1/announcements` 응답을 main-process poller 가 `lvis:marketplace:announcements` IPC 로 renderer 에 전달하고, dismiss 상태를 `settings.marketplace.dismissedAnnouncementIds` 에 저장해 재시작 후에도 숨김을 유지한다. 긴 공지/업데이트 배너 텍스트는 `MarqueeText` 로 overflow 시에만 자동 스크롤하고 reduced-motion 변경 시 정적 표시로 복귀한다.

### 설정 / IPC 경계

- **hostResolverMap 변경 경로 고정** (PR #1259) — generic `lvis:settings:update` 는 이제 `llm.hostResolverMap` 패치를 `host-map-requires-apply-host-map` 으로 거부한다. relaunch-sensitive host map 변경은 dedicated `SETTINGS.applyHostMap` IPC 만 사용해야 한다.

### 검증

- PR #1253: permission memory skip focused Vitest, permission audit assertions, Copilot + reviewer loop Critical=0/Major=0.
- PR #1258: permission reviewer/background adjudicator docs + contract review, Copilot + reviewer loop Critical=0/Major=0.
- PR #1259: focused announcement/marquee Vitest 6 files / 74 pass, MarketplaceFetcher test-stub Vitest 7 files / 104 pass, `bun run typecheck`, pre-push full Vitest 505 files / 6605 pass / 14 skipped, `bun run build`, `git diff --check`.

## v0.3.0 — 2026-06-11

### 데모 자동 활성화 (zero-input)

- **빌드 임베디드 활성화 키** (PR #1237, #1239, #1242) — 내부 배포 빌드에 AES-256-GCM 암호문 형태의 데모 활성화 키를 임베드해, fresh install 에서 데모 칩 클릭만으로 키 입력(붙여넣기) 없이 즉시 활성화된다. CI 빌드는 `LVIS_EMBED_DEMO_ACTIVATION` repo secret 으로 키를 주입하며, secret 이 없는 빌드(포크/외부)는 기존 수동 붙여넣기 흐름을 유지한다.
- **재시작 없는 첫 활성화** (PR #1242) — boot 시 임베디드 키를 복호화해 `process.env` 에 hydrate 하고 Chromium `host-resolver-rules` 를 같은 부팅에 설치해, 기존의 "첫 활성화 후 재시작" 단계를 제거했다.
- **로그아웃 sentinel** (PR #1242) — 명시적 데모 로그아웃(`lvis:demo:clear`) 시 sentinel 파일을 fail-safe 순서(쓰기 우선)로 기록해, 임베디드 키 빌드가 다음 부팅에서 로그아웃 상태를 되살리지 않는다.

### Settings / 로그인 UX

- **수동(host) 입력 지원** (PR #1243) — 일반 LLM endpoint 사용자가 Settings 에서 /etc/hosts 스타일 host-resolver map 을 직접 입력할 수 있다. RFC 1123 hostname + IPv4 검증으로 잘못된 항목과 rule 주입을 차단하고, 적용 시 재시작 안내 confirm(미저장 작업 손실 경고) 후에만 재시작한다. 데모 모드의 host map 은 기존 고정값을 유지한다.
- **로그인 상태 disabled 표시** (PR #1243) — 로그인(데모) 상태에서 vendor/baseUrl/model/host 입력 필드를 숨기는 대신 비활성화 상태로 노출하고, General 탭에서 로그오프하면 manual 모드로 전환되어 직접 입력할 수 있다.
- **기본 선택 정렬** (PR #1243) — Settings 진입 시 vendor 가 hydration 전 stale 값("claude")으로 잠깐 표시되던 flash 를 제거했다.

### i18n

- **시스템 언어 감지** (PR #1240) — fresh install 의 초기 언어를 하드코딩 영어 대신 OS 시스템 언어(ko/en)로 결정한다.

### 온보딩

- **post-tour 하이라이트 게이트** (PR #1241, #1238) — 온보딩 완료 사유(chain vs probe-skip)를 구분해, returning user 에게 post-tour 카드가 ScenarioShowcase 위에 잘못 겹쳐 표시되던 문제를 수정했다.

### 정리

- **Presentation mode 제거** (PR #1244) — 데모 시연용 한시 기능이던 tool 실패 badge 숨김(`hideToolFailures`)을 일정대로 완전 제거했다. 실패/오류 badge 는 항상 표시된다.
- **테스트 품질** (PR #1246, #1247) — 중복 테스트 헬퍼 3건을 공유 fixture 로 추출하고, 로그아웃 테스트 기대를 #1243 동작(authMode manual 전환)과 정렬했다.

### 검증

- dev→main 통합(PR #1245): build-and-test / Windows permission path / CodeQL / naming-gate / cluster-detector 전부 green.
- 각 PR: 3-agent cluster review (architect/critic/security) + Copilot 리뷰 루프 통과. #1242 sentinel fail-open MAJOR, #1243 writer/reader 경로 불일치 CRITICAL 등을 머지 전 수정.
- 로컬 packaged 빌드 검증: 임베디드 ciphertext 존재 + 평문 키/호스트 누출 0 (app.asar), fresh install 런타임에서 `lang=ko` + 데모 `activated=true` + host-resolver-rules 자동 설치 확인.

## v0.2.18 — 2026-06-01

### 플러그인 / 마켓플레이스

- **플러그인 업데이트 stale catalog 차단 복구** (PR #1198) — 업데이트 배지는 live Marketplace catalog 로 `meeting@0.5.25` 를 감지했지만, 설치 직전 `expectedVersion` 검증은 7일 TTL offline catalog cache 의 stale `meeting@0.5.8` 값을 읽어 정상 업데이트를 차단했다. 업데이트 설치 경로의 버전 검증을 live catalog 조회로 정렬해 banner 와 install guard 가 같은 Marketplace 최신 버전을 기준으로 판단하도록 했다.
- **일반 설치 경로 live fetch 범위 제한** (PR #1198) — `expectedVersion` 이 없는 일반 설치는 기존 catalog/list 경로를 유지하고, 업데이트처럼 기대 버전이 명시된 경우에만 live version guard 를 수행한다.

### 검증

- PR #1198: focused Vitest 4 files / 51 pass, `bun run typecheck`, `bun run build`, `git diff --check`, remote build-and-test / Windows permission path / CodeQL / naming-gate success, Copilot current-head inline comments 0, Cross-Cutting 3-lane review Critical=0/Major=0.

## v0.2.17 — 2026-06-01

### 릴리스 검증

- **라이브 앱 업데이트 설치 경로 검증 릴리스** — v0.2.16 의 updater shutdown handoff 수정이 실제 GitHub 릴리스 피드에서 다음 버전 업데이트를 다운로드하고, 확인 후 종료/설치까지 완료하는지 검증하기 위한 version-only 릴리스다. 업데이트 설치 코드 경로는 v0.2.16 과 동일하며, package version bump 만으로 v0.2.16 → v0.2.17 라이브 업데이트 경로를 만든다.

### 검증

- v0.2.16 과 동일 코드 경로. v0.2.16 검증: Targeted Vitest 4 files / 53 pass, `bun run check:test-quality`, `bun run typecheck`, `bun run build`, `git diff --check` pass.

## v0.2.16 — 2026-06-01

### 앱 업데이트

- **앱 업데이트 적용 재시작 경로 복구** — `quitAndInstall()` 가 먼저 BrowserWindow 를 닫고 앱 종료로 이어지는 Electron updater 계약을 LVIS 의 close-to-tray / async before-quit / plugin before-quit 핸들러가 `preventDefault()` 로 가로막아 다운로드 완료 후 재시작 설치가 진행되지 않던 문제를 수정했다. 업데이트 설치 의도를 main process 에 표시하고, 해당 경우에는 창 닫기와 종료 이벤트를 updater 가 소유하도록 둔다.
- **업데이트 설치 IPC 경계 보강** — `lvis:update:install-now` 가 실제 재시작/설치 경로가 되었으므로 host renderer sender 를 main process 에서 검증하고, native 확인 dialog 도 같은 IPC handler 안에서 소유해 renderer 나 plugin shell 이 확인 단계를 건너뛰어 설치를 강제하지 못하게 했다.
- **업데이트 배지 IPC race 방어** — renderer 의 초기 `getAppUpdateState()` snapshot 이 더 늦게 도착해 live update push 를 덮어쓰지 못하게 하고, install IPC 가 실패하거나 앱이 종료되지 않는 경우에는 local click gate 를 해제해 재시도 가능하게 했다.

### 검증

- Targeted Vitest: `release-prep`, `app-update-install-intent-source`, `use-app-update`, `plugin-runtime` — 4 files / 53 pass.
- `bun run typecheck`, `bun run build`, `git diff --check` pass.

## v0.2.15 — 2026-06-01

### 플러그인 / 마켓플레이스

- **플러그인 secret URL 오입력 차단** (PR #1194) — API-key 형태의 플러그인 secret 필드에 `http://` / `https://` endpoint 값이 저장되거나 provider 호출까지 흘러가는 경로를 차단했다. 저장 경계와 HostApi read 경계에서 URL-shaped 값을 거부/격리해 provider 401 에러에 잘못된 endpoint 문자열이 노출되는 문제를 막는다.
- **마켓플레이스 업데이트 버전 검증 강화** (PR #1194) — renderer 가 전달한 기대 버전을 신뢰하지 않고, main-process install lifecycle 에서 trusted catalog version 과 먼저 대조한다. 실제 version-changing install 이 일어난 경우에만 rollback/quarantine 을 수행하고, no-op install 뒤 mismatch 는 기존 정상 런타임을 복구한다.

### 안정성 / Windows 검증

- **permission path SOT Windows 정렬** (PR #1194) — reviewer path-field 값과 allowedDirectories 비교를 canonical + case-fold 형태로 통일해 Windows drive/separator 차이로 허용 경로가 HIGH 로 오판되는 문제를 수정했다.
- **persistent approval store Windows 내구성 보강** (PR #1194) — Windows 에서 directory fsync 가 EPERM 을 반환하는 환경을 best-effort 로 처리하고, persistent approval 파일의 read/modify/write 를 직렬화해 동시 rename 충돌을 제거했다.

### 검증

- PR #1194: 3-agent cluster review GO (architect/critic/security, MAJOR 0), `bun run typecheck`, 전체 `bunx vitest run --reporter=verbose` 473 files / 6226 pass / 24 skipped, `bun run build`, pre-push hook(`tsc --noEmit`, `vitest run`, `build`) pass, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster-detector success.

## v0.2.14 — 2026-05-27

### UI / 설정

- **데모 표시 토글 optimistic 전환** (PR #1185) — `features.hideToolFailures` 스위치가 순수 controlled 라 `updateSettings → onSettingsUpdated` broadcast 왕복이 끝나야 움직였고, stale/느린 설정 snapshot 에선 값은 저장되는데 스위치가 시각적으로 멈춰 "클릭이 안 되는" 것처럼 보였다. 클릭 즉시 로컬 state 로 전환(optimistic)하고 authoritative `settings` 값과 effect 로 reconcile, IPC 에러 시 revert 한다. `useSettings.toggleThinking` 와 동일 패턴.

### 검증

- PR #1185: 3-agent 검증 루프(correctness / architecture / test) GO MAJOR=0, `bun run typecheck` + `build:renderer`, 신규 e2e (flip + persist + reopen reflection) pass, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster 전부 success.

## v0.2.13 — 2026-05-26

### UI / 데모

- **도구 실패 배지 숨김 데모 플래그** (PR #1183) — `features.hideToolFailures`(기본 off)를 추가했다. 켜면 대화 타임라인에서 실패한 도구 호출의 "실패" / "오류 있음" 배지를 중립 표식(·)으로 대체해 시연 중 실패가 노출되지 않는다. 표시 전용 — `ToolEntryItem.status` 는 스트림 상태와 감사 로그에 여전히 `"error"` 로 남으며, 실패를 "완료" 로 가리지 않는다. `ToolStatusBadge`/`HiddenStatusMarker` 로 3곳에 복붙돼 있던 배지 렌더를 단일 출처로 통합했고, 설정 → 일반 → "데모 표시" 토글로 즉시 켜고 끌 수 있다.

### 검증

- PR #1183: `bun run typecheck` clean, ToolGroupCard 44 (신규 4) + settings-store 71 Vitest pass, `bun run build:renderer` 성공, remote CI build-and-test / Windows permission path / CodeQL / naming-gate / cluster 전부 success.

## v0.2.12 — 2026-05-26

### 안정성 / 중단 처리

- **툴 실행 중 사용자 중단 지원** (PR #1180) — `abortCurrentTurn()` 이 provider stream 에만 머물지 않고 tool executor 까지 전파되도록 정렬했다. 비협조 툴이 `abortSignal` 을 무시해도 `runWithCeiling()` 이 사용자 중단/ceiling 에서 즉시 반환하고, 이미 취소된 후속 tool call 은 훅/권한 단계 전에 취소 `tool_result` 로 닫는다.
- **Tool-result pair 보존 후 턴 종료** (PR #1180) — tool 실행 중 중단되면 취소 `tool_result` 를 history 에 남긴 뒤 다음 LLM round 로 재진입하지 않고 `[중단됨]` 으로 턴을 종료한다. OpenAI/Anthropic strict tool_use/tool_result pair invariant 를 유지하면서 사용자는 즉시 중단 완료를 확인할 수 있다.

### 검증

- PR #1180: focused Vitest 3 files, `bun run typecheck`, `bun run build`, pre-push full Vitest 470 files / 6204 pass / 13 skipped, remote CI / Windows permission path / CodeQL / naming / cluster success, Copilot inline comments 0.

## v0.2.11 — 2026-05-26

### TPM / 컨텍스트 안정화 (핵심)

- **Eager 도구 노출 회귀 수정 + 플러그인 활성/비활성** (PR #1177) — tool-level deferral 기본-on 회귀(턴마다 ~12회 `tool_search` 디스커버리 라운드로 TPM 폭증)를 되돌려 활성 플러그인 도구 스키마를 다시 eager 로 노출한다. 빌트인은 항상 eager 이며 임계 카운트에서 제외하고, deferral 은 활성 plugin+MCP 도구 수 ≥ 200(`EAGER_TOOL_EXPOSURE_CEILING`) 일 때만 동작한다. 설치/삭제만 있던 플러그인에 활성/비활성 상태를 도입했고(비활성 플러그인은 로드 유지·모델 노출만 차단·실행은 어댑터에서 fail-closed, sub-agent 경로 포함), 세션 TO-DO 의 no-op 재마킹 루프(이미 in_progress 인 항목 반복 갱신)를 차단하고 같은-메시지 도구 호출 순서를 결정적으로 보장한다.
- **TPM 429 bounded auto-compact 복구** (PR #1178) — provider diagnostics 가 `rate_limit_exceeded` 를 tokens-per-minute(TPM) 실패로 식별하면 대화를 1회 자동 압축해 라운드당 요청 크기를 줄여 복구한다. RPM(요청/분) 한도는 정상 에러 경로를 유지하고, 에러 시리즈당 1회 + clean turn 후에만 re-arm 하는 가드로 반복 429 가 compact 를 증폭하지 못하게 막는다.
- **gpt-5.4-mini TPM-aware preflight** (PR #1174) — `gpt-5.4-mini` 의 `tpmDefault=200K` 를 등록해 preflight 압축 판단이 TPM 한도를 인지하도록 했다.
- **Intra-turn tool-result stubbing** (PR #1172) — tool-call 라운드 사이에 직전 tool result 를 stub 으로 치환해 결과-heavy 턴의 누적 입력 토큰을 줄인다.

### 스트리밍 / 렌더링

- **스트림 종료 후 최종 답변 안정화** (PR #1173) — 스트림 closure 이후 final answer 가 흔들리지 않도록 고정하고, provider stream 실패를 request diagnostics 로 노출한다. 대용량 히스토리에서 streaming 중 render boundary / latency 회귀 가드를 추가했다.

### 개발 도구

- **dev 전용 system-prompt per-source 크기 계측** (PR #1175) — `LVIS_DEV_PROMPT_SOURCE_DUMP` 로 12-source 프롬프트의 소스별 토큰 크기를 측정한다.

### 검증

- PR #1177: 3-agent cluster review GO (architect/critic/security, MAJOR 0), `bun run typecheck`/`build`, plugins/boot 843 + 전체 스위트 6194 pass.
- PR #1178: engine/renderer/coverage multi-agent review, focused Vitest + 470 files / 6200 pass, `bun run typecheck`/`build`, CI CLEAN.

---

## v0.2.10 — 2026-05-25

### 안정성 / 모델 도구 노출

- **Tool-level deferral 기본 경로 정착** (PR #1147) — plugin activation 을 catalog scope 로 유지하고, provider-visible tool schema 는 keyword preload / `tool_search` promotion / carry-forward / 고정 allowlist 로만 노출한다. broad promotion 은 scoring/top-N 으로 제한해 TPM burst 와 불필요한 tool schema 노출을 줄였다.
- **Tool provenance source-aware 정렬** (PR #1153) — `builtin`, `plugin:<id>`, `mcp:<id>` 출처를 ToolRegistry, prompt catalog, execution metadata, IPC, trace/audit, ToolGroupCard UI까지 유지한다. cross-owner tool-name collision 은 fail-closed 처리하고, builtin tool inventory 질문에서는 직전 plugin/MCP carry-forward 를 reset 해 plugin tool 이 builtin 처럼 답변되는 경로를 차단했다.
- **OpenAI/Azure Responses `tool_search` wire alias 정렬** (PR #1149/#1150) — LVIS 내부 `tool_search` 와 provider built-in `tool_search_call` 충돌을 `lvis_tool_search` wire alias 로 분리하고, persisted history / tool result / display text 는 사용자에게 다시 `tool_search` 로 복원한다.

### UX / 컨텍스트

- **Persona prompt store 전환** (PR #1148) — main composer assistant-context 버튼을 Persona 전용으로 정리하고, role/persona prompts 를 file-backed `~/.lvis/prompts/*.md` + seeded resources SOT 로 이동했다.
- **Session TO-DO turn boundary 정렬** (PR #1152) — 세션 TO-DO 를 current-turn transient plan 으로 고정해 새 사용자 턴 시작 시 이전 plan 이 남지 않도록 하고, live push race 와 badge 상태를 정리했다.
- **Chat streaming scroll jitter 수정** (PR #1151) — streaming 중 bottom-follow 를 rAF coalesced immediate pin 으로 통합해 긴 응답에서 smooth scroll 반복으로 viewport 가 흔들리는 문제를 제거했다.

### 컨텍스트 예산 / E2E 안정화

- **Projected next-turn input SOT** (PR #1142/#1143) — context budget ring 과 compact 판단을 next-turn projected input 기준으로 재정렬하고, tool-result carryover / input-output split / TPM banner e2e coverage 를 보강했다.
- **Linux-headless onboarding/e2e 격리 보강** (PR #1143/#1146) — Electron e2e fixture 의 onboarding state, marketplace/update bootstrap, memory seed flow 를 실제 first-boot chain 과 맞췄다.

### 검증

- PR #1153: focused provenance suites, `ToolGroupCard`, `permission-review-scenario-board`, `bun run check:test-quality` 458 files / 6041 pass / 13 skipped with coverage gates, `bun run typecheck`, `bun run build`, remote build-and-test / Windows permission path / CodeQL / naming / cluster success, Copilot inline comments 0.
- PR #1147/#1148/#1149/#1150/#1151/#1152: targeted Vitest/Playwright lanes, typecheck/build, remote CI success.

---

## v0.2.9 — 2026-05-22

### 안정성 / 컨텍스트

- **50-message auto compact 제거** (PR #1097) — auto compact 는 고정 메시지 개수 대신 token pressure 또는 명시적 context-error recovery 로만 동작한다. 불필요한 중간 compact 로 thinking/tool-result 흐름이 끊기는 상황을 줄였다.

### 테스트 / 품질 게이트

- **테스트 helper SOT 정리** (PR #1095) — renderer, plugins, hooks, prompts, permissions, IPC, Vercel LLM adapter, conversation-loop 테스트의 반복 fixture/helper 를 공통 helper 로 이관했다.
- **중복 helper detector 추가** (PR #1095) — AST 기반 `scripts/check-test-duplicates.mjs` 로 test/support 경로의 duplicate helper body, 같은 파일 내부 duplicate, generic `setup`/`fixture`/`mock` substantial body 를 CI에서 검출한다.
- **Coverage area gate 추가** (PR #1095) — `@vitest/coverage-v8` 기반 `scripts/check-test-coverage.mjs` 와 `check:test-quality` 로 total/engine/permissions/plugins/ipc/renderer/main/boot/tools/mcp 영역별 회귀를 잡는다.
- **Coverage wrapper 안정화** (PR #1095) — coverage report 는 임시 디렉터리에서 생성 후 cleanup 하며, Windows 에서 shell 기반 argv handling 없이 `bun.exe` 를 직접 실행한다.

### 검증

- PR #1097: focused Vitest 2 files / 16 pass, `bun run typecheck`, `git diff --check`, remote CI success.
- PR #1095: `bun run check:test-quality` 445 files / 5865 pass / 13 skipped, duplicate scanned files 515 / duplicate helper implementations 0, coverage gates pass, `bun run typecheck`, `bun run build`, remote CI success, inline comments 0.

---

## v0.2.8 — 2026-05-22

### 안정성 / 네트워크

- **Sub-agent Azure Foundry private endpoint 정렬** (PR #1083) — `agent_spawn` 으로 생성된 child conversation loop 도 parent 와 같은 guarded Electron `net.fetch` 기반 LLM fetch 를 상속해 public Azure endpoint 로 우회하지 않도록 했다.
- **macOS 프록시/PAC 환경 private endpoint 고정** — demo host-map 에 포함된 Azure Foundry LLM/web_fetch URL 은 전용 Electron session 을 `direct` proxy mode 로 사용해 시스템 프록시/PAC 가 Chromium host resolver mapping 을 우회하지 못하게 했다.
- **Builtin internet tools resolver 정렬** (PR #1089) — `web_search` / `web_fetch` 같은 builtin network tools 도 Electron `net.fetch` 를 주입받아 demo host resolver/private endpoint mapping 을 공유한다.
- **Demo host-map mapped `web_fetch` 승인 경계 보강** (PR #1089) — demo host map 에 의해 private endpoint 로 해석되는 URL 은 public DNS 상 public IP 로 보이더라도 private-network approval category/cache key 를 사용한다.
- **LLM/Marketplace combined health 안정화** (PR #1083) — background refresh 중 상태가 `online → checking → online` 으로 깜빡이지 않도록 마지막 concrete 상태를 유지한다.

### 개발 / 패키징

- **Dev/start launch SOT 통합** (PR #1081/#1089) — `bun run dev`, `bun run start`, packaged smoke, Windows NSIS smoke 가 같은 Electron launch env/arg helper 를 사용한다. `.env.demo`, Windows-safe GPU flags, `--no-sandbox`, `--user-data-dir`, UTF-8 env, `LVIS_WIN_NO_SANDBOX` 정책이 한 경로에서 적용된다.
- **Package footprint guard 정렬** (PR #1089) — runtime script packaging checks 를 `BUILD_ASSETS` SOT 에서 파생해 dev/build/watch 자산 목록과 drift 나지 않도록 했다.
- **Sequential status toast 안정화** (PR #1081) — install/update toast burst 에서 뒤쪽 toast 가 앞쪽 toast 만료 시간 때문에 즉시 사라지는 queue expiry 문제를 수정했다.

### 검증

- PR #1081: focused `useStatusBar` Vitest 23 pass, repeated focused run 5/5 pass, targeted Vitest 5 files / 73 pass, `bun run typecheck`, `bun run build`.
- PR #1083: focused Vitest 4 files / 42 pass, `bun run typecheck`, `bun run build`, `git diff --check`.
- PR #1089: launcher/package `node --check`, electron launch helper node tests 7 pass, focused host-resolver/web-fetch/launch Vitest 4 files / 47 pass, full Vitest 443 files / 5841 pass / 13 skipped, `bun run typecheck`, `bun run build`, remote CI success, cluster review Critical=0/Major=0.
- macOS 프록시/PAC private endpoint fix: focused Vitest 5 files / 93 pass, `bun run typecheck`, `bun run build`, full Vitest 443 files / 5849 pass / 13 skipped, Electron direct-session probe `200` vs system proxy path `403 ThrowExceptionDueToTrafficDenied`.

---

## v0.2.7 — 2026-05-22

### 안정성 / 패키징

- **Windows uninstall 실제 삭제 검증** (PR #1080) — NSIS uninstall 이 확인 다이얼로그 후 조용히 종료되는 대신 설치 폴더와 핵심 앱 파일 잔존 여부를 검증한다. 삭제 실패 시 실패 exit/error 로 보고하고, GUI uninstall 은 관리자 권한 재시도 1회만 제공한다.
- **사용자 데이터 보존 경로 유지** (PR #1080) — `/KEEP_APP_DATA` 와 update uninstall (`--updated`) 경로는 기존처럼 사용자 데이터를 삭제하지 않으며, 관리자 권한 재시도도 앱 파일 제거 범위로 제한한다.
- **Windows installer smoke 확장** (PR #1080) — Windows setup.exe smoke 가 silent install, installed app launch, `/S /KEEP_APP_DATA` uninstall, full `/S` uninstall, 설치 폴더 제거, user data cleanup 을 disposable Windows runner 에서 검증한다.

### 배포

- `latest` release 에 Windows/macOS/Linux versioned installer 와 stable `LVIS-latest-*` alias asset 을 함께 포함한다.

### 검증

- PR #1080: focused desktop packaging Vitest 6 pass, `bun run typecheck`, `bun run build`, remote CI success.
- Build Installers run `26239492691`: Windows NSIS smoke verified `/S /KEEP_APP_DATA` and full `/S` uninstall both remove the install directory; full uninstall removes LVIS user data paths.

---

## v0.2.6 — 2026-05-21

### 개선

- **도구 입력/출력 pretty JSON 표시** (PR #1075) — 일반 도구 카드와 compacted/verbatim 원문 확장 UI 가 공통 payload formatter 를 사용해 JSON 입력/출력을 보기 쉬운 pretty JSON 으로 표시한다.
- **Azure Foundry private endpoint LLM fetch 정렬** (PR #1077) — packaged build 의 Azure Foundry SDK 호출이 Electron `net.fetch` 기반 safe fetch 를 사용해 Chromium host resolver/private endpoint mapping 을 공유한다. 적용 범위는 검증된 Azure Foundry HTTPS host 로 제한하고, non-Azure provider 는 기존 fetch 경로를 유지한다.

### 안정성 / 패키징

- **Windows NSIS installer smoke 추가** (PR #1075/#1076) — Build Installers Windows job 이 `win-unpacked` 실행뿐 아니라 setup.exe silent install, installed `LVIS.exe` launch, silent uninstall 을 검증한다.
- **Windows update uninstall 데이터 보존** (PR #1075) — update uninstall 경로의 `${isUpdated}` / `/KEEP_APP_DATA` / `--updated` 신호를 custom NSIS uninstall hook 이 존중해 사용자 데이터를 보존한다.
- **Windows smoke cleanup race 안정화** (PR #1076) — Chromium temp cleanup EBUSY 와 NSIS uninstall 완료 직후 파일 제거 race 를 smoke 실패로 오인하지 않도록 외부 cleanup 경계를 기다리거나 best-effort 로 처리한다.

### 검증

- PR #1075: focused ToolGroupCard/CompactedToolResult Vitest 2 files / 41 pass, `bun run typecheck`, `bun run build:renderer`, remote CI success.
- PR #1076: PR CI success, Build Installers PR-head run success across macOS/Linux/Windows including Windows NSIS install/launch/uninstall smoke.
- PR #1077: safe LLM fetch / provider fetch injection focused Vitest, `bun run typecheck`, `bun run build`, remote CI success.

---

## v0.2.5 — 2026-05-21

### 개선

- **Local Indexer update lifecycle 정렬** (PR #1073) — Marketplace update button 과 `lvis://` install path 가 공통 lifecycle helper 를 사용한다. catalog/runtime 에서 기존 설치 상태를 확인한 뒤 artifact patch 전에 실행 중인 플러그인을 먼저 중지하고, install/start 실패 시 기존 runtime 또는 이전 artifact 로 복구한다.
- **마켓플레이스 플러그인 업데이트 확인 주기 단축** (PR #1073) — 기본 update check interval 을 6시간에서 10분으로 낮춰 managed plugin 업데이트가 더 빨리 노출되도록 했다.
- **플러그인 준비 상태 표시 보강** (PR #1071) — host-managed Python 플러그인의 `preparing` 단계가 설정 패널, 플러그인 목록, 메인 플러그인 그리드에 유지 표시된다. Local Indexer 처럼 로드 전 준비 중인 플러그인도 placeholder 상태로 드러난다.
- **Azure Foundry reasoning 노출** (PR #1072) — Azure Foundry 응답의 reasoning/thinking 정보를 visible transcript 흐름에 맞춰 표시한다.

### 안정성

- **Python dependency sync 출력 억제** (PR #1071) — `uv pip sync` 의 대량 stderr 다운로드 로그는 tail 만 보존하고 UI thread 를 압박하지 않도록 조정했다. 프로세스는 기존대로 분리 실행되며 progress event 만 렌더러로 전달한다.
- **Marketplace health probe 안정화** (PR #1070) — 정상 marketplace 에서 status ping abort WARN 이 반복되지 않도록 timeout, in-flight coalescing, cache, stale-generation discard 를 정렬했다.
- **rollback metadata 보존** (PR #1073) — prior-version rollback 은 최신 catalog SHA 와 비교하지 않고 설치 당시 registry snapshot / bundle metadata 를 사용해 admin install source 와 artifact metadata 를 보존한다.

### 검증

- PR #1070: focused Vitest 2 files / 37 pass, `bun run typecheck`, `bun run build`, remote CI success.
- PR #1071: focused PluginRuntime / PluginCard / PluginConfigTab / PluginGridButton suites 95 pass, `bun run typecheck`, `bun run build`.
- PR #1072: remote CI success.
- PR #1073: focused lifecycle/marketplace suites 117 pass, update interval source regression 1 pass, `bun run typecheck`, `bun run build`, remote CI success, Copilot inline comments 0.

---

## v0.2.4 — 2026-05-21

### 신규 기능

- **render_html 전용 preview window** (PR #1063) — 채팅 inline webview 대신 별도 sandboxed BrowserWindow 에서 HTML 결과를 열도록 전환. 저장 세션 replay 는 inert launcher 로 유지하고, 새로 완료된 `render_html` 결과만 1회 자동 open.
- **preview window 내부 JavaScript 제어** (PR #1066) — JavaScript 허용/차단 토글을 채팅 카드가 아니라 실제 preview window toolbar 로 이동. preview shell 은 LVIS theme token 을 주입하고, tool description 도 `hsl(var(--background))` / `foreground` / `primary` / `muted` / `border` 기반 디자인을 권장하도록 정렬.

### 개선

- **plugin surface directory grant 정렬** (PR #1065) — plugin UI shell, preload, renderer resource 접근 경계를 최신 permission policy 에 맞춰 보강.
- **설정 권한 목록 scroll 안정화** (PR #1064) — Settings → 권한 → 허용 디렉터리 삭제 후 스크롤 위치가 상단으로 튀지 않도록 삭제 전후 scrollTop 을 보존.
- **toolbar help hint 정리** (PR #1063) — 상단 toolbar 의 `⌘ + ?` help hint pill 과 stale first-boot tour anchor 를 제거해 현재 onboarding flow 와 맞춤.

### 보안 / 안정성

- `render_html` preview 는 기존 `lvis-render-html` network-deny partition, CSP-first document, isolated renderer boundary 를 유지.
- preview IPC / preload / renderer 회귀 테스트로 arbitrary HTML 이 Node, app preload API, unrestricted network 에 접근하지 못하도록 고정.
- stale `fix/html-render-open-window*` 로컬 worktree/branch 는 최신 main 의 #1063/#1066 구현보다 오래된 축소판임을 확인하고 제거했다.

### 검증

- PR #1063: focused Vitest 6 files / 86 pass, `bun run typecheck`, `bun run build`, remote CI `build-and-test` / CodeQL success.
- PR #1064: focused PermissionsTab Vitest 3 files / 27 pass / 1 skipped, `bun run typecheck`.
- PR #1066: focused Vitest 4 files / 60 pass, `bun run typecheck`, `bun run build`.

---

## v0.2.3 — 2026-05-20

### 신규 기능

- **저장 세션 보존 및 채팅 목록 로드 wiring** — hamburger memory tab 의 채팅 목록 row 를 실제 session load 로 연결하고, detached memory view 에서도 main window 로 세션을 열 수 있게 했다.
- **LLM 기본 모델 dropdown** — 텍스트 입력 기반 모델 설정을 provider별 default dropdown 으로 정렬.
- **설정 logout + demo re-activation entrypoint** — 설정에서 logout / demo 재활성화 흐름을 직접 진입할 수 있게 했다.

### 개선

- **chat transcript replay SOT 정렬** — 재시작 후 history replay 가 proactive envelope, skill-routed user text, tool result display, system notice, turn summary 를 live streaming 과 같은 projection contract 로 복원.
- **token preflight over-count 수정** — 자동 compact preflight 가 세션 누적 input token 이 아니라 최근 provider-reported raw prompt size 와 wire serialization 기준 estimate 를 사용하도록 정렬.
- **TokenProgressRing denominator 수정** — Azure Foundry deployment id 가 OpenAI 모델명과 일치하면 OpenAI catalog context window 를 상속해 `gpt-5.4-mini` usable budget 이 `98,000` 대신 `360,000` 으로 계산.
- **token ring tooltip 상단 상세화** — 비용 예측 tooltip 과 같은 상단 hover 패턴으로 context used / limit / remaining / usage / TPM 정보를 표시.
- **plugin install progress alias 정리** — 요청 slug 와 canonical plugin id 사이 install progress ghost 를 제거하고 plugin cell alias 로 같은 셀에 진행 상태를 표시.

### 안정성 / 패키징

- **plugin dependency lifecycle runtime setup** — host boot 에서 plugin Python dependency sync 를 직접 수행하지 않고 plugin runtime prepare/start 경계로 이동.
- **demo activation relaunch continuity** — dev runner 재시작, host demo status IPC, Foundry endpoint 검증을 통해 첫 활성화 후 relaunch 상태 보존.
- **atomic release publish workflow** — tag build artifact 를 single publish job 으로 모아 GitHub Release asset partial upload race 를 제거.
- **uv runtime packaging hardening** — packaged uv materialization, license notice, package footprint gate 를 보강.

### 검증

- 주요 focused suites: chat/session replay, auto-compact/context-budget/pricing, plugin runtime/install lifecycle, demo activation, status bar, token ring.
- `bun run typecheck`, `bun run build`, macOS package footprint, remote CI / CodeQL / cluster-detector success.

---

## v0.2.2 — 2026-05-20

### 신규 기능

- **Onboarding UX 전체 재설계** (PR #1044) — 4 단계 forced-choice + memory-first flow + ping-aware welcome.
  - **ScenarioShowcase**: 시연 footer 의 "이런 식으로 동작해요" 라인 제거. 버튼 `로그인하에 LVIS 시작하기` / `뒤로가기`. 4 카드 grid 에서 skip/건너뛰기 제거 — 사용자가 *반드시 카드 선택*.
  - **LoginModalConversational**: 1/2/3 chip 화면의 취소 + Esc/outside dismissal 제거 (forced choice). 데모 자격증명 (chip 1) 클릭 시 *fullscreen 새 page* 로 transition — 상단 `← 뒤로가기` + 활성코드 입력 + 모든 취소 버튼 제거.
  - **Chain restructure**: `welcome` stage 폐지, `personalized_welcome` 신설 (memory 다음, tour 이전). MemorySeedDialog 가 LoginModal 직후 바로 등장 → PersonalizedWelcome → tour 순서.
  - **PersonalizedWelcome** (신규 component): 호칭/자기소개 반영 인사 + `api.pingAiProvider()` 로 LLM 연결 확인 + latency 표시. 확인 버튼만 (skip 없음).
  - **SpotlightTour**: ⌘+? 도움말 step 을 #4 → 마지막 #8 위치로 이동.
  - **PluginShowcase**: `둘러보기 →` → inline `펼쳐보기 ↓` expansion. 외부 navigation 제거 — 스폿라이트 2 노출 버그 인식 해소.

### Internal

- **Demo activation: `LVIS_DEMO_ENABLED` 환경변수 폐기** (PR #1040). `captureDemoCredentials()` 가 `LVIS_DEMO_KEY_<VENDOR>` 의 존재만으로 demo 활성을 판정 — activation code (수동 발급) 자체가 유일한 gate. master gate env var 가 누락된 `.env.demo` 가 demo activation 후에도 `isDemoEnabled()=false` 로 떨어지면서 onboarding chain 이 skip → ChatView empty-state 로 떨어지던 SOT divergence 해소. `whitelist-registry` 의 demo snapshot 분기도 `useDemoSnapshot` 옵션만 read — env fallback 제거.
- **Release process 문서화** (PR #1037). `docs/development/release-process.md` SOT + `CLAUDE.md` 의 Release Process section. branch+PR flow / partial asset recovery / intentional limits (Mac arm64 only, electron-builder publish race).

### 사용자 영향

- *진짜 zero-touch demo experience*: activation code 한 줄 → 자동 relaunch → 두 번째 boot fully active. 환경변수 export / `.env.demo` 수동 편집 / 터미널 사용 *완전 불필요*.
- Forced-choice onboarding: 매 화면 1-3 옵션 중 선택. 사용자가 *어디서 막힐 지* 명확.

---

## v0.2.1 — 2026-05-19 (hotfix)

### Critical fix

- **loginMockup IPC 일관 error handling** — Step 2/3 (`llm-key-issuing`/`sandbox-preparing`) 의 unhandled throw 가 IPC reject 로 leak 되어 "로그인 처리 중 오류" 발생하던 회귀 해소. 모든 step 의 try/catch 일관 + 결정적 error code 반환.
- **First-activation host-resolver race** — packaged build 에서 첫 activation 시 Chromium net stack 이 frozen (command-line frozen after `app.whenReady()`). activation 성공 후 자동 `app.relaunch()` 추가 — 다음 boot 의 `loadPersistedDemoActivationSync()` + `applyDemoHostResolverRules()` 시점 매핑 활성.
- **Main process console logging 강화** — `~/Library/Logs/LVIS/main.log` (macOS) / `%APPDATA%\LVIS\logs\main.log` (Windows) 에 stack trace 기록. 진단 가능.
- 새 error code: `llm-key-issuing-failed` / `reviewer-rewire-failed` / `endpoint-unreachable` / `requires-relaunch` — 사용자 친화 한국어 메시지 매핑.

### Internal

- ULTRATHINK 4-agent 진단 (tracer / debugger / critic / verifier) 으로 root cause 확정. PR #1031.

---

## v0.2.0 — 2026-05-19

### 신규 기능

- **Interactive Onboarding Chain** — 첫 부팅 사용자 흐름 재설계. FSM reducer 기반: `ScenarioShowcase → LoginModal → WelcomeQuestion → MemorySeed → SpotlightTour (8-step) → PluginShowcase → 첫 chat`.
- **Interactive ScenarioShowcase (Option A)** — 4 시나리오 카드. 카드 클릭 시 inline demoAutoplay turn 시연.
- **LoginModal Conversational** — chat-style 인증 UX. chip 3개.
- **Demo Activation Code 시스템** — AES-256-GCM 한 줄 code → `.env.demo` 자동 unpack.
- **Memory Seed Wizard** — 호칭 + 자기소개 → MEMORY.md 영구 저장.
- **SpotlightTour 8-step** — composer/도구/⌘K/⌘?/history/Settings/status bar/plugin entry.
- **TutorialDialog (Discovery Swipe)** — 5장 카드 swipe.
- **Live Auto-play 시스템** — scripted-turn engine (returning user 만 활성).
- **PluginShowcase** — Tour 종료 후 plugin 별 설명.
- **Settings → 일반 tab** — 계정 + 워크스페이스 통계 + 시스템/기반 기술 stack.
- **Settings → 마켓플레이스 tab 재구성** — primary CTA + 고급 옵션 collapsed.
- **Status bar 재설계** — marketplace dot + vendor/model 표시.

### 개선

- Onboarding pace + animation, Boot splash 우하단 stack, App 버전 SoT 정정, Demo 모드 host-resolver-rules, Cross-platform 정합, work-proactive → work-assistant rename, uv CI cache.

### 버그 fix

- LoginModal race / ScenarioShowcase closet-flash / DemoAutoplay chain 종료 / SpotlightTour 2번 노출 / "로그인된 척" race / Activation 자동 advance.

### 보안

- AES-256-GCM, IPC sender frame validation, 0o600/0o700 permissions, audit prefix + rate-limit.

### Internal

- 30+ PR merged dev → main (PR #1028). 4-agent ralph review 완료.

---

## #893 — login-and-secret-allowlist

### M1 — perm-revoke → bearer-abort wiring

- `PermissionManager` now owns per-plugin `AbortController`s and exposes
  `getPluginRevokeSignal(pluginId)` + `revokePluginAccess(pluginId, reason)`.
- The three persisted-mutation entry points (`addAlwaysAllowedPersist`,
  `addAlwaysDeniedPersist`, `removeRule`) call `revokeAllPluginAccess(...)`
  after their broadcast so outstanding `hostApi.resolveApiKey` bearers are
  aborted on any rule change.
- `resolve-api-key.ts` accepts a `getPluginRevokeSignal` dep and merges it
  with the caller's request signal via `AbortSignal.any` so the returned
  bearer's `release()` fires on whichever signal aborts first.
- Boot wiring threads the live `PermissionManager` into `initPluginRuntime`
  → per-plugin `resolveApiKey` host implementation.

Before this change, `broadcastConfigChanged` notified the renderer config tab
but did NOT signal aborting plugins' in-flight bearers. The `release()`
listener inside `resolve-api-key.ts` was dead weight because no upstream
caller wired the controller. A plugin that captured the bearer in a closure
could continue calling the upstream provider after the user revoked access.

### M2 — demo snapshot expiry documented

- `marketplace-whitelist.demo.json` retains `expiresAt: 2030-01-01` AS-IS.
  This is INTENTIONAL — kiosk / trade-show machines run the bundled snapshot
  for the lifetime of the signed app binary, so a short expiry would brick
  long offline deployments.
- Production catalog (live `lvis-project/marketplace-whitelist` repo) uses
  a rolling 90-day expiry and is fetched + verified at boot via
  `whitelist-fetcher.ts`. The demo path is gated behind
  `LVIS_DEMO_ENABLED=1` so production builds never load the demo snapshot.
- Comment header added near the demo-snapshot loader in
  `src/plugins/whitelist/whitelist-registry.ts` documenting the policy.

### Optional — whitelist-bootstrap shutdown signal

- `wireWhitelistRegistry` accepts an optional `appShutdownSignal: AbortSignal`
  that is threaded through to the whitelist fetch so app-quit during a slow
  CDN response unblocks boot/shutdown without waiting up to 10s for the HTTP
  timeout.
