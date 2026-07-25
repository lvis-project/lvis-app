// AUTO-GENERATED — i18n migration. Source: src/tools/skill-read.ts. Do not edit by hand.
export const en = {
  "be_skillRead.toolDescription":
    "Reads ONE bundled resource file of a skill that is already loaded in the current user turn. " +
    "A loaded skill lists its bundled files (references/, assets/, …) in its overlay; call this to fetch one on demand " +
    "instead of carrying the whole bundle in the prompt. " +
    "Call skill_load first — an unloaded skill cannot be read. Returns { skillName, path, content, bytes }.",
  "be_skillRead.skillNameDescription":
    "Name of the already-loaded skill that owns the resource (same name passed to skill_load).",
  "be_skillRead.resourcePathDescription":
    "Skill-root-relative path of the bundled file, exactly as listed in the skill's resource manifest (for example references/api.md).",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_skillRead.toolDescription":
    "현재 사용자 턴에 이미 로드된 skill 의 번들 리소스 파일 하나를 읽습니다. " +
    "로드된 skill 은 오버레이에 번들 파일 목록(references/, assets/ 등)을 표시하며, 번들 전체를 프롬프트에 싣는 대신 필요할 때 이 도구로 하나씩 가져옵니다. " +
    "먼저 skill_load 를 호출해야 합니다 — 로드되지 않은 skill 은 읽을 수 없습니다. { skillName, path, content, bytes } 를 반환합니다.",
  "be_skillRead.skillNameDescription":
    "리소스를 소유한, 이미 로드된 skill 의 이름(skill_load 에 전달한 이름과 동일).",
  "be_skillRead.resourcePathDescription":
    "skill 루트 기준 상대 경로. skill 의 리소스 목록에 표시된 그대로 사용하세요(예: references/api.md).",
};
