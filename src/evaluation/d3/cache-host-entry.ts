import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSkillCortex, type DiscoveryResult } from "../../adapters/pi/index.ts";

interface CacheHostObservation {
  cache: DiscoveryResult["cache"];
  recordCount: number;
  candidates: Array<{ skillId: string; skillRevision: string; name: string }>;
}

/** Evaluation-only host entry：不写 Store、不启用 active overlay、不进入生产插件入口。 */
export default function cacheHostEntry(pi: ExtensionAPI): void {
  const observations: CacheHostObservation[] = [];

  registerSkillCortex(pi, {
    mode: "shadow",
    onDiscovery: (result) => {
      observations.push({
        cache: result.cache,
        recordCount: result.recordCount,
        candidates: result.candidates.map(({ skillId, skillRevision, name }) => ({
          skillId,
          skillRevision,
          name,
        })),
      });
    },
  });

  pi.registerTool(
    defineTool({
      name: "d3_cache_observations",
      label: "D3 Cache Observations",
      description: "Evaluation-only cache observation reader.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: `D3 cache observations: ${observations.length}` }],
          details: { observations: structuredClone(observations) },
        };
      },
    }),
  );
}
