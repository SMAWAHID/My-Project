import fs from "fs";
import path from "path";

// Manually walk up directories to find and load .env
function loadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
      return envFile;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envLoaded = loadEnv();

import express from "express";
import cors from "cors";
import { logTools, logToolHandlers } from "./tools/logs/index.js";
import { infraTools, infraToolHandlers } from "./tools/infrastructure/index.js";
import { pm2Tools, pm2ToolHandlers } from "./tools/pm2/index.js";
import { dbTools, dbToolHandlers } from "./tools/database/index.js";
import { deployTools, deployToolHandlers } from "./tools/deployment/index.js";
import { awsTools, awsToolHandlers } from "./tools/aws/index.js";
import { logger } from "./utils/logger.js";

const allTools = [...logTools, ...infraTools, ...pm2Tools, ...dbTools, ...deployTools, ...awsTools];
const allHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  ...logToolHandlers, ...infraToolHandlers, ...pm2ToolHandlers, ...dbToolHandlers, ...deployToolHandlers, ...awsToolHandlers,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/tools", (req, res) => {
  res.json({ tools: allTools, count: allTools.length });
});

app.post("/tools/:toolName", async (req, res) => {
  const { toolName } = req.params;
  const handler = allHandlers[toolName];
  if (!handler) return res.status(404).json({ error: `Unknown tool: ${toolName}` });
  try {
    const result = await handler(req.body);
    res.json({ success: true, result, tool: toolName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message, tool: toolName });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    env_file: envLoaded,
    tool_count: allTools.length,
    aws: !!process.env.AWS_ACCESS_KEY_ID,
    db: !!process.env.POSTGRES_HOST,
    github: !!(process.env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN.includes("your")),
    timestamp: new Date().toISOString(),
  });
});

const PORT = parseInt(process.env.MCP_HTTP_PORT || "3001");
app.listen(PORT, () => {
  logger.info(`MCP Server running on http://localhost:${PORT}`);
  logger.info(`Env file: ${envLoaded || "NOT FOUND — searching from " + process.cwd()}`);
  logger.info(`${allTools.length} tools registered`);
  logger.info(`AWS: ${process.env.AWS_ACCESS_KEY_ID ? "✓ " + process.env.AWS_ACCESS_KEY_ID.slice(0,8)+"..." : "✗ not set"}`);
  logger.info(`DB:  ${process.env.POSTGRES_HOST ? "✓ " + process.env.POSTGRES_HOST : "✗ not set"}`);
  logger.info(`GH:  ${process.env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN.includes("your") ? "✓ configured" : "✗ not set"}`);
});
