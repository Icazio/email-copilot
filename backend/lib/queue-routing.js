const fs = require("fs");
const path = require("path");

// Queue routing: tickets in the home queue (avclabs) that ask about another
// product line get a suggested destination queue.
//
// Evidence, strongest first:
//   1. the subject/preview names a product or brand
//   2. the customer's orders (from AgentOrderSearch on the queue page)
// Product → queue comes from the crawler's tallies (state file) when they are
// clear, otherwise from the brand keywords in backend/data/queue-routing.json.

const CONFIG_FILE = path.join(__dirname, "../data/queue-routing.json");
const LEARNED_FILE = path.join(__dirname, "../state/queue-product-map.json");

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

// "Sidify Music Converter (Win) - 1 Year License" → "sidify music converter"
// Order products look like "FC Netflix Video Downloader 12M, FC_Netflix_Video_Win_12M":
// display name plus an underscore SKU, which is dropped.
function normalizeProduct(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\S*_\S*/g, " ")
    .replace(/\b(for\s+)?(windows|win|mac|macos)\b/g, " ")
    .replace(/\b(\d+[\s-]*(month|year|day)s?|\d+[mdy]|monthly|yearly|annual|lifetime|perpetual|subscription|plan|license|licence)\b/g, " ")
    .replace(/[^a-z0-9.\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Same cleanup as the queue page: "TP-Video (1/0)" → "TP-Video".
function cleanQueueName(name) {
  // The active queue's link also holds its counter and a timestamp on later lines.
  return String(name || "").trim().split(/\s*\n/)[0]
    .replace(/ /g, " ")
    .split("::").pop()
    .replace(/\(\s*\d+(\s*\/\s*\d+)?\s*\)\s*$/, "")
    .trim();
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match so that e.g. "avc" never matches inside "avclabs".
function mentions(text, phrase) {
  if (!phrase) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}($|[^a-z0-9])`, "i").test(text);
}

// Rough language of the customer's email: enough to pick a language queue.
// Returns "ja" | "es" | "fr" | "de" | "en" | "".
const LANG_WORDS = {
  en: ["the", "and", "to", "my", "is", "you", "please", "have", "with", "for", "thank", "it", "not", "can"],
  es: ["el", "la", "los", "que", "por", "para", "mi", "con", "una", "gracias", "hola", "pero", "como", "tengo", "puedo", "compra"],
  fr: ["le", "les", "des", "et", "je", "pour", "merci", "bonjour", "vous", "mon", "est", "pas", "avec", "une", "j'ai", "votre"],
  de: ["der", "die", "das", "und", "ich", "nicht", "mit", "ist", "danke", "bitte", "hallo", "mein", "eine", "habe", "sie", "für"]
};

function detectLanguage(text) {
  const raw = String(text || "");
  const kana = (raw.match(/[\u3040-\u30ff]/g) || []).length;
  if (kana >= 3) return "ja";
  const words = raw.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
  const score = {};
  for (const [lang, list] of Object.entries(LANG_WORDS)) {
    const set = new Set(list);
    score[lang] = words.filter((w) => set.has(w)).length;
  }
  const [best, top] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const second = Object.entries(score).filter(([l]) => l !== best).reduce((m, [, v]) => Math.max(m, v), 0);
  if (top < 3 || top < second * 1.5) return top >= 3 ? "en" : "";
  return best;
}

function createQueueRouting({ configFile = CONFIG_FILE, learnedFile = LEARNED_FILE } = {}) {
  function config() {
    const raw = loadJson(configFile, {});
    return {
      home_queue: raw.home_queue || "avclabs",
      home_keywords: (raw.home_keywords || []).map((k) => String(k).toLowerCase()),
      brands: (raw.brands || []).map((b) => ({ queue: b.queue, keywords: (b.keywords || []).map((k) => String(k).toLowerCase()) })),
      product_codes: Object.fromEntries(Object.entries(raw.product_codes || {})
        .filter(([k]) => !k.startsWith("_"))
        .map(([code, v]) => [code.toLowerCase(), typeof v === "string" ? { queue: v } : v])),
      language_queues: Object.fromEntries(Object.entries(raw.language_queues || {}).filter(([k]) => !k.startsWith("_"))),
      max_queues_per_customer: raw.max_queues_per_customer || 2,
      learned_min_samples: raw.learned_min_samples || 2,
      learned_min_share: raw.learned_min_share || 0.6
    };
  }

  function emptyLearned() {
    return { updated_at: null, queues: [], samples: [] };
  }

  function loadLearned() {
    const raw = loadJson(learnedFile, null);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.samples)) return emptyLearned(); // old format: re-crawl
    return { ...emptyLearned(), ...raw };
  }

  function saveLearned(data) {
    fs.mkdirSync(path.dirname(learnedFile), { recursive: true });
    const tmp = `${learnedFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, learnedFile);
  }

  // Crawler upload: { queues: [{id, name}], samples: [{queue, customer, products: [...]}], replace }
  // Each sample is one customer seen in one queue with the products they
  // bought. `customer` is an opaque key (the page sends a hash, not the email).
  function learn({ queues, samples, replace } = {}) {
    const data = replace ? emptyLearned() : loadLearned();
    if (Array.isArray(queues) && queues.length) {
      data.queues = queues
        .filter((q) => q && q.name)
        .map((q) => ({ id: String(q.id || ""), name: cleanQueueName(q.name) }));
    }
    let added = 0;
    for (const sample of Array.isArray(samples) ? samples : []) {
      const queue = cleanQueueName(sample?.queue);
      const products = [...new Set((sample?.products || []).map(normalizeProduct).filter(Boolean))];
      if (!queue || !products.length) continue;
      data.samples.push({ queue, customer: String(sample.customer || ""), products });
      added += 1;
    }
    data.updated_at = new Date().toISOString();
    saveLearned(data);
    return { added, samples: data.samples.length, updated_at: data.updated_at };
  }

  // Customers seen in many queues (resellers, test accounts, people writing
  // to every brand) say nothing about where a product belongs.
  function usableSamples(cfg, learned) {
    const queuesOf = new Map();
    for (const s of learned.samples) {
      if (!s.customer) continue;
      if (!queuesOf.has(s.customer)) queuesOf.set(s.customer, new Set());
      queuesOf.get(s.customer).add(s.queue);
    }
    const noisy = new Set([...queuesOf].filter(([, q]) => q.size > cfg.max_queues_per_customer).map(([c]) => c));
    return { samples: learned.samples.filter((s) => !noisy.has(s.customer)), noisy: noisy.size };
  }

  function tallies(cfg, learned) {
    const counts = {};
    for (const s of usableSamples(cfg, learned).samples) {
      for (const product of s.products) {
        counts[product] = counts[product] || {};
        // A language queue says which language, not which product line.
        const queue = isLanguageQueue(s.queue, cfg) ? familyOf(s.queue, cfg) : s.queue;
        counts[product][queue] = (counts[product][queue] || 0) + 1;
      }
    }
    return counts;
  }

  // Product (normalized) → { queue, samples, share } when the tallies agree enough.
  function learnedMapping(cfg = config(), learned = loadLearned()) {
    const map = {};
    for (const [product, counts] of Object.entries(tallies(cfg, learned))) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const [queue, top] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
      if (!queue || total < cfg.learned_min_samples || top / total < cfg.learned_min_share) continue;
      map[product] = { queue, samples: total, share: Math.round((top / total) * 100) / 100 };
    }
    return map;
  }

  // "tb amazon video converter" → code "tb" → TuneBoto, or its video
  // subqueue when the product is a video one.
  function codeQueue(product, cfg) {
    const code = product.split(" ")[0];
    const rule = cfg.product_codes[code];
    if (!rule) return null;
    if (rule.video_queue && /\b(video|videos|vidicable|videogo|videoone|movie)\b/.test(product)) return rule.video_queue;
    return rule.queue;
  }

  // Main queue of a subqueue: "TP-Video" → "TunePat", "Sidify-es" → "Sidify".
  function familyOf(queue, cfg) {
    const key = cleanQueueName(queue).toLowerCase().replace(/\s+/g, "");
    const same = (q) => cleanQueueName(q).toLowerCase().replace(/\s+/g, "") === key;
    for (const rule of Object.values(cfg.product_codes)) {
      if (rule.video_queue && same(rule.video_queue)) return rule.queue;
    }
    for (const [main, entry] of Object.entries(cfg.language_queues)) {
      if (same(main) || (entry.applies_to || []).some(same)) return main;
      if (Object.entries(entry).some(([k, v]) => k !== "applies_to" && same(v))) return main;
    }
    return queue;
  }

  function isLanguageQueue(queue, cfg) {
    const key = cleanQueueName(queue).toLowerCase().replace(/\s+/g, "");
    return Object.values(cfg.language_queues).some((entry) =>
      Object.entries(entry).some(([k, v]) => k !== "applies_to" && cleanQueueName(v).toLowerCase().replace(/\s+/g, "") === key));
  }

  // Non-English email → the brand's language queue, when it has one.
  function localize(queue, lang, cfg) {
    if (!lang || lang === "en") return queue;
    const entry = cfg.language_queues[familyOf(queue, cfg)];
    return entry?.[lang] || queue;
  }

  function isHomeText(text, cfg) {
    return cfg.home_keywords.some((k) => mentions(text, k));
  }

  function brandQueue(text, cfg) {
    const hits = cfg.brands.filter((b) => b.keywords.some((k) => mentions(text, k)));
    return [...new Set(hits.map((b) => b.queue))];
  }

  // One product name from an order → queue name (or home) with the source.
  function productQueue(name, cfg, learned) {
    const product = normalizeProduct(name);
    if (!product) return null;
    const code = codeQueue(product, cfg);
    if (isHomeText(product, cfg) || code === cfg.home_queue) return { queue: cfg.home_queue, source: "home" };
    if (code) return { queue: code, source: "code" };
    if (learned[product]) return { queue: learned[product].queue, source: "learned" };
    const brands = brandQueue(product, cfg);
    if (brands.length === 1) return { queue: brands[0], source: "brand" };
    return null;
  }

  // Queues named in the ticket text: learned product names (longest, most
  // specific) first, then brand keywords.
  function textQueues(text, cfg, learned) {
    const found = new Map();
    let rest = text;
    for (const [product, info] of Object.entries(learned)) {
      if (product.split(" ").length < 2) continue; // single words are too vague
      // "tp amazon video converter": customers never write the code, and the
      // rest ("amazon video converter") exists for several brands.
      if (codeQueue(product, cfg)) continue;
      if (mentions(text, product)) {
        found.set(info.queue, `提到产品「${product}」`);
        // Its brand word is already accounted for by the specific product.
        rest = rest.replace(new RegExp(escapeRe(product), "gi"), " ");
      }
    }
    for (const queue of brandQueue(rest, cfg)) {
      if (!found.has(queue)) found.set(queue, `提到品牌「${cfg.brands.find((b) => b.queue === queue).keywords[0]}」`);
    }
    return found;
  }

  // { subject, preview, products: ["Sidify Music Converter", ...] }
  // → { action: "move" | "stay" | "none", queue?, confidence: "high"|"medium", reason }
  function classify(input = {}) {
    const cfg = config();
    const result = route(input, cfg);
    const lang = detectLanguage(`${input.subject || ""}\n${input.preview || ""}`);
    const names = { es: "西语", fr: "法语", de: "德语", ja: "日语" };
    if (result.action !== "move") {
      // A home-queue ticket in a language that has its own home queue
      // (Japanese → AVCLabs JP) moves there, unless another product line
      // made the case ambiguous.
      const homeLang = lang && lang !== "en" && cfg.language_queues[cfg.home_queue]?.[lang];
      if (!homeLang || result.ambiguous) return { ...result, language: lang };
      return {
        action: "move",
        queue: homeLang,
        confidence: "high",
        language: lang,
        reason: `${names[lang] || lang}邮件 → ${homeLang}${result.reason ? `（${result.reason}）` : ""}`
      };
    }
    const queue = localize(result.queue, lang, cfg);
    if (queue === result.queue) return { ...result, language: lang };
    return { ...result, queue, language: lang, reason: `${result.reason}；${names[lang] || lang}邮件 → ${queue}` };
  }

  function route({ subject, preview, products } = {}, cfg) {
    const learned = learnedMapping(cfg);
    const text = `${subject || ""}\n${preview || ""}`.toLowerCase();
    const home = cfg.home_queue.toLowerCase();

    const named = textQueues(text, cfg, learned);
    named.delete(cfg.home_queue);
    const homeNamed = isHomeText(text, cfg);

    const orderQueues = new Map();
    for (const name of Array.isArray(products) ? products : []) {
      const hit = productQueue(name, cfg, learned);
      if (hit) orderQueues.set(hit.queue, name);
    }
    const hasHomeOrder = [...orderQueues.keys()].some((q) => q.toLowerCase() === home);
    const foreignOrders = [...orderQueues.keys()].filter((q) => q.toLowerCase() !== home);

    if (named.size === 1 && !homeNamed) {
      let [queue, why] = [...named.entries()][0];
      // "TunePat" in the text + a TP video order → the more specific TP-Video.
      const specific = foreignOrders.find((q) => q !== queue && familyOf(q, cfg) === queue);
      if (specific) {
        queue = specific;
        why = `${why}，订单是「${orderQueues.get(specific)}」`;
      }
      const ordersAgree = !hasHomeOrder;
      return {
        action: "move",
        queue,
        confidence: ordersAgree ? "high" : "medium",
        reason: ordersAgree ? why : `${why}（但客户也买过 ${cfg.home_queue} 的产品）`
      };
    }
    if (named.size > 1 && !homeNamed) {
      return { action: "none", ambiguous: true, reason: `提到多个产品线：${[...named.keys()].join("、")}，需人工判断` };
    }
    if (homeNamed) {
      return { action: "stay", reason: `邮件提到 ${cfg.home_queue} 产品` };
    }
    if (hasHomeOrder) {
      return { action: "stay", reason: `客户买过 ${cfg.home_queue} 的产品` };
    }
    if (foreignOrders.length === 1) {
      const queue = foreignOrders[0];
      return {
        action: "move",
        queue,
        confidence: "medium",
        reason: `邮件没提产品，客户只买过「${orderQueues.get(queue)}」`
      };
    }
    if (foreignOrders.length > 1) {
      return { action: "none", ambiguous: true, reason: `客户买过多个产品线：${foreignOrders.join("、")}，需人工判断` };
    }
    return { action: "none", reason: "" };
  }

  function table() {
    const cfg = config();
    const learned = loadLearned();
    return {
      home_queue: cfg.home_queue,
      brands: cfg.brands,
      product_codes: cfg.product_codes,
      learned: learnedMapping(cfg, learned),
      raw_counts: tallies(cfg, learned),
      samples: learned.samples.length,
      noisy_customers: usableSamples(cfg, learned).noisy,
      queues: learned.queues,
      updated_at: learned.updated_at
    };
  }

  return { classify, learn, table, config };
}

module.exports = { createQueueRouting, normalizeProduct, mentions, cleanQueueName, detectLanguage };
