import { describe, expect, it } from "vitest";
import { toPublicWorldSnapshot, type AgentDecision, type SeasonConfig, type WorldSnapshot } from "../../shared/contracts";
import { advanceWorld, applyIntervention, createWorld, DEFAULT_CHARACTERS } from "../../shared/simulation";
import { observedEventsFor } from "../../shared/visibility";

const config = (overrides: Partial<SeasonConfig> = {}): SeasonConfig => ({
  id: "season-test",
  title: "موسم الاختبار",
  seed: "stable-seed",
  populationCap: 24,
  speed: 1,
  initialCharacters: DEFAULT_CHARACTERS,
  ...overrides,
});

const decision = (characterId: string, action: AgentDecision["action"], targetId: string | null = null): AgentDecision => ({
  characterId,
  action,
  targetId,
  targetZone: action === "gather_water" ? "spring" : null,
  speech: null,
  emotion: "calm",
  goal: "اختبار القاعدة",
  memory: null,
});

const runningWorld = (season: SeasonConfig): WorldSnapshot => {
  const world = createWorld(season);
  world.status = "running";
  return world;
};

describe("قواعد العالم الحاسمة", () => {
  it("creates a new season paused at time zero", () => {
    const world = createWorld(config());
    expect(world.status).toBe("paused");
    expect(world.tick).toBe(0);
    expect(world.simDay).toBe(0);
    expect(world.nextTickAt).toBeNull();
    expect(world.characters).toHaveLength(3);
  });

  it("projects only intentionally public world fields", () => {
    const world = createWorld(config());
    world.lastError = "private backend detail";
    world.characters[0].pendingProposalFrom = world.characters[1].id;
    const publicWorld = toPublicWorldSnapshot(world);
    expect(publicWorld).not.toHaveProperty("seed");
    expect(publicWorld).not.toHaveProperty("usage");
    expect(publicWorld).not.toHaveProperty("nextTickAt");
    expect(publicWorld).not.toHaveProperty("lastError");
    expect(publicWorld.characters[0]).not.toHaveProperty("pendingProposalFrom");
    expect(publicWorld.relationships[0]).not.toHaveProperty("trust");
  });

  it("never allows resources or character metrics below zero", () => {
    const world = runningWorld(config());
    world.resources = { ...world.resources, water: 0, food: 0, wood: 0, medicine: 0 };
    world.characters.forEach((person) => { person.energy = 1; person.health = 1; });
    const { state } = advanceWorld(world, [decision(world.characters[0].id, "craft")]);
    expect(Object.values(state.resources).every((value) => value >= 0)).toBe(true);
    expect(state.characters.every((person) => person.health >= 0 && person.energy >= 0)).toBe(true);
  });

  it("rejects actions from children and requires mutual consent for marriage", () => {
    const world = runningWorld(config());
    const [a, b] = world.characters;
    a.lifeStage = "child";
    a.ageYears = 12;
    const childAttempt = advanceWorld(world, [decision(a.id, "propose_marriage", b.id)]);
    expect(childAttempt.state.characters[1].pendingProposalFrom).toBeNull();

    const adultWorld = runningWorld(config());
    const [adultA, adultB] = adultWorld.characters;
    const proposed = advanceWorld(adultWorld, [decision(adultA.id, "propose_marriage", adultB.id)]).state;
    expect(proposed.characters[1].pendingProposalFrom).toBe(adultA.id);
    expect(proposed.characters[0].partnerId).toBeNull();
    const married = advanceWorld(proposed, [decision(adultB.id, "accept_marriage", adultA.id)]).state;
    expect(married.characters[0].partnerId).toBe(adultB.id);
    expect(married.characters[1].partnerId).toBe(adultA.id);
  });

  it("starts pregnancy only after mutual intent, eligibility, health and resources", () => {
    let world = runningWorld(config());
    const father = world.characters[0];
    const mother = world.characters[1];
    father.partnerId = mother.id;
    mother.partnerId = father.id;
    world.resources.food = 100;
    world.resources.water = 100;
    world = advanceWorld(world, [decision(father.id, "desire_child", mother.id)]).state;
    expect(world.characters[1].pregnantUntilDay).toBeNull();
    world = advanceWorld(world, [decision(mother.id, "desire_child", father.id)]).state;
    expect(world.characters[1].pregnantUntilDay).toBeGreaterThan(world.simDay);
  });

  it("blocks pregnancy at the population cap with a public capacity event", () => {
    const world = runningWorld(config({ populationCap: 3 }));
    const [father, mother] = world.characters;
    father.partnerId = mother.id;
    mother.partnerId = father.id;
    father.wantsChildWith = mother.id;
    world.resources.food = 100;
    world.resources.water = 100;
    const result = advanceWorld(world, [decision(mother.id, "desire_child", father.id)]);
    expect(result.state.characters[1].pregnantUntilDay).toBeNull();
    expect(result.events.some((event) => event.detail.includes("السعة"))).toBe(true);
  });

  it("creates an abstract birth after nine simulated months and grants agency at 18", () => {
    let world = runningWorld(config());
    const father = world.characters[0];
    const mother = world.characters[1];
    mother.pregnantUntilDay = 0.1;
    mother.pregnancyParentId = father.id;
    world = advanceWorld(world, [decision(father.id, "rest")]).state;
    const child = world.characters.at(-1)!;
    expect(child.lifeStage).toBe("child");
    expect(child.caregiverIds).toEqual([mother.id, father.id]);
    child.ageYears = 17.999;
    world.speed = 16;
    const adulthood = advanceWorld(world, [decision(father.id, "rest")]);
    expect(adulthood.state.characters.at(-1)?.lifeStage).toBe("adult");
    expect(adulthood.events.some((event) => event.kind === "milestone" && event.actorId === child.id)).toBe(true);
  });

  it("marks extinction and preserves an immutable public event", () => {
    const world = runningWorld(config());
    world.characters.forEach((person) => { person.health = 0; });
    const result = advanceWorld(world, []);
    expect(result.state.status).toBe("extinct");
    expect(result.events.some((event) => event.text.includes("انقراض"))).toBe(true);
  });

  it("requires two continuous simulated years before stability", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `شخص ${index + 1}`,
      sex: index % 2 ? "female" as const : "male" as const,
      ageYears: 20 + index,
      traits: ["متعاون"],
      skills: ["النجاة"],
    }));
    let world = runningWorld(config({ speed: 16, initialCharacters: many, populationCap: 24 }));
    world.resources = { ...world.resources, water: 10_000, food: 10_000, shelterCapacity: 12, waterDailyProduction: 15, foodDailyProduction: 10 };
    for (let tick = 0; tick < 181; tick += 1) world = advanceWorld(world, [decision(world.characters[0].id, "rest")]).state;
    expect(world.status).toBe("prosperous");
  });

  it("survives a seven-year deterministic fast-forward with bounded recent history", () => {
    let world: WorldSnapshot = runningWorld(config({ speed: 16 }));
    world.resources.water = 100_000;
    world.resources.food = 100_000;
    for (let tick = 0; tick < 630; tick += 1) world = advanceWorld(world, [], Date.UTC(2026, 0, 1) + tick * 30_000).state;
    expect(world.simDay).toBe(2_520);
    expect(world.recentEvents.length).toBeLessThanOrEqual(30);
    expect(world.characters.length).toBeLessThanOrEqual(world.populationCap);
  });

  it("records interventions without allowing a negative resource balance", () => {
    const world = runningWorld(config());
    const result = applyIntervention(world, "resource", "اختبار سحب مورد", { resource: "food", amount: -99 });
    expect(result.state.resources.food).toBe(0);
    expect(result.event.kind).toBe("intervention");
  });

  it("does not expose an unwitnessed character event to another agent", () => {
    const world = runningWorld(config());
    const [salem, noura] = world.characters;
    salem.position.zone = "camp";
    noura.position.zone = "forest";
    const privateByLocation = { ...world.recentEvents[0], id: "remote", actorId: noura.id, actorName: noura.name, targetId: null, kind: "speech" as const, text: "كلام بعيد" };
    world.recentEvents = [privateByLocation];
    expect(observedEventsFor(world, salem)).toEqual([]);
    noura.position.zone = "camp";
    expect(observedEventsFor(world, salem).map((event) => event.id)).toEqual(["remote"]);
  });

  it("cannot spend wood that does not exist", () => {
    const world = runningWorld(config());
    world.resources.wood = 0;
    const result = advanceWorld(world, [decision(world.characters[0].id, "build")]);
    expect(result.state.resources.shelterProgress).toBe(0);
    expect(result.events.some((event) => event.actorId === world.characters[0].id && event.kind === "action")).toBe(false);
  });
});
