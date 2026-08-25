import { Check } from "lucide-react";
import {
  CALIBRATION_POSTS,
  type CalibrationCombinedReport,
  type CalibrationPostResult,
} from "../../../shared/contracts/calibration.js";

const classificationLabels = {
  true_pipeline_false_positive: "Pipeline false positive",
  true_pipeline_false_negative: "Pipeline false negative",
  expected_editorial_difference: "Expected editorial difference",
  missing_or_ambiguous_reference_guidance: "Missing or ambiguous guidance",
  mock_provider_limitation: "Mock provider limitation",
  recommended_rule_or_reference_adjustment: "Rule or reference adjustment",
} as const;

export function CalibrationReport({
  results,
  report,
}: {
  results: CalibrationPostResult[];
  report: CalibrationCombinedReport;
}) {
  return (
    <section aria-labelledby="comparison-heading" className="mt-12">
      <div className="border-b border-rule pb-3">
        <p className="font-sans text-xs font-semibold uppercase tracking-[0.12em] text-warning">
          Provisional · Aaron approval required
        </p>
        <h2 id="comparison-heading" className="mt-1 text-h2 font-semibold">
          Post comparison
        </h2>
        <p className="mt-2 max-w-[72ch] text-sm text-muted">
          Calibration findings are recommendations for editorial review. They do not change active
          rules or references.
        </p>
      </div>

      <div className="mt-6 grid gap-8 2xl:grid-cols-2">
        {results.map((result) => (
          <PostComparison key={result.slot} result={result} />
        ))}
      </div>

      <CombinedFindings report={report} />
    </section>
  );
}

function PostComparison({ result }: { result: CalibrationPostResult }) {
  const post = result.slot === 1 ? CALIBRATION_POSTS[0] : CALIBRATION_POSTS[1];
  return (
    <article
      aria-labelledby={`post-${result.slot}-heading`}
      className="min-w-0 border-t-2 border-ink pt-4"
    >
      <p className="text-xs font-semibold tracking-[0.08em] text-muted uppercase">
        Post {result.slot}
      </p>
      <h3 id={`post-${result.slot}-heading`} className="mt-1 text-h3 font-semibold">
        {post.generated_title}
      </h3>
      <a
        href={post.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1 block break-all text-sm font-semibold text-action underline underline-offset-4 hover:text-action-hover"
      >
        {post.url}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <dl className="mt-4 grid gap-x-4 gap-y-2 border-y border-rule py-3 text-sm sm:grid-cols-2">
        <Meta label="Pipeline run" value={result.pipeline_run_id} mono />
        <Meta
          label="Outcome"
          value={result.pipeline_outcome === "succeeded" ? "Succeeded" : "Blocked"}
        />
      </dl>
      <details className="border-b border-rule py-3">
        <summary className="cursor-pointer text-sm font-semibold">
          Latest generated markdown summary
        </summary>
        <p className="mt-2 max-w-[72ch] font-serif text-document whitespace-pre-wrap">
          {markdownSummary(result.generated_markdown)}
        </p>
      </details>
      <DimensionTable result={result} />
    </article>
  );
}

function DimensionTable({ result }: { result: CalibrationPostResult }) {
  return (
    <div
      className="mt-6 overflow-x-auto"
      tabIndex={0}
      aria-label={`Post ${result.slot} dimension comparison table`}
    >
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption className="mb-3 text-left font-semibold">14 calibration dimensions</caption>
        <thead>
          <tr className="border-y border-rule bg-subtle">
            <th scope="col" className="px-3 py-2">
              Dimension and classification
            </th>
            <th scope="col" className="px-3 py-2">
              Metrics
            </th>
            <th scope="col" className="px-3 py-2">
              Evidence
            </th>
            <th scope="col" className="px-3 py-2">
              Recommendation
            </th>
          </tr>
        </thead>
        <tbody className="align-top">
          {result.observations.map((observation) => (
            <tr key={observation.dimension} className="border-b border-rule">
              <th scope="row" className="w-[22%] px-3 py-4 font-semibold">
                {humanise(observation.dimension)}
                <span className="mt-1 block font-normal text-muted">
                  {classificationLabels[observation.classification]}
                </span>
              </th>
              <td className="w-[20%] px-3 py-4">
                <MetricList label="Published" values={observation.metrics.published} />
                <MetricList label="Generated" values={observation.metrics.generated} />
              </td>
              <td className="w-[32%] px-3 py-4">
                <p>{observation.summary}</p>
                <ul className="mt-2 space-y-2">
                  {observation.evidence.map((item, index) => (
                    <li key={`${item.citation}-${index}`}>
                      <cite className="not-italic font-semibold">{item.citation}</cite>
                      <blockquote className="mt-0.5 text-muted">“{item.excerpt}”</blockquote>
                    </li>
                  ))}
                </ul>
              </td>
              <td className="w-[26%] px-3 py-4">{observation.recommendation}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CombinedFindings({ report }: { report: CalibrationCombinedReport }) {
  return (
    <section aria-labelledby="combined-heading" className="mt-12 border-t-2 border-ink pt-4">
      <h2 id="combined-heading" className="text-h2 font-semibold">
        Combined findings
      </h2>
      <div className="mt-4 grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="text-h3 font-semibold">Classification counts</h3>
          <dl className="mt-2 divide-y divide-rule border-y border-rule">
            {Object.entries(report.classification_counts).map(([name, count]) => (
              <div key={name} className="flex justify-between gap-4 py-2 text-sm">
                <dt>{classificationLabels[name as keyof typeof classificationLabels]}</dt>
                <dd className="font-mono tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="text-h3 font-semibold">Shared recommendations</h3>
          {report.shared_recommendations.length ? (
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
              {report.shared_recommendations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No shared recommendations were identified.</p>
          )}
        </div>
      </div>
      <section
        aria-labelledby="safety-heading"
        className="mt-8 border-y border-rule bg-subtle px-4 py-4"
      >
        <h3 id="safety-heading" className="text-h3 font-semibold">
          Hard safety invariants remain active
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {report.rule_weakening_prohibited && (
            <SafetyInvariant>Rules cannot be weakened</SafetyInvariant>
          )}
          {report.provenance_remains_hard_flagged && (
            <SafetyInvariant>Provenance remains hard flagged</SafetyInvariant>
          )}
          {report.unresolved_claims_remain_unverified && (
            <SafetyInvariant>Unresolved claims remain unverified</SafetyInvariant>
          )}
        </ul>
      </section>
    </section>
  );
}

function MetricList({
  label,
  values,
}: {
  label: string;
  values: Record<string, string | number | boolean>;
}) {
  const entries = Object.entries(values);
  return (
    <div className="mb-3">
      <span className="font-semibold">{label}</span>
      {entries.length ? (
        <ul className="mt-1 space-y-0.5 text-muted">
          {entries.map(([key, value]) => (
            <li key={key}>
              {humanise(key)}: <span className="tabular-nums text-ink">{String(value)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">No metrics</p>
      )}
    </div>
  );
}

function SafetyInvariant({ children }: { children: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />
      {children}
    </li>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`break-all ${mono ? "font-mono text-xs" : "font-semibold"}`}>{value}</dd>
    </div>
  );
}
function humanise(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
function markdownSummary(markdown: string) {
  const text = markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .trim();
  return text.length > 420 ? `${text.slice(0, 417).trimEnd()}…` : text;
}
