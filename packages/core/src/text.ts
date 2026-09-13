/** Text admission rules: disallowed-control scan and structural non-text detection. */

export function isAsciiWhitespace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

/** §3 disallowed set: U+0000, C0 except TAB/LF/CR, U+007F, U+200B-200F,
 *  U+202A-202E, U+2060, U+2066-2069, U+FEFF. TAB is deliberately excluded so it
 *  is reported as NON_TEXT_INPUT by the structural scan instead. */
export function isDisallowedControl(cp: number): boolean {
  if (cp === 0x00) return true;
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return true;
  if (cp === 0x7f) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp === 0x2060) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  if (cp === 0xfeff) return true;
  return false;
}

/** True iff the text contains a §3 disallowed control or an unpaired surrogate. */
export function hasDisallowedControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (cu >= 0xdc00 && cu <= 0xdfff) return true;
    if (isDisallowedControl(cu)) return true;
  }
  return false;
}

/** Any string field must be well-formed Unicode; used for non-scanned fields. */
export function isWellFormed(text: string): boolean {
  return text.isWellFormed();
}

/**
 * §5.1 structural non-text detection over one text value:
 * any TAB, any line with two or more `|`, any `![`, or a line whose
 * ASCII-whitespace-trimmed lowercase prefix is `<table` or `<svg`.
 */
export function isStructuralNonText(text: string): boolean {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.includes("\t")) return true;
    let pipes = 0;
    for (const ch of line) {
      if (ch === "|") {
        pipes++;
        if (pipes >= 2) return true;
      }
    }
    const trimmed = line.replace(/^[ \t\r\n]+/, "").toLowerCase();
    if (trimmed.startsWith("<table") || trimmed.startsWith("<svg")) return true;
  }
  if (text.includes("![")) return true;
  // A TAB could in principle be smuggled inside no line split above; the per-line
  // scan already covers every line of the document.
  return false;
}

/** Trim ASCII whitespace (U+0020, TAB, LF, CR) from both ends. */
export function trimAscii(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isAsciiWhitespace(s.charCodeAt(a))) a++;
  while (b > a && isAsciiWhitespace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}
