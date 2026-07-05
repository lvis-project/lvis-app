




export interface DetectorResult {
  cleanedText: string;

  newTitle: string | null;

  checkpointSuggested: boolean;
}

const TITLE_PATTERN = /<title>([\s\S]*?)<\/title>/gi;
const CHECKPOINT_MARKER = "[checkpoint]";
const TITLE_MIN = 10;
const TITLE_MAX = 20;

export function detectFromStream(rawText: string): DetectorResult {
  const checkpointSuggested = rawText.includes(CHECKPOINT_MARKER);



  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  const re = new RegExp(TITLE_PATTERN.source, "gi");
  while ((match = re.exec(rawText)) !== null) {
    lastMatch = match;
  }

  let newTitle: string | null = null;
  if (lastMatch) {
    const raw = lastMatch[1].trim();
    if (raw.length >= TITLE_MIN) {
      newTitle = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX) : raw;
    }
  }

  if (!lastMatch && !checkpointSuggested) {
    return { cleanedText: rawText, newTitle: null, checkpointSuggested: false };
  }

  let cleaned = lastMatch
    ? rawText.slice(0, lastMatch.index) +
      rawText.slice(lastMatch.index + lastMatch[0].length)
    : rawText;
  cleaned = cleaned.split(CHECKPOINT_MARKER).join("");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanedText: cleaned, newTitle, checkpointSuggested };
}
