import type { SkillScope } from "../contracts/index.ts";

/**
 * 明确的 Skill package 输入（宿主 adapter 负责把宿主 Skill/SourceInfo 映射到此形状）。
 *
 * 规则（冻结于 Phase 0 baseline §3）：
 * - baseDir 必须是绝对路径；身份与哈希完全由此派生，宿主不提供稳定 ID。
 * - declaredAliases / declaredPermissions / declaredEffects 只接收调用方从作者声明中
 *   显式解析的结果；Registry 不做任何推断（不解析 frontmatter、不扫描脚本、不读未知字段）。
 *   未提供时视为“作者未声明”，落库为空数组。
 * - 文件内容、秘密与原始工具输出一律不进入 SkillRecord，仅保存哈希与元数据。
 */
export interface SkillPackageInput {
  /** 作者提供的 Skill 名（宿主 Skill.name）。 */
  name: string;
  /** 作者提供的完整描述（宿主 Skill.description）。 */
  description: string;
  /** 宿主 SourceInfo.scope："user" | "project" | "temporary"。 */
  scope: SkillScope;
  /** Skill 根目录绝对路径（宿主 Skill.baseDir）。 */
  baseDir: string;
  /** SKILL.md 绝对路径；缺省为 baseDir/SKILL.md。 */
  skillMdPath?: string;
  /** 宿主 Skill.disableModelInvocation；buildSkillCatalog 会过滤 true 的条目。 */
  disableModelInvocation?: boolean;
  /** 作者显式声明的别名（调用方解析结果），不得推断。 */
  declaredAliases?: readonly string[];
  /** 作者显式声明的权限（调用方解析结果），不得推断。 */
  declaredPermissions?: readonly string[];
  /** 作者显式声明的副作用（调用方解析结果），不得推断。 */
  declaredEffects?: readonly string[];
}

/** buildSkillRecord 选项；now 仅用于测试注入确定性时间。 */
export interface BuildSkillRecordOptions {
  now?: Date;
}
