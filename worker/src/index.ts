import { routeAgentRequest } from "agents";
import { z } from "zod";
import type {
  ApiEnvelope,
  EngineMigration,
  HistoryEntity,
  HistoryEntityType,
  HistoryView,
  Intervention,
  PublicWorldSnapshot,
  ResolvedEvent,
  SeasonConfig,
  SeasonRuntimeIdentity,
  SeasonSummary,
  WorldSnapshot,
} from "../../shared/contracts";
import { DEFAULT_CHARACTERS } from "../../shared/simulation";
import { PublicStreamAgent } from "./public-stream-agent";
import { WorldAgent } from "./world-agent";

export { PublicStreamAgent, WorldAgent };

type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
type WorkerEnv = Env & { ADMIN_BRIDGE_SECRET?: string; OPENAI_API_KEY?: string; PUBLIC_RATE_LIMITER?: RateLimiter; ADMIN_RATE_LIMITER?: RateLimiter };
type WorldStub = {
  initialize(config: SeasonConfig): Promise<WorldSnapshot>;
  getSnapshot(): Promise<WorldSnapshot>;
  getPublicSnapshot(view?: HistoryView): Promise<PublicWorldSnapshot>;
  getEvents(cursor?: number, limit?: number, view?: HistoryView): Promise<{ events: ResolvedEvent[]; nextCursor: number }>;
  getCharacter(personId: string, view: HistoryView, asOfDay?: number): Promise<unknown>;
  getAnalytics(includePrivate?: boolean): Promise<unknown>;
  getDiscoveries(): Promise<unknown>;
  getHistoryTimeline(view: HistoryView, atDay?: number, asOfDay?: number): Promise<unknown>;
  getDeceased(): Promise<unknown>;
  getHistoricalPerson(personId: string, view: HistoryView, asOfDay?: number): Promise<unknown>;
  getFamilyTree(rootId?: string): Promise<unknown>;
  getHistoryEntities(type?: HistoryEntityType, atDay?: number): Promise<HistoryEntity[]>;
  getImpactRanking(): Promise<unknown>;
  getReplay(atDay: number, view: HistoryView, asOfDay?: number): Promise<unknown>;
  getMap(bbox?: [number, number, number, number], cursor?: number, limit?: number): Promise<unknown>;
  pause(): Promise<WorldSnapshot>;
  resume(): Promise<WorldSnapshot>;
  setSpeed(speed: 0.25 | 1 | 4 | 16): Promise<WorldSnapshot>;
  intervene(input: Intervention): Promise<WorldSnapshot>;
  archive(): Promise<WorldSnapshot>;
  migrateRuntime(to: SeasonRuntimeIdentity, reason: string): Promise<EngineMigration>;
  requestDestroy(): Promise<void>;
};

const founderSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sex: z.enum(["male", "female"]),
  ageYears: z.number().min(18).max(75),
  traits: z.array(z.string().trim().min(1).max(32)).min(1).max(5),
  aptitudes: z.array(z.string().trim().min(1).max(32)).min(1).max(5),
});

const seasonSchema = z.object({
  title: z.string().trim().min(1).max(80),
  seed: z.string().trim().min(1).max(80),
  speed: z.union([z.literal(0.25), z.literal(1), z.literal(4), z.literal(16)]).default(1),
  initialCharacters: z.tuple([founderSchema, founderSchema, founderSchema]),
  initialExpectedCapacity: z.number().int().positive().max(100_000).optional(),
}).superRefine((value, context) => {
  const expected = [{ name: "سالم", sex: "male" }, { name: "نورة", sex: "female" }, { name: "ريم", sex: "female" }] as const;
  expected.forEach((person, index) => {
    if (value.initialCharacters[index].name !== person.name || value.initialCharacters[index].sex !== person.sex) context.addIssue({ code: "custom", message: "exact_founders_required", path: ["initialCharacters", index] });
  });
});

const interventionSchema = z.object({
  type: z.enum(["resource", "weather", "event"]),
  resource: z.enum(["water", "food", "wood", "fibers", "shelter"]).optional(),
  amount: z.number().min(-10_000).max(10_000).optional(),
  weather: z.enum(["clear", "cloudy", "rain", "storm"]).optional(),
  description: z.string().trim().min(3).max(240),
}).superRefine((value, context) => {
  if (value.type === "resource" && (value.resource === undefined || value.amount === undefined)) context.addIssue({ code: "custom", message: "resource_and_amount_required" });
  if (value.type === "weather" && !value.weather) context.addIssue({ code: "custom", message: "weather_required" });
});

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), request, env);
    try {
      if (url.pathname.startsWith("/agents/public-stream-agent/")) {
        const response = await routeAgentRequest(request, env);
        return response ?? cors(json({ ok: false, error: "stream_not_found" }, 404), request, env);
      }
      if (url.pathname.startsWith("/agents/")) return cors(json({ ok: false, error: "agent_route_not_public" }, 404), request, env);
      if (request.method === "GET") await enforceRateLimit(request, env.PUBLIC_RATE_LIMITER, `public:${url.pathname.split("/").slice(0, 6).join("/")}`);
      if (url.pathname === "/api/health" && request.method === "GET") return cors(json({ ok: true, data: { service: "agent-world-v2", time: Date.now(), engineVersion: "2.0.0" } }), request, env);
      if (url.pathname === "/api/seasons" && request.method === "GET") return cors(await listSeasons(env), request, env);
      if (url.pathname === "/api/seasons" && request.method === "POST") {
        const input = seasonSchema.parse(await signedJson(request, env));
        return cors(await createSeason(input, env), request, env);
      }

      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments[0] !== "api" || segments[1] !== "seasons" || !segments[2]) return cors(json({ ok: false, error: "not_found" }, 404), request, env);
      const seasonId = segments[2];
      const exists = await env.DB.prepare("SELECT id FROM seasons WHERE id = ?").bind(seasonId).first();
      if (!exists) return cors(json({ ok: false, error: "season_not_found" }, 404), request, env);
      const stub = getStub(env, seasonId);
      const view = parseView(url.searchParams.get("view"));

      if (request.method === "GET") {
        if (segments.length === 3 || segments[3] === "snapshot") return cors(json({ ok: true, data: await stub.getPublicSnapshot(view) }), request, env);
        if (segments[3] === "events") return cors(json({ ok: true, data: await stub.getEvents(intParam(url, "cursor", 0), intParam(url, "limit", 80), view) }), request, env);
        if (segments[3] === "characters" && segments[4]) return cors(json({ ok: true, data: await stub.getCharacter(segments[4], view, optionalNumber(url, "asOfDay")) }), request, env);
        if (segments[3] === "analytics") return cors(json({ ok: true, data: await stub.getAnalytics() }), request, env);
        if (segments[3] === "discoveries") return cors(json({ ok: true, data: await stub.getDiscoveries() }), request, env);
        if (segments[3] === "history" && segments[4] === "timeline") return cors(json({ ok: true, data: await stub.getHistoryTimeline(view, optionalNumber(url, "atDay"), optionalNumber(url, "asOfDay")) }), request, env);
        if (segments[3] === "history" && segments[4] === "deceased") return cors(json({ ok: true, data: await stub.getDeceased() }), request, env);
        if (segments[3] === "history" && segments[4] === "people" && segments[5]) return cors(json({ ok: true, data: await stub.getHistoricalPerson(segments[5], view, optionalNumber(url, "asOfDay")) }), request, env);
        if (segments[3] === "history" && segments[4] === "family-tree") return cors(json({ ok: true, data: await stub.getFamilyTree(url.searchParams.get("root") ?? undefined) }), request, env);
        if (segments[3] === "history" && segments[4] === "entities") return cors(json({ ok: true, data: await stub.getHistoryEntities(parseEntityType(url.searchParams.get("type")), optionalNumber(url, "atDay")) }), request, env);
        if (segments[3] === "history" && segments[4] === "impact-ranking") return cors(json({ ok: true, data: await stub.getImpactRanking() }), request, env);
        if (segments[3] === "replay") return cors(json({ ok: true, data: await stub.getReplay(requiredNumber(url, "atDay"), view, optionalNumber(url, "asOfDay")) }), request, env);
        if (segments[3] === "map") return cors(json({ ok: true, data: await stub.getMap(parseBbox(url.searchParams.get("bbox")), intParam(url, "cursor", 0), intParam(url, "limit", 200)) }), request, env);
      }

      if (request.method !== "POST") return cors(json({ ok: false, error: "method_not_allowed" }, 405), request, env);
      const body = await signedJson(request, env);
      if (segments[3] === "private" && segments[4] === "diagnostics") return cors(json({ ok: true, data: await stub.getAnalytics(true) }), request, env);
      if (segments[3] === "delete") {
        await stub.requestDestroy();
        await env.DB.prepare("DELETE FROM seasons WHERE id = ?").bind(seasonId).run();
        return cors(json({ ok: true, data: { seasonId, deleted: true } }), request, env);
      }
      let snapshot: WorldSnapshot;
      if (segments[3] === "pause") snapshot = await stub.pause();
      else if (segments[3] === "resume") snapshot = await stub.resume();
      else if (segments[3] === "archive") snapshot = await stub.archive();
      else if (segments[3] === "speed") snapshot = await stub.setSpeed(z.union([z.literal(0.25), z.literal(1), z.literal(4), z.literal(16)]).parse((body as { speed?: unknown }).speed));
      else if (segments[3] === "interventions") snapshot = await stub.intervene(interventionSchema.parse(body));
      else if (segments[3] === "migrate") {
        const input = z.object({ to: runtimeSchema, reason: z.string().min(3).max(240) }).parse(body);
        return cors(json({ ok: true, data: await stub.migrateRuntime(input.to, input.reason) }), request, env);
      } else return cors(json({ ok: false, error: "not_found" }, 404), request, env);
      await updateSeasonIndex(env, snapshot);
      return cors(json({ ok: true, data: snapshot }), request, env);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", route: url.pathname, error: error instanceof Error ? error.message : "unknown_error" }));
      const status = error instanceof HttpError ? error.status : error instanceof AuthError ? 401 : error instanceof z.ZodError ? 400 : 500;
      return cors(json({ ok: false, error: publicError(error) }, status), request, env);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

const runtimeSchema = z.object({
  engineVersion: z.string().min(1).max(40), worldSchemaVersion: z.number().int().positive(), eventSchemaVersion: z.number().int().positive(),
  resolverVersion: z.string().min(1).max(80), cognitivePolicyVersion: z.string().min(1).max(80), rngVersion: z.string().min(1).max(80), modelConfigVersion: z.string().min(1).max(80),
});

async function listSeasons(env: WorkerEnv): Promise<Response> {
  const result = await env.DB.prepare("SELECT id, title, status, created_at, updated_at, population, sim_year, last_event_preview FROM seasons ORDER BY updated_at DESC LIMIT 100").all();
  const seasons: SeasonSummary[] = result.results.map((row) => ({ id: String(row.id), title: String(row.title), status: row.status as SeasonSummary["status"], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), population: Number(row.population), simYear: Number(row.sim_year), lastEventPreview: row.last_event_preview === null ? null : String(row.last_event_preview) }));
  return json({ ok: true, data: seasons });
}

async function createSeason(input: Omit<SeasonConfig, "id">, env: WorkerEnv): Promise<Response> {
  const id = crypto.randomUUID();
  const config: SeasonConfig = { ...input, id };
  const now = Date.now();
  await env.DB.prepare("INSERT INTO seasons (id, title, status, seed, created_at, updated_at, population, sim_year, last_event_preview) VALUES (?, ?, 'paused', ?, ?, ?, 3, 1, ?)")
    .bind(id, config.title, config.seed, now, now, "العالم V2 جاهز للبدء").run();
  try { return json({ ok: true, data: await getStub(env, id).initialize(config) }, 201); }
  catch (error) { await env.DB.prepare("DELETE FROM seasons WHERE id = ?").bind(id).run(); throw error; }
}

async function updateSeasonIndex(env: WorkerEnv, snapshot: WorldSnapshot): Promise<void> {
  await env.DB.prepare("UPDATE seasons SET status = ?, updated_at = ?, population = ?, sim_year = ?, last_event_preview = ? WHERE id = ?")
    .bind(snapshot.status, Date.now(), snapshot.characters.filter((character) => character.lifeStatus === "alive").length, Math.floor(snapshot.simDay / 360) + 1, snapshot.recentEvents[0]?.text ?? null, snapshot.seasonId).run();
}

function getStub(env: WorkerEnv, id: string): WorldStub { return env.WorldAgent.getByName(id) as unknown as WorldStub; }

async function signedJson(request: Request, env: WorkerEnv): Promise<unknown> {
  if (!env.ADMIN_BRIDGE_SECRET) throw new AuthError("admin_secret_not_configured");
  await enforceRateLimit(request, env.ADMIN_RATE_LIMITER, "admin");
  const timestamp = request.headers.get("x-admin-timestamp") ?? "";
  const signature = request.headers.get("x-admin-signature") ?? "";
  const nonce = request.headers.get("x-admin-nonce") ?? "";
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) throw new AuthError("stale_admin_request");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) throw new AuthError("invalid_admin_nonce");
  const raw = await readBoundedBody(request, 64 * 1024);
  const payload = `${timestamp}.${nonce}.${request.method}.${new URL(request.url).pathname}.${raw}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_BRIDGE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const provided = fromHex(signature.startsWith("v1=") ? signature.slice(3) : signature);
  if (!constantTimeEqual(expected, provided)) throw new AuthError("invalid_admin_signature");
  await env.DB.prepare("DELETE FROM admin_request_nonces WHERE used_at < ?").bind(Date.now() - 10 * 60_000).run();
  const accepted = await env.DB.prepare("INSERT OR IGNORE INTO admin_request_nonces (nonce, used_at) VALUES (?, ?)").bind(nonce, Date.now()).run();
  if (accepted.meta.changes !== 1) throw new AuthError("replayed_admin_request");
  return raw ? JSON.parse(raw) : {};
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "request_body_too_large");
  if (!request.body) return "";
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxBytes) { await reader.cancel(); throw new HttpError(413, "request_body_too_large"); } chunks.push(value); }
  const merged = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function enforceRateLimit(request: Request, limiter: RateLimiter | undefined, bucket: string): Promise<void> { if (!limiter) return; const source = request.headers.get("cf-connecting-ip") ?? "unknown"; const { success } = await limiter.limit({ key: `${bucket}:${source}` }); if (!success) throw new HttpError(429, "rate_limit_exceeded"); }
function parseView(value: string | null): HistoryView { return value === "omniscient" ? "omniscient" : "social"; }
function parseEntityType(value: string | null): HistoryEntityType | undefined { const allowed: HistoryEntityType[] = ["civilization", "group", "government", "ruler", "war", "discovery", "migration", "settlement", "language"]; return allowed.includes(value as HistoryEntityType) ? value as HistoryEntityType : undefined; }
function parseBbox(value: string | null): [number, number, number, number] | undefined { if (!value) return undefined; const values = value.split(",").map(Number); if (values.length !== 4 || values.some((item) => !Number.isFinite(item))) throw new HttpError(400, "invalid_bbox"); return values as [number, number, number, number]; }
function intParam(url: URL, key: string, fallback: number): number { const raw = url.searchParams.get(key); if (raw === null || raw.trim() === "") return fallback; const value = Number(raw); return Number.isFinite(value) ? Math.floor(value) : fallback; }
function optionalNumber(url: URL, key: string): number | undefined { const raw = url.searchParams.get(key); if (raw === null) return undefined; const value = Number(raw); if (!Number.isFinite(value)) throw new HttpError(400, `invalid_${key}`); return value; }
function requiredNumber(url: URL, key: string): number { const value = optionalNumber(url, key); if (value === undefined) throw new HttpError(400, `${key}_required`); return value; }
function fromHex(input: string): Uint8Array { if (!/^[0-9a-f]{64}$/i.test(input)) return new Uint8Array(); return Uint8Array.from(input.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)); }
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; let mismatch = 0; for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index]; return mismatch === 0; }
class AuthError extends Error {}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function publicError(error: unknown): string { if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join(", "); if (error instanceof AuthError || error instanceof HttpError) return error.message; return error instanceof SyntaxError ? "invalid_json" : "internal_error"; }
function json<T>(body: ApiEnvelope<T>, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } }); }
function cors(response: Response, request: Request, env: WorkerEnv): Response { const origin = request.headers.get("Origin"); const allowed = String(env.ALLOWED_ORIGIN ?? "").split(",").map((item) => item.trim()); if (origin && allowed.includes(origin)) response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin"); response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.headers.set("Access-Control-Allow-Headers", "Content-Type, x-admin-timestamp, x-admin-signature, x-admin-nonce"); return response; }

export const DEFAULT_V2_SEASON_INPUT: Omit<SeasonConfig, "id"> = { title: "محاكاة الجزيرة", seed: "agent-world-v2", speed: 1, initialCharacters: DEFAULT_CHARACTERS, initialExpectedCapacity: 24 };
