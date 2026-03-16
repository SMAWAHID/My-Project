import axios from "axios";
import { Investigation } from "@/types";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL || "http://localhost:3002";

const api = axios.create({ baseURL: AGENT_URL });

export async function startInvestigation(
  description: string,
  context?: {
    service?: string;
    environment?: string;
    time_range_minutes?: number;
    known_symptoms?: string[];
  }
): Promise<Investigation> {
  const res = await api.post("/investigations", {
    incident_description: description,
    context,
  });
  return res.data;
}

export async function fetchInvestigation(id: string): Promise<Investigation> {
  const res = await api.get(`/investigations/${id}`);
  return res.data;
}

export async function listInvestigations(): Promise<Investigation[]> {
  const res = await api.get("/investigations");
  return res.data;
}

export async function approveToolCall(
  investigationId: string,
  toolCallId: string,
  approved: boolean
): Promise<Investigation> {
  const res = await api.post(`/investigations/${investigationId}/tool-approval`, {
    tool_call_id: toolCallId,
    approved,
  });
  return res.data;
}
