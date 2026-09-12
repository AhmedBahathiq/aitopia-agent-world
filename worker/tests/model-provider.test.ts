import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, DEFAULT_CHARACTERS } from "../../shared/simulation";
import { OpenAIModelProvider } from "../src/model-provider";

const world = createWorld({ id: "provider-test", title: "اختبار", seed: "provider", populationCap: 24, speed: 1, initialCharacters: DEFAULT_CHARACTERS });
const context = { world, character: world.characters[0], observedEvents: [], memories: [] };

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI model boundary", () => {
  it("rejects non-conforming structured output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output_text: "{\"action\":\"invent_resource\"}", usage: { input_tokens: 4, output_tokens: 2 } })));
    await expect(new OpenAIModelProvider("test-key", "test-model").decide(context)).rejects.toThrow();
  });

  it("removes flagged speech and memory before the engine sees them", async () => {
    const modelBody = { action: "talk", targetId: world.characters[1].id, targetZone: null, speech: "نص للاختبار", emotion: "calm", goal: "التعاون", memory: "ذاكرة" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ output_text: JSON.stringify(modelBody), usage: { input_tokens: 40, output_tokens: 12 } }))
      .mockResolvedValueOnce(Response.json({ results: [{ flagged: true }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new OpenAIModelProvider("test-key", "test-model").decide(context);
    expect(result.moderated).toBe(true);
    expect(result.decision.speech).toBeNull();
    expect(result.decision.memory).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
  });

  it("fails closed when the Responses API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(new OpenAIModelProvider("test-key", "test-model").decide(context)).rejects.toThrow("openai_response_503");
  });
});
