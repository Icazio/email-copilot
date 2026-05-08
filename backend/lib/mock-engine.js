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

  if (/(free.?credits?|credit.*follow|follow.*credit|subscribe.*credit|credit.*subscri)/.test(lower)) {
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

  const youtubeIds = [...(text.matchAll(/@[\w.]{2,}/g) || [])]
    .map((m) => m[0])
    .filter((v, i, a) => a.indexOf(v) === i);

  const { youtubeScreenshot, twitterScreenshot, ambiguousImages } = classifyArticleAttachments(articles);

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
    ambiguousImages
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

  if (info.ambiguousImages) {
    parts.push("Manual check required: attached image content cannot be determined automatically. Ask the customer to clarify the channel.");
  }
  if (info.youtubeIdPending) {
    parts.push("YouTube: awaiting screenshot from customer.");
  }
  if (info.validChannels.length > 0) {
    parts.push(`Log to spreadsheet — copy the row below:\n${formatSpreadsheetRow(info)}`);
    parts.push('Check spreadsheet the next day. Once credit is confirmed, reply using "AVCLabs: Add Free Credits (login with email)" template.');
  }
  if (!info.validChannels.length && !info.youtubeIdPending && !info.ambiguousImages) {
    parts.push("No valid social media channels identified. Review the email manually.");
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
  const responses = (normalizeStructuredThread(body.thread_structured)?.available_standard_responses || []).map(
    (item) => item.toLowerCase()
  );

  if (category === "free_credit") {
    return findTemplateById("free_credit_youtube_v1", templates);
  }

  if (category === "cancel_renewal") {
    return findTemplateById("cancel_renewal_v1", templates);
  }

  if (responses.some((item) => item.includes("cancel subscription"))) {
    return findTemplateById("cancel_renewal_v1", templates);
  }

  if (responses.some((item) => item.includes("ask for refunding") || item.includes("refund policy"))) {
    return findTemplateById("refund_auto_renewal_v1", templates);
  }

  if (responses.some((item) => item.includes("register") || item.includes("new code"))) {
    return findTemplateById("license_code_not_working_v1", templates);
  }

  if (responses.some((item) => item.includes("log files"))) {
    return findTemplateById("technical_issue_collect_info_v1", templates);
  }

  if (responses.some((item) => item.includes("invoice"))) {
    return findTemplateById("invoice_request_v1", templates);
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
    free_credit: "Customer is requesting free credits for following social media channels.",
    cancel_renewal: "Customer is requesting to cancel their subscription or auto-renewal.",
    refund: "Customer is asking about a refund or charge dispute.",
    invoice: "Customer is asking for invoice or billing documentation.",
    account: "Customer is reporting an account, activation, or license code issue.",
    technical: "Customer is reporting a technical issue and likely needs information collection before escalation.",
    general: "Customer request needs manual review."
  };

  return firstLine ? `${map[category]} First visible line: ${firstLine}` : map[category];
}

function buildQuestions(category, fields) {
  const questions = [];

  if (category === "cancel_renewal") {
    if (!fields.account) {
      questions.push("Could you confirm the email address used for the purchase?");
    }
    return questions;
  }

  if (!fields.order_id && (category === "refund" || category === "invoice")) {
    questions.push("Could you please share your order number?");
  }

  if (!fields.account) {
    questions.push("Could you confirm the email address used for the purchase?");
  }

  if (category === "account") {
    questions.push("Could you share the license code and a screenshot of the error message?");
  }

  if (category === "technical") {
    questions.push("Could you share the product version, operating system, and steps to reproduce the issue?");
  }

  return [...new Set(questions)].slice(0, 4);
}

function buildNextStep(category, body) {
  if (category === "cancel_renewal") {
    const status = parseSubscriptionStatus(body?.manual_lookup_result);
    if (status === "not_found") {
      return "No order found. Ask the customer to confirm the email address used for purchase.";
    }
    if (status === "all_cancelled") {
      return "All subscriptions are already cancelled. Use the 'AVCLabs: cancel subscription' standard reply to confirm no further charges.";
    }
    if (status === "has_active") {
      return "Active subscription found (PAID). Send acknowledgment email to customer. Then escalate: People → Owner → paste order info into text field → assign New Owner to Julie Cai → set subject to '取消续订'.";
    }
    return "Run order search first to check subscription status before replying.";
  }
  if (category === "refund") {
    return "Review the order manually in the backend before sending any refund-related reply.";
  }
  if (category === "invoice") {
    return "Collect the missing billing details and continue the manual invoice process.";
  }
  if (category === "account") {
    return "After collecting the required details, continue in the technical support platform.";
  }
  if (category === "technical") {
    return "Collect missing technical details first, then record the case and escalate through the shared document and Redmine if needed.";
  }
  return "Review the email manually and choose the closest support template.";
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
      summary: `Customer is requesting free credits for following social media channels.`,
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
