import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { registerSkillCortex } from "../../adapters/pi/index.ts";
import {
  registerContributionAssessmentObserver,
  type ContributionAssessmentSink,
} from "../../adapters/pi/contribution-assessment-observer.ts";
import {
  createDiscoverySnapshotSource,
  defaultTenantScope,
  registerPracticeObserver,
  type EvidenceHook,
} from "../../adapters/pi/practice-observer.ts";
import { LearningAssessmentStore } from "../../activation/admission-store.ts";
import type { PositiveContributionVerifier } from "../../activation/contribution-verifier.ts";
import type { SkillRecord } from "../../core/contracts/index.ts";
import { buildSkillRecord } from "../../core/registry/index.ts";
import { mapSkills } from "../../adapters/pi/core.ts";
import { PracticeStore } from "../../practice/store/index.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PROMPT = "Use the bounded contribution fixture and return its exact marker.";
const VERIFIED_OUTPUT = "BOUND_VERIFIED_OUTPUT";
const WRONG_OUTPUT = "UNVERIFIED_OUTPUT";
const OPERATION_CLASS = "bounded-marker-check";
const PRACTICE_VERIFIER_ID = "bounded-marker-practice-result";

describe("D1 contribution assessment real AgentSession host seam", () => {
  it("agent_end 最终结果 + persisted PracticeEvent + exact registration 才写 assessment", async (t) => {
    const fixtureRoot = await mkdtemp(path.join(PROJECT_ROOT, ".tmp-d1-contribution-host-"));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const skillDir = path.join(fixtureRoot, "skills", "bounded-contribution");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: bounded-contribution\ndescription: Return a deterministic bounded marker.\n---\n\n# Bounded contribution\n\nReturn exactly ${VERIFIED_OUTPUT}.\n`,
      "utf8",
    );

    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const practice = new PracticeStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "practice"),
      projectRoot: fixtureRoot,
    });
    const assessments = new LearningAssessmentStore({
      rootDir: path.join(fixtureRoot, ".skill-cortex", "learning-assessments"),
      projectRoot: fixtureRoot,
    });
    const source = createDiscoverySnapshotSource();
    let catalogRecords: readonly SkillRecord[] = [];
    let sink: ContributionAssessmentSink | undefined;
    const results: Array<{ reason: string; eventId: string }> = [];
    const errors: string[] = [];

    const evidenceHook: EvidenceHook = {
      async collect(run) {
        if (run.prompt !== PROMPT) return undefined;
        return {
          steps: [{ actor: "agent", operationClass: OPERATION_CLASS, outcome: "ok" }],
          verifierResults: [{ verifierId: PRACTICE_VERIFIER_ID, result: "pass" }],
        };
      },
    };

    const loader = new DefaultResourceLoader({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      settingsManager,
      additionalSkillPaths: [skillDir],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          registerSkillCortex(pi, {
            mode: "inject",
            onDiscovery: (result) => source.push(result),
            onCatalog: (records) => {
              catalogRecords = records;
            },
          });
          registerPracticeObserver(pi, {
            store: practice,
            projectRoot: fixtureRoot,
            routeSnapshotSource: source,
            evidenceHook,
            onEvent: (event, context) => sink?.onPracticeEvent(event, context),
          });
          sink = registerContributionAssessmentObserver(pi, {
            eventSource: practice,
            assessmentStore: assessments,
            catalogRecords: () => catalogRecords,
            verifiers: () => {
              const parent = catalogRecords[0];
              if (parent === undefined) return [];
              const verifier: PositiveContributionVerifier = {
                verifierId: "bounded-marker-contribution-verifier",
                parentSkillId: parent.skillId,
                parentSkillRevision: parent.skillRevision,
                sourceHash: parent.sourceHash,
                requiredOperationClass: OPERATION_CLASS,
                requiredPracticeVerifierId: PRACTICE_VERIFIER_ID,
                verify: async (_event, evidence) =>
                  evidence.userPrompt === PROMPT && evidence.finalAssistantText === VERIFIED_OUTPUT
                    ? "verified_contribution"
                    : "unverified",
              };
              return [verifier];
            },
            onResult: (result, event) => {
              results.push({ reason: result.reason, eventId: event.eventId });
            },
            onError: (error) => {
              errors.push(error instanceof Error ? error.message : String(error));
            },
          });
        },
      ],
    });
    await loader.reload();
    const hostSkill = loader.getSkills().skills[0]!;
    const parent = await buildSkillRecord(mapSkills([hostSkill])[0]!);

    const faux = fauxProvider({
      provider: "d1-contribution-host-fixture",
      api: "d1-contribution-host-fixture-api",
      models: [{ id: "d1-contribution-host-fixture-model", reasoning: false }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("load_skill", { skill_id: parent.skillId, skill_revision: parent.skillRevision }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(VERIFIED_OUTPUT),
      fauxAssistantMessage(
        fauxToolCall("load_skill", { skill_id: parent.skillId, skill_revision: parent.skillRevision }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(WRONG_OUTPUT),
    ]);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    const { session } = await createAgentSession({
      cwd: fixtureRoot,
      agentDir: path.join(fixtureRoot, "agent"),
      modelRuntime: runtime,
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: ["read", "load_skill"],
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(fixtureRoot),
    });

    await session.prompt(PROMPT);
    await session.prompt(PROMPT);

    const tenantScope = defaultTenantScope(fixtureRoot);
    const events = await practice.queryEvidence(tenantScope);
    const storedAssessments = await assessments.list(tenantScope);
    assert.equal(events.length, 2);
    assert.equal(storedAssessments.length, 1, JSON.stringify({ results, errors }));
    assert.equal(storedAssessments[0]!.eventId, results[0]!.eventId);
    assert.deepEqual(results.map((item) => item.reason), ["stored", "contribution_unverified"]);
    assert.deepEqual(errors, []);
    const persisted = JSON.stringify({ events, storedAssessments });
    assert.equal(persisted.includes(PROMPT), false);
    assert.equal(persisted.includes(VERIFIED_OUTPUT), false);
    assert.equal(persisted.includes(WRONG_OUTPUT), false);
  });
});
