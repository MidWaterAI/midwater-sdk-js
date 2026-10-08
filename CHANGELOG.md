# Changelog

## 0.1.0 (unreleased)

- First version. `conversations.create`, `get`, `wait` and `feedback`; `agents.health`; `groups.health`.
- Idempotency keys generated for every `conversations.create`, so retries never store a conversation twice.
- Retries with backoff on 429, 5xx and network errors (GETs, and POSTs with an idempotency key).
- `@midwater/sdk/webhooks`: `verify` and `sign` for `Midwater-Signature`, constant-time, with secret rotation.
- Not published yet.
