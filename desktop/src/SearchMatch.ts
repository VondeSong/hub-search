export type SearchMatchRange = { start: number; end: number };

// Unicode case conversion can change length. Preserve original offsets.
export function searchMatchRanges(text: string, terms: readonly string[]): SearchMatchRange[] {
  // Fold the whole string so contextual forms such as Greek final sigma match.
  const folded = text.toLocaleLowerCase();
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of text) {
    const lower = character.toLocaleLowerCase();
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    offset += character.length;
  }
  const needles = [...new Set(terms.map(term => term.trim().toLocaleLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const occupied = new Uint8Array(text.length);
  const ranges: SearchMatchRange[] = [];
  for (const needle of needles) {
    let found = folded.indexOf(needle);
    while (found >= 0) {
      const start = starts[found];
      const end = ends[found + needle.length - 1];
      if (!occupied.subarray(start, end).some(Boolean)) {
        occupied.fill(1, start, end);
        ranges.push({ start, end });
      }
      found = folded.indexOf(needle, found + needle.length);
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function containsSearchTerm(text: string, terms: readonly string[]): boolean {
  const lower = text.toLocaleLowerCase();
  return terms.some(term => term.trim() && lower.includes(term.trim().toLocaleLowerCase()));
}
