import { createHash } from "node:crypto";

import type { ActivationProfile } from "../../core/contracts/index.ts";
import type { SelectionMemoryBoundaryExample } from "./memory-card.ts";

export const SELECTION_MEMORY_CATALOG_HASH =
  "sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7";
export const SELECTION_MEMORY_EVALUATION_SCOPE_HASH =
  "sha256:99672609a078adb5a985447529297d445c0ec0ec82d76a35eab2da4213c1b71a";

export const SELECTION_MEMORY_SKILL_IDS = Object.freeze({
  architecture: "skill:03165140889cff61f45938f8b8af2a38980514158712b650f541a1220edb0081",
  systematicReview: "skill:bec8e35a8e60b62db96e41a97f5ba935202b9c889add41060d989ee126aac730",
  security: "skill:669a5a164b1141e9d42f7cf0974122b71ec705616bb9fe6a5dcd34956162130d",
  chart: "skill:87048bb1689f395a322b3ed4912eb8d3ee3bc7bfb91df2730573f91bb21256a1",
  codeDocumentation: "skill:e8da2ec737ed6579d59d7ebbc552b452d5f1a6e25cf470b5205751d607e39ec8",
  research: "skill:0b0d687f5de892f5968ff0880190b74fcda0c8cb7d1868c5e7907e5ea20b0f71",
  videoFrames: "skill:f8e0587f44d60bc94b14b9f557f2b578dff79f6b736385cf034ffe1be03c3fc6",
  imageGeneration: "skill:c564b209ae13dda734cd4fd971762dd8840278c5c7309fa540c6bce4b65e5562",
  academicPaperReview: "skill:681f792463fbcfbd0706f0ad9547329a308a0e741123efb5592b1e72e6197e5b",
  code: "skill:7366392fe25e729a66c012caba4a296cfc2b220702a34a3bde8b1d46ae562476",
  codebaseDesign: "skill:725cfa99ce6b7899e15cbad51a338a648ec04be09eb87729ee37b14a3eeb347f",
  domainModeling: "skill:949457902c5ffb8e9c84b5dcf90073cee62084607593a3da0ae037b63121608b",
  dataAnalysis: "skill:f7ee3af6ab0ce0c5040bb9871fd4b4df370f4256d30f0c465992d3ae9ada0873",
  ffmpegEditor: "skill:814cacd312e3ac69f5b0d1b96d563991b63492859e3b2430fc817e16b73d1aad",
  researchPaperWriter: "skill:bd8acdaaeeae6807d80067d826e62583a466fa61892f9c3216f7593cf134aeb1",
  githubDeepResearch: "skill:fa0397d71b9554cd98f793c0bf75bc30af82db6d74077b4369b8783f0e26078e",
  clawdefender: "skill:dfb8725e91a53a5cac5af70921cdba26ef7bbe3d6288645bc6da53568fd63f3d",
  imageToCode: "skill:972f49559143229cc9ae3d70a465318dd261adb9f29de56aea50a37d99f589bc",
  youtubeWatcher: "skill:9e1c09c8d8cdf48d0ef490d25c50e69cfbbbc83e84d4fd02d749dd7f2a400f2b",
} as const);

export interface SelectionMemoryTargetSkill {
  readonly key: keyof Pick<typeof SELECTION_MEMORY_SKILL_IDS,
    | "architecture"
    | "systematicReview"
    | "security"
    | "chart"
    | "codeDocumentation"
    | "research"
    | "videoFrames"
    | "imageGeneration">;
  readonly name: string;
  readonly skillId: string;
  readonly skillRevision: string;
}

export const SELECTION_MEMORY_TARGET_SKILLS: readonly SelectionMemoryTargetSkill[] = Object.freeze([
  target("architecture", "architecture-designer", "rev:3cd15b9327f119e63cd055e76aeecd2a115b37ef309194808fb690a7b6844cb0"),
  target("systematicReview", "systematic-literature-review", "rev:b3623c87c190d153abf724f9f605e92ba81ca12f7dcd5a4087e5d2c37a9e5645"),
  target("security", "security-auditor", "rev:df9d3172f803bb33205c063343e5a1870d9f9e539d7cd98941ba84f9aaf7036e"),
  target("chart", "chart-visualization", "rev:7d76b7489efe2041eddd92f0d63688b4f63ff4149bda131194dc301188a7c93e"),
  target("codeDocumentation", "code-documentation", "rev:dab12680db31319159827bab3578835147f331f3cf23628da4c9f763edc10b9e"),
  target("research", "research", "rev:e519f038cca0eb2019ce9fc3ef0bd5044e3973f17f20778f36c38a91ae99c699"),
  target("videoFrames", "video-frames", "rev:73e1792ab8d20721060ec1c9418fafb1fc6552c3b624c6bdd1dd61e4a7b3710d"),
  target("imageGeneration", "image-generation", "rev:99905bf6bdb5ffea2bda7c999b08f90eb814e89e027f92d3bf43bc51b9dbf95f"),
]);

export type SelectionMemoryEvidenceClass =
  | "verified_positive"
  | "near_miss"
  | "boundary"
  | "environment";

export interface SelectionMemoryEvidenceCase {
  readonly id: string;
  readonly targetSkillId: string;
  readonly targetSkillRevision: string;
  readonly evidenceClass: SelectionMemoryEvidenceClass;
  readonly features: readonly string[];
  readonly environmentKey?: string;
  readonly environmentValueClass?: string;
  readonly provenance: "evaluation_fixture";
  readonly verification: "independent_fixture_review";
}

const EVIDENCE_FEATURES: Readonly<Record<SelectionMemoryTargetSkill["key"], readonly EvidenceSeed[]>> = Object.freeze({
  architecture: Object.freeze([
    seed("verified_positive", ["system-wide topology", "explicit trade-off record"]),
    seed("verified_positive", ["service boundaries", "scalability constraints"]),
    seed("near_miss", ["local module refactoring"]),
    seed("boundary", ["basic architecture terminology"]),
    seed("boundary", ["single-function implementation advice"]),
    environment("artifact_scope", "multi-component-system"),
  ]),
  systematicReview: Object.freeze([
    seed("verified_positive", ["cross-paper evidence synthesis", "explicit screening protocol"]),
    seed("verified_positive", ["multiple academic studies", "inclusion and exclusion criteria"]),
    seed("near_miss", ["single uploaded paper critique"]),
    seed("boundary", ["basic literature-review definition"]),
    seed("boundary", ["casual reading list without screening"]),
    environment("source_set", "multiple-papers"),
  ]),
  security: Object.freeze([
    seed("verified_positive", ["vulnerability audit of existing implementation", "risk report without patching"]),
    seed("verified_positive", ["authentication or authorization attack paths", "adversarial review"]),
    seed("near_miss", ["general maintainability review"]),
    seed("boundary", ["security concept explanation"]),
    seed("boundary", ["general defensive-programming advice"]),
    environment("artifact", "source-code"),
  ]),
  chart: Object.freeze([
    seed("verified_positive", ["specified chart image", "no statistical interpretation"]),
    seed("verified_positive", ["visual encoding from supplied values", "standalone graphic artifact"]),
    seed("near_miss", ["calculate statistics and explain findings"]),
    seed("boundary", ["chart-type definition"]),
    seed("boundary", ["verbal comparison of visualization types"]),
    environment("output", "image"),
  ]),
  codeDocumentation: Object.freeze([
    seed("verified_positive", ["developer-facing documentation from repository implementation", "API reference or migration guide"]),
    seed("verified_positive", ["document current interfaces and examples", "repository documentation artifact"]),
    seed("near_miss", ["implement or debug behavior"]),
    seed("boundary", ["basic software-term explanation"]),
    seed("boundary", ["advice about documentation conventions"]),
    environment("artifact", "source-code-repository"),
  ]),
  research: Object.freeze([
    seed("verified_positive", ["verify current external behavior with primary sources", "source-linked findings"]),
    seed("verified_positive", ["time-sensitive official documentation check", "authoritative-source synthesis"]),
    seed("near_miss", ["analyze only checked-in source code"]),
    seed("boundary", ["stable common-knowledge answer"]),
    seed("boundary", ["conceptual explanation without source verification"]),
    environment("sources", "primary-external"),
  ]),
  videoFrames: Object.freeze([
    seed("verified_positive", ["extract still frames at explicit timestamps", "return image files"]),
    seed("verified_positive", ["export a bounded clip interval", "operate on supplied video"]),
    seed("near_miss", ["summarize video speech or content"]),
    seed("boundary", ["frame-count arithmetic without media operation"]),
    seed("boundary", ["conceptual question about video timing"]),
    environment("input", "video-file"),
  ]),
  imageGeneration: Object.freeze([
    seed("verified_positive", ["generate an original visual artifact", "specified scene or style"]),
    seed("verified_positive", ["create a new image from visual reference", "image output"]),
    seed("near_miss", ["edit frontend layout or styles"]),
    seed("boundary", ["visual-art concept explanation"]),
    seed("boundary", ["discussion of style without requested artifact"]),
    environment("output", "image"),
  ]),
});

export const SELECTION_MEMORY_EVIDENCE_CASES: readonly SelectionMemoryEvidenceCase[] = Object.freeze(
  SELECTION_MEMORY_TARGET_SKILLS.flatMap((targetSkill) => EVIDENCE_FEATURES[targetSkill.key].map((item, index) => Object.freeze({
    id: `SME-${targetSkill.key}-${String(index + 1).padStart(2, "0")}`,
    targetSkillId: targetSkill.skillId,
    targetSkillRevision: targetSkill.skillRevision,
    evidenceClass: item.evidenceClass,
    features: Object.freeze([...item.features]),
    ...(item.environmentKey === undefined ? {} : {
      environmentKey: item.environmentKey,
      environmentValueClass: item.environmentValueClass,
    }),
    provenance: "evaluation_fixture" as const,
    verification: "independent_fixture_review" as const,
  }))),
);

export type SelectionMemoryEvalPartition = "calibration" | "heldout";
export type SelectionMemoryLanguage = "zh" | "en";
export type SelectionMemoryLabel = "single" | "multi" | "no_skill";

export interface SelectionMemoryEvalCase {
  readonly id: string;
  readonly partition: SelectionMemoryEvalPartition;
  readonly language: SelectionMemoryLanguage;
  readonly labelType: SelectionMemoryLabel;
  readonly query: string;
  readonly goldSkillIds: readonly string[];
  readonly candidateSkillIds: readonly string[];
  readonly hardConfuser: boolean;
}

export function selectionMemoryCase(
  id: string,
  partition: SelectionMemoryEvalPartition,
  language: SelectionMemoryLanguage,
  query: string,
  goldSkillIds: readonly string[],
  candidateSkillIds: readonly string[],
  hardConfuser: boolean,
): SelectionMemoryEvalCase {
  const labelType: SelectionMemoryLabel = goldSkillIds.length === 0 ? "no_skill" : goldSkillIds.length === 1 ? "single" : "multi";
  return Object.freeze({
    id,
    partition,
    language,
    labelType,
    query,
    goldSkillIds: Object.freeze([...goldSkillIds]),
    candidateSkillIds: Object.freeze([...candidateSkillIds]),
    hardConfuser,
  });
}

export interface SelectionMemoryEvaluationProjection {
  readonly tenantScopeHash: string;
  readonly profile: ActivationProfile;
  readonly boundaryExamples: readonly SelectionMemoryBoundaryExample[];
}

/** Forms a draft evaluation projection from controlled evidence, never a persisted production profile. */
export function buildSelectionMemoryEvaluationProjection(skillId: string): SelectionMemoryEvaluationProjection {
  const targetSkill = SELECTION_MEMORY_TARGET_SKILLS.find((item) => item.skillId === skillId);
  if (targetSkill === undefined) throw new Error("selection_memory_target_not_found");
  const evidence = SELECTION_MEMORY_EVIDENCE_CASES.filter((item) => item.targetSkillId === skillId);
  const profile: ActivationProfile = {
    schemaVersion: 1,
    profileId: `profile:selection-memory:${targetSkill.key}`,
    parentSkillId: targetSkill.skillId,
    parentSkillRevision: targetSkill.skillRevision,
    status: "draft",
    learnedAliases: [],
    positiveExamples: evidence.filter((item) => item.evidenceClass === "verified_positive").map((item) => ({
      cueId: item.id,
      features: [...item.features],
      evidenceIds: [item.id],
    })),
    nearMissExamples: evidence.filter((item) => item.evidenceClass === "near_miss").map((item) => ({
      cueId: item.id,
      features: [...item.features],
      evidenceIds: [item.id],
    })),
    environmentCues: evidence.filter((item) => item.evidenceClass === "environment").map((item) => ({
      key: item.environmentKey ?? "",
      valueClass: item.environmentValueClass ?? "",
      evidenceIds: [item.id],
    })),
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
  const boundaryExamples = evidence.filter((item) => item.evidenceClass === "boundary").map((item) => Object.freeze({
    cueId: item.id,
    features: Object.freeze([...item.features]),
    evidenceIds: Object.freeze([item.id]),
  }));
  return Object.freeze({
    tenantScopeHash: SELECTION_MEMORY_EVALUATION_SCOPE_HASH,
    profile: Object.freeze(profile),
    boundaryExamples: Object.freeze(boundaryExamples),
  });
}

export function computeSelectionMemoryEvidenceHash(): string {
  const payload = {
    catalogHash: SELECTION_MEMORY_CATALOG_HASH,
    targets: [...SELECTION_MEMORY_TARGET_SKILLS].sort(byId),
    evidence: [...SELECTION_MEMORY_EVIDENCE_CASES].sort(byId),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

/** Draft/frozen identity helper. Candidate order is semantic; case file order is not. */
export function computeSelectionMemoryCaseSetHash(cases: readonly SelectionMemoryEvalCase[]): string {
  const payload = {
    catalogHash: SELECTION_MEMORY_CATALOG_HASH,
    cases: [...cases].sort(byId).map((item) => ({
      id: item.id,
      partition: item.partition,
      language: item.language,
      labelType: item.labelType,
      query: item.query,
      goldSkillIds: [...item.goldSkillIds].sort(),
      candidateSkillIds: [...item.candidateSkillIds],
      hardConfuser: item.hardConfuser,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex")}`;
}

interface EvidenceSeed {
  readonly evidenceClass: SelectionMemoryEvidenceClass;
  readonly features: readonly string[];
  readonly environmentKey?: string;
  readonly environmentValueClass?: string;
}

function seed(evidenceClass: Exclude<SelectionMemoryEvidenceClass, "environment">, features: readonly string[]): EvidenceSeed {
  return Object.freeze({ evidenceClass, features: Object.freeze([...features]) });
}

function environment(key: string, valueClass: string): EvidenceSeed {
  return Object.freeze({ evidenceClass: "environment", features: Object.freeze([]), environmentKey: key, environmentValueClass: valueClass });
}

function target(key: SelectionMemoryTargetSkill["key"], name: string, skillRevision: string): SelectionMemoryTargetSkill {
  return Object.freeze({ key, name, skillId: SELECTION_MEMORY_SKILL_IDS[key], skillRevision });
}

function byId(left: { readonly id?: string; readonly skillId?: string }, right: { readonly id?: string; readonly skillId?: string }): number {
  return (left.id ?? left.skillId ?? "").localeCompare(right.id ?? right.skillId ?? "");
}
