import type {
  AgentBrain,
  AgentDecision,
  CharacterSeed,
  CharacterState,
  Intervention,
  ResolvedEvent,
  SeasonConfig,
  WorldSnapshot,
} from "./contracts";
import { ENGINE_IDENTITY } from "./contracts";
import { createAgentBrain, markDecisionScheduled, schedulingClassFor } from "./brain";
import { createResolvedEvent } from "./events";
import { resolveFreeIntent, type ResolutionResult } from "./free-action-resolver";
import { markLostTechniques } from "./knowledge-contamination";
import { deterministicId, seededRandom } from "./random";
import { witnessIdsFor } from "./visibility";

const COLORS = ["#f5a941", "#ef6f6c", "#74c69d", "#72b8d4", "#c59bed", "#f38ba8", "#84c7a1", "#edc875"];
const FOUNDERS = [
  { name: "سالم", sex: "male", ageYears: 29, traits: ["هادئ", "مثابر", "حذر"], aptitudes: ["ملاحظة", "تنسيق اليد"] },
  { name: "نورة", sex: "female", ageYears: 27, traits: ["فضولية", "شجاعة", "مستقلة"], aptitudes: ["استكشاف", "تجريب"] },
  { name: "ريم", sex: "female", ageYears: 31, traits: ["رحيمة", "دقيقة", "صبورة"], aptitudes: ["ملاحظة", "رعاية"] },
] satisfies CharacterSeed[];

export const DEFAULT_CHARACTERS: CharacterSeed[] = FOUNDERS.map((founder) => ({ ...founder, traits: [...founder.traits], aptitudes: [...founder.aptitudes] }));

export type AdvanceResult = {
  state: WorldSnapshot;
  events: ResolvedEvent[];
  brains: Map<string, AgentBrain>;
  resolutions: ResolutionResult[];
  newlyDeceasedIds: string[];
};

export function createWorld(config: SeasonConfig, now = Date.now()): WorldSnapshot {
  assertThreeFounders(config.initialCharacters);
  const characters = config.initialCharacters.map((seed, index) => makeFounder(seed, index));
  const state: WorldSnapshot = {
    seasonId: config.id ?? crypto.randomUUID(),
    title: config.title,
    seed: config.seed,
    status: "paused",
    initialized: true,
    engineLocked: false,
    runtime: { ...ENGINE_IDENTITY },
    tick: 0,
    simDay: 0,
    speed: config.speed,
    weather: "clear",
    temperatureC: 28,
    characters,
    relationships: [],
    conversations: [],
    resources: { water: 0, food: 0, wood: 0, fibers: 0, shelter: 0 },
    techniques: [],
    discoveries: [],
    worldTruth: {
      lineage: [],
      pregnancies: [],
      reproductiveWillingness: [],
      fictionalMaterials: generateFictionalMaterials(config.seed),
      externalHumanSpawnCount: 0,
    },
    recentEvents: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, lastCallAt: null, consecutiveFailures: 0, circuitOpenUntil: null },
    initialExpectedCapacity: positiveInt(config.initialExpectedCapacity, 24),
    nextTickAt: null,
    lastError: null,
  };
  const opening = createResolvedEvent(
    state,
    "system",
    null,
    "العالم جاهز، وسالم ونورة وريم ينتظرون لحظة البدء عند الشاطئ.",
    "ثلاثة مؤسسين فقط؛ لا معرفة سابقة ولا علاقات أو ملكيات أو أدوار أو قائد أو هدف جماعي.",
    { witnessIds: [], socialDetail: null, now, salt: "world-created" },
  );
  state.recentEvents = [opening];
  return state;
}

export function createInitialBrains(world: WorldSnapshot): Map<string, AgentBrain> {
  return new Map(world.characters.map((character) => [character.id, createAgentBrain(character)]));
}

export function advanceWorld(
  previous: WorldSnapshot,
  decisions: AgentDecision[],
  existingBrains?: Map<string, AgentBrain>,
  now = Date.now(),
): AdvanceResult {
  const fallbackBrains = existingBrains ?? createInitialBrains(previous);
  if (previous.status !== "running") return { state: previous, events: [], brains: fallbackBrains, resolutions: [], newlyDeceasedIds: [] };
  const state = structuredClone(previous);
  const brains = new Map<string, AgentBrain>();
  for (const [id, brain] of fallbackBrains) brains.set(id, structuredClone(brain));
  for (const character of state.characters) if (!brains.has(character.id)) brains.set(character.id, createAgentBrain(character));

  const elapsedDays = 0.25 * state.speed;
  state.tick += 1;
  state.simDay += elapsedDays;
  state.nextTickAt = now + 30_000;
  state.lastError = null;
  const events: ResolvedEvent[] = [];
  const resolutions: ResolutionResult[] = [];

  updateWeather(state, events, now);
  completeActivities(state);
  updateBodies(state, elapsedDays, events, now);
  advancePregnancies(state, events, brains, now);

  for (const decision of decisions.slice(0, 1)) {
    const actor = state.characters.find((character) => character.id === decision.characterId && character.lifeStatus === "alive");
    const brain = actor ? brains.get(actor.id) : undefined;
    if (!actor || !brain) continue;
    const resolution = resolveFreeIntent(state, brain, decision, now);
    resolutions.push(resolution);
    events.push(...resolution.events);
    markDecisionScheduled(actor, state.simDay);
  }

  const newlyDeceasedIds = resolveDeaths(state, events, now);
  const livingIds = new Set(state.characters.filter((character) => character.lifeStatus === "alive").map((character) => character.id));
  state.techniques = markLostTechniques(state.techniques, livingIds, state.simDay);
  for (const character of state.characters) {
    if (character.lifeStatus !== "alive") continue;
    character.scheduler.class = schedulingClassFor(character, state);
    normalizeCharacter(character);
  }
  if (!livingIds.size) {
    state.status = "extinct";
    state.nextTickAt = null;
    events.push(createResolvedEvent(state, "milestone", null, "انتهى الموسم بانقراض جميع السكان.", "لا يوجد أي شخص حي في WorldTruth.", { witnessIds: [], socialDetail: null, now, salt: "extinction" }));
  }
  state.recentEvents = [...events, ...state.recentEvents].slice(0, 40);
  return { state, events, brains, resolutions, newlyDeceasedIds };
}

export function applyIntervention(previous: WorldSnapshot, intervention: Intervention, now = Date.now()): { state: WorldSnapshot; event: ResolvedEvent } {
  const state = structuredClone(previous);
  if (intervention.type === "resource" && intervention.resource && typeof intervention.amount === "number") {
    state.resources[intervention.resource] = Math.max(0, state.resources[intervention.resource] + intervention.amount);
  }
  if (intervention.type === "weather" && intervention.weather) state.weather = intervention.weather;
  const event = createResolvedEvent(state, "intervention", null, intervention.description, "تدخل خارجي معلن ودائم وغير قابل لتعديل الماضي.", { witnessIds: state.characters.filter((character) => character.lifeStatus === "alive").map((character) => character.id), socialDetail: "تدخل خارجي معلن", now, salt: `intervention:${state.recentEvents.length}` });
  state.recentEvents = [event, ...state.recentEvents].slice(0, 40);
  return { state, event };
}

export function freezeRuntimeOnStart(world: WorldSnapshot): WorldSnapshot {
  if (world.engineLocked) return world;
  return { ...world, engineLocked: true, runtime: { ...world.runtime } };
}

function updateWeather(state: WorldSnapshot, events: ResolvedEvent[], now: number): void {
  if (state.tick % 16 !== 0) return;
  const roll = seededRandom(state.seed, state.tick, "weather");
  const next = roll > 0.91 ? "storm" : roll > 0.7 ? "rain" : roll > 0.43 ? "cloudy" : "clear";
  if (next === state.weather) return;
  state.weather = next;
  state.temperatureC = next === "storm" ? 22 : next === "rain" ? 24 : next === "cloudy" ? 26 : 28;
  events.push(createResolvedEvent(state, "environment", null, weatherText(next), `الطقس الفعلي: ${next}`, { witnessIds: state.characters.filter((character) => character.lifeStatus === "alive").map((character) => character.id), now, salt: `weather:${next}` }));
}

function completeActivities(state: WorldSnapshot): void {
  for (const character of state.characters) {
    if (character.currentActivity && character.currentActivity.completesAtSimDay <= state.simDay) character.currentActivity = null;
  }
}

function updateBodies(state: WorldSnapshot, days: number, events: ResolvedEvent[], now: number): void {
  const living = state.characters.filter((character) => character.lifeStatus === "alive");
  const perPersonWater = state.resources.water / Math.max(1, living.length);
  const perPersonFood = state.resources.food / Math.max(1, living.length);
  const waterUsed = Math.min(state.resources.water, living.length * days);
  const foodUsed = Math.min(state.resources.food, living.length * days * 0.62);
  state.resources.water = Math.max(0, state.resources.water - waterUsed);
  state.resources.food = Math.max(0, state.resources.food - foodUsed);
  for (const person of living) {
    person.ageYears += days / 360;
    person.hunger += perPersonFood >= days * 0.62 ? -days * 8 : days * 12;
    person.thirst += perPersonWater >= days ? -days * 10 : days * 18;
    person.energy -= days * (person.currentActivity ? 1.8 : 0.8);
    if (!person.currentActivity) person.energy += days * 2;
    if (person.thirst > 85) person.health -= days * 8;
    if (person.hunger > 90) person.health -= days * 4;
    person.lifeStage = stageFor(person.ageYears);
    normalizeCharacter(person);
  }
  if (living.some((person) => person.thirst > 80 || person.hunger > 85) && state.tick % 4 === 0) {
    events.push(createResolvedEvent(state, "environment", null, "بدأ الجوع أو العطش يظهر على بعض السكان.", "تأثير جسدي سببي؛ لا يفرض قرارًا اجتماعيًا.", { witnessIds: living.map((person) => person.id), now, salt: "need-warning" }));
  }
}

function advancePregnancies(state: WorldSnapshot, events: ResolvedEvent[], brains: Map<string, AgentBrain>, now: number): void {
  const due = state.worldTruth.pregnancies.filter((pregnancy) => pregnancy.dueAtSimDay <= state.simDay);
  state.worldTruth.pregnancies = state.worldTruth.pregnancies.filter((pregnancy) => pregnancy.dueAtSimDay > state.simDay);
  for (const pregnancy of due) {
    const mother = state.characters.find((character) => character.id === pregnancy.pregnantCharacterId && character.lifeStatus === "alive");
    const father = state.characters.find((character) => character.id === pregnancy.otherParentId);
    if (!mother || !father) continue;
    const index = state.characters.length;
    const sex = seededRandom(state.seed, state.tick, `birth-sex:${index}`) >= 0.5 ? "female" : "male";
    const child = makeChild(state, mother, father, sex, index);
    state.characters.push(child);
    state.worldTruth.lineage.push({ childId: child.id, motherId: mother.id, fatherId: father.id });
    brains.set(child.id, createAgentBrain(child));
    const witnessIds = witnessIdsFor(state, mother.position, [mother.id, child.id]);
    events.push(createResolvedEvent(state, "birth", child, `وُلد طفل جديد في الجزيرة.`, `النسب الحقيقي: الأم ${mother.id}، والأب ${father.id}. لا يفرض الحدث شكل أسرة أو دورًا اجتماعيًا.`, { targetIds: [mother.id, father.id], witnessIds: [mother.id, ...witnessIds], socialDetail: "وُلد طفل جديد وفق ما عرفه الحاضرون.", now, salt: `birth:${child.id}` }));
  }
}

function resolveDeaths(state: WorldSnapshot, events: ResolvedEvent[], now: number): string[] {
  const newlyDeceased: string[] = [];
  for (const character of state.characters) {
    if (character.lifeStatus === "deceased" || character.health > 0) continue;
    character.lifeStatus = "deceased";
    character.archivedAtSimDay = state.simDay;
    character.currentActivity = null;
    character.scheduler.class = "sleeping";
    character.scheduler.nextDueSimTime = Number.MAX_SAFE_INTEGER;
    newlyDeceased.push(character.id);
    events.push(createResolvedEvent(state, "death", character, `توفي ${character.name}.`, "انتقلت الشخصية إلى الأرشيف التاريخي ولم تُحذف.", { witnessIds: witnessIdsFor(state, character.position, [character.id]), now, salt: `death:${character.id}` }));
  }
  return newlyDeceased;
}

function makeFounder(seed: CharacterSeed, index: number): CharacterState {
  const positions = [{ x: 18, y: 78 }, { x: 26, y: 75 }, { x: 22, y: 69 }] as const;
  return {
    id: `founder-${index + 1}-${slug(seed.name)}`,
    name: clean(seed.name, 40), sex: seed.sex, ageYears: seed.ageYears, bornAtSimDay: -seed.ageYears * 360,
    lifeStage: stageFor(seed.ageYears), lifeStatus: "alive", archivedAtSimDay: null,
    health: 90, energy: 82, morale: 64, hunger: 18, thirst: 15, stress: 26,
    traits: seed.traits.slice(0, 4), aptitudes: seed.aptitudes.slice(0, 4),
    position: { zone: "beach", ...positions[index] }, currentActivity: null,
    motherId: null, fatherId: null, caregiverIds: [], knownNameIds: [`founder-${index + 1}-${slug(seed.name)}`],
    scheduler: { class: "foreground", nextDueSimTime: 0, waitingSinceSimDay: 0, lastDecisionSimDay: null, majorEventPending: true },
    color: COLORS[index % COLORS.length],
  };
}

function makeChild(state: WorldSnapshot, mother: CharacterState, father: CharacterState, sex: "male" | "female", index: number): CharacterState {
  const id = deterministicId("person", state.seed, state.tick, `birth:${index}`);
  const inherited = [...new Set([
    mother.traits[index % Math.max(1, mother.traits.length)],
    father.traits[(index + 1) % Math.max(1, father.traits.length)],
    seededRandom(state.seed, state.tick, `${id}:variation`) > 0.5 ? "متكيف" : "ملاحظ",
  ].filter(Boolean))].slice(0, 3);
  const closeKin = kinshipCoefficient(state, mother.id, father.id);
  const boundedRisk = Math.min(0.08, closeKin * 0.08);
  const healthVariation = seededRandom(state.seed, state.tick, `${id}:health`) < boundedRisk ? -6 : 0;
  return {
    id, name: `الطفل ${index - 2}`, sex, ageYears: 0, bornAtSimDay: state.simDay, lifeStage: "infant", lifeStatus: "alive", archivedAtSimDay: null,
    health: 88 + healthVariation, energy: 75, morale: 60, hunger: 10, thirst: 10, stress: 5,
    traits: inherited, aptitudes: inheritAptitudes(mother, father, state, index), position: { ...mother.position }, currentActivity: null,
    motherId: mother.id, fatherId: father.id, caregiverIds: [mother.id], knownNameIds: [id, mother.id],
    scheduler: { class: "low_frequency", nextDueSimTime: state.simDay + 30, waitingSinceSimDay: state.simDay, lastDecisionSimDay: null, majorEventPending: true },
    color: COLORS[index % COLORS.length],
  };
}

function generateFictionalMaterials(seed: string): WorldSnapshot["worldTruth"]["fictionalMaterials"] {
  const descriptions = [
    ["مادة رمادية خفيفة ذات حواف لامعة", "beach"],
    ["ألياف زرقاء مرنة تنمو قرب الماء", "spring"],
    ["حجر داكن دافئ الملمس", "ridge"],
    ["نبات ذو بقع فضية ورائحة حادة", "forest"],
  ] as const;
  return descriptions.map(([localDescription, zone], index) => ({
    id: `material-${String.fromCharCode(65 + index)}`,
    localDescription,
    zone,
    hidden: {
      density: seededRandom(seed, index, "density"), brittleness: seededRandom(seed, index, "brittleness"),
      flexibility: seededRandom(seed, index, "flexibility"),
      heatReaction: (["softens", "hardens", "crumbles", "unchanged"] as const)[Math.floor(seededRandom(seed, index, "heat") * 4)],
      toxicity: seededRandom(seed, index, "toxicity"),
    },
  }));
}

function kinshipCoefficient(state: WorldSnapshot, a: string, b: string): number {
  if (a === b) return 1;
  const parents = (id: string) => state.worldTruth.lineage.find((line) => line.childId === id);
  const aParents = parents(a);
  const bParents = parents(b);
  if (!aParents || !bParents) return 0;
  if (aParents.motherId === bParents.motherId && aParents.fatherId === bParents.fatherId) return 0.5;
  if ([aParents.motherId, aParents.fatherId].includes(b) || [bParents.motherId, bParents.fatherId].includes(a)) return 0.5;
  if ([aParents.motherId, aParents.fatherId].some((id) => [bParents.motherId, bParents.fatherId].includes(id))) return 0.25;
  return 0;
}

function inheritAptitudes(mother: CharacterState, father: CharacterState, state: WorldSnapshot, index: number): string[] {
  const combined = [...mother.aptitudes, ...father.aptitudes];
  const first = combined[Math.floor(seededRandom(state.seed, index, "aptitude-a") * Math.max(1, combined.length))];
  const second = combined[Math.floor(seededRandom(state.seed, index, "aptitude-b") * Math.max(1, combined.length))];
  return [...new Set([first, second].filter(Boolean))].slice(0, 2);
}

function assertThreeFounders(founders: CharacterSeed[]): void {
  if (founders.length !== 3) throw new Error("season_requires_exactly_three_founders");
  const expected = [{ name: "سالم", sex: "male" }, { name: "نورة", sex: "female" }, { name: "ريم", sex: "female" }] as const;
  expected.forEach((item, index) => {
    if (founders[index]?.name !== item.name || founders[index]?.sex !== item.sex || founders[index].ageYears < 18) throw new Error("invalid_founder_configuration");
  });
}

function normalizeCharacter(person: CharacterState): void {
  person.health = clamp(person.health); person.energy = clamp(person.energy); person.morale = clamp(person.morale);
  person.hunger = clamp(person.hunger); person.thirst = clamp(person.thirst); person.stress = clamp(person.stress);
}
function stageFor(age: number): CharacterState["lifeStage"] { return age < 2 ? "infant" : age < 6 ? "young_child" : age < 12 ? "child" : age < 18 ? "adolescent" : age < 60 ? "adult" : "elder"; }
function weatherText(weather: WorldSnapshot["weather"]): string { return ({ clear: "صفا الجو فوق الجزيرة.", cloudy: "تجمعت سحب خفيفة فوق الجزيرة.", rain: "بدأ المطر يهطل على الجزيرة.", storm: "اقتربت عاصفة قوية من الجزيرة." } as const)[weather]; }
function clean(value: string, max: number): string { return value.replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, max); }
function slug(value: string): string { return value.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "person"; }
function positiveInt(value: number | undefined, fallback: number): number { return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback; }
function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
