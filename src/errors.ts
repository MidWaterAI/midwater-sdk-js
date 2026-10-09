import type { ApiErrorBody } from "./types";

/** Base class for every error the SDK throws. */
export class MidwaterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The API answered with an error status. */
export class APIError extends MidwaterError {
  /** HTTP status. */
  readonly status: number;
  /** Stable error type from the body, e.g. `validation_error`; `unknown` when the body wasn't JSON. */
  readonly type: string;
  /** Field errors by dotted path, on validation errors. */
  readonly fields: Record<string, string[]> | undefined;
  /** The parsed body, or the raw text when it wasn't JSON. */
  readonly body: unknown;
  /**
   * The request's ID, from `error.request_id` or the `Midwater-Request-Id` header. Quote it to support.
   * Planned server-side: `undefined` until Midwater sends it.
   */
  readonly requestId: string | undefined;

  constructor(status: number, body: unknown, requestId?: string | null) {
    const err = (body as Partial<ApiErrorBody> | null)?.error;
    super(err?.message ?? `HTTP ${status}`);
    this.status = status;
    this.type = err?.type ?? "unknown";
    this.fields = err?.fields;
    this.body = body;
    this.requestId = err?.request_id ?? requestId ?? undefined;
  }
}

/** 401: missing, malformed, unknown or revoked key. */
export class AuthenticationError extends APIError {}
/** 400 (invalid JSON) or 422 (doesn't match the schema). See `fields`. */
export class ValidationError extends APIError {}
/** 403: the key can't do this (planned). */
export class PermissionDeniedError extends APIError {}
/** 404 in the key's environment. */
export class NotFoundError extends APIError {}
/** 405: the path doesn't support this method (planned as a JSON error with an `Allow` header). */
export class MethodNotAllowedError extends APIError {}
/** 408. */
export class RequestTimeoutError extends APIError {}
/** 409 `idempotency_conflict`: the idempotency key was used with a different body (planned). */
export class IdempotencyConflictError extends APIError {}
/** 413: the body is too large (planned). */
export class PayloadTooLargeError extends APIError {}
/** 429. Rate limits are planned; this is here so code written now keeps working. */
export class RateLimitError extends APIError {}
/** 5xx. */
export class ServerError extends APIError {}
/** 503: Midwater is briefly unavailable (planned). */
export class ServiceUnavailableError extends ServerError {}

/** The request never got an HTTP answer (DNS, connection, timeout). */
export class APIConnectionError extends MidwaterError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** `conversations.wait()` gave up before scoring finished. */
export class WaitTimeoutError extends MidwaterError {}

/** A webhook didn't verify. `reason` says why. */
export class WebhookVerificationError extends MidwaterError {
  readonly reason: "missing_header" | "malformed_header" | "stale_timestamp" | "invalid_signature" | "no_secret";
  constructor(reason: WebhookVerificationError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const BY_STATUS: Record<number, new (status: number, body: unknown, requestId?: string | null) => APIError> = {
  400: ValidationError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  405: MethodNotAllowedError,
  408: RequestTimeoutError,
  409: IdempotencyConflictError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitError,
  503: ServiceUnavailableError,
};

/** The error class for a status. Unknown statuses fall back to their class (5xx → ServerError), never a crash. */
export function errorFor(status: number, body: unknown, requestId?: string | null): APIError {
  const Cls = BY_STATUS[status] ?? (status >= 500 ? ServerError : APIError);
  return new Cls(status, body, requestId);
}
