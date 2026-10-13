const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.resolve(__dirname, "../prompts");

function loadJson(filename) {
  const filePath = path.join(PROMPTS_DIR, filename);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadClassificationRules() {
  return loadJson("classification-rules.json");
}

function loadQuestions() {
  return loadJson("questions.json");
}

function loadGuidance() {
  return loadJson("guidance.json");
}

function loadSummaries() {
  return loadJson("summaries.json");
}

function loadDraftTemplates() {
  return loadJson("draft-templates.json");
}

function loadFreeCreditConfig() {
  return loadJson("free-credit-config.json");
}

function loadIssueTypes() {
  return loadJson("issue-types.json");
}

function getSummary(category, firstLine = "") {
  const summaries = loadSummaries();
  const template = summaries[category] || summaries["general"];
  return firstLine ? `${template} 邮件首行：${firstLine}` : template;
}

function getQuestions(category, fields = {}) {
  const questions = loadQuestions();
  const categoryQuestions = questions[category] || [];

  if (category === "cancel_renewal") {
    return !fields.account ? categoryQuestions : [];
  }

  const allQuestions = [...categoryQuestions];
  if (!fields.order_id && (category === "refund" || category === "invoice")) {
    allQuestions.unshift("请问您的订单号是多少？");
  }
  if (!fields.account && !allQuestions.includes("请问您购买时使用的邮箱地址是什么？")) {
    allQuestions.unshift("请问您购买时使用的邮箱地址是什么？");
  }

  return [...new Set(allQuestions)].slice(0, 4);
}

function getGuidance(category, status = null) {
  const guidance = loadGuidance();
  const categoryGuidance = guidance[category];

  if (typeof categoryGuidance === "string") {
    return categoryGuidance;
  }

  if (typeof categoryGuidance === "object" && status) {
    return categoryGuidance[status] || "请人工核查邮件内容。";
  }

  return "请人工核查邮件内容。";
}

function getFreeCreditGuidance(guidanceKey) {
  const guidance = loadGuidance();
  return guidance.free_credit?.[guidanceKey] || "";
}

function buildFreeCreditNextStepFromConfig(info) {
  const config = loadFreeCreditConfig();
  const parts = [];

  if (info.screenshotNeedsVerification) {
    parts.push(getFreeCreditGuidance("screenshot_needs_verification"));
  }
  if (info.ambiguousImages) {
    parts.push(getFreeCreditGuidance("ambiguous_images"));
  }
  if (info.youtubeIdPending) {
    parts.push(getFreeCreditGuidance("youtube_pending"));
  }
  if (info.validChannels.length > 0) {
    parts.push(getFreeCreditGuidance("valid_channels"));
  }
  if (!info.validChannels.length && !info.youtubeIdPending && !info.ambiguousImages) {
    parts.push(getFreeCreditGuidance("no_valid_channels"));
  }

  return parts.join("\n\n");
}

function getDraftTemplate(category, templateKey = null) {
  const templates = loadDraftTemplates();
  const categoryTemplate = templates[category];

  if (templateKey && typeof categoryTemplate === "object") {
    return categoryTemplate[templateKey];
  }

  return categoryTemplate;
}

module.exports = {
  loadClassificationRules,
  loadQuestions,
  loadGuidance,
  loadSummaries,
  loadDraftTemplates,
  loadFreeCreditConfig,
  loadIssueTypes,
  getSummary,
  getQuestions,
  getGuidance,
  getFreeCreditGuidance,
  buildFreeCreditNextStepFromConfig,
  getDraftTemplate
};
