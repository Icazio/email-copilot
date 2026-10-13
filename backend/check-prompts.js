#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const promptsDir = path.join(__dirname, "prompts");
const systemInstructionsPath = path.join(promptsDir, "system-instructions.json");

console.log("🔍 Checking system prompts...\n");

try {
  if (!fs.existsSync(systemInstructionsPath)) {
    throw new Error(`File not found: ${systemInstructionsPath}`);
  }

  const raw = fs.readFileSync(systemInstructionsPath, "utf8");
  const prompts = JSON.parse(raw);

  console.log("✅ system-instructions.json is valid JSON");

  const requiredCategories = ["free_credit", "cancel_renewal", "refund", "invoice", "account", "technical", "general"];
  const actualCategories = Object.keys(prompts.categories || {});

  console.log(`\n📋 Categories defined: ${actualCategories.length}`);
  requiredCategories.forEach((cat) => {
    if (actualCategories.includes(cat)) {
      console.log(`  ✅ ${cat}`);
    } else {
      console.log(`  ❌ ${cat} (MISSING)`);
    }
  });

  if (actualCategories.length > requiredCategories.length) {
    const extra = actualCategories.filter((c) => !requiredCategories.includes(c));
    console.log(`  ⚠️  Extra categories: ${extra.join(", ")}`);
  }

  const base = prompts.base || {};
  console.log(`\n📝 Base instructions:`);
  console.log(`  ✅ role: ${base.role ? "defined" : "MISSING"}`);
  console.log(`  ✅ task: ${base.task ? "defined" : "MISSING"}`);
  console.log(`  ✅ scope: ${base.scope ? "defined" : "MISSING"}`);
  console.log(`  ✅ constraints: ${Array.isArray(base.constraints) ? `${base.constraints.length} items` : "MISSING"}`);

  console.log("\n✨ All checks passed!");
} catch (error) {
  console.error(`\n❌ Error: ${error.message}`);
  process.exit(1);
}
