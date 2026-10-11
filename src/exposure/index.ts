import type {
  ExposureMatchField,
  ExposureObservation,
  SkillCandidate,
  SkillRecord,
} from "../core/contracts/index.ts";

const FIELD_ORDER: readonly ExposureMatchField[] = ["name", "description", "alias", "learned_cue"];
const ASCII_WORD = /[a-z0-9]/u;

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function containsDeclaredReference(prompt: string, declared: string): boolean {
  const haystack = normalize(prompt);
  const needle = normalize(declared);
  if (needle === "") return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1]!;
    const afterIndex = index + needle.length;
    const after = afterIndex === haystack.length ? "" : haystack[afterIndex]!;
    const startsAscii = ASCII_WORD.test(needle[0]!);
    const endsAscii = ASCII_WORD.test(needle[needle.length - 1]!);
    if ((!startsAscii || !ASCII_WORD.test(before)) && (!endsAscii || !ASCII_WORD.test(after))) return true;
    from = index + 1;
  }
  return false;
}

/** 只读取 retriever 输出与作者声明；不分类任务、不估计 expected gain、不返回 show/abstain。 */
export function observeExposure(
  prompt: string,
  records: readonly SkillRecord[],
  candidates: readonly SkillCandidate[],
): ExposureObservation {
  const top = candidates[0];
  const matched = new Set<ExposureMatchField>();
  for (const evidence of top?.evidence ?? []) {
    matched.add(evidence.kind === "learned_cue" ? "learned_cue" : evidence.field);
  }
  const exactDeclaredReference = records.some((record) =>
    [record.skillId, record.name, ...record.declaredAliases]
      .some((declared) => containsDeclaredReference(prompt, declared)),
  );
  return {
    baselineWouldInject: candidates.length > 0,
    candidateCount: candidates.length,
    ...(top !== undefined ? { topScore: top.retrievalScore } : {}),
    ...(candidates[1] !== undefined ? { secondScore: candidates[1]!.retrievalScore } : {}),
    topMatchFields: FIELD_ORDER.filter((field) => matched.has(field)),
    exactDeclaredReference,
  };
}

export { ExposureObservationStore } from "./store.ts";
