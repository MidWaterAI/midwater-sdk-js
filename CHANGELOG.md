# Changelog

## Unreleased (planned for 0.2.0)

- `coverage` on `Conversation` and in `conversation.evaluated` data (API 1.1.0).
- `scorer_version` can be `null`.
- `conversations.feedback` is retried like `create` (the API honours its idempotency key since 1.2.0) and returns `replayed`.

## 0.1.0 (2026-10-08)

- `conversations.create`, `get`, `wait` and `feedback`; `agents.health`; `groups.health`.
- `apiKey` and `baseUrl` are both required (arguments or `MIDWATER_API_KEY` / `MIDWATER_BASE_URL`); there's no default host.
- Every POST sends an `Idempotency-Key`, generated per call and reused on its retries.
- Retries on 408, 429, 5xx and network errors, for GETs and `conversations.create` only; at most 3.
- Typed errors for every status in the contract, with `requestId` (planned server-side).
- `@midwater/sdk/webhooks`: `verifyWebhook` (also `webhooks.verify`) and `webhooks.sign` for `Midwater-Signature`, constant-time, with several `v1=` values accepted.
