import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const ENGINE_URL = process.env.ENGINE_URL;
if (!ENGINE_URL) throw new Error("ENGINE_URL is required");

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

const existingResponse = await fetch(`${ENGINE_URL}/api/seasons`);
const existing = await existingResponse.json();
if (!existingResponse.ok || !existing.ok) throw new Error("Unable to inspect existing seasons");
if (existing.data.length !== 0) throw new Error("Expected a clean environment with zero seasons");

const path = "/api/seasons";
const body = JSON.stringify({
  title: "محاكاة الجزيرة · الموسم الأول",
  seed: randomUUID(),
  speed: 1,
  initialExpectedCapacity: 24,
  initialCharacters: [
    { name: "سالم", sex: "male", ageYears: 29, traits: ["هادئ", "مثابر", "حذر"], aptitudes: ["ملاحظة", "تنسيق اليد"] },
    { name: "نورة", sex: "female", ageYears: 27, traits: ["فضولية", "شجاعة", "مستقلة"], aptitudes: ["استكشاف", "تجريب"] },
    { name: "ريم", sex: "female", ageYears: 31, traits: ["رحيمة", "دقيقة", "صبورة"], aptitudes: ["ملاحظة", "رعاية"] },
  ],
});
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

console.log(JSON.stringify({
  created: true,
  seasonId: result.data.seasonId,
  population: result.data.characters.length,
  names: result.data.characters.map((character) => character.name),
  status: result.data.status,
  simDay: result.data.simDay,
  aiCalls: result.data.usage.calls,
}));
