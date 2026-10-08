#!/usr/bin/env node
/** Every operation under `paths` in openapi/midwater.yaml must be wrapped by the SDK, and nothing else. */
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../openapi/midwater.yaml", import.meta.url), "utf8");
const paths = spec.slice(spec.indexOf("\npaths:"), spec.indexOf("\nx-midwater-webhook-delivery:"));
const ops = [...paths.matchAll(/operationId:\s*(\w+)/g)].map((m) => m[1]);
const covered = {
  createConversation: "conversations.create",
  getConversation: "conversations.get",
  createFeedback: "conversations.feedback",
  getAgentHealth: "agents.health",
  getGroupHealth: "groups.health",
};
const missing = ops.filter((o) => !covered[o]);
const stale = Object.keys(covered).filter((o) => !ops.includes(o));
if (missing.length || stale.length) {
  console.error(`Not wrapped: ${missing.join(", ") || "none"}. In the map but not the spec: ${stale.join(", ") || "none"}.`);
  process.exit(1);
}
console.log(`OpenAPI coverage: all ${ops.length} public operations wrapped.`);
