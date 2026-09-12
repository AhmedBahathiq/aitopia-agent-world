import { z } from "zod";
import { toPublicWorldSnapshot, type ApiEnvelope, type Intervention, type ResolvedEvent, type SeasonConfig, type SeasonSummary, type WorldSnapshot } from "../../shared/contracts";
import { WorldAgent } from "./world-agent";

export { WorldAgent };

type RateLimiter = { limit(input: { key: string }): Promise<{ success: boolean }> };
type WorkerEnv = Env & {
  ADMIN_BRIDGE_SECRET?: string;
  OPENAI_API_KEY?: string;
  PUBLIC_RATE_LIMITER?: RateLimiter;
  ADMIN_RATE_LIMITER?: RateLimiter;
};
type WorldStub = DurableObjectStub & {
  initialize(config: SeasonConfig): Promise<WorldSnapshot>;
  getSnapshot(): Promise<WorldSnapshot>;
  getEvents(cursor?: number, limit?: number): Promise<{ events: ResolvedEvent[]; nextCursor: number }>;
  pause(): Promise<WorldSnapshot>;
  resume(): Promise<WorldSnapshot>;
  setSpeed(speed: 0.25 | 1 | 4 | 16): Promise<WorldSnapshot>;
  setBudget(maxCalls: number, maxTokens: number): Promise<WorldSnapshot>;
  intervene(input: Intervention): Promise<WorldSnapshot>;
  archive(): Promise<WorldSnapshot>;
  requestDestroy(): Promise<void>;
};

const characterSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sex: z.enum(["male", "female"]),
  ageYears: z.number().int().min(18).max(75),
  traits: z.array(z.string().trim().min(1).max(32)).min(1).max(5),
  skills: z.array(z.string().trim().min(1).max(32)).min(1).max(5),
});

const seasonSchema = z.object({
  title: z.string().trim().min(1).max(80),
  seed: z.string().trim().min(1).max(80),
  populationCap: z.number().int().min(3).max(80).default(24),
  speed: z.union([z.literal(0.25), z.literal(1), z.literal(4), z.literal(16)]).default(1),
  initialCharacters: z.array(characterSchema).min(2).max(8),
});

const interventionSchema = z.object({
  type: z.enum(["resource", "weather", "event"]),
  resource: z.enum(["water", "food", "wood", "medicine"]).optional(),
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
      const match = url.pathname.match(/^\/api\/seasons\/([^/]+)(?:\/(snapshot|events|pause|resume|speed|budget|interventions|archive|delete))?$/);
      if (request.method === "GET") await enforceRateLimit(request, env.PUBLIC_RATE_LIMITER, `public:${url.pathname.split("/").slice(0, 5).join("/")}`);
      if (url.pathname === "/api/health" && request.method === "GET") return cors(json({ ok: true, data: { service: "agent-world", time: Date.now() } }), request, env);
      if (url.pathname === "/api/seasons" && request.method === "GET") return cors(await listSeasons(env), request, env);
      if (url.pathname === "/api/seasons" && request.method === "POST") {
        const body = await signedJson(request, env);
        const config = seasonSchema.parse(body);
        return cors(await createSeason(config, env), request, env);
      }
      if (!match) return cors(json({ ok: false, error: "not_found" }, 404), request, env);

      const seasonId = decodeURIComponent(match[1]);
      const action = match[2] ?? "snapshot";
      const exists = await env.DB.prepare("SELECT id FROM seasons WHERE id = ?").bind(seasonId).first();
      if (!exists) return cors(json({ ok: false, error: "season_not_found" }, 404), request, env);
      const stub = getStub(env, seasonId);

      if (action === "snapshot" && request.method === "GET") return cors(json({ ok: true, data: toPublicWorldSnapshot(await stub.getSnapshot()) }), request, env);
      if (action === "events" && request.method === "GET") {
        const cursor = finiteInt(url.searchParams.get("cursor"), 0);
        const limit = finiteInt(url.searchParams.get("limit"), 80);
        const result = await stub.getEvents(cursor, limit);
        return cors(json({ ok: true, data: { ...result, events: result.events.filter((event) => event.public) } }), request, env);
      }

      const body = await signedJson(request, env);
      if (action === "delete" && request.method === "POST") {
        await stub.requestDestroy();
        await env.DB.prepare("DELETE FROM seasons WHERE id = ?").bind(seasonId).run();
        return cors(json({ ok: true, data: { seasonId, deleted: true } }), request, env);
      }
      let snapshot: WorldSnapshot;
      if (action === "pause" && request.method === "POST") snapshot = await stub.pause();
      else if (action === "resume" && request.method === "POST") snapshot = await stub.resume();
      else if (action === "archive" && request.method === "POST") snapshot = await stub.archive();
      else if (action === "speed" && request.method === "POST") snapshot = await stub.setSpeed(z.union([z.literal(0.25), z.literal(1), z.literal(4), z.literal(16)]).parse((body as { speed?: unknown }).speed));
      else if (action === "budget" && request.method === "POST") {
        const budget = z.object({ maxCalls: z.number().int().positive(), maxTokens: z.number().int().min(1_000) }).parse(body);
        snapshot = await stub.setBudget(budget.maxCalls, budget.maxTokens);
      } else if (action === "interventions" && request.method === "POST") snapshot = await stub.intervene(interventionSchema.parse(body));
      else return cors(json({ ok: false, error: "method_not_allowed" }, 405), request, env);

      await updateSeasonIndex(env, snapshot);
      return cors(json({ ok: true, data: snapshot }), request, env);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof AuthError ? 401 : error instanceof z.ZodError ? 400 : 500;
      return cors(json({ ok: false, error: publicError(error) }, status), request, env);
    }
  },
} satisfies ExportedHandler<WorkerEnv>;

async function listSeasons(env: WorkerEnv): Promise<Response> {
  const result = await env.DB.prepare(`SELECT id, title, status, created_at, updated_at, population, sim_year, last_event_preview
    FROM seasons ORDER BY updated_at DESC LIMIT 100`).all();
  const seasons: SeasonSummary[] = result.results.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: row.status as SeasonSummary["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    population: Number(row.population),
    simYear: Number(row.sim_year),
    lastEventPreview: row.last_event_preview === null ? null : String(row.last_event_preview),
  }));
  return json({ ok: true, data: seasons });
}

async function createSeason(input: Omit<SeasonConfig, "id">, env: WorkerEnv): Promise<Response> {
  const id = crypto.randomUUID();
  const config: SeasonConfig = { ...input, id };
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO seasons (id, title, status, seed, created_at, updated_at, population, sim_year, last_event_preview)
    VALUES (?, ?, 'paused', ?, ?, ?, ?, 1, ?)`)
    .bind(id, config.title, config.seed, now, now, config.initialCharacters.length, "العالم جاهز للبدء").run();
  try {
    const snapshot = await getStub(env, id).initialize(config);
    return json({ ok: true, data: snapshot }, 201);
  } catch (error) {
    await env.DB.prepare("DELETE FROM seasons WHERE id = ?").bind(id).run();
    throw error;
  }
}

async function updateSeasonIndex(env: WorkerEnv, snapshot: WorldSnapshot): Promise<void> {
  const preview = snapshot.recentEvents[0]?.text ?? null;
  await env.DB.prepare(`UPDATE seasons SET status = ?, updated_at = ?, population = ?, sim_year = ?, last_event_preview = ? WHERE id = ?`)
    .bind(snapshot.status, Date.now(), snapshot.characters.filter((character) => character.alive).length, Math.floor(snapshot.simDay / 360) + 1, preview, snapshot.seasonId).run();
}

function getStub(env: WorkerEnv, id: string): WorldStub {
  return env.WorldAgent.getByName(id) as unknown as WorldStub;
}

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
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "request_body_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function enforceRateLimit(request: Request, limiter: RateLimiter | undefined, bucket: string): Promise<void> {
  if (!limiter) return;
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${bucket}:${source}` });
  if (!success) throw new HttpError(429, "rate_limit_exceeded");
}

function fromHex(input: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(input)) return new Uint8Array();
  return Uint8Array.from(input.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

class AuthError extends Error {}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function finiteInt(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function publicError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join(", ");
  if (error instanceof AuthError) return error.message;
  if (error instanceof HttpError) return error.message;
  return error instanceof SyntaxError ? "invalid_json" : "internal_error";
}

function json<T>(body: ApiEnvelope<T>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });
}

function cors(response: Response, request: Request, env: WorkerEnv): Response {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGIN.split(",").map((item) => item.trim());
  if (origin && allowed.includes(origin)) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}
