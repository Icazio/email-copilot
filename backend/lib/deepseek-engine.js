const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");
const { extractFieldsMock, analyzeThreadMock, generateDraftMock, refineDraftMock } = require("./mock-engine");

async function callDeepSeekChat({ model, instructions, input, maxTokens = 1200 }) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
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
    })
  });

  if (!response.ok) {
    throw new Error(`DeepSeek request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";

  if (!content.trim()) {
    throw new Error("DeepSeek returned empty content.");
  }

  return content;
}

function buildSystemInstructions(mode) {
  return [
    "You are an internal email support copilot.",
    "You help a support agent draft English email replies for customers.",
    "You are not the final sender.",
    "Never promise refunds, compensation, SLA, technical fixes, or account changes unless clearly supported by provided facts.",
    "For technical issues, focus on information collection and escalation guidance.",
    "Write summary, clarification_questions, and next_step in Simplified Chinese.",
    "",
    "Available categories and when to use them:",
    "- free_credit: Customer provides social media proof (Facebook/Twitter/YouTube link or screenshot) to earn free platform credits. Any email mentioning credits/积分 alongside a social media link or handle belongs here, regardless of language.",
    "- cancel_renewal: Customer wants to cancel subscription or stop auto-renewal.",
    "- refund: Customer requests a refund or disputes a charge.",
    "- invoice: Customer needs an invoice or billing document.",
    "- account: Customer has an activation, license code, or account access issue.",
    "- technical: Customer reports a software bug, crash, or performance issue.",
    "- general: None of the above.",
    "",
    `Return valid json only for mode: ${mode}.`
  ].join("\n");
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
    throw new Error("No JSON object returned by DeepSeek.");
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

async function analyzeThreadDeepSeek({ model, body, templates }) {
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
    "Return json with keys:",
    "category, summary, confidence, extracted_fields, clarification_questions, next_step, suggested_template_id"
  ].join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructions("analyze-thread"),
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
    "Return json with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructions("generate-draft"),
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
    "Return json with keys:",
    "category, draft_reply, clarification_questions, next_step, extracted_fields, template_id"
  ].join("\n\n");

  const text = await callDeepSeekChat({
    model,
    instructions: buildSystemInstructions("refine-draft"),
    input,
    maxTokens: 1600
  });

  return tryParseJson(text);
}

module.exports = {
  analyzeThreadDeepSeek,
  generateDraftDeepSeek,
  refineDraftDeepSeek
};
