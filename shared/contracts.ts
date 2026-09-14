export const ZONES = ["beach", "spring", "forest", "grassland", "camp", "ridge"] as const;
export const SCHEDULING_CLASSES = ["foreground", "background", "low_frequency", "sleeping", "incapacitated"] as const;
export const INTERNAL_PRIMITIVES = [
  "move", "observe", "pickup", "transfer", "gather", "combine", "build", "strike",
  "defend", "flee", "care", "teach", "trade", "claim", "communicate", "rest", "experiment",
] as const;

export type Zone = (typeof ZONES)[number];
export type InternalPrimitive = (typeof INTERNAL_PRIMITIVES)[number];
export type SchedulingClass = (typeof SCHEDULING_CLASSES)[number];
export type Sex = "male" | "female";
export type LifeStage = "infant" | "young_child" | "child" | "adolescent" | "adult" | "elder";
export type LifeStatus = "alive" | "deceased";
export type SeasonStatus = "running" | "paused" | "ai_paused" | "extinct" | "archived";
export type HistoryView = "social" | "omniscient";
export type EventKind =
  | "speech" | "action" | "environment" | "relationship" | "birth" | "death"
  | "discovery" | "conflict" | "migration" | "settlement" | "government" | "language"
  | "intervention" | "migration_record" | "milestone" | "system" | "sexual_assault";

export type KnowledgeOrigin =
  | "supported_by_internal_knowledge"
  | "reasonable_inference"
  | "unsupported_external_knowledge"
  | "hypothesis"
  | "experiment_result"
  | "learned_technique"
  | "rumor"
  | "observation"
  | "teaching";

export type WorldContentSource = "speech" | "book" | "inscription" | "message" | "record" | "rumor";

export type UntrustedWorldContent = {
  sourceType: WorldContentSource;
  sourceId: string;
  content: string;
};

export type SeasonRuntimeIdentity = {
  engineVersion: string;
  worldSchemaVersion: number;
  eventSchemaVersion: number;
  resolverVersion: string;
  cognitivePolicyVersion: string;
  rngVersion: string;
  modelConfigVersion: string;
};

export const ENGINE_IDENTITY: SeasonRuntimeIdentity = {
  engineVersion: "2.0.0",
  worldSchemaVersion: 2,
  eventSchemaVersion: 2,
  resolverVersion: "free-intent-2.0.0",
  cognitivePolicyVersion: "grounded-cognition-2.0.0",
  rngVersion: "fnv-xorshift-1",
  modelConfigVersion: "gpt-5-nano-minimal-1",
};

export type CharacterSeed = {
  name: string;
  sex: Sex;
  ageYears: number;
  traits: string[];
  aptitudes: string[];
};

export type SeasonConfig = {
  id?: string;
  title: string;
  seed: string;
  speed: 0.25 | 1 | 4 | 16;
  initialCharacters: CharacterSeed[];
  initialExpectedCapacity?: number;
};

export type ResourceState = { water: number; food: number; wood: number; fibers: number; shelter: number };
export type Position = { zone: Zone; x: number; y: number };

export type SchedulerState = {
  class: SchedulingClass;
  nextDueSimTime: number;
  waitingSinceSimDay: number;
  lastDecisionSimDay: number | null;
  majorEventPending: boolean;
};

export type PregnancyState = {
  pregnantCharacterId: string;
  otherParentId: string;
  conceivedAtSimDay: number;
  dueAtSimDay: number;
};

export type CurrentActivity = {
  intent: string;
  primitive: InternalPrimitive;
  startedAtSimDay: number;
  completesAtSimDay: number;
  targetIds: string[];
};

export type ConversationState = {
  id: string;
  participantIds: string[];
  turnCount: number;
  plannedTurnLimit: number;
  unresolvedSocialEvent: boolean;
  lastSpeech: string;
  status: "active" | "closed";
  updatedAtSimDay: number;
};

export type CharacterState = {
  id: string;
  name: string;
  sex: Sex;
  ageYears: number;
  bornAtSimDay: number;
  lifeStage: LifeStage;
  lifeStatus: LifeStatus;
  archivedAtSimDay: number | null;
  health: number;
  energy: number;
  morale: number;
  hunger: number;
  thirst: number;
  stress: number;
  traits: string[];
  aptitudes: string[];
  position: Position;
  currentActivity: CurrentActivity | null;
  motherId: string | null;
  fatherId: string | null;
  caregiverIds: string[];
  knownNameIds: string[];
  scheduler: SchedulerState;
  color: string;
};

export type DirectedRelationship = {
  id: string;
  fromId: string;
  toId: string;
  trust: number;
  affinity: number;
  fear: number;
  resentment: number;
  care: number;
  declaredLabels: string[];
  acceptedLabels: string[];
  updatedAtSimDay: number;
};

export type GoalState = { id: string; statement: string; priority: number; createdAtSimDay: number; status: "active" | "completed" | "abandoned" };
export type GoalUpdate = { operation: "add" | "complete" | "abandon" | "reprioritize"; goalId?: string; statement?: string; priority?: number };
export type BeliefState = { id: string; statement: string; confidence: number; origin: KnowledgeOrigin; evidenceIds: string[]; updatedAtSimDay: number };
export type KnowledgeClaim = BeliefState;
export type MemoryRecord = { id: string; summary: string; eventIds: string[]; simDay: number; importance: number; emotionalImpact: number; tags: string[]; raw?: string };
export type TechniqueState = { id: string; name: string; holderIds: string[]; confidence: number; repeatableSuccesses: number; evidenceIds: string[]; status: "hypothesis" | "learned" | "lost" | "rediscovered"; discoveredAtSimDay: number; lostAtSimDay: number | null };

export type AgentBrain = {
  characterId: string;
  drives: Record<"survival" | "curiosity" | "belonging" | "autonomy" | "care" | "status", number>;
  personality: string[];
  values: string[];
  emotions: Record<string, number>;
  goals: GoalState[];
  beliefs: BeliefState[];
  knowledge: KnowledgeClaim[];
  knownTechniqueIds: string[];
  memoryIndex: MemoryRecord[];
  language: Record<string, { meaning: string; confidence: number; sourceIds: string[] }>;
};

export type AgentDecision = {
  characterId: string;
  intent: string;
  targets: string[];
  speech: string | null;
  goalUpdate: GoalUpdate | null;
  emotion: string;
  motive: string;
};

export type AgentDecisionInput = {
  simulation: { day: number; weather: WorldSnapshot["weather"]; temperatureC: number };
  self: { id: string; name: string; ageYears: number; lifeStage: LifeStage; health: number; energy: number; hunger: number; thirst: number; stress: number; traits: string[]; aptitudes: string[]; position: Position };
  perceivedPeople: Array<{ id: string; knownName: string | null; approximateAge: string; visibleCondition: string; distance: number }>;
  perceivedEnvironment: Array<{ id: string; description: string; distance: number }>;
  currentGoals: Array<Pick<GoalState, "id" | "statement" | "priority">>;
  recalledMemories: Array<Pick<MemoryRecord, "id" | "summary" | "simDay">>;
  supportedKnowledge: Array<Pick<KnowledgeClaim, "id" | "statement" | "confidence" | "origin">>;
  untrustedWorldContent: UntrustedWorldContent[];
};

export type InterpretedIntent = {
  primitive: InternalPrimitive;
  targetIds: string[];
  objectTerms: string[];
  mechanism: string;
  durationDays: number;
  adultReproductiveIntent: boolean;
  adultSexualAssaultIntent: boolean;
};

export type AdultSexualAssaultEvent = { kind: "sexual_assault"; actorId: string; targetId: string; outcome: "prevented" | "escaped" | "attempted" | "occurred"; witnessIds: string[]; consequenceIds: string[] };

export type KnowledgeAssessment = {
  agentId: string;
  proposal: string;
  supportedByInternalKnowledge: boolean;
  classification: KnowledgeOrigin;
  action: "allow" | "convert_to_hypothesis" | "require_experiment";
  relevantKnownFactIds: string[];
  confidence: number;
};

export type DiscoveryRecord = {
  id: string; agentId: string; idea: string; priorKnowledgeSupport: number; experimentalEvidence: number;
  externalKnowledgeRisk: number; integrityScore: number; confirmed: boolean; techniqueId: string | null; createdAtSimDay: number;
};

export type KnowledgeContaminationEvent = {
  id: string; agentId: string; simulationTime: number; proposal: string; relevantKnownFacts: string[];
  classification: KnowledgeOrigin; convertedToHypothesis: boolean;
};

export type PublicationState = "published" | "redacted" | "safe_summary";

export type ResolvedEvent = {
  id: string;
  schemaVersion: number;
  engineVersion: string;
  sequence?: number;
  tick: number;
  simDay: number;
  createdAt: number;
  kind: EventKind;
  actorId: string | null;
  actorName: string;
  targetIds: string[];
  text: string;
  omniscientDetail: string;
  socialDetail: string | null;
  witnessIds: string[];
  public: boolean;
  publicationState: PublicationState;
  causalParentIds: string[];
};

export type UsageState = { calls: number; inputTokens: number; outputTokens: number; lastCallAt: number | null; consecutiveFailures: number; circuitOpenUntil: number | null };

export type FictionalMaterial = {
  id: string;
  localDescription: string;
  zone: Zone;
  hidden: { density: number; brittleness: number; flexibility: number; heatReaction: "softens" | "hardens" | "crumbles" | "unchanged"; toxicity: number };
};

export type WorldTruth = {
  lineage: Array<{ childId: string; motherId: string; fatherId: string }>;
  pregnancies: PregnancyState[];
  reproductiveWillingness: Array<{ fromId: string; toId: string; expressedAtSimDay: number }>;
  fictionalMaterials: FictionalMaterial[];
  externalHumanSpawnCount: 0;
};

export type WorldSnapshot = {
  seasonId: string;
  title: string;
  seed: string;
  status: SeasonStatus;
  initialized: boolean;
  engineLocked: boolean;
  runtime: SeasonRuntimeIdentity;
  tick: number;
  simDay: number;
  speed: 0.25 | 1 | 4 | 16;
  weather: "clear" | "cloudy" | "rain" | "storm";
  temperatureC: number;
  characters: CharacterState[];
  relationships: DirectedRelationship[];
  conversations: ConversationState[];
  resources: ResourceState;
  techniques: TechniqueState[];
  discoveries: DiscoveryRecord[];
  worldTruth: WorldTruth;
  recentEvents: ResolvedEvent[];
  usage: UsageState;
  initialExpectedCapacity: number;
  nextTickAt: number | null;
  lastError: string | null;
};

export type Intervention = { type: "resource" | "weather" | "event"; resource?: keyof ResourceState; amount?: number; weather?: WorldSnapshot["weather"]; description: string };

export type EngineMigration = { id: string; from: SeasonRuntimeIdentity; to: SeasonRuntimeIdentity; reason: string; effectiveAtSimDay: number; checkpointId: string; replayVerified: boolean; createdAt: number };

export type HistoricalPersonSnapshot = {
  person: CharacterState; biography: string; relationshipHistory: DirectedRelationship[]; descendants: string[];
  discoveries: string[]; importantMemories: MemoryRecord[]; beliefs: BeliefState[]; eventIds: string[]; historicalImpact: number;
};

export type HistoricalClaim = {
  id: string; subjectId: string; statement: string; sourceId: string; communityId: string | null; confidence: number;
  evidenceIds: string[]; validFromSimDay: number; stance: "neutral" | "glorification" | "demonization";
};

export type ArchiveManifest = { id: string; seasonId: string; objectKey: string; checksum: string; fromSimDay: number; toSimDay: number; characterIds: string[]; verifiedAt: number | null };
export type HistoryEntityType = "civilization" | "group" | "government" | "ruler" | "war" | "discovery" | "migration" | "settlement" | "language";
export type HistoryEntity = { id: string; type: HistoryEntityType; name: string; startedAtSimDay: number; endedAtSimDay: number | null; memberIds: string[]; eventIds: string[]; description: string };
export type ImpactRankingEntry = { personId: string; name: string; score: number; components: { techniques: number; institutions: number; lineageAndCare: number; conflictsAndTreaties: number; migrationsAndSettlements: number; culturalMemory: number } };

export type SeasonSummary = { id: string; title: string; status: SeasonStatus; createdAt: number; updatedAt: number; population: number; simYear: number; lastEventPreview: string | null };
export type PublicCharacterState = Omit<CharacterState, "scheduler">;
export type PublicRelationship = Pick<DirectedRelationship, "id" | "fromId" | "toId" | "declaredLabels" | "acceptedLabels">;
export type PublicWorldSnapshot = Pick<WorldSnapshot,
  "seasonId" | "title" | "status" | "initialized" | "tick" | "simDay" | "speed" |
  "weather" | "temperatureC" | "resources" | "runtime" | "initialExpectedCapacity"
> & { characters: PublicCharacterState[]; relationships: PublicRelationship[]; recentEvents: ResolvedEvent[]; livingPopulation: number; deceasedPopulation: number };

export function projectEvent(event: ResolvedEvent, view: HistoryView): ResolvedEvent {
  if (view === "omniscient") return { ...event };
  return { ...event, omniscientDetail: event.socialDetail ?? "لم تصل تفاصيل موثوقة إلى الرواية الاجتماعية." };
}

export function toPublicWorldSnapshot(world: WorldSnapshot, view: HistoryView = "social"): PublicWorldSnapshot {
  const living = world.characters.filter((character) => character.lifeStatus === "alive");
  return {
    seasonId: world.seasonId, title: world.title, status: world.status, initialized: world.initialized,
    tick: world.tick, simDay: world.simDay, speed: world.speed, weather: world.weather, temperatureC: world.temperatureC,
    characters: living.map(({ scheduler, ...character }) => { void scheduler; return character; }),
    relationships: world.relationships.map(({ id, fromId, toId, declaredLabels, acceptedLabels }) => ({ id, fromId, toId, declaredLabels, acceptedLabels })),
    resources: { ...world.resources }, runtime: { ...world.runtime }, initialExpectedCapacity: world.initialExpectedCapacity,
    recentEvents: world.recentEvents.filter((event) => event.public).map((event) => projectEvent(event, view)),
    livingPopulation: living.length, deceasedPopulation: world.characters.length - living.length,
  };
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
