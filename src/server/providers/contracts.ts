import type { DraftProviderRequest, DraftProviderResponse } from "../../shared/milestone-two.js";

/** Server-only provider boundary; implementations must pin an exact model identifier. */
export interface DraftProvider {
  readonly provider: string;
  readonly model: string;
  generate(request: DraftProviderRequest): Promise<DraftProviderResponse>;
}
