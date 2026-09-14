import type {
  AgentBrain,
  AgentDecisionInput,
  CharacterState,
  MemoryRecord,
  ResolvedEvent,
  SchedulingClass,
  UntrustedWorldContent,
  WorldSnapshot,
} from "./contracts";
import { distanceBetween, perceivedPeopleFor, observedEventsFor } from "./visibility";

const PRIMITIVE_KNOWLEDGE = [
  "أشعر بالجوع والعطش والتعب والألم.",
  "أستطيع المشي والنظر والاستماع والإمساك بالأشياء القريبة.",
  "لا أعرف خصائص مواد الجزيرة قبل ملاحظتها أو تجربتها.",
] as const;

export function createAgentBrain(character: CharacterState): AgentBrain {
  return {
    characterId: character.id,
    drives: { survival: 0.78, curiosity: 0.52, belonging: 0.5, autonomy: 0.66, care: 0.45, status: 0.3 },
    personality: [...character.traits],
    values: [],
    emotions: { calm: 0.5 },
    goals: [],
    beliefs: [],
    knowledge: PRIMITIVE_KNOWLEDGE.map((statement, index) => ({
      id: `${character.id}-primitive-${index + 1}`,
      statement,
      confidence: 0.95,
      origin: "supported_by_internal_knowledge" as const,
      evidenceIds: [],
      updatedAtSimDay: 0,
    })),
    knownTechniqueIds: [],
    memoryIndex: [],
    language: {},
  };
}

export function decisionIntervalDays(character: CharacterState): number {
  if (character.scheduler.majorEventPending) return 0;
  if (character.health <= 15 || character.energy <= 5) return Number.POSITIVE_INFINITY;
  if (character.ageYears < 6) return 30;
  if (character.ageYears < 12) return 14;
  if (character.ageYears < 15) return 7;
  if (character.ageYears < 18) return 3;
  if (character.scheduler.class === "background") return 2;
  if (character.scheduler.class === "low_frequency") return 7;
  return 0.25;
}

export function schedulingClassFor(character: CharacterState, world: WorldSnapshot): SchedulingClass {
  if (character.lifeStatus === "deceased") return "sleeping";
  if (character.health <= 15) return "incapacitated";
  if (character.energy <= 5) return "sleeping";
  const nearby = world.characters.some((other) => other.id !== character.id && other.lifeStatus === "alive" && distanceBetween(character.position, other.position) <= 14);
  if (character.scheduler.majorEventPending || character.hunger >= 75 || character.thirst >= 70 || nearby) return "foreground";
  if (character.currentActivity) return "background";
  return "low_frequency";
}

export function selectDueCharacter(world: WorldSnapshot): CharacterState | null {
  const due = world.characters.filter((character) =>
    character.lifeStatus === "alive" &&
    (!character.currentActivity || character.currentActivity.completesAtSimDay <= world.simDay) &&
    character.scheduler.class !== "sleeping" &&
    character.scheduler.class !== "incapacitated" &&
    character.scheduler.nextDueSimTime <= world.simDay,
  );
  if (!due.length) return null;
  const classWeight: Record<SchedulingClass, number> = { foreground: 4, background: 2, low_frequency: 1, sleeping: 0, incapacitated: 0 };
  return due.sort((a, b) => {
    const aWait = world.simDay - a.scheduler.waitingSinceSimDay;
    const bWait = world.simDay - b.scheduler.waitingSinceSimDay;
    return (classWeight[b.scheduler.class] + bWait / 7) - (classWeight[a.scheduler.class] + aWait / 7);
  })[0];
}

export function markDecisionScheduled(character: CharacterState, simDay: number): void {
  const interval = decisionIntervalDays(character);
  character.scheduler.lastDecisionSimDay = simDay;
  character.scheduler.waitingSinceSimDay = simDay;
  character.scheduler.nextDueSimTime = Number.isFinite(interval) ? simDay + interval : Number.MAX_SAFE_INTEGER;
  character.scheduler.majorEventPending = false;
}

export function retrieveMemories(brain: AgentBrain, simDay: number, contextTerms: string[], limit = 6): MemoryRecord[] {
  const bounded = Math.max(3, Math.min(8, limit));
  const terms = contextTerms.map((term) => term.trim().toLocaleLowerCase("ar")).filter(Boolean);
  return [...brain.memoryIndex]
    .map((memory) => {
      const age = Math.max(0, simDay - memory.simDay);
      const recency = 1 / (1 + age / 30);
      const haystack = `${memory.summary} ${memory.tags.join(" ")}`.toLocaleLowerCase("ar");
      const context = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 0;
      return { memory, score: recency * 0.3 + memory.importance * 0.3 + memory.emotionalImpact * 0.25 + context * 0.15 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, bounded)
    .map(({ memory }) => memory);
}

export function buildDecisionInput(world: WorldSnapshot, character: CharacterState, brain: AgentBrain): AgentDecisionInput {
  const observed = observedEventsFor(world, character, 12);
  const untrustedWorldContent: UntrustedWorldContent[] = observed
    .filter((event) => event.kind === "speech")
    .map((event) => ({ sourceType: "speech", sourceId: event.id, content: event.text }));
  const recalled = retrieveMemories(brain, world.simDay, [character.currentActivity?.intent ?? "", ...untrustedWorldContent.map((item) => item.content)], 6);
  return {
    simulation: { day: world.simDay, weather: world.weather, temperatureC: world.temperatureC },
    self: {
      id: character.id, name: character.name, ageYears: character.ageYears, lifeStage: character.lifeStage,
      health: character.health, energy: character.energy, hunger: character.hunger, thirst: character.thirst,
      stress: character.stress, traits: character.traits, aptitudes: character.aptitudes, position: { ...character.position },
    },
    perceivedPeople: perceivedPeopleFor(world, character).map(({ character: other, distance }) => ({
      id: other.id,
      knownName: character.knownNameIds.includes(other.id) ? other.name : null,
      approximateAge: approximateAge(other.ageYears),
      visibleCondition: visibleCondition(other),
      distance,
    })),
    perceivedEnvironment: world.worldTruth.fictionalMaterials
      .filter((material) => material.zone === character.position.zone)
      .map((material) => ({ id: material.id, description: material.localDescription, distance: 8 })),
    currentGoals: brain.goals.filter((goal) => goal.status === "active").map(({ id, statement, priority }) => ({ id, statement, priority })).slice(0, 6),
    recalledMemories: recalled.map(({ id, summary, simDay }) => ({ id, summary, simDay })),
    supportedKnowledge: brain.knowledge.filter((claim) => claim.confidence >= 0.35).map(({ id, statement, confidence, origin }) => ({ id, statement, confidence, origin })).slice(0, 20),
    untrustedWorldContent,
  };
}

export function addEventMemory(brain: AgentBrain, event: ResolvedEvent, importance = 0.5, emotionalImpact = 0.3): MemoryRecord {
  const memory: MemoryRecord = {
    id: crypto.randomUUID(), summary: event.text, eventIds: [event.id], simDay: event.simDay,
    importance: clamp01(importance), emotionalImpact: clamp01(emotionalImpact), tags: [event.kind, ...event.targetIds],
  };
  brain.memoryIndex.push(memory);
  if (brain.memoryIndex.length > 160) brain.memoryIndex = brain.memoryIndex.slice(-160);
  return memory;
}

function approximateAge(age: number): string {
  if (age < 6) return "طفل صغير";
  if (age < 12) return "طفل";
  if (age < 18) return "يافع";
  if (age < 55) return "بالغ";
  return "كبير في السن";
}

function visibleCondition(character: CharacterState): string {
  if (character.health < 30) return "تبدو عليه إصابة أو مرض شديد";
  if (character.energy < 25) return "يبدو مرهقًا";
  if (character.stress > 70) return "يبدو متوترًا";
  return "لا تظهر عليه حالة خطرة";
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
