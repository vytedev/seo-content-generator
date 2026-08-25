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
import {
  GscSearchAnalyticsClient,
  SitemapClient,
  LiveInternalLinkDiscoverer,
  NoNetworkLinkDiscoverer,
  PostgresLinkDiscoveryCache,
  SafeUrlVerifier,
  linkDiscoveryConfigFromEnv,
} from "../providers/internal-link-discovery.js";

export interface LocalServicesConfig {
  databaseUrl?: string;
  fixture?: DeterministicFixture;
  calibrationRetriever?: PublicPageRetriever;
  /** Tests without a database must opt out; real database composition fails closed. */
  authMode?: "required" | "disabled-test";
  /** Explicit deployment opt-in for a non-loopback PostgreSQL endpoint. */
  allowNonLocalDatabase?: boolean;
}

export function createLocalServices(config: LocalServicesConfig): {
  appOptions: CreateAppOptions;
  close(): Promise<void>;
} {
  // Validate any attempted Google configuration even when the database is unavailable;
  // only a wholly absent configuration is allowed to select credential-free behaviour.
  const googleConfig = googleOAuthConfigFromEnv(process.env);
  const authConfig = authConfigFromEnv(process.env);
  const factVerifierConfig = factVerifierConfigFromEnv(process.env);
  const linkDiscoveryConfig = linkDiscoveryConfigFromEnv(process.env);
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
    return {
      appOptions: { pipelineUnavailable: true, auth: { mode: "disabled" } },
      close: async () => undefined,
    };
  }
  if (config.authMode !== "disabled-test" && !authConfig) {
    throw new Error(
      "Operator authentication configuration is required when DATABASE_URL is configured",
    );
  }
  const url = new URL(config.databaseUrl);
  const databaseIsLocal = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname);
  if (!databaseIsLocal && !config.allowNonLocalDatabase) {
    throw new Error("DATABASE_URL must target local PostgreSQL for this local-only application");
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  // Seeded export templates stay pending until editorial approval. Local testing
  // may use the schema's traceable local_pending_explicit policy, while an
  // explicitly enabled non-loopback deployment must not inherit that override.
  const repository = new PostgresMilestoneRepository(pool, 300_000, {
    writer: { template_id: "mobelaris.writer-submission", version: "1.0.0" },
    schema: { template_id: "mobelaris.blog-schema", version: "1.0.0" },
    allow_local_pending: databaseIsLocal,
  });
  const googleStore = googleConfig
    ? new GoogleTokenStore(pool, googleConfig.encryptionKey)
    : undefined;
  const googleClient =
    googleConfig && googleStore ? new GoogleOAuthClient(googleConfig, googleStore) : undefined;
  const googleDocsAdapter = googleClient
    ? new RealGoogleDocsAdapter(googleClient)
    : new MockGoogleDocsAdapter();
  // The OAuth callback lives on this API origin (it must match GOOGLE_OAUTH_REDIRECT_URI
  // exactly), but the operator's browser needs sending back to wherever the SPA actually
  // is once the exchange completes. Only `npm start` serves the built client from this
  // same origin (a relative redirect is correct there); every other way of running the
  // server — including `npm run dev`, where a stale `dist/client` build may coincidentally
  // exist on disk — means the SPA is on Vite's separate port instead.
  const googleClientOrigin =
    process.env.npm_lifecycle_event === "start" || process.env.CONTAINER_DEV === "true"
      ? ""
      : "http://127.0.0.1:5173";
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
  const modelOptions = modelProviderOptionsFromEnv(process.env);
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
  return {
    appOptions: {
      auth:
        config.authMode === "disabled-test"
          ? { mode: "disabled" }
          : {
              mode: "enabled",
              config: authConfig!,
              store: new PostgresSessionStore(pool),
              secureCookies:
                process.env.NODE_ENV === "production" || process.env.CONTAINER_DEV === "true",
            },
      findingsRepository: repository,
      modelDiagnostic,
      googleOAuth: {
        configured: Boolean(googleConfig),
        clientOrigin: googleClientOrigin,
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
    close: () => pool.end(),
  };
}

export function createLocalApp(config: LocalServicesConfig) {
  const services = createLocalServices(config);
  return { app: createApp(services.appOptions), close: services.close };
}
