export interface ToolCall {
  id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  result?: unknown;
  error?: string;
  requested_at: string;
  executed_at?: string;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: "thinking" | "tool_call" | "observation" | "hypothesis" | "conclusion";
  title: string;
  description: string;
  tool_call?: ToolCall;
  data?: unknown;
}

export interface Evidence {
  id: string;
  type: "log" | "metric" | "deployment" | "commit" | "query_result" | "process" | "network";
  source: string;
  title: string;
  content: unknown;
  relevance: "critical" | "high" | "medium" | "low";
  timestamp: string;
}

export interface RootCauseReport {
  summary: string;
  root_cause: string;
  contributing_factors: string[];
  evidence: Evidence[];
  confidence: number; // 0-100
  severity: "critical" | "high" | "medium" | "low";
  suggested_fixes: SuggestedFix[];
  immediate_actions: string[];
  next_steps: string[];
  timeline_of_events: string[];
  postmortem_notes: string;
}

export interface SuggestedFix {
  title: string;
  description: string;
  priority: "immediate" | "short_term" | "long_term";
  effort: "low" | "medium" | "high";
  commands?: string[];
  risk: "safe" | "medium" | "high";
}

export interface Investigation {
  id: string;
  incident_description: string;
  status: "running" | "waiting_approval" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  timeline: TimelineEvent[];
  evidence: Evidence[];
  pending_tool_call?: ToolCall;
  report?: RootCauseReport;
  messages: AgentMessage[];
}

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
}

export interface InvestigationRequest {
  incident_description: string;
  context?: {
    service?: string;
    environment?: string;
    time_range_minutes?: number;
    known_symptoms?: string[];
  };
}

export interface ToolApprovalRequest {
  investigation_id: string;
  tool_call_id: string;
  approved: boolean;
}
