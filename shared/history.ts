import type {
  AgentBrain,
  CharacterState,
  HistoricalClaim,
  HistoricalPersonSnapshot,
  HistoryEntity,
  HistoryView,
  ImpactRankingEntry,
  MemoryRecord,
  ResolvedEvent,
  WorldSnapshot,
} from "./contracts";
import { projectEvent } from "./contracts";

export function createHistoricalPersonSnapshot(
  world: WorldSnapshot,
  personId: string,
  brain: AgentBrain,
  events: ResolvedEvent[],
): HistoricalPersonSnapshot {
  const person = world.characters.find((character) => character.id === personId);
  if (!person) throw new Error("historical_person_not_found");
  const relatedEvents = events.filter((event) => event.actorId === personId || event.targetIds.includes(personId));
  const importantMemories = brain.memoryIndex.filter(isImportantMemory);
  const descendants = descendantsOf(world, personId);
  const discoveries = world.discoveries.filter((item) => item.agentId === personId).map((item) => item.id);
  const relationshipHistory = world.relationships.filter((relationship) => relationship.fromId === personId || relationship.toId === personId);
  const impact = calculateHistoricalImpact(world, person, relatedEvents, descendants.length, importantMemories.length);
  return {
    person: stripWorkingState(person),
    biography: buildBiography(person, relatedEvents, discoveries.length, descendants.length),
    relationshipHistory,
    descendants,
    discoveries,
    importantMemories,
    beliefs: [...brain.beliefs],
    eventIds: relatedEvents.map((event) => event.id),
    historicalImpact: impact.score,
  };
}

export function isImportantMemory(memory: MemoryRecord): boolean {
  const importantKinds = new Set(["birth", "death", "discovery", "conflict", "migration", "government", "relationship"]);
  return memory.importance >= 0.65 || memory.emotionalImpact >= 0.65 || memory.tags.some((tag) => importantKinds.has(tag) || tag === "historical-claim");
}

export function compressibleWorkingMemories(brain: AgentBrain): MemoryRecord[] {
  return brain.memoryIndex.filter((memory) => !isImportantMemory(memory));
}

export function timelineFor(events: ResolvedEvent[], view: HistoryView, atDay?: number): ResolvedEvent[] {
  return events
    .filter((event) => atDay === undefined || event.simDay <= atDay)
    .sort((a, b) => a.simDay - b.simDay || (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((event) => projectEvent(event, view));
}

export function socialClaimsAsOf(claims: HistoricalClaim[], asOfDay: number): HistoricalClaim[] {
  return claims.filter((claim) => claim.validFromSimDay <= asOfDay).sort((a, b) => b.confidence - a.confidence);
}

export function descendantsOf(world: WorldSnapshot, rootId: string): string[] {
  const result = new Set<string>();
  let frontier = [rootId];
  while (frontier.length) {
    const parents = new Set(frontier);
    const children = world.worldTruth.lineage.filter((line) => parents.has(line.motherId) || parents.has(line.fatherId)).map((line) => line.childId).filter((id) => !result.has(id));
    children.forEach((id) => result.add(id));
    frontier = children;
  }
  return [...result];
}

export function familyTree(world: WorldSnapshot, rootId?: string): Array<{ person: CharacterState; parents: string[]; children: string[] }> {
  const included = rootId ? new Set([rootId, ...descendantsOf(world, rootId)]) : new Set(world.characters.map((person) => person.id));
  return world.characters.filter((person) => included.has(person.id)).map((person) => {
    const lineage = world.worldTruth.lineage.find((line) => line.childId === person.id);
    const children = world.worldTruth.lineage.filter((line) => line.motherId === person.id || line.fatherId === person.id).map((line) => line.childId);
    return { person: stripWorkingState(person), parents: lineage ? [lineage.motherId, lineage.fatherId] : [], children };
  });
}

export function impactRanking(world: WorldSnapshot, events: ResolvedEvent[], claims: HistoricalClaim[] = []): ImpactRankingEntry[] {
  return world.characters.map((person) => {
    const personEvents = events.filter((event) => event.actorId === person.id || event.targetIds.includes(person.id));
    const descendants = descendantsOf(world, person.id).length;
    const cultural = claims.filter((claim) => claim.subjectId === person.id).length;
    return calculateHistoricalImpact(world, person, personEvents, descendants, cultural);
  }).sort((a, b) => b.score - a.score);
}

export function entitiesByType(entities: HistoryEntity[], type?: HistoryEntity["type"], atDay?: number): HistoryEntity[] {
  return entities.filter((entity) => (!type || entity.type === type) && (atDay === undefined || entity.startedAtSimDay <= atDay));
}

function calculateHistoricalImpact(world: WorldSnapshot, person: CharacterState, events: ResolvedEvent[], descendants: number, culturalMemories: number): ImpactRankingEntry {
  const techniques = world.discoveries.filter((discovery) => discovery.agentId === person.id && discovery.confirmed).length;
  const institutions = events.filter((event) => event.kind === "government").length;
  const conflicts = events.filter((event) => event.kind === "conflict").length;
  const migrations = events.filter((event) => event.kind === "migration" || event.kind === "settlement").length;
  const components = {
    techniques: normalized(techniques, 8),
    institutions: normalized(institutions, 5),
    lineageAndCare: normalized(descendants, 20),
    conflictsAndTreaties: normalized(conflicts, 12),
    migrationsAndSettlements: normalized(migrations, 10),
    culturalMemory: normalized(culturalMemories, 20),
  };
  const score = components.techniques * 25 + components.institutions * 20 + components.lineageAndCare * 15 + components.conflictsAndTreaties * 15 + components.migrationsAndSettlements * 15 + components.culturalMemory * 10;
  return { personId: person.id, name: person.name, score: Math.round(score * 100) / 100, components };
}

function stripWorkingState(person: CharacterState): CharacterState {
  return { ...structuredClone(person), currentActivity: null, scheduler: { ...person.scheduler, class: "sleeping", nextDueSimTime: Number.MAX_SAFE_INTEGER, majorEventPending: false } };
}

function buildBiography(person: CharacterState, events: ResolvedEvent[], discoveryCount: number, descendantCount: number): string {
  const years = Math.max(0, Math.round(person.ageYears));
  return `${person.name} عاش ${years} سنة تقريبًا، وارتبط اسمه بـ${events.length} حدثًا محفوظًا و${discoveryCount} اكتشافات، وله ${descendantCount} من الذرية المسجلة في الحقيقة التاريخية.`;
}

function normalized(value: number, saturation: number): number { return Math.min(1, value / saturation); }
