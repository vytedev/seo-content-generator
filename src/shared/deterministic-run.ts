import { z, ZodError } from "zod";
import {
  CheckerInputSchema,
  FindingSchema,
  InternalLinkHierarchySchema,
  type CheckerInput,
  type Finding,
} from "./checker/contracts.js";
import { CHECKER_REGISTRY } from "./checker/registry.js";
import { RULE_INVENTORY_V1 } from "./checker/v1/inventory.js";
import { RULE_INVENTORY_V2 } from "./checker/v2/inventory.js";
import { HandoffSchema } from "./pipeline.js";
import { InternalLinkSchema } from "./milestone-two.js";

export const DETERMINISTIC_MANIFEST_SCHEMA_VERSION = "1.0.0";
/** Historical checker version; its behaviour and fingerprints are frozen. */
export const DETERMINISTIC_CHECKER_VERSION_V1 = "1.0.0";
/** Current checker version used for new runs (v1 plus the editorial blockers). */
export const DETERMINISTIC_CHECKER_VERSION_V2 = "2.0.0";
export const DETERMINISTIC_CHECKER_VERSION = DETERMINISTIC_CHECKER_VERSION_V2;
/** Every version a frozen manifest may legitimately record. */
export const DETERMINISTIC_SUPPORTED_CHECKER_VERSIONS = [
  DETERMINISTIC_CHECKER_VERSION_V1,
  DETERMINISTIC_CHECKER_VERSION_V2,
] as const;
export const DETERMINISTIC_INPUT_VERSION = "1.0.0";
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);

export const DETERMINISTIC_RULE_INVENTORY_V1 = RULE_INVENTORY_V1;
export const DETERMINISTIC_RULE_INVENTORY_V2 = RULE_INVENTORY_V2;
export const DETERMINISTIC_RULE_INVENTORY = DETERMINISTIC_RULE_INVENTORY_V2;

/** Explicit immutable implementation dependency signatures; changes require v2. */
export const DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1 = Object.freeze({
  executable: "checker-v1-rules@1",
  parser: "commonmark-mdast-structural-path@1",
  url_canonicalisation: "internal-url-origin-tracking-sort-trailing-slash@1",
  finding_identity: "fnv1a-rule-path-subject-occurrence@1",
  readability: "flesch-kincaid-approximation@1",
  policy_data: "provisional-language-and-repeated-adjective@1",
});

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function deterministicHash(value: unknown): string {
  const input = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const words: number[] = [],
    bitLength = input.length * 8;
  const paddedLength = ((input.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  const k: number[] = [];
  let candidate = 2;
  const prime = (n: number) => {
    for (let d = 2; d * d <= n; d += 1) if (n % d === 0) return false;
    return true;
  };
  while (k.length < 64) {
    if (prime(candidate)) k.push(((Math.pow(candidate, 1 / 3) % 1) * 0x100000000) >>> 0);
    candidate += 1;
  }
  let h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!,
        b = words[i - 2]!;
      words[i] =
        ((r(a, 7) ^ r(a, 18) ^ (a >>> 3)) +
          words[i - 16]! +
          (r(b, 17) ^ r(b, 19) ^ (b >>> 10)) +
          words[i - 7]!) >>>
        0;
    }
    let [a, b, c, d, e, f, g, q] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (q! + (r(e!, 6) ^ r(e!, 11) ^ r(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + k[i]! + words[i]!) >>>
        0;
      const t2 = ((r(a!, 2) ^ r(a!, 13) ^ r(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      q = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h = h.map((x, i) => (x + [a, b, c, d, e, f, g, q][i]!) >>> 0);
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** v2 signatures: the executable is the additive v2 composition over frozen v1. */
export const DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V2 = Object.freeze({
  ...DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1,
  executable: "checker-v2-rules@1",
  editorial_integrity: "dangling-title-and-faq-pair-permutation@1",
});

export const DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1 =
  "72c368a93c53adc1dcf502babb8ed8f8b0a4a8075a02b323af78a21dd61b7980";
export const DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1 =
  "443a945e0c35d8b704e4fa220806b7ea41abb651c7f5d75bf5386df7dd1fecaa";
const RUNNER_V1_BUILD_MATERIAL = {
  // Pinned to v1 explicitly: this material must not move when the current
  // version advances, or v1's historical build id would silently change.
  checker_version: DETERMINISTIC_CHECKER_VERSION_V1,
  input_version: DETERMINISTIC_INPUT_VERSION,
  rule_descriptors_hash: DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1,
  implementation_signatures_hash: DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1,
};
export const DETERMINISTIC_RULE_DESCRIPTORS_HASH_V2 = deterministicHash(RULE_INVENTORY_V2);
export const DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V2 = deterministicHash(
  DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V2,
);
const RUNNER_V2_BUILD_MATERIAL = {
  checker_version: DETERMINISTIC_CHECKER_VERSION_V2,
  input_version: DETERMINISTIC_INPUT_VERSION,
  rule_descriptors_hash: DETERMINISTIC_RULE_DESCRIPTORS_HASH_V2,
  implementation_signatures_hash: DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V2,
};
export const DETERMINISTIC_BUILD_ID_V2 = deterministicHash(RUNNER_V2_BUILD_MATERIAL);
export const DETERMINISTIC_BUILD_ID =
  "9da8aadc50849eeac929789cdfbe1ebfad83b944bc53a49bb98e975036408d70";
export function assertDeterministicBuildId(): void {
  if (
    DETERMINISTIC_RULE_DESCRIPTORS_HASH_V1 !== deterministicHash(DETERMINISTIC_RULE_INVENTORY_V1) ||
    DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V1 !==
      deterministicHash(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V1) ||
    DETERMINISTIC_BUILD_ID !== deterministicHash(RUNNER_V1_BUILD_MATERIAL)
  )
    throw new Error("Deterministic v1 fingerprint is stale; create v2 for behavioural changes");
  if (
    DETERMINISTIC_RULE_DESCRIPTORS_HASH_V2 !== deterministicHash(DETERMINISTIC_RULE_INVENTORY_V2) ||
    DETERMINISTIC_IMPLEMENTATION_SIGNATURES_HASH_V2 !==
      deterministicHash(DETERMINISTIC_IMPLEMENTATION_SIGNATURES_V2) ||
    DETERMINISTIC_BUILD_ID_V2 !== deterministicHash(RUNNER_V2_BUILD_MATERIAL)
  )
    throw new Error("Deterministic v2 fingerprint is stale; create v3 for behavioural changes");
}

export const DeterministicRuleSchema = z
  .object({ id: text, applicability: text, parameters: z.record(z.string(), z.unknown()) })
  .strict();
export const DeterministicReferenceSchema = z
  .object({
    kind: text,
    version_id: text,
    immutable_pointer: text,
    content_hash: hashSchema,
    content: z.string(),
    executable: z.literal(false),
  })
  .strict();
export const DeterministicFixtureSnapshotSchema = z
  .object({
    source_identity: text,
    content_hash: hashSchema,
    content: z
      .object({
        internal_origins: z.array(z.string().url()).min(1),
        link_verification: z.array(
          z
            .object({
              url: z.string().url(),
              status: z.number().int(),
              hierarchy: InternalLinkHierarchySchema,
              hierarchy_rank: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
export const DeterministicArtifactSnapshotSchema = z
  .object({
    artifact_id: text,
    content_hash: hashSchema,
    body_text: z.string(),
    body: z.array(InternalLinkSchema),
    metadata_artifact_id: text.nullable(),
    metadata_content_hash: hashSchema.nullable(),
    metadata_body_text: z.string().nullable(),
    metadata: z.unknown().nullable(),
  })
  .strict();
export const DeterministicFrozenContextSchema = z
  .object({
    primary_keyword: text,
    related_keywords: z.array(text).min(1),
    internal_origins: z.array(z.string().url()).min(1),
    verified_internal_links: z.array(
      z
        .object({
          url: z.string().url(),
          status: z.number().int(),
          hierarchy: InternalLinkHierarchySchema,
          hierarchy_rank: z.number().int(),
        })
        .strict(),
    ),
    handoff: HandoffSchema,
    fixture: DeterministicFixtureSnapshotSchema,
    internal_links_artifact: DeterministicArtifactSnapshotSchema,
  })
  .strict();

export const DeterministicManifestSchema = z
  .object({
    schema_version: z.literal(DETERMINISTIC_MANIFEST_SCHEMA_VERSION),
    checker_version: z.enum(DETERMINISTIC_SUPPORTED_CHECKER_VERSIONS),
    input_version: z.literal(DETERMINISTIC_INPUT_VERSION),
    build_id: hashSchema,
    run_id: text,
    baseline_document: z.object({ id: text, content_hash: hashSchema }).strict(),
    handoff_hash: hashSchema,
    frozen_context: DeterministicFrozenContextSchema,
    frozen_context_hash: hashSchema,
    shortlist_hash: hashSchema,
    references: z.array(DeterministicReferenceSchema),
    references_hash: hashSchema,
    rule_inventory: z.array(DeterministicRuleSchema),
    rule_inventory_hash: hashSchema,
    config_hash: hashSchema,
    producing_execution_id: text,
    executed_at: z.string().datetime({ offset: true }),
    manifest_hash: hashSchema,
  })
  .strict();
export type DeterministicManifest = z.infer<typeof DeterministicManifestSchema>;
const EvaluationSchema = z
  .object({ rule_id: text, status: z.enum(["evaluated", "skipped"]), reason: text.optional() })
  .strict()
  .superRefine((v, c) => {
    if (v.status === "skipped" && !v.reason)
      c.addIssue({ code: "custom", message: "Skipped rules require a reason" });
  });
export const DeterministicComparisonSchema = z
  .object({
    resolved: z.array(text),
    retained: z.array(text),
    introduced: z.array(text),
    retained_blockers: z.array(text),
    introduced_blockers: z.array(text),
  })
  .strict();
export const DeterministicRunResultSchema = z
  .object({
    checker_version: z.enum(DETERMINISTIC_SUPPORTED_CHECKER_VERSIONS),
    input_version: z.literal(DETERMINISTIC_INPUT_VERSION),
    runner_build_id: hashSchema,
    document_id: text,
    document_hash: hashSchema,
    baseline_manifest_hash: hashSchema,
    rule_evaluations: z.array(EvaluationSchema),
    config_hash: hashSchema,
    findings: z.array(FindingSchema),
    findings_hash: hashSchema,
    result_hash: hashSchema,
    comparison: DeterministicComparisonSchema.optional(),
  })
  .strict();
export type DeterministicRunResult = z.infer<typeof DeterministicRunResultSchema>;

export class DeterministicManifestMismatchError extends Error {
  override readonly name = "DeterministicManifestMismatchError";
  readonly code = "DETERMINISTIC_MANIFEST_MISMATCH";
  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Step 1.11 baseline manifest mismatch: ${reason}`, options);
  }
}
const mismatchParse = <T>(schema: z.ZodType<T>, raw: unknown, reason: string): T => {
  try {
    return schema.parse(raw);
  } catch (cause) {
    throw new DeterministicManifestMismatchError(reason, { cause });
  }
};
const configFor = (inventory: unknown, buildId: string, checkerVersion: string) => ({
  checker_version: checkerVersion,
  input_version: DETERMINISTIC_INPUT_VERSION,
  build_id: buildId,
  inventory,
});

export function createDeterministicManifest(input: {
  run_id: string;
  document: { id: string; content_hash: string };
  handoff: z.infer<typeof HandoffSchema>;
  checker_input: CheckerInput;
  fixture: z.infer<typeof DeterministicFixtureSnapshotSchema>;
  internal_links_artifact: z.infer<typeof DeterministicArtifactSnapshotSchema>;
  references: z.infer<typeof DeterministicReferenceSchema>[];
  producing_execution_id: string;
  executed_at: string;
}): DeterministicManifest {
  assertDeterministicBuildId();
  const checker = CheckerInputSchema.parse(input.checker_input),
    handoff = HandoffSchema.parse(input.handoff);
  const frozen = DeterministicFrozenContextSchema.parse({
    primary_keyword: checker.primary_keyword,
    related_keywords: checker.related_keywords,
    internal_origins: checker.internal_origins,
    verified_internal_links: checker.verified_internal_links,
    handoff,
    fixture: input.fixture,
    internal_links_artifact: input.internal_links_artifact,
  });
  const inventory = DETERMINISTIC_RULE_INVENTORY.map((v) => ({ ...v }));
  const core = {
    schema_version: DETERMINISTIC_MANIFEST_SCHEMA_VERSION,
    checker_version: DETERMINISTIC_CHECKER_VERSION,
    input_version: DETERMINISTIC_INPUT_VERSION,
    build_id: DETERMINISTIC_BUILD_ID_V2,
    run_id: input.run_id,
    baseline_document: input.document,
    handoff_hash: deterministicHash(handoff),
    frozen_context: frozen,
    frozen_context_hash: deterministicHash(frozen),
    shortlist_hash: deterministicHash(frozen.internal_links_artifact),
    references: input.references,
    references_hash: deterministicHash(input.references),
    rule_inventory: inventory,
    rule_inventory_hash: deterministicHash(inventory),
    config_hash: deterministicHash(
      configFor(inventory, DETERMINISTIC_BUILD_ID_V2, DETERMINISTIC_CHECKER_VERSION),
    ),
    producing_execution_id: input.producing_execution_id,
    executed_at: input.executed_at,
  };
  return DeterministicManifestSchema.parse({ ...core, manifest_hash: deterministicHash(core) });
}

export function validateDeterministicManifest(
  raw: unknown,
  expected: { run_id: string; handoff?: unknown },
): DeterministicManifest {
  const m = mismatchParse(DeterministicManifestSchema, raw, "schema");
  try {
    const { manifest_hash: _, ...core } = m;
    const checks: Array<[boolean, string]> = [
      [m.manifest_hash === deterministicHash(core), "manifest_hash"],
      [m.run_id === expected.run_id, "run_lineage"],
      [m.handoff_hash === deterministicHash(m.frozen_context.handoff), "embedded_handoff_hash"],
      [
        expected.handoff === undefined || m.handoff_hash === deterministicHash(expected.handoff),
        "handoff_hash",
      ],
      [m.frozen_context_hash === deterministicHash(m.frozen_context), "frozen_context_hash"],
      [
        m.shortlist_hash === deterministicHash(m.frozen_context.internal_links_artifact),
        "shortlist_artifact_hash",
      ],
      [
        m.frozen_context.fixture.content_hash ===
          deterministicHash(m.frozen_context.fixture.content),
        "fixture_hash",
      ],
      [
        m.frozen_context.internal_links_artifact.content_hash ===
          deterministicHash(m.frozen_context.internal_links_artifact.body_text) &&
          canonicalJson(m.frozen_context.internal_links_artifact.body) ===
            canonicalJson(JSON.parse(m.frozen_context.internal_links_artifact.body_text)),
        "shortlist_body_hash",
      ],
      [
        m.frozen_context.internal_links_artifact.metadata_body_text === null
          ? m.frozen_context.internal_links_artifact.metadata === null &&
            m.frozen_context.internal_links_artifact.metadata_content_hash === null
          : m.frozen_context.internal_links_artifact.metadata_content_hash ===
              deterministicHash(m.frozen_context.internal_links_artifact.metadata_body_text) &&
            canonicalJson(m.frozen_context.internal_links_artifact.metadata) ===
              canonicalJson(
                JSON.parse(m.frozen_context.internal_links_artifact.metadata_body_text),
              ),
        "shortlist_metadata_hash",
      ],
      [
        m.references.every((r) => r.content_hash === deterministicHash(r.content)),
        "reference_content_hash",
      ],
      [m.references_hash === deterministicHash(m.references), "references_hash"],
      [m.rule_inventory_hash === deterministicHash(m.rule_inventory), "rule_inventory_hash"],
      [
        m.config_hash ===
          deterministicHash(configFor(m.rule_inventory, m.build_id, m.checker_version)),
        "config_hash",
      ],
    ];
    const runner = RUNNER_REGISTRY[m.checker_version];
    checks.push(
      [Boolean(runner), "runner_version"],
      [runner?.build_id === m.build_id, "runner_build_id"],
      [canonicalJson(runner?.inventory) === canonicalJson(m.rule_inventory), "runner_inventory"],
    );
    const failed = checks.find(([ok]) => !ok);
    if (failed) throw new DeterministicManifestMismatchError(failed[1]);
    return m;
  } catch (cause) {
    if (cause instanceof DeterministicManifestMismatchError) throw cause;
    throw new DeterministicManifestMismatchError("artefact_validation", { cause });
  }
}

export function validateDeterministicBaseline(
  manifest: DeterministicManifest,
  raw: unknown,
): DeterministicRunResult {
  const result = mismatchParse(DeterministicRunResultSchema, raw, "baseline_result_schema");
  const { result_hash: _, comparison: __, ...core } = result;
  const checks: Array<[boolean, string]> = [
    [!result.comparison, "baseline_comparison"],
    [result.result_hash === deterministicHash(core), "baseline_result_hash"],
    [result.findings_hash === deterministicHash(result.findings), "baseline_findings_hash"],
    [result.baseline_manifest_hash === manifest.manifest_hash, "baseline_manifest_link"],
    [
      result.document_id === manifest.baseline_document.id &&
        result.document_hash === manifest.baseline_document.content_hash,
      "baseline_document_link",
    ],
    [result.config_hash === manifest.config_hash, "baseline_config_link"],
    [result.runner_build_id === manifest.build_id, "baseline_build_link"],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new DeterministicManifestMismatchError(failed[1]);
  return result;
}

export function checkerInputFromManifest(
  manifest: DeterministicManifest,
  current: Pick<CheckerInput, "body_markdown" | "on_page">,
): CheckerInput {
  return mismatchParse(
    CheckerInputSchema,
    {
      primary_keyword: manifest.frozen_context.primary_keyword,
      related_keywords: manifest.frozen_context.related_keywords,
      internal_origins: manifest.frozen_context.internal_origins,
      verified_internal_links: manifest.frozen_context.verified_internal_links,
      ...current,
    },
    "checker_input",
  );
}

type Runner = {
  build_id: string;
  inventory: readonly unknown[];
  run(input: CheckerInput): {
    findings: Finding[];
    evaluations: Array<{
      rule_id: string;
      status: "evaluated" | "skipped";
      reason?: string;
    }>;
  };
};
const runnerV1: Runner = {
  build_id: DETERMINISTIC_BUILD_ID,
  inventory: DETERMINISTIC_RULE_INVENTORY_V1,
  run(input) {
    const { findings, evaluations } = CHECKER_REGISTRY["1.0.0"]!.run(input);
    const allowed = new Set(DETERMINISTIC_RULE_INVENTORY_V1.map((r) => r.id));
    const outside = findings.find((f) => !allowed.has(f.rule as never));
    if (outside)
      throw new DeterministicManifestMismatchError(
        `runtime_rule_outside_inventory:${outside.rule}`,
      );
    return { findings, evaluations };
  },
};
const runnerV2: Runner = {
  build_id: DETERMINISTIC_BUILD_ID_V2,
  inventory: DETERMINISTIC_RULE_INVENTORY_V2,
  run(input) {
    const { findings, evaluations } =
      CHECKER_REGISTRY[DETERMINISTIC_CHECKER_VERSION_V2]!.run(input);
    const allowed = new Set(DETERMINISTIC_RULE_INVENTORY_V2.map((r) => r.id));
    const outside = findings.find((f) => !allowed.has(f.rule as never));
    if (outside)
      throw new DeterministicManifestMismatchError(
        `runtime_rule_outside_inventory:${outside.rule}`,
      );
    return { findings, evaluations };
  },
};
export const RUNNER_REGISTRY: Readonly<Record<string, Runner>> = Object.freeze({
  [DETERMINISTIC_CHECKER_VERSION_V1]: Object.freeze(runnerV1),
  [DETERMINISTIC_CHECKER_VERSION_V2]: Object.freeze(runnerV2),
});

export function runVersionedDeterministicChecks(
  input: CheckerInput,
  document: { id: string; content_hash: string },
  manifest: DeterministicManifest,
): DeterministicRunResult {
  const validated = validateDeterministicManifest(manifest, { run_id: manifest.run_id });
  const runner = RUNNER_REGISTRY[validated.checker_version];
  if (!runner) throw new DeterministicManifestMismatchError("runner_version");
  const parsed = mismatchParse(CheckerInputSchema, input, "runner_input");
  const { findings, evaluations } = runner.run(parsed);
  if (
    new Set(evaluations.map((e) => e.rule_id)).size !== validated.rule_inventory.length ||
    evaluations.length !== validated.rule_inventory.length
  )
    throw new DeterministicManifestMismatchError("rule_evaluation_coverage");
  const core = {
    checker_version: validated.checker_version,
    input_version: validated.input_version,
    runner_build_id: runner.build_id,
    document_id: document.id,
    document_hash: document.content_hash,
    baseline_manifest_hash: validated.manifest_hash,
    rule_evaluations: evaluations,
    config_hash: validated.config_hash,
    findings,
    findings_hash: deterministicHash(findings),
  };
  return mismatchParse(
    DeterministicRunResultSchema,
    { ...core, result_hash: deterministicHash(core) },
    "runner_result",
  );
}

function occurrenceIds(findings: Finding[]): Map<string, Finding> {
  const counts = new Map<string, number>(),
    out = new Map<string, Finding>();
  for (const f of findings) {
    const n = (counts.get(f.id) ?? 0) + 1;
    counts.set(f.id, n);
    out.set(n === 1 ? f.id : `${f.id}#${n}`, f);
  }
  return out;
}
export function compareDeterministicResults(baseline: Finding[], current: Finding[]) {
  const before = occurrenceIds(baseline),
    after = occurrenceIds(current);
  const resolved = [...before.keys()].filter((id) => !after.has(id)).sort(),
    retained = [...after.keys()].filter((id) => before.has(id)).sort(),
    introduced = [...after.keys()].filter((id) => !before.has(id)).sort();
  return DeterministicComparisonSchema.parse({
    resolved,
    retained,
    introduced,
    retained_blockers: retained.filter((id) => after.get(id)?.severity === "blocker"),
    introduced_blockers: introduced.filter((id) => after.get(id)?.severity === "blocker"),
  });
}

// Keep the import visible in diagnostics while all boundary failures are normalised above.
void ZodError;
