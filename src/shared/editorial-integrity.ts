import type { StructuredDraft } from "./contracts/content.js";

const DANGLING_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

const FAQ_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "are",
  "can",
  "could",
  "does",
  "from",
  "have",
  "how",
  "into",
  "should",
  "that",
  "the",
  "their",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "your",
]);

const unicodeCharacters = (value: string) => Array.from(value);

export function unicodeLength(value: string): number {
  return unicodeCharacters(value).length;
}

function finalWord(value: string): string | undefined {
  return value
    .trim()
    .replace(/[\p{P}\p{S}]+$/gu, "")
    .split(/[\s\u00a0]+/u)
    .at(-1)
    ?.toLocaleLowerCase("en-GB");
}

export function hasDanglingTitleEnding(value: string): boolean {
  const word = finalWord(value);
  return word !== undefined && DANGLING_TITLE_WORDS.has(word);
}

/**
 * Unicode-safe shortening for an authorised title-length correction. It never
 * manufactures prose: it retains a complete prefix, removes a partial final
 * word, then removes any dangling connector left by that boundary.
 */
export function shortenTitleAtWordBoundary(value: string, maximum: number): string {
  const trimmed = value.trim();
  if (unicodeLength(trimmed) <= maximum) return trimmed;
  const characters = unicodeCharacters(trimmed);
  let candidate = characters.slice(0, maximum).join("").trimEnd();
  const next = characters[maximum];
  if (next !== undefined && !/[\s\u00a0]/u.test(next))
    candidate = candidate.replace(/[^\s\u00a0]+$/u, "").trimEnd();
  while (hasDanglingTitleEnding(candidate))
    candidate = candidate.replace(/(?:^|[\s\u00a0]+)[^\s\u00a0]+$/u, "").trimEnd();
  return candidate;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase("en-GB")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 3 && !FAQ_STOP_WORDS.has(token)) ?? [],
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function permutations(values: number[]): number[][] {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

/**
 * Detects only a strong, content-free permutation signal. It does not attempt
 * to decide general semantic relevance. A draft is blocked only when another
 * complete-pair assignment has materially greater question-anchor overlap and
 * fixes at least two zero-overlap current pairs. The app never applies that
 * permutation; an operator-authorised revision must correct the source pairs.
 */
export function suspiciousFaqPairIndexes(
  faqs: StructuredDraft["faqs"],
  primaryKeyword: string,
): number[] {
  if (faqs.length < 2 || faqs.length > 6) return [];
  const topic = tokens(primaryKeyword);
  const questions = faqs.map((faq) => {
    const value = tokens(faq.question);
    for (const token of topic) value.delete(token);
    return value;
  });
  if (questions.some((question) => question.size === 0)) return [];
  const answers = faqs.map((faq) => tokens(faq.answer));
  const scores = questions.map((question) => answers.map((answer) => overlap(question, answer)));
  const identity = faqs.map((_, index) => index);
  const identityScore = identity.reduce(
    (sum, answer, question) => sum + scores[question]![answer]!,
    0,
  );
  let best = identity;
  let bestScore = identityScore;
  for (const candidate of permutations(identity)) {
    const score = candidate.reduce((sum, answer, question) => sum + scores[question]![answer]!, 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const improved = identity.filter((answer, question) => {
    const alternative = best[question];
    return (
      alternative !== undefined &&
      scores[question]![answer] === 0 &&
      scores[question]![alternative]! > 0
    );
  });
  return bestScore >= identityScore + 3 && improved.length >= 2 ? improved : [];
}

export function assertEditoriallyExportable(draft: StructuredDraft, primaryKeyword: string): void {
  const incomplete = [draft.title, draft.meta_title ?? draft.title, draft.og_title].filter(
    hasDanglingTitleEnding,
  ).length;
  if (incomplete > 0)
    throw new Error("Title integrity requires a controlled correction before export");
  if (suspiciousFaqPairIndexes(draft.faqs, primaryKeyword).length > 0)
    throw new Error("FAQ pair integrity requires a controlled correction before export");
}
