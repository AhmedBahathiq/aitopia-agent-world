import { Agent, type Connection } from "agents";
import type {
  AgentDecision,
  Intervention,
  ResolvedEvent,
  SeasonConfig,
  WorldSnapshot,
} from "../../shared/contracts";
import { advanceWorld, applyIntervention, createWorld } from "../../shared/simulation";
import { observedEventsFor } from "../../shared/visibility";
import {
  MockModelProvider,
  OpenAIModelProvider,
  type ModelProvider,
  type ModelResult,
} from "./model-provider";

type AgentEnv = Env & {
  OPENAI_API_KEY?: string;
  ADMIN_BRIDGE_SECRET?: string;
};

type EventRow = { sequence: number; event_json: string };
type MemoryRow = { summary: string };

const emptyState = (): WorldSnapshot => ({
  seasonId: "",
  title: "",
  seed: "",
  status: "paused",
  initialized: false,
  tick: 0,
  simDay: 0,
  speed: 1,
  weather: "clear",
  temperatureC: 27,
  characters: [],
  relationships: [],
  resources: {
    water: 0,
    food: 0,
    wood: 0,
    medicine: 0,
    shelterCapacity: 0,
    shelterProgress: 0,
    waterDailyProduction: 0,
    foodDailyProduction: 0,
  },
  populationCap: 24,
  stabilityProgress: 0,
  stabilitySinceDay: null,
  recentEvents: [],
  usage: {
    dayKey: new Date(0).toISOString().slice(0, 10),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    maxCalls: 600,
    maxTokens: 2_000_000,
    economyMode: false,
  },
  nextTickAt: null,
  lastError: null,
});

export class WorldAgent extends Agent<AgentEnv, WorldSnapshot> {
  initialState = emptyState();
  private tickRunning = false;

  async onStart(): Promise<void> {
    this.ensureTables();
    if (this.state.initialized && ["running", "prosperous"].includes(this.state.status)) {
      await this.ensureSchedule();
    }
  }

  private ensureTables(): void {
    this.sql`CREATE TABLE IF NOT EXISTS world_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      tick INTEGER NOT NULL,
      sim_day REAL NOT NULL,
      event_json TEXT NOT NULL
    )`;
    this.sql`CREATE INDEX IF NOT EXISTS world_events_tick_idx ON world_events(tick, sequence)`;
    this.sql`CREATE TABLE IF NOT EXISTS character_memories (
      character_id TEXT NOT NULL,
      tick INTEGER NOT NULL,
      summary TEXT NOT NULL,
      PRIMARY KEY(character_id, tick, summary)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS world_snapshots (
      tick INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
    )`;
  }

  validateStateChange(_nextState: WorldSnapshot, source: Connection | "server"): void {
    if (source !== "server") throw new Error("public_connections_are_read_only");
  }

  shouldConnectionBeReadonly(): boolean {
    return true;
  }

  async initialize(config: SeasonConfig): Promise<WorldSnapshot> {
    if (this.state.initialized) return this.state;
    this.ensureTables();
    const state = createWorld(config);
    state.usage.maxCalls = positiveInt(this.env.MAX_MODEL_CALLS_PER_DAY, 600);
    state.usage.maxTokens = positiveInt(this.env.MAX_TOTAL_TOKENS_PER_DAY, 2_000_000);
    this.persistEvents(state.recentEvents);
    this.persistSnapshot(state);
    this.setState(state);
    return state;
  }

  getSnapshot(): WorldSnapshot {
    return this.state;
  }

  getEvents(cursor = 0, limit = 80): { events: ResolvedEvent[]; nextCursor: number } {
    const safeCursor = Math.max(0, Math.floor(cursor));
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.sql<EventRow>`SELECT sequence, event_json FROM world_events
      WHERE sequence > ${safeCursor} ORDER BY sequence ASC LIMIT ${safeLimit}`;
    const events = rows.map((row) => JSON.parse(row.event_json) as ResolvedEvent);
    return { events, nextCursor: rows.at(-1)?.sequence ?? safeCursor };
  }

  async tick(): Promise<void> {
    if (this.tickRunning || !this.state.initialized || !["running", "prosperous"].includes(this.state.status)) return;
    this.tickRunning = true;
    const startingTick = this.state.tick;
    try {
      const actor = this.pickActor();
      let decision: AgentDecision | null = null;
      let result: ModelResult | null = null;
      let decisionError: string | null = null;
      const budget = this.state.usage;
      const budgetAvailable = !budget.economyMode && budget.calls < budget.maxCalls && budget.inputTokens + budget.outputTokens < budget.maxTokens;

      if (actor && budgetAvailable) {
        const observed = observedEventsFor(this.state, actor);
        const memories = this.sql<MemoryRow>`SELECT summary FROM character_memories
          WHERE character_id = ${actor.id} ORDER BY tick DESC LIMIT 12`.map((row) => row.summary);
        const provider = this.createProvider();
        if (provider) {
          try {
            result = await this.retry(() => provider.decide({ world: this.state, character: actor, observedEvents: observed, memories }), {
              maxAttempts: 2,
              baseDelayMs: 250,
              maxDelayMs: 1_000,
            });
            decision = result.decision;
          } catch (error) {
            decisionError = safeError(error);
          }
        }
      }

      if (this.state.tick !== startingTick) return;
      const { state, events } = advanceWorld(this.state, decision ? [decision] : []);
      if (decisionError) state.lastError = decisionError;
      if (result) {
        state.usage.calls += 1;
        state.usage.inputTokens += result.usage.inputTokens;
        state.usage.outputTokens += result.usage.outputTokens;
        state.usage.economyMode = state.usage.calls >= state.usage.maxCalls || state.usage.inputTokens + state.usage.outputTokens >= state.usage.maxTokens;
        if (result.moderated) {
          events.unshift(systemEvent(state, "حجب نظام الأمان عبارة غير مناسبة واستمر الفعل دون نشر النص.", "محتوى محجوب"));
          state.recentEvents = [...events, ...state.recentEvents].slice(0, 30);
        }
      }
      if (decision?.memory && actor) this.persistMemory(actor.id, state.tick, decision.memory);
      this.persistEvents(events);
      if (state.tick % 20 === 0 || events.some((event) => ["birth", "death", "milestone"].includes(event.kind))) this.persistSnapshot(state);
      this.setState(state);
      try {
        await this.updateSeasonIndex(state);
      } catch (error) {
        this.setState({ ...state, lastError: `season_index: ${safeError(error)}` });
      }
    } finally {
      this.tickRunning = false;
    }
  }

  async pause(): Promise<WorldSnapshot> {
    if (!["extinct", "archived"].includes(this.state.status)) this.setState({ ...this.state, status: "paused", nextTickAt: null });
    return this.state;
  }

  async resume(): Promise<WorldSnapshot> {
    if (this.state.status === "paused") {
      this.setState({ ...this.state, status: "running", nextTickAt: Date.now() + 30_000 });
      await this.ensureSchedule();
    }
    return this.state;
  }

  setSpeed(speed: 0.25 | 1 | 4 | 16): WorldSnapshot {
    this.setState({ ...this.state, speed });
    return this.state;
  }

  setBudget(maxCalls: number, maxTokens: number): WorldSnapshot {
    const usage = {
      ...this.state.usage,
      maxCalls: Math.max(1, Math.floor(maxCalls)),
      maxTokens: Math.max(1_000, Math.floor(maxTokens)),
    };
    usage.economyMode = usage.calls >= usage.maxCalls || usage.inputTokens + usage.outputTokens >= usage.maxTokens;
    this.setState({ ...this.state, usage });
    return this.state;
  }

  intervene(input: Intervention): WorldSnapshot {
    const resolved = applyIntervention(this.state, input.type, input.description, input);
    this.persistEvents([resolved.event]);
    this.setState(resolved.state);
    return this.state;
  }

  async archive(): Promise<WorldSnapshot> {
    if (this.state.initialized) {
      const event = systemEvent(this.state, "أرشف المشرف هذا الموسم. بقي السجل متاحًا للعرض.", "أرشفة الموسم");
      const state = { ...this.state, status: "archived" as const, nextTickAt: null, recentEvents: [event, ...this.state.recentEvents].slice(0, 30) };
      this.persistEvents([event]);
      this.persistSnapshot(state);
      this.setState(state);
      const schedules = await this.listSchedules({ type: "interval" });
      await Promise.all(schedules.map((schedule) => this.cancelSchedule(schedule.id)));
    }
    return this.state;
  }

  async requestDestroy(): Promise<void> {
    await this.schedule(1, "destroyWorld", undefined, { idempotent: true });
  }

  async destroyWorld(): Promise<void> {
    await this.destroy();
  }

  private createProvider(): ModelProvider | null {
    const mode = String(this.env.SIMULATION_MODE);
    if (mode === "openai" && this.env.OPENAI_API_KEY) {
      return new OpenAIModelProvider(this.env.OPENAI_API_KEY, this.env.SIMULATION_MODEL);
    }
    if (mode === "mock") return new MockModelProvider();
    return null;
  }

  private pickActor() {
    const adults = this.state.characters.filter((person) => person.alive && person.lifeStage !== "child");
    return adults.length ? adults[this.state.tick % adults.length] : undefined;
  }

  private async ensureSchedule(): Promise<void> {
    await this.scheduleEvery(30, "tick", undefined, { retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 } });
  }

  private persistEvents(events: ResolvedEvent[]): void {
    for (const item of events) {
      this.sql`INSERT OR IGNORE INTO world_events (event_id, tick, sim_day, event_json)
        VALUES (${item.id}, ${item.tick}, ${item.simDay}, ${JSON.stringify(item)})`;
    }
  }

  private persistMemory(characterId: string, tick: number, summary: string): void {
    this.sql`INSERT OR IGNORE INTO character_memories (character_id, tick, summary)
      VALUES (${characterId}, ${tick}, ${summary.slice(0, 180)})`;
    this.sql`DELETE FROM character_memories WHERE character_id = ${characterId} AND rowid NOT IN (
      SELECT rowid FROM character_memories WHERE character_id = ${characterId} ORDER BY tick DESC LIMIT 80
    )`;
  }

  private persistSnapshot(state: WorldSnapshot): void {
    this.sql`INSERT OR REPLACE INTO world_snapshots (tick, created_at, snapshot_json)
      VALUES (${state.tick}, ${Date.now()}, ${JSON.stringify(state)})`;
    this.sql`DELETE FROM world_snapshots WHERE tick NOT IN (SELECT tick FROM world_snapshots ORDER BY tick DESC LIMIT 180)`;
  }

  private async updateSeasonIndex(state: WorldSnapshot): Promise<void> {
    const preview = state.recentEvents[0]?.text ?? null;
    await this.env.DB.prepare(`UPDATE seasons
      SET status = ?, updated_at = ?, population = ?, sim_year = ?, last_event_preview = ?
      WHERE id = ?`)
      .bind(
        state.status,
        Date.now(),
        state.characters.filter((character) => character.alive).length,
        Math.floor(state.simDay / 360) + 1,
        preview,
        state.seasonId,
      ).run();
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "model_provider_failed";
}

function systemEvent(state: WorldSnapshot, text: string, detail: string): ResolvedEvent {
  return {
    id: crypto.randomUUID(),
    tick: state.tick,
    simDay: state.simDay,
    createdAt: Date.now(),
    kind: "system",
    actorId: null,
    actorName: "النظام",
    targetId: null,
    text,
    detail,
    public: true,
  };
}
