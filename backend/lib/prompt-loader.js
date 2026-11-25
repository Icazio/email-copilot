const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.resolve(__dirname, "../prompts");

function loadPrompts() {
  const instructionsPath = path.join(PROMPTS_DIR, "system-instructions.json");
  const raw = fs.readFileSync(instructionsPath, "utf8");
  return JSON.parse(raw);
}

function buildSystemInstructions(mode, contextBlock = "") {
  const prompts = loadPrompts();
  const { base, categories } = prompts;

  const lines = [
    contextBlock || null,
    base.role,
    base.task,
    base.scope,
    "",
    ...base.constraints,
    "",
    "Available categories and when to use them:",
    ...Object.entries(categories).map(([key, desc]) => `- ${key}: ${desc}`),
    "",
    `Return valid json only for mode: ${mode}.`
  ];

  return lines.filter(Boolean).join("\n");
}

module.exports = {
  loadPrompts,
  buildSystemInstructions
};
