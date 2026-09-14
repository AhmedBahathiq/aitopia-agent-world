import type { HistoricalClaim, HistoryEntity, ResolvedEvent, WorldSnapshot } from "./contracts";
import { deterministicId } from "./random";

export function deriveHistoricalClaims(world: WorldSnapshot, events: ResolvedEvent[]): HistoricalClaim[] {
  return events.filter((event) => event.kind === "speech" && /(?:سمعت|يقولون|كان|حدث|أتذكر)/u.test(event.text)).map((event) => ({
    id: deterministicId("claim", world.seed, event.tick, event.id),
    subjectId: event.targetIds[0] ?? event.actorId ?? "world",
    statement: event.text,
    sourceId: event.id,
    communityId: null,
    confidence: 0.25 * speakerTrust(world, event.actorId),
    evidenceIds: [event.id],
    validFromSimDay: event.simDay,
    stance: /(?:بطل|عظيم|أنقذ)/u.test(event.text) ? "glorification" : /(?:خائن|شرير|دمّر)/u.test(event.text) ? "demonization" : "neutral",
  }));
}

export function deriveObserverEntities(world: WorldSnapshot, allEvents: ResolvedEvent[], existing: HistoryEntity[]): HistoryEntity[] {
  const additions: HistoryEntity[] = [];
  const add = (entity: HistoryEntity) => { if (![...existing, ...additions].some((item) => item.id === entity.id)) additions.push(entity); };

  for (const discovery of world.discoveries.filter((item) => item.confirmed)) {
    add({ id: `observer-discovery-${discovery.id}`, type: "discovery", name: "تقنية ناشئة", startedAtSimDay: discovery.createdAtSimDay, endedAtSimDay: null, memberIds: [discovery.agentId], eventIds: [], description: discovery.idea });
  }
  for (const event of allEvents.filter((item) => item.kind === "migration")) {
    add({ id: `observer-migration-${event.id}`, type: "migration", name: "انتقال سكاني", startedAtSimDay: event.simDay, endedAtSimDay: event.simDay, memberIds: event.actorId ? [event.actorId] : [], eventIds: [event.id], description: event.omniscientDetail });
  }
  const voteEvents = allEvents.filter((event) => event.kind === "speech" && /(?:يصوت|تصويت|يختار كل واحد|أكثر الأصوات)/u.test(event.text));
  if (voteEvents.length >= 3) add({ id: "observer-government-voting-1", type: "government", name: "نمط اختيار متكرر", startedAtSimDay: voteEvents[0].simDay, endedAtSimDay: null, memberIds: [...new Set(voteEvents.flatMap((event) => [event.actorId, ...event.targetIds].filter((id): id is string => Boolean(id))))], eventIds: voteEvents.map((event) => event.id), description: "صنّف المراقب السلوك المتكرر كنظام اختيار؛ لا يدخل هذا الاسم معرفة السكان." });
  const leaderEvents = allEvents.filter((event) => event.kind === "speech" && /(?:قائد|يحكم|حاكم|القرار الأخير)/u.test(event.text));
  if (leaderEvents.length >= 3) add({ id: "observer-ruler-pattern-1", type: "ruler", name: "سلطة معترف بها", startedAtSimDay: leaderEvents[0].simDay, endedAtSimDay: null, memberIds: [...new Set(leaderEvents.flatMap((event) => event.targetIds))], eventIds: leaderEvents.map((event) => event.id), description: "تسمية مراقب لنمط سلطة متكرر." });
  const conflicts = allEvents.filter((event) => event.kind === "conflict");
  if (conflicts.length >= 4) add({ id: "observer-war-pattern-1", type: "war", name: "صراع ممتد", startedAtSimDay: conflicts[0].simDay, endedAtSimDay: null, memberIds: [...new Set(conflicts.flatMap((event) => [event.actorId, ...event.targetIds].filter((id): id is string => Boolean(id))))], eventIds: conflicts.map((event) => event.id), description: "صنّف المراقب تكرار العنف كصراع ممتد دون حكم أخلاقي." });
  const languageEvents = allEvents.filter((event) => event.kind === "speech" && /(?:نسميه|نسميها|معناها|هذي الكلمة)/u.test(event.text));
  if (languageEvents.length >= 2) add({ id: "observer-language-pattern-1", type: "language", name: "مفردات محلية ناشئة", startedAtSimDay: languageEvents[0].simDay, endedAtSimDay: null, memberIds: [...new Set(languageEvents.flatMap((event) => [event.actorId, ...event.targetIds].filter((id): id is string => Boolean(id))))], eventIds: languageEvents.map((event) => event.id), description: "رصد المراقب تداول مفردات أو معانٍ محلية." });
  return additions;
}

function speakerTrust(world: WorldSnapshot, speakerId: string | null): number {
  if (!speakerId) return 0.5;
  const incoming = world.relationships.filter((relationship) => relationship.toId === speakerId);
  if (!incoming.length) return 0.5;
  return Math.max(0, Math.min(1, incoming.reduce((sum, relationship) => sum + relationship.trust / 100, 0) / incoming.length));
}
