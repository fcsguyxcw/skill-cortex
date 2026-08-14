# Phase 2 Gate P2 验收报告

日期：2026-08-14  
状态：**PASS**  
范围：project-local Practice Store、写入 policy、证据隔离/删除，以及 docx pilot evaluation replay

## 1. 实际交付

- `src/practice/policy/`：运行时 `unknown` 输入验证、脱敏/最小化、归因与失败分类。
- `src/practice/store/`：不可变事件文件、tenant/provenance 分区、全局 event claim、物理删除与 tombstone。
- `src/evaluation/phase2/`：明确标记为 `evaluation` 的 docx 慢路径 observation replay。
- `docs/adr/0009-practice-store-event-files-and-deletion.md`：以不可变事件文件替代 Phase 0 的 JSONL 介质选择。

Phase 2 只记录 observation，不创建或发布 `ActivationProfile`、`CompiledProcedure`，也不接入真实用户 Pi 持久化路径。

## 2. Gate 验证

| Gate 项 | 结果与证据 |
|---|---|
| append 后不可原地修改 | event 与 claim 均使用 exclusive create；重复/并发同 ID 仅一个成功 |
| 合同 round-trip | 全部必需/可选字段与失败信号通过 round-trip；未知字段在写侧和读侧均白名单剥离 |
| provenance 隔离 | real/shadow/evaluation/synthetic 物理分区；production query 只读 real |
| tenant 隔离 | project/user scope 使用 SHA-256 目录；互不可见；原 tenant 不进入路径 |
| 归因边界 | caller attribution 不受信；无干净 verifier pass 时保持 mixed/unknown |
| 数据最小化 | secret、凭据、私钥、绝对/相对路径、完整任务、原始工具输出样式被拒绝 |
| 删除与级联 seam | tombstone 先于物理删除；删除重试、幂等、ID 不复用；只返回真实 invalidated IDs |
| 失败分类 | permission/tool/environment/user interruption/guard/postcondition/procedure 分栏；证据不足 unknown |
| 坏证据读侧 | 非法 JSON、坏嵌套、ID/provenance/tenant 不一致稳定 fail-closed，不回显内容或路径 |
| pilot replay | docx evaluation event 可重复构造和隔离回放；不进入 production evidence，不冒充真实执行 |
| active path guard | production 源码无 proposal/profile/procedure 发布或 Router LLM 调用 |

## 3. 实际命令与结果

```text
node --test src/practice/policy/index.test.ts src/practice/store/index.test.ts src/evaluation/phase2/replay.test.ts
  PASS；64 tests；64 pass；0 fail；0 skip

npm.cmd test
  PASS；164 tests；163 pass；0 fail；1 skip

npm.cmd run typecheck
  PASS；tsc --noEmit；exit 0

production active-path rg
  PASS；实际调用命中 0（测试中的否认断言不计）
```

唯一 skip 是 Windows 当前权限不允许创建文件 symlink 的 Registry 测试；Store 的 junction 指向 project root 外测试实际通过。

CC 只读独立审查建议 `Gate P2 = PASS`。审查之后，Leader 又修复了其非阻塞项中的 eventId 合同漂移、坏证据读侧验证和临时目录忽略规则，并重新运行上述最终命令。

## 4. Pilot 证据边界

docx replay 是 synthetic/evaluation observation fixture：

- provenance 固定为 `evaluation`；
- step、authorization、guard 与 verifier 未执行项均为 `unknown`；
- `observedEffect` 明确为 `replay-not-executed`；
- 未复制或提交 proprietary docx Skill；
- 未运行 `validate.py`、`unpack.py`、真实 OOXML verifier 或用户日常 Pi。

因此该 fixture 只证明 PracticeEvent 的回放、政策、分区和删除链路，不证明 docx procedure 或宿主执行能力已经可用。

## 5. 未解决风险

1. 未做跨进程并发、断电/fsync 或大规模文件数量压力测试；当前证据是单进程 Promise 并发与故障注入。
2. 真实宿主 observer 尚未接入；没有真实用户 `PracticeEvent`，也没有真实授权/sandbox 等价性证据。
3. 应用不提供 at-rest encryption；按冻结政策，`internal`/`confidential` 继续拒绝写入。
4. failure classification 的 operation-class 文本规则是确定性 MVP，不等于真实宿主因果归因。
5. proprietary docx fixture、Python/lxml/XSD 依赖与真实 verifier 留到 Phase 3 前的隔离验证。

## 6. Gate 结论

**Gate P2 = PASS。** 可启动 Phase 3 的 project-local、离线、只读/幂等 procedure proposal 与独立验证；不得直接进入 canary/active，也不得写用户日常 Pi 环境。
