/**
 * Semantic deduplication utilities for context entries.
 * Pure utility module — no project imports.
 */

export const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "and", "or", "in", "for", "with", "that", "this", "of",
  "i", "we", "it", "he", "she", "they", "you", "my", "our",
  "need", "should", "will", "must", "have", "has", "had",
  "do", "does", "did", "can", "could", "would",
  "not", "no", "but", "if", "so", "then",
  // Serbian (Latin script)
  "je", "su", "sam", "si", "smo", "ste",
  "ili", "ali", "da", "ne",
  "za", "na", "u", "sa", "od", "do", "iz",
  "taj", "ta", "to", "ovo", "ono",
  "ja", "ti", "on", "ona", "mi", "vi", "oni",
  "treba", "moze", "mora", "ce",
]);

/**
 * Normalize text for comparison: strip bullets, markdown formatting,
 * collapse whitespace, lowercase, trim.
 */
export function normalize(text: string): string {
  let s = text;
  // Strip leading bullets: "- ", "* ", "1. ", etc.
  s = s.replace(/^\s*[-*]\s+/, "");
  s = s.replace(/^\s*\d+\.\s+/, "");
  // Strip markdown bold/italic and backticks
  s = s.replace(/\*\*|[*`]/g, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ");
  // Lowercase and trim
  return s.toLowerCase().trim();
}

/**
 * Extract meaningful keywords from text after normalization,
 * removing stop words and short tokens.
 */
export function extractKeywords(text: string): Set<string> {
  const normalized = normalize(text);
  const words = normalized.split(" ");
  const keywords = new Set<string>();
  for (const w of words) {
    if (w.length >= 3 && !STOP_WORDS.has(w)) {
      keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Determine if two strings are semantic duplicates using 3-tier matching:
 * 1. Normalized exact match
 * 2. Keyword Jaccard overlap >= 0.5 (skipped if union < 3 keywords)
 * 3. Substring containment (shorter must be >= 10 chars)
 */
export function isSemanticDuplicate(a: string, b: string): boolean {
  const normA = normalize(a);
  const normB = normalize(b);

  // Tier 1: normalized exact match
  if (normA === normB) return true;

  // Tier 2: keyword Jaccard overlap
  const kwA = extractKeywords(a);
  const kwB = extractKeywords(b);

  const union = new Set<string>();
  for (const w of kwA) union.add(w);
  for (const w of kwB) union.add(w);

  if (union.size >= 3) {
    let intersectionSize = 0;
    for (const w of kwA) {
      if (kwB.has(w)) intersectionSize++;
    }
    if (intersectionSize / union.size >= 0.5) return true;
  }

  // Tier 3: substring containment (word-boundary aware to avoid "Decision 1" ⊂ "Decision 10")
  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = normA.length <= normB.length ? normB : normA;

  if (shorter.length >= 10 && longer.includes(shorter)) {
    const idx = longer.indexOf(shorter);
    const afterEnd = idx + shorter.length;
    // Require word boundary at end of match (end-of-string or non-alphanumeric)
    if (afterEnd >= longer.length || /\W/.test(longer[afterEnd])) return true;
  }

  return false;
}
