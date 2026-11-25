const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createQueueRouting, normalizeProduct, mentions, cleanQueueName, detectLanguage } = require("../lib/queue-routing");

function makeRouting() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ec-qr-"));
  return createQueueRouting({ learnedFile: path.join(dir, "learned.json") });
}

test("normalizeProduct strips platform, plan and suffixes", () => {
  assert.equal(normalizeProduct("Sidify Music Converter (Win) - 1 Year License"), "sidify music converter");
  assert.equal(normalizeProduct("AVCLabs Video Enhancer AI for Mac Lifetime"), "avclabs video enhancer ai");
});

test("mentions is whole-word: avc does not match avclabs", () => {
  assert.equal(mentions("i bought avclabs", "avc"), false);
  assert.equal(mentions("my sidify key", "sidify"), true);
});

test("subject naming another brand → move (high)", () => {
  const r = makeRouting().classify({ subject: "Sidify registration code not working", preview: "", products: [] });
  assert.equal(r.action, "move");
  assert.equal(r.queue, "Sidify");
  assert.equal(r.confidence, "high");
});

test("text naming avclabs stays, even with foreign orders", () => {
  const r = makeRouting().classify({ subject: "AVCLabs Video Enhancer AI refund", preview: "", products: ["TunePat Spotify Converter"] });
  assert.equal(r.action, "stay");
});

test("brand in text but avclabs order → move medium", () => {
  const r = makeRouting().classify({ subject: "NoteBurner crashes", products: ["AVCLabs Photo Enhancer AI"] });
  assert.equal(r.action, "move");
  assert.equal(r.queue, "noteburner");
  assert.equal(r.confidence, "medium");
});

test("no text hint, only foreign orders → move medium by order", () => {
  const r = makeRouting().classify({ subject: "refund please", products: ["TuneBoto Netflix Video Downloader - 1 Month"] });
  assert.equal(r.action, "move");
  assert.equal(r.queue, "TuneBoto");
  assert.equal(r.confidence, "medium");
});

test("two foreign brands → needs a human", () => {
  const r = makeRouting().classify({ subject: "Sidify and TunePat license", products: [] });
  assert.equal(r.action, "none");
});

test("learned tallies override brand keywords for product names", () => {
  const routing = makeRouting();
  routing.learn({
    samples: [
      { queue: "TP-Video", products: ["TunePat Netflix Video Downloader"] },
      { queue: "TP-Video", products: ["TunePat Netflix Video Downloader (Mac)"] },
      { queue: "TunePat", products: ["TunePat Netflix Video Downloader", "TunePat Spotify Converter"] },
      { queue: "TP-Video", products: ["TunePat Netflix Video Downloader"] }
    ]
  });
  const table = routing.table();
  assert.equal(table.learned["tunepat netflix video downloader"].queue, "TP-Video");
  assert.equal(table.learned["tunepat spotify converter"], undefined); // one sample only

  const byOrder = routing.classify({ subject: "help", products: ["TunePat Netflix Video Downloader - 1 Year"] });
  assert.equal(byOrder.queue, "TP-Video");
  const byText = routing.classify({ subject: "TunePat Netflix Video Downloader stops at 99%" });
  assert.equal(byText.queue, "TP-Video");
  assert.equal(byText.confidence, "high");
});

test("unknown products and plain text → none", () => {
  const r = makeRouting().classify({ subject: "hello", preview: "question about my order", products: ["Something Else"] });
  assert.equal(r.action, "none");
});

test("queue names lose the queue-view counters", () => {
  assert.equal(cleanQueueName("TP-Video (1/0)"), "TP-Video");
  assert.equal(cleanQueueName("syncios (32/21)"), "syncios");
  assert.equal(cleanQueueName("TunePat::TP-Video"), "TP-Video");
  const routing = makeRouting();
  routing.learn({ samples: [
    { queue: "TP-Video (1/0)", products: ["TunePat Disney+ Video Downloader"] },
    { queue: "TP-Video (3/1)", products: ["TunePat Disney+ Video Downloader"] }
  ] });
  assert.equal(routing.table().learned["tunepat disney video downloader"].queue, "TP-Video");
});

test("order product names: SKU and plan code are dropped", () => {
  assert.equal(normalizeProduct("FC Netflix Video Downloader 12M, FC_Netflix_Video_Win_12M"), "fc netflix video downloader");
  assert.equal(normalizeProduct("TP Amazon Music Converter 1M TP_Amazon_Audio_Win_1M"), "tp amazon music converter");
});

test("queue link text with counter and timestamp lines", () => {
  assert.equal(cleanQueueName("TunePat\n        1\n            TicketOverview\n  19/11/2026 12:36:38"), "TunePat");
});

test("brand code in order products decides the queue", () => {
  const routing = makeRouting();
  const sd = routing.classify({ subject: "refund", products: ["SD Spotify Music Converter 12M, SD_Spotify_Audio_Win_12M"] });
  assert.equal(sd.queue, "Sidify");
  const tbVideo = routing.classify({ subject: "help", products: ["TB Amazon Video Converter, TB_Amazon_Video_Win"] });
  assert.equal(tbVideo.queue, "TB-Video");
  const tbMusic = routing.classify({ subject: "help", products: ["TB Spotify Music Converter"] });
  assert.equal(tbMusic.queue, "TuneBoto");
  const al = routing.classify({ subject: "help", products: ["AL PhotoPro AI, AL_Photo_Pro_Win", "TP Amazon Music Converter"] });
  assert.equal(al.action, "stay");
});

test("coded product names are not matched in email text", () => {
  const routing = makeRouting();
  routing.learn({ samples: [
    { queue: "TuneBoto", customer: "a", products: ["TB Amazon Video Converter"] },
    { queue: "TuneBoto", customer: "b", products: ["TB Amazon Video Converter"] }
  ] });
  // "amazon video converter" alone exists for several brands.
  assert.equal(routing.classify({ subject: "amazon video converter not working" }).action, "none");
});

test("customers seen in many queues are ignored when learning", () => {
  const routing = makeRouting();
  const everywhere = ["Sidify", "TunePat", "KeepMusic", "syncios"].map((queue) =>
    ({ queue, customer: "spread", products: ["AudiCable Music Recorder"] }));
  routing.learn({ samples: [
    ...everywhere,
    { queue: "AudiCable", customer: "x", products: ["AudiCable Music Recorder"] },
    { queue: "AudiCable", customer: "y", products: ["AudiCable Music Recorder"] }
  ] });
  const table = routing.table();
  assert.equal(table.noisy_customers, 1);
  assert.deepEqual(table.raw_counts["audicable music recorder"], { AudiCable: 2 });
  assert.equal(table.learned["audicable music recorder"].queue, "AudiCable");
});

test("language detection", () => {
  assert.equal(detectLanguage("Hola, compré Sidify y no puedo activar la licencia, gracias"), "es");
  assert.equal(detectLanguage("Bonjour, je n'arrive pas à activer mon code, merci pour votre aide"), "fr");
  assert.equal(detectLanguage("Hallo, ich habe den Code gekauft und er funktioniert nicht, danke"), "de");
  assert.equal(detectLanguage("ライセンスコードが使えません"), "ja");
  assert.equal(detectLanguage("Hi, my license code is not working, please help"), "en");
});

test("non-English emails go to the brand's language queue", () => {
  const routing = makeRouting();
  const es = routing.classify({ subject: "Sidify licencia", preview: "Hola, compré el programa y no puedo activar la licencia, gracias" });
  assert.equal(es.queue, "Sidify-es");
  const ja = routing.classify({ subject: "TunePat", preview: "ライセンスコードが使えません", products: [] });
  assert.equal(ja.queue, "tunepat.jp");
  // No language queue for this brand → main queue.
  const fr = routing.classify({ subject: "Syncios", preview: "Bonjour, je n'arrive pas à activer mon code, merci pour votre aide" });
  assert.equal(fr.queue, "syncios");
  // English stays on the main / video queue.
  const en = routing.classify({ subject: "help", preview: "my code is not working, please help", products: ["TP Netflix Video Downloader, TP_Netflix_Video_Win"] });
  assert.equal(en.queue, "TP-Video");
  // Video product + Spanish → the language queue.
  const esVideo = routing.classify({ subject: "ayuda", preview: "Hola, compré el programa y no puedo activar la licencia, gracias", products: ["TP Netflix Video Downloader"] });
  assert.equal(esVideo.queue, "tunepat-es");
});

test("brand in text + video order → the video subqueue", () => {
  const r = makeRouting().classify({ subject: "TunePat not downloading", products: ["TP Netflix Video Downloader 12M, TP_Netflix_Video_Win_12M"] });
  assert.equal(r.queue, "TP-Video");
  assert.equal(r.confidence, "high");
});

test("language queues fold into the main queue when learning", () => {
  const routing = makeRouting();
  routing.learn({ samples: [
    { queue: "Sidify-es", customer: "a", products: ["Sidify Tidal Pack"] },
    { queue: "Sidify JP", customer: "b", products: ["Sidify Tidal Pack"] }
  ] });
  assert.equal(routing.table().learned["sidify tidal pack"].queue, "Sidify");
});

test("AnyLibro goes to AEC", () => {
  const r = makeRouting().classify({ subject: "refund", products: ["AnyLibro Converter 12M, Any_Libro_Mac_12M"] });
  assert.equal(r.queue, "AEC");
});

test("Japanese avclabs tickets move to AVCLabs JP", () => {
  const routing = makeRouting();
  const stay = routing.classify({ subject: "AVCLabs Video Enhancer AI", preview: "ライセンスコードが使えません", products: ["AL Video Enhancer AI"] });
  assert.equal(stay.action, "move");
  assert.equal(stay.queue, "AVCLabs JP");
  assert.equal(stay.confidence, "high");
  // No product evidence at all: it is in the avclabs queue, so AVCLabs JP.
  const plain = routing.classify({ subject: "お問い合わせ", preview: "購入したのですが、使い方を教えてください" });
  assert.equal(plain.queue, "AVCLabs JP");
  // Japanese email about another brand → that brand's JP queue, not AVCLabs JP.
  const sidify = routing.classify({ subject: "Sidify", preview: "ライセンスコードが使えません" });
  assert.equal(sidify.queue, "Sidify JP");
  // Two other product lines: still a human decision.
  const mixed = routing.classify({ subject: "Sidify と TunePat", preview: "ライセンスコードが使えません" });
  assert.equal(mixed.action, "none");
  // English and other languages without a home language queue stay.
  assert.equal(routing.classify({ subject: "AVCLabs refund", preview: "please refund my order" }).action, "stay");
  assert.equal(routing.classify({ subject: "AVCLabs", preview: "Hola, compré el programa y no puedo activar la licencia, gracias" }).action, "stay");
});

test("AVCLabs JP samples count toward avclabs when learning", () => {
  const routing = makeRouting();
  routing.learn({ samples: [
    { queue: "AVCLabs JP", customer: "a", products: ["Video Upscaler Pack"] },
    { queue: "AVCLabs JP", customer: "b", products: ["Video Upscaler Pack"] }
  ] });
  assert.equal(routing.table().learned["video upscaler pack"].queue, "avclabs");
});
