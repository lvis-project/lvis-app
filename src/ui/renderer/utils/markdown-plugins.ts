// Shared remark plugin config for every ReactMarkdown surface in the
// renderer. All chat surfaces (assistant card, trigger card, imported
// trigger summary/response, routine card, etc.) MUST import from here so
// markdown behavior stays in lockstep — copying the tuple inline lets one
// component drift while the others stay correct.
//
// `singleTilde: false` forces strikethrough to require `~~text~~` (GFM
// standard). Without it remark-gfm renders `7~12℃` style ranges as a
// `<del>` between the tildes.

import remarkGfm from "remark-gfm";
import type { Options } from "react-markdown";

// Use the type from `react-markdown` (a direct dependency) rather than
// `unified` (a transitive one) so the package boundary stays clean.
export const MARKDOWN_REMARK_PLUGINS: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
];
