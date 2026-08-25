import { sha256 } from "./sha256.js";

function randomToken(): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.randomUUID)
    throw new LeaseContractError("Secure random UUID generation is unavailable");
  return webCrypto.randomUUID();
}

export interface LeaseState {
  readonly token: string | null;
  readonly owner: string | null;
  readonly expires_at: Date | null;
}

export interface LeaseGrant extends LeaseState {
  readonly token: string;
  readonly owner: string;
  readonly expires_at: Date;
}

export type LeaseDecision =
  | { readonly kind: "granted"; readonly lease: LeaseGrant }
  | { readonly kind: "busy"; readonly lease: LeaseGrant };

/**
 * Pure lease policy. Persistence must use one atomic conditional UPDATE and
 * include the lease token in heartbeat, completion and failure WHERE clauses.
 */
export function decideLease(
  current: LeaseState,
  owner: string,
  now: Date,
  durationMs: number,
  token: string = randomToken(),
): LeaseDecision {
  if (!owner.trim()) throw new LeaseContractError("Lease owner is required");
  assertValidDate(now, "Lease time");
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new LeaseContractError("Lease duration must be a positive safe integer");
  }
  const expiryMs = now.getTime() + durationMs;
  if (!Number.isSafeInteger(expiryMs))
    throw new LeaseContractError("Lease expiry is outside the safe range");
  assertLeaseShape(current);

  if (
    current.token !== null &&
    current.owner !== null &&
    current.expires_at !== null &&
    current.expires_at.getTime() > now.getTime()
  ) {
    return { kind: "busy", lease: current as LeaseGrant };
  }

  return { kind: "granted", lease: { token, owner, expires_at: new Date(expiryMs) } };
}

export function holdsLease(current: LeaseState, token: string, now: Date): boolean {
  assertValidDate(now, "Lease time");
  assertLeaseShape(current);
  return (
    current.token === token &&
    current.expires_at !== null &&
    current.expires_at.getTime() > now.getTime()
  );
}

export interface IdempotencyRecord<Result> {
  readonly key: string;
  readonly input_hash: string;
  readonly result: Result;
}

export type IdempotencyDecision<Result> =
  | { readonly kind: "execute"; readonly key: string; readonly input_hash: string }
  | { readonly kind: "replay"; readonly result: Result }
  | {
      readonly kind: "conflict";
      readonly expected_input_hash: string;
      readonly actual_input_hash: string;
    };

export function hashIdempotencyInput(input: unknown): string {
  return sha256(canonicalJson(input));
}

export function decideIdempotency<Result>(
  key: string,
  input: unknown,
  existing: IdempotencyRecord<Result> | null,
): IdempotencyDecision<Result> {
  if (!key.trim()) throw new IdempotencyContractError("Idempotency key is required");
  const inputHash = hashIdempotencyInput(input);
  if (existing === null) return { kind: "execute", key, input_hash: inputHash };
  if (existing.key !== key)
    throw new IdempotencyContractError("Existing record key does not match");
  if (existing.input_hash === inputHash) return { kind: "replay", result: existing.result };
  return {
    kind: "conflict",
    expected_input_hash: existing.input_hash,
    actual_input_hash: inputHash,
  };
}

function assertLeaseShape(lease: LeaseState): void {
  const values = [lease.token, lease.owner, lease.expires_at];
  if (!values.every((value) => value === null) && !values.every((value) => value !== null)) {
    throw new LeaseContractError("Lease fields must be all null or all populated");
  }
  if (lease.expires_at !== null) assertValidDate(lease.expires_at, "Lease expiry");
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new LeaseContractError(`${label} must be valid`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new IdempotencyContractError("Input must contain only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new IdempotencyContractError("Sparse arrays are not supported");
      entries.push(canonicalJson(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new IdempotencyContractError("Input must contain only plain objects and arrays");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new IdempotencyContractError(`Unsupported idempotency input type: ${typeof value}`);
}

export class LeaseContractError extends Error {
  override readonly name = "LeaseContractError";
}

export class IdempotencyContractError extends Error {
  override readonly name = "IdempotencyContractError";
}
