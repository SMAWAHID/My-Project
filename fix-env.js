const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
console.log("\n=== .env Checker ===");
console.log("Looking for:", envPath);

if (!fs.existsSync(envPath)) {
  console.log("❌ .env NOT FOUND — run: copy .env.example .env");
  process.exit(1);
}

const content = fs.readFileSync(envPath, "utf-8");
const lines = content.split("\n");
const vars = {};

lines.forEach((line, i) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) return;
  const key = trimmed.slice(0, eqIndex).trim();
  let val = trimmed.slice(eqIndex + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  vars[key] = val;
});

console.log(`\n✓ Found .env (${lines.length} lines, ${Object.keys(vars).length} vars)\n`);

const groq = vars["GROQ_API_KEY"] || "";
const anth = vars["ANTHROPIC_API_KEY"] || "";

if (!groq && !anth) {
  console.log("❌ GROQ_API_KEY = (not set)");
  console.log("❌ ANTHROPIC_API_KEY = (not set)");
  console.log("\n>>> ADD ONE OF THESE TO YOUR .env FILE:");
  console.log("    GROQ_API_KEY=gsk_xxxxxxxxxxxx");
  console.log("    Free key at: https://console.groq.com\n");
} else {
  if (groq) console.log(`✅ GROQ_API_KEY = "${groq.slice(0,12)}..." (${groq.length} chars)`);
  if (anth) console.log(`✅ ANTHROPIC_API_KEY = "${anth.slice(0,12)}..." (${anth.length} chars)`);
}

const aws = vars["AWS_ACCESS_KEY_ID"] || "";
const db = vars["POSTGRES_HOST"] || "";
const gh = vars["GITHUB_TOKEN"] || "";
console.log(`\nAWS: ${aws ? "✅ " + aws.slice(0,8)+"..." : "⚪ not set (optional)"}`);
console.log(`DB:  ${db ? "✅ " + db : "⚪ not set (optional)"}`);
console.log(`GH:  ${gh ? "✅ " + gh.slice(0,8)+"..." : "⚪ not set (optional)"}`);

console.log("\n=== Common mistakes ===");
console.log("BAD:  GROQ_API_KEY = gsk_xxx   (spaces around =)");
console.log("BAD:  GROQ_API_KEY='gsk_xxx'   (quotes)");
console.log("GOOD: GROQ_API_KEY=gsk_xxx     (no spaces, no quotes)");
