export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  readonly code = "NOT_FOUND";
}

export class ConflictError extends Error {
  override readonly name = "ConflictError";
  readonly code = "CONFLICT";
}

export class UnprocessableError extends Error {
  override readonly name = "UnprocessableError";
  readonly code = "UNPROCESSABLE_ENTITY";
}

export class ServiceUnavailableError extends Error {
  override readonly name = "ServiceUnavailableError";
  readonly code = "SERVICE_UNAVAILABLE";
}

/** A persistence race found the same repository identity bound to different input. */
export class RepositoryConflictError extends Error {
  override readonly name = "RepositoryConflictError";
  readonly code = "REPOSITORY_CONFLICT";
}

/** A bounded PostgreSQL connectivity failure; safe to expose only as a generic 503. */
export class RepositoryUnavailableError extends Error {
  override readonly name = "RepositoryUnavailableError";
  readonly code = "REPOSITORY_UNAVAILABLE";
}
