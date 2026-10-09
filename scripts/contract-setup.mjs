#!/usr/bin/env node
/**
 * Creates a throwaway workspace and a test API key on a local Midwater stack, the way a tenant would (sign up,
 * create a workspace, make a test key), and writes them to a git-ignored env file for the contract tests.
 *
 *   node scripts/contract-setup.mjs [--base-url http://localhost:3200] [--out .env.contract] [--out ../midwater-sdk-python/.env.contract]
 *
 * Nothing secret is printed: the key, the login password and the session cookie go only into the output files.
 * Refuses to run against anything but localhost.
 *
 * Cleanup guarantee (as the e2e runner does, PM review 45): before the sign-up is submitted, the throwaway login is
 * written to .secrets/throwaway/<run>.json (directory 0700, file 0600, git-ignored), and the key's ID is added once
 * it exists, so `contract-teardown.mjs` can always sign in and revoke, even after an aborted run.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outs = args.flatMap((a, i) => (a === "--out" ? [args[i + 1]] : []));
const baseUrl = (opt("--base-url", "http://localhost:3200") || "").replace(/\/+$/, "");
if (!outs.length) outs.push(".env.contract");

const host = new URL(baseUrl).hostname;
if (!["localhost", "127.0.0.1"].includes(host)) {
  console.error(`Refusing to create a throwaway workspace on ${host}: local stacks only.`);
  process.exit(2);
}

const jar = new Map();
function keep(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function req(path, init = {}) {
  const res = await fetch(baseUrl + path, { redirect: "manual", ...init, headers: { cookie: cookieHeader(), ...(init.headers ?? {}) } });
  keep(res);
  return res;
}

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const email = `sdk-contract-${stamp}@example.com`;
const password = randomBytes(18).toString("base64url");
const workspace = `SDK contract tests ${stamp} (throwaway)`;

const ledgerDir = ".secrets/throwaway";
const ledgerFile = `${ledgerDir}/${stamp}.json`;
const ledger = { runId: stamp, url: baseUrl, createdAt: new Date().toISOString(), workspace, email, password, keys: [], revoked: [] };
const saveLedger = () => {
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  chmodSync(".secrets", 0o700);
  chmodSync(ledgerDir, 0o700);
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  chmodSync(ledgerFile, 0o600);
};
saveLedger(); // before the account exists

// 1. Sign up through the product's own form (progressive-enhancement post of the sign-up action).
const page = await req("/signup");
const html = await page.text();
const hidden = [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => m[0]);
const form = new FormData();
for (const tag of hidden) {
  const name = tag.match(/name="([^"]*)"/)?.[1];
  const value = (tag.match(/value="([^"]*)"/)?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  if (name) form.append(name, value);
}
if (![...form.keys()].some((k) => k.startsWith("$ACTION"))) throw new Error("Sign-up form not found on /signup");
form.append("name", "SDK contract tests");
form.append("email", email);
form.append("password", password);
const signup = await req("/signup", { method: "POST", body: form });
if (![200, 303, 302, 307].includes(signup.status)) throw new Error(`Sign-up returned HTTP ${signup.status}`);
if (![...jar.keys()].some((k) => /session-token/.test(k))) throw new Error("Sign-up did not start a session");

// 2. A workspace of its own (Test and Live environments come with it).
const org = await req("/api/orgs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspace, timeZone: "UTC" }) });
if (org.status !== 201) throw new Error(`Creating the workspace returned HTTP ${org.status}`);

// 3. A test key, shown once.
const key = await req("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: "test", name: "SDK contract tests" }) });
if (key.status !== 201) throw new Error(`Creating the key returned HTTP ${key.status}`);
const { key: meta, secret } = await key.json();
ledger.keys.push(meta.id);
saveLedger();

const body = [
  "# Throwaway workspace for the SDK contract tests (local stack only). Never commit this file.",
  `MIDWATER_BASE_URL=${baseUrl}`,
  `MIDWATER_API_KEY=${secret}`,
  `MIDWATER_CONTRACT_WORKSPACE=${workspace}`,
  `MIDWATER_CONTRACT_LOGIN_EMAIL=${email}`,
  `MIDWATER_CONTRACT_LOGIN_PASSWORD=${password}`,
  `MIDWATER_CONTRACT_KEY_ID=${meta.id}`,
  `MIDWATER_CONTRACT_LEDGER=${ledgerFile}`,
  "",
].join("\n");
for (const out of outs) {
  writeFileSync(out, body, { mode: 0o600 });
  chmodSync(out, 0o600);
}
console.log(`Created workspace "${workspace}" and a ${meta.environment} key ending …${meta.last4}; login saved in ${ledgerFile}; wrote ${outs.join(", ")}.`);
