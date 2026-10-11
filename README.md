# Midwater JavaScript SDK

**Version 0.1.0. Unpublished:** `@midwater/sdk` isn't on npm yet; see [Releasing](#releasing).

The TypeScript and JavaScript client for the Midwater API. Send each conversation your AI agents have, read back its outcome and the result of every check, follow agent health, and verify Midwater webhooks.

- No runtime dependencies; uses `fetch`.
- ESM and CommonJS, with types.
- Node 18 and later. The client also runs in edge runtimes and modern browsers, but **never put an API key in a browser**: anyone who opens the page can read it and use it for your whole environment. Call Midwater from your server; in a browser, use the client only against your own backend.

## Install

```sh
npm install @midwater/sdk
```

## Quickstart

Make a **test key** in the Midwater app (Developers page). Test keys start `mw_test_`; live keys start `mw_live_`. (Keys made before October 2026 start `vk_` and still work.) Each key belongs to one environment of one project, and everything you send and read is scoped to it.

The API key and the base URL are both required. The base URL is `https://api.midwater.ai`; the SDK doesn't assume it yet, so pass it or set `MIDWATER_BASE_URL`.

```sh
export MIDWATER_API_KEY=mw_test_...
export MIDWATER_BASE_URL=https://api.midwater.ai
```

```ts
import { Midwater } from "@midwater/sdk";

const midwater = new Midwater(); // reads MIDWATER_API_KEY and MIDWATER_BASE_URL; or new Midwater({ apiKey, baseUrl })

const { id } = await midwater.conversations.create({
  external_id: "call_8f2a91",          // your ID; sending it again returns the same conversation
  channel: "voice",                    // or "chat"
  ended_by: "caller",
  agent: { id: "front-desk", name: "Front desk", version: "1.0.0" },
  transcript: [
    { speaker: "agent", text: "Thanks for calling, this call may be recorded. How can I help?" },
    { speaker: "user", text: "I need to move my appointment to Thursday." },
    { speaker: "agent", text: "Done: Thursday at 10 AM." },
  ],
  events: [{ type: "tool_call", name: "reschedule_appointment", status: "success" }],
});

const conversation = await midwater.conversations.wait(id); // polls until scoring finishes
console.log(conversation.outcome); // "resolved" | "unresolved" | "escalated" | "not_real_inquiry" | null
for (const r of conversation.results) console.log(r.check_key, r.verdict, r.reason);
```

`create` resolves as soon as Midwater has stored the conversation (`status: "queued"`). Scoring runs in the background, usually within seconds. Use `wait`, poll `get`, or subscribe to the `conversation.evaluated` webhook.

## Reference

| Method | API |
|---|---|
| `conversations.create(params, { idempotencyKey? })` | `POST /v1/conversations` |
| `conversations.get(idOrExternalId)` | `GET /v1/conversations/{id}` |
| `conversations.wait(id, { timeoutMs?, intervalMs? })` | polls `GET /v1/conversations/{id}` until `done` or `failed` |
| `conversations.feedback(id, { check_key, verdict, note? }, { idempotencyKey? })` | `POST /v1/conversations/{id}/feedback` |
| `agents.health(agentId)` | `GET /v1/agents/{agent_id}/health` |
| `groups.health(groupId)` | `GET /v1/groups/{group_id}/health` |

Types for every request and response are exported (`ConversationCreateParams`, `Conversation`, `CheckResult`, `AgentHealth`, `GroupHealth`, `WebhookEvent`, …), written from the pinned copy of the app's API spec, [`openapi/midwater.json`](openapi/midwater.json).

**Versioning.** The API version is in the path (`/v1`). New fields, event types and enum values can appear without a new version, so don't fail on values you don't recognise. A breaking change would get `/v2`, with at least 6 months of overlap.

### Outcomes and results

- `outcome`: `resolved`, `unresolved`, `escalated` (handed to a person), `not_real_inquiry` (not a customer call, kept out of resolution rates), or `null` while scoring or when no outcome check applied.
- **Planned renames:** `outcome` `escalated` → `handed_to_person`, `not_real_inquiry` → `not_customer_call`, and `decided_by` `llm_judge` → `second_review`. The types already accept both names; handle both until the change is announced. The field name `verdict` stays.
- Each entry in `results` is one check: `verdict` is its result (`pass`, `fail`, `uncertain`, `not_applicable`, or `met` / `not_met` for gating questions), `score` the likelihood the problem occurred (0 to 1), `decided_by` how it was decided (`rule`, `model` for Midwater's model, `llm_judge` for a second review of unclear conversations, `human`), and `reason` why.

## Errors

Every error extends `MidwaterError`. API errors carry `status`, `type`, `message`, `fields`, `body` and `requestId`.

| Class | Status and type |
|---|---|
| `ValidationError` | 400 `invalid_json`, 422 `validation_error` (`fields` maps each path to its messages) |
| `AuthenticationError` | 401 `authentication_error` |
| `PermissionDeniedError` | 403 `permission_denied` (planned) |
| `NotFoundError` | 404 `not_found` |
| `MethodNotAllowedError` | 405 `method_not_allowed` (planned as JSON, with an `Allow` header) |
| `RequestTimeoutError` | 408 |
| `IdempotencyConflictError` | 409 `idempotency_conflict`: the key was used for a different request |
| `PayloadTooLargeError` | 413 `payload_too_large` (planned) |
| `RateLimitError` | 429 `rate_limited` (planned) |
| `ServiceUnavailableError` | 503 `service_unavailable` (planned); a `ServerError` |
| `ServerError` | other 5xx, `server_error` |
| `APIError` | any other status, by its class |
| `APIConnectionError` | no HTTP answer (DNS, connection, timeout) |
| `WaitTimeoutError` | `wait` gave up |

An unknown type or status never crashes the client: it maps by status class. `requestId` comes from `error.request_id` or the `Midwater-Request-Id` header; both are planned, so it's `undefined` until Midwater sends them.

## Retries and idempotency

- **What retries:** 408, 429, every 5xx, and network errors, on calls that are safe to repeat: GETs, `conversations.create` and `conversations.feedback`. At most 3 retries whatever `maxRetries` says (default 2), with exponential backoff and jitter, honouring a numeric `Retry-After` (capped at 60 s).
- **Idempotency keys:** every POST sends an `Idempotency-Key` (255 characters or fewer), yours if you pass `{ idempotencyKey }`, otherwise a new random one per call, reused on that call's retries. The API keeps a key for 24 hours per environment: the same key with the same request answers with the first response, and the SDK sets `replayed: true` on what `create` and `feedback` return. The same key with a different request raises `IdempotencyConflictError` (409); use a new key for a new request.
- Separately, sending an `external_id` that already exists answers with that conversation and `duplicate: true`.

## Webhooks

Midwater signs every webhook with your environment's signing secret (`whsec_…`, on the Developers page). Verify with the raw body, exactly as received:

```ts
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "@midwater/sdk/webhooks";

const app = express();
app.post("/midwater/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers, process.env.MIDWATER_WEBHOOK_SECRET!);
    if (event.type === "conversation.evaluated") console.log(event.data.outcome);
    res.sendStatus(204);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.status(400).send(e.reason);
    throw e;
  }
});
```

`verifyWebhook(payload, headers, secret, { toleranceSeconds? })` (also `webhooks.verify`) checks `Midwater-Signature` (`t=<seconds>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>`) in constant time, accepts the delivery if any of several `v1=` values matches, rejects timestamps more than 5 minutes from now, and returns the parsed event. Failures throw `WebhookVerificationError` with a `reason`: `missing_header`, `malformed_header`, `stale_timestamp`, `invalid_signature` or `no_secret`. `headers` can be a `Headers` object or a plain object. This entry point uses `node:crypto`, so it runs on servers. The signing secret is as sensitive as an API key: never put it in a browser or a mobile app.

Answer with any 2xx within 5 seconds, and deduplicate on the `Midwater-Delivery` header: a delivery can arrive more than once.

## Configuration

```ts
new Midwater({
  apiKey: "mw_live_...",   // required: or MIDWATER_API_KEY
  baseUrl: "https://api.midwater.ai", // required: or MIDWATER_BASE_URL; no default yet
  timeoutMs: 30_000,       // per attempt
  maxRetries: 2,           // at most 3
  fetch: customFetch,      // default: global fetch
});
```

The key never appears in errors, logs, `JSON.stringify(client)` or `console.log(client)`; a test proves it.

## Develop

```sh
npm ci
npm run typecheck && npm test && npm run build && npm run check:package && npm run check:openapi
```

`npm test` runs the unit tests with coverage (at least 90% required). `openapi/midwater.json` is a pinned copy of the app's spec: `openapi/midwater.json.sha256` records its checksum and `openapi/SOURCE` the app commit. The tests use the shared fixtures in `fixtures/`, generated from that spec in `midwater-docs`; `fixtures/SHA256SUMS` pins them, and a test fails when either pinned copy drifts. Don't edit them here: `scripts/pin-openapi.sh <app-commit>` in `midwater-docs` updates all three repos.

Contract tests run against a local Midwater stack and read the key from environment variables only:

```sh
MIDWATER_API_KEY=… MIDWATER_BASE_URL=http://localhost:3200 npm run test:contract
```

The throwaway workspace and test key come from the Midwater team's end-to-end runner, which records every throwaway account before it's created and revokes the key afterwards. Never use a customer's key.

**Superseded:** `npm run contract:setup` and `contract:teardown` signed up through the app's password form, which no longer exists (sign-in is by email code). They're kept for reference and refuse any host other than localhost.

## Releasing

Nothing is published today. Publishing needs a company-owned npm organisation `@midwater` and the owner's go. When that's in place:

1. Create the `midwater` organisation on npm under a company account with 2FA enforced, and add maintainers.
2. Configure npm trusted publishing for this repository's release workflow (OIDC, no long-lived token), with provenance.
3. Add a release workflow triggered by a `v*` tag that runs the CI steps, then `npm publish --provenance --access public`.
4. Bump `version` in `package.json` and `src/version.ts`, update `CHANGELOG.md`, tag `vX.Y.Z`, push the tag.

## License

MIT
