const fs = require("fs");
const path = require("path");
const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");
const { extractFieldsMock, analyzeThreadMock, generateDraftMock, refineDraftMock } = require("./mock-engine");
const { retrieve, buildContextBlock } = require("./knowledge-retriever");
const { buildSystemInstructions: buildSystemInstructionsFromPrompt } = require("./prompt-loader");

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
      body: JSON.stringify(requestPayload),
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
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: requestMessages }),
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
  const content = msg.content || msg.reasoning_content || "";

  writeLog(`[chat-raw] finish_reason=${finishReason} content_chars=${(msg.content || "").length} reasoning_chars=${(msg.reasoning_content || "").length}`);

  if (!content) {
    throw new Error(`DeepSeek returned empty content (finish_reason: ${finishReason}).`);
  }
  return content;
}

function buildChatSystemPrompt(threadContext, orderContext, knowledgeBlock) {
  const subject = threadContext?.subject || "";
  const threadText = threadContext?.thread_text || "";

  const sections = [
    "You are an email copilot assistant for AVCLabs customer support agents.",
    "Help agents handle support tickets: draft replies, analyze issues, explain policies, and suggest next steps.",
    "IMPORTANT FORMATTING AND LANGUAGE RULES:",
    "- When writing a draft email reply, use PLAIN TEXT ONLY — no markdown, no asterisks, no bullet dashes, no headers. The draft must be ready to paste directly into an email client. Email drafts must be written in English.",
    "- For all other responses (analysis, summaries, suggestions, questions), respond in Simplified Chinese and you may use markdown formatting.",
    ""
  ];

  if (subject || threadText) {
    sections.push("## Email Thread");
    if (subject) sections.push(`Subject: ${subject}`);
    if (threadText) sections.push(threadText.slice(0, 6000));
    sections.push("");
  }

  if (orderContext && orderContext.trim()) {
    sections.push("## Customer Order Information");
    sections.push(orderContext.slice(0, 2000));
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
      writeLog(`[chat] first attempt failed (${err.message}), retrying once…`);
      return callDeepSeekChatRaw({ model, systemPrompt, messages, maxTokens: 2400 });
    });
  return { reply };
}

module.exports = {
  analyzeThreadDeepSeek,
  generateDraftDeepSeek,
  refineDraftDeepSeek,
  chatDeepSeek
};
