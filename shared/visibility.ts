import type { CharacterState, Position, ResolvedEvent, WorldSnapshot } from "./contracts";

const ZONE_EDGES: Record<string, string[]> = {
  beach: ["forest", "grassland"],
  spring: ["forest", "camp"],
  forest: ["beach", "spring", "camp"],
  grassland: ["beach", "camp", "ridge"],
  camp: ["spring", "forest", "grassland", "ridge"],
  ridge: ["grassland", "camp"],
};

export function distanceBetween(a: Position, b: Position): number {
  if (a.zone !== b.zone && !ZONE_EDGES[a.zone]?.includes(b.zone)) return 100;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const base = Math.sqrt(dx * dx + dy * dy);
  return a.zone === b.zone ? base : base + 24;
}

export function perceptionRadius(world: WorldSnapshot, actor: CharacterState): number {
  const weatherPenalty = world.weather === "storm" ? 0.45 : world.weather === "rain" ? 0.72 : world.weather === "cloudy" ? 0.9 : 1;
  const healthPenalty = actor.health < 30 ? 0.7 : 1;
  return 24 * weatherPenalty * healthPenalty;
}

export function hearingRadius(world: WorldSnapshot): number {
  return world.weather === "storm" ? 7 : world.weather === "rain" ? 12 : 18;
}

export function perceivedPeopleFor(world: WorldSnapshot, actor: CharacterState): Array<{ character: CharacterState; distance: number }> {
  const radius = perceptionRadius(world, actor);
  return world.characters
    .filter((person) => person.lifeStatus === "alive" && person.id !== actor.id)
    .map((character) => ({ character, distance: distanceBetween(actor.position, character.position) }))
    .filter(({ distance }) => distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

export function witnessIdsFor(world: WorldSnapshot, position: Position, excludedIds: string[] = []): string[] {
  const excluded = new Set(excludedIds);
  const pseudoActor: Pick<CharacterState, "position" | "health"> = { position, health: 100 };
  const radius = perceptionRadius(world, pseudoActor as CharacterState);
  return world.characters
    .filter((person) => person.lifeStatus === "alive" && !excluded.has(person.id) && distanceBetween(position, person.position) <= radius)
    .map((person) => person.id);
}

export function observedEventsFor(world: WorldSnapshot, actor: CharacterState, limit = 16): ResolvedEvent[] {
  const visible = new Set(perceivedPeopleFor(world, actor).map(({ character }) => character.id));
  return world.recentEvents.filter((event) =>
    event.actorId === actor.id ||
    event.targetIds.includes(actor.id) ||
    event.witnessIds.includes(actor.id) ||
    (event.kind === "speech" && event.actorId !== null && visible.has(event.actorId) && distanceToActor(world, actor, event.actorId) <= hearingRadius(world)) ||
    (event.actorId === null && event.kind === "environment"),
  ).slice(0, limit);
}

function distanceToActor(world: WorldSnapshot, observer: CharacterState, actorId: string): number {
  const actor = world.characters.find((character) => character.id === actorId);
  return actor ? distanceBetween(observer.position, actor.position) : 100;
}
