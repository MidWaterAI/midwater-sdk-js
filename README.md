# Midwater JavaScript SDK

The official TypeScript and JavaScript client for the [Midwater API](https://docs.midwater.ai). Send each conversation your AI agents have, read back its outcome and the result of every check, follow agent health, and verify Midwater webhooks.

- Zero runtime dependencies; uses `fetch`.
- ESM and CommonJS, with types.
- Node 18 and later. The client also runs in modern browsers and edge runtimes, but your API key is a secret: call Midwater from your server, not from a web page.

> **Not published yet.** `@midwater/sdk` isn't on npm. Until it is, install from this repository (see [Releasing](#releasing)).

## Install

```sh
npm install @midwater/sdk
```

## Quickstart

Make a **test key** in the Midwater app (Developers page). Test keys start `mw_test_`; live keys start `mw_live_`. Each key belongs to one environment of one project, and everything you send and read is scoped to it.

```sh
export MIDWATER_API_KEY=mw_test_...
# Only needed for a non-production host:
export MIDWATER_BASE_URL=https://api.midwater.ai
```

```ts
import { Midwater } from "@midwater/sdk";

const midwater = new Midwater(); // reads MIDWATER_API_KEY and MIDWATER_BASE_URL

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
| `conversations.feedback(id, { check_key, verdict, note? })` | `POST /v1/conversations/{id}/feedback` |
| `agents.health(agentId)` | `GET /v1/agents/{agent_id}/health` |
| `groups.health(groupId)` | `GET /v1/groups/{group_id}/health` |
| `request(method, path, body?)` | anything else under `/v1` |

Types for every request and response are exported: `ConversationCreateParams`, `Conversation`, `CheckResult`, `AgentHealth`, `GroupHealth`, `WebhookEvent`, and more. They're written from the OpenAPI document in [`openapi/midwater.yaml`](openapi/midwater.yaml).

### Outcomes and results

- `outcome`: `resolved`, `unresolved`, `escalated` (handed to a person), `not_real_inquiry` (not a customer call, kept out of resolution rates), or `null` while scoring or when no outcome check applied.
- Each entry in `results` is one check: `verdict` is its result (`pass`, `fail`, `uncertain`, `not_applicable`, or `met` / `not_met` for gating questions), `score` the likelihood the problem occurred (0 to 1), `decided_by` how it was decided (`rule`, `model` for Midwater's model, `llm_judge` for a second review of unclear conversations, `human`), and `reason` why.

### Agents and groups

Send `agent.id` with each conversation; a new ID creates the agent. Without it, the conversation goes to the project's Default agent (`default`). IDs use letters, digits, `.`, `_`, `:` and `-`. An optional `group: { id, name? }` files a new agent into a group until someone moves it in the app.

```ts
const health = await midwater.agents.health("front-desk");
// health.health_status: "healthy" | "watch" | "at_risk" | "not_enough_calls"
```

Health is measured per environment: a test key reads test health.

## Errors

Every error extends `MidwaterError`. API errors carry `status`, `type`, `message`, `fields` and `body`.

| Class | When |
|---|---|
| `AuthenticationError` | 401: missing, unknown or revoked key |
| `ValidationError` | 400 (body isn't JSON) or 422; `fields` maps each path to its messages |
| `NotFoundError` | 404 in the key's environment |
| `RateLimitError` | 429 |
| `ServerError` | 5xx |
| `APIError` | any other error status |
| `APIConnectionError` | no HTTP answer (DNS, connection, timeout) |
| `WaitTimeoutError` | `wait` gave up |

```ts
import { ValidationError } from "@midwater/sdk";

try {
  await midwater.conversations.create(payload);
} catch (e) {
  if (e instanceof ValidationError) console.error(e.fields); // { "transcript.0.speaker": ["Invalid enum value…"] }
  else throw e;
}
```

## Retries and idempotency

The client retries 429, 500, 502, 503, 504 and network errors up to `maxRetries` times (default 2) with exponential backoff, honouring `Retry-After` when present. GETs always retry. `conversations.create` sends an `Idempotency-Key` header on every call (a random one unless you pass `{ idempotencyKey }`), so a retry never stores a conversation twice. `feedback` isn't idempotent and isn't retried.

Passing your own key, such as your `external_id`, also makes retries across process restarts safe. A repeated key answers with the first response and `replayed: true`; Midwater doesn't compare bodies, so use a new key for a different conversation. Separately, sending an `external_id` that already exists answers with that conversation and `duplicate: true`.

## Webhooks

Midwater signs every webhook with your environment's signing secret (`whsec_…`, on the Developers page). Verify with the raw body, exactly as received:

```ts
import express from "express";
import { webhooks, WebhookVerificationError } from "@midwater/sdk/webhooks";

const app = express();
app.post("/midwater/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = webhooks.verify(req.body, req.headers, process.env.MIDWATER_WEBHOOK_SECRET!);
    if (event.type === "conversation.evaluated") console.log(event.data.outcome);
    res.sendStatus(204);
  } catch (e) {
    if (e instanceof WebhookVerificationError) return res.status(400).send(e.reason);
    throw e;
  }
});
```

`verify(payload, headers, secret, { toleranceSeconds? })` checks `Midwater-Signature` (`t=<seconds>,v1=<hex>`, HMAC-SHA256 of `<t>.<raw body>`) in constant time, accepts any of several `v1` values during secret rotation, rejects timestamps more than 300 s from now, and returns the parsed event. `headers` can be a `Headers` object or a plain object. Until launch, Midwater also sends the same signature as `Verdict-Signature`, the header's name before the product was renamed; `verify` reads it only when `Midwater-Signature` is missing. `@midwater/sdk/webhooks` uses `node:crypto`, so it runs on servers.

Answer with any 2xx within 5 seconds. Other answers are retried three times (after about 2, 8 and 30 seconds) with the same `Midwater-Delivery` ID, so deduplicate on it.

## Configuration

```ts
new Midwater({
  apiKey: "mw_live_...",              // default: MIDWATER_API_KEY
  baseUrl: "https://api.midwater.ai", // default: MIDWATER_BASE_URL, then the production host (a placeholder until launch)
  timeoutMs: 30_000,                  // per attempt
  maxRetries: 2,
  fetch: customFetch,                 // default: global fetch
});
```

The key never appears in errors, `JSON.stringify(client)` or `console.log(client)`.

## Develop

```sh
npm ci
npm run typecheck && npm test && npm run build && npm run check:package && npm run check:openapi
```

Contract tests run against a local Midwater stack (`http://localhost:3200`). `npm run contract:setup` signs up a throwaway workspace there, makes a test key, and writes both to the git-ignored `.env.contract`; then `npm run test:contract`. The setup script refuses any host other than localhost.

## Releasing

Nothing is published today. Publishing needs a company-owned npm organisation `@midwater` and the owner's go. When that's in place:

1. Create the `midwater` organisation on npm under a company account with 2FA enforced, and add maintainers.
2. Configure npm trusted publishing for this repository's release workflow (OIDC, no long-lived token), with provenance.
3. Add a release workflow triggered by a `v*` tag that runs the CI steps, then `npm publish --provenance --access public`.
4. Bump `version` in `package.json` and `src/version.ts`, update `CHANGELOG.md`, tag `vX.Y.Z`, push the tag.

## License

MIT
