// AUTO-GENERATED — i18n migration. Source: src/tools/skill-load.ts. Do not edit by hand.
export const en = {
  "be_skillLoad.toolDescription":
    "Loads a skill body by name (after approval) and injects it only into subsequent rounds of the current user turn. " +
    "Skills are located at ~/.lvis/skills/<name>/SKILL.md or ~/.lvis/skills/<name>.md (YAML frontmatter + markdown). " +
    "User skills loaded for the first time require user approval, which is persisted permanently. " +
    "On success returns { loaded: true, skillName, summary }.",
  "be_skillLoad.skillNameDescription":
    "The skill name to load (must match the file/directory name and the frontmatter name field).",
  "be_skillLoad.argsDescription":
    "Parameters to pass to the skill (current version treats these as simple metadata). Optional.",
  "be_skillLoad.approvalReason":
    "Injects skill '{name}' body only into subsequent rounds of the current user turn. The approval record is stored permanently and bound to the current body's sha256 — if the body changes, confirmation is requested again.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_skillLoad.toolDescription":
    "이름으로 skill body 를 승인 후 현재 사용자 턴의 후속 라운드에만 주입합니다. " +
    "Skill 은 ~/.lvis/skills/<name>/SKILL.md 또는 ~/.lvis/skills/<name>.md (YAML frontmatter + markdown). " +
    "처음 로드되는 user skill 은 사용자 승인을 요구하며, 승인은 영구 저장됩니다. " +
    "성공 시 { loaded: true, skillName, summary } 반환.",
  "be_skillLoad.skillNameDescription":
    "로드할 skill 이름 (파일/디렉터리명과 frontmatter name 이 일치해야 함).",
  "be_skillLoad.argsDescription":
    "skill 에 전달할 파라미터 (현재 버전은 단순 메타데이터). 선택.",
  "be_skillLoad.approvalReason":
    "skill '{name}' body 를 현재 사용자 턴의 후속 라운드에만 주입합니다. 승인 기록은 영구 저장되며 현재 본문 sha256 에 바인딩됩니다 — 본문이 변경되면 다시 확인합니다.",
};
