/**
 * D1 Pi host seam for contribution assessment.
 *
 * Raw prompt/final assistant text stays in memory. The observer waits until PracticeObserver has
 * persisted an event, then passes both to the exact-bound trusted verifier. It never self-registers
 * a verifier and never turns an ordinary Practice verifier pass into contribution evidence.
 */
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { PracticeEvent, SkillRecord } from "../../core/contracts/index.ts";
import type { LearningAssessmentEventSource } from "../../activation/admission-store.ts";
import { LearningAssessmentStore } from "../../activation/admission-store.ts";
import {
  type PositiveContributionVerifier,
  type VerifyAndStoreContributionResult,
  verifyAndStorePositiveContribution,
} from "../../activation/contribution-verifier.ts";
import type { PracticeObserverEventContext } from "./practice-observer.ts";

const MAX_HOST_EVIDENCE_CHARS = 131_072;

export interface ContributionAssessmentObserverOptions {
  eventSource: LearningAssessmentEventSource;
  assessmentStore: LearningAssessmentStore;
  catalogRecords: () => readonly SkillRecord[];
  verifiers: () => readonly PositiveContributionVerifier[];
  assessedAt?: () => string;
  onResult?: (
    result: VerifyAndStoreContributionResult,
    event: PracticeEvent,
  ) => void | Promise<void>;
  onError?: (error: unknown, phase: "capture" | "finalize") => void;
}

export interface ContributionAssessmentSink {
  onPracticeEvent(event: PracticeEvent, context: PracticeObserverEventContext): void;
}

interface PendingRun {
  prompt?: string;
  finalAssistantText?: string;
  events: PracticeEvent[];
}

function sessionIdFrom(context: unknown): string | undefined {
  const sessionManager = (context as { sessionManager?: { getSessionId?: () => string } })
    ?.sessionManager;
  if (typeof sessionManager?.getSessionId !== "function") return undefined;
  try {
    const sessionId = sessionManager.getSessionId();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function bounded(value: string): string | undefined {
  return value.length > 0 && value.length <= MAX_HOST_EVIDENCE_CHARS ? value : undefined;
}

function finalAssistantText(event: AgentEndEvent): string | undefined {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "stop") return undefined;
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    return bounded(text);
  }
  return undefined;
}

/**
 * Register after PracticeObserver and route its onEvent callback into the returned sink. Pi invokes
 * handlers in registration order, so the PracticeEvent is persisted before assessment finalization.
 */
export function registerContributionAssessmentObserver(
  pi: ExtensionAPI,
  options: ContributionAssessmentObserverOptions,
): ContributionAssessmentSink {
  const pendingBySession = new Map<string, PendingRun>();

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, context) => {
    try {
      const sessionId = sessionIdFrom(context);
      if (sessionId === undefined) return;
      pendingBySession.set(sessionId, { prompt: bounded(event.prompt), events: [] });
    } catch (error) {
      options.onError?.(error, "capture");
    }
  });

  pi.on("agent_end", (event: AgentEndEvent, context) => {
    try {
      const sessionId = sessionIdFrom(context);
      if (sessionId === undefined) return;
      const pending = pendingBySession.get(sessionId);
      if (pending === undefined) return;
      pending.finalAssistantText = finalAssistantText(event);
    } catch (error) {
      options.onError?.(error, "capture");
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    const sessionId = sessionIdFrom(context);
    if (sessionId === undefined) return;
    const pending = pendingBySession.get(sessionId);
    pendingBySession.delete(sessionId);
    if (pending === undefined) return;
    try {
      for (const event of pending.events) {
        const result = await verifyAndStorePositiveContribution({
          tenantScope: event.tenantScope,
          eventId: event.eventId,
          eventSource: options.eventSource,
          assessmentStore: options.assessmentStore,
          catalogRecords: options.catalogRecords(),
          verifiers: options.verifiers(),
          ...(pending.prompt !== undefined && pending.finalAssistantText !== undefined
            ? {
                verificationEvidence: {
                  userPrompt: pending.prompt,
                  finalAssistantText: pending.finalAssistantText,
                },
              }
            : {}),
          ...(options.assessedAt !== undefined ? { assessedAt: options.assessedAt } : {}),
        });
        await options.onResult?.(result, event);
      }
    } catch (error) {
      options.onError?.(error, "finalize");
    }
  });

  return {
    onPracticeEvent(event, context) {
      const pending = pendingBySession.get(context.sessionId);
      if (pending === undefined) return;
      pending.events.push(event);
    },
  };
}
