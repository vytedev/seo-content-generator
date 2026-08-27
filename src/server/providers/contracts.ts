import type { DraftProviderRequest, DraftProviderResponse } from "../../shared/milestone-two.js";

/** Server-only provider boundary; implementations must pin an exact model identifier. */
export interface DraftProvider {
  readonly provider: string;
  readonly model: string;
  /** Mechanically derived from prompt/schema/reasoning/retry/token policy. */
  readonly contractIdentity: string;
  readonly prompt: NonNullable<DraftProviderRequest["prompt"]>;
  generate(request: DraftProviderRequest): Promise<DraftProviderResponse>;
}
