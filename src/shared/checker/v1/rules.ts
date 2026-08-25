import type { CheckerInput, Finding } from "../contracts.js";
import { CheckerInputSchema, FindingSchema } from "../contracts.js";
import { countWords, parseMarkdown, type MarkdownBlock } from "./markdown.js";
import { canonicaliseInternalUrl } from "./internal-link-url.js";
import { REPEATED_ADJECTIVE_POLICY } from "./rule-data.js";
import { RULE_IDS_V1 } from "./rule-ids.js";
import {
  PROVISIONAL_BANNED_PHRASES_V1,
  PROVISIONAL_US_TO_UK_WORD_MAP_V1,
  PROVISIONAL_VAGUE_HEADINGS_V1,
} from "./policy-data.js";
/** Provisional, task-derived examples only. This is not a complete US-to-UK wordlist. */
export const PROVISIONAL_US_TO_UK_WORD_MAP = PROVISIONAL_US_TO_UK_WORD_MAP_V1;
/** Provisional, task-derived generic headings only. This is not an approved blocklist. */
export const PROVISIONAL_VAGUE_HEADINGS = PROVISIONAL_VAGUE_HEADINGS_V1;
/** Provisional safe subset of the task's absolute-claim category; no complete banned/AI-tell list is claimed. */
export const PROVISIONAL_BANNED_PHRASES = PROVISIONAL_BANNED_PHRASES_V1;

export interface FindingDetails {
  rule: string;
  severity?: Finding["severity"];
  field: string;
  line_start?: number;
  line_end?: number;
  section?: string;
  issue: string;
  suggested_fix: string;
  provisional?: boolean;
  semantic_location_key?: string;
  subject_key?: string;
  semantic_occurrence?: number;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function finding(details: FindingDetails): Finding {
  const location = {
    field: details.field,
    ...(details.line_start === undefined ? {} : { line_start: details.line_start }),
    ...(details.line_end === undefined ? {} : { line_end: details.line_end }),
    ...(details.section === undefined ? {} : { section: details.section }),
  };
  const identity = [
    details.rule,
    details.semantic_location_key ?? details.field,
    details.subject_key ?? "rule",
    details.semantic_occurrence ?? 1,
  ].join("|");
  return FindingSchema.parse({
    id: `det_${hash(identity)}`,
    rule: details.rule,
    severity: details.severity ?? (details.provisional ? "warning" : "blocker"),
    location,
    issue: details.issue,
    suggested_fix: details.suggested_fix,
    provisional: details.provisional ?? false,
  });
}

const normalise = (value: string) => value.toLocaleLowerCase("en-GB").replace(/\s+/g, " ").trim();
function containsExact(value: string, phrase: string): boolean {
  const haystack = normalise(value);
  const needle = normalise(phrase);
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    const isWordCharacter = (character: string | undefined) =>
      character !== undefined && /[\p{L}\p{N}_]/u.test(character);
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])(?:["'”’)]*)\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function syllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length <= 3) return cleaned ? 1 : 0;
  const adjusted = cleaned.replace(/(?:[^le]e|ed|es)$/, "").replace(/^y/, "");
  return Math.max(1, adjusted.match(/[aeiouy]{1,2}/g)?.length ?? 1);
}

/** Deterministic approximation of Flesch-Kincaid grade, rounded only for reporting. */
export function calculateReadabilityGrade(value: string): number {
  const words = value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  if (words.length === 0) return 0;
  const sentenceCount = Math.max(1, sentences(value).length);
  const syllableCount = words.reduce((sum, word) => sum + syllables(word), 0);
  return 0.39 * (words.length / sentenceCount) + 11.8 * (syllableCount / words.length) - 15.59;
}

function blockLocation(block: MarkdownBlock) {
  return {
    line_start: block.line_start,
    line_end: block.line_end,
    ...(block.section ? { section: block.section } : {}),
    ...(block.semantic_key ? { semantic_location_key: block.semantic_key } : {}),
  };
}

function firstProseAfterH1(blocks: MarkdownBlock[]): MarkdownBlock | undefined {
  const h1Index = blocks.findIndex(
    (block) => block.kind === "heading" && block.heading_level === 1,
  );
  if (h1Index < 0) return undefined;
  const immediate = blocks[h1Index + 1];
  return immediate?.kind === "paragraph" ? immediate : undefined;
}

function keyTakeawayItems(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const headingIndex = blocks.findIndex(
    (block) => block.kind === "heading" && normalise(block.text) === "key takeaways",
  );
  if (headingIndex < 0) return [];
  const result: MarkdownBlock[] = [];
  for (const block of blocks.slice(headingIndex + 1)) {
    if (block.kind === "heading") break;
    if (block.kind === "list_item" && !block.ordered) result.push(block);
  }
  return result;
}

function repeatedExactPhrase(value: string, phrase: string): boolean {
  const escaped = normalise(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (normalise(value).match(new RegExp(escaped, "g"))?.length ?? 0) > 1;
}

function repeatedAdjectives(
  blocks: MarkdownBlock[],
  requiredPhrases: readonly string[],
): Array<{ adjective: string; count: number; location: MarkdownBlock }> {
  // Headings and blockquotes are intentionally excluded. Required keyword
  // phrases are removed before counting so SEO placement cannot trigger the
  // style warning. Capitalised words are ignored as conservative product/name
  // candidates; this favours false negatives over noisy findings.
  const candidates = blocks.filter(
    (block) => block.kind === "paragraph" || block.kind === "list_item",
  );
  const requiredWords = new Set(
    requiredPhrases.flatMap((phrase) => normalise(phrase).match(/[a-z]+/g) ?? []),
  );
  const counts = new Map<string, { count: number; location: MarkdownBlock }>();
  for (const block of candidates) {
    const withoutKeywords = requiredPhrases.reduce(
      (text, phrase) =>
        text.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " "),
      block.text,
    );
    for (const match of withoutKeywords.matchAll(/\b[A-Za-z]+(?:['’-][A-Za-z]+)?\b/g)) {
      const raw = match[0];
      if (/^[A-Z]/.test(raw)) continue;
      const word = raw.toLocaleLowerCase("en-GB");
      if (requiredWords.has(word) || word.length < 4) continue;
      const adjective =
        (REPEATED_ADJECTIVE_POLICY.adjectives as readonly string[]).includes(word) ||
        REPEATED_ADJECTIVE_POLICY.adjectiveSuffixes.some((suffix) => word.endsWith(suffix));
      if (!adjective) continue;
      const current = counts.get(word);
      counts.set(word, {
        count: (current?.count ?? 0) + 1,
        location: current?.location ?? block,
      });
    }
  }
  const proseWords = Math.max(1, countWords(candidates.map((block) => block.text).join(" ")));
  return [...counts.entries()]
    .filter(([, value]) => {
      const rate = (value.count * 1000) / proseWords;
      return (
        value.count >= REPEATED_ADJECTIVE_POLICY.minimumOccurrences &&
        rate >= REPEATED_ADJECTIVE_POLICY.occurrencesPerThousandWords
      );
    })
    .map(([adjective, value]) => ({ adjective, ...value }))
    .sort((a, b) => a.adjective.localeCompare(b.adjective, "en-GB"));
}

export interface RuleEvaluationV1 {
  rule_id: string;
  status: "evaluated" | "skipped";
  reason?: string;
}

export interface CheckerRunV1 {
  findings: Finding[];
  evaluations: RuleEvaluationV1[];
}

/** Frozen v1 executable. Behavioural changes require a new versioned module. */
export function runDeterministicChecksV1(rawInput: CheckerInput): CheckerRunV1 {
  const input = CheckerInputSchema.parse(rawInput);
  const parsed = parseMarkdown(input.body_markdown);
  const findings: Finding[] = [];
  const conditionalApplicability = new Map<string, string | undefined>([
    ["structure.heading_levels", parsed.headings.length ? undefined : "no_headings"],
    ["style.vague_heading_provisional", parsed.headings.length ? undefined : "no_headings"],
    [
      "style.repeated_adjective",
      parsed.blocks.some((block) => block.kind === "paragraph" || block.kind === "list_item")
        ? undefined
        : "no_paragraph_or_list_prose",
    ],
    ["structure.faq_answer_length", input.on_page.faqs.length ? undefined : "no_faqs"],
  ]);
  const evaluations: RuleEvaluationV1[] = RULE_IDS_V1.map((rule_id) => {
    const reason = conditionalApplicability.get(rule_id);
    return reason ? { rule_id, status: "skipped", reason } : { rule_id, status: "evaluated" };
  });
  const semanticOccurrences = new Map<string, number>();
  const add = (details: FindingDetails) => {
    const key = [
      details.rule,
      details.semantic_location_key ?? details.field,
      details.subject_key ?? "rule",
    ].join("|");
    const semanticOccurrence = (semanticOccurrences.get(key) ?? 0) + 1;
    semanticOccurrences.set(key, semanticOccurrence);
    findings.push(finding({ ...details, semantic_occurrence: semanticOccurrence }));
  };

  const lengths: Array<[string, string, number, number]> = [
    ["meta_title", input.on_page.meta_title, 55, 60],
    ["meta_description", input.on_page.meta_description, 150, 155],
  ];
  for (const [field, value, minimum, maximum] of lengths) {
    if (value.length < minimum || value.length > maximum)
      add({
        rule: `on_page.${field}.length`,
        field: `on_page.${field}`,
        issue: `${field.replaceAll("_", " ")} is ${value.length} characters; required range is ${minimum}–${maximum}.`,
        suggested_fix: `Revise it to ${minimum}–${maximum} characters.`,
      });
  }

  const requiredFields: Array<[string, string]> = [
    ["meta_title", input.on_page.meta_title],
    ["meta_description", input.on_page.meta_description],
    ["og_title", input.on_page.og_title],
    ["og_description", input.on_page.og_description],
    ["slug", input.on_page.slug],
  ];
  for (const [field, value] of requiredFields)
    if (!value.trim())
      add({
        rule: "on_page.populated",
        field: `on_page.${field}`,
        issue: `${field.replaceAll("_", " ")} is not populated.`,
        suggested_fix: "Populate this on-page field.",
      });
  if (input.on_page.images.length === 0)
    add({
      rule: "on_page.populated",
      field: "on_page.images",
      issue: "No image alt text or filename entries are populated.",
      suggested_fix: "Add at least one image with alt text and a filename.",
    });
  input.on_page.images.forEach((image, index) => {
    for (const field of ["alt", "filename"] as const)
      if (!image[field].trim())
        add({
          rule: "on_page.populated",
          field: `on_page.images.${index}.${field}`,
          issue: `Image ${index + 1} ${field} is not populated.`,
          suggested_fix: `Populate the image ${field}.`,
        });
  });

  const h1s = parsed.headings.filter((item) => item.heading_level === 1);
  const firstHeading = parsed.headings[0];
  if (firstHeading && firstHeading.heading_level !== 1)
    add({
      rule: "structure.heading_levels",
      field: "body_markdown",
      ...blockLocation(firstHeading),
      subject_key: "initial-heading",
      issue: `The initial heading is H${firstHeading.heading_level}; the heading hierarchy must begin with H1.`,
      suggested_fix: "Begin the document heading hierarchy with its single H1.",
    });
  if (h1s.length !== 1)
    add({
      rule: "structure.single_h1",
      field: "body_markdown",
      issue: `Found ${h1s.length} H1 headings; exactly one is required.`,
      suggested_fix: "Add one H1 or demote additional H1 headings.",
    });
  const keywordH1 = h1s.find((item) => containsExact(item.text, input.primary_keyword));
  if (!keywordH1)
    add({
      rule: "keyword.primary.h1",
      field: "body_markdown",
      issue: "The H1 does not contain the exact primary keyword.",
      suggested_fix: "Include the exact primary keyword in the single H1.",
    });

  for (let index = 1; index < parsed.headings.length; index += 1) {
    const previous = parsed.headings[index - 1];
    const current = parsed.headings[index];
    if (previous && current && (current.heading_level ?? 0) > (previous.heading_level ?? 0) + 1)
      add({
        rule: "structure.heading_levels",
        field: "body_markdown",
        ...blockLocation(current),
        issue: `Heading level skips from H${previous.heading_level} to H${current.heading_level}.`,
        suggested_fix: "Use the next heading level without skipping a level.",
      });
  }

  const answer = firstProseAfterH1(parsed.blocks);
  const answerWords = answer ? countWords(answer.text) : 0;
  if (answerWords < 40 || answerWords > 70)
    add({
      rule: "structure.direct_answer",
      field: "body_markdown",
      ...(answer ? blockLocation(answer) : {}),
      issue: `The direct-answer paragraph has ${answerWords} words; required range is 40–70.`,
      suggested_fix: "Make the first prose paragraph after the H1 a 40–70 word direct answer.",
    });

  const conclusionHeading = parsed.headings.find(
    (heading) => heading.heading_level === 2 && normalise(heading.text) === "conclusion",
  );
  if (!conclusionHeading) {
    add({
      rule: "structure.conclusion",
      field: "body_markdown",
      issue: "No H2 named Conclusion is present.",
      suggested_fix: "Add an H2 Conclusion section that states the bottom line up front.",
    });
  } else {
    const conclusionIndex = parsed.blocks.indexOf(conclusionHeading);
    const conclusionIntro = parsed.blocks[conclusionIndex + 1];
    if (conclusionIntro?.kind !== "paragraph")
      add({
        rule: "structure.conclusion",
        field: "body_markdown",
        ...blockLocation(conclusionHeading),
        subject_key: "answer-first",
        issue: "The Conclusion does not begin with a prose paragraph.",
        suggested_fix: "Begin the Conclusion with an answer-first bottom-line paragraph.",
      });
  }

  const takeaways = keyTakeawayItems(parsed.blocks);
  if (takeaways.length < 3 || takeaways.length > 5)
    add({
      rule: "structure.key_takeaways",
      field: "body_markdown",
      issue: `Found ${takeaways.length} key-takeaway bullets; required range is 3–5.`,
      suggested_fix: "Add a Key Takeaways section containing three to five unordered bullets.",
    });

  if (input.on_page.faqs.length < 3 || input.on_page.faqs.length > 6)
    add({
      rule: "structure.faq_count",
      field: "on_page.faqs",
      issue: `Found ${input.on_page.faqs.length} FAQ items; required range is 3–6.`,
      suggested_fix: "Provide three to six FAQ questions and answers.",
    });
  input.on_page.faqs.forEach((faq, index) => {
    if (!faq.question.trim())
      add({
        rule: "on_page.populated",
        field: `on_page.faqs.${index}.question`,
        issue: `FAQ ${index + 1} question is not populated.`,
        suggested_fix: "Populate the FAQ question.",
      });
    const words = countWords(faq.answer);
    if (words < 40 || words > 80)
      add({
        rule: "structure.faq_answer_length",
        field: `on_page.faqs.${index}.answer`,
        issue: `FAQ ${index + 1} answer has ${words} words; required range is 40–80.`,
        suggested_fix: "Revise the answer to 40–80 words.",
      });
    if (!faq.answer.trim())
      add({
        rule: "on_page.populated",
        field: `on_page.faqs.${index}.answer`,
        issue: `FAQ ${index + 1} answer is not populated.`,
        suggested_fix: "Populate the FAQ answer.",
      });
  });

  if (parsed.blockquotes.length < 1 || parsed.blockquotes.length > 3)
    add({
      rule: "structure.callouts",
      field: "body_markdown",
      issue: `Found ${parsed.blockquotes.length} Markdown blockquote callouts; required range is 1–3.`,
      suggested_fix: "Use one to three Markdown blockquote callouts.",
    });

  const grade = calculateReadabilityGrade(parsed.prose);
  if (grade > 8)
    add({
      rule: "style.readability_grade_8",
      field: "body_markdown",
      issue: `Estimated Flesch-Kincaid grade is ${grade.toFixed(1)}; target is Grade 8 or below.`,
      suggested_fix: "Shorten sentences and prefer simpler words to reach Grade 8 or below.",
    });

  for (const [us, uk] of Object.entries(PROVISIONAL_US_TO_UK_WORD_MAP)) {
    const expression = new RegExp(`\\b${us}\\b`, "i");
    for (const block of parsed.blocks.filter((item) => expression.test(item.text)))
      add({
        rule: "style.british_english_provisional",
        field: "body_markdown",
        ...blockLocation(block),
        subject_key: us,
        issue: `US spelling “${us}” appears in the draft (provisional task-derived map).`,
        suggested_fix: `Consider the British English spelling “${uk}”.`,
        provisional: true,
      });
  }
  for (const heading of parsed.headings) {
    if (
      PROVISIONAL_VAGUE_HEADINGS.includes(
        normalise(heading.text) as (typeof PROVISIONAL_VAGUE_HEADINGS)[number],
      )
    )
      add({
        rule: "style.vague_heading_provisional",
        field: "body_markdown",
        ...blockLocation(heading),
        subject_key: normalise(heading.text),
        issue: `Heading “${heading.text}” matches the small provisional task-derived vague-heading list.`,
        suggested_fix: "Replace it with a specific heading that describes the section.",
        provisional: true,
      });
  }
  for (const phrase of PROVISIONAL_BANNED_PHRASES) {
    const expression = new RegExp(`\\b${phrase}\\b`, "i");
    for (const block of parsed.blocks.filter((item) => expression.test(item.text)))
      add({
        rule: "style.banned_phrase_provisional",
        field: "body_markdown",
        ...blockLocation(block),
        subject_key: phrase,
        issue: `Absolute phrase “${phrase}” matches the safe provisional task-derived category.`,
        suggested_fix: "Qualify or remove the absolute claim unless evidence supports it.",
        provisional: true,
      });
  }
  for (const repeated of repeatedAdjectives(parsed.blocks, [
    input.primary_keyword,
    ...input.related_keywords,
  ]))
    add({
      rule: "style.repeated_adjective",
      severity: REPEATED_ADJECTIVE_POLICY.severity,
      field: "body_markdown",
      ...blockLocation(repeated.location),
      subject_key: repeated.adjective,
      issue: `Adjective “${repeated.adjective}” appears ${repeated.count} times, meeting the warning threshold of ${REPEATED_ADJECTIVE_POLICY.occurrencesPerThousandWords} uses per 1,000 prose words.`,
      suggested_fix: "Remove unnecessary repetition or use more precise reader-first wording.",
    });

  const placements: Array<[string, string, string]> = [
    [
      "meta_title",
      input.on_page.meta_title,
      "Include the exact primary keyword in the meta title.",
    ],
    [
      "first_100_words",
      parsed.blocks
        .filter((block) => block.kind !== "heading")
        .map((block) => block.text)
        .join(" ")
        .split(/\s+/)
        .slice(0, 100)
        .join(" "),
      "Include the exact primary keyword within the first 100 body words.",
    ],
  ];
  for (const [place, value, fix] of placements)
    if (!containsExact(value, input.primary_keyword))
      add({
        rule: `keyword.primary.${place}`,
        field: place === "meta_title" ? "on_page.meta_title" : "body_markdown",
        issue: `The exact primary keyword is absent from ${place.replaceAll("_", " ")}.`,
        suggested_fix: fix,
      });
  if (
    !parsed.headings.some(
      (item) => item.heading_level === 2 && containsExact(item.text, input.primary_keyword),
    )
  )
    add({
      rule: "keyword.primary.h2",
      field: "body_markdown",
      issue: "No H2 contains the exact primary keyword.",
      suggested_fix: "Include the exact primary keyword in at least one relevant H2.",
    });

  for (const keyword of input.related_keywords) {
    const meaningful = parsed.blocks.some(
      (block) =>
        (block.kind === "paragraph" || block.kind === "list_item" || block.kind === "blockquote") &&
        Boolean(block.section) &&
        containsExact(block.text, keyword),
    );
    if (!meaningful)
      add({
        rule: "keyword.related.meaningful_section",
        field: "body_markdown",
        subject_key: normalise(keyword),
        issue: `Related keyword “${keyword}” is absent from prose in a headed section.`,
        suggested_fix: "Use the exact related keyword naturally in a relevant headed section.",
      });
  }

  for (const phrase of [input.primary_keyword, ...input.related_keywords]) {
    for (const block of parsed.blocks.filter(
      (item) => item.kind !== "heading" && repeatedExactPhrase(item.text, phrase),
    ))
      add({
        rule: "keyword.concentration_provisional",
        severity: "warning",
        field: "body_markdown",
        ...blockLocation(block),
        subject_key: normalise(phrase),
        issue: `Exact phrase “${phrase}” repeats within one paragraph or sentence (provisional non-numeric heuristic).`,
        suggested_fix:
          "Review the concentrated repetition and keep only natural, useful occurrences.",
        provisional: true,
      });
  }

  // Step 1.8 owns target membership, live status, redirects, hierarchy and
  // model link-quality review. Step 1.4 retains only commercial body presence;
  // the same presence check is deliberately rerun at Step 1.11.
  const shortlist = new Map(
    input.verified_internal_links.flatMap((link) => {
      const canonical = canonicaliseInternalUrl(link.url, input.internal_origins);
      return canonical ? [[canonical, link] as const] : [];
    }),
  );
  const bodyInternalLinks = parsed.links.flatMap((link) => {
    const canonical = canonicaliseInternalUrl(link.url, input.internal_origins);
    return canonical ? [{ link, canonical }] : [];
  });
  const validLinks = bodyInternalLinks.filter(
    ({ canonical }) => shortlist.get(canonical)?.status === 200,
  );
  const excludedCommercialSections = new Set(["conclusion", "key takeaways", "faq", "faqs"]);
  const validCommercialProseLinks = validLinks.filter(({ link }) => {
    const block = parsed.blocks.find(
      (item) => item.semantic_key && link.semantic_key?.startsWith(item.semantic_key),
    );
    return (
      block?.kind === "paragraph" &&
      !link.section_path.some((section) => excludedCommercialSections.has(normalise(section)))
    );
  });
  if (validCommercialProseLinks.length === 0)
    add({
      rule: "links.verified_internal_presence",
      field: "body_markdown",
      issue:
        "No status-200 shortlist link appears in commercial body prose outside excluded end sections and callouts.",
      suggested_fix:
        "Add a relevant verified commercial link in ordinary body prose outside Conclusion, Key Takeaways and FAQ.",
    });
  return { findings, evaluations };
}
