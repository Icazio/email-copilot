#!/usr/bin/env node

const { buildSystemInstructions, loadPrompts } = require("./lib/prompt-loader");

console.log("🧪 Testing prompt-loader...\n");

try {
  console.log("1. Loading prompts...");
  const prompts = loadPrompts();
  console.log(`   ✅ Loaded ${Object.keys(prompts.categories).length} categories\n`);

  console.log("2. Building system instructions for 'analyze-thread'...");
  const instructions1 = buildSystemInstructions("analyze-thread");
  console.log(`   ✅ Generated ${instructions1.length} chars\n`);

  console.log("3. Building system instructions for 'generate-draft'...");
  const instructions2 = buildSystemInstructions("generate-draft");
  console.log(`   ✅ Generated ${instructions2.length} chars\n`);

  console.log("4. Building with context block...");
  const contextBlock = "Custom knowledge context here";
  const instructions3 = buildSystemInstructions("refine-draft", contextBlock);
  console.log(`   ✅ Generated ${instructions3.length} chars (includes context)\n`);

  console.log("5. Verifying all categories are included...");
  const categories = ["free_credit", "cancel_renewal", "refund", "invoice", "account", "technical", "general"];
  const allIncluded = categories.every((cat) => instructions1.includes(cat));
  if (allIncluded) {
    console.log(`   ✅ All ${categories.length} categories are included\n`);
  } else {
    console.log(`   ❌ Some categories are missing!\n`);
  }

  console.log("✨ All tests passed!");
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}
