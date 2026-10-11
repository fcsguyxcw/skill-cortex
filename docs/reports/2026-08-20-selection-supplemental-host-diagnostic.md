# Selection 补搜真实宿主诊断

日期：2026-08-20  
证据级别：**真实 Pi `AgentSession` + 真实主模型的聚焦开发集诊断；不是 final-heldout，也不并入原 paired 分数**

## 结论

- D01、D04 的初始 Top-K 均缺失人工 Gold；
- 主模型在两条案例中都主动调用了一次 `search_skills`，两次 query 都含英文字符；
- D04 补搜后选中 `architecture-designer`，exact-set 正确；
- D01 补搜后仍返回空集合，exact-set 错误；
- 因此，当前补搜链能恢复部分跨语言 lexical miss，但不能视为稳定修复。

## 运行边界

- 模型：`deepseek/deepseek-v4-flash`；thinking=`high`；temperature 为宿主默认值，API 未暴露本次实际值；
- 链路：Pi `AgentSession → before_agent_start → Top-K prompt rewrite → 主模型 tool_call → search_skills → tool_result → 主模型最终 JSON`；
- 每条案例使用新建的内存 Session；未启用 PracticeObserver；未写用户环境；
- 工具仅允许 `read` 与 `search_skills`。`read` 用于使 Pi 构建原生 Skill block，模型本次未调用它；
- 不保存原始 prompt、原始回复或补搜 query，只保存 hash、长度、语言特征、Skill ID、usage 与 latency；
- catalog hash：`sha256:9190e01aa3ea13951f7b60027fb03aeae79cf1c056cebe74acc7e24d939ffcd7`；
- dev Gold hash：`sha256:45af7f527178dd47903845984b64916a827e1cb6be747cec90cd87d614708966`。

## 结果

| Case | 初始 Gold 可见 | 调用补搜 | 英文改写证据 | 最终选择 | Exact-set | 延迟 | 总 token |
|---|---|---|---|---|---|---:|---:|
| D01 | 否 | 1 次 | `hasLatin=true` | `[]` | 否 | 4741 ms | 3464 |
| D04 | 否 | 1 次 | `hasLatin=true` | `architecture-designer` | 是 | 5321 ms | 3904 |

## 不能外推的内容

- 2 条开发集 miss 只能证明 focused rescue 行为，不能估计总体补搜成功率；
- 本结果不能与原 `full_catalog` / `top_k` 两臂直接合并，因为补搜新增了工具 schema、模型轮次、成本与延迟；
- 当前 PracticeObserver 不把 `search_skills` 返回的 Top-K 外候选纳入 route snapshot，因此本诊断不证明补搜结果已进入 Practice Store 或 Activation learning；
- D01 失败说明下一步不能只依赖模型英文改写。应先冻结并人工确认独立 held-out，再评估通用跨语言 alias/补搜策略，禁止根据这两条开发案例直接堆叠中文关键词。

机器可读证据见 `2026-08-20-selection-supplemental-host-diagnostic.json`。
