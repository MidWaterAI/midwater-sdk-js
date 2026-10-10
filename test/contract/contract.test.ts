/**
 * Contract tests against a running local Midwater stack. The key comes from environment variables only:
 * MIDWATER_API_KEY (a throwaway test key) and MIDWATER_BASE_URL (localhost). Skipped when either is missing.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthenticationError, Midwater, NotFoundError, ValidationError, type ConversationCreateParams } from "../../src/index";

const env = { MIDWATER_API_KEY: process.env.MIDWATER_API_KEY ?? "", MIDWATER_BASE_URL: process.env.MIDWATER_BASE_URL ?? "" };
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(env.MIDWATER_BASE_URL);
const enabled = !!env.MIDWATER_API_KEY && local;

describe.skipIf(!enabled)("contract: local Midwater stack", () => {
  const midwater = new Midwater({ apiKey: env.MIDWATER_API_KEY, baseUrl: env.MIDWATER_BASE_URL });
  const externalId = `js-contract-${randomUUID()}`;
  const conversation: ConversationCreateParams = {
    external_id: externalId,
    channel: "voice",
    started_at: new Date(Date.now() - 300_000).toISOString(),
    ended_at: new Date().toISOString(),
    ended_by: "caller",
    agent: { id: "js-contract-agent", name: "JS contract agent", version: "0.1.0" },
    group: { id: "js-contract-group", name: "JS contract group" },
    transcript: [
      { speaker: "agent", text: "Thanks for calling, this call may be recorded. How can I help?", start_ms: 0, end_ms: 2400 },
      { speaker: "user", text: "I need to move my appointment to Thursday.", start_ms: 2900, end_ms: 5100, asr_confidence: 0.93 },
      { speaker: "agent", text: "Sure, I have Thursday at 10 AM. Does that work?", start_ms: 5600, end_ms: 8200 },
      { speaker: "user", text: "Yes, that's perfect.", start_ms: 8700, end_ms: 9900 },
      { speaker: "agent", text: "Great, you're all set for Thursday at 10 AM.", start_ms: 61500, end_ms: 64000 },
    ],
    events: [{ type: "tool_call", name: "reschedule_appointment", status: "success", at_ms: 61000 }],
    metadata: { source: "midwater-sdk-js contract tests" },
  };
  let id = "";

  it("creates a conversation (202 queued)", async () => {
    const r = await midwater.conversations.create(conversation, { idempotencyKey: `idem-${externalId}` });
    expect(r.status).toBe("queued");
    expect(r.replayed).toBe(false);
    expect(r.duplicate).toBeUndefined();
    id = r.id;
  });

  it("replays the same idempotency key", async () => {
    const r = await midwater.conversations.create(conversation, { idempotencyKey: `idem-${externalId}` });
    expect(r).toMatchObject({ id, replayed: true });
  });

  it("answers an existing external_id with the existing conversation", async () => {
    const r = await midwater.conversations.create(conversation);
    expect(r).toMatchObject({ id, duplicate: true, replayed: false });
  });

  it("rejects an invalid payload with field errors", async () => {
    const err = await midwater.conversations.create({ external_id: "x", channel: "fax", transcript: [] } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(422);
    expect(Object.keys(err.fields)).toEqual(expect.arrayContaining(["channel", "transcript"]));
  });

  it("waits for scoring and reads the results, by id and by external_id", async () => {
    const c = await midwater.conversations.wait(id, { timeoutMs: 90_000 });
    expect(c.status).toBe("done");
    expect(c).toMatchObject({ id, external_id: externalId, channel: "voice", agent: { id: "js-contract-agent", version: "0.1.0" }, group: { id: "js-contract-group" } });
    expect(["resolved", "unresolved", "escalated", "not_real_inquiry", null]).toContain(c.outcome);
    expect(Array.isArray(c.results)).toBe(true);
    for (const r of c.results) {
      expect(typeof r.check_key).toBe("string");
      expect(["pass", "fail", "uncertain", "not_applicable", "met", "not_met"]).toContain(r.verdict);
      expect(r.scorer_version === null || typeof r.scorer_version === "string").toBe(true);
    }
    expect((await midwater.conversations.get(externalId)).id).toBe(id);
  }, 100_000);

  it("records feedback on a check result", async () => {
    const c = await midwater.conversations.get(id);
    const key = c.results[0]?.check_key;
    expect(key, "the conversation should have at least one result").toBeTruthy();
    const f = await midwater.conversations.feedback(externalId, { check_key: key!, verdict: "pass", note: "contract test" });
    expect(f).toMatchObject({ check_key: key, verdict: "pass", source: "api" });
    await expect(midwater.conversations.feedback(externalId, { check_key: "no_such_check", verdict: "pass" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers 404 for an unknown conversation", async () => {
    await expect(midwater.conversations.get(`missing-${randomUUID()}`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reads agent and group health in the test environment", async () => {
    const a = await midwater.agents.health("js-contract-agent");
    expect(a).toMatchObject({ agent_id: "js-contract-agent", environment: "test", group: { id: "js-contract-group" } });
    expect(["healthy", "watch", "at_risk", "not_enough_calls"]).toContain(a.health_status);
    expect(a.last_7_days.conversations).toBeGreaterThanOrEqual(1);
    const g = await midwater.groups.health("js-contract-group");
    expect(g.agents.map((x) => x.id)).toContain("js-contract-agent");
    await expect(midwater.agents.health(`missing-${randomUUID()}`)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an unknown key with AuthenticationError", async () => {
    const wrong = new Midwater({ apiKey: `mw_test_${"x".repeat(32)}`, baseUrl: env.MIDWATER_BASE_URL });
    await expect(wrong.conversations.get(id)).rejects.toBeInstanceOf(AuthenticationError);
  });
});
