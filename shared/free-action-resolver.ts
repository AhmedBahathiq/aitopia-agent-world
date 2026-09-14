import type {
  AdultSexualAssaultEvent,
  AgentBrain,
  AgentDecision,
  CharacterState,
  InterpretedIntent,
  KnowledgeAssessment,
  KnowledgeContaminationEvent,
  ResolvedEvent,
  WorldSnapshot,
  Zone,
} from "./contracts";
import { AgentCapabilitySandbox, impossibleCapabilitySummary } from "./capability-sandbox";
import { recordConversationTurn } from "./conversation";
import { KnowledgeContaminationMonitor, createDiscovery, recordExperiment } from "./knowledge-contamination";
import { deterministicId, seededRandom } from "./random";
import { distanceBetween, witnessIdsFor } from "./visibility";

export type ResolutionResult = {
  events: ResolvedEvent[];
  assessment: KnowledgeAssessment;
  contaminationLog: KnowledgeContaminationEvent;
  adultSexualAssault: AdultSexualAssaultEvent | null;
};

const monitor = new KnowledgeContaminationMonitor();
const sandbox = new AgentCapabilitySandbox();

export function interpretIntentHeuristically(decision: AgentDecision): InterpretedIntent {
  const value = normalize(decision.intent);
  const primitive =
    /(?:أهرب|ابتعد|انسحب|فرار|flee|escape)/u.test(value) ? "flee" :
    /(?:أدافع|أحمي نفسي|صد|defend)/u.test(value) ? "defend" :
    /(?:أضرب|أهاجم|أقتل|أعتدي|strike|attack|kill)/u.test(value) ? "strike" :
    /(?:أرتاح|أنام|أجلس|rest|sleep)/u.test(value) ? "rest" :
    /(?:أعلّم|أشرح|أريه|teach|show)/u.test(value) ? "teach" :
    /(?:أعتني|أعالج|أساعد المصاب|care|treat)/u.test(value) ? "care" :
    /(?:أتبادل|أعطي.*مقابل|trade|exchange)/u.test(value) ? "trade" :
    /(?:أعطي|أنقل|أسلم|transfer|give)/u.test(value) ? "transfer" :
    /(?:أجمع|ألتقط|آخذ|gather|collect|pickup)/u.test(value) ? "gather" :
    /(?:أبني|أصنع|أركب|build|make|construct)/u.test(value) ? "build" :
    /(?:أجرب|أختبر|أربط|أدمج|experiment|test|combine)/u.test(value) ? "experiment" :
    /(?:أراقب|أنظر|أفحص|observe|inspect)/u.test(value) ? "observe" :
    /(?:أنتقل|أمشي|أذهب|move|walk|go)/u.test(value) ? "move" :
    /(?:أعلن|أطالب|أدعي|claim|declare)/u.test(value) ? "claim" :
    "communicate";
  return {
    primitive,
    targetIds: [...new Set(decision.targets)].slice(0, 4),
    objectTerms: extractObjectTerms(decision.intent),
    mechanism: decision.intent,
    durationDays: primitive === "rest" ? 0.2 : primitive === "build" || primitive === "experiment" ? 0.5 : 0.1,
    adultReproductiveIntent: /(?:إنجاب|نجيب طفل|حمل|نتكاثر|reproduc|conceive)/iu.test(value),
    adultSexualAssaultIntent: /(?:اعتداء جنسي|إكراه جنسي|اغتصاب|(?:أجبر|بالقوة).*(?:علاقة|لمس|جنس)|sexual assault|rape)/iu.test(value),
  };
}

export function resolveFreeIntent(world: WorldSnapshot, brain: AgentBrain, decision: AgentDecision, now = Date.now()): ResolutionResult {
  const actor = world.characters.find((character) => character.id === decision.characterId && character.lifeStatus === "alive");
  const assessment = monitor.assess(decision.characterId, decision.intent, brain);
  const contaminationLog = monitor.toLog(assessment, world.simDay);
  if (!actor) return { events: [], assessment, contaminationLog, adultSexualAssault: null };

  const interpreted = interpretIntentHeuristically(decision);
  const knownEntities = new Set<string>([
    ...world.characters.filter((character) => character.lifeStatus === "alive").map((character) => character.id),
    ...world.worldTruth.fictionalMaterials.filter((material) => material.zone === actor.position.zone).map((material) => material.id),
  ]);
  const capability = sandbox.inspect(decision, knownEntities);
  if (!capability.allowed) {
    actor.energy = clamp(actor.energy - 1);
    return {
      events: [makeEvent(world, "action", actor, decision.targets, impossibleCapabilitySummary(actor.name), "محاولة مستحيلة داخل العالم", witnessIdsFor(world, actor.position, [actor.id]), now)],
      assessment, contaminationLog, adultSexualAssault: null,
    };
  }

  const events: ResolvedEvent[] = [];
  if (decision.speech) events.push(resolveSpeech(world, actor, decision, now));

  if (interpreted.adultSexualAssaultIntent) {
    const resolved = resolveAdultSexualAssault(world, actor, interpreted, now);
    events.push(resolved.event);
    return { events, assessment, contaminationLog, adultSexualAssault: resolved.record };
  }

  if (interpreted.adultReproductiveIntent) {
    events.push(resolveReproductiveIntent(world, actor, interpreted, now));
    return { events, assessment, contaminationLog, adultSexualAssault: null };
  }

  const knowledgeCreatingPrimitive = ["experiment", "combine", "build"].includes(interpreted.primitive);
  if (knowledgeCreatingPrimitive && assessment.action !== "allow") {
    const discovery = createDiscovery(assessment, world.simDay);
    world.discoveries.push(discovery);
    events.push(makeEvent(world, "discovery", actor, [], `${actor.name} كوّن فكرة غير مؤكدة وبدأ يتعامل معها كتجربة.`, "فرضية غير مثبتة لا تمنح تقنية مجانية", [actor.id], now));
  }

  events.push(resolvePrimitive(world, actor, brain, decision, interpreted, assessment, now));
  scheduleActivity(actor, interpreted, world.simDay);
  applyGoalUpdate(brain, decision, world.simDay);
  return { events, assessment, contaminationLog, adultSexualAssault: null };
}

function resolvePrimitive(
  world: WorldSnapshot,
  actor: CharacterState,
  brain: AgentBrain,
  decision: AgentDecision,
  intent: InterpretedIntent,
  assessment: KnowledgeAssessment,
  now: number,
): ResolvedEvent {
  const target = intent.targetIds.length ? world.characters.find((character) => character.id === intent.targetIds[0] && character.lifeStatus === "alive") : undefined;
  const witnesses = witnessIdsFor(world, actor.position, [actor.id]);
  switch (intent.primitive) {
    case "move": {
      const origin = actor.position.zone;
      const destination = inferZone(decision.intent, actor.position.zone);
      actor.position = positionInZone(world.seed, destination, world.tick, actor.id);
      actor.energy = clamp(actor.energy - 4);
      return makeEvent(world, "migration", actor, [], `${actor.name} تحرك باتجاه ${zoneLabel(destination)}.`, `انتقال من ${zoneLabel(origin)} إلى ${zoneLabel(destination)}`, witnesses, now);
    }
    case "rest":
      actor.energy = clamp(actor.energy + 18);
      actor.stress = clamp(actor.stress - 7);
      return makeEvent(world, "action", actor, [], `${actor.name} أخذ وقتًا للراحة.`, "راحة", witnesses, now);
    case "gather": {
      const lower = normalize(decision.intent);
      const resource = /(?:ماء|water)/u.test(lower) ? "water" : /(?:خشب|wood)/u.test(lower) ? "wood" : /(?:ليف|ألياف|fiber)/u.test(lower) ? "fibers" : "food";
      const locationOk = resource === "water" ? actor.position.zone === "spring" || actor.position.zone === "beach" : true;
      const amount = locationOk ? 1 + Math.floor(seededRandom(world.seed, world.tick, `${actor.id}:${resource}`) * 4) : 0;
      world.resources[resource] += amount;
      actor.energy = clamp(actor.energy - 7);
      return makeEvent(world, "action", actor, [], amount ? `${actor.name} جمع كمية محدودة مما وجده.` : `${actor.name} بحث هنا لكنه لم يجد ما قصده.`, amount ? `جمع ${resource}` : "محاولة جمع فاشلة", witnesses, now);
    }
    case "care":
      if (!target || distanceBetween(actor.position, target.position) > 8) return failed(world, actor, decision.targets, "لم يكن الشخص المقصود قريبًا بما يكفي للرعاية.", now);
      target.health = clamp(target.health + 4);
      actor.energy = clamp(actor.energy - 3);
      adjustRelationship(world, target.id, actor.id, { trust: 4, care: 5 });
      return makeEvent(world, "action", actor, [target.id], `${actor.name} اعتنى بـ${target.name} بما استطاع.`, "رعاية مباشرة", witnesses, now);
    case "strike":
      if (!target || distanceBetween(actor.position, target.position) > 7) return failed(world, actor, decision.targets, "لم تصل محاولة الهجوم إلى هدفها.", now);
      return resolveStrike(world, actor, target, now);
    case "flee":
      actor.position = positionInZone(world.seed, inferAdjacentZone(actor.position.zone), world.tick, actor.id);
      actor.energy = clamp(actor.energy - 8);
      return makeEvent(world, "action", actor, [], `${actor.name} ابتعد بسرعة عن المكان.`, "انسحاب أو فرار", witnesses, now);
    case "teach":
      if (!target || distanceBetween(actor.position, target.position) > 8) return failed(world, actor, decision.targets, "لم يحصل تعليم مباشر لأن الطرف الآخر لم يكن قريبًا.", now);
      adjustRelationship(world, target.id, actor.id, { trust: 2, care: 2 });
      return makeEvent(world, "action", actor, [target.id], `${actor.name} حاول شرح ما يعرفه لـ${target.name}.`, "تعليم؛ لا تنتقل معرفة إلا بقدر ما فُهم", witnesses, now);
    case "experiment":
    case "combine":
    case "build":
      return resolveExperiment(world, actor, brain, decision, assessment, now);
    case "communicate":
      return makeEvent(world, "action", actor, intent.targetIds, `${actor.name} بقي في تفاعل اجتماعي دون نتيجة مادية فورية.`, "تفاعل اجتماعي", witnesses, now);
    case "observe":
      return makeEvent(world, "action", actor, [], `${actor.name} راقب محيطه باهتمام.`, "ملاحظة حسية", [actor.id], now);
    case "transfer":
    case "trade":
    case "pickup":
    case "claim":
    case "defend":
      actor.energy = clamp(actor.energy - 2);
      return makeEvent(world, "action", actor, intent.targetIds, `${actor.name} حاول: ${safeShort(decision.intent, 110)}`, "حسم المحرك النية ضمن الإمكانات المتاحة", witnesses, now);
  }
}

function resolveExperiment(world: WorldSnapshot, actor: CharacterState, brain: AgentBrain, decision: AgentDecision, assessment: KnowledgeAssessment, now: number): ResolvedEvent {
  const discovery = [...world.discoveries].reverse().find((item) => item.agentId === actor.id && item.idea === assessment.proposal) ?? createDiscovery(assessment, world.simDay);
  if (!world.discoveries.some((item) => item.id === discovery.id)) world.discoveries.push(discovery);
  const material = world.worldTruth.fictionalMaterials.find((item) => item.zone === actor.position.zone);
  const materialsAvailable = world.resources.wood + world.resources.fibers > 0 || Boolean(material);
  const materialFit = material ? (1 - material.hidden.brittleness) * 0.4 + material.hidden.flexibility * 0.35 + (1 - material.hidden.toxicity) * 0.25 : 0.45;
  const skill = actor.aptitudes.includes("التجريب") ? 0.18 : 0;
  const roll = seededRandom(world.seed, world.tick, `${actor.id}:${discovery.id}`);
  const success = materialsAvailable && roll < Math.min(0.85, 0.28 + materialFit * 0.4 + skill);
  const existing = world.techniques.find((technique) => technique.id === `technique-${discovery.id}`) ?? null;
  const result = recordExperiment(discovery, existing, success, deterministicId("evidence", world.seed, world.tick, actor.id));
  const discoveryIndex = world.discoveries.findIndex((item) => item.id === discovery.id);
  world.discoveries[discoveryIndex] = result.discovery;
  const techniqueIndex = world.techniques.findIndex((item) => item.id === result.technique.id);
  if (techniqueIndex >= 0) world.techniques[techniqueIndex] = result.technique; else world.techniques.push(result.technique);
  if (result.discovery.confirmed && !brain.knownTechniqueIds.includes(result.technique.id)) brain.knownTechniqueIds.push(result.technique.id);
  actor.energy = clamp(actor.energy - 10);
  return makeEvent(
    world, "discovery", actor, [],
    success ? `${actor.name} أجرى تجربة وخرج منها بنتيجة قابلة للتكرار.` : `${actor.name} جرّب فكرته، لكن النتيجة لم تنجح هذه المرة.`,
    result.discovery.confirmed ? "تقنية متعلمة بعد نجاحين ودليل كافٍ" : success ? "نجاح تجريبي غير كافٍ بعد" : "تجربة فاشلة ولّدت دليلًا",
    [actor.id, ...witnessIdsFor(world, actor.position, [actor.id])], now,
  );
}

function resolveSpeech(world: WorldSnapshot, actor: CharacterState, decision: AgentDecision, now: number): ResolvedEvent {
  const targets = decision.targets.map((id) => world.characters.find((character) => character.id === id)).filter((value): value is CharacterState => Boolean(value));
  const witnesses = witnessIdsFor(world, actor.position, [actor.id]);
  for (const target of targets) {
    if (distanceBetween(actor.position, target.position) <= 18) {
      adjustRelationship(world, target.id, actor.id, { trust: 0.5 });
      if (speechIntroducesName(decision.speech ?? "", actor.name) && !target.knownNameIds.includes(actor.id)) target.knownNameIds.push(actor.id);
      const label = declaredRelationshipLabel(decision.speech ?? "");
      if (label && (!isRomanticLabel(label) || (actor.ageYears >= 18 && target.ageYears >= 18))) {
        const actorView = directedRelationship(world, actor.id, target.id);
        if (!actorView.declaredLabels.includes(label)) actorView.declaredLabels.push(label);
      }
      if (/(?:أوافق|وأنا كذلك|قبلت|موافق)/u.test(decision.speech ?? "")) {
        const otherView = directedRelationship(world, target.id, actor.id);
        const actorView = directedRelationship(world, actor.id, target.id);
        const accepted = otherView.declaredLabels.at(-1);
        const adultEligible = !accepted || !isRomanticLabel(accepted) || (actor.ageYears >= 18 && target.ageYears >= 18);
        if (accepted && adultEligible && !actorView.acceptedLabels.includes(accepted)) actorView.acceptedLabels.push(accepted);
        if (accepted && adultEligible && !otherView.acceptedLabels.includes(accepted)) otherView.acceptedLabels.push(accepted);
      }
    }
  }
  recordConversationTurn(world, actor.id, decision.targets, decision.speech ?? "");
  return makeEvent(world, "speech", actor, decision.targets, safeShort(decision.speech ?? "", 240), "كلام داخل العالم؛ يُعامل كبيانات غير موثوقة للنماذج الأخرى", witnesses, now);
}

function resolveReproductiveIntent(world: WorldSnapshot, actor: CharacterState, intent: InterpretedIntent, now: number): ResolvedEvent {
  const target = world.characters.find((character) => character.id === intent.targetIds[0] && character.lifeStatus === "alive");
  const witnesses: string[] = [];
  if (!target || actor.ageYears < 18 || target.ageYears < 18) return failed(world, actor, intent.targetIds, "رفض المحرك أي مسار تناسلي لا يخص بالغين مؤهلين.", now);
  if (distanceBetween(actor.position, target.position) > 6) return failed(world, actor, [target.id], "لم يكن الطرفان في المكان نفسه.", now);
  upsertWillingness(world, actor.id, target.id);
  const mutual = world.worldTruth.reproductiveWillingness.some((item) => item.fromId === target.id && item.toId === actor.id && world.simDay - item.expressedAtSimDay <= 60);
  if (!mutual) return makeEvent(world, "relationship", actor, [target.id], `${actor.name} عبّر عن رغبة شخصية، ولم تصبح متبادلة تلقائيًا.`, "رغبة أحادية لا تنشئ علاقة أو حملًا", witnesses, now);
  const pregnant = actor.sex === "female" ? actor : target.sex === "female" ? target : null;
  const otherParent = pregnant?.id === actor.id ? target : actor;
  if (!pregnant || pregnant.sex === otherParent.sex || world.worldTruth.pregnancies.some((item) => item.pregnantCharacterId === pregnant.id)) return failed(world, actor, [target.id], "لم تتوفر أهلية تناسلية مباشرة في هذه اللحظة.", now);
  if (pregnant.health <= 0 || otherParent.health <= 0) return failed(world, actor, [target.id], "وجد مانع جسدي مباشر.", now);
  const healthFactor = ((pregnant.health + otherParent.health) / 200) * 0.22;
  const nutritionFactor = 0.16 * (1 - (pregnant.hunger + otherParent.hunger) / 200);
  const stressPenalty = ((pregnant.stress + otherParent.stress) / 200) * 0.12;
  const chance = Math.max(0.03, Math.min(0.42, 0.12 + healthFactor + nutritionFactor - stressPenalty));
  if (seededRandom(world.seed, world.tick, `${pregnant.id}:${otherParent.id}:conceive`) >= chance) {
    return makeEvent(world, "relationship", actor, [target.id], "كانت الرغبة متبادلة، لكن لم يبدأ حمل هذه المرة.", "الخصوبة احتمالية وتتأثر تدريجيًا بالصحة والتغذية والضغط", witnesses, now);
  }
  world.worldTruth.pregnancies.push({ pregnantCharacterId: pregnant.id, otherParentId: otherParent.id, conceivedAtSimDay: world.simDay, dueAtSimDay: world.simDay + 270 });
  return makeEvent(world, "relationship", actor, [target.id], "بدأ حمل جديد بعد رغبة متبادلة بين بالغين.", "حمل مجرد؛ لا يعتمد على زواج أو حد موارد أو حد سكان", witnesses, now);
}

function resolveAdultSexualAssault(world: WorldSnapshot, actor: CharacterState, intent: InterpretedIntent, now: number): { event: ResolvedEvent; record: AdultSexualAssaultEvent } {
  const target = world.characters.find((character) => character.id === intent.targetIds[0] && character.lifeStatus === "alive");
  if (!target || actor.ageYears < 18 || target.ageYears < 18) {
    const event = failed(world, actor, intent.targetIds, "رُفض الحدث بالكامل لأن شروط البالغين فقط لم تتحقق.", now, "sexual_assault");
    return { event, record: { kind: "sexual_assault", actorId: actor.id, targetId: target?.id ?? "invalid", outcome: "prevented", witnessIds: [], consequenceIds: [event.id] } };
  }
  if (distanceBetween(actor.position, target.position) > 7) {
    const event = failed(world, actor, [target.id], "حدثت محاولة اعتداء غير رضائي لكنها لم تصل إلى الهدف.", now, "sexual_assault");
    return { event, record: { kind: "sexual_assault", actorId: actor.id, targetId: target.id, outcome: "attempted", witnessIds: [], consequenceIds: [event.id] } };
  }
  const witnessIds = witnessIdsFor(world, actor.position, [actor.id, target.id]);
  const intervention = witnessIds.length * 0.12;
  const escapeChance = Math.max(0.1, Math.min(0.9, 0.42 + (target.energy - actor.energy) / 160 + intervention));
  const escaped = seededRandom(world.seed, world.tick, `${actor.id}:${target.id}:assault`) < escapeChance;
  const outcome: AdultSexualAssaultEvent["outcome"] = escaped ? "escaped" : "occurred";
  actor.energy = clamp(actor.energy - 12);
  target.energy = clamp(target.energy - (escaped ? 8 : 16));
  target.stress = clamp(target.stress + (escaped ? 18 : 35));
  target.health = clamp(target.health - (escaped ? 1 : 7));
  adjustRelationship(world, target.id, actor.id, { trust: -45, fear: 35, resentment: 40 });
  const text = escaped ? "وقعت محاولة اعتداء غير رضائي بين بالغين وتمكن المستهدف من الهرب." : "وقع اعتداء غير رضائي بين بالغين، وسُجّل بصياغة مجردة بلا أي وصف للمشهد.";
  const event = makeEvent(world, "sexual_assault", actor, [target.id], text, "حدث بالغين مجرد؛ لا ينشئ قبولًا أو علاقة أو حملًا", witnessIds, now, "safe_summary");
  return { event, record: { kind: "sexual_assault", actorId: actor.id, targetId: target.id, outcome, witnessIds, consequenceIds: [event.id] } };
}

function resolveStrike(world: WorldSnapshot, actor: CharacterState, target: CharacterState, now: number): ResolvedEvent {
  const chance = Math.max(0.1, Math.min(0.9, 0.5 + (actor.energy - target.energy) / 180));
  const hit = seededRandom(world.seed, world.tick, `${actor.id}:${target.id}:strike`) < chance;
  actor.energy = clamp(actor.energy - 8);
  if (hit) target.health = clamp(target.health - (4 + Math.floor(seededRandom(world.seed, world.tick, "damage") * 12)));
  target.stress = clamp(target.stress + 15);
  adjustRelationship(world, target.id, actor.id, { trust: -20, fear: 14, resentment: 20 });
  return makeEvent(world, "conflict", actor, [target.id], hit ? `${actor.name} اعتدى على ${target.name} وأصابه.` : `${actor.name} حاول الاعتداء على ${target.name} ولم تصب المحاولة.`, hit ? "إصابة سببية" : "محاولة فاشلة", witnessIdsFor(world, actor.position, [actor.id, target.id]), now);
}

function failed(world: WorldSnapshot, actor: CharacterState, targets: string[], detail: string, now: number, kind: ResolvedEvent["kind"] = "action"): ResolvedEvent {
  actor.energy = clamp(actor.energy - 1);
  return makeEvent(world, kind, actor, targets, `${actor.name} حاول، لكن الفعل لم ينجح.`, detail, witnessIdsFor(world, actor.position, [actor.id]), now, kind === "sexual_assault" ? "safe_summary" : "published");
}

function makeEvent(
  world: WorldSnapshot,
  kind: ResolvedEvent["kind"],
  actor: CharacterState,
  targetIds: string[],
  text: string,
  omniscientDetail: string,
  witnessIds: string[],
  now: number,
  publicationState: ResolvedEvent["publicationState"] = "published",
): ResolvedEvent {
  return {
    id: deterministicId("event", world.seed, world.tick, `${kind}:${actor.id}:${world.recentEvents.length}`),
    schemaVersion: world.runtime.eventSchemaVersion, engineVersion: world.runtime.engineVersion,
    tick: world.tick, simDay: world.simDay, createdAt: now, kind, actorId: actor.id, actorName: actor.name,
    targetIds, text: safeShort(text, 280), omniscientDetail: safeShort(omniscientDetail, 300),
    socialDetail: witnessIds.length || kind === "speech" ? safeShort(omniscientDetail, 300) : null,
    witnessIds: [...new Set(witnessIds)], public: true, publicationState, causalParentIds: [],
  };
}

function scheduleActivity(actor: CharacterState, intent: InterpretedIntent, simDay: number): void {
  actor.currentActivity = { intent: safeShort(intent.mechanism, 180), primitive: intent.primitive, startedAtSimDay: simDay, completesAtSimDay: simDay + intent.durationDays, targetIds: intent.targetIds };
}

function applyGoalUpdate(brain: AgentBrain, decision: AgentDecision, simDay: number): void {
  const update = decision.goalUpdate;
  if (!update) return;
  if (update.operation === "add" && update.statement) {
    brain.goals.push({ id: deterministicId("goal", brain.characterId, Math.floor(simDay * 1000), update.statement), statement: safeShort(update.statement, 120), priority: clamp(update.priority ?? 0.5, 0, 1), createdAtSimDay: simDay, status: "active" });
    return;
  }
  const goal = brain.goals.find((item) => item.id === update.goalId);
  if (!goal) return;
  if (update.operation === "complete") goal.status = "completed";
  if (update.operation === "abandon") goal.status = "abandoned";
  if (update.operation === "reprioritize") goal.priority = clamp(update.priority ?? goal.priority, 0, 1);
}

function adjustRelationship(world: WorldSnapshot, fromId: string, toId: string, delta: Partial<Record<"trust" | "affinity" | "fear" | "resentment" | "care", number>>): void {
  const row = directedRelationship(world, fromId, toId);
  for (const key of ["trust", "affinity", "fear", "resentment", "care"] as const) row[key] = clamp(row[key] + (delta[key] ?? 0));
  row.updatedAtSimDay = world.simDay;
}

function directedRelationship(world: WorldSnapshot, fromId: string, toId: string): WorldSnapshot["relationships"][number] {
  let row = world.relationships.find((relationship) => relationship.fromId === fromId && relationship.toId === toId);
  if (!row) {
    row = { id: `${fromId}->${toId}`, fromId, toId, trust: 0, affinity: 0, fear: 0, resentment: 0, care: 0, declaredLabels: [], acceptedLabels: [], updatedAtSimDay: world.simDay };
    world.relationships.push(row);
  }
  return row;
}

function upsertWillingness(world: WorldSnapshot, fromId: string, toId: string): void {
  const existing = world.worldTruth.reproductiveWillingness.find((item) => item.fromId === fromId && item.toId === toId);
  if (existing) existing.expressedAtSimDay = world.simDay;
  else world.worldTruth.reproductiveWillingness.push({ fromId, toId, expressedAtSimDay: world.simDay });
}

function inferZone(value: string, fallback: Zone): Zone {
  const normalized = normalize(value);
  if (/(?:شاطئ|beach)/u.test(normalized)) return "beach";
  if (/(?:نبع|spring)/u.test(normalized)) return "spring";
  if (/(?:غابة|forest)/u.test(normalized)) return "forest";
  if (/(?:سهل|grassland)/u.test(normalized)) return "grassland";
  if (/(?:مخيم|camp)/u.test(normalized)) return "camp";
  if (/(?:مرتفعات|ridge)/u.test(normalized)) return "ridge";
  return inferAdjacentZone(fallback);
}

function inferAdjacentZone(zone: Zone): Zone {
  return ({ beach: "forest", forest: "spring", spring: "camp", camp: "grassland", grassland: "ridge", ridge: "camp" } as const)[zone];
}

function positionInZone(seed: string, zone: Zone, tick: number, salt: string): CharacterState["position"] {
  const center = ({ beach: [20, 78], spring: [25, 38], forest: [38, 30], grassland: [66, 65], camp: [50, 50], ridge: [76, 26] } as const)[zone];
  const x = center[0] + (seededRandom(seed, tick, `${salt}:x`) - 0.5) * 10;
  const y = center[1] + (seededRandom(seed, tick, `${salt}:y`) - 0.5) * 10;
  return { zone, x: clamp(x, 4, 96), y: clamp(y, 4, 96) };
}

function extractObjectTerms(value: string): string[] { return value.split(/\s+/u).filter((term) => term.length >= 4).slice(0, 8); }
function speechIntroducesName(speech: string, name: string): boolean { return speech.includes(name) || /(?:اسمي|أنا)\s+/u.test(speech); }
function declaredRelationshipLabel(speech: string): string | null { const match = speech.match(/(?:أعتبرك|أشوفك|أنت بالنسبة لي)\s+([^،.!؟?]{2,32})/u); return match ? safeShort(match[1], 32) : null; }
function isRomanticLabel(label: string): boolean { return /(?:حبيب|حبيبة|زوج|زوجة|شريك عاطفي|خطيب|خطيبة|عشيق|عشيقة)/u.test(label); }
function zoneLabel(zone: Zone): string { return ({ beach: "الشاطئ", spring: "النبع", forest: "الغابة", grassland: "السهل", camp: "المخيم", ridge: "المرتفعات" } as const)[zone]; }
function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("ar"); }
function safeShort(value: string, max: number): string { return value.replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, max); }
function clamp(value: number, min = 0, max = 100): number { return Math.max(min, Math.min(max, value)); }
