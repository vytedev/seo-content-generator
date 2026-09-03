import pg from "pg";
import type { DeterministicFixture } from "../../shared/milestone-three.js";
import { createApp, type CreateAppOptions } from "./create-app.js";
import { MilestoneFourOrchestrator } from "../pipeline/milestone-four.js";
import { MilestoneThreeOrchestrator } from "../pipeline/milestone-three.js";
import { EditorialCorrectionOrchestrator } from "../pipeline/editorial-correction.js";
import { MilestoneTwoOrchestrator } from "../pipeline/milestone-two.js";
import { MockDraftProvider } from "../providers/draft-provider.js";
import { ChatCompletionDraftProvider } from "../providers/chat-completion-draft-provider.js";
import { MockReviewProvider } from "../providers/review-provider.js";
import { ChatCompletionReviewProvider } from "../providers/chat-completion-review-provider.js";
import {
  PublicStorefrontFactVerifier,
  NoNetworkFactVerifier,
  factVerifierConfigFromEnv,
} from "../providers/fact-verifier.js";
import { ChatCompletionRevisionProvider } from "../providers/chat-completion-revision-provider.js";
import { ChatCompletionCoherenceProvider } from "../providers/chat-completion-coherence-provider.js";
import { modelProviderOptionsFromEnv } from "../providers/model-provider.js";
import { ModelDiagnosticService } from "../services/model-diagnostic-service.js";
import { PostgresModelDiagnosticRepository } from "../repositories/model-diagnostic-repository.js";
import { PostgresMilestoneRepository } from "../repositories/postgres-repository.js";
import { PostgresGoogleDocsExportService } from "../services/export-service.js";
import { MockGoogleDocsAdapter, RealGoogleDocsAdapter } from "../providers/google-docs.js";
import {
  GoogleOAuthClient,
  GoogleTokenStore,
  googleOAuthConfigFromEnv,
} from "../providers/google-oauth.js";
import {
  MockCoherenceProvider,
  MockRevisionProvider,
} from "../providers/milestone-four-providers.js";
import {
  SafePublicPageRetriever,
  type PublicPageRetriever,
} from "../providers/public-page-retriever.js";
import { PostgresCalibrationRepository } from "../repositories/calibration-repository.js";
import { CalibrationService } from "../services/calibration-service.js";
import { PostgresCalibrationPipelineRunner } from "../services/calibration-pipeline.js";
import { CachedPublicPageRetriever } from "../services/public-retrieval-cache.js";
import { createIngestService } from "../routes/ingest-routes.js";
import { PostgresReferenceApprovalRepository } from "../repositories/reference-approval-repository.js";
import { authConfigFromEnv } from "../auth/config.js";
import { PostgresSessionStore } from "../auth/session-store.js";
import { LOCAL_FRONTEND_ORIGIN } from "../../shared/local-runtime.js";
import { PipelineQueueWorker } from "../pipeline/queue-worker.js";
import { SerpProbeWorker } from "../pipeline/serp-probe-worker.js";
import { ConfiguredSerpProbe, serpProbeConfigFromEnv } from "../providers/serp-probe.js";
import { RuntimeModeSchema, permitsTestDoubles } from "../../shared/runtime-mode.js";

import { closePoolWithin, type ShutdownResult } from "../shutdown.js";
import { classifyError, logger } from "../logger.js";
import {
  GscSearchAnalyticsClient,
  SitemapClient,
  LiveInternalLinkDiscoverer,
  NoNetworkLinkDiscoverer,
  PostgresLinkDiscoveryCache,
  SafeUrlVerifier,
  linkDiscoveryConfigFromEnv,
} from "../providers/internal-link-discovery.js";

export const CURRENT_APPLICATION_SCHEMA_VERSION = 55;

export async function databaseSchemaIsCurrent(pool: Pick<pg.Pool, "query">): Promise<boolean> {
  try {
    const result = await pool.query<{ version: number }>(
      "select version from application_schema_version where singleton=true",
    );
    return result.rows[0]?.version === CURRENT_APPLICATION_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export interface LocalServicesConfig {
  databaseUrl?: string;
  fixture?: DeterministicFixture;
  calibrationRetriever?: PublicPageRetriever;
  /** Tests without a database must opt out; real database composition fails closed. */
  authMode?: "required" | "disabled-test";
  /** Explicit local/test opt-in for a non-loopback PostgreSQL endpoint. */
  allowNonLocalDatabase?: boolean;
  runtimeMode?: "local" | "test" | "production";
  /** Runtime never mutates schema; migrations must complete before startup. */
  migrationPolicy?: "verify-only" | "on-startup";
  /** Production entrypoint role; development defaults to the historical combined process. */
  processRole?: "combined" | "api" | "worker";
  /** Standalone workers use this to turn a fatal queue-loop error into process failure. */
  onWorkerFailure?: (error: unknown) => void;
}

export function createLocalServices(config: LocalServicesConfig): {
  appOptions: CreateAppOptions;
  ready: Promise<void>;
  workerHealth: () => { status: "running" | "stopped" | "failed" };
  close(deadlineMs?: number): Promise<ShutdownResult>;
} {
  const runtimeMode = RuntimeModeSchema.parse(config.runtimeMode ?? "local");
  const processRole = config.processRole ?? "combined";
  if (runtimeMode === "production" && processRole === "combined")
    throw new Error("Production requires separate API and worker process roles.");
  const testDoublesAllowed = permitsTestDoubles(runtimeMode);
  const migrationPolicy = config.migrationPolicy ?? "verify-only";
  if (migrationPolicy !== "verify-only")
    throw new Error("Migration-on-startup is forbidden; apply migrations before starting the app.");
  // Validate any attempted Google configuration even when the database is unavailable;
  // only a wholly absent configuration is allowed to select credential-free behaviour.
  const googleConfig = googleOAuthConfigFromEnv(process.env);
  // A worker may receive the shared deployment environment, but must never parse, validate,
  // retain or use API-only operator credentials.
  const authConfig = processRole === "worker" ? undefined : authConfigFromEnv(process.env);
  const factVerifierConfig = factVerifierConfigFromEnv(process.env);
  const linkDiscoveryConfig = linkDiscoveryConfigFromEnv(process.env);
  const serpProbeConfig = serpProbeConfigFromEnv(process.env);
  // Temporary local test-only capability: allow drafting to proceed with an honest
  // empty verified shortlist before sitemap/GSC configuration exists. Rejected when the
  // database is not local; default remains the strict production gate.
  const rawBypassFlag = process.env.LOCAL_ALLOW_UNVERIFIED_LINK_BYPASS?.trim().toLowerCase();
  const allowUnverifiedLinkBypass = rawBypassFlag === "true";
  if (rawBypassFlag && !new Set(["true", "false"]).has(rawBypassFlag))
    throw new Error(
      "LOCAL_ALLOW_UNVERIFIED_LINK_BYPASS must be exactly 'true' or 'false' when set.",
    );
  if (!config.databaseUrl?.trim()) {
    if (config.authMode !== "disabled-test")
      throw new Error("Local PostgreSQL is required for operator authentication");
    if (runtimeMode === "production") throw new Error("Production requires configured PostgreSQL.");
    return {
      appOptions: {
        pipelineUnavailable: true,
        auth: { mode: "disabled" },
        runtimeMode,
        readiness: async () => ({
          ready: false,
          checks: {
            database: false,
            migrations: false,
            reconciliation: false,
            worker: false,
            configuration: true,
          },
        }),
      },
      ready: Promise.resolve(),
      workerHealth: () => ({ status: "stopped" }),
      close: async () => "closed",
    };
  }
  if (processRole !== "worker" && config.authMode !== "disabled-test" && !authConfig) {
    throw new Error(
      "Operator authentication configuration is required when DATABASE_URL is configured",
    );
  }
  const url = new URL(config.databaseUrl);
  const databaseIsLocal = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  if (runtimeMode === "production") {
    if (databaseIsLocal) throw new Error("Production forbids a loopback PostgreSQL database.");
    if (!config.allowNonLocalDatabase)
      throw new Error("Production requires explicit non-local database approval.");
  } else if (!databaseIsLocal && !config.allowNonLocalDatabase) {
    throw new Error(
      "Local/test DATABASE_URL requires loopback PostgreSQL unless explicitly allowed.",
    );
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  // Seeded export templates stay pending until editorial approval. Local testing
  // may use the schema's traceable local_pending_explicit policy, while an
  // explicitly enabled non-loopback deployment must not inherit that override.
  const repository = new PostgresMilestoneRepository(pool, 300_000, {
    writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
    schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
    allow_local_pending: testDoublesAllowed && databaseIsLocal,
  });
  const googleStore = googleConfig
    ? new GoogleTokenStore(pool, googleConfig.encryptionKey)
    : undefined;
  const googleClient =
    googleConfig && googleStore ? new GoogleOAuthClient(googleConfig, googleStore) : undefined;
  const modelOptions = modelProviderOptionsFromEnv(process.env);
  if (runtimeMode === "production") {
    if (!modelOptions)
      throw new Error("Production requires an explicitly configured model provider.");
    if (!googleClient)
      throw new Error("Production requires an explicitly configured Google OAuth client.");
    if (!linkDiscoveryConfig)
      throw new Error("Production requires configured live internal-link discovery.");
    if (!factVerifierConfig)
      throw new Error("Production requires configured public storefront verification.");
    if (!serpProbeConfig) throw new Error("Production requires configured SERP probing.");
    if (allowUnverifiedLinkBypass)
      throw new Error("Production forbids the unverified-link bypass.");
    if (config.fixture) throw new Error("Production forbids deterministic test fixtures.");
    if (config.authMode === "disabled-test" && processRole !== "worker")
      throw new Error("Production forbids the authentication test bypass.");
  }
  const googleDocsAdapter = googleClient
    ? new RealGoogleDocsAdapter(googleClient)
    : testDoublesAllowed
      ? new MockGoogleDocsAdapter()
      : (() => {
          throw new Error("Production forbids the mock Google Docs adapter.");
        })();
  // The OAuth callback lives on this API origin (it must match GOOGLE_OAUTH_REDIRECT_URI
  // exactly), but the operator's browser needs sending back to wherever the SPA actually
  // is once the exchange completes. Only `npm start` serves the built client from this
  // same origin (a relative redirect is correct there); every other way of running the
  // server — including `npm run dev`, where a stale `dist/client` build may coincidentally
  // exist on disk — means the SPA is on Vite's separate port instead.
  const googleClientOrigin =
    process.env.npm_lifecycle_event === "start" || process.env.CONTAINER_DEV === "true"
      ? ""
      : LOCAL_FRONTEND_ORIGIN;
  const referenceApprovals = new PostgresReferenceApprovalRepository(pool);
  const calibrationRepository = new PostgresCalibrationRepository(pool);
  const calibrationRetriever = new CachedPublicPageRetriever(
    config.calibrationRetriever ?? new SafePublicPageRetriever(),
  );
  const calibrationService = new CalibrationService(
    calibrationRepository,
    calibrationRetriever,
    new PostgresCalibrationPipelineRunner(pool, repository),
  );
  const fixture = config.fixture ?? {
    internal_origins: ["https://www.mobelaris.com"],
    // Production verification comes from the run's persisted Step 1.2 shortlist.
    // Keep no static fallback here: no-network/unavailable discovery must remain
    // an honest empty shortlist rather than claiming a URL was verified.
    link_verification: [],
  };
  // Local mocked milestone-two providers: no network, deterministic output.
  // Model steps (1.3 drafting, 1.5–1.8 reviews, 1.10 revision, 1.12 coherence)
  // use exactly one explicitly configured OpenRouter or Hugging Face provider;
  // otherwise deterministic mocks keep local behaviour unchanged.
  const modelDiagnostic = new ModelDiagnosticService({
    ...(modelOptions ? { provider: modelOptions } : {}),
    store: new PostgresModelDiagnosticRepository(pool),
  });
  const draftProvider = modelOptions
    ? new ChatCompletionDraftProvider(modelOptions)
    : new MockDraftProvider("local-no-network");
  const linkDiscoverer = linkDiscoveryConfig
    ? new LiveInternalLinkDiscoverer(
        linkDiscoveryConfig,
        new SitemapClient(linkDiscoveryConfig),
        new SafeUrlVerifier(linkDiscoveryConfig),
        new PostgresLinkDiscoveryCache(pool),
        linkDiscoveryConfig.gscSiteUrl && googleClient
          ? new GscSearchAnalyticsClient(
              googleClient,
              linkDiscoveryConfig.gscSiteUrl,
              linkDiscoveryConfig,
            )
          : undefined,
      )
    : new NoNetworkLinkDiscoverer();
  const liveUrlVerifier = linkDiscoveryConfig
    ? new SafeUrlVerifier(linkDiscoveryConfig)
    : undefined;
  const milestoneTwo = new MilestoneTwoOrchestrator(
    repository,
    linkDiscoverer,
    draftProvider,
    undefined,
    allowUnverifiedLinkBypass,
  );
  const milestoneThree = new MilestoneThreeOrchestrator(
    repository,
    fixture,
    modelOptions
      ? new ChatCompletionReviewProvider(modelOptions)
      : new MockReviewProvider("local-no-network"),
    undefined,
    factVerifierConfig && linkDiscoveryConfig
      ? new PublicStorefrontFactVerifier({
          ...factVerifierConfig,
          sitemap: new SitemapClient(linkDiscoveryConfig),
        })
      : new NoNetworkFactVerifier(),
    liveUrlVerifier ? { verify: (url) => liveUrlVerifier.verifyOutcome(url) } : undefined,
  );
  const orchestrator = new MilestoneFourOrchestrator(
    repository,
    fixture,
    modelOptions
      ? new ChatCompletionRevisionProvider(modelOptions)
      : new MockRevisionProvider("local-no-network"),
    modelOptions
      ? new ChatCompletionCoherenceProvider(modelOptions)
      : new MockCoherenceProvider("local-no-network"),
    new PostgresGoogleDocsExportService(pool, googleDocsAdapter),
  );
  const queueWorker = new PipelineQueueWorker(
    repository,
    {
      milestoneTwo,
      milestoneThree,
      milestoneFour: orchestrator,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (error) => {
      logger.error("local_services.queue_worker_failed", {
        worker_status: "failed",
        ...classifyError(error),
      });
      config.onWorkerFailure?.(error);
    },
    new SerpProbeWorker(
      repository,
      serpProbeConfig ? new ConfiguredSerpProbe(serpProbeConfig) : null,
    ),
  );
  let reconciliationComplete = false;
  let startupFailure: unknown = null;
  const requiredProductionConfig =
    runtimeMode !== "production" ||
    Boolean(
      modelOptions &&
      googleClient &&
      linkDiscoveryConfig &&
      factVerifierConfig &&
      serpProbeConfig &&
      !allowUnverifiedLinkBypass &&
      !config.fixture &&
      config.authMode !== "disabled-test",
    );
  const verifyDatabaseAndMigrations = () => databaseSchemaIsCurrent(pool);
  const ready = (async () => {
    if (runtimeMode === "production") {
      const [unsafeReferences, selectedTemplates] = await Promise.all([
        pool.query(
          `select 1 from reference_activations a
            where a.provisional_local or not exists (
              select 1 from reference_approval_attestations aa
              join reference_attestation_verifications v on v.attestation_id=aa.id
              where aa.reference_version_id=a.reference_version_id
            ) limit 1`,
        ),
        pool.query<{ status: string }>(
          `select status from content_templates where
            (template_id=$1 and version=$2 and kind='writer') or
            (template_id=$3 and version=$4 and kind='schema')`,
          ["mobelaris.writer-submission", "1.0.0", "mobelaris.blog-schema", "1.0.0"],
        ),
      ]);
      if (unsafeReferences.rows[0])
        throw new Error("Production refuses provisional or unverified active references.");
      if (
        selectedTemplates.rows.length !== 2 ||
        selectedTemplates.rows.some((row) => row.status !== "approved")
      )
        throw new Error("Production refuses missing or pending export templates.");
    }
    if (!(await verifyDatabaseAndMigrations()))
      throw new Error("Database migrations are not current; apply migrations before startup.");
    if (processRole !== "api") {
      await queueWorker.start();
      reconciliationComplete = true;
    }
  })().catch((error) => {
    startupFailure = error;
    throw error;
  });
  // Mark the promise observed for compositions that only inspect providers in tests; the same
  // rejecting promise is still returned and production awaits it before opening readiness.
  void ready.catch(() => undefined);
  return {
    appOptions: {
      auth:
        config.authMode === "disabled-test" || processRole === "worker"
          ? { mode: "disabled" }
          : {
              mode: "enabled",
              config: authConfig!,
              store: new PostgresSessionStore(pool),
              secureCookies:
                process.env.NODE_ENV === "production" || process.env.CONTAINER_DEV === "true",
            },
      findingsRepository: repository,
      queue: repository,
      commands: repository,
      workerHealth: () => (processRole === "api" ? { status: "stopped" } : queueWorker.health()),
      runtimeMode,
      readiness: async () => {
        let database = false;
        let migrations = false;
        try {
          await pool.query("select 1");
          database = true;
          migrations = await verifyDatabaseAndMigrations();
        } catch {
          database = false;
          migrations = false;
        }
        const ownsWorker = processRole !== "api";
        let externalWorker = false;
        if (!ownsWorker && database) {
          try {
            externalWorker = Boolean(
              (
                await pool.query<{ alive: boolean }>(
                  "select exists(select 1 from worker_heartbeats where worker_name='pipeline' and heartbeat_at>clock_timestamp()-interval '15 seconds') alive",
                )
              ).rows[0]?.alive,
            );
          } catch {
            externalWorker = false;
          }
        }
        const worker = ownsWorker ? queueWorker.health().status === "running" : externalWorker;
        const checks = {
          database,
          migrations,
          reconciliation: ownsWorker ? reconciliationComplete : externalWorker,
          worker,
          configuration: requiredProductionConfig,
        };
        return {
          ready: !startupFailure && Object.values(checks).every(Boolean),
          checks,
        };
      },
      modelDiagnostic,
      googleOAuth: {
        configured: Boolean(googleConfig),
        clientOrigin: googleClientOrigin,
        secureCookies: runtimeMode === "production",
        ...(googleClient ? { client: googleClient } : {}),
        ...(googleStore ? { store: googleStore } : {}),
      },
      ingestService: createIngestService(repository),
      referenceApprovals,
      milestoneTwo: { repository, orchestrator: milestoneTwo },
      milestoneThree: {
        repository,
        orchestrator: milestoneThree,
        editorialCorrection: new EditorialCorrectionOrchestrator(repository, fixture),
      },
      milestoneFour: { repository, orchestrator },
      calibration: { repository: calibrationRepository, service: calibrationService },
    },
    ready,
    workerHealth: () => queueWorker.health(),
    close: async (deadlineMs = 10_000) => {
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0)
        throw new Error("Service shutdown deadline must be a non-negative integer");
      const expiresAt = Date.now() + deadlineMs;
      if (processRole !== "api") {
        const worker = await queueWorker.stop(Math.max(0, expiresAt - Date.now()));
        if (worker === "deadline_exceeded" || Date.now() >= expiresAt) return "deadline_exceeded";
      }
      // pg does not provide a safe cancellation primitive for checked-out client work. Bound
      // end(); if it misses the deadline its sockets/timers are unref'd so the process can exit
      // while the durable queue lease expires naturally.
      return closePoolWithin(pool, Math.max(0, expiresAt - Date.now()));
    },
  };
}

export function createLocalApp(config: LocalServicesConfig) {
  const services = createLocalServices(config);
  return { app: createApp(services.appOptions), ready: services.ready, close: services.close };
}
