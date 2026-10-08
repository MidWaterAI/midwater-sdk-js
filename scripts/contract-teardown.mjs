#!/usr/bin/env node
/**
 * Revokes the throwaway contract-test key the way a tenant would: signs in to the local Midwater app as the
 * throwaway workspace's owner and calls the app's revoke endpoint. Reads the git-ignored file written by
 * contract-setup.mjs. Prints nothing secret. Local stacks only.
 *
 *   node scripts/contract-teardown.mjs [--env .env.contract]
 */
import { readFileSync } from "node:fs";

const i = process.argv.indexOf("--env");
const file = i >= 0 ? process.argv[i + 1] : ".env.contract";
const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const baseUrl = env.MIDWATER_BASE_URL.replace(/\/+$/, "");
if (!["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname)) throw new Error("Local stacks only");

const jar = new Map();
const keep = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const k = pair.slice(0, pair.indexOf("=")).trim();
    const v = pair.slice(pair.indexOf("=") + 1).trim();
    if (!v || /max-age=0/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
};
const req = async (path, init = {}) => {
  const res = await fetch(baseUrl + path, { redirect: "manual", ...init, headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(init.headers ?? {}) } });
  keep(res);
  return res;
};

// Sign in through the product's own login form.
const html = await (await req("/login")).text();
const form = new FormData();
for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
  const name = tag.match(/name="([^"]*)"/)?.[1];
  const value = (tag.match(/value="([^"]*)"/)?.[1] ?? "").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  if (name) form.append(name, value);
}
form.append("email", env.MIDWATER_CONTRACT_LOGIN_EMAIL);
form.append("password", env.MIDWATER_CONTRACT_LOGIN_PASSWORD);
await req("/login", { method: "POST", body: form });
if (![...jar.keys()].some((k) => /session-token/.test(k))) throw new Error("Sign-in failed");

const res = await req(`/api/keys/${env.MIDWATER_CONTRACT_KEY_ID}/revoke`, { method: "POST" });
const body = await res.json();
if (res.status !== 200 || !body.key?.revokedAt) throw new Error(`Revoke returned HTTP ${res.status}`);

// Prove it: the key no longer authenticates.
const probe = await fetch(`${baseUrl}/v1/agents/default/health`, { headers: { authorization: `Bearer ${env.MIDWATER_API_KEY}` } });
console.log(`Key ${env.MIDWATER_CONTRACT_KEY_ID} revoked at ${body.key.revokedAt} in "${env.MIDWATER_CONTRACT_WORKSPACE}"; the key now gets HTTP ${probe.status}.`);
if (probe.status !== 401) process.exit(1);
