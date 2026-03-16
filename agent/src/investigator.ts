/**
 * AI DevOps Investigator — Agent Core
 * Supports both Groq (free) and Anthropic APIs.
 * Set GROQ_API_KEY or ANTHROPIC_API_KEY in your .env file.
 */

import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import {
  Investigation,
  ToolCall,
  TimelineEvent,
  Evidence,
  RootCauseReport,
  InvestigationRequest,
} from "./types/index.js";
import { DEVOPS_INVESTIGATOR_SYSTEM_PROMPT } from "./prompts/system.js";
import { logger } from "./utils/logger.js";

// NOTE: env vars are read lazily (inside functions) so dotenv in index.ts can load first
function getMcpUrl() { return process.env.MCP_SERVER_URL || "http://localhost:3001"; }
function useGroq() { return !!process.env.GROQ_API_KEY; }
function useAnthropic() { return !!process.env.ANTHROPIC_API_KEY; }

// Lazy-loaded clients
let _groqClient: unknown = null;
let _anthropicClient: unknown = null;

async function getGroqClient() {
  if (!_groqClient) {
    const { default: Groq } = await import("groq-sdk");
    _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groqClient as import("groq-sdk").default;
}

async function getAnthropicClient() {
  if (!_anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient as import("@anthropic-ai/sdk").default;
}

// ─── In-memory store ──────────────────────────────────────────────────────────
const investigations = new Map<string, Investigation>();

// ─── Public API ───────────────────────────────────────────────────────────────
export async function createInvestigation(request: InvestigationRequest): Promise<Investigation> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const investigation: Investigation = {
    id,
    incident_description: request.incident_description,
    status: "running",
    created_at: now,
    updated_at: now,
    timeline: [],
    evidence: [],
    messages: [],
  };

  investigations.set(id, investigation);

  addTimelineEvent(investigation, {
    type: "thinking",
    title: "Investigation Started",
    description: `Beginning investigation: "${request.incident_description}"`,
  });

  runInvestigation(investigation, request).catch((err) => {
    logger.error(`Investigation ${id} failed:`, err);
    investigation.status = "failed";
    investigation.updated_at = new Date().toISOString();
  });

  return investigation;
}

export function getInvestigation(id: string): Investigation | undefined {
  return investigations.get(id);
}

export function listInvestigations(): Investigation[] {
  return Array.from(investigations.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

export async function approveToolCall(
  investigationId: string,
  toolCallId: string,
  approved: boolean
): Promise<void> {
  const investigation = investigations.get(investigationId);
  if (!investigation) throw new Error(`Investigation ${investigationId} not found`);

  const toolCall = investigation.pending_tool_call;
  if (!toolCall || toolCall.id !== toolCallId) {
    throw new Error(`Tool call ${toolCallId} not found or already processed`);
  }

  toolCall.status = approved ? "approved" : "rejected";

  if (approved) {
    await executeToolCall(investigation, toolCall);
  } else {
    addTimelineEvent(investigation, {
      type: "observation",
      title: `Tool Rejected: ${toolCall.tool_name}`,
      description: `User rejected execution of ${toolCall.tool_name}. Continuing with available data.`,
    });
  }

  investigation.pending_tool_call = undefined;
  investigation.status = "running";
  investigation.updated_at = new Date().toISOString();

  continueInvestigation(investigation);
}

// ─── Investigation loop ───────────────────────────────────────────────────────
async function runInvestigation(investigation: Investigation, request: InvestigationRequest): Promise<void> {
  logger.info(`Starting investigation ${investigation.id}`);

  investigation.messages.push({
    role: "user",
    content: buildUserMessage(request),
    timestamp: new Date().toISOString(),
  });

  addTimelineEvent(investigation, {
    type: "thinking",
    title: "Analyzing Incident",
    description: "Parsing incident and forming initial hypotheses...",
  });

  await continueInvestigation(investigation);
}

async function continueInvestigation(investigation: Investigation): Promise<void> {
  if (investigation.status === "waiting_approval" || investigation.status === "completed") return;

  try {
    // Get tools list from MCP server
    const toolsResponse = await axios.get(`${getMcpUrl()}/tools`, { timeout: 8000 });
    const mcpTools: Array<{ name: string; description: string; inputSchema: object }> = toolsResponse.data.tools;

    if (useGroq()) {
      await continueWithGroq(investigation, mcpTools);
    } else if (useAnthropic()) {
      await continueWithAnthropic(investigation, mcpTools);
    } else {
      logger.error("No AI API key! Set GROQ_API_KEY or ANTHROPIC_API_KEY in your .env file");
      investigation.status = "failed";
      investigation.updated_at = new Date().toISOString();
      addTimelineEvent(investigation, {
        type: "observation",
        title: "Configuration Error",
        description: "No AI API key found. Set GROQ_API_KEY (free at console.groq.com) or ANTHROPIC_API_KEY in your .env file.",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Investigation loop error: ${message}`);
    investigation.status = "failed";
    investigation.updated_at = new Date().toISOString();
  }
}

// ─── Groq implementation ──────────────────────────────────────────────────────
async function continueWithGroq(
  investigation: Investigation,
  mcpTools: Array<{ name: string; description: string; inputSchema: object }>
): Promise<void> {
  const Groq = await import("groq-sdk");
  type GroqTool = Groq.Groq.Chat.Completions.ChatCompletionTool;
  type GroqMsg = Groq.Groq.Chat.Completions.ChatCompletionMessageParam;

  const client = await getGroqClient();

  const tools: GroqTool[] = mcpTools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  const messages: GroqMsg[] = buildGroqMessages(investigation);

  logger.info(`Calling Groq with ${tools.length} tools, ${messages.length} messages`);

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 4096,
    messages: [
      { role: "system", content: DEVOPS_INVESTIGATOR_SYSTEM_PROMPT },
      ...messages,
    ],
    tools,
    tool_choice: "auto",
  });

  const choice = response.choices[0];
  const msg = choice.message;

  logger.info(`Groq response: finish_reason=${choice.finish_reason}, tool_calls=${msg.tool_calls?.length || 0}`);

  // Handle text content
  if (msg.content) {
    investigation.messages.push({
      role: "assistant",
      content: msg.content,
      timestamp: new Date().toISOString(),
    });
    if (msg.content.length > 100) {
      addTimelineEvent(investigation, {
        type: "thinking",
        title: "AI Analysis",
        description: msg.content.substring(0, 300) + (msg.content.length > 300 ? "..." : ""),
      });
    }
    if (msg.content.includes('"root_cause"') && msg.content.includes('"confidence"')) {
      await extractAndFinalizeReport(investigation, msg.content);
    }
  }

  // Handle tool calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const tc = msg.tool_calls[0]; // Process one at a time (approval flow)

    const toolCall: ToolCall = {
      id: uuidv4(),
      tool_name: tc.function.name,
      tool_args: JSON.parse(tc.function.arguments || "{}"),
      status: "pending",
      requested_at: new Date().toISOString(),
    };

    investigation.pending_tool_call = toolCall;
    investigation.status = "waiting_approval";
    investigation.updated_at = new Date().toISOString();

    addTimelineEvent(investigation, {
      type: "tool_call",
      title: `Requesting: ${tc.function.name}`,
      description: `AI wants to run ${tc.function.name} — awaiting approval`,
      tool_call: toolCall,
    });

    investigation.messages.push({
      role: "assistant",
      content: JSON.stringify({ tool_use: { id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || "{}") } }),
      timestamp: new Date().toISOString(),
    });

    logger.info(`Waiting for approval: ${tc.function.name}`);
    return;
  }

  // finish_reason === "stop" or no tools — investigation complete
  if (choice.finish_reason === "stop") {
    if (!investigation.report) {
      await generateFinalReport(investigation);
    }
    investigation.status = "completed";
    investigation.updated_at = new Date().toISOString();
    addTimelineEvent(investigation, {
      type: "conclusion",
      title: "Investigation Complete",
      description: "Root cause identified. See Report tab for full analysis.",
    });
    logger.info(`Investigation ${investigation.id} completed`);
  }
}

// ─── Anthropic implementation ─────────────────────────────────────────────────
async function continueWithAnthropic(
  investigation: Investigation,
  mcpTools: Array<{ name: string; description: string; inputSchema: object }>
): Promise<void> {
  const Anthropic = await import("@anthropic-ai/sdk");
  type AnthropicTool = Anthropic.Anthropic.Tool;
  type AnthropicMsg = Anthropic.Anthropic.MessageParam;

  const client = await getAnthropicClient();

  const tools: AnthropicTool[] = mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Anthropic.Tool["input_schema"],
  }));

  const messages: AnthropicMsg[] = buildAnthropicMessages(investigation);

  logger.info(`Calling Anthropic with ${tools.length} tools, ${messages.length} messages`);

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 4096,
    system: DEVOPS_INVESTIGATOR_SYSTEM_PROMPT,
    tools,
    messages,
  });

  logger.info(`Anthropic response: stop_reason=${response.stop_reason}, blocks=${response.content.length}`);

  for (const block of response.content) {
    if (block.type === "text" && block.text.trim()) {
      investigation.messages.push({
        role: "assistant",
        content: block.text,
        timestamp: new Date().toISOString(),
      });
      if (block.text.length > 100) {
        addTimelineEvent(investigation, {
          type: "thinking",
          title: "AI Analysis",
          description: block.text.substring(0, 300) + (block.text.length > 300 ? "..." : ""),
        });
      }
      if (block.text.includes('"root_cause"') && block.text.includes('"confidence"')) {
        await extractAndFinalizeReport(investigation, block.text);
      }
    }

    if (block.type === "tool_use") {
      const toolCall: ToolCall = {
        id: uuidv4(),
        tool_name: block.name,
        tool_args: block.input as Record<string, unknown>,
        status: "pending",
        requested_at: new Date().toISOString(),
      };

      investigation.pending_tool_call = toolCall;
      investigation.status = "waiting_approval";
      investigation.updated_at = new Date().toISOString();

      addTimelineEvent(investigation, {
        type: "tool_call",
        title: `Requesting: ${block.name}`,
        description: `AI wants to run ${block.name} — awaiting approval`,
        tool_call: toolCall,
      });

      investigation.messages.push({
        role: "assistant",
        content: JSON.stringify({ tool_use: { id: block.id, name: block.name, input: block.input } }),
        timestamp: new Date().toISOString(),
      });

      logger.info(`Waiting for approval: ${block.name}`);
      return;
    }
  }

  if (response.stop_reason === "end_turn") {
    if (!investigation.report) {
      await generateFinalReport(investigation);
    }
    investigation.status = "completed";
    investigation.updated_at = new Date().toISOString();
    addTimelineEvent(investigation, {
      type: "conclusion",
      title: "Investigation Complete",
      description: "Root cause identified. See Report tab for full analysis.",
    });
    logger.info(`Investigation ${investigation.id} completed`);
  }
}

// ─── Message history builders ─────────────────────────────────────────────────
function buildGroqMessages(investigation: Investigation) {
  type GroqMsg = import("groq-sdk").Groq.Chat.Completions.ChatCompletionMessageParam;
  const messages: GroqMsg[] = [];

  for (const msg of investigation.messages) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.tool_use) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: parsed.tool_use.id,
              type: "function",
              function: { name: parsed.tool_use.name, arguments: JSON.stringify(parsed.tool_use.input) },
            }],
          } as GroqMsg);
          continue;
        }
      } catch { /* not a tool_use message */ }
      messages.push({ role: "assistant", content: msg.content });
    } else if (msg.role === "tool") {
      // Find the preceding tool_call id
      const lastAssistant = [...messages].reverse().find(m => m.role === "assistant") as { tool_calls?: Array<{ id: string }> } | undefined;
      const toolCallId = lastAssistant?.tool_calls?.[0]?.id || "tool_call_0";
      messages.push({ role: "tool", tool_call_id: toolCallId, content: msg.content } as GroqMsg);
    }
  }

  return messages;
}

function buildAnthropicMessages(investigation: Investigation) {
  type Msg = import("@anthropic-ai/sdk").Anthropic.MessageParam;
  const messages: Msg[] = [];

  for (const msg of investigation.messages) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.tool_use) {
          messages.push({
            role: "assistant",
            content: [{ type: "tool_use", id: parsed.tool_use.id, name: parsed.tool_use.name, input: parsed.tool_use.input }],
          });
          continue;
        }
      } catch { /* not a tool_use message */ }
      messages.push({ role: "assistant", content: msg.content });
    } else if (msg.role === "tool") {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "assistant" && Array.isArray(lastMsg.content)) {
        const toolBlock = lastMsg.content.find((b): b is import("@anthropic-ai/sdk").Anthropic.ToolUseBlock => b.type === "tool_use");
        if (toolBlock) {
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolBlock.id, content: msg.content }] });
          continue;
        }
      }
      messages.push({ role: "user", content: `Tool result: ${msg.content}` });
    }
  }

  return messages;
}

// ─── Tool execution ───────────────────────────────────────────────────────────
async function executeToolCall(investigation: Investigation, toolCall: ToolCall): Promise<void> {
  toolCall.status = "executed";
  toolCall.executed_at = new Date().toISOString();

  addTimelineEvent(investigation, {
    type: "tool_call",
    title: `Executing: ${toolCall.tool_name}`,
    description: `Running ${toolCall.tool_name} with args: ${JSON.stringify(toolCall.tool_args)}`,
    tool_call: toolCall,
  });

  try {
    logger.info(`Executing tool: ${toolCall.tool_name}`, { args: toolCall.tool_args });

    const response = await axios.post(
      `${getMcpUrl()}/tools/${toolCall.tool_name}`,
      toolCall.tool_args,
      { timeout: 30000 }
    );

    toolCall.result = response.data.result;

    addTimelineEvent(investigation, {
      type: "observation",
      title: `Result: ${toolCall.tool_name}`,
      description: "Tool completed. Analyzing results...",
      data: toolCall.result,
    });

    await categorizeAsEvidence(investigation, toolCall);

    investigation.messages.push({
      role: "tool",
      content: JSON.stringify(toolCall.result),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toolCall.status = "failed";
    toolCall.error = message;
    logger.error(`Tool execution failed: ${message}`);
    investigation.messages.push({
      role: "tool",
      content: JSON.stringify({ error: message }),
      timestamp: new Date().toISOString(),
    });
  }
}

async function categorizeAsEvidence(investigation: Investigation, toolCall: ToolCall): Promise<void> {
  const result = toolCall.result as Record<string, unknown>;
  if (!result) return;

  let evidenceType: Evidence["type"] = "log";
  let relevance: Evidence["relevance"] = "medium";

  if (toolCall.tool_name.includes("log") || toolCall.tool_name.includes("cloudwatch")) evidenceType = "log";
  else if (toolCall.tool_name.includes("deploy") || toolCall.tool_name.includes("commit") || toolCall.tool_name.includes("merge") || toolCall.tool_name.includes("action")) evidenceType = "deployment";
  else if (toolCall.tool_name.includes("db") || toolCall.tool_name.includes("database") || toolCall.tool_name.includes("query")) evidenceType = "query_result";
  else if (toolCall.tool_name.includes("process") || toolCall.tool_name.includes("pm2")) evidenceType = "process";
  else if (toolCall.tool_name.includes("network") || toolCall.tool_name.includes("port")) evidenceType = "network";
  else evidenceType = "metric";

  if (result.alerts && Array.isArray(result.alerts) && result.alerts.length > 0) relevance = "high";
  if (result.error_count && (result.error_count as number) > 10) relevance = "critical";
  if (result.failures && Array.isArray(result.failures) && (result.failures as unknown[]).length > 0) relevance = "high";
  if (result.error && typeof result.error === "string") relevance = "medium";

  investigation.evidence.push({
    id: uuidv4(),
    type: evidenceType,
    source: toolCall.tool_name,
    title: formatEvidenceTitle(toolCall.tool_name),
    content: result,
    relevance,
    timestamp: new Date().toISOString(),
  });
}

function formatEvidenceTitle(toolName: string): string {
  return toolName
    .split("_")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Report extraction ────────────────────────────────────────────────────────
async function extractAndFinalizeReport(investigation: Investigation, text: string): Promise<void> {
  try {
    const jsonMatch =
      text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
      text.match(/(\{[\s\S]*"root_cause"[\s\S]*"confidence"[\s\S]*\})/);

    if (jsonMatch) {
      const reportData = JSON.parse(jsonMatch[1]);
      investigation.report = {
        summary: reportData.summary || "Investigation complete",
        root_cause: reportData.root_cause || "Root cause identified",
        contributing_factors: reportData.contributing_factors || [],
        evidence: investigation.evidence,
        confidence: reportData.confidence || 75,
        severity: reportData.severity || "high",
        suggested_fixes: reportData.suggested_fixes || [],
        immediate_actions: reportData.immediate_actions || [],
        next_steps: reportData.next_steps || [],
        timeline_of_events: reportData.timeline_of_events || [],
        postmortem_notes: reportData.postmortem_notes || "",
      };
    }
  } catch {
    logger.warn("Could not parse structured report from AI response");
  }
}

async function generateFinalReport(investigation: Investigation): Promise<void> {
  investigation.report = {
    summary: `Investigation of: ${investigation.incident_description}`,
    root_cause: "See evidence and timeline for detailed analysis",
    contributing_factors: [],
    evidence: investigation.evidence,
    confidence: 70,
    severity: "high",
    suggested_fixes: [],
    immediate_actions: ["Review evidence collected during investigation"],
    next_steps: ["Check all flagged alerts in evidence", "Review deployment timeline"],
    timeline_of_events: investigation.timeline.map(e => `${e.timestamp}: ${e.title}`),
    postmortem_notes: `Investigation completed. ${investigation.evidence.length} evidence items collected.`,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function addTimelineEvent(
  investigation: Investigation,
  event: Omit<TimelineEvent, "id" | "timestamp">
): void {
  investigation.timeline.push({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    ...event,
  });
  investigation.updated_at = new Date().toISOString();
}

function buildUserMessage(request: InvestigationRequest): string {
  let message = `INCIDENT REPORT\n===============\n\nDescription: ${request.incident_description}\n`;
  if (request.context) {
    if (request.context.service) message += `\nAffected Service: ${request.context.service}`;
    if (request.context.environment) message += `\nEnvironment: ${request.context.environment}`;
    if (request.context.time_range_minutes) message += `\nTime Window: Last ${request.context.time_range_minutes} minutes`;
    if (request.context.known_symptoms?.length) {
      message += `\n\nKnown Symptoms:\n${request.context.known_symptoms.map(s => `- ${s}`).join("\n")}`;
    }
  }
  message += "\n\nInvestigate systematically. Request tool approvals to gather real evidence.";
  return message;
}
