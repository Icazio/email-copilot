const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");
const { extractFieldsMock, analyzeThreadMock, generateDraftMock, refineDraftMock } = require("./mock-engine");
const { buildSystemInstructions } = require("./prompt-loader");
const { retrieve, buildContextBlock } = require("./knowledge-retriever");

async function callResponsesAPI({ model, instructions, input }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        store: false,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: instructions }]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: input }]
          }
        ]
      })
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "terminated" : err.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.output_text || "";
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

function tryParseJson(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON object returned by model.");
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

async function analyzeThreadOpenAI({ model, body, templates }) {
  const mockResult = analyzeThreadMock(body, templates);
  if (mockResult.category === "free_credit") return mockResult;
  const template = findTemplateById(body.template_ids?.[0], templates) || pickTemplate("general", templates);
  const structured = normalizeStructuredThread(body.thread_structured);
  const input = [
    "Task: analyze-thread",
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    buildCombinedThreadText(body),
    "Template context:",
    buildTemplateContext(template),
    "Return JSON with keys:",
    "category, summary, confidence, extracted_fields, clarification_questions, next_step, suggested_template_id"
  ].join("\n\n");

  const text = await callResponsesAPI({
    model,
    instructions: buildSystemInstructions("analyze-thread", ""),
    input
  });

  return tryParseJson(text);
}

async function generateDraftOpenAI({ model, body, templates }) {
  if (body.category === "free_credit") return generateDraftMock(body, templates);
  const template =
    findTemplateById(body.template_ids?.[0], templates) || pickTemplate(body.category || "general", templates);
  const extractedFields = extractFieldsMock(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const input = [
    "Task: generate-draft",
    `Category: ${body.category || "unknown"}`,
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    buildCombinedThreadText(body),
    "Manual notes:",
    normalizeText(body.manual_notes || ""),
    "Extracted fields:",
    JSON.stringify(extractedFields, null, 2),
    "Template context:",
    buildTemplateContext(template),
    "Return JSON with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].join("\n\n");

  const text = await callResponsesAPI({
    model,
    instructions: buildSystemInstructions("generate-draft", ""),
    input
  });

  return tryParseJson(text);
}

async function refineDraftOpenAI({ model, body, templates }) {
  if (body.category === "free_credit") return refineDraftMock(body, templates);
  const template =
    findTemplateById(body.template_ids?.[0], templates) || pickTemplate(body.category || "general", templates);
  const mergedFields = extractFieldsMock(body);
  const structured = normalizeStructuredThread(body.thread_structured);
  const input = [
    "Task: refine-draft",
    `Category: ${body.category || "unknown"}`,
    "Structured ticket data:",
    JSON.stringify(structured || {}, null, 2),
    "Combined thread context:",
    buildCombinedThreadText(body, [body.manual_lookup_result, body.manual_notes]),
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
    "Return JSON with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].join("\n\n");

  const text = await callResponsesAPI({
    model,
    instructions: buildSystemInstructions("refine-draft", ""),
    input
  });

  return tryParseJson(text);
}

async function callChatCompletions({ model, systemPrompt, messages }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1600,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      })
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "terminated" : err.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
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

async function chatOpenAI({ model, body }) {
  const { messages = [], thread_context = {}, order_context = "" } = body;
  const threadText = thread_context?.thread_text || "";
  const lastUserMsg = String(messages[messages.length - 1]?.content || "");
  const ragQuery = `${threadText} ${lastUserMsg}`.slice(0, 3000);
  const knowledgeBlock = buildContextBlock(retrieve(ragQuery));
  const systemPrompt = buildChatSystemPrompt(thread_context, order_context, knowledgeBlock);

  const reply = await callChatCompletions({ model, systemPrompt, messages });
  return { reply };
}

module.exports = {
  analyzeThreadOpenAI,
  generateDraftOpenAI,
  refineDraftOpenAI,
  chatOpenAI
};
