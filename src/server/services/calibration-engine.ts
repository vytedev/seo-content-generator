import { createHash } from "node:crypto";
import {
  CALIBRATION_POSTS,
  CalibrationPostResultSchema,
  CalibrationDimensionSchema,
  type CalibrationClassification,
  type CalibrationObservation,
  type CalibrationPostResult,
  type CalibrationSnapshot,
} from "../../shared/contracts/calibration.js";
import {
  runDeterministicChecks,
  type CheckerInput,
  type Finding,
} from "../../shared/checker/index.js";
import type { StructuredDraft } from "../../shared/milestone-two.js";
import type { Handoff } from "../../shared/pipeline.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const words = (value: string) => value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
const excerpt = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, 500) || "No dimension-specific evidence found.";
const headings = (value: string) => value.match(/^#{1,6} .+$/gm) ?? [];
const links = (value: string) =>
  [...value.matchAll(/\[[^\]]+\]\((https:\/\/www\.mobelaris\.com[^)]+)\)/g)].map(
    (match) => match[1]!,
  );
const figures = (value: string) => value.match(/\b\d[\d,.]*(?:%|\b)/g) ?? [];
const attributions = (value: string) =>
  value.match(/[^.\n]*(?:designed by|designer|original)[^.\n]*[.\n]/gi) ?? [];

type Dimension = (typeof CalibrationDimensionSchema)["_output"];
const DIMENSIONS: Dimension[] = [
  "structure",
  "direct_answer",
  "takeaways",
  "heading_hierarchy",
  "keyword_placement_non_numeric_concentration",
  "readability",
  "faq",
  "internal_links",
  "information_gain",
  "factual_figures",
  "product_claims",
  "attribution",
  "on_page_metadata",
  "coherence",
];

const RULES: Record<Dimension, string[]> = {
  structure: ["structure.single_h1", "structure.conclusion", "structure.callouts"],
  direct_answer: ["structure.direct_answer"],
  takeaways: ["structure.key_takeaways"],
  heading_hierarchy: ["structure.heading_levels"],
  keyword_placement_non_numeric_concentration: [
    "keyword.primary.h1",
    "keyword.primary.h2",
    "keyword.primary.meta_title",
    "keyword.primary.first_100_words",
    "keyword.related.meaningful_section",
    "keyword.concentration_provisional",
  ],
  readability: [
    "style.readability_grade_8",
    "style.british_english_provisional",
    "style.vague_heading_provisional",
    "style.banned_phrase_provisional",
  ],
  faq: ["structure.faq_count", "structure.faq_answer_length"],
  internal_links: [
    "links.verified_internal_presence",
    "links.shortlist_membership",
    "links.target_status",
    "links.hierarchy_priority",
  ],
  information_gain: [],
  factual_figures: [],
  product_claims: [],
  attribution: [],
  on_page_metadata: [
    "on_page.meta_title.length",
    "on_page.meta_description.length",
    "on_page.populated",
  ],
  coherence: [],
};

export interface GeneratedCalibrationDocument {
  pipeline_run_id: string;
  final_document_version_id: string;
  export_id: string | null;
  pipeline_outcome: "succeeded" | "blocked";
  draft: StructuredDraft;
  handoff: Handoff;
  fixture: {
    internal_origins: string[];
    verified_internal_links: CheckerInput["verified_internal_links"];
  };
}

function checkerInput(
  body: string,
  title: string,
  description: string,
  slug: string,
  keyword: string,
  related: string[],
  onPage: CheckerInput["on_page"],
  fixture: GeneratedCalibrationDocument["fixture"],
): CheckerInput {
  return {
    primary_keyword: keyword,
    related_keywords: related,
    body_markdown: body,
    on_page: { ...onPage, meta_title: title, meta_description: description, slug },
    internal_origins: fixture.internal_origins,
    verified_internal_links: fixture.verified_internal_links,
  };
}

function findingRules(findings: Finding[], dimension: Dimension): string[] {
  const allowed = new Set(RULES[dimension]);
  return findings.filter((finding) => allowed.has(finding.rule)).map((finding) => finding.rule);
}

function metrics(dimension: Dimension, text: string, input: CheckerInput, findings: Finding[]) {
  const rules = findingRules(findings, dimension);
  switch (dimension) {
    case "structure":
      return {
        word_count: words(text),
        heading_count: headings(text).length,
        rule_findings: rules.length,
      };
    case "direct_answer":
      return { direct_answer_rule_findings: rules.length };
    case "takeaways":
      return { takeaway_rule_findings: rules.length };
    case "heading_hierarchy":
      return { headings: headings(text).join(" | ") || "none", rule_findings: rules.length };
    case "keyword_placement_non_numeric_concentration":
      return { keyword: input.primary_keyword, rule_findings: rules.length };
    case "readability":
      return { rule_findings: rules.length };
    case "faq":
      return { faq_count: input.on_page.faqs.length, rule_findings: rules.length };
    case "internal_links":
      return {
        extracted_links: links(text).length,
        verified_links: input.verified_internal_links.length,
        rule_findings: rules.length,
      };
    case "information_gain":
      return { word_count: words(text), heading_count: headings(text).length };
    case "factual_figures":
      return { figure_count: figures(text).length };
    case "product_claims":
      return { recorded_claims: 0 };
    case "attribution":
      return { attribution_mentions: attributions(text).length };
    case "on_page_metadata":
      return {
        title_length: input.on_page.meta_title.length,
        description_length: input.on_page.meta_description.length,
        rule_findings: rules.length,
      };
    case "coherence":
      return { heading_count: headings(text).length, word_count: words(text) };
  }
}

export interface CalibrationClassificationEvidence {
  checkerRuleSet: readonly string[];
  publishedRules: readonly string[];
  generatedRules: readonly string[];
  publishedMetric: Record<string, string | number | boolean>;
  generatedMetric: Record<string, string | number | boolean>;
  pipelineOutcome: "succeeded" | "blocked";
  relevantMentions: number;
  labelledActualRuleEvidence?: "false_positive" | "false_negative";
}

export function classifyCalibrationEvidence(
  dimension: Dimension,
  evidence: CalibrationClassificationEvidence,
): CalibrationClassification {
  if (evidence.labelledActualRuleEvidence === "false_positive")
    return "true_pipeline_false_positive";
  if (evidence.labelledActualRuleEvidence === "false_negative")
    return "true_pipeline_false_negative";

  const checkerCoverage = evidence.checkerRuleSet.length > 0;
  const metricsPresent =
    Object.keys(evidence.publishedMetric).length > 0 &&
    Object.keys(evidence.generatedMetric).length > 0;
  const metricDifference =
    JSON.stringify(evidence.publishedMetric) !== JSON.stringify(evidence.generatedMetric);
  const ruleDifference =
    JSON.stringify([...evidence.publishedRules].sort()) !==
    JSON.stringify([...evidence.generatedRules].sort());
  const modelDependent = ["information_gain", "product_claims", "coherence"].includes(dimension);

  if (evidence.pipelineOutcome === "blocked" && modelDependent) return "mock_provider_limitation";
  if (
    (dimension === "factual_figures" || dimension === "attribution") &&
    evidence.relevantMentions === 0
  )
    return "expected_editorial_difference";
  if (!checkerCoverage && evidence.relevantMentions > 0)
    return "missing_or_ambiguous_reference_guidance";
  if (!metricsPresent || (ruleDifference && !checkerCoverage))
    return "missing_or_ambiguous_reference_guidance";
  if (metricDifference || ruleDifference) return "expected_editorial_difference";
  return "expected_editorial_difference";
}

function dimensionEvidence(
  dimension: Dimension,
  text: string,
  metric: Record<string, string | number | boolean>,
  findings: Finding[],
  rules: string[],
): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const relevant = (() => {
    switch (dimension) {
      case "structure":
      case "direct_answer":
      case "takeaways":
      case "heading_hierarchy":
      case "information_gain":
      case "coherence":
        return lines.filter((line) => /^#{1,6} |^[-*] /.test(line)).slice(0, 8);
      case "faq":
        return lines.filter((line) => /faq|frequently|\?$/.test(line.toLowerCase())).slice(0, 6);
      case "internal_links":
        return lines.filter((line) => /\]\(https:\/\/www\.mobelaris\.com/.test(line)).slice(0, 6);
      case "factual_figures":
        return lines.filter((line) => figures(line).length > 0).slice(0, 6);
      case "attribution":
        return lines.filter((line) => attributions(`${line}.`).length > 0).slice(0, 6);
      case "on_page_metadata":
        return [];
      default:
        return lines.filter((line) => /keyword|product|chair|table/i.test(line)).slice(0, 6);
    }
  })();
  return excerpt(
    `${JSON.stringify(metric)}; ${findingExcerpt(findings, rules)}${relevant.length ? `; ${relevant.join(" | ")}` : ""}`,
  );
}

function recommendationFor(classification: CalibrationClassification): string {
  if (classification === "mock_provider_limitation")
    return "Repeat this comparison with a terminal production-capable run before drawing conclusions.";
  if (classification === "missing_or_ambiguous_reference_guidance")
    return "Collect labelled editorial evidence and clarify the relevant reference guidance; do not weaken a rule from this observation.";
  if (
    classification === "true_pipeline_false_positive" ||
    classification === "true_pipeline_false_negative"
  )
    return "Submit the labelled rule evidence for editorial review before changing checker behaviour.";
  return "Record this as an editorial difference; no rule or reference change is supported by this observation alone.";
}

function findingExcerpt(findings: Finding[], rules: string[]): string {
  const selected = findings.filter((finding) => rules.includes(finding.rule)).slice(0, 3);
  return selected.length
    ? selected
        .map(
          (finding) =>
            `${finding.rule}@${finding.location.field}${finding.location.line_start ? `:${finding.location.line_start}` : ""}: ${finding.issue}`,
        )
        .join(" | ")
    : "No matching deterministic finding.";
}

export function compareCalibrationPost(
  snapshot: CalibrationSnapshot,
  generated: GeneratedCalibrationDocument,
): CalibrationPostResult {
  const config = CALIBRATION_POSTS.find((post) => post.slot === snapshot.slot)!;
  const publishedBody = `# ${snapshot.title.replace(/ \| Mobelaris$/, "")}\n\n${snapshot.article_markdown}`;
  const publishedOnPage: CheckerInput["on_page"] = {
    meta_title: snapshot.title.replace(/ \| Mobelaris$/, ""),
    meta_description: snapshot.meta_description,
    slug: config.slug,
    og_title: snapshot.title.replace(/ \| Mobelaris$/, ""),
    og_description: snapshot.meta_description,
    images: snapshot.safe_metadata.image_url
      ? [
          {
            alt: snapshot.title,
            filename:
              new URL(snapshot.safe_metadata.image_url).pathname.split("/").at(-1) ?? "image",
          },
        ]
      : [],
    faqs: [],
  };
  const publishedFixture = {
    internal_origins: generated.fixture.internal_origins,
    verified_internal_links: links(snapshot.article_markdown).map((url) => ({
      url,
      status: 200,
      hierarchy: "product" as const,
      hierarchy_rank: 4,
    })),
  };
  const publishedInput = checkerInput(
    publishedBody,
    snapshot.title.replace(/ \| Mobelaris$/, ""),
    snapshot.meta_description,
    config.slug,
    config.primary_keyword,
    [config.related_keyword],
    publishedOnPage,
    publishedFixture,
  );
  const generatedInput = checkerInput(
    generated.draft.markdown,
    generated.draft.title,
    generated.draft.meta_description,
    generated.draft.slug,
    generated.handoff.primary_keyword,
    generated.handoff.related_keywords,
    {
      meta_title: generated.draft.title,
      meta_description: generated.draft.meta_description,
      slug: generated.draft.slug,
      og_title: generated.draft.og_title,
      og_description: generated.draft.og_description,
      // Project to the checker's strict image shape, as mapDeterministicInput
      // does: placement is draft-owned and not a checker input.
      images: generated.draft.images.map(({ alt, filename }) => ({ alt, filename })),
      faqs: generated.draft.faqs,
    },
    generated.fixture,
  );
  const publishedFindings = runDeterministicChecks(publishedInput);
  const generatedFindings = runDeterministicChecks(generatedInput);
  const observations: CalibrationObservation[] = DIMENSIONS.map((dimension) => {
    const publishedRules = findingRules(publishedFindings, dimension);
    const generatedRules = findingRules(generatedFindings, dimension);
    const publishedMetric = metrics(dimension, publishedBody, publishedInput, publishedFindings);
    const generatedMetric = metrics(
      dimension,
      generated.draft.markdown,
      generatedInput,
      generatedFindings,
    );
    const relevantMentions =
      dimension === "factual_figures"
        ? figures(publishedBody).length + figures(generated.draft.markdown).length
        : dimension === "attribution"
          ? attributions(publishedBody).length + attributions(generated.draft.markdown).length
          : 0;
    const classification = classifyCalibrationEvidence(dimension, {
      checkerRuleSet: RULES[dimension],
      publishedRules,
      generatedRules,
      publishedMetric,
      generatedMetric,
      pipelineOutcome: generated.pipeline_outcome,
      relevantMentions,
    });
    return {
      dimension,
      classification,
      summary: `${dimension.replaceAll("_", " ")} comparison derived from recorded metrics and checker evidence; it does not assert a true false-positive or false-negative without labelled ground truth.`,
      metrics: {
        published: publishedMetric,
        generated: generatedMetric,
        published_rule_ids: publishedRules,
        generated_rule_ids: generatedRules,
      },
      evidence: [
        {
          source: "published_snapshot" as const,
          citation: `snapshot:${snapshot.content_hash}:${dimension}`,
          excerpt: dimensionEvidence(
            dimension,
            publishedBody,
            publishedMetric,
            publishedFindings,
            publishedRules,
          ),
        },
        {
          source: "generated_pipeline" as const,
          citation: `run:${generated.pipeline_run_id}:document:${generated.final_document_version_id}:${dimension}`,
          excerpt: dimensionEvidence(
            dimension,
            generated.draft.markdown,
            generatedMetric,
            generatedFindings,
            generatedRules,
          ),
        },
      ],
      recommendation: recommendationFor(classification),
    };
  });
  return CalibrationPostResultSchema.parse({
    slot: snapshot.slot,
    snapshot_hash: snapshot.content_hash,
    pipeline_run_id: generated.pipeline_run_id,
    final_document_version_id: generated.final_document_version_id,
    export_id: generated.export_id,
    pipeline_outcome: generated.pipeline_outcome,
    pipeline_outcome_code:
      generated.pipeline_outcome === "succeeded" ? "PIPELINE_EXPORTED" : "DETERMINISTIC_BLOCKER",
    handoff: generated.handoff,
    generated_content_hash: sha256(generated.draft.markdown),
    generated_markdown: generated.draft.markdown,
    generated_on_page: {
      meta_title: generated.draft.title,
      meta_description: generated.draft.meta_description,
      slug: generated.draft.slug,
      faqs: generated.draft.faqs,
    },
    published_findings: publishedFindings,
    generated_findings: generatedFindings,
    observations,
    // A single post cannot establish the repeated cross-post evidence required for a proposal.
    proposed_reference_changes: [],
  });
}
