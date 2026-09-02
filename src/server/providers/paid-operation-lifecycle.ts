import type {
  PaidOperationKind,
  PaidOperationProjection,
  PaidOperationReleaseReason,
} from "../../shared/paid-operation.js";

/** Runtime brand applied only by provider code before any HTTP dispatch. */
export const PRE_DISPATCH_PROVIDER_FAILURE = Symbol("pre-dispatch-provider-failure");
export interface PreDispatchProviderFailure {
  readonly code: string;
  readonly [PRE_DISPATCH_PROVIDER_FAILURE]: true;
}

export function markPreDispatchProviderFailure<T extends Error & { readonly code: string }>(
  error: T,
): T & PreDispatchProviderFailure {
  Object.defineProperty(error, PRE_DISPATCH_PROVIDER_FAILURE, { value: true });
  return error as T & PreDispatchProviderFailure;
}

const RELEASE_CODES: Readonly<Record<string, PaidOperationReleaseReason>> = {
  TOKEN_MISSING: "configuration_before_dispatch",
  MODEL_INVALID: "configuration_before_dispatch",
  MODEL_MISMATCH: "configuration_before_dispatch",
  AUTHENTICATION_BEFORE_DISPATCH: "authentication_before_dispatch",
  BILLING_BEFORE_DISPATCH: "billing_before_dispatch",
};

/**
 * Maps only application-owned, typed pre-dispatch failures to release authority.
 * Invalid/malformed successful responses occur after dispatch and intentionally return null.
 */
export function paidOperationReleaseReason(
  kind: PaidOperationKind,
  error: unknown,
): PaidOperationReleaseReason | null {
  if (
    !(error instanceof Error) ||
    !(PRE_DISPATCH_PROVIDER_FAILURE in error) ||
    error[PRE_DISPATCH_PROVIDER_FAILURE] !== true ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return null;
  const prefix = `${kind.toUpperCase()}_PROVIDER_`;
  if (!error.code.startsWith(prefix)) return null;
  return RELEASE_CODES[error.code.slice(prefix.length)] ?? null;
}

export function paidOperationAmbiguity(input: {
  operation_id: string;
  kind: PaidOperationKind;
  owner: string;
}): PaidOperationProjection {
  return {
    operation_id: input.operation_id,
    kind: input.kind,
    stage: "provider_in_flight",
    exposure: "possible_provider_spend",
    owner: input.owner,
    ambiguity_reason: "provider_in_flight_without_checkpoint",
  };
}

export interface PaidOperationAdapter<Command, Response> {
  markInFlight(command: Command): Promise<void>;
  checkpoint(command: Command, response: Response): Promise<void>;
  release(command: Command, reason: PaidOperationReleaseReason): Promise<void>;
}

/** Shared S1 lifecycle: reserve before dispatch, release only proven-undispatched failures. */
export async function executePaidOperation<Command, Raw, Response>(input: {
  kind: PaidOperationKind;
  command: Command;
  adapter: PaidOperationAdapter<Command, Response>;
  dispatch(): Promise<Raw>;
  validate(raw: Raw): Response | Promise<Response>;
}): Promise<Response> {
  await input.adapter.markInFlight(input.command);
  let raw: Raw;
  try {
    raw = await input.dispatch();
  } catch (error) {
    const reason = paidOperationReleaseReason(input.kind, error);
    if (reason) await input.adapter.release(input.command, reason);
    throw error;
  }
  // Validation is deliberately outside the releasable catch: provider returned successfully.
  const response = await input.validate(raw);
  await input.adapter.checkpoint(input.command, response);
  return response;
}
