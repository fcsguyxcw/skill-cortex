import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PAGINATION_CASES, type PaginationCase } from "./cases.ts";
import { verify } from "./verifier.ts";

function caseById(id: string): PaginationCase {
  const found = PAGINATION_CASES.find((c) => c.id === id);
  assert.ok(found, `case ${id} 必须存在`);
  return found;
}

describe("Phase 3 verifier（独立二值判定，不依赖 detector）", () => {
  it("四类正确 finding（带合法 evidence）→ pass", () => {
    assert.deepEqual(verify(caseById("T01"), { class: "uses_offset", evidence: { matchText: "OFFSET 40" } }), { pass: true, code: "ok" });
    assert.deepEqual(verify(caseById("T02"), { class: "uses_keyset", evidence: { matchText: "id > $1" } }), { pass: true, code: "ok" });
    assert.deepEqual(verify(caseById("T03"), { class: "no_pagination", evidence: { matchText: "author_id = $1" } }), { pass: true, code: "ok" });
    assert.deepEqual(verify(caseById("H12"), { class: "abstain", evidence: { matchText: "OFFSET" } }), { pass: true, code: "ok" });
  });

  it("H14 空串 SQL 的正确 abstain（空串 evidence 仍合法）→ pass", () => {
    assert.deepEqual(verify(caseById("H14"), { class: "abstain", evidence: { matchText: "" } }), { pass: true, code: "ok" });
  });

  it("非空 SQL 不得用空串 evidence 绕过来源校验", () => {
    assert.deepEqual(
      verify(caseById("T03"), { class: "no_pagination", evidence: { matchText: "" } }),
      { pass: false, code: "malformed_finding" },
    );
    assert.deepEqual(
      verify(caseById("H12"), { class: "abstain", evidence: { matchText: "" } }),
      { pass: false, code: "malformed_finding" },
    );
  });

  it("label 不匹配 → label_mismatch（含 unexpected abstain）", () => {
    assert.deepEqual(verify(caseById("T01"), { class: "uses_keyset" }), { pass: false, code: "label_mismatch" });
    assert.deepEqual(verify(caseById("T01"), { class: "no_pagination" }), { pass: false, code: "label_mismatch" });
    // 期望非 abstain 但输出 abstain = unexpected abstain → fail
    assert.deepEqual(verify(caseById("T01"), { class: "abstain" }), { pass: false, code: "label_mismatch" });
  });

  it("malformed finding（非对象 / 缺 class / 非法 class）→ malformed_finding", () => {
    for (const bad of [null, 42, "uses_offset", { evidence: { matchText: "x" } }, {}, { class: undefined }, { class: 7 }, { class: "uses_offsetx" }]) {
      const r = verify(caseById("T01"), bad);
      assert.equal(r.pass, false, `malformed 必须 fail: ${JSON.stringify(bad)}`);
      assert.equal(r.code, "malformed_finding");
    }
  });

  it("证据校验：matchText 不在输入 SQL → evidence_not_in_input", () => {
    const r = verify(caseById("T01"), {
      class: "uses_offset",
      evidence: { matchText: "NOT PRESENT ANYWHERE" },
    });
    assert.deepEqual(r, { pass: false, code: "evidence_not_in_input" });
  });

  it("证据校验：uses_offset 的 matchText 必须含 OFFSET（keyword 不敏感；includes 敏感）", () => {
    assert.deepEqual(
      verify(caseById("H01"), { class: "uses_offset", evidence: { matchText: "LIMIT 20" } }),
      { pass: false, code: "evidence_keyword_mismatch" },
    );
    // matchText 必须真实存在于输入（大小写敏感 includes）：sql 含 "OFFSET 40"，小写变体不命中
    assert.deepEqual(
      verify(caseById("H01"), { class: "uses_offset", evidence: { matchText: "offset 40" } }),
      { pass: false, code: "evidence_not_in_input" },
    );
    // 原文命中 + keyword 命中 → pass
    assert.deepEqual(
      verify(caseById("H01"), { class: "uses_offset", evidence: { matchText: "OFFSET 40" } }),
      { pass: true, code: "ok" },
    );
  });

  it("证据缺失/非字符串 → malformed_finding（fail-closed，不再直接 pass）", () => {
    const badFindings: unknown[] = [
      { class: "uses_offset" }, // 无 evidence 字段
      { class: "uses_offset", evidence: {} }, // evidence 存在但 matchText 缺失
      { class: "uses_offset", evidence: { matchText: undefined } },
      { class: "uses_offset", evidence: { matchText: null } },
      { class: "uses_offset", evidence: { matchText: 42 } },
      { class: "uses_offset", evidence: { matchText: ["OFFSET 40"] } },
      { class: "uses_offset", evidence: { matchText: {} } },
    ];
    for (const bad of badFindings) {
      const r = verify(caseById("H01"), bad);
      assert.equal(r.pass, false, `缺/非字符串 evidence 必须 fail: ${JSON.stringify(bad)}`);
      assert.equal(r.code, "malformed_finding");
    }
  });

  it("非 uses_offset 的 matchText 命中（如小写列名 offset）→ 仅校验 includes，不查 keyword", () => {
    // H08 含小写列名 "offset"；正确输出 no_pagination + 证据命中该子串 → pass
    assert.deepEqual(
      verify(caseById("H08"), { class: "no_pagination", evidence: { matchText: "offset" } }),
      { pass: true, code: "ok" },
    );
    // 但若把它误判为 uses_offset（label 错）→ label_mismatch 先于证据校验
    assert.deepEqual(
      verify(caseById("H08"), { class: "uses_offset", evidence: { matchText: "offset" } }),
      { pass: false, code: "label_mismatch" },
    );
  });

  it("正确的 abstain finding 带证据也受 includes 校验", () => {
    assert.deepEqual(
      verify(caseById("H12"), { class: "abstain", evidence: { matchText: "ghost text" } }),
      { pass: false, code: "evidence_not_in_input" },
    );
    assert.deepEqual(
      verify(caseById("H12"), { class: "abstain", evidence: { matchText: "OFFSET" } }),
      { pass: true, code: "ok" },
    );
  });
});
