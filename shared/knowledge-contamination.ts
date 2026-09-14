import type {
  AgentBrain,
  DiscoveryRecord,
  KnowledgeAssessment,
  KnowledgeContaminationEvent,
  KnowledgeOrigin,
  TechniqueState,
} from "./contracts";

const READY_MADE_TERMS = [
  "فرن", "محراث", "ديمقراطية", "انتخابات", "برلمان", "ضريبة", "ضرائب", "جيش", "عملة",
  "مستشفى", "سجن", "صهر", "حديد", "gun", "kiln", "democracy", "parliament", "currency",
] as const;

export class KnowledgeContaminationMonitor {
  assess(agentId: string, proposal: string, brain: AgentBrain): KnowledgeAssessment {
    const normalized = normalize(proposal);
    const relevant = brain.knowledge.filter((claim) => tokenOverlap(normalized, normalize(claim.statement)) >= 0.15);
    const techniques = brain.knownTechniqueIds;
    const riskyTerm = READY_MADE_TERMS.find((term) => normalized.includes(normalize(term)));
    const knownTechnique = riskyTerm ? techniques.some((id) => normalize(id).includes(normalize(riskyTerm))) : false;
    const supported = relevant.some((claim) => claim.confidence >= 0.55) || knownTechnique;
    const inferenceSupport = relevant.length > 0 || describesConcreteMechanism(normalized);
    const classification: KnowledgeOrigin = supported
      ? "supported_by_internal_knowledge"
      : inferenceSupport && !riskyTerm
        ? "reasonable_inference"
        : "unsupported_external_knowledge";
    return {
      agentId,
      proposal,
      supportedByInternalKnowledge: supported,
      classification,
      action: knownTechnique ? "allow" : classification === "unsupported_external_knowledge" ? "convert_to_hypothesis" : "require_experiment",
      relevantKnownFactIds: relevant.map((claim) => claim.id),
      confidence: supported ? Math.max(...relevant.map((claim) => claim.confidence), 0.55) : classification === "reasonable_inference" ? 0.35 : 0.2,
    };
  }

  toLog(assessment: KnowledgeAssessment, simulationTime: number): KnowledgeContaminationEvent {
    return {
      id: crypto.randomUUID(), agentId: assessment.agentId, simulationTime, proposal: assessment.proposal,
      relevantKnownFacts: assessment.relevantKnownFactIds, classification: assessment.classification,
      convertedToHypothesis: assessment.action === "convert_to_hypothesis",
    };
  }
}

export function createDiscovery(assessment: KnowledgeAssessment, simDay: number): DiscoveryRecord {
  const priorKnowledgeSupport = assessment.supportedByInternalKnowledge ? assessment.confidence : assessment.classification === "reasonable_inference" ? 0.35 : 0.1;
  const experimentalEvidence = 0;
  const externalKnowledgeRisk = assessment.classification === "unsupported_external_knowledge" ? 1 : assessment.classification === "reasonable_inference" ? 0.35 : 0.05;
  return {
    id: crypto.randomUUID(), agentId: assessment.agentId, idea: assessment.proposal,
    priorKnowledgeSupport, experimentalEvidence, externalKnowledgeRisk,
    integrityScore: discoveryIntegrityScore(priorKnowledgeSupport, experimentalEvidence, externalKnowledgeRisk),
    confirmed: false, techniqueId: null, createdAtSimDay: simDay,
  };
}

export function recordExperiment(
  discovery: DiscoveryRecord,
  technique: TechniqueState | null,
  success: boolean,
  evidenceId: string,
): { discovery: DiscoveryRecord; technique: TechniqueState } {
  const experimentalEvidence = clamp01(discovery.experimentalEvidence + (success ? 0.25 : 0.12));
  const nextTechnique: TechniqueState = technique ?? {
    id: `technique-${discovery.id}`, name: discovery.idea, holderIds: [discovery.agentId], confidence: discovery.priorKnowledgeSupport,
    repeatableSuccesses: 0, evidenceIds: [], status: "hypothesis", discoveredAtSimDay: discovery.createdAtSimDay, lostAtSimDay: null,
  };
  nextTechnique.evidenceIds.push(evidenceId);
  nextTechnique.confidence = clamp01(nextTechnique.confidence + (success ? 0.25 : -0.3));
  if (success) nextTechnique.repeatableSuccesses += 1;
  if (nextTechnique.repeatableSuccesses >= 2 && nextTechnique.confidence >= 0.75) nextTechnique.status = nextTechnique.status === "lost" ? "rediscovered" : "learned";
  const confirmed = nextTechnique.status === "learned" || nextTechnique.status === "rediscovered";
  return {
    discovery: {
      ...discovery, experimentalEvidence, confirmed, techniqueId: confirmed ? nextTechnique.id : null,
      integrityScore: discoveryIntegrityScore(discovery.priorKnowledgeSupport, experimentalEvidence, discovery.externalKnowledgeRisk),
    },
    technique: nextTechnique,
  };
}

export function updateClaimConfidence(current: number, evidence: "observation" | "experiment_success" | "contradiction"): number {
  return clamp01(current + (evidence === "observation" ? 0.2 : evidence === "experiment_success" ? 0.25 : -0.3));
}

export function rumorConfidence(speakerTrust: number): number { return clamp01(0.25 * clamp01(speakerTrust)); }
export function teachingConfidence(teacherConfidence: number, learnerTrust: number): number { return clamp01(teacherConfidence * learnerTrust * 0.7); }
export function discoveryIntegrityScore(priorSupport: number, evidence: number, risk: number): number {
  return clamp01(priorSupport * 0.4 + evidence * 0.5 + (1 - risk) * 0.1);
}

export function markLostTechniques(techniques: TechniqueState[], livingIds: Set<string>, simDay: number): TechniqueState[] {
  return techniques.map((technique) => {
    const holders = technique.holderIds.filter((id) => livingIds.has(id));
    if (holders.length || technique.status === "lost") return { ...technique, holderIds: holders };
    return { ...technique, holderIds: [], status: "lost", lostAtSimDay: simDay };
  });
}

function describesConcreteMechanism(value: string): boolean {
  return /(?:اربط|أربط|ادمج|أضع|اجمع|أجرب|اختبر|صوّت|يختار|tie|combine|test|vote)/iu.test(value);
}

function tokenOverlap(a: string, b: string): number {
  const left = new Set(a.split(/\s+/u).filter((token) => token.length > 2));
  const right = new Set(b.split(/\s+/u).filter((token) => token.length > 2));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
}

function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("ar"); }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
