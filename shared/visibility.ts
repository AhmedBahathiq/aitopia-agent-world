import type { CharacterState, ResolvedEvent, WorldSnapshot } from "./contracts";

export function observedEventsFor(world: WorldSnapshot, actor: CharacterState, limit = 16): ResolvedEvent[] {
  const visibleIds = new Set(world.characters.filter((person) => person.alive && person.position.zone === actor.position.zone).map((person) => person.id));
  return world.recentEvents.filter((event) => event.public && (
    event.actorId === actor.id ||
    event.targetId === actor.id ||
    event.actorId === null ||
    (event.actorId !== null && visibleIds.has(event.actorId))
  )).slice(0, limit);
}
