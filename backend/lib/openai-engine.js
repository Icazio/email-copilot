const {
  normalizeText,
  normalizeStructuredThread,
  buildCombinedThreadText,
  pickTemplate,
  findTemplateById
} = require("./helpers");
const { extractFieldsMock } = require("./mock-engine");

async function callResponsesAPI({ model, instructions, input }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
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

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.output_text || "";
}

function buildSystemInstructions(mode) {
  return [
    "You are an internal email support copilot.",
    "You help a support agent draft English email replies for customers.",
    "You are not the final sender.",
    "Never promise refunds, compensation, SLA, technical fixes, or account changes unless clearly supported by provided facts.",
    "For technical issues, focus on information collection and escalation guidance.",
    `Return valid JSON only for mode: ${mode}.`
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
    throw new Error("No JSON object returned by model.");
  }

  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

async function analyzeThreadOpenAI({ model, body, templates }) {
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
    instructions: buildSystemInstructions("analyze-thread"),
    input
  });

  return tryParseJson(text);
}

async function generateDraftOpenAI({ model, body, templates }) {
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
    instructions: buildSystemInstructions("generate-draft"),
    input
  });

  return tryParseJson(text);
}

async function refineDraftOpenAI({ model, body, templates }) {
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
    instructions: buildSystemInstructions("refine-draft"),
    input
  });

  return tryParseJson(text);
}

module.exports = {
  analyzeThreadOpenAI,
  generateDraftOpenAI,
  refineDraftOpenAI
};
