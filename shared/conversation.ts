import type { ConversationState, WorldSnapshot } from "./contracts";
import { deterministicId, seededRandom } from "./random";

export function recordConversationTurn(world: WorldSnapshot, actorId: string, targetIds: string[], speech: string): ConversationState | null {
  const participants = [...new Set([actorId, ...targetIds])].sort();
  if (participants.length < 2) return null;
  let conversation = [...world.conversations].reverse().find((item) => item.status === "active" && sameParticipants(item.participantIds, participants));
  if (!conversation) {
    const initialLimit = 3 + Math.floor(seededRandom(world.seed, world.tick, participants.join(":")) * 4);
    conversation = { id: deterministicId("conversation", world.seed, world.tick, participants.join(":")), participantIds: participants, turnCount: 0, plannedTurnLimit: initialLimit, unresolvedSocialEvent: false, lastSpeech: "", status: "active", updatedAtSimDay: world.simDay };
    world.conversations.push(conversation);
  }
  const cleanSpeech = speech.trim();
  const madeProgress = cleanSpeech.length > 0 && cleanSpeech !== conversation.lastSpeech;
  conversation.turnCount += 1;
  conversation.unresolvedSocialEvent = /[؟?]|(?:لا زلنا|ما اتفقنا|لا أوافق|وش نسوي|ماذا نفعل)/u.test(cleanSpeech);
  conversation.lastSpeech = cleanSpeech.slice(0, 240);
  conversation.updatedAtSimDay = world.simDay;
  if (conversation.turnCount >= conversation.plannedTurnLimit) {
    if (conversation.unresolvedSocialEvent && madeProgress && conversation.plannedTurnLimit < 12) conversation.plannedTurnLimit = Math.min(12, conversation.plannedTurnLimit + 2);
    else conversation.status = "closed";
  }
  if (conversation.turnCount >= 12) conversation.status = "closed";
  return conversation;
}

function sameParticipants(a: string[], b: string[]): boolean { return a.length === b.length && a.every((id, index) => id === b[index]); }
