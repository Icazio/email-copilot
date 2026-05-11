const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");

function extractFieldsMock(input) {
  const body = typeof input === "string" ? { thread_text: input } : input || {};
  const text = buildCombinedThreadText(body, [body.manual_lookup_result, body.manual_notes]);
  const structured = normalizeStructuredThread(body.thread_structured);
  const orderMatch = text.match(/\b(?:order|order id|purchase id)[\s:#-]*([A-Z0-9-]{5,})\b/i);
  const invoiceMatch = text.match(/\b(?:invoice|invoice id|vat invoice)[\s:#-]*([A-Z0-9-]{4,})\b/i);
  const accountMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const productMatch = text.match(/\b(?:product|plan|license for)[\s:]+([A-Za-z0-9 .+/_-]{3,60})/i);
  const ticketNumberMatch = normalizeText(body.subject || "").match(/Ticket#?([A-Z0-9-]+)/i);

  return {
    order_id: orderMatch ? orderMatch[1] : null,
    account: accountMatch ? accountMatch[0] : null,
    invoice_id: invoiceMatch ? invoiceMatch[1] : null,
    product_name: productMatch ? productMatch[1].trim() : null,
    ticket_number: ticketNumberMatch ? ticketNumberMatch[1] : null,
    latest_customer_message: structured?.active_article_body
      ? structured.active_article_body.slice(0, 1200)
      : null,
    issue_type: inferIssueType(text)
  };
}

function inferCategory(text) {
  const lower = text.toLowerCase();

  if (/(invoice|billing info|tax invoice|receipt)/.test(lower)) {
    return "invoice";
  }

  const hasCreditKeyword = /\b(free.?credits?|credits?|cr[eé]ditos?|积分)\b/i.test(lower);
  const hasAtHandle = /(?<!\S)@[\w.]{3,}/i.test(text);
  const hasSocialUrl = /https?:\/\/(?:www\.)?(?:facebook|twitter|x\.com|youtube)\.com\/\S+/i.test(text);

  if (hasAtHandle || (hasCreditKeyword && hasSocialUrl)) {
    return "free_credit";
  }

  if (/(cancel.{0,20}(renew|subscri)|cancell?ation.{0,20}(subscri|plan)|do not renew|don.t renew|stop.{0,15}renew|stop.{0,10}bill|unsubscribe)/.test(lower)) {
    return "cancel_renewal";
  }

  if (/(refund|money back|auto-renew|renewed automatically)/.test(lower)) {
    return "refund";
  }

  if (
    /(license code|registration code|activation code|serial|code does not work|can't activate|cannot activate|new code)/.test(
      lower
    )
  ) {
    return "account";
  }

  if (/(bug|crash|not working|error|failed|program issue|slow|freeze|stuck)/.test(lower)) {
    return "technical";
  }

  return "general";
}

// === FREE CREDIT HELPERS ===

function didWeAskForYoutubeScreenshot(articles) {
  const askedIndex = articles.findIndex(
    (a) => a.direction === "outgoing" && /unable to verify youtube/i.test(a.body || "")
  );
  if (askedIndex === -1) return false;
  return articles.slice(askedIndex + 1).some(
    (a) => a.direction === "incoming" &&
      (a.attachments || []).some((f) => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f))
  );
}

function classifyArticleAttachments(articles) {
  let youtubeScreenshot = false;
  let twitterScreenshot = false;
  let ambiguousImages = false;

  for (const article of articles) {
    for (const filename of (article.attachments || [])) {
      const lower = filename.toLowerCase();
      if (/youtube/i.test(lower)) {
        youtubeScreenshot = true;
      } else if (/twitter|avclabsofficial|_x\.|x\.com/i.test(lower)) {
        twitterScreenshot = true;
      } else if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(lower)) {
        ambiguousImages = true;
      }
    }
  }

  // Ambiguous image: infer from thread context (we asked → user replied with image)
  if (ambiguousImages && !youtubeScreenshot && didWeAskForYoutubeScreenshot(articles)) {
    youtubeScreenshot = true;
    ambiguousImages = false;
  }

  return { youtubeScreenshot, twitterScreenshot, ambiguousImages };
}

function extractFreeCredit(body) {
  const text = buildCombinedThreadText(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const articles = structured?.articles || [];

  const facebookLinks = [...(text.matchAll(/https?:\/\/(?:www\.)?facebook\.com\/\S+/gi) || [])]
    .map((m) => m[0].replace(/[,.)>\s]+$/, ""))
    .filter((v, i, a) => a.indexOf(v) === i);

  const twitterLinks = [...(text.matchAll(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/\S+/gi) || [])]
    .map((m) => m[0].replace(/[,.)>\s]+$/, ""))
    .filter((v, i, a) => a.indexOf(v) === i);

  const youtubeIds = [...(text.matchAll(/(?<!\S)@[\w.]{2,}/g) || [])]
    .map((m) => m[0])
    .filter((v, i, a) => a.indexOf(v) === i);

  const classified = classifyArticleAttachments(articles);
  let youtubeScreenshot = classified.youtubeScreenshot;
  const twitterScreenshot = classified.twitterScreenshot;
  let ambiguousImages = classified.ambiguousImages;

  // Ambiguous screenshot + YouTube handle → generate spreadsheet row but flag for manual verification
  let screenshotNeedsVerification = false;
  if (ambiguousImages && !youtubeScreenshot && youtubeIds.length > 0) {
    youtubeScreenshot = true;
    ambiguousImages = false;
    screenshotNeedsVerification = true;
  }

  const validChannels = [];
  const validLinks = [];

  if (facebookLinks.length) {
    validChannels.push("Facebook");
    validLinks.push(...facebookLinks);
  }
  if (twitterLinks.length || twitterScreenshot) {
    validChannels.push("Twitter");
    if (twitterLinks.length) validLinks.push(...twitterLinks);
    else validLinks.push("截图");
  }
  if (youtubeScreenshot) {
    validChannels.push("Youtube");
    validLinks.push("截图");
  }

  const customerEmail =
    structured?.customer_id_email ||
    structured?.customer_email ||
    (structured?.customer_email_candidates || [])[0] ||
    (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";

  const youtubeIdPending = youtubeIds.length > 0 && !youtubeScreenshot;

  return {
    validChannels,
    validLinks,
    youtubeIdPending,
    youtubeIds,
    totalCredits: validChannels.length * 60,
    customerEmail,
    ambiguousImages,
    screenshotNeedsVerification
  };
}

function formatSpreadsheetRow(info) {
  const now = new Date();
  const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  return `${date}\t${info.customerEmail}\t${info.validChannels.join(" ")}\t${info.totalCredits}\t\t${info.validLinks.join("\n")}`;
}

function buildFreeCreditDraft(info, template) {
  const opening = template?.opening || "Hi,";
  const closing = template?.closing || "Best regards,";
  const youtubeAsk =
    "As we're currently unable to verify YouTube subscriptions from our end, could you please send us a screenshot showing that you've subscribed to our YouTube channel? This will help us complete the verification process.";

  // All channels confirmed — no draft needed
  if (!info.youtubeIdPending && !info.ambiguousImages) {
    return "";
  }

  // Ambiguous image — can't determine channel
  if (info.ambiguousImages) {
    return `${opening}

Thank you for reaching out.

We received your message but were unable to determine which channel the attached image is for. Could you please confirm which platform the screenshot is from?

${closing}`.trim();
  }

  // Has valid channels + YouTube ID pending
  if (info.validChannels.length > 0 && info.youtubeIdPending) {
    const channelNote = `We have received your ${info.validChannels.join(" and ")} follow information and will process it shortly.`;
    return `${opening}

Thank you for your support!

${channelNote}

Regarding your YouTube subscription — ${youtubeAsk}

${closing}`.trim();
  }

  // Only YouTube ID, nothing else confirmed yet
  return `${opening}

Thank you for your support!

${youtubeAsk}

${closing}`.trim();
}

function buildFreeCreditNextStep(info) {
  const parts = [];

  if (info.screenshotNeedsVerification) {
    parts.push("检测到附件截图，请查看截图确认是否为关注截图。确认后可使用下方表格行记录。");
  }
  if (info.ambiguousImages) {
    parts.push("检测到附件截图，但无法自动判断对应渠道，请查看截图内容确认。");
  }
  if (info.youtubeIdPending) {
    parts.push("YouTube：等待客户发送订阅截图。");
  }
  if (info.validChannels.length > 0) {
    parts.push("将下方表格行复制到积分记录表格。");
    parts.push('次日确认表格中积分已发放后，使用「AVCLabs: Add Free Credits (login with email)」模板回复客户。');
  }
  if (!info.validChannels.length && !info.youtubeIdPending && !info.ambiguousImages) {
    parts.push("未识别到有效社交媒体渠道，请人工核查邮件内容。");
  }

  return parts.join("\n\n");
}

// === END FREE CREDIT HELPERS ===

// Returns "has_active" | "all_cancelled" | "not_found" | null
function parseSubscriptionStatus(manualLookupResult) {
  if (!manualLookupResult) return null;
  const hasPaid = /\bPAID\b/.test(manualLookupResult);
  if (hasPaid) return "has_active";
  const hasCancelled = /\bSUBSCRIPTION_CANCELLED\b/.test(manualLookupResult);
  if (hasCancelled) return "all_cancelled";
  return "not_found";
}

// Returns true if this email was forwarded by Paddle as a reseller
function isPaddleForward(text) {
  return /paddle acts as a reseller/i.test(text);
}

function inferIssueType(text) {
  const lower = text.toLowerCase();
  if (/(auto-renew|renewed automatically)/.test(lower)) {
    return "refund_auto_renewal";
  }
  if (/(cancel renewal|cancel subscription|stop renewal)/.test(lower)) {
    return "cancel_renewal";
  }
  if (/(invoice|tax invoice|receipt)/.test(lower)) {
    return "invoice_request";
  }
  if (/(license code|registration code|activation code|serial|can't activate|cannot activate|new code)/.test(lower)) {
    return "license_code_not_working";
  }
  if (/(slow|crash|error|failed|freeze|program issue)/.test(lower)) {
    return "technical_issue";
  }
  return "general";
}

function suggestTemplateFromStructuredData(category, body, templates) {
  if (category === "free_credit") {
    return findTemplateById("free_credit_youtube_v1", templates);
  }

  if (category === "cancel_renewal") {
    return findTemplateById("cancel_renewal_v1", templates);
  }

  if (category === "account") {
    return findTemplateById("license_code_not_working_v1", templates);
  }

  if (category === "technical") {
    return findTemplateById("technical_issue_collect_info_v1", templates);
  }

  return null;
}

function buildSummary(text, category, structured) {
  const firstLine = normalizeText(structured?.active_article_body || text).split("\n")[0] || "";

  const map = {
    free_credit: "客户申请关注社交媒体渠道的免费积分。",
    cancel_renewal: "客户请求取消订阅或自动续费。",
    refund: "客户就退款或扣费问题进行咨询。",
    invoice: "客户需要发票或账单文件。",
    account: "客户反映账户、激活或许可证代码问题。",
    technical: "客户报告技术问题，可能需要收集信息后再升级处理。",
    general: "需人工核查客户请求内容。"
  };

  return firstLine ? `${map[category]} 邮件首行：${firstLine}` : map[category];
}

function buildQuestions(category, fields) {
  const questions = [];

  if (category === "cancel_renewal") {
    if (!fields.account) {
      questions.push("请问您购买时使用的邮箱地址是什么？");
    }
    return questions;
  }

  if (!fields.order_id && (category === "refund" || category === "invoice")) {
    questions.push("请问您的订单号是多少？");
  }

  if (!fields.account) {
    questions.push("请问您购买时使用的邮箱地址是什么？");
  }

  if (category === "account") {
    questions.push("请提供许可证代码以及报错截图，以便我们协助排查。");
  }

  if (category === "technical") {
    questions.push("请告知产品版本、操作系统，以及问题的复现步骤。");
  }

  return [...new Set(questions)].slice(0, 4);
}

function buildNextStep(category, body) {
  if (category === "cancel_renewal") {
    const status = parseSubscriptionStatus(body?.manual_lookup_result);
    if (status === "not_found") {
      return "未查到订单，请让客户确认购买时使用的邮箱地址。";
    }
    if (status === "all_cancelled") {
      return "所有订阅已取消。使用「AVCLabs: cancel subscription」标准回复，告知客户不会再产生扣费。";
    }
    if (status === "has_active") {
      return "发现有效订阅（PAID）。先发送确认邮件给客户，然后升级处理：People → Owner → 将订单信息粘贴到文本框 → 将 New Owner 指派给 Julie Cai → 将标题设为「取消续订」。";
    }
    return "请先执行订单查询，确认订阅状态后再回复客户。";
  }
  if (category === "refund") {
    return "发送任何退款相关回复前，请先在后台人工核查订单。";
  }
  if (category === "invoice") {
    return "收集缺失的账单信息后，继续人工开票流程。";
  }
  if (category === "account") {
    return "收集所需信息后，在技术支持平台继续处理。";
  }
  if (category === "technical") {
    return "先收集缺失的技术信息，再在共享文档和 Redmine 中记录并升级处理。";
  }
  return "请人工核查邮件内容，选择最接近的支持模板。";
}

function buildCancelRenewalDraft(body, template) {
  const opening = template?.opening || "Hi,";
  const closing = template?.closing || "Best regards,";
  const status = parseSubscriptionStatus(body?.manual_lookup_result);

  if (status === "all_cancelled") {
    return `${opening}

Thank you for contacting us.

We have checked your account and can confirm that your subscription has already been cancelled. No further charges will be made to your account.

${closing}`.trim();
  }

  if (status === "has_active") {
    return `${opening}

Thank you for contacting us.

We have received your request and will assist you in submitting your request to cancel your auto-renewal. You will be notified by email upon success.

${closing}`.trim();
  }

  // not_found or no order search run yet
  return `${opening}

Thank you for contacting us.

To help us locate your subscription, could you please confirm the email address used for the purchase?

${closing}`.trim();
}

function buildDraft({ category, fields, template, body }) {
  if (category === "cancel_renewal") {
    return buildCancelRenewalDraft(body, template);
  }

  const customerNeed = {
    refund: "your refund-related request",
    invoice: "your invoice request",
    account: "the activation issue",
    technical: "the issue you reported",
    general: "your request"
  }[category];

  const opening = template?.opening || "Hi,";
  const closing = template?.closing || "Best regards,";
  const orderSentence = fields.order_id ? `We have noted your order number: ${fields.order_id}. ` : "";
  const contextSentence =
    category === "account" && fields.latest_customer_message
      ? "Based on your latest message, it appears that the activation code is not working as expected. "
      : "";
  const questions = buildQuestions(category, fields);
  const questionBlock = questions.length
    ? `To help us proceed, could you please provide the following information?\n\n- ${questions.join("\n- ")}`
    : "We will review the details and assist you further.";

  return `${opening}

Thank you for contacting us.

We understand that you are contacting us about ${customerNeed}. ${contextSentence}${orderSentence}${
    template?.body_guidance?.[0] || "We would like to help you with this as quickly as possible."
  }

${questionBlock}

${closing}`.trim();
}

function analyzeThreadMock(body, templates) {
  const threadText = buildCombinedThreadText(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const category = inferCategory(threadText);

  if (category === "free_credit") {
    const info = extractFreeCredit(body);
    const template = findTemplateById("free_credit_youtube_v1", templates);
    return {
      category,
      summary: `客户申请关注社交媒体渠道的免费积分。`,
      confidence: 0.85,
      extracted_fields: {
        customer_email: info.customerEmail,
        valid_channels: info.validChannels,
        total_credits: info.totalCredits,
        youtube_id_pending: info.youtubeIdPending,
        youtube_ids: info.youtubeIds
      },
      clarification_questions: [],
      next_step: buildFreeCreditNextStep(info),
      spreadsheet_row: info.validChannels.length > 0 ? formatSpreadsheetRow(info) : "",
      suggested_template_id: info.youtubeIdPending ? (template?.id || null) : null
    };
  }

  const fields = extractFieldsMock(body);
  const template =
    findTemplateById(body.template_ids?.[0], templates) ||
    suggestTemplateFromStructuredData(category, body, templates) ||
    pickTemplate(category, templates);

  return {
    category,
    summary: buildSummary(threadText, category, structured),
    confidence: 0.78,
    extracted_fields: fields,
    clarification_questions: buildQuestions(category, fields),
    next_step: buildNextStep(category, body),
    suggested_template_id: template?.id || null
  };
}

function generateDraftMock(body, templates) {
  const threadText = buildCombinedThreadText(body);
  const category = body.category || inferCategory(threadText);

  if (category === "free_credit") {
    const info = extractFreeCredit(body);
    const template = findTemplateById("free_credit_youtube_v1", templates);
    return {
      category,
      draft_reply: buildFreeCreditDraft(info, template),
      clarification_questions: [],
      next_step: buildFreeCreditNextStep(info),
      spreadsheet_row: info.validChannels.length > 0 ? formatSpreadsheetRow(info) : "",
      extracted_fields: {
        customer_email: info.customerEmail,
        valid_channels: info.validChannels,
        total_credits: info.totalCredits,
        youtube_id_pending: info.youtubeIdPending,
        youtube_ids: info.youtubeIds
      },
      template_id: template?.id || null
    };
  }

  const fields = extractFieldsMock(body);
  const template =
    findTemplateById(body.template_ids?.[0], templates) ||
    suggestTemplateFromStructuredData(category, body, templates) ||
    pickTemplate(category, templates);

  return {
    category,
    draft_reply: buildDraft({ category, fields, template, body }),
    clarification_questions: buildQuestions(category, fields),
    next_step: buildNextStep(category, body),
    extracted_fields: fields,
    template_id: template?.id || null
  };
}

function refineDraftMock(body, templates) {
  const mergedText = buildCombinedThreadText(body, [body.manual_lookup_result, body.manual_notes]);
  const category = body.category || inferCategory(mergedText);

  if (category === "free_credit") {
    const info = extractFreeCredit(body);
    const template = findTemplateById("free_credit_youtube_v1", templates);
    return {
      category,
      draft_reply: buildFreeCreditDraft(info, template),
      clarification_questions: [],
      next_step: buildFreeCreditNextStep(info),
      spreadsheet_row: info.validChannels.length > 0 ? formatSpreadsheetRow(info) : "",
      extracted_fields: {
        customer_email: info.customerEmail,
        valid_channels: info.validChannels,
        total_credits: info.totalCredits,
        youtube_id_pending: info.youtubeIdPending,
        youtube_ids: info.youtubeIds
      },
      template_id: template?.id || null
    };
  }

  const fields = extractFieldsMock(body);
  const template =
    findTemplateById(body.template_ids?.[0], templates) ||
    suggestTemplateFromStructuredData(category, body, templates) ||
    pickTemplate(category, templates);

  return {
    category,
    draft_reply: buildDraft({ category, fields, template, body }),
    clarification_questions: buildQuestions(category, fields),
    next_step: buildNextStep(category, body),
    extracted_fields: fields,
    template_id: template?.id || null
  };
}

module.exports = {
  analyzeThreadMock,
  extractFieldsMock,
  generateDraftMock,
  refineDraftMock
};
