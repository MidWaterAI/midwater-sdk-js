export { Midwater, DEFAULT_BASE_URL, Conversations, Agents, Groups } from "./client";
export type { MidwaterOptions, RequestOptions, WaitOptions } from "./client";
export {
  MidwaterError,
  APIError,
  AuthenticationError,
  ValidationError,
  NotFoundError,
  RateLimitError,
  ServerError,
  APIConnectionError,
  WaitTimeoutError,
  WebhookVerificationError,
} from "./errors";
export type * from "./types";
export { VERSION } from "./version";
export { Midwater as default } from "./client";
