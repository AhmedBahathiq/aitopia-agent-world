import { Agent, type Connection } from "agents";
import type {
  AgentBrain,
  AgentDecision,
  ArchiveManifest,
  EngineMigration,
  HistoricalClaim,
  HistoricalPersonSnapshot,
  HistoryEntity,
  HistoryEntityType,
  HistoryView,
  Intervention,
  KnowledgeContaminationEvent,
  ResolvedEvent,
  SeasonConfig,
  SeasonRuntimeIdentity,
  WorldSnapshot,
} from "../../shared/contracts";
import { ENGINE_IDENTITY, projectEvent, toPublicWorldSnapshot } from "../../shared/contracts";
import { addEventMemory, buildDecisionInput, selectDueCharacter } from "../../shared/brain";
import { createResolvedEvent, normalizeResolvedEvent } from "../../shared/events";
import { createHistoricalPersonSnapshot, compressibleWorkingMemories, entitiesByType, familyTree, impactRanking, socialClaimsAsOf, timelineFor } from "../../shared/history";
import { deriveHistoricalClaims, deriveObserverEntities } from "../../shared/observer-history";
import { advanceWorld, applyIntervention, createInitialBrains, createWorld, freezeRuntimeOnStart } from "../../shared/simulation";
import {
  MockModelProvider,
  ModelProviderError,
  OpenAIModelProvider,
  PublicationSafetyFilter,
  type AgentModelProvider,
  type ModelResult,
} from "./model-provider";

type AgentEnv = Env & {
  OPENAI_API_KEY?: string;
  ADMIN_BRIDGE_SECRET?: string;
  INITIAL_EXPECTED_CAPACITY?: string;
  ARCHIVE?: R2Bucket;
  PublicStreamAgent: DurableObjectNamespace;
};

type EventRow = { sequence: number; event_json: string };
type JsonRow = { value_json: string };
type PersonRow = { person_json: string };
type ClaimRow = { claim_json: string };
type EntityRow = { entity_json: string };
type CheckpointRow = { checkpoint_id: string; sim_day: number; snapshot_json: string; kind: string; runtime_json: string };

const emptyState = (): WorldSnapshot => ({
  seasonId: "", title: "", seed: "", status: "paused", initialized: false, engineLocked: false,
  runtime: { ...ENGINE_IDENTITY }, tick: 0, simDay: 0, speed: 1, weather: "clear", temperatureC: 28,
  characters: [], relationships: [], conversations: [], resources: { water: 0, food: 0, wood: 0, fibers: 0, shelter: 0 },
  techniques: [], discoveries: [],
  worldTruth: { lineage: [], pregnancies: [], reproductiveWillingness: [], fictionalMaterials: [], externalHumanSpawnCount: 0 },
  recentEvents: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, lastCallAt: null, consecutiveFailures: 0, circuitOpenUntil: null },
  initialExpectedCapacity: 24, nextTickAt: null, lastError: null,
});

export class WorldAgent extends Agent<AgentEnv, WorldSnapshot> {
  initialState = emptyState();

  async onStart(): Promise<void> {
    this.ensureTables();
    if (this.state.initialized && this.state.status === "running") await this.ensureSchedule();
  }

  validateStateChange(_nextState: WorldSnapshot, source: Connection | "server"): void {
    if (source !== "server") throw new Error("public_connections_are_read_only");
  }

  shouldConnectionBeReadonly(): boolean { return true; }

  async initialize(config: SeasonConfig): Promise<WorldSnapshot> {
    if (this.state.initialized) return this.state;
    this.ensureTables();
    const state = createWorld({ ...config, initialExpectedCapacity: positiveInt(this.env.INITIAL_EXPECTED_CAPACITY, config.initialExpectedCapacity ?? 24) });
    this.persistBrains(createInitialBrains(state), state.simDay);
    this.persistEvents(state.recentEvents);
    this.persistCheckpoint(state, "full", "initial");
    this.setState(state);
    await this.publishPublicState(state);
    return state;
  }

  getSnapshot(): WorldSnapshot { return this.state; }

  getPublicSnapshot(view: HistoryView = "social") { return toPublicWorldSnapshot(this.state, view); }

  getEvents(cursor = 0, limit = 80, view: HistoryView = "social"): { events: ResolvedEvent[]; nextCursor: number } {
    const safeCursor = Math.max(0, Math.floor(cursor));
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.sql<EventRow>`SELECT sequence, event_json FROM world_events WHERE sequence > ${safeCursor} ORDER BY sequence ASC LIMIT ${safeLimit}`;
    return {
      events: rows.map((row) => projectEvent(normalizeResolvedEvent(JSON.parse(row.event_json), row.sequence), view)).filter((event) => event.public),
      nextCursor: rows.at(-1)?.sequence ?? safeCursor,
    };
  }

  async tick(): Promise<void> {
    if (!this.state.initialized || this.state.status !== "running") return;
    const lease = this.acquireTickLease();
    if (!lease) return;
    const startingTick = this.state.tick;
    try {
      const brains = this.loadBrains();
      const actor = selectDueCharacter(this.state);
      let modelResult: ModelResult | null = null;
      let decision: AgentDecision | null = null;
      let modelError: string | null = null;
      const circuitOpen = this.state.usage.circuitOpenUntil !== null && this.state.usage.circuitOpenUntil > Date.now();
      if (actor && !circuitOpen) {
        const provider = this.createProvider();
        const brain = brains.get(actor.id);
        if (provider && brain) {
          try {
            modelResult = await this.retry(() => provider.decide(actor.id, buildDecisionInput(this.state, actor, brain)), { maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 1_200 });
            decision = modelResult.decision;
          } catch (error) {
            if (error instanceof ModelProviderError && error.quotaRelated) {
              const paused = { ...this.state, status: "ai_paused" as const, nextTickAt: null, lastError: "openai_quota_exhausted" };
              this.setState(paused);
              await this.cancelTickSchedules();
              await this.publishPublicState(paused);
              return;
            }
            modelError = safeError(error);
          }
        }
      }
      if (this.state.tick !== startingTick) return;
      const advanced = advanceWorld(this.state, decision ? [decision] : [], brains);
      const state = advanced.state;
      if (modelResult) {
        state.usage.calls += 1;
        state.usage.inputTokens += modelResult.usage.inputTokens;
        state.usage.outputTokens += modelResult.usage.outputTokens;
        state.usage.lastCallAt = Date.now();
        state.usage.consecutiveFailures = 0;
        state.usage.circuitOpenUntil = null;
      } else if (modelError) {
        state.usage.consecutiveFailures += 1;
        if (state.usage.consecutiveFailures >= 3) state.usage.circuitOpenUntil = Date.now() + 5 * 60_000;
        state.lastError = modelError;
      }

      const publicationFilter = new PublicationSafetyFilter(this.env.OPENAI_API_KEY);
      const publicEvents: ResolvedEvent[] = [];
      for (const event of advanced.events) {
        const filtered = await publicationFilter.filter(event);
        publicEvents.push({ ...event, text: filtered.publicText, publicationState: filtered.state });
      }
      state.recentEvents = [...publicEvents, ...this.state.recentEvents].slice(0, 40);
      this.persistEvents(publicEvents);
      this.persistDerivedHistory(state, publicEvents);
      this.persistResolutions(decision, advanced.resolutions);
      this.updateBrainMemories(state, advanced.brains, publicEvents);
      for (const personId of advanced.newlyDeceasedIds) await this.archiveDeceased(state, personId, advanced.brains.get(personId), publicEvents);
      this.persistBrains(advanced.brains, state.simDay);
      await this.maybeReflect(state, actor?.id ?? null, advanced.brains, publicEvents);
      await this.maybeCheckpoint(state);
      this.setState(state);
      await this.updateSeasonIndex(state);
      await this.publishPublicState(state);
      if (state.status !== "running") await this.cancelTickSchedules();
    } finally {
      this.releaseTickLease(lease);
    }
  }

  async pause(): Promise<WorldSnapshot> {
    if (!this.state.initialized || this.state.status === "archived" || this.state.status === "extinct") return this.state;
    const state = { ...this.state, status: "paused" as const, nextTickAt: null };
    this.setState(state);
    await this.cancelTickSchedules();
    await this.publishPublicState(state);
    return state;
  }

  async resume(): Promise<WorldSnapshot> {
    if (!this.state.initialized || !["paused", "ai_paused"].includes(this.state.status)) return this.state;
    const state = freezeRuntimeOnStart({ ...this.state, status: "running", nextTickAt: Date.now() + 30_000, lastError: null });
    this.setState(state);
    await this.ensureSchedule();
    await this.publishPublicState(state);
    return state;
  }

  async setSpeed(speed: 0.25 | 1 | 4 | 16): Promise<WorldSnapshot> {
    const state = { ...this.state, speed };
    this.setState(state);
    await this.publishPublicState(state);
    return state;
  }

  async intervene(input: Intervention): Promise<WorldSnapshot> {
    const resolved = applyIntervention(this.state, input);
    this.persistEvents([resolved.event]);
    this.setState(resolved.state);
    await this.publishPublicState(resolved.state);
    return resolved.state;
  }

  async archive(): Promise<WorldSnapshot> {
    if (!this.state.initialized) return this.state;
    const event = createResolvedEvent(this.state, "system", null, "أُرشف الموسم وبقي تاريخه متاحًا.", "أرشفة إدارية عامة ودائمة.", { socialDetail: "أُرشف الموسم.", salt: "season-archive" });
    const state = { ...this.state, status: "archived" as const, nextTickAt: null, recentEvents: [event, ...this.state.recentEvents].slice(0, 40) };
    this.persistEvents([event]);
    this.persistCheckpoint(state, "full", "archive");
    this.setState(state);
    await this.cancelTickSchedules();
    await this.publishPublicState(state);
    return state;
  }

  async migrateRuntime(to: SeasonRuntimeIdentity, reason: string): Promise<EngineMigration> {
    if (this.state.status !== "paused") throw new Error("migration_requires_paused_season");
    const checkpointId = this.persistCheckpoint(this.state, "full", `pre-migration:${to.engineVersion}`);
    const migration: EngineMigration = { id: crypto.randomUUID(), from: this.state.runtime, to, reason: reason.slice(0, 240), effectiveAtSimDay: this.state.simDay, checkpointId, replayVerified: this.verifyCheckpoint(checkpointId), createdAt: Date.now() };
    if (!migration.replayVerified) throw new Error("migration_replay_verification_failed");
    const event = createResolvedEvent(this.state, "migration_record", null, "تم تطبيق ترحيل موثق على قوانين الموسم.", `${migration.from.engineVersion} → ${migration.to.engineVersion}: ${migration.reason}`, { socialDetail: "تم توثيق تغيير في محرك الموسم.", salt: `migration:${migration.id}` });
    this.sql`INSERT INTO engine_migrations (migration_id, migration_json) VALUES (${migration.id}, ${JSON.stringify(migration)})`;
    this.persistEvents([event]);
    const state = { ...this.state, runtime: { ...to }, recentEvents: [event, ...this.state.recentEvents].slice(0, 40) };
    this.setState(state);
    await this.publishPublicState(state);
    return migration;
  }

  getCharacter(personId: string, view: HistoryView, asOfDay?: number): unknown {
    const person = this.state.characters.find((character) => character.id === personId);
    if (!person) return null;
    const archived = this.sql<PersonRow>`SELECT person_json FROM historical_people WHERE person_id = ${personId} LIMIT 1`[0];
    const claims = this.loadClaims().filter((claim) => claim.subjectId === personId);
    if (view === "social") return { person: stripPrivateCharacter(person), claims: socialClaimsAsOf(claims, asOfDay ?? this.state.simDay) };
    return archived ? JSON.parse(archived.person_json) : { person: stripPrivateCharacter(person), truthLineage: this.state.worldTruth.lineage.find((line) => line.childId === personId) ?? null };
  }

  getAnalytics(includePrivate = false): unknown {
    const contamination = this.sql<{ classification: string; count: number }>`SELECT classification, COUNT(*) AS count FROM knowledge_contamination_logs GROUP BY classification`;
    const tested = this.state.discoveries.filter((item) => item.experimentalEvidence > 0);
    const analytics: Record<string, unknown> = {
      unsupportedIdeas: countBy(contamination, "unsupported_external_knowledge"),
      hypotheses: this.state.discoveries.length,
      hypothesesTested: tested.length,
      hypothesesSucceeded: tested.filter((item) => item.confirmed).length,
      hypothesesFailed: tested.filter((item) => !item.confirmed).length,
      learnedTechniques: this.state.techniques.filter((item) => item.status === "learned" || item.status === "rediscovered").length,
      lostTechniques: this.state.techniques.filter((item) => item.status === "lost").length,
      discoveriesByAgent: Object.fromEntries(this.state.characters.map((person) => [person.id, this.state.discoveries.filter((item) => item.agentId === person.id).length])),
    };
    if (includePrivate) analytics.usage = { ...this.state.usage };
    return analytics;
  }

  getDiscoveries() { return { discoveries: this.state.discoveries, techniques: this.state.techniques }; }

  getHistoryTimeline(view: HistoryView, atDay?: number, asOfDay?: number): unknown {
    const events = this.loadAllEvents();
    return { events: timelineFor(events, view, atDay), claims: view === "social" ? socialClaimsAsOf(this.loadClaims(), asOfDay ?? atDay ?? this.state.simDay) : [] };
  }

  getDeceased(): HistoricalPersonSnapshot[] {
    return this.sql<PersonRow>`SELECT person_json FROM historical_people ORDER BY archived_at_sim_day ASC`.map((row) => JSON.parse(row.person_json) as HistoricalPersonSnapshot);
  }

  getHistoricalPerson(personId: string, view: HistoryView, asOfDay?: number): unknown { return this.getCharacter(personId, view, asOfDay); }
  getFamilyTree(rootId?: string): unknown { return familyTree(this.state, rootId); }
  getHistoryEntities(type?: HistoryEntityType, atDay?: number): HistoryEntity[] { return entitiesByType(this.loadEntities(), type, atDay); }
  getImpactRanking() { return impactRanking(this.state, this.loadAllEvents(), this.loadClaims()); }

  getReplay(atDay: number, view: HistoryView, asOfDay?: number): unknown {
    const checkpoint = this.sql<CheckpointRow>`SELECT checkpoint_id, sim_day, snapshot_json, kind, runtime_json FROM world_checkpoints WHERE sim_day <= ${atDay} ORDER BY sim_day DESC LIMIT 1`[0];
    if (!checkpoint) return null;
    const snapshot = JSON.parse(checkpoint.snapshot_json) as WorldSnapshot;
    const events = this.loadAllEvents().filter((event) => event.simDay > checkpoint.sim_day && event.simDay <= atDay).map((event) => projectEvent(event, view));
    return { checkpointId: checkpoint.checkpoint_id, checkpointDay: checkpoint.sim_day, checkpointKind: checkpoint.kind, runtime: JSON.parse(checkpoint.runtime_json), snapshot: toPublicWorldSnapshot(snapshot, view), appliedEvents: events, asOfDay: asOfDay ?? atDay };
  }

  getMap(bbox?: [number, number, number, number], cursor = 0, limit = 200): unknown {
    const living = this.state.characters.filter((person) => person.lifeStatus === "alive" && (!bbox || (person.position.x >= bbox[0] && person.position.y >= bbox[1] && person.position.x <= bbox[2] && person.position.y <= bbox[3])));
    const page = living.slice(cursor, cursor + Math.min(500, Math.max(1, limit)));
    const clusters = clusterPeople(page);
    return { clusters, people: page.map(stripPrivateCharacter), nextCursor: cursor + page.length < living.length ? cursor + page.length : null };
  }

  async requestDestroy(): Promise<void> { await this.schedule(1, "destroyWorld", undefined, { idempotent: true }); }
  async destroyWorld(): Promise<void> { await this.destroy(); }

  private ensureTables(): void {
    this.sql`CREATE TABLE IF NOT EXISTS world_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, tick INTEGER NOT NULL, sim_day REAL NOT NULL, schema_version INTEGER NOT NULL, engine_version TEXT NOT NULL, event_json TEXT NOT NULL)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_world_events_day_sequence ON world_events(sim_day, sequence)`;
    this.sql`CREATE TABLE IF NOT EXISTS agent_brains (character_id TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_sim_day REAL NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS decision_ledger (decision_id TEXT PRIMARY KEY, tick INTEGER NOT NULL, character_id TEXT NOT NULL, decision_json TEXT NOT NULL, runtime_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS knowledge_contamination_logs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, sim_day REAL NOT NULL, classification TEXT NOT NULL, log_json TEXT NOT NULL)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_contamination_agent_day ON knowledge_contamination_logs(agent_id, sim_day)`;
    this.sql`CREATE TABLE IF NOT EXISTS adult_assault_events (event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS historical_people (person_id TEXT PRIMARY KEY, archived_at_sim_day REAL NOT NULL, person_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS cold_memory_blocks (block_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, compression TEXT NOT NULL, bytes BLOB NOT NULL, checksum TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS archive_manifests (manifest_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, manifest_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS historical_claims (claim_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, valid_from_sim_day REAL NOT NULL, claim_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS history_entities (entity_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, started_at_sim_day REAL NOT NULL, entity_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS world_checkpoints (checkpoint_id TEXT PRIMARY KEY, sim_day REAL NOT NULL, kind TEXT NOT NULL, runtime_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, checksum TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this.sql`CREATE INDEX IF NOT EXISTS idx_checkpoints_day ON world_checkpoints(sim_day)`;
    this.sql`CREATE TABLE IF NOT EXISTS engine_migrations (migration_id TEXT PRIMARY KEY, migration_json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS world_runtime_locks (lock_name TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS archive_cursor (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`;
  }

  private createProvider(): AgentModelProvider | null {
    const mode = String(this.env.SIMULATION_MODE ?? "openai");
    if (mode === "openai" && this.env.OPENAI_API_KEY) return new OpenAIModelProvider(this.env.OPENAI_API_KEY, String(this.env.SIMULATION_MODEL ?? "gpt-5-nano"));
    if (mode === "mock") return new MockModelProvider();
    return null;
  }

  private loadBrains(): Map<string, AgentBrain> {
    const rows = this.sql<{ character_id: string; value_json: string }>`SELECT character_id, value_json FROM agent_brains`;
    return new Map(rows.map((row) => [row.character_id, JSON.parse(row.value_json) as AgentBrain]));
  }

  private persistBrains(brains: Map<string, AgentBrain>, simDay = this.state.simDay): void {
    for (const [characterId, brain] of brains) {
      this.sql`INSERT INTO agent_brains (character_id, value_json, updated_at_sim_day) VALUES (${characterId}, ${JSON.stringify(brain)}, ${simDay}) ON CONFLICT(character_id) DO UPDATE SET value_json = excluded.value_json, updated_at_sim_day = excluded.updated_at_sim_day`;
    }
  }

  private persistEvents(events: ResolvedEvent[]): void {
    for (const event of events) {
      this.sql`INSERT OR IGNORE INTO world_events (event_id, tick, sim_day, schema_version, engine_version, event_json) VALUES (${event.id}, ${event.tick}, ${event.simDay}, ${event.schemaVersion}, ${event.engineVersion}, ${JSON.stringify(event)})`;
    }
  }

  private persistDerivedHistory(state: WorldSnapshot, latestEvents: ResolvedEvent[]): void {
    for (const claim of deriveHistoricalClaims(state, latestEvents)) {
      this.sql`INSERT OR IGNORE INTO historical_claims (claim_id, subject_id, valid_from_sim_day, claim_json) VALUES (${claim.id}, ${claim.subjectId}, ${claim.validFromSimDay}, ${JSON.stringify(claim)})`;
    }
    const allEvents = this.loadAllEvents();
    for (const entity of deriveObserverEntities(state, allEvents, this.loadEntities())) {
      this.sql`INSERT OR IGNORE INTO history_entities (entity_id, entity_type, started_at_sim_day, entity_json) VALUES (${entity.id}, ${entity.type}, ${entity.startedAtSimDay}, ${JSON.stringify(entity)})`;
    }
  }

  private persistResolutions(decision: AgentDecision | null, resolutions: Array<{ contaminationLog: KnowledgeContaminationEvent; adultSexualAssault: unknown }>): void {
    for (const resolution of resolutions) {
      const log = resolution.contaminationLog;
      this.sql`INSERT OR IGNORE INTO knowledge_contamination_logs (id, agent_id, sim_day, classification, log_json) VALUES (${log.id}, ${log.agentId}, ${log.simulationTime}, ${log.classification}, ${JSON.stringify(log)})`;
      if (resolution.adultSexualAssault) {
        const record = resolution.adultSexualAssault as { consequenceIds: string[] };
        const eventId = record.consequenceIds[0] ?? crypto.randomUUID();
        this.sql`INSERT OR IGNORE INTO adult_assault_events (event_id, event_json) VALUES (${eventId}, ${JSON.stringify(resolution.adultSexualAssault)})`;
      }
    }
    if (!decision) return;
    const sexual = resolutions.some((resolution) => resolution.adultSexualAssault);
    const safeDecision = sexual ? { ...decision, intent: "محاولة اعتداء غير رضائي بين بالغين (تفاصيل محذوفة)", speech: null, motive: "تفاصيل محذوفة من الأرشيف" } : decision;
    const decisionId = crypto.randomUUID();
    this.sql`INSERT INTO decision_ledger (decision_id, tick, character_id, decision_json, runtime_json) VALUES (${decisionId}, ${this.state.tick + 1}, ${decision.characterId}, ${JSON.stringify(safeDecision)}, ${JSON.stringify(this.state.runtime)})`;
  }

  private updateBrainMemories(state: WorldSnapshot, brains: Map<string, AgentBrain>, events: ResolvedEvent[]): void {
    for (const event of events) {
      const experiencedIds = new Set([event.actorId, ...event.targetIds, ...event.witnessIds].filter((value): value is string => Boolean(value)));
      for (const id of experiencedIds) {
        const brain = brains.get(id);
        if (!brain) continue;
        const importance = ["birth", "death", "discovery", "conflict", "sexual_assault", "government"].includes(event.kind) ? 0.8 : 0.45;
        addEventMemory(brain, event, importance, event.kind === "sexual_assault" || event.kind === "death" ? 0.9 : 0.4);
        const term = event.kind === "speech" ? parseNovelTerm(event.text) : null;
        if (term) brain.language[term.word] = { meaning: term.meaning, confidence: id === event.actorId ? 0.7 : 0.35, sourceIds: [event.id] };
      }
    }
  }

  private async maybeReflect(state: WorldSnapshot, actorId: string | null, brains: Map<string, AgentBrain>, events: ResolvedEvent[]): Promise<void> {
    if (!actorId || !events.some((event) => ["birth", "death", "discovery", "conflict", "sexual_assault"].includes(event.kind))) return;
    if (state.characters.find((character) => character.id === actorId)?.lifeStatus !== "alive") return;
    const provider = this.createProvider();
    const brain = brains.get(actorId);
    if (!provider || !brain) return;
    try {
      const reflected = await provider.reflect(brain, events);
      state.usage.calls += 1;
      state.usage.inputTokens += reflected.usage.inputTokens;
      state.usage.outputTokens += reflected.usage.outputTokens;
      brain.memoryIndex.push({ id: crypto.randomUUID(), summary: reflected.reflection.memorySummary, eventIds: events.map((event) => event.id), simDay: state.simDay, importance: 0.7, emotionalImpact: 0.6, tags: ["reflection"] });
      for (const value of reflected.reflection.valueUpdates) if (!brain.values.includes(value)) brain.values.push(value);
      this.persistBrains(new Map([[actorId, brain]]), state.simDay);
    } catch {
      // Reflection is optional and never changes the already-resolved world outcome.
    }
  }

  private async archiveDeceased(state: WorldSnapshot, personId: string, brain: AgentBrain | undefined, latestEvents: ResolvedEvent[]): Promise<void> {
    if (!brain) return;
    const allEvents = [...this.loadAllEvents(), ...latestEvents];
    const snapshot = createHistoricalPersonSnapshot(state, personId, brain, allEvents);
    const coldMemories = compressibleWorkingMemories(brain);
    const bytes = new TextEncoder().encode(JSON.stringify(coldMemories));
    const compressed = await gzip(bytes);
    const checksum = await sha256Hex(compressed);
    const blockId = crypto.randomUUID();
    const key = `seasons/${state.seasonId}/people/${personId}/${blockId}.json.gz`;
    let verifiedAt: number | null = null;
    if (this.env.ARCHIVE) {
      await this.env.ARCHIVE.put(key, compressed, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: { checksum, personId } });
      const head = await this.env.ARCHIVE.head(key);
      if (head && head.customMetadata?.checksum === checksum) verifiedAt = Date.now();
    } else {
      this.sql`INSERT INTO cold_memory_blocks (block_id, person_id, compression, bytes, checksum) VALUES (${blockId}, ${personId}, ${"gzip+base64"}, ${toBase64(compressed)}, ${checksum})`;
      verifiedAt = Date.now();
    }
    if (!verifiedAt) throw new Error("cold_archive_verification_failed");
    const manifest: ArchiveManifest = { id: blockId, seasonId: state.seasonId, objectKey: key, checksum, fromSimDay: coldMemories.at(0)?.simDay ?? 0, toSimDay: coldMemories.at(-1)?.simDay ?? state.simDay, characterIds: [personId], verifiedAt };
    this.sql`INSERT INTO archive_manifests (manifest_id, person_id, manifest_json) VALUES (${manifest.id}, ${personId}, ${JSON.stringify(manifest)})`;
    this.sql`INSERT OR REPLACE INTO historical_people (person_id, archived_at_sim_day, person_json) VALUES (${personId}, ${state.simDay}, ${JSON.stringify(snapshot)})`;
    brain.memoryIndex = snapshot.importantMemories;
  }

  private async maybeCheckpoint(state: WorldSnapshot): Promise<void> {
    const cursor = this.sql<JsonRow>`SELECT value_json FROM archive_cursor WHERE key = ${"checkpoint_day"} LIMIT 1`[0];
    const lastDay = cursor ? Number(JSON.parse(cursor.value_json)) : 0;
    if (Math.floor(state.simDay / 30) <= Math.floor(lastDay / 30)) return;
    const kind = Math.floor(state.simDay / 360) > Math.floor(lastDay / 360) ? "full" : "differential";
    const checkpointId = this.persistCheckpoint(state, kind, `month:${Math.floor(state.simDay / 30)}`);
    if (this.env.ARCHIVE) {
      const characterIds = state.characters.map((person) => person.id);
      await this.archiveWorldJson(state, `checkpoints/${checkpointId}.json.gz`, { checkpointId, kind, runtime: state.runtime, snapshot: state }, lastDay, state.simDay, characterIds);
      const eventPartition = this.loadAllEvents().filter((event) => event.simDay > lastDay && event.simDay <= state.simDay);
      await this.archiveWorldJson(state, `events/month-${Math.floor(state.simDay / 30)}.json.gz`, eventPartition, lastDay, state.simDay, [...new Set(eventPartition.flatMap((event) => [event.actorId, ...event.targetIds].filter((id): id is string => Boolean(id))))]);
    }
    this.sql`INSERT INTO archive_cursor (key, value_json) VALUES (${"checkpoint_day"}, ${JSON.stringify(state.simDay)}) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`;
  }

  private async archiveWorldJson(state: WorldSnapshot, relativeKey: string, payload: unknown, fromSimDay: number, toSimDay: number, characterIds: string[]): Promise<void> {
    if (!this.env.ARCHIVE) return;
    const compressed = await gzip(new TextEncoder().encode(JSON.stringify(payload)));
    const checksum = await sha256Hex(compressed);
    const objectKey = `seasons/${state.seasonId}/${relativeKey}`;
    await this.env.ARCHIVE.put(objectKey, compressed, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: { checksum, engineVersion: state.runtime.engineVersion } });
    const head = await this.env.ARCHIVE.head(objectKey);
    if (!head || head.customMetadata?.checksum !== checksum) throw new Error("world_archive_verification_failed");
    const manifest: ArchiveManifest = { id: crypto.randomUUID(), seasonId: state.seasonId, objectKey, checksum, fromSimDay, toSimDay, characterIds, verifiedAt: Date.now() };
    this.sql`INSERT INTO archive_manifests (manifest_id, person_id, manifest_json) VALUES (${manifest.id}, ${"__world__"}, ${JSON.stringify(manifest)})`;
  }

  private persistCheckpoint(state: WorldSnapshot, kind: string, salt: string): string {
    const checkpointId = `${state.seasonId}:${salt}:${state.tick}`;
    const snapshotJson = JSON.stringify(state);
    const checksum = fastChecksum(snapshotJson);
    this.sql`INSERT OR IGNORE INTO world_checkpoints (checkpoint_id, sim_day, kind, runtime_json, snapshot_json, checksum, created_at) VALUES (${checkpointId}, ${state.simDay}, ${kind}, ${JSON.stringify(state.runtime)}, ${snapshotJson}, ${checksum}, ${Date.now()})`;
    return checkpointId;
  }

  private verifyCheckpoint(checkpointId: string): boolean {
    const row = this.sql<{ snapshot_json: string; checksum: string }>`SELECT snapshot_json, checksum FROM world_checkpoints WHERE checkpoint_id = ${checkpointId} LIMIT 1`[0];
    if (!row || fastChecksum(row.snapshot_json) !== row.checksum) return false;
    try { return Boolean((JSON.parse(row.snapshot_json) as WorldSnapshot).runtime.engineVersion); } catch { return false; }
  }

  private loadAllEvents(): ResolvedEvent[] {
    return this.sql<EventRow>`SELECT sequence, event_json FROM world_events ORDER BY sequence ASC`.map((row) => normalizeResolvedEvent(JSON.parse(row.event_json), row.sequence));
  }
  private loadClaims(): HistoricalClaim[] { return this.sql<ClaimRow>`SELECT claim_json FROM historical_claims ORDER BY valid_from_sim_day ASC`.map((row) => JSON.parse(row.claim_json) as HistoricalClaim); }
  private loadEntities(): HistoryEntity[] { return this.sql<EntityRow>`SELECT entity_json FROM history_entities ORDER BY started_at_sim_day ASC`.map((row) => JSON.parse(row.entity_json) as HistoryEntity); }

  private acquireTickLease(): string | null {
    const token = crypto.randomUUID();
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO world_runtime_locks (lock_name, token, lease_until) VALUES (${"tick"}, ${""}, ${0})`;
    this.sql`UPDATE world_runtime_locks SET token = ${token}, lease_until = ${now + 120_000} WHERE lock_name = ${"tick"} AND lease_until < ${now}`;
    const row = this.sql<{ token: string }>`SELECT token FROM world_runtime_locks WHERE lock_name = ${"tick"} LIMIT 1`[0];
    return row?.token === token ? token : null;
  }

  private releaseTickLease(token: string): void {
    this.sql`UPDATE world_runtime_locks SET lease_until = ${0} WHERE lock_name = ${"tick"} AND token = ${token}`;
  }

  private async ensureSchedule(): Promise<void> {
    const schedules = await this.listSchedules({ type: "interval" });
    if (schedules.length) return;
    await this.scheduleEvery(30, "tick", undefined, { retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4_000 } });
  }

  private async cancelTickSchedules(): Promise<void> {
    const schedules = await this.listSchedules({ type: "interval" });
    await Promise.all(schedules.map((schedule) => this.cancelSchedule(schedule.id)));
  }

  private async publishPublicState(state: WorldSnapshot): Promise<void> {
    const stream = this.env.PublicStreamAgent.getByName(state.seasonId) as DurableObjectStub & { publish(snapshot: ReturnType<typeof toPublicWorldSnapshot>): Promise<void> };
    await stream.publish(toPublicWorldSnapshot(state));
  }

  private async updateSeasonIndex(state: WorldSnapshot): Promise<void> {
    await this.env.DB.prepare("UPDATE seasons SET status = ?, updated_at = ?, population = ?, sim_year = ?, last_event_preview = ? WHERE id = ?")
      .bind(state.status, Date.now(), state.characters.filter((character) => character.lifeStatus === "alive").length, Math.floor(state.simDay / 360) + 1, state.recentEvents[0]?.text ?? null, state.seasonId).run();
  }
}

function stripPrivateCharacter(character: WorldSnapshot["characters"][number]): Omit<WorldSnapshot["characters"][number], "scheduler"> {
  const { scheduler: _scheduler, ...publicCharacter } = character;
  return publicCharacter;
}

function clusterPeople(people: WorldSnapshot["characters"]): Array<{ id: string; x: number; y: number; count: number; personIds: string[] }> {
  const cells = new Map<string, WorldSnapshot["characters"]>();
  for (const person of people) {
    const key = `${person.position.zone}:${Math.floor(person.position.x / 10)}:${Math.floor(person.position.y / 10)}`;
    cells.set(key, [...(cells.get(key) ?? []), person]);
  }
  return [...cells.entries()].map(([id, members]) => ({ id, x: members.reduce((sum, person) => sum + person.position.x, 0) / members.length, y: members.reduce((sum, person) => sum + person.position.y, 0) / members.length, count: members.length, personIds: members.map((person) => person.id) }));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function sha256Hex(bytes: Uint8Array): Promise<string> { const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; return [...new Uint8Array(await crypto.subtle.digest("SHA-256", source))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function toBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fastChecksum(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 120) : "model_provider_failed"; }
function positiveInt(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
function countBy(rows: Array<{ classification: string; count: number }>, key: string): number { return Number(rows.find((row) => row.classification === key)?.count ?? 0); }
function parseNovelTerm(text: string): { word: string; meaning: string } | null { const match = text.match(/(?:نسميه|نسميها|هذي الكلمة)\s+["«]?([^\s"»]{2,24})["»]?(?:\s+(?:يعني|معناها)\s+(.{2,80}))?/u); return match ? { word: match[1], meaning: (match[2] ?? "معنى غير مؤكد").trim() } : null; }
