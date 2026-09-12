import { z } from "zod";
import { ACTIONS, ZONES, type AgentDecision, type CharacterState, type ResolvedEvent, type WorldSnapshot } from "../../shared/contracts";

const decisionSchema = z.object({
  action: z.enum(ACTIONS),
  targetId: z.string().nullable(),
  targetZone: z.enum(ZONES).nullable(),
  speech: z.string().max(240).nullable(),
  emotion: z.enum(["calm", "hopeful", "worried", "happy", "tired", "angry"]),
  goal: z.string().min(1).max(100),
  memory: z.string().max(180).nullable(),
});

const jsonSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTIONS },
    targetId: { type: ["string", "null"] },
    targetZone: { type: ["string", "null"], enum: [...ZONES, null] },
    speech: { type: ["string", "null"], maxLength: 240 },
    emotion: { type: "string", enum: ["calm", "hopeful", "worried", "happy", "tired", "angry"] },
    goal: { type: "string", minLength: 1, maxLength: 100 },
    memory: { type: ["string", "null"], maxLength: 180 },
  },
  required: ["action", "targetId", "targetZone", "speech", "emotion", "goal", "memory"],
  additionalProperties: false,
} as const;

export type DecisionContext = {
  world: WorldSnapshot;
  character: CharacterState;
  observedEvents: ResolvedEvent[];
  memories: string[];
};

export type ModelUsage = { inputTokens: number; outputTokens: number };
export type ModelResult = { decision: AgentDecision; usage: ModelUsage; moderated: boolean };

export interface ModelProvider {
  decide(context: DecisionContext): Promise<ModelResult>;
}

export class OpenAIModelProvider implements ModelProvider {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async decide(context: DecisionContext): Promise<ModelResult> {
    const input = buildInput(context);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        store: false,
        max_output_tokens: 420,
        reasoning: { effort: "none" },
        instructions: SYSTEM_INSTRUCTIONS,
        input,
        text: { format: { type: "json_schema", name: "agent_decision", strict: true, schema: jsonSchema } },
      }),
    });
    if (!response.ok) throw new Error(`openai_response_${response.status}`);
    const raw: unknown = await response.json();
    const parsedResponse = responseSchema.parse(raw);
    const parsedDecision = decisionSchema.parse(JSON.parse(extractOutputText(parsedResponse)));
    const moderated = parsedDecision.speech ? await this.isFlagged(parsedDecision.speech) : false;
    const safeDecision = moderated ? { ...parsedDecision, speech: null, memory: null } : parsedDecision;
    return {
      decision: { characterId: context.character.id, ...safeDecision },
      usage: { inputTokens: parsedResponse.usage?.input_tokens ?? 0, outputTokens: parsedResponse.usage?.output_tokens ?? 0 },
      moderated,
    };
  }

  private async isFlagged(text: string): Promise<boolean> {
    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
    });
    if (!response.ok) return true;
    const raw: unknown = await response.json();
    return moderationSchema.parse(raw).results.some((result) => result.flagged);
  }
}

export class MockModelProvider implements ModelProvider {
  async decide({ world, character }: DecisionContext): Promise<ModelResult> {
    const living = world.characters.filter((person) => person.alive && person.id !== character.id);
    const friend = living[world.tick % Math.max(1, living.length)];
    let action: AgentDecision["action"] = "explore";
    let targetZone: AgentDecision["targetZone"] = "ridge";
    let speech: string | null = null;
    let goal = "استكشاف الجزيرة";
    if (character.energy < 35) { action = "rest"; targetZone = "camp"; goal = "استعادة الطاقة"; }
    else if (world.resources.water < world.characters.length * 8) { action = "gather_water"; targetZone = "spring"; goal = "تأمين الماء"; }
    else if (world.resources.food < world.characters.length * 7) { action = "forage"; targetZone = "forest"; goal = "جمع الغذاء"; }
    else if (world.resources.shelterCapacity < world.characters.filter((person) => person.alive).length) { action = world.resources.wood >= 4 ? "build" : "gather_wood"; targetZone = action === "build" ? "camp" : "forest"; goal = "إكمال المأوى"; }
    else if (friend && world.tick % 5 === 0) { action = "talk"; targetZone = null; speech = `${friend.name}، عندي فكرة لخطوتنا القادمة. هل نراجع المؤن معًا؟`; goal = "تقوية التعاون"; }
    return { decision: { characterId: character.id, action, targetId: action === "talk" ? friend?.id ?? null : null, targetZone, speech, emotion: character.energy < 35 ? "tired" : "hopeful", goal, memory: speech ? `تحدثت مع ${friend?.name ?? "المجموعة"} عن المؤن.` : null }, usage: { inputTokens: 0, outputTokens: 0 }, moderated: false };
  }
}

const responseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});
const moderationSchema = z.object({ results: z.array(z.object({ flagged: z.boolean() })) });

function extractOutputText(response: z.infer<typeof responseSchema>): string {
  if (response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error("openai_response_missing_output_text");
}

const SYSTEM_INSTRUCTIONS = `أنت شخصية بالغة مستقلة داخل محاكاة نجاة عربية. اختر فعلًا واحدًا فقط من الأفعال المتاحة بناءً على ما تعرفه أنت، لا على معلومات خفية. لا تخترع موارد أو نتائج؛ محرك العالم سيحسم النتيجة. اجعل الكلام طبيعيًا ومختصرًا وغير صريح جنسيًا أو عنيفًا. لا تكشف استدلالًا داخليًا. يمكن أن تقترح الزواج أو تكوين أسرة فقط بين بالغين وبقبول متبادل.`;

function buildInput({ world, character, observedEvents, memories }: DecisionContext): string {
  const visiblePeople = world.characters.filter((person) => person.alive && (person.position.zone === character.position.zone || person.id === character.id)).map((person) => ({ id: person.id, name: person.name, age: Math.floor(person.ageYears), stage: person.lifeStage, partnerId: person.partnerId }));
  return JSON.stringify({
    time: { simDay: Math.floor(world.simDay), weather: world.weather, temperatureC: world.temperatureC },
    self: { id: character.id, name: character.name, age: Math.floor(character.ageYears), traits: character.traits, skills: character.skills, health: character.health, energy: character.energy, morale: character.morale, hunger: character.hunger, thirst: character.thirst, goal: character.goal, position: character.position, partnerId: character.partnerId, pendingProposalFrom: character.pendingProposalFrom },
    visiblePeople,
    publicResources: world.resources,
    recentObservedEvents: observedEvents.slice(0, 16).map(({ actorName, text, detail, simDay }) => ({ actorName, text, detail, simDay: Math.floor(simDay) })),
    memories: memories.slice(0, 12),
    availableActions: ACTIONS,
    zones: ZONES,
  });
}
