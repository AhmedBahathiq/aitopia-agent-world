import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const ENGINE_URL = process.env.ENGINE_URL;
if (!ENGINE_URL) throw new Error("ENGINE_URL is required");
const [action, seasonId] = process.argv.slice(2);

if (!new Set(["pause", "resume", "archive", "delete"]).has(action) || !seasonId) {
  throw new Error("Usage: node control-season.mjs <pause|resume|archive|delete> <season-id>");
}

const vars = Object.fromEntries(
  (await readFile(new URL("../.dev.vars", import.meta.url), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      const value = line.slice(separator + 1).trim();
      return [line.slice(0, separator).trim(), value.replace(/^(["'])(.*)\1$/, "$2")];
    }),
);

if (!vars.ADMIN_BRIDGE_SECRET) throw new Error("ADMIN_BRIDGE_SECRET is missing");

const path = `/api/seasons/${encodeURIComponent(seasonId)}/${action}`;
const body = "{}";
const timestamp = Math.floor(Date.now() / 1_000).toString();
const nonce = randomUUID();
const payload = [timestamp, nonce, "POST", path, body].join(".");
const signature = createHmac("sha256", vars.ADMIN_BRIDGE_SECRET).update(payload).digest("hex");
const response = await fetch(`${ENGINE_URL}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-admin-timestamp": timestamp,
    "x-admin-nonce": nonce,
    "x-admin-signature": `v1=${signature}`,
  },
  body,
});
const result = await response.json();
if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);

console.log(JSON.stringify(action === "delete"
  ? { seasonId, deleted: result.data.deleted }
  : { seasonId, status: result.data.status, simDay: result.data.simDay }));
