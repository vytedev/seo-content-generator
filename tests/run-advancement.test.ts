import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { createIngestService } from "../src/server/routes/ingest-routes.js";
import { InMemoryMilestoneRepository } from "../src/server/repositories/memory-repository.js";
import {
  MilestoneTwoOrchestrator,
  MockLinkDiscoverer,
} from "../src/server/pipeline/milestone-two.js";
import { MilestoneThreeOrchestrator } from "../src/server/pipeline/milestone-three.js";
import { MilestoneFourOrchestrator } from "../src/server/pipeline/milestone-four.js";
import { PipelineQueueWorker } from "../src/server/pipeline/queue-worker.js";
import { MockDraftProvider } from "../src/server/providers/draft-provider.js";
import { MockReviewProvider } from "../src/server/providers/review-provider.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../src/server/providers/milestone-four-providers.js";
import {
  DEFAULT_BLOG_SCHEMA_TEMPLATE,
  DEFAULT_WRITER_TEMPLATE,
  renderExport,
} from "../src/shared/export.js";

const handoff = {
  plane_ticket: "MOB-321",
  primary_keyword: "wishbone chair",
  related_keywords: ["wishbone chair replica"],
  page_type: "blog",
  word_count_target: 1200,
  locales_for_translation: ["sv-SE"],
};

const fixture = {
  internal_origins: ["https://www.mobelaris.com"],
  link_verification: [
    {
      url: "https://www.mobelaris.com/en/wishbone-chair",
      status: 200,
      hierarchy: "collection" as const,
      hierarchy_rank: 1,
    },
  ],
};

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");

// A deterministic-check-compliant draft so the 1.11 re-run can reach export.
const compliantDraft = {
  title: "Wishbone chair guide".padEnd(55, "x"),
  slug: "wishbone-chair-guide",
  meta_description: "Wishbone chair guidance".padEnd(150, "x"),
  og_title: "Wishbone chair",
  og_description: "Wishbone chair guidance",
  images: [
    {
      alt: "Wishbone chair in oak",
      filename: "wishbone-chair-oak.jpg",
      placement: { marker: "wishbone-chair" },
    },
  ],
  faqs: [1, 2, 3].map((number) => ({ question: `Question ${number}`, answer: words(40) })),
  markdown: [
    "# Wishbone chair guide",
    "<!-- MOBELARIS_IMAGE:wishbone-chair -->",
    `Wishbone chair ${words(38)}`,
    "## Key Takeaways",
    "- Fit matters",
    "- Comfort matters",
    "- Materials matter",
    "## How a wishbone chair fits your room",
    "A [wishbone chair replica](https://www.mobelaris.com/en/wishbone-chair) works when scale and use are clear.",
    "> Measure your room first.",
    "## Conclusion",
    "Choose a chair that fits your room.",
  ].join("\n\n"),
  claims: [
    { text: "It measures 80 cm", type: "dimension" as const, status: "unverified" as const },
  ],
};

function wiredApp(repository = new InMemoryMilestoneRepository()) {
  const milestoneTwo = new MilestoneTwoOrchestrator(
    repository,
    new MockLinkDiscoverer([
      {
        url: "https://www.mobelaris.com/en/wishbone-chair",
        title: "Wishbone chair",
        relevance: 0.9,
      },
    ]),
    new MockDraftProvider("local-no-network", compliantDraft),
  );
  const milestoneThree = new MilestoneThreeOrchestrator(
    repository,
    fixture,
    new MockReviewProvider("local-no-network"),
  );
  const revisionProvider = new MockRevisionProvider("local-no-network");
  const milestoneFour = new MilestoneFourOrchestrator(
    repository,
    fixture,
    revisionProvider,
    new MockCoherenceProvider("local-no-network"),
    repository,
  );
  return {
    repository,
    milestoneTwo,
    milestoneThree,
    milestoneFour,
    revisionProvider,
    app: createApp({
      testOnlySynchronousPipeline: true,
      findingsRepository: repository,
      ingestService: createIngestService(repository),
      commands: repository,
      milestoneTwo: { repository, orchestrator: milestoneTwo },
      milestoneThree: { repository, orchestrator: milestoneThree },
      milestoneFour: { repository, orchestrator: milestoneFour },
    }),
  };
}

describe("live run advancement 1.1 → 1.9 → export", () => {
  it("continues Step 1.10 only through the durable queue after a worker restart", async () => {
    const setup = wiredApp();
    const app = createApp({
      serveClient: false,
      findingsRepository: setup.repository,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      queue: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
      milestoneThree: { repository: setup.repository, orchestrator: setup.milestoneThree },
      milestoneFour: { repository: setup.repository, orchestrator: setup.milestoneFour },
    });
    const milestoneFourRun = vi.spyOn(setup.milestoneFour, "run");
    const orchestrators = {
      milestoneTwo: setup.milestoneTwo,
      milestoneThree: setup.milestoneThree,
      milestoneFour: setup.milestoneFour,
    };
    const firstWorker = new PipelineQueueWorker(
      setup.repository,
      orchestrators,
      "before-findings-restart",
      30_000,
      1,
    );
    await firstWorker.start();
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "queued-step-1-10-restart")
      .send(handoff);
    expect(created.status).toBe(202);
    const runId = created.body.run_id as string;
    await vi.waitFor(async () =>
      expect((await setup.repository.getRunDetail(runId)).status).toBe("waiting"),
    );
    await firstWorker.stop();

    const detail = await setup.repository.getRunDetail(runId);
    const findings = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    const milestoneFourCallsBeforeSubmission = milestoneFourRun.mock.calls.length;
    const submitted = await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: detail.current_document!.version.id,
        idempotency_key: `queued-dispositions-${runId}`,
        dispositions: findings.body.findings.map((finding: { id: string }) => ({
          finding_id: finding.id,
          decision: "accepted",
        })),
      });
    expect(submitted.status).toBe(202);
    expect(submitted.body.queue_accepted).toBe(true);
    expect(setup.revisionProvider.calls).toHaveLength(0);

    const restartedWorker = new PipelineQueueWorker(
      setup.repository,
      orchestrators,
      "after-findings-restart",
      30_000,
      1,
    );
    await restartedWorker.start();
    await vi.waitFor(async () =>
      expect((await setup.repository.getRunDetail(runId)).status).toBe("succeeded"),
    );
    await restartedWorker.stop();

    expect(milestoneFourRun.mock.calls.length).toBeGreaterThan(milestoneFourCallsBeforeSubmission);
    expect(setup.revisionProvider.calls).toHaveLength(1);
    expect(
      (await setup.repository.getRunDetail(runId)).steps.find(
        (step) => step.step === "revision_pass",
      )?.status,
    ).toBe("succeeded");
    expect(setup.repository.queueJobs).toHaveLength(1);
    expect(setup.repository.queueJobs[0]).toMatchObject({ state: "completed", attempt: 1 });
  });

  it("recovers a crashed worker after Step 1.11 persisted without rerunning the gate", async () => {
    let now = 0;
    const repository = new InMemoryMilestoneRepository(300_000, () => now);
    const setup = wiredApp(repository);
    const app = createApp({
      serveClient: false,
      findingsRepository: repository,
      ingestService: createIngestService(repository),
      commands: repository,
      queue: repository,
      milestoneTwo: { repository, orchestrator: setup.milestoneTwo },
      milestoneThree: { repository, orchestrator: setup.milestoneThree },
      milestoneFour: { repository, orchestrator: setup.milestoneFour },
    });
    const initialWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: setup.milestoneFour,
      },
      "step-1-11-initial",
      1_000,
      1,
    );
    await initialWorker.start();
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "queued-step-1-11-takeover")
      .send(handoff)
      .expect(202);
    const runId = created.body.run_id as string;
    await vi.waitFor(async () =>
      expect((await repository.getRunDetail(runId)).status).toBe("waiting"),
    );
    await initialWorker.stop();

    const detail = await repository.getRunDetail(runId);
    const findings = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: detail.current_document!.version.id,
        idempotency_key: `step-1-11-takeover-${runId}`,
        dispositions: findings.body.findings.map((finding: { id: string }) => ({
          finding_id: finding.id,
          decision: "accepted",
        })),
      })
      .expect(202);

    const coherence = new MockCoherenceProvider("step-1-11-takeover");
    const originalSaveRerun = repository.saveRerun.bind(repository);
    let saveRerunCalls = 0;
    repository.saveRerun = async (input) => {
      saveRerunCalls += 1;
      return originalSaveRerun(input);
    };
    const crashedOrchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      setup.revisionProvider,
      coherence,
      repository,
      {
        hit(boundary) {
          if (boundary === "after_rerun_persist") return new Promise<void>(() => undefined);
        },
      },
    );
    const crashedWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: crashedOrchestrator,
      },
      "step-1-11-crashed",
      1_000,
      1,
    );
    await crashedWorker.start();
    await vi.waitFor(async () => {
      const current = await repository.getRunDetail(runId);
      expect(current.current_step).toBe("final_coherence_export");
      expect(current.steps.find((step) => step.step === "automated_checks_rerun")?.status).toBe(
        "succeeded",
      );
    });
    await expect(crashedWorker.stop(5)).resolves.toBe("deadline_exceeded");
    expect(repository.queueJobs[0]).toMatchObject({ state: "leased", attempt: 1 });

    now += 1_001;
    const replacementOrchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      setup.revisionProvider,
      coherence,
      repository,
    );
    const replacementWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: replacementOrchestrator,
      },
      "step-1-11-replacement",
      1_000,
      1,
    );
    await replacementWorker.start();
    await vi.waitFor(async () =>
      expect((await repository.getRunDetail(runId)).status).toBe("succeeded"),
    );
    await replacementWorker.stop();

    expect(repository.deterministicReruns.size).toBe(1);
    expect(saveRerunCalls).toBe(1);
    expect(setup.revisionProvider.calls).toHaveLength(1);
    expect(coherence.calls).toHaveLength(1);
    expect(repository.exports).toHaveLength(1);
    expect(repository.queueJobs[0]).toMatchObject({ state: "completed", attempt: 2 });
  });

  it("takes over a pre-save Step 1.11 crash and rejects the stale worker save", async () => {
    let now = 0;
    const repository = new InMemoryMilestoneRepository(1_000, () => now);
    const setup = wiredApp(repository);
    const app = createApp({
      serveClient: false,
      findingsRepository: repository,
      ingestService: createIngestService(repository),
      commands: repository,
      queue: repository,
      milestoneTwo: { repository, orchestrator: setup.milestoneTwo },
      milestoneThree: { repository, orchestrator: setup.milestoneThree },
      milestoneFour: { repository, orchestrator: setup.milestoneFour },
    });
    const initialWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: setup.milestoneFour,
      },
      "pre-save-initial",
      1_000,
      1,
    );
    await initialWorker.start();
    const created = await request(app)
      .post("/api/runs")
      .set("Idempotency-Key", "queued-step-1-11-pre-save-takeover")
      .send(handoff)
      .expect(202);
    const runId = created.body.run_id as string;
    await vi.waitFor(async () =>
      expect((await repository.getRunDetail(runId)).status).toBe("waiting"),
    );
    await initialWorker.stop();
    const detail = await repository.getRunDetail(runId);
    const findings = await request(app).get(`/api/runs/${runId}/findings`).expect(200);
    await request(app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send({
        document_version_id: detail.current_document!.version.id,
        idempotency_key: `pre-save-takeover-${runId}`,
        dispositions: findings.body.findings.map((finding: { id: string }) => ({
          finding_id: finding.id,
          decision: "accepted",
        })),
      })
      .expect(202);

    let release!: () => void;
    const boundaryReached = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalBoundary!: () => void;
    const enteredBoundary = new Promise<void>((resolve) => {
      signalBoundary = resolve;
    });
    const originalSaveRerun = repository.saveRerun.bind(repository);
    let saveAttempts = 0;
    let staleSaveRejected = false;
    repository.saveRerun = async (input) => {
      saveAttempts += 1;
      try {
        return await originalSaveRerun(input);
      } catch (error) {
        if (saveAttempts > 1 && /Stale fencing token/.test(String(error))) staleSaveRejected = true;
        throw error;
      }
    };
    const crashedOrchestrator = new MilestoneFourOrchestrator(
      repository,
      fixture,
      setup.revisionProvider,
      new MockCoherenceProvider("pre-save-crashed"),
      repository,
      {
        async hit(boundary) {
          if (boundary === "before_rerun_persist") {
            signalBoundary();
            await boundaryReached;
          }
        },
      },
    );
    const crashedWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: crashedOrchestrator,
      },
      "pre-save-crashed",
      1_000,
      1,
    );
    await crashedWorker.start();
    await enteredBoundary;
    expect(repository.deterministicReruns.size).toBe(0);

    now += 1_001;
    const coherence = new MockCoherenceProvider("pre-save-replacement");
    const replacementWorker = new PipelineQueueWorker(
      repository,
      {
        milestoneTwo: setup.milestoneTwo,
        milestoneThree: setup.milestoneThree,
        milestoneFour: new MilestoneFourOrchestrator(
          repository,
          fixture,
          setup.revisionProvider,
          coherence,
          repository,
        ),
      },
      "pre-save-replacement",
      1_000,
      1,
    );
    await replacementWorker.start();
    await vi.waitFor(async () =>
      expect((await repository.getRunDetail(runId)).status).toBe("succeeded"),
    );
    await replacementWorker.stop();
    release();
    await vi.waitFor(() => expect(staleSaveRejected).toBe(true));
    await crashedWorker.stop();

    expect(saveAttempts).toBe(2);
    expect(repository.deterministicReruns.size).toBe(1);
    expect(coherence.calls).toHaveLength(1);
    expect(repository.exports).toHaveLength(1);
    expect(repository.queueJobs[0]).toMatchObject({ state: "completed", attempt: 2 });
  });

  it("ingest auto-runs milestone two then three and stops waiting at 1.9", async () => {
    const setup = wiredApp();
    const milestoneThreeRun = vi.spyOn(setup.milestoneThree, "run");
    const milestoneFourRun = vi.spyOn(setup.milestoneFour, "run");
    const created = await request(setup.app)
      .post("/api/runs")
      .set("Idempotency-Key", "advance-key-1")
      .send(handoff);
    expect(created.status).toBe(201);
    const runId = created.body.run_id;
    // The 201 body reflects ingest only; the run detail shows the advanced state.
    const detail = await request(setup.app).get(`/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("waiting");
    expect(detail.body.current_step).toBe("findings_review");
    expect(milestoneThreeRun).toHaveBeenCalledTimes(1);
    expect(milestoneFourRun).toHaveBeenCalledTimes(1);

    const findings = await request(setup.app).get(`/api/runs/${runId}/findings`);
    expect(findings.status).toBe(200);
    const dispositions = {
      document_version_id: detail.body.current_document.version.id,
      idempotency_key: `advancement-${runId}`,
      dispositions: findings.body.findings.map((finding: { id: string }) => ({
        finding_id: finding.id,
        decision: "accepted",
      })),
    };
    const submitted = await request(setup.app)
      .post(`/api/runs/${runId}/findings/dispositions`)
      .send(dispositions);
    expect(submitted.status).toBe(200);

    const resumed = await request(setup.app).get(`/api/runs/${runId}`);
    expect(resumed.status).toBe(200);
    if (resumed.body.status !== "succeeded") {
      const after = await request(setup.app).get(`/api/runs/${runId}/findings`);
      console.error(
        "advanced run blocked. counts:",
        JSON.stringify(resumed.body.counts),
        "blocker findings:",
        JSON.stringify(
          after.body.findings?.filter(
            (finding: { severity: string }) => finding.severity === "blocker",
          ),
        ),
      );
    }
    expect(resumed.body.status).toBe("succeeded");
    expect(resumed.body.current_step).toBe("final_coherence_export");
    expect(resumed.body.export.external_url).toContain("https://docs.google.local/document/d/");
  });

  it("milestone-two resume chains milestone three exactly once for a stalled run", async () => {
    const setup = wiredApp();
    const milestoneThreeRun = vi.spyOn(setup.milestoneThree, "run");
    const milestoneFourRun = vi.spyOn(setup.milestoneFour, "run");
    // Ingest through an app wired with milestone two only, so the run stalls at
    // 1.4 exactly like a run whose milestone-three pass previously failed.
    const milestoneTwoOnly = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
    });
    const created = await request(milestoneTwoOnly)
      .post("/api/runs")
      .set("Idempotency-Key", "advance-key-2")
      .send(handoff);
    const runId = created.body.run_id;
    const before = await request(milestoneTwoOnly).get(`/api/runs/${runId}`);
    expect(before.body.current_step).toBe("automated_checks");

    const resumed = await request(setup.app)
      .post(`/api/runs/${runId}/milestone-two/resume`)
      .set("Idempotency-Key", "advancement-resume-key");
    expect(resumed.status).toBe(200);
    expect(resumed.body.current_step).toBe("findings_review");
    expect(resumed.body.status).toBe("waiting");
    expect(milestoneThreeRun).toHaveBeenCalledTimes(1);
    expect(milestoneFourRun).toHaveBeenCalledTimes(1);
  });

  it("milestone-three resume invokes milestone-four continuation exactly once", async () => {
    const setup = wiredApp();
    const milestoneTwoOnly = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
    });
    const created = await request(milestoneTwoOnly)
      .post("/api/runs")
      .set("Idempotency-Key", "advance-key-3")
      .send(handoff);
    const milestoneThreeRun = vi.spyOn(setup.milestoneThree, "run");
    const milestoneFourRun = vi.spyOn(setup.milestoneFour, "run");

    const resumed = await request(setup.app)
      .post(`/api/runs/${created.body.run_id}/milestone-three/resume`)
      .set("Idempotency-Key", `advancement-${created.body.run_id}`);

    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("waiting");
    expect(resumed.body.current_step).toBe("findings_review");
    expect(milestoneThreeRun).toHaveBeenCalledTimes(1);
    expect(milestoneFourRun).toHaveBeenCalledTimes(1);
  });

  it("returns persisted milestone-three provider failure detail instead of a generic 500", async () => {
    const setup = wiredApp();
    const milestoneTwoOnly = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
    });
    const created = await request(milestoneTwoOnly)
      .post("/api/runs")
      .set("Idempotency-Key", "m3-persisted-provider-failure")
      .send(handoff);
    const safeError = "Review provider HTTP 403";
    vi.spyOn(setup.milestoneThree, "run").mockImplementation(async (runId) => {
      const lease = await setup.repository.claimStep(runId, "automated_checks", "route-test");
      await setup.repository.failStep(lease.execution_id, lease.token, safeError);
      throw new Error(safeError);
    });

    const resumed = await request(setup.app)
      .post(`/api/runs/${created.body.run_id}/milestone-three/resume`)
      .set("Idempotency-Key", `advancement-${created.body.run_id}`);

    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      run_id: created.body.run_id,
      status: "retryable_failed",
      current_step: "automated_checks",
    });
    expect(resumed.body.steps).toContainEqual(
      expect.objectContaining({
        step: "automated_checks",
        status: "retryable_failed",
        error: safeError,
      }),
    );
  });

  it("propagates an unpersisted milestone-three error while the run remains running", async () => {
    const setup = wiredApp();
    const milestoneTwoOnly = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
    });
    const created = await request(milestoneTwoOnly)
      .post("/api/runs")
      .set("Idempotency-Key", "m3-unpersisted-failure")
      .send(handoff);
    vi.spyOn(setup.milestoneThree, "run").mockRejectedValue(new Error("raw internal failure"));

    const resumed = await request(setup.app)
      .post(`/api/runs/${created.body.run_id}/milestone-three/resume`)
      .set("Idempotency-Key", `advancement-${created.body.run_id}`);

    expect(resumed.status).toBe(500);
    expect(resumed.body.error).toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await setup.repository.getRunDetail(created.body.run_id)).status).toBe("running");
  });

  it("returns authoritative cancelled detail when cancellation wins a resume error", async () => {
    const setup = wiredApp();
    const milestoneTwoOnly = createApp({
      testOnlySynchronousPipeline: true,
      ingestService: createIngestService(setup.repository),
      commands: setup.repository,
      milestoneTwo: { repository: setup.repository, orchestrator: setup.milestoneTwo },
    });
    const created = await request(milestoneTwoOnly)
      .post("/api/runs")
      .set("Idempotency-Key", "m3-cancelled-resume")
      .send(handoff);
    vi.spyOn(setup.milestoneThree, "run").mockImplementation(async (runId) => {
      await setup.repository.cancelRun(runId);
      throw new Error("provider completed after cancellation");
    });

    const resumed = await request(setup.app)
      .post(`/api/runs/${created.body.run_id}/milestone-three/resume`)
      .set("Idempotency-Key", `advancement-${created.body.run_id}`);

    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "cancelled", can_retry: false });
  });
});

describe("renderExport completeness (step 1.12 artefact)", () => {
  const templates = {
    writer_template: DEFAULT_WRITER_TEMPLATE,
    schema_template: DEFAULT_BLOG_SCHEMA_TEMPLATE,
  };
  const draft = {
    title: "Wishbone chair",
    slug: "wishbone-chair",
    meta_description:
      "A clear guide to the wishbone chair, its materials and what to check before buying.",
    og_title: "Wishbone chair",
    og_description: "A clear guide to the wishbone chair.",
    images: [
      {
        alt: "Wishbone chair in oak",
        filename: "wishbone-chair-oak.jpg",
        placement: { marker: "wishbone-chair" },
      },
    ],
    faqs: [{ question: "Is it solid oak?", answer: "Most replicas use steamed oak." }],
    markdown:
      "# Wishbone chair\n\n<!-- MOBELARIS_IMAGE:wishbone-chair -->\n\nA guide to the wishbone chair.",
    claims: [{ text: "Oak frame", type: "material", status: "unverified" }],
  };

  it("renders the metadata block, images, FAQ, schema and claim table", () => {
    const rendered = renderExport({
      plane_ticket: "MOB-321",
      draft,
      ...templates,
      primary_keyword: "wishbone chair",
      related_keywords: ["wishbone chair replica"],
      page_type: "blog",
      locales_for_translation: ["sv-SE"],
      export_date: "2026-08-20",
      internal_links: [
        {
          url: "https://www.mobelaris.com/blogs/furniture-guides",
          title: "Mobelaris furniture guides",
          relevance: 0.9,
        },
      ],
      claims: [
        {
          id: "claim-1",
          claim_text: "The chair was designed in 1949.",
          type: "provenance",
          status: "unverified",
          hard_flag: true,
          location: { field: "body_markdown", line_start: 3 },
          claim_hash: "a".repeat(64),
          sources: [],
        },
      ],
      rejected_findings: [
        {
          finding_id: "finding-1",
          disposition_id: "disposition-1",
          review_set_id: "review-set-1",
          review_set_membership_hash: "b".repeat(64),
          stable_key: "style-vague-heading",
          category: "writing_style",
          rule_reference: "style.vague_heading",
          severity: "warning",
          location: { field: "body_markdown", line_start: 1 },
          issue: "A heading is vague.",
          suggested_fix: "Name the chair in the heading.",
          rationale: null,
          finding_hash: "c".repeat(64),
          disposition_hash: "d".repeat(64),
        },
      ],
    });
    expect(rendered.title).toBe("Wishbone chair");
    for (const heading of [
      "## Metadata",
      "## Body copy",
      "## Images",
      "## FAQ",
      "## Internal links used",
      "## Schema requirements",
      "## Translatable elements",
      "## Fact-check claims",
      "## Outstanding rejected findings",
    ]) {
      expect(rendered.markdown).toContain(heading);
    }
    expect(rendered.markdown).toContain("- Primary keyword: wishbone chair");
    expect(rendered.markdown).toContain("- Locales for translation: sv-SE");
    expect(rendered.markdown).toContain(
      '| claim-1 | The chair was designed in 1949. | provenance | unverified | unknown_legacy | {"field":"body_markdown","line_start":3} |',
    );
    expect(rendered.markdown).toContain("style-vague-heading | writing_style");
    expect(rendered.markdown).toContain("No rationale supplied");
  });

  it("stays deterministic and backward compatible for minimal input", () => {
    const first = renderExport({ plane_ticket: "MOB-321", draft, ...templates });
    const second = renderExport({ plane_ticket: "MOB-321", draft, ...templates });
    expect(second).toEqual(first);
    expect(first.markdown).toContain("## Fact-check claims");
    expect(first.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
