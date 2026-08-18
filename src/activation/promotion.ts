/**
 * Phase 6 第三批 —— ActivationProfile promotion gate（纯函数；Gate P6 判门）。
 *
 * plan §11 任务 5 + Gate P6：shadow → active 放行须满足：
 * - overlay 非劣（learned ≥ static − tolerance，consume OverlayEvaluationReport.nonInferior）；
 * - 每栏 Recall@K / set recall 达到冻结门槛（默认 0.8；真实分布校准前按合成 fixture 冻结）；
 * - no-skill 不误召、hard-confuser 不误召、gold 不挤出 Top-K（退化检测）均不劣于门槛。
 *
 * 判定返回 { ok:true } 或 { ok:false; reasons }（reasons 可审计，供报告/gate 日志）。
 * 本模块只判门；draft→shadow 回放与 active 落地（store 持久化）不在本 slice；
 * 任何退化可关闭 overlay 无损回静态（rerankWithOverlay overlay-off 可复现，无需本模块动作）。
 */
import { createHash } from "node:crypto";

import type { ActivationProfile, SkillRecord } from "../core/contracts/index.ts";
import type {
  EvaluateOptions,
  EvaluationCase,
  EvaluationColumn,
  OverlayEvaluationReport,
} from "./evaluate.ts";

/** Gate P6 promotion 必须覆盖的四栏（与 evaluate.ts 的 EvaluationColumn 全集一致）。 */
const REQUIRED_COLUMNS: readonly EvaluationColumn[] = [
  "hard_confuser",
  "no_skill",
  "multi_skill",
  "cross_language",
];

/**
 * real-skill 冻结 promotion gate 降级后的必覆盖栏（2026-08-18 收口）：
 *
 * 冻结 real-skill 评估 provider（buildFrozenEvaluation）只能**真实验证**这两栏——
 * - `hard_confuser`：父 Skill 的 name/description 召回 gold + 真实 confuser 不误召；
 * - `no_skill`：冻结无关查询不误召。
 *
 * `multi_skill`（多 gold 全召回）与 `cross_language`（纯跨语言 learned cue 触发召回）在真实
 * 2-skill 无共召回查询的 catalog、且 rerank overlay 只能重排静态候选（不能新增候选）的前提下，
 * **无法真实验证**（见 host.ts buildFrozenEvaluation 的降级说明）。这两栏仍由合成
 * final-heldout/calibration set（真正的多 gold 与中文查询 fixture）单独验证，但 real-skill
 * 冻结 gate 不再把它们列为必覆盖栏——不造假 fixture、不降低数值门槛，如实降级。
 */
export const FROZEN_REQUIRED_COLUMNS: readonly EvaluationColumn[] = [
  "hard_confuser",
  "no_skill",
];

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 递归稳定序列化（对象 key 排序、数组有序），保证同内容不同 key 顺序产生同 hash。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * promotion evidence 绑定（Issue 2：PASS report 不得跨 Profile 复用）。至少绑定：
 * profileId / parentSkillRevision / profile content hash / evaluation set hash /
 * evaluation config hash。store 用落盘 profile 重算 profileId/parentSkillRevision/
 * profileContentHash 三项（不信任 caller），eval set/config hash 校验格式完整性。
 */
export interface PromotionBinding {
  profileId: string;
  parentSkillRevision: string;
  profileContentHash: string;
  evaluationSetHash: string;
  evaluationConfigHash: string;
}

/**
 * profile 内容 hash（learned cue 数据 + 父绑定，不含可变 status/updatedAt）。store 用落盘
 * profile 重算同 hash，与 caller 传入的 binding 比对（内容被改 ⇒ 失配拒绝）。
 */
export function computeProfileContentHash(profile: ActivationProfile): string {
  return hashHex(
    stableStringify({
      parentSkillId: profile.parentSkillId,
      learnedAliases: profile.learnedAliases,
      positiveExamples: profile.positiveExamples,
      nearMissExamples: profile.nearMissExamples,
      environmentCues: profile.environmentCues,
    }),
  );
}

/** 由评估输入确定性计算 promotion binding（供 host 侧 promotion 时绑定 evidence）。 */
export function computePromotionBinding(
  profile: ActivationProfile,
  cases: readonly EvaluationCase[],
  records: readonly SkillRecord[],
  options: EvaluateOptions,
  requiredColumns: readonly EvaluationColumn[],
): PromotionBinding {
  return {
    profileId: profile.profileId,
    parentSkillRevision: profile.parentSkillRevision,
    profileContentHash: computeProfileContentHash(profile),
    evaluationSetHash: hashHex(stableStringify({ cases, records })),
    evaluationConfigHash: hashHex(stableStringify({ options, requiredColumns })),
  };
}

/**
 * Gate P6 冻结门槛（2026-08-16 收口）：
 * - recallAtK / setRecall 最低 0.9（calibration set 各栏下界 1.0 − 0.1 容差）；
 * - confuserNotRecalled 最低 0.9（hard-confuser 不误召干扰项）；
 * - noSkillPrecision = 1（安全硬边界：no-skill 不误召，不放松）；
 * - goldPreservedInTopK = 1（退化检测硬边界：learned overlay 不得把 static Top-K 中的
 *   gold 挤出，任何退化即拒）。
 * 门槛冻结后不得为过门调低；final-heldout 未达标须如实报告。
 */
export const PROMOTION_THRESHOLDS = {
  /** 每栏 Recall@K / set recall 最低值（gold 非空栏）。 */
  recallAtK: 0.9,
  /** no-skill 栏不误召率最低值（安全硬边界）。 */
  noSkillPrecision: 1,
  /** hard-confuser 栏 confuser 不误召率最低值。 */
  confuserNotRecalled: 0.9,
  /** 退化检测：learned Top-K 保留 static gold 命中比例最低值（硬边界，任何退化即拒）。 */
  goldPreservedInTopK: 1,
} as const;

export interface PromotionThresholds {
  recallAtK?: number;
  noSkillPrecision?: number;
  confuserNotRecalled?: number;
  goldPreservedInTopK?: number;
  /** 必覆盖栏（默认 REQUIRED_COLUMNS 四栏；real-skill 冻结 gate 用 FROZEN_REQUIRED_COLUMNS）。 */
  requiredColumns?: readonly EvaluationColumn[];
}

export type PromotionVerdict =
  | { ok: true }
  | { ok: false; reasons: readonly string[] };

function below(value: number | "N/A", threshold: number): boolean {
  return value !== "N/A" && value < threshold;
}

/**
 * shadow→active 判门：nonInferior 必须成立 + 各栏指标达门槛。
 * 无案例的栏（caseCount=0 或指标 N/A）不构成门槛（不虚判）。
 */
export function evaluateProfilePromotion(
  report: OverlayEvaluationReport,
  thresholds: PromotionThresholds = {},
): PromotionVerdict {
  const recallAtK = thresholds.recallAtK ?? PROMOTION_THRESHOLDS.recallAtK;
  const noSkillPrecision = thresholds.noSkillPrecision ?? PROMOTION_THRESHOLDS.noSkillPrecision;
  const confuserNotRecalled =
    thresholds.confuserNotRecalled ?? PROMOTION_THRESHOLDS.confuserNotRecalled;
  const goldPreservedInTopK =
    thresholds.goldPreservedInTopK ?? PROMOTION_THRESHOLDS.goldPreservedInTopK;
  const requiredColumns = thresholds.requiredColumns ?? REQUIRED_COLUMNS;

  const reasons: string[] = [];
  if (!report.nonInferior) {
    reasons.push("overlay_not_non_inferior");
    for (const violation of report.violations) {
      reasons.push(`violation:${violation}`);
    }
  }
  // 栏覆盖：合成 held-out 缺省要求四栏；real-skill 冻结 gate 降级为 FROZEN_REQUIRED_COLUMNS。
  // 缺任一必覆盖栏（caseCount=0 或缺失）⇒ 拒绝，不虚判。
  const covered = new Set(
    report.learnedColumns
      .filter((column) => column.caseCount > 0)
      .map((column) => column.column),
  );
  for (const column of requiredColumns) {
    if (!covered.has(column)) {
      reasons.push(`column_not_covered:${column}`);
    }
  }
  for (const column of report.learnedColumns) {
    if (column.caseCount === 0) continue;
    if (below(column.recallAtK, recallAtK)) {
      reasons.push(`${column.column}.recallAtK=${column.recallAtK} < ${recallAtK}`);
    }
    if (below(column.setRecall, recallAtK)) {
      reasons.push(`${column.column}.setRecall=${column.setRecall} < ${recallAtK}`);
    }
    if (below(column.noSkillPrecision, noSkillPrecision)) {
      reasons.push(`${column.column}.noSkillPrecision=${column.noSkillPrecision} < ${noSkillPrecision}`);
    }
    if (below(column.confuserNotRecalled, confuserNotRecalled)) {
      reasons.push(
        `${column.column}.confuserNotRecalled=${column.confuserNotRecalled} < ${confuserNotRecalled}`,
      );
    }
    if (below(column.goldPreservedInTopK, goldPreservedInTopK)) {
      reasons.push(
        `${column.column}.goldPreservedInTopK=${column.goldPreservedInTopK} < ${goldPreservedInTopK}`,
      );
    }
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
