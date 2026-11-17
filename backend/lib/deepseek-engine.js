const fs = require("fs");
const path = require("path");
const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById,
  formatOrdersForPrompt
} = require("./helpers");
const { extractFieldsMock, analyzeThreadMock, generateDraftMock, refineDraftMock } = require("./mock-engine");
const { retrieve, buildContextBlock } = require("./knowledge-retriever");
const { buildSystemInstructions: buildSystemInstructionsFromPrompt } = require("./prompt-loader");
const { recordDeepSeekRequest } = require("./deepseek-request-logger");

const logDir = path.join(__dirname, "../logs");
const logFile = path.join(logDir, "deepseek-debug.log");

// 创建logs目录（如果不存在）
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeLog(content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${content}\n`;
  fs.appendFileSync(logFile, logEntry, "utf8");
}

async function callDeepSeekChat({ model, instructions, input, maxTokens = 1200 }) {
  const requestPayload = {
    model,
    max_tokens: maxTokens,
    response_format: {
      type: "json_object"
    },
    messages: [
      {
        role: "system",
        content: instructions
      },
      {
        role: "user",
        content: input
      }
    ]
  };

  writeLog("========== DeepSeek API Request ==========");
  writeLog(`Model: ${model}`);
  writeLog(`Max Tokens: ${maxTokens}`);
  writeLog(`System Instructions:\n${instructions}`);
  writeLog(`\nUser Input:\n${input}`);
  writeLog("==========================================");

  const requestBody = JSON.stringify(requestPayload);
  recordDeepSeekRequest(requestBody, "structured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: requestBody,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "terminated" : err.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    writeLog(`ERROR: DeepSeek API returned ${response.status} ${response.statusText}`);
    throw new Error(`DeepSeek request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";

  writeLog("========== DeepSeek API Response ==========");
  writeLog(`Raw Response:\n${JSON.stringify(data, null, 2)}`);
  writeLog(`Extracted Content:\n${content}`);
  writeLog("===========================================");

  if (!content.trim()) {
    throw new Error("DeepSeek returned empty content.");
  }

  return content;
}


function buildTemplateContext(template) {
  if (!template) {
    return "No template provided.";
  }

  return JSON.stringify(
    {
      id: template.id,
      scene: template.scene,
      opening: template.opening,
      body_guidance: template.body_guidance,
      closing: template.closing
    },
    null,
    2
  );
}

function buildAgentAnalysisBlock(body) {
  const lines = [];

  if (typeof body.agent_summary === "string") {
    lines.push(body.agent_summary.trim()
      ? `Summary: ${body.agent_summary.trim()}`
      : "The agent has cleared the summary — do not infer or restate one.");
  }

  if (typeof body.agent_questions === "string") {
    lines.push(body.agent_questions.trim()
      ? `Questions to ask: ${body.agent_questions.trim()}`
      : "The agent has removed all clarification questions. Do NOT include any questions in the draft reply.");
  }

  if (typeof body.agent_next_step === "string") {
    lines.push(body.agent_next_step.trim()
      ? `Next step: ${body.agent_next_step.trim()}`
      : "The agent has cleared the next step. Do NOT suggest any next steps or actions in the draft reply.");
  }

  if (lines.length === 0) return "";
  return `Agent analysis (reviewed and possibly edited — treat as ground truth, do not override):\n${lines.join("\n")}`;
}

function tryParseJson(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON object returned by DeepSeek.");
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

async function analyzeThreadDeepSeek({ model, body, templates }) {
  const mockResult = analyzeThreadMock(body, templates);
  if (mockResult.category === "free_credit") return mockResult;
  const template = findTemplateById(body.template_ids?.[0], templates) || pickTemplate("general", templates);
  const structured = normalizeStructuredThread(body.thread_structured);
  const threadText = buildCombinedThreadText(body);
  const contextBlock = buildContextBlock(retrieve(threadText));

  writeLog(`[analyze-thread] template selection - requested template_id: ${body.template_ids?.[0]}, selected: ${template?.id}`);
  writeLog(`[analyze-thread] ticket subject: ${body.subject || "N/A"}`);
  const input = [
    "Task: analyze-thread",
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    threadText,
    "Template context:",
    buildTemplateContext(template),
    "Return json with keys:",
    "category, summary, confidence, extracted_fields, clarification_questions, next_step, suggested_template_id"
  ].join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructionsFromPrompt("analyze-thread", contextBlock),
    input,
    maxTokens: 900
  });

  return tryParseJson(text);
}

async function generateDraftDeepSeek({ model, body, templates }) {
  if (body.category === "free_credit") return generateDraftMock(body, templates);
  const template =
    findTemplateById(body.template_ids?.[0], templates) || pickTemplate(body.category || "general", templates);
  const extractedFields = extractFieldsMock(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const threadText = buildCombinedThreadText(body);
  const contextBlock = buildContextBlock(retrieve(threadText));
  const agentAnalysis = buildAgentAnalysisBlock(body);

  writeLog(`[generate-draft] category: ${body.category}, template selection - requested: ${body.template_ids?.[0]}, selected: ${template?.id}`);

  const input = [
    "Task: generate-draft",
    `Category: ${body.category || "unknown"}`,
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    threadText,
    agentAnalysis,
    "Manual notes:",
    normalizeText(body.manual_notes || ""),
    "Extracted fields:",
    JSON.stringify(extractedFields, null, 2),
    "Template context:",
    buildTemplateContext(template),
    "Return json with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].filter(Boolean).join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructionsFromPrompt("generate-draft", contextBlock),
    input,
    maxTokens: 1400
  });

  return tryParseJson(text);
}

async function refineDraftDeepSeek({ model, body, templates }) {
  if (body.category === "free_credit") return refineDraftMock(body, templates);
  const template =
    findTemplateById(body.template_ids?.[0], templates) || pickTemplate(body.category || "general", templates);
  const mergedFields = extractFieldsMock(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const threadText = buildCombinedThreadText(body);
  const contextBlock = buildContextBlock(retrieve(threadText));

  writeLog(`[refine-draft] category: ${body.category}, template selection - requested: ${body.template_ids?.[0]}, selected: ${template?.id}`);

  const agentAnalysis = buildAgentAnalysisBlock(body);

  const input = [
    "Task: refine-draft",
    `Category: ${body.category || "unknown"}`,
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    threadText,
    agentAnalysis,
    "Manual lookup result:",
    normalizeText(body.manual_lookup_result || ""),
    "Manual notes:",
    normalizeText(body.manual_notes || ""),
    "Previous draft:",
    normalizeText(body.previous_draft || ""),
    "Extracted fields:",
    JSON.stringify(mergedFields, null, 2),
    "Template context:",
    buildTemplateContext(template),
    "Return json with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].filter(Boolean).join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructionsFromPrompt("refine-draft", contextBlock),
    input,
    maxTokens: 1600
  });

  return tryParseJson(text);
}

async function callDeepSeekChatRaw({ model, systemPrompt, messages, maxTokens = 1600 }) {
  const requestMessages = [
    { role: "system", content: systemPrompt },
    ...messages
  ];

  const requestBody = JSON.stringify({ model, max_tokens: maxTokens, messages: requestMessages });
  recordDeepSeekRequest(requestBody, "chat");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: requestBody,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "terminated" : err.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    const err = new Error(`DeepSeek request failed: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const msg = data?.choices?.[0]?.message || {};
  const finishReason = data?.choices?.[0]?.finish_reason || "";
  const content = typeof msg.content === "string" ? msg.content : "";

  writeLog(`[chat-raw] finish_reason=${finishReason} content_chars=${(msg.content || "").length} reasoning_chars=${(msg.reasoning_content || "").length}`);

  if (!content.trim() || finishReason === "length") {
    const err = new Error("模型未生成完整的正式回答，请重试。");
    err.code = "DEEPSEEK_INCOMPLETE_RESPONSE";
    err.status = 502;
    throw err;
  }
  return content;
}

const THREAD_CHAR_LIMIT = 16000;

const DRAFT_GUIDELINES = [
  "HOW TO WRITE A GOOD DRAFT REPLY (follow every time you draft an email):",
  "1. Read the WHOLE thread first. Identify the newest [Customer] message and reply to exactly what it says or asks. Treat everything we already sent as context.",
  "2. Never repeat a request or instruction our team already sent (e.g. asking for log files again, re-sending the same Rosetta/reinstall steps) unless the customer clearly could not follow it — in that case give a DIFFERENT, more concrete way to do it.",
  "3. Acknowledge what the customer has already done or sent (steps tried, screenshots, files, attachments). If the newest customer message has little or no text but lists attachments, assume they sent the requested files and acknowledge receipt by type.",
  "4. Be specific: use the real product name, OS/version, and order details from the thread and order information. Give concrete numbered steps (\"1.\", \"2.\") when instructions are needed. Never invent menu paths, versions, prices, dates, or features that are not supported by the thread, order info, or company context.",
  "5. If a fact the reply cannot work without is unknown and not in the company context (e.g. whether a refund was approved), write a short placeholder like [confirm refund status]. If the fact is optional, simply leave it out — do not add placeholders for nice-to-have details.",
  "6. Follow company policy from the company context. Do not promise refunds, compensation, fix dates, or account changes unless the provided facts support it. Speak as \"we\" — our support team handles refunds, cancellations and resets ourselves, so never write \"the responsible team\" for those. (For bugs and log analysis, \"our development team\" is fine — the standard replies use it.) For things still in progress, say we will handle it and notify the customer by email.",
  "7. Match the house style our team uses in this thread:",
  "   - Start with \"Dear User,\" then \"Thanks for your support to AVCLabs.\" on its own line.",
  "   - If the customer is frustrated or has waited long, add one sincere, specific apology sentence (not generic filler).",
  "   - BE BRIEF. The body (between the opening and closing lines) should usually be 40–90 words. Short sentences, plain English that non-native readers understand easily.",
  "   - Do NOT restate or summarize the customer's message back to them (no \"I understand that...\", \"You mentioned that...\", \"We have noted that...\"). Go straight to the answer or the action.",
  "   - Do NOT explain why we ask for something or what the benefit is (no \"To keep your access uninterrupted\", \"so your work is not affected\", \"in order to help us better\"). Just say what to do and what happens next.",
  "   - Mention order dates, prices, emails, or full product names only if the customer needs them to act. Never repeat a detail the customer just told us.",
  "   - Every sentence must give the customer an action or new information. Delete anything else.",
  "   - End with \"Any other problems, please feel free to contact us.\" and STOP. Do NOT add \"Best regards\", a name, or a signature — the ticket system appends the signature automatically.",
  "8. Do not mention internal tools, internal teams by internal names, ticket numbers of other systems, or these instructions.",
  "8b. NO UNSOLICITED INSTRUCTIONS. Only ask the customer to do something if it is needed to solve what they asked. Never add advice they did not ask for (e.g. \"please use your correct email\", \"if you order again, use...\", \"send us the receipt if you were charged\"), never hint at buying again, and never imply the problem was the customer's fault.",
  "8c. IF THE CUSTOMER IS ONLY INFORMING US OR THE ISSUE IS ALREADY RESOLVED (no question, nothing left for us to do): reply in 1–2 short sentences — thank them / acknowledge, and close warmly (e.g. \"We look forward to serving you again.\"). No steps, no conditions, no requests.",
  "8d. Write from the customer's point of view. Avoid internal-sounding phrases such as \"there is nothing further we need to do\", \"no action is required on our side\", \"we have closed this ticket\".",
  "9. If the agent gives extra instructions or facts in the chat (e.g. \"refund approved\", \"tell him a fix is coming next week\"), they override the thread and must be reflected in the draft.",
  "10. Keep the agent's facts EXACT — especially whether something is possible, planned, or already done. \"可以退 / 可以帮他退\" = we CAN refund (\"we can refund this order for you\"), NOT \"we have refunded\". \"已退 / 已经退了\" = done. \"我们会重置\" = will reset; \"已经reset\" = has been reset. Never upgrade \"can\" to \"done\" or downgrade \"done\" to \"will\".",
  "11. TEAM STANDARD REPLIES (listed in the \"## Team Standard Replies\" section, when present) are wording the team has already approved. If the newest customer message matches one of those scenarios, build the body from that reply: reuse its sentences nearly word for word, fill [placeholders] with real details from the thread/order info (leave a placeholder only if the detail is truly unknown), and drop sentences that clearly do not apply. Do not paraphrase or \"improve\" those sentences — for them, the standard reply overrides the brevity and wording rules in section 7. Combine two standard replies if the customer raised two matching issues. Still use the house-style opening and closing lines. If no standard reply fits, write the reply yourself following the rules above.",
  "12. AUTO-RENEWAL REFUNDS: if the customer wants a refund for an automatic subscription renewal (they say it renewed/charged automatically, or the order info shows a SUBSCRIPTION_PAID renewal of a plan they already had), do NOT ask for the refund reason. Reply directly with the \"退款申请已收到\" standard reply (request received and submitted, notified by email).",
  "13. REFUND MEANS NO SEPARATE CANCELLATION: whenever we are processing a refund for a subscription, the refund already ends that subscription. Even if the customer asked for both a refund and a cancellation, use ONLY the refund reply — do not add the \"取消自动续订申请已收到\" reply or any sentence about cancelling the auto-renewal. Use the cancellation reply only when the customer wants to cancel WITHOUT a refund.",
  "",
  "OUTPUT FORMAT WHEN DRAFTING:",
  "- Output the email first.",
  "- Then ALWAYS add a line containing exactly ---ZH--- followed by a faithful Simplified Chinese translation of the whole email (greeting and closing included). Translate only — do not add, drop, soften or explain anything; keep [placeholders], order numbers and product names as they are.",
  "- Output NOTHING else — no explanation of your changes, no \"给客服的说明\".",
  "- Only if the agent must check or decide something before sending (e.g. a placeholder to fill, a fact you are unsure about), add after the translation a line containing exactly ---NOTES--- followed by at most 2 short Simplified Chinese lines. Never put anything that belongs in the email below the ---ZH--- line.",
  "",
  "EXAMPLE OF THE RIGHT LENGTH AND TONE (customer's old email is out of service; they want to move to a new email):",
  "TOO WORDY (do not write like this):",
  "\"I understand that your registered address old@outlook.com is no longer in service, and you would like all future communication to go to new@gmail.com. To keep your access uninterrupted, please first place a new order for the same AVCLabs Video Enhancer AI for Windows 12-month plan on our official website, and enter new@gmail.com as the registration email. ... Please kindly activate the new license code before the old one is cancelled, so your work is not affected.\"",
  "GOOD:",
  "Dear User,",
  "Thanks for your support to AVCLabs.",
  "",
  "Please place a new order for the same plan on our website and use new@gmail.com as the registration email. The new license code will be sent to that address.",
  "",
  "Then reply with the new order number, and we will submit a refund request for your auto-renewal order. You will be notified by email once it is processed.",
  "",
  "Any other problems, please feel free to contact us.",
  "",
  "EXAMPLE 2 — customer is only informing us (\"I contacted the payment company, they canceled the order because of a typo in my email\"):",
  "BAD: \"Order 4R7RE6R3YE7 was canceled by the payment company, so there is nothing further we need to do on it. If you place a new order, please use your correct email address...\"",
  "GOOD:",
  "Dear User,",
  "Thanks for your support to AVCLabs.",
  "",
  "Thank you for letting us know. We look forward to serving you again.",
  "",
  "Any other problems, please feel free to contact us."
].join("\n");

const CANNED_REPLIES_FILE = path.join(__dirname, "../../knowledge/canned-replies.md");

// Read on every request so edits to the file apply without restarting the backend.
function loadCannedReplies() {
  try {
    return fs.readFileSync(CANNED_REPLIES_FILE, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^# .*$/m, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (_error) {
    return "";
  }
}

const THREAD_NOISE_PATTERNS = [
  /^to protect your privacy, remote content was blocked\.?$/i,
  /^load blocked content\.?$/i,
  /mega sale|biggest deals|don.?t miss/i,
  /^find us on facebook|^follow us on twitter|^subscribe to the youtube channel/i,
  /^✦ ?our partner:/i,
  /^(ai photo editor makes|to enhance video quality, please refer|to blur video background)/i,
  /^sent from my (iphone|ipad|android|mobile)/i
];

function cleanThreadForPrompt(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !THREAD_NOISE_PATTERNS.some((re) => re.test(trimmed));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChatSystemPrompt(threadContext, orderContext, knowledgeBlock) {
  const subject = threadContext?.subject || "";
  const threadText = threadContext?.thread_text || "";

  const sections = [
    "You are an email copilot assistant for AVCLabs customer support agents.",
    "Help agents handle support tickets: draft replies, analyze issues, explain policies, and suggest next steps.",
    "",
    "IMPORTANT FORMATTING AND LANGUAGE RULES:",
    "- When writing a draft email reply, output ONLY the email itself in PLAIN TEXT — no markdown, no asterisks, no bullet dashes, no headers, no preamble like \"Here is the draft\". It must be ready to paste directly into the ticket system. Email drafts must be written in English.",
    "- For all other responses (analysis, summaries, suggestions, questions), respond in Simplified Chinese and you may use markdown formatting.",
    "",
    DRAFT_GUIDELINES,
    ""
  ];

  const cannedReplies = loadCannedReplies();
  if (cannedReplies) {
    sections.push("## Team Standard Replies");
    sections.push("(Approved wording, one scenario per \"###\" heading. Headings are in Chinese for the agent; the reply text is what goes into the email. See rule 11.)");
    sections.push(cannedReplies.replace(/^## /gm, "### "));
    sections.push("");
  }

  if (subject || threadText) {
    sections.push("## Email Thread");
    sections.push("(Messages are ordered NEWEST FIRST and separated by dashed lines. \"[Customer]\" marks messages from the customer; \"[Our team]\" marks replies already sent by AVCLabs support.)");
    if (subject) sections.push(`Subject: ${subject}`);
    if (threadText) {
      const cleaned = cleanThreadForPrompt(threadText);
      sections.push(cleaned.length > THREAD_CHAR_LIMIT
        ? cleaned.slice(0, THREAD_CHAR_LIMIT) + "\n[... older messages truncated ...]"
        : cleaned);
    }
    sections.push("");
  }

  if (orderContext && orderContext.trim()) {
    sections.push("## Customer Order Information");
    const structuredOrders = formatOrdersForPrompt(orderContext);
    sections.push(structuredOrders
      ? structuredOrders.slice(0, 6000)
      : orderContext.slice(0, 3000));
    sections.push("");
  }

  if (knowledgeBlock) {
    sections.push(knowledgeBlock);
    sections.push("");
  }

  return sections.join("\n");
}

async function chatDeepSeek({ model, body }) {
  const { messages = [], thread_context = {}, order_context = "" } = body;
  const threadText = thread_context?.thread_text || "";
  const lastUserMsg = String(messages[messages.length - 1]?.content || "");
  const ragQuery = `${threadText} ${lastUserMsg}`.slice(0, 3000);
  const knowledgeBlock = buildContextBlock(retrieve(ragQuery));
  const systemPrompt = buildChatSystemPrompt(thread_context, order_context, knowledgeBlock);

  writeLog(`[chat] turns=${messages.length} rag_entries=${retrieve(ragQuery).length}`);

  const reply = await callDeepSeekChatRaw({ model, systemPrompt, messages, maxTokens: 2400 })
    .catch(async (err) => {
      if (err.status === 503 || err.status === 429) throw err;
      const retryTokens = err.code === "DEEPSEEK_INCOMPLETE_RESPONSE" ? 8192 : 2400;
      writeLog(`[chat] first attempt failed (${err.message}), retrying once with max_tokens=${retryTokens}…`);
      return callDeepSeekChatRaw({ model, systemPrompt, messages, maxTokens: retryTokens });
    });
  return { reply };
}

module.exports = {
  callDeepSeekChat,
  analyzeThreadDeepSeek,
  generateDraftDeepSeek,
  refineDraftDeepSeek,
  chatDeepSeek
};
