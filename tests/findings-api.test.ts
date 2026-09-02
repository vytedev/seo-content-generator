import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import type { MilestoneThreeRepository } from "../src/shared/milestone-three.js";
import { ConflictError, NotFoundError, UnprocessableError } from "../src/shared/errors.js";

const finding = {
  id: "finding-1",
  run_id: "run-1",
  document_version_id: "doc-1",
  step_execution_id: "execution-1",
  step: "automated_checks" as const,
  stable_key: "det_key",
  category: "deterministic",
  rule_reference: "rule",
  severity: "warning" as const,
  location: { field: "body_markdown" },
  issue: "Issue",
  suggested_fix: "Fix",
  hard_flag: false,
  disposition: null,
  rationale: null,
  evidence_sources: [],
};

function repository(): MilestoneThreeRepository &
  import("../src/shared/command-repository.js").RunCommandRepository {
  return {
    stepSucceeded: async () => false,
    stepWaiting: async () => false,
    claimStep: async () => ({ execution_id: "x", token: "x" }),
    heartbeatStep: async () => true,
    cancelRun: async () => {},
    completeStep: async () => {},
    failStep: async () => {},
    getHandoff: async () => {
      throw new Error();
    },
    getLinks: async () => [],
    getLinksArtifact: async () => null,
    getDraft: async () => null,
    snapshotReferences: async () => [],
    hasStepOutput: async () => false,
    saveDeterministicBaseline: async () => {},
    getDeterministicManifest: async () => {
      throw new Error();
    },
    saveFindings: async () => {},
    beginReviewOperation: async () => ({ operation_id: "operation", response: null }),
    markReviewProviderInFlight: async () => {},
    checkpointReviewResponse: async () => {},
    saveReview: async () => {},
    waitForFindings: async () => {},
    listFindings: async () => [finding],
    openEditorialCorrectionRound: async () => ({
      status: "opened" as const,
      review_set_id: "set",
      round: 2,
    }),
    submitDispositions: async (_run, input) => ({
      completed: true,
      submitted: input.dispositions.length,
      continuation_required: true,
    }),
    submitCommand: async (command: any) => ({
      command_id: command.command_id,
      run_id: command.run_id,
      replayed: false,
      queue_accepted: true,
      result: {
        completed: true,
        submitted: command.dispositions.dispositions.length,
        continuation_required: true,
      },
    }),
    listCommandActivity: async () => [],
  };
}

describe("findings API", () => {
  it("keeps historical findings without projected source metadata compatible", async () => {
    const app = createApp({ serveClient: false, findingsRepository: repository() });
    const listed = await request(app).get("/api/runs/run-1/findings");
    expect(listed.status).toBe(200);
    expect(listed.body.findings[0].evidence_sources).toEqual([]);
  });

  it("lists with strict filters and accepts bulk dispositions", async () => {
    const app = createApp({ serveClient: false, findingsRepository: repository() });
    const listed = await request(app).get(
      "/api/runs/run-1/findings?severity=warning&disposition=pending",
    );
    expect(listed.status).toBe(200);
    expect(listed.body.findings).toEqual([finding]);
    const submitted = await request(app)
      .post("/api/runs/run-1/findings/dispositions")
      .send({
        document_version_id: "doc-1",
        idempotency_key: "decision-test-1",
        dispositions: [{ finding_id: "finding-1", decision: "accepted", rationale: "Apply" }],
      });
    expect(submitted.status).toBe(202);
    expect(submitted.body).toMatchObject({
      run_id: "run-1",
      replayed: false,
      queue_accepted: true,
    });
  });

  it("never invokes the legacy synchronous continuation in production-shaped composition", async () => {
    const run = vi.fn(async () => undefined);
    const app = createApp({
      serveClient: false,
      findingsRepository: repository(),
      milestoneFour: { repository: repository() as never, orchestrator: { run } as never },
    });

    const submitted = await request(app)
      .post("/api/runs/run-1/findings/dispositions")
      .send({
        document_version_id: "doc-1",
        idempotency_key: "decision-production-route",
        dispositions: [{ finding_id: "finding-1", decision: "accepted" }],
      });

    expect(submitted.status).toBe(202);
    expect(submitted.body.queue_accepted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("retains synchronous continuation only behind the explicit test switch", async () => {
    const run = vi.fn(async () => undefined);
    const app = createApp({
      serveClient: false,
      testOnlySynchronousPipeline: true,
      findingsRepository: repository(),
      milestoneFour: { repository: repository() as never, orchestrator: { run } as never },
    });

    const submitted = await request(app)
      .post("/api/runs/run-1/findings/dispositions")
      .send({
        document_version_id: "doc-1",
        idempotency_key: "decision-test-route",
        dispositions: [{ finding_id: "finding-1", decision: "accepted" }],
      });

    expect(submitted.status).toBe(200);
    expect(submitted.body.continuation).toBe("completed");
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    [new NotFoundError("The findings run was not found."), 404, "NOT_FOUND"],
    [new ConflictError("Dispositions must target the current document version."), 409, "CONFLICT"],
    [
      new UnprocessableError("A finding does not belong to the current document."),
      422,
      "UNPROCESSABLE_ENTITY",
    ],
  ] as const)("maps typed findings errors without internals", async (failure, status, code) => {
    const failing = repository();
    failing.submitCommand = async () => {
      throw failure;
    };
    const response = await request(createApp({ serveClient: false, findingsRepository: failing }))
      .post("/api/runs/run-1/findings/dispositions")
      .send({
        document_version_id: "doc-1",
        idempotency_key: "decision-test-2",
        dispositions: [{ finding_id: "finding-1", decision: "accepted" }],
      });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message: failure.message } });
  });

  it("rejects unknown filters, duplicate IDs and unknown body fields", async () => {
    const app = createApp({ serveClient: false, findingsRepository: repository() });
    expect((await request(app).get("/api/runs/run-1/findings?unknown=x")).status).toBe(400);
    const response = await request(app)
      .post("/api/runs/run-1/findings/dispositions")
      .send({
        document_version_id: "doc-1",
        idempotency_key: "decision-test-3",
        unknown: true,
        dispositions: [
          { finding_id: "same", decision: "accepted" },
          { finding_id: "same", decision: "rejected" },
        ],
      });
    expect(response.status).toBe(400);
  });
});
