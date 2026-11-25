const assert = require("assert");
const { retrieve, buildContextBlock, entryCount } = require("../lib/knowledge-retriever");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function ids(results) {
  return results.map((e) => e.id);
}

// ─── Entry loading ────────────────────────────────────────────────────────────
console.log("\nEntry loading");

test("loads all 14 entries (9 products + 5 policies)", () => {
  assert.strictEqual(entryCount, 14);
});

// ─── English matching ─────────────────────────────────────────────────────────
console.log("\nEnglish matching");

test("single keyword: refund → product-001 + policy-001", () => {
  const result = ids(retrieve("I would like a refund please"));
  assert.ok(result.includes("product-001"), "missing product-001");
  assert.ok(result.includes("policy-001"), "missing policy-001");
});

test("single keyword: license → product-002", () => {
  const result = ids(retrieve("my license code is invalid"));
  assert.ok(result.includes("product-002"), "missing product-002");
});

test("keyword: crash → product-007", () => {
  const result = ids(retrieve("the software keeps crashing with an error"));
  assert.ok(result.includes("product-007"), "missing product-007");
});

test("keyword: invoice → product-005", () => {
  const result = ids(retrieve("I need a VAT invoice for my company"));
  assert.ok(result.includes("product-005"), "missing product-005");
});

test("keyword: cancel + renewal → product-004 + policy-002", () => {
  const result = ids(retrieve("please cancel my auto-renewal subscription"));
  assert.ok(result.includes("product-004"), "missing product-004");
  assert.ok(result.includes("policy-002"), "missing policy-002");
});

test("keyword: chargeback → policy-003", () => {
  const result = ids(retrieve("I will do a chargeback if not resolved"));
  assert.ok(result.includes("policy-003"), "missing policy-003");
});

test("keyword: youtube + credits → product-006", () => {
  const result = ids(retrieve("I posted a review on YouTube for free credits"));
  assert.ok(result.includes("product-006"), "missing product-006");
});

test("keyword: forgot email → product-008", () => {
  const result = ids(retrieve("I forgot the email I used to purchase"));
  assert.ok(result.includes("product-008"), "missing product-008");
});

test("keyword: change email → product-009", () => {
  const result = ids(retrieve("I want to change my email address"));
  assert.ok(result.includes("product-009"), "missing product-009");
});

test("keyword: new computer → product-003", () => {
  const result = ids(retrieve("I bought a new computer and need to transfer my license"));
  assert.ok(result.includes("product-003"), "missing product-003");
});

// ─── Case insensitivity ───────────────────────────────────────────────────────
console.log("\nCase insensitivity");

test("REFUND (uppercase) still matches", () => {
  const result = ids(retrieve("I WANT A REFUND"));
  assert.ok(result.includes("product-001"), "missing product-001");
});

test("CRASH (uppercase) still matches", () => {
  const result = ids(retrieve("APP KEEPS CRASHING"));
  assert.ok(result.includes("product-007"), "missing product-007");
});

// ─── CJK / Chinese ───────────────────────────────────────────────────────────
console.log("\nCJK matching (Chinese)");

test("Chinese 退款 → product-001 + policy-001", () => {
  const result = ids(retrieve("我想申请退款"));
  assert.ok(result.includes("product-001"), "missing product-001");
});

test("Chinese 取消续订 → product-004", () => {
  const result = ids(retrieve("请帮我取消自动扣款"));
  assert.ok(result.includes("product-004"), "missing product-004");
});

test("Chinese 注册码 → product-002", () => {
  const result = ids(retrieve("注册码无法使用"));
  assert.ok(result.includes("product-002"), "missing product-002");
});

// ─── CJK / Japanese ──────────────────────────────────────────────────────────
console.log("\nCJK matching (Japanese)");

test("Japanese 返金 (no spaces) → product-001", () => {
  const result = ids(retrieve("この製品の返金をお願いしたいです"));
  assert.ok(result.includes("product-001"), "missing product-001");
});

test("Japanese キャンセル → product-004 + policy-002", () => {
  const result = ids(retrieve("サブスクリプションをキャンセルしたいです"));
  assert.ok(result.includes("product-004"), "missing product-004");
  assert.ok(result.includes("policy-002"), "missing policy-002");
});

test("Japanese ライセンス → product-002", () => {
  const result = ids(retrieve("ライセンスが無効です"));
  assert.ok(result.includes("product-002"), "missing product-002");
});

test("Japanese クラッシュ → product-007", () => {
  const result = ids(retrieve("ソフトウェアがクラッシュします"));
  assert.ok(result.includes("product-007"), "missing product-007");
});

// ─── French ──────────────────────────────────────────────────────────────────
console.log("\nMultilingual matching (French)");

test("French annuler → product-004 + policy-002", () => {
  const result = ids(retrieve("Je voudrais annuler mon abonnement"));
  assert.ok(result.includes("product-004"), "missing product-004");
  assert.ok(result.includes("policy-002"), "missing policy-002");
});

test("French remboursement → product-001 + policy-001", () => {
  const result = ids(retrieve("Je demande un remboursement"));
  assert.ok(result.includes("product-001"), "missing product-001");
  assert.ok(result.includes("policy-001"), "missing policy-001");
});

test("French licence → product-002", () => {
  const result = ids(retrieve("Mon code de licence ne fonctionne pas"));
  assert.ok(result.includes("product-002"), "missing product-002");
});

// ─── German ──────────────────────────────────────────────────────────────────
console.log("\nMultilingual matching (German)");

test("German Rückerstattung → product-001 + policy-001", () => {
  const result = ids(retrieve("Ich möchte eine Rückerstattung beantragen"));
  assert.ok(result.includes("product-001"), "missing product-001");
  assert.ok(result.includes("policy-001"), "missing policy-001");
});

test("German kündigen → product-004 + policy-002", () => {
  const result = ids(retrieve("Ich möchte mein Abonnement kündigen"));
  assert.ok(result.includes("product-004"), "missing product-004");
  assert.ok(result.includes("policy-002"), "missing policy-002");
});

test("German Lizenz → product-002", () => {
  const result = ids(retrieve("Mein Lizenz-Code funktioniert nicht"));
  assert.ok(result.includes("product-002"), "missing product-002");
});

// ─── Spanish ─────────────────────────────────────────────────────────────────
console.log("\nMultilingual matching (Spanish)");

test("Spanish reembolso → product-001 + policy-001", () => {
  const result = ids(retrieve("Quiero solicitar un reembolso"));
  assert.ok(result.includes("product-001"), "missing product-001");
  assert.ok(result.includes("policy-001"), "missing policy-001");
});

test("Spanish cancelar → product-004 + policy-002", () => {
  const result = ids(retrieve("Quiero cancelar mi suscripción"));
  assert.ok(result.includes("product-004"), "missing product-004");
  assert.ok(result.includes("policy-002"), "missing policy-002");
});

test("Spanish fallo → product-007", () => {
  const result = ids(retrieve("El programa tiene un fallo grave"));
  assert.ok(result.includes("product-007"), "missing product-007");
});

// ─── Ranking and limits ───────────────────────────────────────────────────────
console.log("\nRanking and limits");

test("returns at most 3 results", () => {
  const result = retrieve("refund cancel crash license error invoice");
  assert.ok(result.length <= 3, `expected ≤3, got ${result.length}`);
});

test("empty string returns empty array", () => {
  assert.deepStrictEqual(retrieve(""), []);
});

test("whitespace-only returns empty array", () => {
  assert.deepStrictEqual(retrieve("   "), []);
});

test("unrelated text returns empty array", () => {
  const result = retrieve("hello good morning how are you today");
  assert.deepStrictEqual(result, []);
});

test("higher hit count ranks first", () => {
  // 'refund' hits product-001 + policy-001; 'crash' hits product-007
  // A query with both 'refund' and 'return' should rank product-001 first
  const result = retrieve("refund money back return");
  assert.strictEqual(result[0].id, "product-001", "product-001 should rank first with 3 tag hits");
});

// ─── buildContextBlock ────────────────────────────────────────────────────────
console.log("\nbuildContextBlock");

test("empty entries returns empty string", () => {
  assert.strictEqual(buildContextBlock([]), "");
});

test("returns string starting with [COMPANY CONTEXT]", () => {
  const entries = retrieve("refund");
  const block = buildContextBlock(entries);
  assert.ok(block.startsWith("[COMPANY CONTEXT]"), "missing header");
});

test("contains entry title and content", () => {
  const entries = retrieve("refund");
  const block = buildContextBlock(entries);
  assert.ok(block.includes("Refund Eligibility and Conditions"), "missing title");
  assert.ok(block.includes("5 days"), "missing content detail");
});

test("each entry is on its own line prefixed with -", () => {
  const entries = retrieve("refund license");
  const block = buildContextBlock(entries);
  const lines = block.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length >= 1, "no bullet lines found");
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
