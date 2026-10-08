#!/usr/bin/env node
/** Loads the built package both ways and checks the main entry stays browser-safe (no node: imports). */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const esm = await import("../dist/index.js");
const cjs = require("../dist/index.cjs");
const hooksEsm = await import("../dist/webhooks.js");
const hooksCjs = require("../dist/webhooks.cjs");
const fail = (m) => { console.error(m); process.exit(1); };
for (const [name, mod] of [["esm", esm], ["cjs", cjs]]) {
  if (typeof mod.Midwater !== "function") fail(`${name}: Midwater missing`);
  if (typeof mod.ValidationError !== "function") fail(`${name}: errors missing`);
}
for (const [name, mod] of [["esm", hooksEsm], ["cjs", hooksCjs]]) if (typeof mod.webhooks?.verify !== "function") fail(`${name}: webhooks.verify missing`);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (esm.VERSION !== pkg.version) fail(`VERSION ${esm.VERSION} != package.json ${pkg.version}`);
const main = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const chunks = [...main.matchAll(/from "\.\/(chunk-[\w-]+\.js)"/g)].map((m) => readFileSync(new URL(`../dist/${m[1]}`, import.meta.url), "utf8"));
if ([main, ...chunks].some((s) => /["']node:/.test(s))) fail("dist/index.js imports a node: module; the client must stay browser-safe");
const instance = new esm.Midwater({ apiKey: "mw_test_" + "x".repeat(32), baseUrl: "http://localhost:3200", fetch: async () => new Response("{}") });
if (JSON.stringify(instance).includes("mw_test_")) fail("key visible in JSON");
console.log(`@midwater/sdk ${pkg.version}: ESM and CJS load, webhooks subpath loads, main entry is browser-safe.`);
