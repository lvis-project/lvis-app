/**
 * Built-in skills shipped inline with the host. Distinct from user-authored
 * skills under `~/.lvis/skills/`. Bundled as TS so the build pipeline does
 * not need to copy markdown into `dist/`.
 *
 * Each entry is rendered through {@link parseFrontmatter} the same way a
 * user file would be, so the contract stays consistent.
 */
import type { LoadedSkill } from "./skill-store.js";

export const BUILTIN_SKILLS: LoadedSkill[] = [
  {
    name: "report-writing",
    description:
      "Structured business-report writing skill — situation, action, result, recommendation",
    triggers: ["report", "리포트", "보고서", "summary", "결산"],
    source: "builtin",
    filePath: "<builtin>:report-writing",
    body: `# Report Writing Skill

When the user asks for a business-style report or summary, structure your
response with the four-part SARR template:

1. **Situation** — Set the context in 1–2 sentences. What happened, who was
   involved, and over what window?
2. **Action** — List the concrete steps that were taken (or that are being
   recommended), bullet-pointed for scannability.
3. **Result** — Quantify the outcome where possible. Pull metrics from any
   tools you called (memory_search, web_search, task_list). Be honest about
   gaps in the data.
4. **Recommendation** — Close with the one or two next steps the reader
   should take. Keep these actionable, not aspirational.

Format guidelines:
- Use Markdown headings for each of the four sections.
- Lead each bullet with a strong verb.
- Length budget: 200–400 words for a standard daily report.
- If the underlying data is thin, say so explicitly under "Result" rather
  than padding with filler.`,
  },
];
