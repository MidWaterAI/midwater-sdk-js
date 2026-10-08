import { APIConnectionError, errorFor, MidwaterError, WaitTimeoutError } from "./errors";
import type {
  AgentHealth,
  Conversation,
  ConversationAccepted,
  ConversationCreateParams,
  Feedback,
  FeedbackCreateParams,
  GroupHealth,
} from "./types";
import { VERSION } from "./version";

/** The production API host. A placeholder until deployment; set `baseUrl` or `MIDWATER_BASE_URL` to override. */
export const DEFAULT_BASE_URL = "https://api.midwater.ai";

const KEY_SHAPE = /^(mw|vk)_(test|live)_/;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface MidwaterOptions {
  /** Defaults to `process.env.MIDWATER_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.MIDWATER_BASE_URL`, then {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /** Retries after the first attempt on 429, 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** A fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Waits between retries; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  /** Makes a retry of this request safe. `conversations.create` makes one for you when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WaitOptions {
  /** Give up after this long. Default 60 000 ms. */
  timeoutMs?: number;
  /** Time between polls. Default 1 000 ms. */
  intervalMs?: number;
  signal?: AbortSignal;
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name] || undefined;
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Node 18 has no global crypto.randomUUID by default; uniqueness is all an idempotency key needs.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Midwater API client.
 *
 * ```ts
 * const midwater = new Midwater(); // reads MIDWATER_API_KEY and MIDWATER_BASE_URL
 * const { id } = await midwater.conversations.create({ external_id: "call_8f2a91", channel: "voice", transcript });
 * const conversation = await midwater.conversations.wait(id);
 * ```
 */
export class Midwater {
  readonly baseUrl: string;
  readonly conversations: Conversations;
  readonly agents: Agents;
  readonly groups: Groups;
  /** `test` or `live`, from the key's prefix. */
  readonly environment: "test" | "live";

  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: MidwaterOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("MIDWATER_API_KEY");
    if (!apiKey) throw new MidwaterError("No API key. Set MIDWATER_API_KEY or pass { apiKey }.");
    const shape = KEY_SHAPE.exec(apiKey);
    if (!shape) throw new MidwaterError("That doesn't look like a Midwater API key: keys start mw_test_ or mw_live_.");
    this.#apiKey = apiKey;
    this.environment = shape[2] as "test" | "live";
    this.baseUrl = (options.baseUrl ?? readEnv("MIDWATER_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2);
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new MidwaterError("No fetch implementation found. Use Node 18+ or pass { fetch }.");
    this.#fetch = f;
    this.#sleep = options.sleep ?? defaultSleep;
    this.conversations = new Conversations(this);
    this.agents = new Agents(this);
    this.groups = new Groups(this);
  }

  /** Keeps the key out of logs and console output. */
  toJSON() {
    return { baseUrl: this.baseUrl, environment: this.environment };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Midwater { baseUrl: '${this.baseUrl}', environment: '${this.environment}' }`;
  }

  /** Sends one request with retries. Exposed for endpoints the SDK doesn't wrap yet. */
  async request<T>(method: "GET" | "POST", path: string, body?: unknown, opts: RequestOptions = {}): Promise<{ data: T; status: number; headers: Headers }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      "user-agent": `midwater-js/${VERSION}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    // Without an idempotency key a retried POST could store a conversation twice, so only safe requests retry.
    const retryable = method === "GET" || !!opts.idempotencyKey;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const last = !retryable || attempt >= this.#maxRetries;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.#fetch(this.baseUrl + path, { method, headers, body: payload, signal: controller.signal });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (last) throw new APIConnectionError(`Couldn't reach Midwater at ${this.baseUrl}: ${(e as Error)?.message ?? e}`, e);
        await this.#sleep(backoff(attempt));
        continue;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON: keep the text */
      }
      if (res.ok) return { data: parsed as T, status: res.status, headers: res.headers };
      if (last || !RETRY_STATUSES.has(res.status)) throw errorFor(res.status, parsed);
      await this.#sleep(retryAfter(res.headers) ?? backoff(attempt));
    }
  }
}

/** 0.5 s, 1 s, 2 s, … capped at 8 s, with full jitter on the upper half. */
function backoff(attempt: number) {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/** Midwater doesn't send Retry-After today; honoured when it does (seconds only), capped at 60 s. */
function retryAfter(h: Headers) {
  const v = h.get("retry-after");
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return undefined;
  return Math.min(60_000, Number(v) * 1000);
}

const seg = (s: string) => encodeURIComponent(s);

export class Conversations {
  constructor(private readonly client: Midwater) {}

  /**
   * Sends a finished conversation. Resolves once Midwater has stored it (`status: "queued"`), before scoring.
   * An idempotency key is generated when you don't pass one, so retries never store the conversation twice.
   */
  async create(params: ConversationCreateParams, opts: RequestOptions = {}): Promise<ConversationAccepted> {
    const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
    const r = await this.client.request<Omit<ConversationAccepted, "replayed">>("POST", "/v1/conversations", params, { ...opts, idempotencyKey });
    return { ...r.data, replayed: r.headers.get("idempotent-replayed") === "true" };
  }

  /** A conversation with its outcome and check results. `id` is Midwater's ID or your `external_id`. */
  async get(id: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<Conversation> {
    return (await this.client.request<Conversation>("GET", `/v1/conversations/${seg(id)}`, undefined, opts)).data;
  }

  /** Polls until scoring finishes (`done` or `failed`) and returns the conversation. */
  async wait(id: string, opts: WaitOptions = {}): Promise<Conversation> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await this.get(id, { signal: opts.signal });
      if (c.status === "done" || c.status === "failed") return c;
      if (Date.now() + intervalMs > deadline) throw new WaitTimeoutError(`Conversation ${id} was still ${c.status} after ${Math.round(timeoutMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Confirms or corrects one check's result on a conversation. Each call adds a label. */
  async feedback(id: string, params: FeedbackCreateParams, opts: Pick<RequestOptions, "signal"> = {}): Promise<Feedback> {
    return (await this.client.request<Feedback>("POST", `/v1/conversations/${seg(id)}/feedback`, params, opts)).data;
  }
}

export class Agents {
  constructor(private readonly client: Midwater) {}

  /** The agent's health in the key's environment. `agentId` is the `agent.id` you send, or `default`. */
  async health(agentId: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<AgentHealth> {
    return (await this.client.request<AgentHealth>("GET", `/v1/agents/${seg(agentId)}/health`, undefined, opts)).data;
  }
}

export class Groups {
  constructor(private readonly client: Midwater) {}

  /** The group's health: the worst of its agents, each agent's status, and totals. */
  async health(groupId: string, opts: Pick<RequestOptions, "signal"> = {}): Promise<GroupHealth> {
    return (await this.client.request<GroupHealth>("GET", `/v1/groups/${seg(groupId)}/health`, undefined, opts)).data;
  }
}

