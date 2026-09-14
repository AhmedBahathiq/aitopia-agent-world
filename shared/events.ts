import type { CharacterState, ResolvedEvent, WorldSnapshot } from "./contracts";
import { deterministicId } from "./random";

export function createResolvedEvent(
  world: WorldSnapshot,
  kind: ResolvedEvent["kind"],
  actor: CharacterState | null,
  text: string,
  omniscientDetail: string,
  options: {
    targetIds?: string[];
    witnessIds?: string[];
    socialDetail?: string | null;
    public?: boolean;
    publicationState?: ResolvedEvent["publicationState"];
    causalParentIds?: string[];
    now?: number;
    salt?: string;
  } = {},
): ResolvedEvent {
  const targetIds = options.targetIds ?? [];
  const witnessIds = options.witnessIds ?? [];
  const sequenceSalt = options.salt ?? `${kind}:${actor?.id ?? "world"}:${world.recentEvents.length}:${targetIds.join(",")}`;
  return {
    id: deterministicId("event", world.seed, world.tick, sequenceSalt),
    schemaVersion: world.runtime.eventSchemaVersion,
    engineVersion: world.runtime.engineVersion,
    tick: world.tick,
    simDay: world.simDay,
    createdAt: options.now ?? Date.now(),
    kind,
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? "العالم",
    targetIds,
    text: clean(text, 280),
    omniscientDetail: clean(omniscientDetail, 320),
    socialDetail: options.socialDetail === undefined ? (witnessIds.length ? clean(omniscientDetail, 320) : null) : options.socialDetail,
    witnessIds: [...new Set(witnessIds)],
    public: options.public ?? true,
    publicationState: options.publicationState ?? "published",
    causalParentIds: options.causalParentIds ?? [],
  };
}

function clean(value: string, max: number): string { return value.replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, max); }

/**
 * Converts persisted event payloads to the current read model without rewriting
 * history. V1 events remain labelled as V1 and therefore replay under their
 * original semantics; this adapter only supplies fields introduced by V2.
 */
export function normalizeResolvedEvent(raw: unknown, sequence?: number): ResolvedEvent {
  const value = isRecord(raw) ? raw : {};
  const targetIds = Array.isArray(value.targetIds)
    ? value.targetIds.filter((item): item is string => typeof item === "string")
    : typeof value.targetId === "string" && value.targetId ? [value.targetId] : [];
  const witnessIds = Array.isArray(value.witnessIds)
    ? value.witnessIds.filter((item): item is string => typeof item === "string")
    : [];
  const publicValue = value.public !== false;
  const detail = typeof value.omniscientDetail === "string"
    ? value.omniscientDetail
    : typeof value.detail === "string" ? value.detail : typeof value.text === "string" ? value.text : "";
  const socialDetail = value.socialDetail === null
    ? null
    : typeof value.socialDetail === "string" ? value.socialDetail : publicValue ? detail : null;
  return {
    id: typeof value.id === "string" ? value.id : `legacy-event-${sequence ?? 0}`,
    sequence,
    schemaVersion: finiteInteger(value.schemaVersion, 1),
    engineVersion: typeof value.engineVersion === "string" ? value.engineVersion : "1.x-legacy",
    tick: finiteNumber(value.tick, 0),
    simDay: finiteNumber(value.simDay, 0),
    createdAt: finiteNumber(value.createdAt, 0),
    kind: isEventKind(value.kind) ? value.kind : "system",
    actorId: typeof value.actorId === "string" ? value.actorId : null,
    actorName: typeof value.actorName === "string" ? value.actorName : "العالم",
    targetIds,
    text: clean(typeof value.text === "string" ? value.text : "حدث تاريخي", 280),
    omniscientDetail: clean(detail, 320),
    socialDetail: socialDetail === null ? null : clean(socialDetail, 320),
    witnessIds,
    public: publicValue,
    publicationState: value.publicationState === "redacted" || value.publicationState === "safe_summary" ? value.publicationState : "published",
    causalParentIds: Array.isArray(value.causalParentIds) ? value.causalParentIds.filter((item): item is string => typeof item === "string") : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function finiteInteger(value: unknown, fallback: number): number { const result = finiteNumber(value, fallback); return Number.isInteger(result) ? result : fallback; }
function isEventKind(value: unknown): value is ResolvedEvent["kind"] {
  return typeof value === "string" && [
    "speech", "action", "environment", "relationship", "birth", "death", "conflict", "discovery",
    "intervention", "system", "migration_record", "sexual_assault", "government", "war", "migration",
    "settlement", "language", "teaching", "rumor",
  ].includes(value);
}
