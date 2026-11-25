const fs = require("fs");
const path = require("path");

const KNOWLEDGE_DIR = path.resolve(__dirname, "../../knowledge");
const TOP_N = 3;

function loadEntries(filename) {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

const allEntries = [
  ...loadEntries("products.json"),
  ...loadEntries("policies.json")
];

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[\s,.\-/()[\]{}:;!?'"]+/)
    .filter((w) => w.length > 1);
}

const NON_ASCII = /[^\x00-\x7F]/;

function tagMatches(tag, words, textLower) {
  const tagLower = tag.toLowerCase();
  if (words.has(tagLower)) return true;
  if (tokenize(tag).every((w) => words.has(w))) return true;
  // CJK and other non-ASCII tags: substring match against full text
  if (NON_ASCII.test(tag)) return textLower.includes(tagLower);
  // ASCII tags ≥4 chars: prefix match to handle plurals and verb inflections
  // e.g. "crash" matches "crashing", "crashed"; "refund" matches "refunding"
  if (tagLower.length >= 4) {
    for (const word of words) {
      if (word.startsWith(tagLower)) return true;
    }
  }
  return false;
}

function retrieve(threadText) {
  const textLower = String(threadText || "").toLowerCase();
  const words = new Set(tokenize(textLower));
  if (words.size === 0) {
    return [];
  }

  const scored = allEntries
    .map((entry) => {
      const hits = entry.tags.filter((tag) => tagMatches(tag, words, textLower)).length;
      return { entry, hits };
    })
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, TOP_N);

  return scored.map(({ entry }) => entry);
}

function buildContextBlock(entries) {
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((e) => `- ${e.title}: ${e.content}`);
  return "[COMPANY CONTEXT]\n" + lines.join("\n");
}

module.exports = {
  retrieve,
  buildContextBlock,
  entryCount: allEntries.length
};
