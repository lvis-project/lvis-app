#!/usr/bin/env bash
# Copy Korean-named screenshots from ~/Downloads/스크린샷 to public/screenshots/ with ASCII slugs.
set -euo pipefail

SRC="${HOME}/Downloads/스크린샷"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/screenshots"
mkdir -p "$DEST"

declare -A MAP=(
  # chat
  ["채팅-TODO,메세지큐.png"]="chat-todo-queue.png"
  ["채팅-tool,thinking.png"]="chat-tool-thinking.png"
  ["채팅-권한-llm자율검토.png"]="chat-permission-llm-review.png"
  ["채팅-권한-디렉토리.png"]="chat-permission-directory.png"
  ["채팅-권한-위험관리.png"]="chat-permission-risk.png"
  ["채팅-앱업데이트.png"]="chat-app-update.png"
  ["채팅-질문카드.png"]="chat-question-card.png"
  ["채팅-플러그인.png"]="chat-plugin-panel.png"
  # plugin common
  ["플러그인-권한허용.png"]="plugin-permission-grant.png"
  # local-indexer
  ["플러그인-로컬인덱서-기본화면.png"]="local-indexer-home.png"
  ["플러그인-로컬인덱서-인덱싱.png"]="local-indexer-indexing.png"
  ["플러그인-로컬인덱서-폴더추가.png"]="local-indexer-add-folder.png"
  # outlook / ms-graph
  ["플러그인_아웃룩-로그인.png"]="outlook-login-trigger.png"
  ["플러그인-아웃룩-로그인창.png"]="outlook-login-window.png"
  ["플러그인-아웃룩-로그인2.png"]="outlook-login-after.png"
  ["플러그인-아웃룩-로그아웃.png"]="outlook-logout.png"
  # meeting
  ["플러그인_미팅_녹음.png"]="meeting-record.png"
  ["플러그인_미팅_녹음2.png"]="meeting-record-stt.png"
  # work-assistant
  ["플러그인-업무도우미-일정겹침.png"]="work-assistant-conflict.png"
  ["플러그인-업무도우미-일정겹침2.png"]="work-assistant-conflict-2.png"
  ["플러그인-업무도우미-일정알림.png"]="work-assistant-reminder.png"
  ["플러그인-업무도우미-일정알림2.png"]="work-assistant-reminder-2.png"
  ["플러그인_워크어시스턴트-미팅종료_트리거.png"]="work-assistant-meeting-end-trigger.png"
  ["플러그인_워크어시스턴트-미팅종료_트리거2.png"]="work-assistant-meeting-end-trigger-2.png"
  # lge-api (이피)
  ["플러그인-이피-로그인.png"]="ep-login.png"
  ["플러그인-이피-근태.png"]="ep-attendance.png"
  ["플러그인-이피-근태2.png"]="ep-attendance-2.png"
  ["플러그인-이피-근태3.png"]="ep-attendance-3.png"
  ["플러그인-이피-결재.png"]="ep-approval.png"
  ["플러그인-이피-주차.png"]="ep-parking.png"
  ["플러그인-이피-회의실.png"]="ep-meeting-room.png"
  ["플러그인-이피-회의실2.png"]="ep-meeting-room-2.png"
  ["플러그인-이피-회의실3.png"]="ep-meeting-room-3.png"
  ["플러그인-이피-회의실4.png"]="ep-meeting-room-4.png"
  ["플러그인-이피-회의실5.png"]="ep-meeting-room-5.png"
  ["플러그인-이피-화상회의.png"]="ep-video-call.png"
  ["플러그인-이피-화상회의2.png"]="ep-video-call-2.png"
  ["플러그인-이피-화상회의3.png"]="ep-video-call-3.png"
  ["플러그인-이피-화상회의4.png"]="ep-video-call-4.png"
  ["플러그인-이피-lgenie.png"]="ep-lgenie.png"
  ["플러그인-이피-lgenie2.png"]="ep-lgenie-2.png"
  # agent-hub plugin
  ["플러그인_에이전트허브-마이워크.png"]="agent-hub-my-work.png"
  ["플러그인_에이전트허브-팀보드.png"]="agent-hub-team-board.png"
  # marketplace server
  ["서버-마켓플레이스-로그인.png"]="mp-login.png"
  ["서버-마켓플레이스-플러그인.png"]="mp-plugin.png"
  ["서버-마켓플레이스-agents.png"]="mp-agents.png"
  ["서버-마켓플레이스-mcp.png"]="mp-mcp.png"
  ["서버-마켓플레이스-skills.png"]="mp-skills.png"
  ["서버-마켓플레이스-퍼블리셔.png"]="mp-publisher.png"
  ["서버-마켓플레이스-퍼블리셔2.png"]="mp-publisher-2.png"
  ["서버-마켓플레이스-어드민.png"]="mp-admin.png"
  ["서버-마켓플레이스-어드민2.png"]="mp-admin-2.png"
  ["서버-마켓플레이스-어드민3.png"]="mp-admin-3.png"
  ["서버-마켓플레이스-어드민4.png"]="mp-admin-4.png"
  ["서버-마켓플레이스-어드민5.png"]="mp-admin-5.png"
  # agent-hub server
  ["서버-에이전트허브-대시보드.png"]="ah-dashboard.png"
  ["서버-에이전트허브-워크보드.png"]="ah-workboard.png"
  ["서버-에이전트허브-워크로그.png"]="ah-worklog.png"
  ["서버-에이전트허브-인박스.png"]="ah-inbox.png"
  ["서버-에이전트허브-리포트.png"]="ah-report.png"
  ["서버-에이전트허브-구독관리.png"]="ah-subscription.png"
)

OK=0
MISS=0
for src in "${!MAP[@]}"; do
  if [[ -f "$SRC/$src" ]]; then
    cp "$SRC/$src" "$DEST/${MAP[$src]}"
    OK=$((OK+1))
  else
    echo "MISSING: $src" >&2
    MISS=$((MISS+1))
  fi
done

echo "copied=$OK missing=$MISS dest=$DEST"
