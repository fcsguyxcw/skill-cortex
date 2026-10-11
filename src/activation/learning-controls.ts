import type { ActivationProfile } from "../core/contracts/index.ts";
import { EVENT_ID_RE, type PracticeStore } from "../practice/store/index.ts";
import { LearningAssessmentStore } from "./admission-store.ts";
import { LearningControlStore } from "./learning-control-store.ts";
import {
  transitionProfileToRetired,
  transitionProfileToSuspended,
  type ActiveActivationProfile,
  type RetirableProfile,
  type SuspendableProfile,
  type SuspendedActivationProfile,
} from "./state.ts";
import { ActivationProfileStore, applyEvidenceDeletionCascade } from "./store.ts";

export interface LearningStatus {
  learningEnabled: boolean;
  staticDiscoveryEnabled: true;
  activeOverlayContinuesWhilePaused: true;
  activeProfileCount: number;
  profileCount: number;
}

export interface MemorySummary {
  profileId: string;
  parentSkillId: string;
  parentSkillRevision: string;
  status: ActivationProfile["status"];
  cueCount: number;
  evidenceIds: readonly string[];
}

export class LearningControls {
  readonly controlStore: LearningControlStore;
  readonly assessmentStore: LearningAssessmentStore;
  readonly practiceStore: PracticeStore;
  readonly activationStore: ActivationProfileStore;
  readonly tenantScope: string;

  constructor(
    controlStore: LearningControlStore,
    assessmentStore: LearningAssessmentStore,
    practiceStore: PracticeStore,
    activationStore: ActivationProfileStore,
    tenantScope: string,
  ) {
    this.controlStore = controlStore;
    this.assessmentStore = assessmentStore;
    this.practiceStore = practiceStore;
    this.activationStore = activationStore;
    this.tenantScope = tenantScope;
  }

  async status(): Promise<LearningStatus> {
    const [control, profiles] = await Promise.all([
      this.controlStore.status(),
      this.activationStore.listCurrent(),
    ]);
    return {
      learningEnabled: control.learningEnabled,
      staticDiscoveryEnabled: true,
      activeOverlayContinuesWhilePaused: true,
      activeProfileCount: profiles.filter((profile) => profile.status === "active").length,
      profileCount: profiles.length,
    };
  }

  async list(options: { skillId?: string } = {}): Promise<MemorySummary[]> {
    const profiles = await this.activationStore.listCurrent();
    return profiles
      .filter((profile) => options.skillId === undefined || profile.parentSkillId === options.skillId)
      .sort((a, b) => a.profileId.localeCompare(b.profileId))
      .map((profile) => {
        const cues = [
          ...profile.learnedAliases,
          ...profile.positiveExamples,
          ...profile.nearMissExamples,
          ...profile.environmentCues,
        ];
        return {
          profileId: profile.profileId,
          parentSkillId: profile.parentSkillId,
          parentSkillRevision: profile.parentSkillRevision,
          status: profile.status,
          cueCount: cues.length,
          evidenceIds: [...new Set(cues.flatMap((cue) => cue.evidenceIds))].sort(),
        };
      });
  }

  setLearning(enabled: boolean) {
    return this.controlStore.setLearning(enabled);
  }

  async forget(target: { evidenceId?: string; profileId?: string }): Promise<{
    invalidatedEvidenceIds: readonly string[];
    affectedProfileIds: readonly string[];
  }> {
    const targetCount = Number(target.evidenceId !== undefined) + Number(target.profileId !== undefined);
    if (targetCount !== 1) throw new Error("learning_forget_requires_exactly_one_target");
    if (target.evidenceId !== undefined) {
      const [practice, assessment] = await Promise.all([
        EVENT_ID_RE.test(target.evidenceId)
          ? this.practiceStore.invalidate(this.tenantScope, [target.evidenceId])
          : Promise.resolve({ invalidatedEventIds: [] }),
        this.assessmentStore.invalidate(this.tenantScope, [target.evidenceId]),
      ]);
      const invalidated = [...new Set([
        ...practice.invalidatedEventIds,
        ...assessment.invalidatedEventIds,
      ])].sort();
      const cascade = await applyEvidenceDeletionCascade(this.activationStore, invalidated, "user");
      return { invalidatedEvidenceIds: invalidated, affectedProfileIds: cascade.suspended };
    }

    const profile = await this.activationStore.getProfile(target.profileId!);
    if (profile === undefined || profile.status === "retired") {
      return { invalidatedEvidenceIds: [], affectedProfileIds: [] };
    }
    let retirable: RetirableProfile;
    if (profile.status === "active" || profile.status === "suspended") {
      retirable = profile as ActiveActivationProfile | SuspendedActivationProfile;
    } else {
      const suspended = transitionProfileToSuspended(profile as SuspendableProfile, {
        decision: "suspended",
        reason: "user_forget_profile",
      });
      await this.activationStore.transition(profile, suspended, {
        trigger: "user",
        reason: "user_forget_profile",
      });
      retirable = suspended;
    }
    const retired = transitionProfileToRetired(retirable, {
      decision: "retired",
      reason: "user_forget_profile",
    });
    await this.activationStore.transition(retirable, retired, {
      trigger: "user",
      reason: "user_forget_profile",
    });
    return { invalidatedEvidenceIds: [], affectedProfileIds: [profile.profileId] };
  }
}
