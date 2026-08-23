import { mkdir, readFile, writeFile } from "node:fs/promises";

import type { SkillRecord } from "../../core/contracts/index.ts";
import { runActivationMemoryCalibrationAblation } from "./calibration-ablation.ts";

const SNAPSHOT_PATH = "docs/evaluation/2026-08-20-selection-catalog-snapshot.json";
const JSON_REPORT_PATH = "docs/reports/2026-08-20-activation-memory-calibration.json";
const MARKDOWN_REPORT_PATH = "docs/reports/2026-08-20-activation-memory-calibration.md";

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as {
  catalogHash: string;
  entries: Array<Pick<SkillRecord, "skillId" | "skillRevision" | "name" | "description">>;
};
const catalog: SkillRecord[] = snapshot.entries.map((item) => ({
  ...item,
  schemaVersion: 1,
  scope: "user",
  sourceLocator: "fixture://catalog-snapshot",
  sourceHash: `sha256:${"0".repeat(64)}`,
  disableModelInvocation: false,
  declaredAliases: [],
  declaredEffects: [],
  declaredPermissions: [],
  dependencyManifest: [],
  discoveredAt: "2026-08-20T00:00:00.000Z",
}));

const report = runActivationMemoryCalibrationAblation({ catalog, catalogHash: snapshot.catalogHash });
await mkdir("docs/reports", { recursive: true });
await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await writeFile(MARKDOWN_REPORT_PATH, renderMarkdown(report), { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({
  jsonReportPath: JSON_REPORT_PATH,
  markdownReportPath: MARKDOWN_REPORT_PATH,
  pointCount: report.pointCount,
  negativeControlsPassed: report.negativeControls.allPassed,
}, null, 2));

function renderMarkdown(report: ReturnType<typeof runActivationMemoryCalibrationAblation>): string {
  const lines = [
    "# Activation Memory calibration ablation",
    "",
    "日期：2026-08-20  ",
    "证据等级：**offline component / evaluation fixture**",
    "",
    `- Catalog hash：\`${report.catalogHash}\``,
    `- Fixture hash：\`${report.fixtureHash}\``,
    `- Config hash：\`${report.configHash}\``,
    `- Top-K / boost / near-miss penalty：\`${report.configuration.topK} / ${report.configuration.memoryBoost} / ${report.configuration.nearMissPenalty}\``,
    "- Held-out：未运行",
    "- Model / host：未调用",
    "",
    "## Learning curve",
    "",
    "| Exp. | Arm | Overall R@K | ZH R@K | EN R@K | Multi full | Per-Gold | MRR | No-Skill FP | Hard R@K | Hard FP | Static preserve |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const point of report.points) {
    const overall = point.metrics.overall;
    lines.push(`| ${point.exposure} | ${point.condition.id} | ${format(overall.goldAvailabilityRecallAtK)} | ${format(point.metrics.zh.goldAvailabilityRecallAtK)} | ${format(point.metrics.en.goldAvailabilityRecallAtK)} | ${format(point.metrics.multi.multiSkillFullSetAvailability)} | ${format(overall.meanPerGoldRecall)} | ${format(overall.meanReciprocalRank)} | ${format(point.metrics.noSkill.noSkillFalsePositiveRate)} | ${format(point.metrics.hardConfuser.hardConfuserGoldAvailabilityRecallAtK)} | ${format(point.metrics.hardConfuser.hardConfuserFalsePositiveRate)} | ${format(overall.staticGoldPreservationRate)} |`);
  }
  lines.push(
    "",
    "## Negative controls",
    "",
    `结果：${report.negativeControls.results.filter((item) => item.passed).length}/${report.negativeControls.controlCount} passed。`,
    "",
    "| ID | Control | Expected | Observed | Pass |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const item of report.negativeControls.results) {
    lines.push(`| ${item.id} | ${item.kind} | ${item.expectedOutcome} | ${item.observedOutcome} | ${item.passed ? "yes" : "no"} |`);
  }
  lines.push(
    "",
    "## Evidence boundary",
    "",
    "该报告只证明冻结 fixture 上的离线 formation/retrieval component 行为。它不证明真实 PracticeEvent formation、生产 active overlay、主模型 Selection 或 Pi host E2E。",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function format(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(4);
}
