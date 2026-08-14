# Phase 3 评测阈值与分区冻结（OFFSET Pagination 静态检测）

日期：2026-08-14
状态：Phase 3 Evaluation Owner 冻结（在查看任何候选 procedure 实现结果**之前**）
性质：评测设计合同。本文件冻结的阈值、分区与案例标签独立于候选实现；实现者不得据此反向调参 held-out 集。

---

## 1. 范围与目的

- 父 Skill：本机只读安装的 MIT `supabase-postgres-best-practices`。
- 研究对象：`references/data-pagination.md` 中 **OFFSET pagination 的静态检测** 这一稳定子过程。
- 候选 procedure 能力边界：给定一段 SQL 文本，判定其是否使用 OFFSET 分页；**只读、纯静态**。
- 明确禁止（属安全硬门，非性能建议）：不执行 SQL、不连接数据库、不自动改写 SQL、不发起网络。
- 本文件所有测试 SQL 均为项目原创，不复制外部正文。

## 2. Finding taxonomy（逐例预期输出）

候选 procedure 对单个输入输出一个 `finding`，其 `class` 属于以下四类之一：

| class | 语义 |
|---|---|
| `uses_offset` | 查询使用 OFFSET 分页（`LIMIT … OFFSET …`、`OFFSET … LIMIT …` 或 SQL 标准 `OFFSET … ROWS FETCH NEXT … ROWS ONLY`）。 |
| `uses_keyset` | 查询使用 keyset/cursor 分页（`WHERE` 游标谓词 + `ORDER BY` + `LIMIT`，无 OFFSET）。 |
| `no_pagination` | 查询无分页，或 `OFFSET` 仅以非分页形态出现（字符串字面量、注释、列名、窗口函数等）。 |
| `abstain` | 无法自信判定（语法残缺、歧义等）。abstain 是安全回退，其正确性见 §5/§6 计数规则。 |

## 3. 训练 / held-out 分区原则

1. **证据独立（ADR-0008 硬门 2）**：用于编写/调参 procedure 的案例（`train`）与用于验收的案例（`heldout`）严格不相交。
2. **标签不可变**：held-out 的案例、标签、顺序在本文件冻结为合同的一部分，任何阶段（含看结果后）不得改动。实现者可以查看合同（含案例与标签），但**不得以 held-out 上 procedure 的运行结果反向修正检测规则**；任何改规则必须重跑全量并声明，held-out 标签永不改。
3. **Owner 独立**：阈值与标签由 Evaluation Owner 在实现者产出任何结果**之前**冻结；Owner 不得在看过结果后回改标签或放宽阈值。若确需改动，须作为新的合同修订（等同新 ADR），不得就地覆盖。
4. **边角集中在 held-out**：所有“OFFSET 出现在非分页语境”的对抗性边角（字符串、注释、列名、窗口函数、SQL 标准 FETCH、CTE、残缺）全部放入 held-out，train 只保留规范形态。
5. 逐例预期 finding 已冻结（§4 表），作为 verifier 的 oracle。

## 4. 案例清单（原创 SQL，逐例预期 label + 分区）

`expected` 为冻结 oracle。`partition ∈ {train, heldout}`。

| id | partition | sql（原创） | expected |
|---|---|---|---|
| T01 | train | `SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40;` | uses_offset |
| T02 | train | `SELECT * FROM posts WHERE id > $1 ORDER BY id LIMIT 20;` | uses_keyset |
| T03 | train | `SELECT * FROM posts WHERE author_id = $1;` | no_pagination |
| T04 | train | `SELECT id, title FROM posts ORDER BY created_at DESC LIMIT 10;` | no_pagination |
| H01 | heldout | `SELECT * FROM posts ORDER BY id OFFSET 40 LIMIT 20;` | uses_offset |
| H02 | heldout | `SELECT * FROM posts ORDER BY id LIMIT $1 OFFSET $2;` | uses_offset |
| H03 | heldout | `SELECT * FROM posts ORDER BY id OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY;` | uses_offset |
| H04 | heldout | `SELECT * FROM (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) AS page;` | uses_offset |
| H05 | heldout | `WITH page AS (SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET 40) SELECT * FROM page;` | uses_offset |
| H06 | heldout | `SELECT 'OFFSET 20' AS hint;` | no_pagination |
| H07 | heldout | `SELECT * FROM posts; -- legacy OFFSET 20 removed` | no_pagination |
| H08 | heldout | `SELECT "offset", id FROM posts;` | no_pagination |
| H09 | heldout | `SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM posts;` | no_pagination |
| H10 | heldout | `SELECT * FROM posts WHERE (created_at, id) > ($1, $2) ORDER BY created_at, id LIMIT 20;` | uses_keyset |
| H11 | heldout | `SELECT * FROM posts WHERE created_at < $1 ORDER BY created_at DESC LIMIT 20;` | uses_keyset |
| H12 | heldout | `SELECT * FROM posts ORDER BY id LIMIT 20 OFFSET;` | abstain |
| H13 | heldout | `SELECT * FROM posts OFFSET;` | abstain |
| H14 | heldout | ``（空串） | abstain |
| H15 | heldout | `SELECT count(*) FROM posts;` | no_pagination |

统计：19 例 = train 4 + heldout 15。held-out 内 uses_offset 5（H01–H05）、no_pagination 5（H06–H09, H15）、uses_keyset 2（H10–H11）、abstain 3（H12–H14）。对抗性“OFFSET 非分页语境”全部在 held-out（H06–H09）。

## 5. 独立 deterministic verifier 合同

verifier 为纯函数，输入 `(case, finding)`，不读 procedure 内部、不调 LLM，输出 **二值** `pass` / `fail`：

```
verify(case, finding):
  1. 若 finding 非对象或缺失 class 字段 → fail("malformed_finding")
  2. 若 finding.class === case.expected：
        - expected=abstain 且 finding.class=abstain → 正确 abstain，走证据校验(3)后 pass
        - 否则（class 精确匹配）→ 走证据校验(3)后 pass
  3. 证据校验（仅当 finding.evidence?.matchText 存在时强制，否则直接 pass）：
        - case.sql.includes(finding.evidence.matchText) 必须为 true，否则 fail("evidence_not_in_input")
        - 对 uses_offset：matchText 必须含子串 "OFFSET"（大小写不敏感），否则 fail("evidence_keyword_mismatch")
  4. 其余（finding.class ≠ case.expected，含“expected≠abstain 但输出 abstain”的 unexpected abstain）→ fail("label_mismatch")
```

- **没有第三态**：abstain 要么是「期望 abstain 且输出 abstain」= pass（正确 abstain），要么是「期望非 abstain 但输出 abstain」= fail（unexpected abstain）。因此**全 abstain 无法逃过 accuracy**（见 §6 分母定义）。
- oracle（`case.expected`）在本文件冻结，构成 verifier 的独立判定基准（不依赖 procedure 或 LLM 自评，满足 ADR-0008 硬门 2/6）。
- 证据校验是结构不变量：procedure 声称命中的文本必须真实存在于输入 SQL，防“幻觉证据”。

## 6. 分项阈值与指标（独立报告，不合并为加权总分）

记 held-out 集为 `H`（|H|=15）。各子集：

- `H_offset = {c∈H : expected=uses_offset}`，|H_offset|=5
- `H_nonoffset = {c∈H : expected≠uses_offset}`，|H_nonoffset|=10
- `H_abstain = {c∈H : expected=abstain}`，|H_abstain|=3
- `H_nonabstain = {c∈H : expected≠abstain}`，|H_nonabstain|=12

**分母=0 规则**：任一指标分母为 0 时，该指标记为 `N/A`（不适用）并在报告中显式标注；`N/A` 既不算 0 也不算 1，不得进入 promotion 判定。本冻结集所有分母均 > 0（见上），故本次全部适用。

| 维度 | 指标 | 精确定义（分子/分母） | 阈值 |
|---|---|---|---|
| 成功/质量 | accuracy | \|{c∈H : verify=pass}\| / \|H\| | **≥ 0.95** |
| 成功/质量 | offset recall | \|{c∈H_offset : verify=pass}\| / \|H_offset\| | **= 1.0（硬门）** |
| 成功/质量 | offset false-positive rate | \|{c∈H_nonoffset : finding=uses_offset}\| / \|H_nonoffset\| | **≤ 0.05** |
| 成功/质量 | expected-abstain recall | \|{c∈H_abstain : verify=pass}\| / \|H_abstain\| | **= 1.0** |
| 回退 | abstain rate | \|{c∈H : finding=abstain}\| / \|H\| | **≤ 0.20** |
| 回退 | unexpected-abstain rate | \|{c∈H_nonabstain : finding=abstain}\| / \|H_nonabstain\| | **≤ 0.10** |
| 安全（结构化） | 无执行/连接/网络/自动改写 | 静态审查 + 测试，非比例指标 | 硬门（§7） |
| 成本 | N_break-even（字节口径） | 见 §6.1 | **≤ 10** |

**防逃逸说明**：accuracy 分母是全部 held-out 15 例（含 abstain）。若 procedure 对全 15 例都 abstain：3 例正确 abstain + 12 例 unexpected abstain → accuracy = 3/15 ≈ 0.20 < 0.95，且 unexpected-abstain rate = 12/12 = 1.0 > 0.10，双双失败。故全 abstain 无法逃过 accuracy 与回退门。

### 6.1 成本模型与统一单位（可复现、无 LLM）

**统一成本单位 = 输入字节（input bytes）**，可复现采集，不依赖 LLM：

- `slow_path_cost(c) = byteLength(data-pagination.md 全文) + byteLength(c.sql)`（慢路径必须读完整 reference + 查询）。
- `fast_path_cost(c) = byteLength(c.sql)`（快路径仅扫描查询）。
- `fallback_cost(c) = 对 abstain/低置信案例仍按 slow_path_cost 计`。
- `compile_and_validation_cost`（一次性）= `byteLength(reference)` + Σ_{全部案例} byteLength(case.sql)（规则作者/验证的一次性等价字节工作量，仅记录一次，不随调用摊销重算）。

**采集方法**：project-local 只读读取已安装 Skill 的 `references/data-pagination.md`，用 `fs.statSync().size` 取字节；每例 SQL 用 UTF-8 `Buffer.byteLength` 取字节。全流程无 LLM、无网络、无 SQL 执行。

```
N_break-even = compile_and_validation_cost
             / ( mean(slow_path_cost) − mean(fast_path_cost) − mean(fallback_cost) )
```

**明确声明**：该字节口径 comparator 只证明“确定性输入字节读取量”的减少，**不构成、也不证明真实宿主 LLM 的 token / latency 节省**。真实 LLM 成本证据缺失是 Gate P3 blocker（§7），不得用字节口径 N_break-even 冒充真实成本收益。阈值 N_break-even ≤ 10 仅在“存在真实 LLM 成本证据”的前提下才参与 promotion。

## 7. 硬失败门（任一触发 → 不得 promotion，procedure 保持 draft）

1. **offset recall < 1.0**（质量/有效性硬门）：漏报 OFFSET 使检测失效（agent 不会建议 keyset）。**这是质量硬门，不是安全/授权问题**。
2. **结构化安全违反**（真正的安全门）：artifact 中出现 SQL 执行、数据库连接、网络、或自动改写 SQL 的任何调用/意图。
3. **来源不一致**：artifact 未绑定父 `skill_id + skill_revision + dependency fingerprint`（含 `data-pagination.md` 内容指纹）。
4. **证据不独立**：任何 held-out 案例被用于调参/反向修正规则（训练-验证泄漏），或 Evaluation Owner 看结果后回改标签/放宽阈值。
5. **verifier 非独立**：用 LLM 自评或 procedure 自证替代冻结 oracle 判定。
6. **correctness 不达标**：accuracy < 0.95 或 offset false-positive rate > 0.05 或 expected-abstain recall < 1.0。
7. **回退不达标**：unexpected-abstain rate > 0.10。
8. **成本不达标**：abstain rate > 0.20，或（有真实成本证据时）N_break-even > 10。
9. **缺少真实宿主 LLM 慢路径成本证据**（Gate P3 blocker）：字节口径 comparator 不构成真实 token/latency 证据；无此证据则不得进入 `validated`。
10. **越权**：procedure 超出“只读静态检测”声明范围（如返回改写建议之外的写操作）。

## 8. Promotion 判定

- **通过（`validated`）**：§7 全部硬门通过（含真实 LLM 成本证据）+ §6 全部阈值达标。`validated ≠ active`；进入 `active` 前必须再过 canary + shadow replay（ADR-0008）。
- **不通过（`draft`）**：任一硬门触发或任一分项阈值不达标 → 保持 `draft`，回退父 `SKILL.md` 慢路径，不得进入 canary。
- 单一加权总分不得掩盖任一维度的失败（ADR-0008 硬门 6）。

## 9. 冻结声明与自检

- 本文件在查看任何候选 procedure 实现/结果**之前**冻结；截至撰写时仓库内无 Phase 3 procedure 实现，仅有 Phase 1/2 产物（与本检测无关）。
- 自检：分区不相交（train∩heldout=∅）；每例均有 expected；held-out 覆盖四类 class；verifier 为二值纯函数且含证据不变量；accuracy 分母=全 held-out（含 abstain，防逃逸）；所有指标分母均已定义且本集 >0；成本用可复现字节单位并声明不证明 LLM 节省，真实 LLM 证据为 Gate P3 blocker；offset recall 表述为质量硬门而非安全授权；promotion 仅 `validated` 且非 `active`。
- 测试 SQL 全部原创（posts 表分页形态），未复制外部正文。
