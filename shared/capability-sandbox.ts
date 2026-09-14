import type { AgentDecision } from "./contracts";

export type CapabilityDecision = {
  allowed: boolean;
  reason: "in_world_intent" | "external_capability_denied" | "invalid_target";
  deniedCapabilities: string[];
};

const EXTERNAL_CAPABILITY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "shell", pattern: /(?:shell|terminal|powershell|cmd|bash|سطر الأوامر|طرفية)/iu },
  { name: "filesystem", pattern: /(?:filesystem|file system|read file|write file|ملف(?:ات)? النظام|اقرأ ملف)/iu },
  { name: "sql", pattern: /(?:\bsql\b|sqlite|database|قاعدة البيانات|جدول البيانات)/iu },
  { name: "http", pattern: /(?:\bhttp\b|https?:\/\/|\burl\b|endpoint|رابط خارجي|طلب ويب)/iu },
  { name: "secrets", pattern: /(?:api[_ -]?key|secret|token|env(?:ironment)?|مفتاح سري|الأسرار)/iu },
  { name: "tools", pattern: /(?:function calling|code interpreter|web search|mcp|استدعاء أداة|ابحث في الإنترنت)/iu },
  { name: "code_execution", pattern: /(?:\beval\b|dynamic import|execute code|نفذ كود|شغّل كود)/iu },
];

export class AgentCapabilitySandbox {
  inspect(decision: AgentDecision, knownEntityIds: Set<string>): CapabilityDecision {
    const content = `${decision.intent}\n${decision.speech ?? ""}\n${decision.motive}`;
    const deniedCapabilities = EXTERNAL_CAPABILITY_PATTERNS.filter(({ pattern }) => pattern.test(content)).map(({ name }) => name);
    if (deniedCapabilities.length) return { allowed: false, reason: "external_capability_denied", deniedCapabilities };
    if (decision.targets.some((target) => !knownEntityIds.has(target))) return { allowed: false, reason: "invalid_target", deniedCapabilities: [] };
    return { allowed: true, reason: "in_world_intent", deniedCapabilities: [] };
  }
}

export function impossibleCapabilitySummary(actorName: string): string {
  return `${actorName} حاول فعل شيء لا وجود له كقدرة داخل الجزيرة، فلم يحدث شيء سوى ضياع بعض الوقت.`;
}
