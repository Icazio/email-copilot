const fs = require("fs");
const path = require("path");

// Shared sender block/allow lists. Runtime data (contains real email addresses),
// so it lives in backend/state/ which is git-ignored.
const DEFAULT_FILE = path.join(__dirname, "../state/spam-lists.json");

// Payment processors / app stores send legitimate refund and dispute notices
// from no-reply style addresses, and customers send sample videos / logs via
// file-transfer services — never let these be classified as spam.
const DEFAULT_ALLOWED_DOMAINS = ["paddle.com", "stripe.com", "paypal.com", "apple.com", "avclabs.com", "wetransfer.com"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function emptyLists() {
  return {
    blocked_senders: [],
    blocked_domains: [],
    allowed_senders: [],
    allowed_domains: [...DEFAULT_ALLOWED_DOMAINS]
  };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : "";
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^@/, "");
  return DOMAIN_RE.test(domain) ? domain : "";
}

function domainOf(email) {
  const normalized = normalizeEmail(email);
  return normalized ? normalized.slice(normalized.lastIndexOf("@") + 1) : "";
}

// True when `domain` equals `listed` or is a subdomain of it (mail.paddle.com → paddle.com).
function domainMatches(domain, listed) {
  return domain === listed || domain.endsWith("." + listed);
}

function sanitize(raw) {
  const base = emptyLists();
  if (!raw || typeof raw !== "object") return base;
  const uniq = (arr, fn) => [...new Set((Array.isArray(arr) ? arr : []).map(fn).filter(Boolean))].sort();
  return {
    blocked_senders: uniq(raw.blocked_senders, normalizeEmail),
    blocked_domains: uniq(raw.blocked_domains, normalizeDomain),
    allowed_senders: uniq(raw.allowed_senders, normalizeEmail),
    // Defaults are always merged in, so domains added in a later release reach
    // installs whose list file was created earlier.
    allowed_domains: uniq([...base.allowed_domains, ...(Array.isArray(raw.allowed_domains) ? raw.allowed_domains : [])], normalizeDomain)
  };
}

function createSpamLists(filePath = DEFAULT_FILE) {
  function load() {
    try {
      return sanitize(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (_error) {
      return emptyLists();
    }
  }

  function save(lists) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lists, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  }

  // Allow beats block: a sender that support explicitly marked as legitimate
  // (or a payment-processor domain) must never be hidden as spam.
  function check(email) {
    const sender = normalizeEmail(email);
    if (!sender) return null;
    const domain = domainOf(sender);
    const lists = load();
    if (lists.allowed_senders.includes(sender)) return "allowed";
    if (lists.allowed_domains.some((d) => domainMatches(domain, d))) return "allowed";
    if (lists.blocked_senders.includes(sender)) return "blocked";
    if (lists.blocked_domains.some((d) => domainMatches(domain, d))) return "blocked";
    return null;
  }

  // action: block | unblock | block_domain | unblock_domain | allow | disallow | import
  function apply({ action, email, domain, emails } = {}) {
    const lists = load();
    const add = (key, value) => { if (value && !lists[key].includes(value)) lists[key].push(value); };
    const remove = (key, value) => { lists[key] = lists[key].filter((v) => v !== value); };
    const sender = normalizeEmail(email);
    const dom = normalizeDomain(domain) || domainOf(email);

    switch (action) {
      case "block":
        if (!sender) throw badRequest("email is required");
        add("blocked_senders", sender);
        remove("allowed_senders", sender);
        break;
      case "unblock":
        if (!sender) throw badRequest("email is required");
        remove("blocked_senders", sender);
        break;
      case "block_domain":
        if (!dom) throw badRequest("domain is required");
        if (lists.allowed_domains.some((d) => domainMatches(dom, d))) {
          throw badRequest(`${dom} is on the allowed domain list`);
        }
        add("blocked_domains", dom);
        break;
      case "unblock_domain":
        if (!dom) throw badRequest("domain is required");
        remove("blocked_domains", dom);
        break;
      case "allow":
        if (!sender) throw badRequest("email is required");
        add("allowed_senders", sender);
        remove("blocked_senders", sender);
        break;
      case "disallow":
        if (!sender) throw badRequest("email is required");
        remove("allowed_senders", sender);
        break;
      case "import":
        // One-time migration of the old per-browser localStorage blocklist.
        (Array.isArray(emails) ? emails : []).map(normalizeEmail).forEach((e) => {
          if (e && !lists.allowed_senders.includes(e)) add("blocked_senders", e);
        });
        break;
      default:
        throw badRequest(`unknown action: ${action}`);
    }

    const next = sanitize(lists);
    save(next);
    return next;
  }

  // Regex fragments for Znuny PostMaster filters (layer 1 hand-off).
  function exportFilterPatterns() {
    const lists = load();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      from_senders: lists.blocked_senders.length ? `^(${lists.blocked_senders.map(esc).join("|")})$` : "",
      from_domains: lists.blocked_domains.length ? `@(.+\\.)?(${lists.blocked_domains.map(esc).join("|")})$` : ""
    };
  }

  return { load, check, apply, exportFilterPatterns, filePath };
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = { createSpamLists, normalizeEmail, normalizeDomain, domainOf, DEFAULT_ALLOWED_DOMAINS };
