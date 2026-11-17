const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");
const {
  loadClassificationRules,
  loadFreeCreditConfig,
  getSummary,
  getQuestions,
  getGuidance,
  getFreeCreditGuidance,
  buildFreeCreditNextStepFromConfig,
  getDraftTemplate
} = require("./mock-engine-loader");

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
  const rules = loadClassificationRules();

  if (new RegExp(rules.invoice.pattern).test(lower)) {
    return "invoice";
  }

  const creditRule = rules.free_credit;
  const hasCreditKeyword = new RegExp(creditRule.patterns.hasCreditsKeyword).test(lower);
  const hasAtHandle = new RegExp(creditRule.patterns.hasAtHandle).test(text);
  const hasSocialUrl = new RegExp(creditRule.patterns.hasSocialUrl).test(text);

  if (hasAtHandle || (hasCreditKeyword && hasSocialUrl)) {
    return "free_credit";
  }

  if (new RegExp(rules.cancel_renewal.pattern).test(lower)) {
    return "cancel_renewal";
  }

  if (new RegExp(rules.refund.pattern).test(lower)) {
    return "refund";
  }

  if (new RegExp(rules.account.pattern).test(lower)) {
    return "account";
  }

  if (new RegExp(rules.technical.pattern).test(lower)) {
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
  const draftTemplates = getDraftTemplate("free_credit");
  const youtubeAsk = draftTemplates.youtube_ask;

  // All channels confirmed — no draft needed
  if (!info.youtubeIdPending && !info.ambiguousImages) {
    return "";
  }

  // Ambiguous image — can't determine channel
  if (info.ambiguousImages) {
    return draftTemplates.ambiguous_image.replace("{closing}", closing).trim();
  }

  // Has valid channels + YouTube ID pending
  if (info.validChannels.length > 0 && info.youtubeIdPending) {
    const channelNote = `We have received your ${info.validChannels.join(" and ")} follow information and will process it shortly.`;
    return draftTemplates.valid_channels_with_youtube_pending
      .replace("{channels}", info.validChannels.join(" and "))
      .replace("{youtube_ask}", youtubeAsk)
      .replace("{closing}", closing)
      .replace(`${opening}\n\n`, "")
      .trim();
  }

  // Only YouTube ID, nothing else confirmed yet
  return draftTemplates.only_youtube_id
    .replace("{youtube_ask}", youtubeAsk)
    .replace("{closing}", closing)
    .replace(`${opening}\n\n`, "")
    .trim();
}

function buildFreeCreditNextStep(info) {
  return buildFreeCreditNextStepFromConfig(info);
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
  return getSummary(category, firstLine);
}

function buildQuestions(category, fields) {
  return getQuestions(category, fields);
}

function buildNextStep(category, body) {
  if (category === "cancel_renewal") {
    const status = parseSubscriptionStatus(body?.manual_lookup_result);
    return getGuidance(category, status);
  }
  return getGuidance(category);
}

function buildCancelRenewalDraft(body, template) {
  const opening = template?.opening || "Hi,";
  const closing = template?.closing || "Best regards,";
  const status = parseSubscriptionStatus(body?.manual_lookup_result);
  const draftTemplates = getDraftTemplate("cancel_renewal");

  const templateKey = status === "all_cancelled" ? "all_cancelled" :
                      status === "has_active" ? "has_active" : "not_found";

  return `${opening}\n\n${draftTemplates[templateKey]}\n\n${closing}`.trim();
}

function buildDraft({ category, fields, template, body }) {
  if (category === "cancel_renewal") {
    return buildCancelRenewalDraft(body, template);
  }

  const draftTemplate = getDraftTemplate("generic_support");
  const categoryTemplate = getDraftTemplate(category);
  const customerNeed = categoryTemplate?.customer_need || "your request";

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

  return draftTemplate
    .replace("{opening}", opening)
    .replace("{customer_need}", customerNeed)
    .replace("{context_sentence}", contextSentence)
    .replace("{order_sentence}", orderSentence)
    .replace("{body_guidance}", template?.body_guidance?.[0] || "We would like to help you with this as quickly as possible.")
    .replace("{question_block}", questionBlock)
    .replace("{closing}", closing);
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

function chatMock({ messages = [], thread_context = {}, order_context = "" } = {}) {
  const lastMsg = String(messages[messages.length - 1]?.content || "").toLowerCase();
  const subject = thread_context?.subject || "";
  const hasThread = Boolean((thread_context?.thread_text || "").trim());

  if (/draft|reply|write|compose|email/i.test(lastMsg)) {
    const body = hasThread
      ? "Thank you for contacting us. We have reviewed your request and will follow up with you shortly."
      : "Thank you for reaching out to AVCLabs Support. Could you please provide more details about your issue so we can assist you?";
    return {
      reply: `Subject: Re: ${subject || "(no subject)"}\n\nDear Customer,\n\n${body}\n\nBest regards,\nAVCLabs Support Team`
    };
  }

  if (/summar|what is the issue|what happened|describe/i.test(lastMsg)) {
    return {
      reply: hasThread
        ? `Summary: The customer has submitted a support request. Subject: "${subject}". Please review the email thread for full context.`
        : "No email thread has been captured yet. Click Capture to extract the thread from the current page."
    };
  }

  if (/ask|question|need.*info|what.*info|missing/i.test(lastMsg)) {
    return {
      reply: "Consider asking the customer for:\n- Their purchase email address\n- Order ID or transaction ID\n- Product name and version\n- Operating system\n- Steps already attempted"
    };
  }

  if (/next step|what should|recommend|eligible|refund|policy/i.test(lastMsg)) {
    return {
      reply: "Review the customer's issue against our standard policies. If order information is available, check the purchase date and status before proceeding. Use the Order Search to look up their order if you have their email."
    };
  }

  return {
    reply: `Running in mock mode — responses are template-based.\n\nFor full AI assistance, configure a real provider in .env:\n  AI_PROVIDER=deepseek\n  DEEPSEEK_API_KEY=...\n\nTry asking: "Write a reply", "Summarize the issue", or "What should I ask?"`
  };
}

module.exports = {
  extractFreeCredit,
  analyzeThreadMock,
  extractFieldsMock,
  generateDraftMock,
  refineDraftMock,
  chatMock
};
