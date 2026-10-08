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

  constructor(status: number, body: unknown) {
    const err = (body as Partial<ApiErrorBody> | null)?.error;
    super(err?.message ?? `HTTP ${status}`);
    this.status = status;
    this.type = err?.type ?? "unknown";
    this.fields = err?.fields;
    this.body = body;
  }
}

/** 401: missing, malformed, unknown or revoked key. */
export class AuthenticationError extends APIError {}
/** 400 (invalid JSON) or 422 (doesn't match the schema). See `fields`. */
export class ValidationError extends APIError {}
/** 404 in the key's environment. */
export class NotFoundError extends APIError {}
/** 429. Midwater doesn't rate-limit today; this is here so code written now keeps working. */
export class RateLimitError extends APIError {}
/** 5xx. */
export class ServerError extends APIError {}

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

export function errorFor(status: number, body: unknown): APIError {
  if (status === 401) return new AuthenticationError(status, body);
  if (status === 400 || status === 422) return new ValidationError(status, body);
  if (status === 404) return new NotFoundError(status, body);
  if (status === 429) return new RateLimitError(status, body);
  if (status >= 500) return new ServerError(status, body);
  return new APIError(status, body);
}
