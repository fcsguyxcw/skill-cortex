# Phase 1 Gate P1 验收报告

日期：2026-08-14  
状态：**PASS**  
范围：project-local Registry、静态 BM25 discovery、候选卡、补搜工具与默认 shadow Pi adapter

## 1. 实际交付

- `src/core/contracts/`：冻结的数据合同 TypeScript 形状。
- `src/core/registry/`：完整 SHA-256 的 Skill 身份、source/revision、dependency manifest 与路径边界。
- `src/discovery/`：确定性 tokenizer、BM25、词法相关性 guard 与有界候选卡。
- `src/adapters/pi/`：基于当前真实 `ExtensionAPI`、`defineTool`、`Type.Object` 的薄适配层。
- `.pi/extensions/skill-cortex/`：project-local 入口，默认 `shadow`，不修改 system prompt。
- `src/evaluation/phase1/`：single/multi/no-skill、中文 alias、模糊名称和 hard confuser smoke。

## 2. 验证命令与结果

```text
npm install --ignore-scripts --cache .npm-cache
  PASS；240 packages audited；0 vulnerabilities

npm test
  PASS；100 tests；99 pass；0 fail；1 skip

npm run typecheck
  PASS；tsc --noEmit；覆盖 src/**/*.ts 与 .pi/**/*.ts

project-local extension runtime import smoke
  PASS；注册 before_agent_start handler 与 search_skills TypeBox object schema

production anti-pattern rg
  PASS；Router LLM、appendEntry、PracticeEvent 写入、CATEGORY_RULES、maturity/procedure ranking 命中 0
```

唯一 skip 是 Windows 当前权限不允许创建文件 symlink；junction 指向 baseDir 内、外以及角色目录逃逸均有实测。实现同时使用 `lstat`/`realpath`，拒绝链接形式的 `SKILL.md`，忽略 manifest 中的链接目录。

## 3. Smoke 指标

数据：8 个 synthetic Skill、9 个手工 smoke case；不作统计普适性声明。

| 指标 | 结果 |
|---|---:|
| Recall@5 | 1.0 |
| Set recall | 1.0 |
| No-skill accuracy | 1.0 |
| Router LLM calls | 0（结构性约束，不是运行时计费器） |
| 最大候选数 | 2 |
| 总候选卡字符 | 1283 |
| 估算 token | 324 |

p50/p95 与索引构建时间由每次 `npm test` 输出；该微型 smoke 的亚毫秒结果不代表真实 catalog 性能。

## 4. 安全与回退

- 默认入口只做 shadow；只有显式 `mode="inject"` 才追加 Top-K。
- Registry/index 失败时不修改原 system prompt，回到宿主原始 Skill 慢路径。
- `search_skills` 未初始化、构建失败、空查询或无匹配时均返回有界诊断，不返回全量 catalog。
- 模型可见错误只包含稳定错误类别，不含绝对路径或原始错误文本。
- Phase 1 不写 Practice Store、不调用 Router LLM、不写用户级 Pi 环境。
- Skill package 的自定义 `SKILL.md` 路径必须位于 real baseDir 内；链接逃逸与非 `ENOENT` I/O 错误不会静默形成 revision。

## 5. 已知限制

1. 真实 Pi `Skill` 类型不暴露作者 aliases；adapter 当前不解析未知 frontmatter，因此中文 alias 结果只证明 synthetic 明确 alias 的 BM25 链路，不证明真实 installed Skill 的跨语言召回。
2. 未运行真实 Pi 项目信任交互，也未把候选注入用户日常环境；入口运行验证使用 project-local fake host。
3. `onError` 可把原始错误交给调用方作本地诊断；默认入口不配置该回调。调用方不得将其直接持久化或注入模型。
4. 当前相关性 guard 是第一版词法规则；出现真实 hard confuser/跨语言 miss 后再按 ADR 提案，不增加 Router LLM。

## 6. Gate 结论

**Gate P1 = PASS。** project-local shadow、候选注入测试、补搜、确定性身份与安全回退均通过；正式环境仍无写入。可启动 Phase 2 Practice Store 与证据治理，但不得自动调权、编译或进入 procedure 快路径。
