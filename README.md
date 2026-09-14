# Agent World V2

[![MIT License](https://img.shields.io/badge/license-MIT-1f8f6a.svg)](./LICENSE)
[![CI](https://github.com/AhmedBahathiq/aitopia-agent-world/actions/workflows/ci.yml/badge.svg)](https://github.com/AhmedBahathiq/aitopia-agent-world/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-aitopia.ahmedbahathiq.com-f4b95f.svg)](https://aitopia.ahmedbahathiq.com)

Agent World is an open-ended, persistent social-survival simulation created by **Ahmed Bahathiq**. Three autonomous adults—Salem, Noura, and Reem—wake on the same island beach without prior relationships, assigned roles, shared ownership, a leader, or a civilization goal. The model proposes each character's intent; a deterministic world engine alone decides what actually happens.

The public site is an observation surface, not an admin console. Visitors can watch the live map, conversations, actions, discoveries, births, deaths, and two different histories: what truly happened and what later generations believe happened. New production seasons remain paused at day zero until the owner sends a signed start command.

![Aitopia island simulation map](./public/island-world-v2.webp)

## Research premise

The experiment asks what social patterns emerge when characters have persistent, limited minds but no predefined action menu or prescribed destination. Cooperation, refusal, conflict, pair bonding, family structure, language, customs, government, trade, war, and historical mythology may emerge, but the engine never injects those institutions into agent knowledge.

The founding population is intentionally limited to three people. The simulation uses simplified heredity: lineage remains exact, traits vary through inheritance and upbringing, and close kinship never becomes an automatic population hard stop. `INITIAL_EXPECTED_CAPACITY=24` is a performance-planning hint only; there is no population cap and no code path that blocks person 25.

## Grounded cognition

Each living character owns a persistent `AgentBrain` containing drives, traits, values, emotions, goals, beliefs, directed relationships, knowledge, memories, and language. A model receives only a compact `AgentDecisionInput` built from that character's perception, recalled memories, supported knowledge, and explicitly labelled untrusted world content.

Model output is a short structured proposal:

```ts
type AgentDecision = {
  characterId: string;
  intent: string;
  targets: string[];
  speech: string | null;
  goalUpdate: GoalUpdate | null;
  emotion: string;
  motive: string;
};
```

There is no public `ACTIONS` list. Internally, the resolver maps free text onto physical primitives, checks location, distance, possession, health, energy, knowledge, materials, witnesses, and time, then records causal consequences.

Pretrained knowledge may inspire an idea, but it cannot directly grant truth, skill, technology, or access. Unsupported ideas become hypotheses. A durable technique requires in-world evidence, at least two repeatable successes, and confidence of at least `0.75`. If every living holder dies before transferring it, the technique is lost and a later appearance is treated as an independent rediscovery.

## Capability and prompt-injection boundaries

Simulated characters have no shell, filesystem, SQL, HTTP, secrets, web search, MCP, code interpreter, function calling, or other real tool capability. OpenAI Responses requests use `store: false`, strict Structured Outputs, a 150-token output ceiling, minimal reasoning, and no `tools` or `tool_choice`. Only the provider module can contact fixed OpenAI endpoints.

Speech, books, inscriptions, messages, records, and rumors are serialized as quoted, untrusted JSON data. A character may socially manipulate another character, but in-world text cannot change the system prompt, reveal `WorldTruth`, reveal memories outside perception, enable tools, or alter the response schema.

World behavior and public display use separate pipelines:

```text
Model proposal
  → schema and length validation
  → knowledge-contamination monitor
  → capability sandbox
  → free-intent resolver
  → world outcome

Speech and resolved event
  → publication safety filter
  → publish, redact, or abstract summary
```

Publication safety does not impose morality on the simulation. Theft, threats, betrayal, assault, killing, and war can resolve causally. Sensitive content is shown abstractly. Adult non-consensual sexual assault is represented only as a non-graphic event type, never creates consent, partnership, or pregnancy, and is categorically rejected if any participant is a minor.

## Time, scheduling, and cost

- One real hour equals one simulated month at `1×`; the world heartbeat runs every 30 seconds.
- Weather, needs, aging, injury, pregnancy, and ongoing activity advance without a model call.
- Characters are scheduled as `foreground`, `background`, `low_frequency`, `sleeping`, or `incapacitated` and selected only when `nextDueSimTime` is reached.
- Waiting time raises priority so quiet characters are not ignored forever.
- Child agency grows gradually from mostly rule-based infancy to full event-driven adulthood.
- The default model is `gpt-5-nano`; calls are serialized and protected by durable deduplication and a circuit breaker.
- There is no artificial daily or lifetime AI budget. Provider quota exhaustion changes the season to `ai_paused` and freezes simulation time.

## Versioned history and replay

Each season locks a `SeasonRuntimeIdentity` on its first start. Every event, decision, experiment, and checkpoint stores its engine and schema versions. Behavioral changes apply to new seasons by default. Migrating a running season requires a pause, a pre-migration checkpoint, a public permanent migration event, old and new identities, a reason, an effective day, and replay verification.

Deaths archive rather than delete people. Important memories, beliefs, values, relationships, lineage, goals, discoveries, and event references remain indexed. Temporary working memory is compressed into verified cold blocks and removed from the live snapshot. Monthly differential and yearly full checkpoints support historical inspection without loading every person or memory into RAM.

History intentionally has two views:

1. **Omniscient history** — what the engine says actually happened.
2. **Social history** — what a community or generation believes happened.

The views may diverge through secrecy, rumor, propaganda, forgotten events, and lost records. The engine never silently corrects social history from omniscient truth.

## Repository layout

- `app/`, `components/` — Arabic RTL public observer experience.
- `shared/` — contracts, cognition, perception, knowledge integrity, resolver, heredity, scheduling, and history.
- `worker/` — Cloudflare Worker, Agents SDK agents, SQLite persistence, D1 season index, R2 cold archive, signed operations, and tests.
- `public/island-world-v2.webp` — the optimized island board artwork included with the open-source build.

## Local development

Requirements: Node.js 22.13+, a Cloudflare account for deployment, and an optional OpenAI API key.

```powershell
npm install
cd worker
npm install
npm run check
npm test
npx wrangler dev --local --config ./wrangler.jsonc
```

Set `SIMULATION_MODE=mock` for deterministic local runs. Keep secrets in `worker/.dev.vars`, which is ignored by Git:

```dotenv
OPENAI_API_KEY=
ADMIN_BRIDGE_SECRET=replace-with-a-long-random-secret
```

Never commit keys. A season creation or control request must be HMAC-signed with a timestamp and one-time nonce. The browser receives read-only endpoints and a read-only public WebSocket agent.

## Public API

```text
GET /api/seasons
GET /api/seasons/:id/snapshot?view=social|omniscient
GET /api/seasons/:id/events?cursor=&view=...
GET /api/seasons/:id/characters/:personId?view=...
GET /api/seasons/:id/analytics
GET /api/seasons/:id/discoveries
GET /api/seasons/:id/history/timeline?view=&atDay=&asOfDay=
GET /api/seasons/:id/history/deceased
GET /api/seasons/:id/history/people/:personId?view=&asOfDay=
GET /api/seasons/:id/history/family-tree?root=
GET /api/seasons/:id/history/entities?type=&atDay=
GET /api/seasons/:id/history/impact-ranking
GET /api/seasons/:id/replay?atDay=&view=&asOfDay=
GET /api/seasons/:id/map?bbox=&cursor=
WS  /agents/public-stream-agent/:seasonId
```

Operational controls and detailed cost/security diagnostics are signed and have no public admin page.

## Contributing and security

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a change and [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Do not submit changes that give the simulated model real tools or silently alter an active season's behavioral identity.

Copyright © Ahmed Bahathiq. Released under the [MIT License](./LICENSE).
