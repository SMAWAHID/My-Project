import fs from "fs";
import path from "path";

// Manually read .env — tsx/dotenv path detection is unreliable in monorepos
// Walk up from cwd until we find the .env file
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
        if (!process.env[key]) process.env[key] = val; // don't override real env vars
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
import {
  createInvestigation,
  getInvestigation,
  listInvestigations,
  approveToolCall,
} from "./investigator.js";
import { InvestigationRequest } from "./types/index.js";
import { logger } from "./utils/logger.js";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/investigations", async (req, res) => {
  try {
    const request = req.body as InvestigationRequest;
    if (!request.incident_description) {
      return res.status(400).json({ error: "incident_description is required" });
    }
    logger.info(`New investigation: ${request.incident_description}`);
    const investigation = await createInvestigation(request);
    res.status(201).json(investigation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.get("/investigations/:id", (req, res) => {
  const investigation = getInvestigation(req.params.id);
  if (!investigation) return res.status(404).json({ error: "Investigation not found" });
  res.json(investigation);
});

app.get("/investigations", (req, res) => {
  res.json(listInvestigations());
});

app.post("/investigations/:id/tool-approval", async (req, res) => {
  try {
    const { tool_call_id, approved } = req.body as { tool_call_id: string; approved: boolean };
    await approveToolCall(req.params.id, tool_call_id, approved);
    res.json(getInvestigation(req.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    env_file: envLoaded || "not found",
    groq: !!process.env.GROQ_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.AGENT_PORT || 3002;
app.listen(PORT, () => {
  logger.info(`Agent running on port ${PORT}`);
  logger.info(`Env file: ${envLoaded || "NOT FOUND"}`);
  if (process.env.GROQ_API_KEY) {
    logger.info(`AI Provider: Groq ✓ (${process.env.GROQ_API_KEY.slice(0, 12)}...)`);
  } else if (process.env.ANTHROPIC_API_KEY) {
    logger.info(`AI Provider: Anthropic ✓`);
  } else {
    logger.error(`❌ NO API KEY — add GROQ_API_KEY=gsk_... to your .env file`);
    logger.error(`   .env searched from: ${process.cwd()}`);
  }
});
