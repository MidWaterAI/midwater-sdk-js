/**
 * Types for the Midwater API, written from openapi/midwater.yaml (the contract). Field names match the wire format.
 */

/** Which environment a key belongs to. Test keys start `mw_test_`, live keys `mw_live_`. */
export type Environment = "test" | "live";

export type Channel = "voice" | "chat";

/** `agent` is your AI agent, `user` the caller or chat user, `human_agent` a person who took over. */
export type Speaker = "agent" | "user" | "human_agent";

export type EndedBy = "agent" | "caller" | "user" | "human_agent" | "timeout" | "system";

export interface Turn {
  speaker: Speaker;
  text: string;
  /** Offset from the start of the conversation. */
  start_ms?: number;
  end_ms?: number;
  /** Speech-recognition confidence for this turn, 0 to 1 (voice). */
  asr_confidence?: number;
}

/** Something your agent did: a tool call, a transfer, a handoff. Extra properties are kept. */
export interface ConversationEvent {
  type: string;
  name?: string;
  status?: string;
  target?: string;
  at_ms?: number;
  [extra: string]: unknown;
}

export interface AgentRef {
  /** Letters, digits, `.`, `_`, `:` and `-`; starts with a letter or digit; at most 128 characters. */
  id?: string;
  name?: string;
  /** Your agent's release, e.g. `3.2.0`. */
  version?: string;
}

export interface GroupRef {
  id: string;
  name?: string;
}

/** The body of `POST /v1/conversations`. */
export interface ConversationCreateParams {
  /** Your ID for this call or chat; unique per environment. */
  external_id: string;
  channel: Channel;
  /** ISO 8601 with an offset, e.g. `2026-10-05T14:02:11Z`. */
  started_at?: string;
  ended_at?: string;
  /** `timeout` is valid for chat only. */
  ended_by?: EndedBy;
  /** Omit to use the project's Default agent. A new `id` creates the agent. */
  agent?: AgentRef;
  /** Files the agent into this group the first time it's seen without one. */
  group?: GroupRef;
  /** Every turn, in order. At least one. */
  transcript: Turn[];
  events?: ConversationEvent[];
  metadata?: Record<string, unknown>;
}

export type ConversationStatus = "queued" | "evaluating" | "done" | "failed";

export interface ConversationAccepted {
  id: string;
  status: ConversationStatus;
  /** `true` when a conversation with this `external_id` already existed (HTTP 200). */
  duplicate?: boolean;
  /** `true` when the response replays an earlier request with the same idempotency key. */
  replayed: boolean;
}

/**
 * How the conversation ended for the caller: Resolved, Unresolved, Handed to a person (`escalated`), or Not a
 * customer call (`not_real_inquiry`). `null` while scoring, or when no outcome check applied.
 */
export type Outcome = "resolved" | "unresolved" | "escalated" | "not_real_inquiry" | null;

/** A check's result: `pass`, `fail`, `uncertain`, `not_applicable`, or `met` / `not_met` for gating questions. */
export type CheckResultValue = "pass" | "fail" | "uncertain" | "not_applicable" | "met" | "not_met";

/** `rule`, `model` (Midwater's model), `llm_judge` (a second review for unclear conversations), `human`. */
export type DecidedBy = "rule" | "model" | "llm_judge" | "human" | null;

export interface CheckResult {
  check_key: string;
  check_name?: string;
  check_version: number;
  check_status: "draft" | "shadow" | "active";
  /** Likelihood that the problem occurred, 0 to 1. */
  score: number | null;
  /** The check's result. */
  verdict: CheckResultValue;
  choice: string | null;
  decided_by: DecidedBy;
  reason: string | null;
  evidence_turns: unknown[];
  /** Midwater's opaque scoring version, e.g. `2026-10-06.3`. */
  scorer_version: string;
  latency_ms: number | null;
}

export interface Conversation {
  id: string;
  external_id: string;
  channel: Channel;
  status: ConversationStatus;
  outcome: Outcome;
  dashboard_url: string;
  started_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
  agent: { id: string; name: string; version: string | null };
  group: { id: string; name: string } | null;
  transcript: Turn[];
  events: ConversationEvent[];
  metadata: Record<string, unknown>;
  results: CheckResult[];
}

export interface FeedbackCreateParams {
  check_key: string;
  /** Your team's answer: `pass` (no problem) or `fail` (the problem happened). */
  verdict: "pass" | "fail";
  note?: string;
}

export interface Feedback {
  id: string;
  check_key: string;
  verdict: "pass" | "fail";
  source: "api";
}

/** `not_enough_calls`: fewer than 5 calls with an outcome in the last 7 days. */
export type HealthStatus = "healthy" | "watch" | "at_risk" | "not_enough_calls";

export interface HealthWindow {
  conversations: number;
  with_outcome: number;
  resolution_rate: number | null;
  handed_to_person_rate: number | null;
  requests_for_person_not_honored: number;
  avg_frustration: number | null;
  compliance_failures: number;
}

export interface AgentHealth {
  agent_id: string;
  name: string;
  environment: Environment;
  health_status: HealthStatus;
  reason: string;
  group: { id: string; name: string } | null;
  last_7_days: HealthWindow;
  last_30_days: HealthWindow;
}

export interface GroupHealth {
  group_id: string;
  name: string;
  environment: Environment;
  health_status: HealthStatus;
  reason: string;
  agents: { id: string; name: string; health_status: HealthStatus }[];
  last_7_days: HealthWindow;
  last_30_days: HealthWindow;
}

export interface ApiErrorBody {
  error: { type: string; message: string; fields?: Record<string, string[]>; request_id?: string };
}

/* Webhooks */

export type WebhookEventType =
  | "conversation.evaluated"
  | "check.failed"
  | "check.failed.digest"
  | "agent.health_changed"
  | "group.health_changed"
  | "test";

export interface WebhookAgent {
  id: string;
  name: string;
  health_status: HealthStatus;
}

export interface ConversationEvaluatedData {
  conversation_id: string;
  external_id: string;
  agent: WebhookAgent;
  group?: { id: string; name: string };
  outcome: Outcome;
  results: { check_key: string; verdict: CheckResultValue; score: number | null; decided_by: DecidedBy; shadow: boolean }[];
}

export interface CheckFailedData {
  conversation: { id: string; external_id: string; channel: Channel; agent_version: string | null; ended_at: string | null };
  agent: WebhookAgent;
  group?: { id: string; name: string };
  check: { key: string; name: string; severity: "low" | "medium" | "high"; version: number };
  result: { score: number | null; verdict: CheckResultValue; decided_by: DecidedBy; reason: string | null };
  url: string;
}

export interface AgentHealthChangedData {
  agent: WebhookAgent;
  group?: { id: string; name: string };
  from: HealthStatus;
  to: HealthStatus;
  last_7_days: HealthWindow;
  last_30_days: HealthWindow;
  url: string;
}

export interface GroupHealthChangedData {
  group: { id: string; name: string };
  from: HealthStatus;
  to: HealthStatus;
  agent: { id: string; name: string } | null;
  last_7_days: HealthWindow;
  last_30_days: HealthWindow;
  url: string;
}

interface Envelope<T extends WebhookEventType, D> {
  id: string;
  type: T;
  environment: Environment;
  created_at: string;
  data: D;
}

export type WebhookEvent =
  | Envelope<"conversation.evaluated", ConversationEvaluatedData>
  | Envelope<"check.failed", CheckFailedData>
  | Envelope<"check.failed.digest", { count: number; items: CheckFailedData[] }>
  | Envelope<"agent.health_changed", AgentHealthChangedData>
  | Envelope<"group.health_changed", GroupHealthChangedData>
  | Envelope<"test", { message: string; destination?: string; url?: string }>;
