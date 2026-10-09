export { Midwater, MAX_RETRIES_CAP, Conversations, Agents, Groups } from "./client";
export type { MidwaterOptions, RequestOptions, WaitOptions } from "./client";
export {
  MidwaterError,
  APIError,
  AuthenticationError,
  ValidationError,
  PermissionDeniedError,
  NotFoundError,
  MethodNotAllowedError,
  RequestTimeoutError,
  IdempotencyConflictError,
  PayloadTooLargeError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  APIConnectionError,
  WaitTimeoutError,
  WebhookVerificationError,
} from "./errors";
export type * from "./types";
export { VERSION } from "./version";
export { Midwater as default } from "./client";
