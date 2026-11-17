const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createSpamLists } = require("../lib/spam-lists");
const { createSpamClassifier, parseVerdict } = require("../lib/spam-classifier");

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ec-spam-")), name);
}

test("lists: default allowed domains win over blocks", () => {
  const lists = createSpamLists(tmpFile("lists.json"));
  assert.equal(lists.check("assist@paddle.com"), "allowed");
  assert.equal(lists.check("notify@mail.stripe.com"), "allowed");
  lists.apply({ action: "block", email: "assist@paddle.com" });
  assert.equal(lists.check("assist@paddle.com"), "allowed");
  assert.throws(() => lists.apply({ action: "block_domain", domain: "paypal.com" }), /allowed domain/);
});

test("lists: new default allowed domains reach an existing list file", () => {
  const file = tmpFile("lists.json");
  fs.writeFileSync(file, JSON.stringify({ allowed_domains: ["paddle.com", "custom.example"] }));
  const lists = createSpamLists(file);
  assert.equal(lists.check("noreply@wetransfer.com"), "allowed");
  assert.equal(lists.check("x@custom.example"), "allowed");
});

test("lists: block, allow and unblock a sender", () => {
  const lists = createSpamLists(tmpFile("lists.json"));
  lists.apply({ action: "block", email: "  SEO@Spam.example " });
  assert.equal(lists.check("seo@spam.example"), "blocked");
  lists.apply({ action: "allow", email: "seo@spam.example" });
  assert.equal(lists.check("seo@spam.example"), "allowed");
  assert.deepEqual(lists.load().blocked_senders, []);
  lists.apply({ action: "disallow", email: "seo@spam.example" });
  assert.equal(lists.check("seo@spam.example"), null);
});

test("lists: domain block covers subdomains; import skips allowed senders", () => {
  const lists = createSpamLists(tmpFile("lists.json"));
  lists.apply({ action: "block_domain", email: "x@outreach.example" });
  assert.equal(lists.check("anyone@mail.outreach.example"), "blocked");
  lists.apply({ action: "allow", email: "friend@ok.example" });
  lists.apply({ action: "import", emails: ["friend@ok.example", "a@b.example", "not-an-email"] });
  assert.deepEqual(lists.load().blocked_senders, ["a@b.example"]);
});

test("lists: rejects unknown action and missing email", () => {
  const lists = createSpamLists(tmpFile("lists.json"));
  assert.throws(() => lists.apply({ action: "nope" }), /unknown action/);
  assert.throws(() => lists.apply({ action: "block", email: "" }), /email is required/);
});

test("lists: export filter patterns escape regex characters", () => {
  const lists = createSpamLists(tmpFile("lists.json"));
  lists.apply({ action: "block", email: "a.b@c.example" });
  const { from_senders } = lists.exportFilterPatterns();
  assert.ok(new RegExp(from_senders).test("a.b@c.example"));
  assert.ok(!new RegExp(from_senders).test("aXb@c.example"));
});

test("parseVerdict: malformed or unknown output becomes unsure", () => {
  assert.equal(parseVerdict("not json").verdict, "unsure");
  assert.equal(parseVerdict('{"verdict":"maybe","confidence":0.99}').verdict, "unsure");
  assert.deepEqual(parseVerdict('```json\n{"verdict":"spam","confidence":1.7,"reason":"x"}\n```'), { verdict: "spam", confidence: 1, reason: "x" });
});

test("classifier: mock provider never guesses", async () => {
  const c = createSpamClassifier({ provider: "mock", cacheFile: tmpFile("cache.json") });
  assert.equal((await c.classify({ ticket_id: "1", subject: "guest post" })).verdict, "unsure");
});

test("classifier: caches by ticket, does not cache failures, human override wins", async () => {
  let calls = 0;
  let fail = true;
  const callModel = async () => {
    calls += 1;
    if (fail) throw new Error("boom");
    return '{"verdict":"spam","confidence":0.95,"reason":"推销"}';
  };
  const c = createSpamClassifier({ provider: "deepseek", model: "m", callModel, cacheFile: tmpFile("cache.json") });

  assert.equal((await c.classify({ ticket_id: "7" })).verdict, "unsure");
  fail = false;
  assert.equal((await c.classify({ ticket_id: "7" })).verdict, "spam");
  assert.equal((await c.classify({ ticket_id: "7" })).cached, true);
  assert.equal(calls, 2);

  c.override("7", "ham", "人工标记为正常");
  const r = await c.classify({ ticket_id: "7" });
  assert.equal(r.verdict, "ham");
  assert.equal(r.engine, "human");
});
