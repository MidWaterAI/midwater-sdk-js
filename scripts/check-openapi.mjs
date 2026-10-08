#!/usr/bin/env node
/** Every operation in openapi/midwater.yaml must be wrapped by the SDK (or listed here as deliberately not). */
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../openapi/midwater.yaml", import.meta.url), "utf8");
const ops = [...spec.matchAll(/operationId:\s*(\w+)/g)].map((m) => m[1]);
const covered = {
  createConversation: "conversations.create",
  getConversation: "conversations.get",
  createFeedback: "conversations.feedback",
  getAgentHealth: "agents.health",
  getGroupHealth: "groups.health",
};
const deliberatelyUnwrapped = { streamTurns: "always 501 today; reachable through client.request()" };
const missing = ops.filter((o) => !covered[o] && !deliberatelyUnwrapped[o]);
const stale = Object.keys(covered).filter((o) => !ops.includes(o));
if (missing.length || stale.length) {
  console.error(`Not wrapped: ${missing.join(", ") || "none"}. In the map but not the spec: ${stale.join(", ") || "none"}.`);
  process.exit(1);
}
console.log(`OpenAPI coverage: ${Object.keys(covered).length} operations wrapped, ${Object.keys(deliberatelyUnwrapped).length} deliberately not (${Object.keys(deliberatelyUnwrapped).join(", ")}).`);
