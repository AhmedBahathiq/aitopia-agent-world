import type { AgentDecision, CharacterSeed, CharacterState, Relationship, ResolvedEvent, SeasonConfig, WorldSnapshot, Zone } from "./contracts";

const COLORS = ["#f5a941", "#ef6f6c", "#74c69d", "#72b8d4", "#c59bed", "#f38ba8", "#84c7a1", "#edc875"];
const POSITIONS: Record<Zone, { x: number; y: number }> = {
  beach: { x: 24, y: 72 }, spring: { x: 24, y: 38 }, forest: { x: 34, y: 25 },
  grassland: { x: 62, y: 64 }, camp: { x: 49, y: 49 }, ridge: { x: 75, y: 28 },
};

export const DEFAULT_CHARACTERS: CharacterSeed[] = [
  { name: "سالم", sex: "male", ageYears: 29, traits: ["هادئ", "مثابر", "حذر"], skills: ["البناء", "الصناعة"] },
  { name: "نورة", sex: "female", ageYears: 27, traits: ["فضولية", "شجاعة", "اجتماعية"], skills: ["الاستكشاف", "الملاحة"] },
  { name: "ريم", sex: "female", ageYears: 31, traits: ["رحيمة", "دقيقة", "صبورة"], skills: ["النباتات", "الرعاية"] },
];

export function createWorld(config: SeasonConfig, now = Date.now()): WorldSnapshot {
  const characters = config.initialCharacters.map((seed, index) => makeCharacter(seed, index, config.seed));
  const opening = event(0, 0, "system", null, "العالم", `أصبح ${config.title} جاهزًا بـ${characters.length} شخصيات تنتظر إشارة البدء.`, "العالم جاهز", now);
  return {
    seasonId: config.id ?? crypto.randomUUID(), title: config.title, seed: config.seed,
    status: "paused", initialized: true, tick: 0, simDay: 0, speed: config.speed,
    weather: "clear", temperatureC: 27, characters, relationships: initialRelationships(characters),
    resources: { water: 30, food: 18, wood: 12, medicine: 3, shelterCapacity: 0, shelterProgress: 0, waterDailyProduction: 0, foodDailyProduction: 0 },
    populationCap: config.populationCap, stabilityProgress: 0, stabilitySinceDay: null,
    recentEvents: [opening], usage: { dayKey: utcDay(now), calls: 0, inputTokens: 0, outputTokens: 0, maxCalls: 600, maxTokens: 2_000_000, economyMode: false },
    nextTickAt: null, lastError: null,
  };
}

export function advanceWorld(previous: WorldSnapshot, decisions: AgentDecision[], now = Date.now()): { state: WorldSnapshot; events: ResolvedEvent[] } {
  if (!["running", "prosperous"].includes(previous.status)) return { state: previous, events: [] };
  const state = structuredClone(previous);
  const elapsedDays = 0.25 * state.speed;
  state.tick += 1; state.simDay += elapsedDays; state.nextTickAt = now + 30_000; state.lastError = null;
  resetBudgetIfNeeded(state, now);
  const events: ResolvedEvent[] = [];
  updateWeather(state, events, now);
  consumeResources(state, elapsedDays, events, now);
  for (const decision of decisions) events.push(...applyDecision(state, decision, now));
  if (decisions.length === 0) events.push(...applyRoutine(state, now));
  events.push(...advanceLives(state, elapsedDays, now));
  updateOutcome(state, events, now);
  state.characters = state.characters.map(normalizeCharacter);
  state.recentEvents = [...events, ...state.recentEvents].slice(0, 30);
  return { state, events };
}

export function applyIntervention(previous: WorldSnapshot, kind: "resource" | "weather" | "event", description: string, payload: { resource?: "water" | "food" | "wood" | "medicine"; amount?: number; weather?: WorldSnapshot["weather"] }, now = Date.now()) {
  const state = structuredClone(previous);
  if (kind === "resource" && payload.resource && payload.amount) state.resources[payload.resource] = Math.max(0, state.resources[payload.resource] + payload.amount);
  if (kind === "weather" && payload.weather) state.weather = payload.weather;
  const intervention = event(state.tick, state.simDay, "intervention", null, "المشرف", description, "تدخل معلن", now);
  state.recentEvents = [intervention, ...state.recentEvents].slice(0, 30);
  return { state, event: intervention };
}

function applyDecision(state: WorldSnapshot, decision: AgentDecision, now: number): ResolvedEvent[] {
  const actor = state.characters.find((person) => person.id === decision.characterId && person.alive);
  if (!actor || actor.lifeStage === "child") return [];
  actor.goal = clean(decision.goal, 100) || actor.goal;
  const events: ResolvedEvent[] = [];
  if (decision.speech) events.push(event(state.tick, state.simDay, "speech", actor.id, actor.name, clean(decision.speech, 240), "حديث مسموع", now, decision.targetId));
  const target = decision.targetId ? state.characters.find((person) => person.id === decision.targetId && person.alive) : undefined;
  switch (decision.action) {
    case "move": if (decision.targetZone) { actor.position = jitterPosition(decision.targetZone, actor.id, state.tick); events.push(actionEvent(state, actor, `انتقل إلى ${zoneName(decision.targetZone)}.`, "حركة", now)); } break;
    case "gather_water": state.resources.water += skill(actor, "الملاحة") ? 12 : 8; actor.energy -= 8; events.push(actionEvent(state, actor, "جمع ماءً عذبًا من النبع.", "+ ماء", now)); break;
    case "forage": state.resources.food += skill(actor, "النباتات") ? 10 : 6; actor.energy -= 11; events.push(actionEvent(state, actor, "جمع طعامًا صالحًا من الجزيرة.", "+ غذاء", now)); break;
    case "gather_wood": state.resources.wood += 7; actor.energy -= 12; events.push(actionEvent(state, actor, "جمع أخشابًا جافة للبناء.", "+ خشب", now)); break;
    case "build": if (state.resources.wood >= 4) { state.resources.wood -= 4; state.resources.shelterProgress = Math.min(100, state.resources.shelterProgress + (skill(actor, "البناء") ? 12 : 7)); if (state.resources.shelterProgress >= 100) state.resources.shelterCapacity = Math.max(state.resources.shelterCapacity, state.characters.filter((p) => p.alive).length); actor.energy -= 13; events.push(actionEvent(state, actor, "عمل على تدعيم المأوى.", `اكتمل ${Math.round(state.resources.shelterProgress)}%`, now)); } break;
    case "rest": actor.energy += 24; actor.morale += 4; events.push(actionEvent(state, actor, "أخذ قسطًا من الراحة ليستعيد طاقته.", "راحة", now)); break;
    case "talk": if (target) { changeRelationship(state, actor.id, target.id, 4, 3, -1); actor.morale += 3; target.morale += 2; events.push(actionEvent(state, actor, `قضى وقتًا في الحديث مع ${target.name}.`, "تقارب اجتماعي", now, target.id)); } break;
    case "care": if (target) { target.health += skill(actor, "الرعاية") && state.resources.medicine >= 1 ? 12 : 5; if (state.resources.medicine >= 1) state.resources.medicine -= 1; changeRelationship(state, actor.id, target.id, 6, 4, -2); events.push(actionEvent(state, actor, `اعتنى بصحة ${target.name}.`, "رعاية", now, target.id)); } break;
    case "teach": if (target?.lifeStage === "child") { target.educatedDays += 12; changeRelationship(state, actor.id, target.id, 5, 3, 0); events.push(actionEvent(state, actor, `علّم ${target.name} مهارة جديدة.`, "تعليم", now, target.id)); } break;
    case "explore": actor.energy -= 10; actor.morale += 2; if (seeded(state.seed, state.tick + actor.id.length) > .62) state.resources.medicine += 1; events.push(actionEvent(state, actor, "استكشف منطقة جديدة وسجّل ما وجده.", "استكشاف", now)); break;
    case "propose_marriage": if (target && eligibleAdult(actor) && eligibleAdult(target) && !actor.partnerId && !target.partnerId) { target.pendingProposalFrom = actor.id; events.push(event(state.tick, state.simDay, "relationship", actor.id, actor.name, `طلب من ${target.name} أن يبنيا حياتهما معًا.`, "اقتراح زواج", now, target.id)); } break;
    case "accept_marriage": if (target && actor.pendingProposalFrom === target.id && !actor.partnerId && !target.partnerId) { actor.partnerId = target.id; target.partnerId = actor.id; actor.pendingProposalFrom = null; const relation = getRelationship(state, actor.id, target.id); relation.status = "married"; relation.trust = Math.max(70, relation.trust); events.push(event(state.tick, state.simDay, "relationship", actor.id, actor.name, `وافق على الزواج من ${target.name}.`, "زواج بالتراضي", now, target.id)); } break;
    case "separate": if (target && actor.partnerId === target.id) { actor.partnerId = null; target.partnerId = null; getRelationship(state, actor.id, target.id).status = "separated"; events.push(event(state.tick, state.simDay, "relationship", actor.id, actor.name, `اتفق مع ${target.name} على الانفصال.`, "انفصال", now, target.id)); } break;
    case "desire_child": if (target && actor.partnerId === target.id && eligibleAdult(actor) && eligibleAdult(target)) { actor.wantsChildWith = target.id; if (target.wantsChildWith === actor.id) events.push(...startPregnancy(state, actor, target, now)); } break;
    case "craft": if (state.resources.wood >= 2) { state.resources.wood -= 2; actor.energy -= 5; actor.morale += 2; events.push(actionEvent(state, actor, "صنع أداة بسيطة تساعد المجموعة.", "صناعة", now)); } break;
  }
  return events;
}

function applyRoutine(state: WorldSnapshot, now: number): ResolvedEvent[] {
  const adults = state.characters.filter((p) => p.alive && p.lifeStage !== "child");
  if (!adults.length) return [];
  const actor = adults[state.tick % adults.length];
  let decision: AgentDecision;
  if (actor.energy < 28) decision = decisionFor(actor, "rest", "استعادة الطاقة");
  else if (state.resources.water < adults.length * 8) decision = decisionFor(actor, "gather_water", "تأمين الماء");
  else if (state.resources.food < adults.length * 6) decision = decisionFor(actor, "forage", "البحث عن الغذاء");
  else if (state.resources.shelterCapacity < state.characters.filter((p) => p.alive).length) decision = decisionFor(actor, state.resources.wood >= 4 ? "build" : "gather_wood", "توسعة المأوى");
  else decision = decisionFor(actor, "explore", "فهم الجزيرة");
  return applyDecision(state, decision, now);
}

function advanceLives(state: WorldSnapshot, elapsedDays: number, now: number): ResolvedEvent[] {
  const events: ResolvedEvent[] = [];
  for (const person of state.characters) {
    if (!person.alive) continue;
    person.ageYears += elapsedDays / 360;
    if (person.lifeStage === "child" && person.ageYears >= 18) { person.lifeStage = "adult"; events.push(event(state.tick, state.simDay, "milestone", person.id, person.name, `بلغ ${person.name} سن الرشد وأصبح صاحب قرارات مستقلة.`, "18 سنة", now)); }
    if (person.lifeStage === "adult" && person.ageYears >= 60) person.lifeStage = "elder";
    if (person.pregnantUntilDay !== null && state.simDay >= person.pregnantUntilDay) events.push(...giveBirth(state, person, now));
    if (person.health <= 0 || person.ageYears >= 82) { person.alive = false; events.push(event(state.tick, state.simDay, "death", person.id, person.name, `توفي ${person.name}، وبقي أثره في ذاكرة الجزيرة.`, "وفاة", now)); }
  }
  return events;
}

function startPregnancy(state: WorldSnapshot, a: CharacterState, b: CharacterState, now: number): ResolvedEvent[] {
  if (state.characters.filter((p) => p.alive).length >= state.populationCap) return [event(state.tick, state.simDay, "system", a.id, a.name, "لا تسمح موارد الجزيرة حاليًا بزيادة السكان.", "السعة الاستيعابية مكتملة", now, b.id)];
  const mother = a.sex === "female" ? a : b.sex === "female" ? b : null;
  const father = a.sex === "male" ? a : b.sex === "male" ? b : null;
  if (!mother || !father || mother.pregnantUntilDay !== null || mother.health < 60 || father.health < 60 || state.resources.food < 30 || state.resources.water < 45) return [];
  mother.pregnantUntilDay = state.simDay + 270; mother.pregnancyParentId = father.id; a.wantsChildWith = null; b.wantsChildWith = null;
  return [event(state.tick, state.simDay, "relationship", mother.id, mother.name, `قرر ${mother.name} و${father.name} تكوين أسرة، وبدأ انتظار مولود جديد.`, "حمل مجرد وآمن", now, father.id)];
}

function giveBirth(state: WorldSnapshot, mother: CharacterState, now: number): ResolvedEvent[] {
  const father = state.characters.find((p) => p.id === mother.pregnancyParentId);
  if (!father || state.characters.filter((p) => p.alive).length >= state.populationCap) { mother.pregnantUntilDay = null; mother.pregnancyParentId = null; return []; }
  const index = state.characters.length;
  const female = seeded(state.seed, state.tick + index * 13) >= .5;
  const name = childName(female, index);
  const seed: CharacterSeed = { name, sex: female ? "female" : "male", ageYears: 0, traits: inherit(mother.traits, father.traits, index), skills: [] };
  const child = makeCharacter(seed, index, state.seed); child.lifeStage = "child"; child.caregiverIds = [mother.id, father.id]; child.position = { ...mother.position };
  state.characters.push(child); mother.pregnantUntilDay = null; mother.pregnancyParentId = null;
  return [event(state.tick, state.simDay, "birth", child.id, child.name, `وُلد ${child.name} لأسرة ${mother.name} و${father.name}.`, "مولود جديد", now)];
}

function updateWeather(state: WorldSnapshot, events: ResolvedEvent[], now: number) {
  if (state.tick % 16 !== 0) return;
  const roll = seeded(state.seed, state.tick); const next = roll > .9 ? "storm" : roll > .68 ? "rain" : roll > .42 ? "cloudy" : "clear";
  if (next !== state.weather) { state.weather = next; state.temperatureC = next === "storm" ? 22 : next === "rain" ? 24 : 27; events.push(event(state.tick, state.simDay, "environment", null, "العالم", weatherText(next), "تغير الطقس", now)); }
}

function consumeResources(state: WorldSnapshot, days: number, events: ResolvedEvent[], now: number) {
  const living = state.characters.filter((p) => p.alive); const needWater = living.length * days; const needFood = living.length * days * .65;
  state.resources.water += state.resources.waterDailyProduction * days; state.resources.food += state.resources.foodDailyProduction * days;
  const waterShort = Math.max(0, needWater - state.resources.water); const foodShort = Math.max(0, needFood - state.resources.food);
  state.resources.water = Math.max(0, state.resources.water - needWater); state.resources.food = Math.max(0, state.resources.food - needFood);
  for (const person of living) { person.energy -= days * 1.2; person.thirst += waterShort ? days * 18 : -days * 8; person.hunger += foodShort ? days * 12 : -days * 5; if (person.thirst > 85) person.health -= days * 8; if (person.hunger > 90) person.health -= days * 4; }
  if ((waterShort || foodShort) && state.tick % 4 === 0) events.push(event(state.tick, state.simDay, "system", null, "العالم", "المؤن لا تكفي الجميع، وبدأ التعب يظهر على السكان.", "نقص موارد", now));
}

function updateOutcome(state: WorldSnapshot, events: ResolvedEvent[], now: number) {
  const living = state.characters.filter((p) => p.alive); if (!living.length) { if (state.status !== "extinct") events.push(event(state.tick, state.simDay, "milestone", null, "العالم", "انتهى الموسم بانقراض سكان الجزيرة.", "نهاية الموسم", now)); state.status = "extinct"; state.nextTickAt = null; return; }
  const adults = living.filter((p) => p.lifeStage !== "child"); const children = living.filter((p) => p.lifeStage === "child");
  const consumption = living.length; const stable = living.length >= 12 && adults.length >= 6 && state.resources.shelterCapacity >= living.length && state.resources.waterDailyProduction >= consumption * 1.2 && state.resources.foodDailyProduction >= consumption * .65 * 1.2 && state.resources.water >= consumption * 90 && state.resources.food >= consumption * .65 * 90 && living.every((p) => p.health > 35) && children.every((p) => p.caregiverIds.length > 0 && p.educatedDays >= 90);
  const partials = [living.length / 12, adults.length / 6, state.resources.shelterCapacity / Math.max(1, living.length), state.resources.water / Math.max(1, consumption * 90), state.resources.food / Math.max(1, consumption * .65 * 90), children.length ? children.filter((p) => p.educatedDays >= 90).length / children.length : 1];
  state.stabilityProgress = Math.round(Math.min(1, partials.reduce((a, b) => a + Math.min(1, b), 0) / partials.length) * 100);
  if (stable) state.stabilitySinceDay ??= state.simDay; else state.stabilitySinceDay = null;
  if (state.status !== "prosperous" && state.stabilitySinceDay !== null && state.simDay - state.stabilitySinceDay >= 720) { state.status = "prosperous"; state.stabilityProgress = 100; events.push(event(state.tick, state.simDay, "milestone", null, "العالم", "أصبحت الجزيرة مجتمعًا مستقرًا قادرًا على الاستمرار عبر الأجيال.", "تحقق الاكتفاء", now)); }
}

function makeCharacter(seed: CharacterSeed, index: number, worldSeed: string): CharacterState {
  const zone: Zone = index === 0 ? "camp" : index === 1 ? "spring" : "grassland"; const pos = jitterPosition(zone, `${worldSeed}-${index}`, 0);
  return { id: `${slug(seed.name)}-${index + 1}`, name: clean(seed.name, 40), sex: seed.sex, ageYears: seed.ageYears, lifeStage: seed.ageYears < 18 ? "child" : seed.ageYears >= 60 ? "elder" : "adult", alive: true, health: 90, energy: 82, morale: 70, hunger: 18, thirst: 15, traits: seed.traits.slice(0, 3), skills: seed.skills.slice(0, 2), position: pos, goal: "فهم الوضع وتأمين الاحتياجات الأساسية", partnerId: null, pendingProposalFrom: null, wantsChildWith: null, pregnantUntilDay: null, pregnancyParentId: null, caregiverIds: [], educatedDays: 0, color: COLORS[index % COLORS.length] };
}

function initialRelationships(characters: CharacterState[]): Relationship[] { const rows: Relationship[] = []; for (let i = 0; i < characters.length; i++) for (let j = i + 1; j < characters.length; j++) rows.push({ id: pairId(characters[i].id, characters[j].id), characterAId: characters[i].id, characterBId: characters[j].id, trust: 45, affinity: 40, conflict: 5, status: "acquaintance" }); return rows; }
function changeRelationship(state: WorldSnapshot, a: string, b: string, trust: number, affinity: number, conflict: number) { const row = getRelationship(state, a, b); row.trust = clamp(row.trust + trust); row.affinity = clamp(row.affinity + affinity); row.conflict = clamp(row.conflict + conflict); if (row.status === "acquaintance" && row.trust >= 60) row.status = "friend"; }
function getRelationship(state: WorldSnapshot, a: string, b: string) { let row = state.relationships.find((r) => r.id === pairId(a, b)); if (!row) { row = { id: pairId(a, b), characterAId: a, characterBId: b, trust: 40, affinity: 40, conflict: 5, status: "acquaintance" }; state.relationships.push(row); } return row; }
function resetBudgetIfNeeded(state: WorldSnapshot, now: number) { const key = utcDay(now); if (state.usage.dayKey !== key) state.usage = { ...state.usage, dayKey: key, calls: 0, inputTokens: 0, outputTokens: 0, economyMode: false }; state.usage.economyMode = state.usage.calls >= state.usage.maxCalls || state.usage.inputTokens + state.usage.outputTokens >= state.usage.maxTokens; }
function normalizeCharacter(person: CharacterState) { return { ...person, health: clamp(person.health), energy: clamp(person.energy), morale: clamp(person.morale), hunger: clamp(person.hunger), thirst: clamp(person.thirst) }; }
function decisionFor(actor: CharacterState, action: AgentDecision["action"], goal: string): AgentDecision { return { characterId: actor.id, action, targetId: null, targetZone: action === "gather_water" ? "spring" : action === "forage" ? "forest" : null, speech: null, emotion: "calm", goal, memory: null }; }
function actionEvent(state: WorldSnapshot, actor: CharacterState, text: string, detail: string, now: number, targetId: string | null = null) { return event(state.tick, state.simDay, "action", actor.id, actor.name, text, detail, now, targetId); }
function event(tick: number, simDay: number, kind: ResolvedEvent["kind"], actorId: string | null, actorName: string, text: string, detail: string, createdAt: number, targetId: string | null = null): ResolvedEvent { return { id: crypto.randomUUID(), tick, simDay, createdAt, kind, actorId, actorName, targetId, text, detail, public: true }; }
function eligibleAdult(person: CharacterState) { return person.alive && person.lifeStage !== "child" && person.ageYears >= 18; }
function skill(person: CharacterState, name: string) { return person.skills.includes(name); }
function clean(value: string, max: number) { return value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }
function clamp(value: number) { return Math.max(0, Math.min(100, value)); }
function pairId(a: string, b: string) { return [a, b].sort().join("::"); }
function utcDay(now: number) { return new Date(now).toISOString().slice(0, 10); }
function slug(value: string) { return value.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "agent"; }
function seeded(seed: string, step: number) { let h = 2166136261; for (const c of `${seed}:${step}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967295; }
function jitterPosition(zone: Zone, salt: string, tick: number) { const base = POSITIONS[zone]; const n = seeded(salt, tick); return { zone, x: Math.max(7, Math.min(93, base.x + (n - .5) * 9)), y: Math.max(8, Math.min(88, base.y + (.5 - n) * 7)) }; }
function zoneName(zone: Zone) { return ({ beach: "الشاطئ", spring: "النبع", forest: "الغابة", grassland: "السهل", camp: "المخيم", ridge: "المرتفعات" } as const)[zone]; }
function weatherText(weather: WorldSnapshot["weather"]) { return ({ clear: "صفا الجو فوق الجزيرة.", cloudy: "تجمعت سحب خفيفة فوق الجزيرة.", rain: "بدأ مطر نافع يهطل على الجزيرة.", storm: "اقتربت عاصفة قوية، واحتاج السكان إلى مأوى." } as const)[weather]; }
function childName(female: boolean, index: number) { const names = female ? ["ليان", "هيا", "سارة", "دانا"] : ["راشد", "مازن", "زيد", "إياد"]; return names[index % names.length]; }
function inherit(a: string[], b: string[], index: number) { return [...new Set([a[index % Math.max(1, a.length)], b[(index + 1) % Math.max(1, b.length)], "متكيف"].filter(Boolean))].slice(0, 3); }
