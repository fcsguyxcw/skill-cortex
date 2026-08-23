/**
 * Phase 6 host integration —— 隔离 E2E 入口（仅验收用，非生产入口；经真实 ExtensionRunner /
 * `pi -e` 显式加载）。
 *
 * 接线真实链路（observer → induction → ActivationProfileStore → shadow → 受控 promotion →
 * active discovery + cascade）：
 *
 *   pi.on("before_agent_start")            // 先刷新 active profiles（注册顺序先于 cortex）
 *     → registerSkillCortex({ inject, onDiscovery: push, onCatalog, overlayProfiles, overlayOptions })
 *     → registerPracticeObserver({ store, routeSnapshotSource, evidenceHook: pagination, onEvent })
 *     → pi.on("agent_settled")             // D1 admission 缺失时阻止 consolidation
 *
 * 受控 promotion（Seam 3）：report 只能来自冻结 real-skill 评估 provider（buildFrozenEvaluation）
 * + evaluateProfileForPromotion 重算；caller 无法注入手搓评估集/report/verdict。
 * host lifecycle（Seam 2）：agent_settled 编排 = 父 revision 漂移回 shadow + induction + 受控
 * promotion；evidence 删除级联经 runEvidenceDeletionCascade 单独接线（删除是外部触发）。
 *
 * 命令（项目根）：
 *   pi --no-session -ne -e ./src/evaluation/phase6/host-integration-entry.ts --print "<只读任务>"
 *
 * 不写用户环境、不写工作区外路径；store 落在 <cwd>/.skill-cortex/{practice,activation}。
 */
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import { registerLearningControls } from "../../adapters/pi/learning-controls.ts";
import {
  createDiscoverySnapshotSource,
  defaultTenantScope,
  registerPracticeObserver,
} from "../../adapters/pi/practice-observer.ts";
import { createPaginationEvidenceHook } from "../../adapters/pi/practice-pagination-hook.ts";
import {
  FROZEN_PROMOTION_OVERLAY,
  runActivationHostLifecycle,
} from "../../activation/host.ts";
import { LearningAssessmentStore } from "../../activation/admission-store.ts";
import { LearningControlStore } from "../../activation/learning-control-store.ts";
import { LearningControls } from "../../activation/learning-controls.ts";
import { ActivationProfileStore } from "../../activation/store.ts";
import type {
  ActivationProfile,
  PracticeEvent,
  SkillRecord,
} from "../../core/contracts/index.ts";
import { resolveAttribution } from "../../practice/policy/index.ts";
import { PracticeStore } from "../../practice/store/index.ts";
import { ExposureObservationStore } from "../../exposure/index.ts";

export const PHASE6_SHADOW_REPORT_ID = "shadow:phase6-host-001" as const;
export const PHASE6_PROMOTION_REPORT_ID = "promotion:phase6-host-001" as const;

export default function phase6HostIntegrationEntry(pi: ExtensionAPI): void {
  const projectRoot = process.cwd();
  const source = createDiscoverySnapshotSource();
  const practiceStore = new PracticeStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "practice"),
    projectRoot,
  });
  const activationStore = new ActivationProfileStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "activation"),
    projectRoot,
  });
  const assessmentStore = new LearningAssessmentStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "learning-assessments"),
    projectRoot,
  });
  const controlStore = new LearningControlStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "control"),
    projectRoot,
    tenantScope: defaultTenantScope(projectRoot),
  });
  const exposureStore = new ExposureObservationStore({
    rootDir: path.join(projectRoot, ".skill-cortex", "exposure"),
    projectRoot,
  });
  registerLearningControls(
    pi,
    new LearningControls(
      controlStore,
      assessmentStore,
      practiceStore,
      activationStore,
      defaultTenantScope(projectRoot),
    ),
  );

  // 内存管线状态（store 为唯一持久化真源；activeProfiles 每次 run 前从 store 刷新）。
  let catalogRecords: readonly SkillRecord[] = [];
  let activeProfiles: ActivationProfile[] = [];
  const eventsByParent = new Map<string, PracticeEvent[]>();

  // 先于 cortex 刷新 active profiles（注册顺序：本 handler 先执行，cortex 的 discovery
  // 后执行，故当次 discovery 能拿到最新 active overlay）。
  pi.on("before_agent_start", async () => {
    activeProfiles = await activationStore.listByStatus("active");
  });

  registerSkillCortex(pi, {
    mode: "inject",
    onDiscovery: (result) => source.push(result),
    onSearchExposure: (candidates) => source.exposeSearchCandidates(candidates),
    onCatalog: (records) => {
      catalogRecords = records;
    },
    overlayProfiles: () => activeProfiles,
    overlayOptions: { ...FROZEN_PROMOTION_OVERLAY },
  });

  registerPracticeObserver(pi, {
    store: practiceStore,
    projectRoot,
    routeSnapshotSource: source,
    evidenceHook: createPaginationEvidenceHook(),
    learningEnabled: async () => (await controlStore.status()).learningEnabled,
    onExposure: (record) => exposureStore.append(record),
    onEvent: (event) => {
      if (event.provenance !== "real") return;
      // observer 落盘时 store 用 policy 正规化 attribution（onEvent 收到的是 append 前原始值，
      // attribution 恒 unknown）；此处用同一 policy resolveAttribution 重算归一化后进 induction。
      if (resolveAttribution(event) !== "verified_skill_effect") return;
      const normalized: PracticeEvent = { ...event, attribution: "verified_skill_effect" };
      const list = eventsByParent.get(normalized.parentSkillId) ?? [];
      list.push(normalized);
      eventsByParent.set(normalized.parentSkillId, list);
    },
  });

  pi.on("agent_settled", async () => {
    // Phase 7 Seam 2：host lifecycle 编排（父 revision 漂移回 shadow + induction + 受控 promotion）。
    await runActivationHostLifecycle({
      store: activationStore,
      eventsByParent,
      assessmentSource: assessmentStore,
      tenantScope: defaultTenantScope(projectRoot),
      learningEnabled: (await controlStore.status()).learningEnabled,
      catalogRecords,
      shadowReportId: PHASE6_SHADOW_REPORT_ID,
      promotionReportId: PHASE6_PROMOTION_REPORT_ID,
    });
    eventsByParent.clear();
  });
}

/** 供 E2E 测试在隔离 fixture 根构造同一 store 路径（单真源断言/播种）。 */
export function phase6ActivationStore(root: string): ActivationProfileStore {
  return new ActivationProfileStore({
    rootDir: path.join(root, ".skill-cortex", "activation"),
    projectRoot: root,
  });
}

/** 供 E2E 测试在隔离 fixture 根构造同一 practice store 路径（evidence 删除级联断言）。 */
export function phase6PracticeStore(root: string): PracticeStore {
  return new PracticeStore({
    rootDir: path.join(root, ".skill-cortex", "practice"),
    projectRoot: root,
  });
}

/** 供 E2E 测试验证暂停/恢复在宿主重载后的持久状态。 */
export function phase6LearningControlStore(root: string): LearningControlStore {
  return new LearningControlStore({
    rootDir: path.join(root, ".skill-cortex", "control"),
    projectRoot: root,
    tenantScope: defaultTenantScope(root),
  });
}

export function phase6ExposureStore(root: string): ExposureObservationStore {
  return new ExposureObservationStore({
    rootDir: path.join(root, ".skill-cortex", "exposure"),
    projectRoot: root,
  });
}
