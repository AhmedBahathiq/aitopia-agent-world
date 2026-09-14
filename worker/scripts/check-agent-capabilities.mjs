import { readFile } from "node:fs/promises";

const files = [
  new URL("../../shared/brain.ts", import.meta.url),
  new URL("../../shared/simulation.ts", import.meta.url),
  new URL("../../shared/free-action-resolver.ts", import.meta.url),
  new URL("../../shared/knowledge-contamination.ts", import.meta.url),
];

const forbidden = [
  [/\bfetch\s*\(/u, "network fetch"],
  [/\beval\s*\(/u, "eval"],
  [/\bnew\s+Function\b/u, "Function constructor"],
  [/\bimport\s*\(/u, "dynamic import"],
  [/\bprocess\.env\b/u, "environment access"],
  [/\bthis\.sql\b/u, "SQL access"],
  [/\bnew\s+URL\s*\(/u, "URL construction"],
  [/\btool_choice\b/u, "model tool selection"],
];

const violations = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const [pattern, label] of forbidden) if (pattern.test(source)) violations.push(`${file.pathname}: ${label}`);
}

if (violations.length) throw new Error(`Agent capability boundary violated:\n${violations.join("\n")}`);
console.log("Agent cognition and resolver modules contain no real system capabilities.");
