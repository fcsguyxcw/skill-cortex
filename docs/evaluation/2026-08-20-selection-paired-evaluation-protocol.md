# Selection Paired Evaluation Protocol

日期：2026-08-20  
状态：**Dev v1 与 final-heldout v1 首次揭示均已完成；final-heldout 冻结 gate 未通过**

## 1. 评测主张

本评测只回答：在相同主模型、相同任务和相同选择指令下，把全量 Skill descriptions
替换为 prompt 外检索产生的 Top-K Skill Cards 后，Skill exact-set selection 是否保持非劣，
同时减少模型可见输入规模。

它不评估 procedure 执行质量，也不把 retrieval recall、Selection 和执行成功率合并为一个分数。

## 2. Paired arms

| Arm | 模型可见 Skill 信息 | 其他条件 |
|---|---|---|
| `full_catalog` | 当次冻结 catalog 的全部 `skill_id + name + description` | 与 treatment 相同 |
| `top_k` | 同一 catalog 经当前 BM25/Activation overlay 后的 Top-K Candidate Cards | 与 baseline 相同 |

两臂必须使用同一 provider、model、thinking level、system instruction、输出 schema、案例顺序策略和
重复次数。模型调用禁用 skills、tools、extensions、context files 和 session persistence，避免额外
Skill metadata 或工作区指令污染实验。

模型唯一允许的输出形状：

```json
{"selected_skill_ids":["skill:..."]}
```

空数组表示 No-Skill。重复 ID、catalog 外 ID、非严格 JSON 或额外字段均视为失败，不做宽松修复。

## 3. 数据边界

### 3.1 Runner fixture

现有 Phase 1 synthetic catalog/cases 只用于验证 runner、解析器和指标计算。其输出固定标记为
`evaluation_fixture`，不得写成真实模型 Selection 证据，也不得用于简历中的准确率主张。

### 3.2 Real-skill Gold Set

正式案例必须满足 ADR-0005：

- query 由人工编写或来自经脱敏、人工复核的真实任务表达；
- `gold_skill_ids` 由用户人工复核，不能来自当前 retriever 或模型选择；
- single-skill、multi-skill、no-skill、hard-confuser 和跨语言分栏；
- query 不机械复制 Skill name/description；
- dev 与 final-heldout 在任何模型结果产生前分离并冻结 hash；
- final-heldout 结果出现后，不修改 query、gold、Top-K 或选择 prompt。

Gold Set 必须绑定完整 catalog snapshot，而不是只绑定 case 文本。规范化 hash 覆盖按 `skillId`
排序后的 `{skillId, skillRevision, name, description}`；Gold hash 另覆盖 catalog hash，以及按 case ID
排序的 `{id, query, goldSkillIds}`，其中 `goldSkillIds` 也排序。任一 Skill 增删、revision 或
description 改变后，旧 Gold 自动失效并需重审。

冻结 artifact 分两层：公开 integrity manifest 保存 `skillId / name / skillRevision / descriptionHash`；
可重建 evaluation snapshot 保存 `skillId / name / skillRevision / description`。二者都不保存 source path
或 Skill 正文，并分别记录 entries hash。

标注采用“最小充分 Skill 集合”：通用工作流 Skill 若被更具体 Skill 完整覆盖，不重复加入；若多个
Skill 各自都能完整完成任务，则该案例不具备唯一 exact-set Gold，必须在模型运行前改写或替换。

dev 用于验证协议；final-heldout 候选只保留具有唯一 exact-set Gold 的案例，不为维持预设数量而强行
标注重叠能力。正式运行次数与非劣阈值在查看 final-heldout 结果前，根据 dev 的失败分类和预算另行冻结。

## 4. 分层指标

### 4.1 Retrieval availability（仅 `top_k`）

- `gold_available_rate`：所有 gold 均出现在 Top-K 的比例；No-Skill 案例按 available 处理。
- `retrieval_miss_rate`：至少一个 gold 未进入 Top-K 的比例。

retrieval miss 不改写成模型错选；报告中必须单列。

### 4.2 Selection quality（两臂分别报告）

- `exact_set_accuracy`：预测集合与 gold 集合完全相等，顺序无关。
- `exact_set_accuracy_when_gold_available`：只在模型可见集合含全部 gold 时计算。
- `parse_failure_rate`。
- `invalid_skill_id_rate`。
- single / multi / no-skill / hard-confuser / language 分栏结果。

解析失败、重复 ID 和 catalog 外 ID均计为 Selection 失败。

### 4.3 Cost and latency

- prompt chars 与明确标记为 estimate 的 input tokens；
- 若宿主 JSON event 提供 usage，则另报 actual input/output/cache tokens；
- 每臂 latency mean / p50 / p95；
- 模型调用数与失败调用数。

估算 token 不得表述为 provider 计费 token。

## 5. 运行顺序与防污染

### 5.1 Dev v1 冻结运行参数

以下参数在查看 dev 模型输出前冻结：

- provider/model：`deepseek/deepseek-v4-flash`；API：`openai-completions`；
- thinking：`high`；temperature：`0`；max output tokens：`256`；
- Top-K：`5`；每个 case 每臂一次调用；
- timeout：`120000 ms`；provider retry：`0`；
- arm order：全部 `full_catalog`，随后全部 `top_k`；每次调用无 session、tools 或历史消息；
- 只保存解析后的 Skill IDs、原始回复 SHA-256、usage、latency 和受控失败类别；不保存完整 prompt 或原始回复。

Dev v1 用于暴露协议、retrieval 与 parser 问题，不用于冻结 final 非劣阈值，也不作为最终 benchmark。

1. 冻结 catalog snapshot、dev/final cases、prompt schema、provider/model 和 runner commit；记录 catalog hash 与 Gold hash。
2. 用户人工复核并确认 Gold Set；记录文件 hash。
3. 只运行 dev，修复协议或解析问题；不得查看 final 输出。
4. 冻结正式重复次数和非劣阈值。
5. 一次性运行 final paired evaluation，原始结构化输出只写 project-local report。
6. 报告 baseline/treatment 全部分栏、失败案例和证据边界，不挑样本、不压成综合分。

### 5.2 Final-heldout 揭示与复用政策

首次 final-heldout v1 的任何 case-level 或 aggregate 结果一旦被开发者查看，v1 即成为 revealed set。
此后若根据 v1 的 retrieval miss、Selection error、分数或其他结果修改 retriever、alias、Top-K、
candidate-card 序列化、模型提示、routing/selection logic、fallback 或其他被测行为，则不得再把 v1
重跑结果作为独立 held-out 证据。v1 可继续用于明确标注的 regression；新的独立最终证据必须来自此前
未运行、未用于调参的新 held-out 版本，并保留 v1 的原 cases、Gold、配置和首次报告。

### 5.3 Gold 与运行配置分别绑定

`GoldSetHash` 只标识 catalog-bound cases/Gold。每次正式运行还必须计算并写入独立
`EvaluationRunConfigHash`，至少绑定：

- catalog snapshot hash、Gold hash、threshold config hash；
- provider/model/API/model revision；reasoning、temperature、max tokens、timeout、retry；
- Selection prompt hash、Top-K；
- retriever 名称与 implementation revision；
- candidate-card serialization revision；
- host package/version、arm order、supplemental tool 开关。

正式 runner 若缺任一必填字段必须 fail closed，不得只依赖 Markdown 中的人工记录。

Final v1 已冻结的 EvaluationRunConfig hash 为
`sha256:30dbdaa057ba98c2fdbb622108e0d16a1fce1c8ba5ba8af53360768550e3ab7b`。
当前 provider 不暴露不可变后端 revision，因此模型版本字段如实记录为 dated provider alias
`provider-alias:deepseek-v4-flash@2026-08-20`；这是一项复现限制，不得表述为已获得隐藏的 provider build ID。

### 5.4 Final v1 冻结门槛

门槛在查看 final-heldout 输出前冻结，机器身份为：
`sha256:df11ad053b95508b265ec48966525b0bfb20933b74f84cd7565644ece0d0fb0d`。

| Gate | 冻结值 | Dev v1 依据 |
|---|---:|---|
| Top-K retrieval Gold availability | `>= 0.80` | dev 为 `12/14 = 0.857`，保留小样本波动空间 |
| Gold-available 同案例 paired exact-set 回归 | `<= 0.05` | dev 同子集 baseline/treatment 均为 `11/12` |
| No-Skill accuracy 回归 | `<= 0` | No-Skill 是安全边界，不接受相对 baseline 退化 |
| strict parse failure rate | `0` | 输出协议错误不作宽松修复 |
| invalid Skill ID case rate | `0` | catalog/unlisted ID 均为协议失败 |
| actual input token reduction | `>= 0.80` | dev treatment 相对 baseline 减少 `97.33%` |

single、multi、no-skill、hard-confuser、中文、英文与 overall 均为必报分栏，但不以一个加权总分
替代上述独立 gate。门槛实现见 `src/evaluation/selection/final-thresholds.ts`；
`src/evaluation/selection/final-verdict.ts` 在报告落盘前按冻结配置自动生成分栏与逐项 verdict，
usage 缺失时成本 gate fail closed。

### 5.5 首次揭示操作门

正式入口为 `src/evaluation/selection/run-final.ts`。无显式确认参数时必须在 catalog 加载和 provider
调用前拒绝；唯一允许的首次揭示命令为：

```powershell
node src/evaluation/selection/run-final.ts --confirm-first-reveal
```

入口还必须在首个 provider call 前确认：v1 报告文件不存在、四个源码 revision 未漂移、catalog / Gold /
threshold / EvaluationRunConfig hash 全部匹配。报告已存在时不得覆盖或再次运行 v1。

## 6. 当前成功标准

本轮实现成功只要求：

- paired runner 与严格解析器存在；
- synthetic fixture 合同测试通过；
- retrieval miss 与 Selection error 可分离；
- 报告包含输入规模、延迟和错误分栏；
- injected/fake invoker 不能把结果升级为真实模型证据；
- 正式 Gold Set 未经用户复核时，真实模型 runner 必须拒绝 final 执行。

真实 Selection 质量是否非劣目前仍是**未验证**，不能因 runner 测试通过而关闭 Phase 7 Selection 边界。
