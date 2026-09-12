export const ZONES = ["beach", "spring", "forest", "grassland", "camp", "ridge"] as const;
export const ACTIONS = ["move", "gather_water", "forage", "gather_wood", "rest", "build", "craft", "care", "teach", "talk", "explore", "propose_marriage", "accept_marriage", "separate", "desire_child"] as const;

export type Zone = (typeof ZONES)[number];
export type AgentAction = (typeof ACTIONS)[number];
export type Sex = "male" | "female";
export type LifeStage = "child" | "adult" | "elder";
export type SeasonStatus = "running" | "paused" | "prosperous" | "extinct" | "archived";
export type EventKind = "speech" | "action" | "environment" | "relationship" | "birth" | "death" | "intervention" | "milestone" | "system";

export type CharacterSeed = {
  name: string;
  sex: Sex;
  ageYears: number;
  traits: string[];
  skills: string[];
};

export type SeasonConfig = {
  id?: string;
  title: string;
  seed: string;
  populationCap: number;
  speed: 0.25 | 1 | 4 | 16;
  initialCharacters: CharacterSeed[];
};

export type ResourceState = {
  water: number;
  food: number;
  wood: number;
  medicine: number;
  shelterCapacity: number;
  shelterProgress: number;
  waterDailyProduction: number;
  foodDailyProduction: number;
};

export type Position = { zone: Zone; x: number; y: number };

export type CharacterState = {
  id: string;
  name: string;
  sex: Sex;
  ageYears: number;
  lifeStage: LifeStage;
  alive: boolean;
  health: number;
  energy: number;
  morale: number;
  hunger: number;
  thirst: number;
  traits: string[];
  skills: string[];
  position: Position;
  goal: string;
  partnerId: string | null;
  pendingProposalFrom: string | null;
  wantsChildWith: string | null;
  pregnantUntilDay: number | null;
  pregnancyParentId: string | null;
  caregiverIds: string[];
  educatedDays: number;
  color: string;
};

export type Relationship = {
  id: string;
  characterAId: string;
  characterBId: string;
  trust: number;
  affinity: number;
  conflict: number;
  status: "acquaintance" | "friend" | "married" | "separated";
};

export type AgentDecision = {
  characterId: string;
  action: AgentAction;
  targetId: string | null;
  targetZone: Zone | null;
  speech: string | null;
  emotion: "calm" | "hopeful" | "worried" | "happy" | "tired" | "angry";
  goal: string;
  memory: string | null;
};

export type ResolvedEvent = {
  id: string;
  tick: number;
  simDay: number;
  createdAt: number;
  kind: EventKind;
  actorId: string | null;
  actorName: string;
  targetId: string | null;
  text: string;
  detail: string;
  public: boolean;
};

export type UsageBudget = {
  dayKey: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  maxCalls: number;
  maxTokens: number;
  economyMode: boolean;
};

export type WorldSnapshot = {
  seasonId: string;
  title: string;
  seed: string;
  status: SeasonStatus;
  initialized: boolean;
  tick: number;
  simDay: number;
  speed: 0.25 | 1 | 4 | 16;
  weather: "clear" | "cloudy" | "rain" | "storm";
  temperatureC: number;
  characters: CharacterState[];
  relationships: Relationship[];
  resources: ResourceState;
  populationCap: number;
  stabilityProgress: number;
  stabilitySinceDay: number | null;
  recentEvents: ResolvedEvent[];
  usage: UsageBudget;
  nextTickAt: number | null;
  lastError: string | null;
};

export type Intervention = {
  type: "resource" | "weather" | "event";
  resource?: keyof Pick<ResourceState, "water" | "food" | "wood" | "medicine">;
  amount?: number;
  weather?: WorldSnapshot["weather"];
  description: string;
};

export type SeasonSummary = {
  id: string;
  title: string;
  status: SeasonStatus;
  createdAt: number;
  updatedAt: number;
  population: number;
  simYear: number;
  lastEventPreview: string | null;
};

export type PublicCharacterState = Omit<CharacterState,
  "pendingProposalFrom" | "wantsChildWith" | "pregnantUntilDay" | "pregnancyParentId"
>;

export type PublicRelationship = Pick<Relationship,
  "id" | "characterAId" | "characterBId" | "status"
>;

export type PublicWorldSnapshot = Pick<WorldSnapshot,
  "seasonId" | "title" | "status" | "initialized" | "tick" | "simDay" | "speed" |
  "weather" | "temperatureC" | "resources" | "populationCap" | "stabilityProgress" |
  "stabilitySinceDay"
> & {
  characters: PublicCharacterState[];
  relationships: PublicRelationship[];
  recentEvents: ResolvedEvent[];
};

export function toPublicWorldSnapshot(world: WorldSnapshot): PublicWorldSnapshot {
  return {
    seasonId: world.seasonId,
    title: world.title,
    status: world.status,
    initialized: world.initialized,
    tick: world.tick,
    simDay: world.simDay,
    speed: world.speed,
    weather: world.weather,
    temperatureC: world.temperatureC,
    characters: world.characters.map((character) => {
      const publicCharacter: Partial<CharacterState> = { ...character };
      delete publicCharacter.pendingProposalFrom;
      delete publicCharacter.wantsChildWith;
      delete publicCharacter.pregnantUntilDay;
      delete publicCharacter.pregnancyParentId;
      return publicCharacter as PublicCharacterState;
    }),
    relationships: world.relationships.map(({ id, characterAId, characterBId, status }) => ({
      id,
      characterAId,
      characterBId,
      status,
    })),
    resources: { ...world.resources },
    populationCap: world.populationCap,
    stabilityProgress: world.stabilityProgress,
    stabilitySinceDay: world.stabilitySinceDay,
    recentEvents: world.recentEvents.filter((event) => event.public),
  };
}

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
