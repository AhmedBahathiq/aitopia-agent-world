import { Agent, type Connection } from "agents";
import type { PublicWorldSnapshot } from "../../shared/contracts";
import { ENGINE_IDENTITY } from "../../shared/contracts";

const emptyPublicState = (): PublicWorldSnapshot => ({
  seasonId: "", title: "", status: "paused", initialized: false, tick: 0, simDay: 0, speed: 1,
  weather: "clear", temperatureC: 28, characters: [], relationships: [],
  resources: { water: 0, food: 0, wood: 0, fibers: 0, shelter: 0 },
  runtime: { ...ENGINE_IDENTITY }, initialExpectedCapacity: 24, recentEvents: [], livingPopulation: 0, deceasedPopulation: 0,
});

export class PublicStreamAgent extends Agent<Env, PublicWorldSnapshot> {
  initialState = emptyPublicState();

  validateStateChange(_nextState: PublicWorldSnapshot, source: Connection | "server"): void {
    if (source !== "server") throw new Error("public_connections_are_read_only");
  }

  shouldConnectionBeReadonly(): boolean { return true; }

  publish(snapshot: PublicWorldSnapshot): void {
    this.setState(snapshot);
  }
}
