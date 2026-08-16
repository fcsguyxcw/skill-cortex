/**
 * Phase 4 — Execution Resolver 运行时模块。
 *
 * 纯函数、确定性、无副作用：resolveExecution（快/慢/abstain 决策）、checkGuards
 * （前置/runtime/postcondition guard）、resolveFallback（安全停止与回退）。
 * 不启动 canary/active、不修改 procedure 状态、不执行任何副作用。
 */
export * from "./resolver.ts";
export * from "./guard.ts";
export * from "./fallback.ts";
