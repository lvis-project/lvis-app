import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REVIEW_LABEL = "cluster-review-passed";
const REVIEW_ROLES = [
  { key: "architect", label: "Architect" },
  { key: "critic", label: "Critic" },
  { key: "security", label: "Security" },
];
const HEAD_PATTERN = "[0-9a-fA-F]{40}";
const SECTION_HEADING = "## Cross-Cutting Review Gate";
const TABLE_HEADER = "| Role | Reviewed HEAD SHA | Verdict | Blocking findings |";
const TABLE_SEPARATOR = "|---|---|---|---|";
const TEMPLATE_PLACEHOLDERS = [
  "<40-char-head-sha>",
  "<HEAD_SHA>",
  "`GO` / `NO-GO`",
  "None, or links/details",
];

function rejected(reason) {
  return { attested: false, reason };
}

function normalizeBody(value) {
  return typeof value === "string" ? value.replaceAll("\r", "") : "";
}

function exactLineCount(text, expected) {
  return text.split("\n").filter((line) => line === expected).length;
}

const RAW_HTML_CONTAINERS = new Set([
  "blockquote",
  "details",
  "dialog",
  "div",
  "iframe",
  "noembed",
  "noframes",
  "object",
  "plaintext",
  "pre",
  "script",
  "section",
  "select",
  "span",
  "style",
  "table",
  "template",
  "textarea",
  "title",
  "xmp",
]);

const RAW_TEXT_HTML_CONTAINERS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

function isInsideHtmlComment(text, index) {
  return text.lastIndexOf("<!--", index) > text.lastIndexOf("-->", index);
}

function withoutHtmlComments(text) {
  const preserveLines = (value) => value.replace(/[^\n]/g, " ");
  return text
    .replace(/<!--[\s\S]*?-->/g, preserveLines)
    .replace(/<!--[\s\S]*$/, preserveLines);
}

function parseFenceLine(line) {
  const match = line.match(/^ {0,3}((?:`{3,})|(?:~{3,}))(.*)$/);
  if (!match) return undefined;
  return { marker: match[1], suffix: match[2] };
}

function isFenceOpener(candidate) {
  return !(
    candidate.marker[0] === "`" &&
    candidate.suffix.includes("`")
  );
}

function closesFence(candidate, openFence) {
  return (
    candidate.marker[0] === openFence.character &&
    candidate.marker.length >= openFence.length &&
    /^[ \t]*$/.test(candidate.suffix)
  );
}

function isInsideMarkdownFence(text, index) {
  let openFence;
  const prefix = withoutHtmlComments(text.slice(0, index));
  for (const line of prefix.split("\n")) {
    const candidate = parseFenceLine(line);
    if (!candidate) continue;
    if (!openFence) {
      if (!isFenceOpener(candidate)) continue;
      openFence = {
        character: candidate.marker[0],
        length: candidate.marker.length,
      };
    } else if (closesFence(candidate, openFence)) {
      openFence = undefined;
    }
  }
  return openFence !== undefined;
}

function withoutMarkdownFencedCode(text) {
  const visibleLines = [];
  let openFence;
  for (const line of text.split("\n")) {
    const candidate = parseFenceLine(line);
    if (openFence) {
      if (candidate && closesFence(candidate, openFence)) {
        openFence = undefined;
      }
      visibleLines.push("");
      continue;
    }
    if (candidate && isFenceOpener(candidate)) {
      openFence = {
        character: candidate.marker[0],
        length: candidate.marker.length,
      };
      visibleLines.push("");
      continue;
    }
    visibleLines.push(line);
  }
  return visibleLines.join("\n");
}

function maximalBacktickRunLength(text, index) {
  if (text[index] !== "`") return 0;
  let end = index + 1;
  while (text[end] === "`") end += 1;
  return end - index;
}

function blankPreservingNewlines(text) {
  return text.replace(/[^\n]/g, " ");
}

function withoutMarkdownIndentedCode(text) {
  const visibleLines = [];
  let inIndentedCode = false;
  let previousWasBlank = true;

  for (const line of text.split("\n")) {
    const isBlank = /^[ \t]*$/.test(line);
    const isIndented = /^(?: {4}|\t)/.test(line);
    if (inIndentedCode) {
      if (isBlank || isIndented) {
        visibleLines.push(blankPreservingNewlines(line));
        previousWasBlank = isBlank;
        continue;
      }
      inIndentedCode = false;
    }

    if (!isBlank && isIndented && previousWasBlank) {
      inIndentedCode = true;
      visibleLines.push(blankPreservingNewlines(line));
    } else {
      visibleLines.push(line);
    }
    previousWasBlank = isBlank;
  }

  return visibleLines.join("\n");
}

function isBackslashEscaped(text, index) {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function withoutMarkdownCodeSpans(text) {
  const visible = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openingIndex = text.indexOf("`", cursor);
    if (openingIndex < 0) {
      visible.push(text.slice(cursor));
      break;
    }
    visible.push(text.slice(cursor, openingIndex));

    const openingLength = maximalBacktickRunLength(text, openingIndex);
    if (isBackslashEscaped(text, openingIndex)) {
      visible.push(text.slice(openingIndex, openingIndex + openingLength));
      cursor = openingIndex + openingLength;
      continue;
    }
    let searchIndex = openingIndex + openingLength;
    let closingIndex = -1;

    while (searchIndex < text.length) {
      const candidateIndex = text.indexOf("`", searchIndex);
      if (candidateIndex < 0) break;
      const candidateLength = maximalBacktickRunLength(text, candidateIndex);
      if (
        candidateLength === openingLength
        && !isBackslashEscaped(text, candidateIndex)
      ) {
        closingIndex = candidateIndex;
        break;
      }
      searchIndex = candidateIndex + candidateLength;
    }

    if (closingIndex < 0) {
      visible.push(text.slice(openingIndex, openingIndex + openingLength));
      cursor = openingIndex + openingLength;
      continue;
    }

    const spanEnd = closingIndex + openingLength;
    visible.push(blankPreservingNewlines(text.slice(openingIndex, spanEnd)));
    cursor = spanEnd;
  }

  return visible.join("");
}

function isInsideRawHtmlContainer(text, index) {
  const stack = [];
  const pattern = /<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g;
  const visiblePrefix = withoutMarkdownFencedCode(
    withoutHtmlComments(text.slice(0, index)),
  );
  const withoutIndentedCode = withoutMarkdownIndentedCode(visiblePrefix);
  const withoutCodeSpans = withoutMarkdownCodeSpans(withoutIndentedCode);

  for (const match of withoutCodeSpans.matchAll(pattern)) {
    if (isBackslashEscaped(withoutCodeSpans, match.index)) continue;
    const name = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    const rawTextContainer = stack.at(-1);
    if (rawTextContainer && RAW_TEXT_HTML_CONTAINERS.has(rawTextContainer)) {
      if (closing && name === rawTextContainer) stack.pop();
      continue;
    }
    if (!RAW_HTML_CONTAINERS.has(name) && !RAW_TEXT_HTML_CONTAINERS.has(name)) {
      continue;
    }
    if (closing) {
      const openIndex = stack.lastIndexOf(name);
      if (openIndex >= 0) stack.splice(openIndex);
    } else {
      stack.push(name);
    }
  }
  return stack.length > 0;
}

function isEvidenceHidden(text, index) {
  return (
    isInsideHtmlComment(text, index) ||
    isInsideMarkdownFence(text, index) ||
    isInsideRawHtmlContainer(text, index)
  );
}

export function evaluateClusterReviewAttestation(pullRequest, triggerEvent) {
  if (!pullRequest || typeof pullRequest !== "object") return rejected("invalid-pull-request");

  const labels = Array.isArray(pullRequest.labels) ? pullRequest.labels : [];
  const hasLabel = labels.some((label) =>
    typeof label === "string" ? label === REVIEW_LABEL : label?.name === REVIEW_LABEL,
  );
  if (!hasLabel) return rejected("missing-label");

  const headSha = pullRequest.head?.sha;
  if (typeof headSha !== "string" || !new RegExp(`^${HEAD_PATTERN}$`).test(headSha)) {
    return rejected("invalid-head-sha");
  }

  const body = normalizeBody(pullRequest.body);
  if (triggerEvent !== undefined) {
    if (!triggerEvent || typeof triggerEvent !== "object" || !triggerEvent.pull_request) {
      return rejected("invalid-trigger-event");
    }

    const changes =
      triggerEvent.changes && typeof triggerEvent.changes === "object"
        ? triggerEvent.changes
        : {};
    const invalidatingEdit =
      triggerEvent.action === "edited" &&
      (Object.hasOwn(changes, "body") || Object.hasOwn(changes, "base"));
    if (
      triggerEvent.action === "synchronize" ||
      triggerEvent.action === "reopened" ||
      invalidatingEdit
    ) {
      return rejected("retained-label-invalidated:" + triggerEvent.action);
    }
    if (
      triggerEvent.action !== "labeled" ||
      triggerEvent.label?.name !== REVIEW_LABEL
    ) {
      return rejected("fresh-review-label-required");
    }

    const eventPullRequest = triggerEvent.pull_request;
    const eventHead = eventPullRequest.head?.sha;
    if (typeof eventHead !== "string" || eventHead.toLowerCase() !== headSha.toLowerCase()) {
      return rejected("stale-event-head");
    }
    if (normalizeBody(eventPullRequest.body) !== body) {
      return rejected("stale-event-body");
    }
    if (
      typeof pullRequest.updated_at !== "string" ||
      typeof eventPullRequest.updated_at !== "string"
    ) {
      return rejected("invalid-event-updated-at");
    }
    if (eventPullRequest.updated_at !== pullRequest.updated_at) {
      return rejected("stale-event-updated-at");
    }
    if (
      typeof pullRequest.state !== "string" ||
      typeof eventPullRequest.state !== "string" ||
      eventPullRequest.state !== pullRequest.state
    ) {
      return rejected("stale-event-state");
    }
  }

  const sectionMatches = [...body.matchAll(new RegExp(`^${SECTION_HEADING}$`, "gm"))];
  if (sectionMatches.length === 0) return rejected("missing-section");
  if (sectionMatches.length > 1) return rejected("duplicate-section");

  if (TEMPLATE_PLACEHOLDERS.some((placeholder) => body.includes(placeholder))) {
    return rejected("template-placeholder");
  }

  const sectionStart = sectionMatches[0].index;
  const nextHeadingPattern = /^## .+$/gm;
  nextHeadingPattern.lastIndex = sectionStart + SECTION_HEADING.length;
  const nextHeading = nextHeadingPattern.exec(body);
  const sectionEnd = nextHeading?.index ?? body.length;
  const section = body.slice(sectionStart, sectionEnd);
  if (isEvidenceHidden(body, sectionStart)) return rejected("table-not-visible");
  const outsideSection = body.slice(0, sectionStart) + body.slice(sectionEnd);
  if (
    /^Reviewed HEAD:/m.test(outsideSection) ||
    /cluster-review:/.test(outsideSection) ||
    /^\| (Architect|Critic|Security) \|/m.test(outsideSection)
  ) {
    return rejected("review-evidence-outside-section");
  }

  const reviewedHeadLines = section
    .split("\n")
    .filter((line) => line.startsWith("Reviewed HEAD:"));
  if (reviewedHeadLines.length === 0) return rejected("missing-reviewed-head");
  if (reviewedHeadLines.length > 1) return rejected("duplicate-reviewed-head");
  const reviewedHeadMatch = reviewedHeadLines[0].match(
    new RegExp(`^Reviewed HEAD: \\\`${HEAD_PATTERN}\\\`$`),
  );
  if (!reviewedHeadMatch) return rejected("invalid-reviewed-head");
  const reviewedHead = reviewedHeadMatch[0].slice("Reviewed HEAD: `".length, -1);
  if (reviewedHead.toLowerCase() !== headSha.toLowerCase()) return rejected("stale-reviewed-head");

  if (exactLineCount(section, TABLE_HEADER) !== 1) return rejected("invalid-table-header");
  if (exactLineCount(section, TABLE_SEPARATOR) !== 1) return rejected("invalid-table-separator");
  if (/^(```|~~~)/m.test(section)) return rejected("table-not-visible");

  const tableBlockPattern = new RegExp(
    [
      "^\\| Role \\| Reviewed HEAD SHA \\| Verdict \\| Blocking findings \\|",
      "\\|---\\|---\\|---\\|---\\|",
      `\\| Architect \\| \\\`(${HEAD_PATTERN})\\\` \\| \\\`(GO|NO-GO)\\\` \\| ([^|\\n]+) \\|`,
      `\\| Critic \\| \\\`(${HEAD_PATTERN})\\\` \\| \\\`(GO|NO-GO)\\\` \\| ([^|\\n]+) \\|`,
      `\\| Security \\| \\\`(${HEAD_PATTERN})\\\` \\| \\\`(GO|NO-GO)\\\` \\| ([^|\\n]+) \\|$`,
    ].join("\\n"),
    "gm",
  );
  const tableBlocks = [...section.matchAll(tableBlockPattern)];
  if (tableBlocks.length !== 1) return rejected("invalid-table-block");
  const [tableBlock] = tableBlocks;
  const tableIndex = sectionStart + tableBlock.index;
  if (isEvidenceHidden(body, tableIndex)) return rejected("table-not-visible");

  const tableRows = REVIEW_ROLES.map((role, index) => ({
    label: role.label,
    sha: tableBlock[1 + index * 3],
    verdict: tableBlock[2 + index * 3],
    findings: tableBlock[3 + index * 3],
  }));
  const tableCandidateCount = section
    .split("\n")
    .filter((line) => /^\| (Architect|Critic|Security) \|/.test(line)).length;
  if (tableCandidateCount !== REVIEW_ROLES.length) return rejected("invalid-table-row");

  const markerPattern = new RegExp(
    `^<!-- cluster-review:(architect|critic|security):(${HEAD_PATTERN}):(GO|NO-GO) -->$`,
  );
  const markerLines = section.split("\n").filter((line) => line.includes("cluster-review:"));
  const markers = [];
  for (const line of markerLines) {
    const match = line.match(markerPattern);
    if (!match) return rejected("invalid-marker");
    markers.push({ role: match[1], sha: match[2], verdict: match[3] });
  }

  for (const [index, role] of REVIEW_ROLES.entries()) {
    const row = tableRows[index];
    if (row.sha.toLowerCase() !== headSha.toLowerCase()) {
      return rejected(`stale-table-head:${role.key}`);
    }
    if (row.verdict !== "GO") return rejected(`table-no-go:${role.key}`);
    if (row.findings !== "None") return rejected(`blocking-findings:${role.key}`);

    const roleMarkers = markers.filter((marker) => marker.role === role.key);
    if (roleMarkers.length === 0) return rejected(`missing-role:${role.key}`);
    if (roleMarkers.length > 1) return rejected(`duplicate-role:${role.key}`);
    const [marker] = roleMarkers;
    if (marker.sha.toLowerCase() !== headSha.toLowerCase()) {
      return rejected(`stale-head:${role.key}`);
    }
    if (marker.verdict !== "GO") return rejected(`no-go:${role.key}`);
    if (
      marker.sha.toLowerCase() !== row.sha.toLowerCase() ||
      marker.verdict !== row.verdict
    ) {
      return rejected(`visible-marker-mismatch:${role.key}`);
    }
  }

  return { attested: true, reason: "attested" };
}

function runFromActionsEnvironment() {
  const snapshotPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
  const outputPath = process.argv[3] ?? process.env.GITHUB_OUTPUT;
  const triggerPath = process.argv[4];
  if (!snapshotPath || !outputPath) {
    throw new Error("pull-request snapshot and GitHub output paths are required");
  }

  let result;
  try {
    const payload = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const pullRequest = payload.pull_request ?? payload;
    const triggerEvent = triggerPath
      ? JSON.parse(readFileSync(triggerPath, "utf8"))
      : payload.pull_request
        ? payload
        : undefined;
    result = evaluateClusterReviewAttestation(pullRequest, triggerEvent);
  } catch {
    result = rejected("invalid-event");
  }

  appendFileSync(outputPath, `attested=${result.attested}\nreason=${result.reason}\n`, "utf8");
  console.log(`Cluster review attestation: ${result.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromActionsEnvironment();
}
