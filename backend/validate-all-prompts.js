#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const promptsDir = path.join(__dirname, "prompts");

console.log("🔍 Validating all prompt configuration files...\n");

const requiredFiles = [
  "system-instructions.json",
  "classification-rules.json",
  "questions.json",
  "guidance.json",
  "summaries.json",
  "draft-templates.json",
  "free-credit-config.json",
  "issue-types.json"
];

const categories = ["free_credit", "cancel_renewal", "refund", "invoice", "account", "technical", "general"];

let allValid = true;

// Check all files exist and are valid JSON
console.log("📋 Checking file existence and JSON validity:");
const loadedConfigs = {};

for (const file of requiredFiles) {
  const filePath = path.join(promptsDir, file);
  try {
    const content = fs.readFileSync(filePath, "utf8");
    JSON.parse(content);
    loadedConfigs[file] = JSON.parse(content);
    console.log(`  ✅ ${file}`);
  } catch (error) {
    console.log(`  ❌ ${file} - ${error.message}`);
    allValid = false;
  }
}

console.log("\n📝 Checking category coverage:");

// Check summaries has all categories
const summaries = loadedConfigs["summaries.json"] || {};
for (const cat of categories) {
  if (summaries[cat]) {
    console.log(`  ✅ summaries: ${cat}`);
  } else {
    console.log(`  ❌ summaries: ${cat} (MISSING)`);
    allValid = false;
  }
}

// Check questions has all categories
const questions = loadedConfigs["questions.json"] || {};
for (const cat of categories) {
  if (cat in questions) {
    console.log(`  ✅ questions: ${cat}`);
  } else {
    console.log(`  ❌ questions: ${cat} (MISSING)`);
    allValid = false;
  }
}

// Check guidance has all categories
const guidance = loadedConfigs["guidance.json"] || {};
for (const cat of categories) {
  if (cat in guidance) {
    console.log(`  ✅ guidance: ${cat}`);
  } else {
    console.log(`  ❌ guidance: ${cat} (MISSING)`);
    allValid = false;
  }
}

// Check classification rules
console.log("\n🎯 Checking classification rules:");
const classificationRules = loadedConfigs["classification-rules.json"] || {};
for (const cat of categories) {
  if (cat in classificationRules) {
    const rule = classificationRules[cat];
    if (rule.pattern || rule.patterns) {
      console.log(`  ✅ ${cat}`);
    } else {
      console.log(`  ⚠️  ${cat} (no pattern defined)`);
    }
  } else {
    console.log(`  ❌ ${cat} (MISSING)`);
    allValid = false;
  }
}

// Check draft templates
console.log("\n🎬 Checking draft templates:");
const draftTemplates = loadedConfigs["draft-templates.json"] || {};
const requiredTemplateKeys = ["free_credit", "cancel_renewal", "generic_support"];
for (const key of requiredTemplateKeys) {
  if (key in draftTemplates) {
    console.log(`  ✅ ${key}`);
  } else {
    console.log(`  ❌ ${key} (MISSING)`);
    allValid = false;
  }
}

// Check free credit config
console.log("\n🎁 Checking free credit config:");
const freeCreditConfig = loadedConfigs["free-credit-config.json"] || {};
const requiredFreeCredit = ["social_platforms", "attachment_detection", "verification_rules", "credits_calculation"];
for (const key of requiredFreeCredit) {
  if (key in freeCreditConfig) {
    console.log(`  ✅ ${key}`);
  } else {
    console.log(`  ❌ ${key} (MISSING)`);
    allValid = false;
  }
}

// Check if loaders can load the configs
console.log("\n⚙️  Checking if loaders work:");
try {
  const promptLoader = require("./lib/prompt-loader");
  const prompts = promptLoader.loadPrompts();
  console.log(`  ✅ prompt-loader works`);
} catch (error) {
  console.log(`  ❌ prompt-loader failed: ${error.message}`);
  allValid = false;
}

try {
  const mockEngineLoader = require("./lib/mock-engine-loader");
  const rules = mockEngineLoader.loadClassificationRules();
  console.log(`  ✅ mock-engine-loader works`);
} catch (error) {
  console.log(`  ❌ mock-engine-loader failed: ${error.message}`);
  allValid = false;
}

// Final result
console.log("\n" + (allValid ? "✨ All validations passed!" : "❌ Some validations failed!"));
process.exit(allValid ? 0 : 1);
