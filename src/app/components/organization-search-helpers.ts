export interface HighlightSegment {
  text: string;
  match: boolean;
}

const MAX_RECENT_SEARCHES = 5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Splits text into matched/unmatched segments for one query. Query words
// shorter than 2 characters are ignored because the API rejects them.
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = [...new Set(
    query
      .split(/\s+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  )].sort((a, b) => b.length - a.length);
  if (text === "" || terms.length === 0) {
    return [{ text, match: false }];
  }
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const index = found.index ?? 0;
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), match: false });
    }
    segments.push({ text: found[0], match: true });
    cursor = index + found[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: false });
  }
  return segments;
}

// Newest first, case-insensitive dedup, capped. Pure so it stays testable
// without a DOM; the page wraps it with localStorage.
export function addRecentSearch(previous: string[], value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return previous;
  }
  const lowered = trimmed.toLowerCase();
  return [trimmed, ...previous.filter((entry) => entry.toLowerCase() !== lowered)]
    .slice(0, MAX_RECENT_SEARCHES);
}

export function loadRecentSearches(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length >= 2)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}
