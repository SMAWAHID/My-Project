import { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const execAsync = promisify(exec);

// ─── CloudWatch client (lazy init) ───────────────────────────────────────────
function getCWClient() {
  return new CloudWatchLogsClient({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        }
      : undefined,
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
export const logTools: Tool[] = [
  {
    name: "get_logs",
    description: "Retrieve application logs from log files on disk for a specific service. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name (e.g., fastapi, nginx, postgres)" },
        last_minutes: { type: "number", description: "Minutes to look back", default: 30 },
        log_level: { type: "string", enum: ["ERROR", "WARN", "INFO", "DEBUG", "ALL"], default: "ALL" },
        max_lines: { type: "number", default: 200 },
      },
      required: ["service"],
    },
  },
  {
    name: "search_logs",
    description: "Search log files on disk for a pattern or error message. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern or regex" },
        service: { type: "string", description: "Service to search (optional)" },
        last_hours: { type: "number", default: 24 },
        case_sensitive: { type: "boolean", default: false },
      },
      required: ["pattern"],
    },
  },
  {
    name: "tail_logs",
    description: "Get the most recent log entries from disk for a service. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        lines: { type: "number", default: 100 },
      },
      required: ["service"],
    },
  },
  {
    name: "get_cloudwatch_logs",
    description: "Retrieve REAL logs from AWS CloudWatch Logs. Requires AWS credentials in environment. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        log_group: { type: "string", description: "CloudWatch log group name (e.g. /aws/lambda/my-function or /ecs/my-service)" },
        log_stream: { type: "string", description: "Specific log stream name (optional, fetches all streams if omitted)" },
        filter_pattern: { type: "string", description: "CloudWatch filter pattern (e.g. ERROR, [timestamp, level=ERROR, ...])" },
        start_time_minutes_ago: { type: "number", default: 60 },
        limit: { type: "number", default: 100 },
      },
      required: ["log_group"],
    },
  },
  {
    name: "get_error_logs",
    description: "Extract ERROR-level entries from disk logs or CloudWatch. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        last_minutes: { type: "number", default: 60 },
        include_stack_traces: { type: "boolean", default: true },
        source: { type: "string", enum: ["disk", "cloudwatch", "auto"], default: "auto" },
        cloudwatch_log_group: { type: "string", description: "If source=cloudwatch, the log group to query" },
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLogPaths(service: string): string[] {
  const base = process.env.LOG_BASE_PATH || "/var/log";
  const pm2 = process.env.PM2_LOG_PATH || "/root/.pm2/logs";
  return [
    `${base}/${service}/${service}.log`,
    `${base}/${service}/app.log`,
    `${base}/${service}/error.log`,
    `${base}/${service}.log`,
    `${pm2}/${service}-out.log`,
    `${pm2}/${service}-error.log`,
    `/home/ubuntu/.pm2/logs/${service}-out.log`,
    `/home/ubuntu/.pm2/logs/${service}-error.log`,
  ];
}

function readLogFile(filePath: string, maxLines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

async function tailFileLines(filePath: string, lines: number): Promise<string[]> {
  if (!fs.existsSync(filePath)) return [];
  try {
    const { stdout } = await execAsync(`tail -n ${lines} "${filePath}"`);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return readLogFile(filePath, lines);
  }
}

async function grepLogFile(filePath: string, pattern: string, caseSensitive: boolean): Promise<Array<{ line: string; lineNum: number }>> {
  if (!fs.existsSync(filePath)) return [];
  try {
    const flag = caseSensitive ? "" : "-i";
    const { stdout } = await execAsync(`grep -n ${flag} "${pattern.replace(/"/g, '\\"')}" "${filePath}" 2>/dev/null | head -200`);
    return stdout.split("\n").filter(Boolean).map(line => {
      const [num, ...rest] = line.split(":");
      return { lineNum: parseInt(num), line: rest.join(":") };
    });
  } catch {
    return [];
  }
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
export const logToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  get_logs: async (args: unknown) => {
    const { service, last_minutes = 30, log_level = "ALL", max_lines = 200 } = args as {
      service: string; last_minutes?: number; log_level?: string; max_lines?: number;
    };

    const paths = getLogPaths(service);
    const foundFiles: string[] = [];
    let allLines: string[] = [];

    for (const p of paths) {
      if (fs.existsSync(p)) {
        foundFiles.push(p);
        const lines = await tailFileLines(p, max_lines);
        allLines = allLines.concat(lines);
      }
    }

    // Filter by log level
    let filtered = allLines;
    if (log_level !== "ALL") {
      filtered = allLines.filter(l => l.toUpperCase().includes(log_level));
    }

    const errorCount = allLines.filter(l => l.toUpperCase().includes("ERROR")).length;
    const warnCount = allLines.filter(l => l.toUpperCase().includes("WARN")).length;

    if (foundFiles.length === 0) {
      return {
        service,
        found: false,
        message: `No log files found for service "${service}". Checked: ${paths.join(", ")}`,
        hint: "Set LOG_BASE_PATH or PM2_LOG_PATH environment variables, or use get_cloudwatch_logs for AWS logs.",
        paths_checked: paths,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      service,
      files_read: foundFiles,
      total_lines: allLines.length,
      filtered_lines: filtered.length,
      log_level_filter: log_level,
      error_count: errorCount,
      warn_count: warnCount,
      entries: filtered.slice(-max_lines).map(line => ({ raw: line })),
      timestamp: new Date().toISOString(),
    };
  },

  search_logs: async (args: unknown) => {
    const { pattern, service, last_hours = 24, case_sensitive = false } = args as {
      pattern: string; service?: string; last_hours?: number; case_sensitive?: boolean;
    };

    const base = process.env.LOG_BASE_PATH || "/var/log";
    const services = service ? [service] : ["fastapi", "nginx", "postgres", "redis", "node", "app"];
    const matches: Array<{ file: string; line_number: number; content: string }> = [];

    for (const svc of services) {
      for (const p of getLogPaths(svc)) {
        const results = await grepLogFile(p, pattern, case_sensitive);
        matches.push(...results.map(r => ({ file: p, line_number: r.lineNum, content: r.line })));
      }
    }

    // Also try searching with find + grep for broader coverage
    if (matches.length === 0 && service) {
      try {
        const flag = case_sensitive ? "" : "-i";
        const { stdout } = await execAsync(
          `find "${base}" -name "*.log" -newer /tmp -exec grep -l ${flag} "${pattern.replace(/"/g, '\\"')}" {} \\; 2>/dev/null | head -10`
        );
        const files = stdout.split("\n").filter(Boolean);
        for (const file of files) {
          const results = await grepLogFile(file, pattern, case_sensitive);
          matches.push(...results.map(r => ({ file, line_number: r.lineNum, content: r.line })));
        }
      } catch { /* ignore */ }
    }

    return {
      pattern,
      service: service || "all",
      total_matches: matches.length,
      matches: matches.slice(0, 100),
      case_sensitive,
      timestamp: new Date().toISOString(),
    };
  },

  tail_logs: async (args: unknown) => {
    const { service, lines = 100 } = args as { service: string; lines?: number };

    const paths = getLogPaths(service);
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const entries = await tailFileLines(p, lines);
        return {
          service,
          file: p,
          lines_requested: lines,
          lines_returned: entries.length,
          entries,
          timestamp: new Date().toISOString(),
        };
      }
    }

    return {
      service,
      found: false,
      message: `No log files found for "${service}"`,
      paths_checked: paths,
      timestamp: new Date().toISOString(),
    };
  },

  get_cloudwatch_logs: async (args: unknown) => {
    const {
      log_group,
      log_stream,
      filter_pattern,
      start_time_minutes_ago = 60,
      limit = 100,
    } = args as {
      log_group: string;
      log_stream?: string;
      filter_pattern?: string;
      start_time_minutes_ago?: number;
      limit?: number;
    };

    if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
      return {
        error: "AWS credentials not configured",
        setup_required: [
          "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file",
          "Or set AWS_PROFILE to use a named profile from ~/.aws/credentials",
          "Required IAM permissions: logs:FilterLogEvents, logs:GetLogEvents, logs:DescribeLogStreams",
        ],
        log_group,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const client = getCWClient();
      const startTime = Date.now() - start_time_minutes_ago * 60 * 1000;
      const endTime = Date.now();

      if (filter_pattern) {
        // Use FilterLogEvents for pattern-based searching
        const command = new FilterLogEventsCommand({
          logGroupName: log_group,
          logStreamNames: log_stream ? [log_stream] : undefined,
          filterPattern: filter_pattern,
          startTime,
          endTime,
          limit: Math.min(limit, 10000),
        });

        const response = await client.send(command);
        const events = (response.events || []).map(e => ({
          timestamp: new Date(e.timestamp!).toISOString(),
          message: e.message?.trim(),
          log_stream: e.logStreamName,
          event_id: e.eventId,
        }));

        return {
          log_group,
          filter_pattern,
          time_window_minutes: start_time_minutes_ago,
          event_count: events.length,
          events,
          next_token: response.nextToken || null,
          timestamp: new Date().toISOString(),
        };
      } else {
        // Get recent log streams first
        const streamsCmd = new DescribeLogStreamsCommand({
          logGroupName: log_group,
          orderBy: "LastEventTime",
          descending: true,
          limit: log_stream ? 1 : 5,
        });

        const streamsResp = await client.send(streamsCmd);
        const streams = log_stream
          ? [log_stream]
          : (streamsResp.logStreams || []).map(s => s.logStreamName!).filter(Boolean);

        const allEvents: Array<{ timestamp: string; message: string; stream: string }> = [];

        for (const stream of streams.slice(0, 5)) {
          const eventsCmd = new GetLogEventsCommand({
            logGroupName: log_group,
            logStreamName: stream,
            startTime,
            endTime,
            limit: Math.ceil(limit / streams.length),
            startFromHead: false,
          });
          const eventsResp = await client.send(eventsCmd);
          const events = (eventsResp.events || []).map(e => ({
            timestamp: new Date(e.timestamp!).toISOString(),
            message: e.message?.trim() || "",
            stream,
          }));
          allEvents.push(...events);
        }

        allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return {
          log_group,
          streams_queried: streams,
          time_window_minutes: start_time_minutes_ago,
          event_count: allEvents.length,
          events: allEvents.slice(0, limit),
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        error: msg,
        log_group,
        hint: "Check that the log group name is correct and your IAM user has logs:FilterLogEvents and logs:GetLogEvents permissions",
        timestamp: new Date().toISOString(),
      };
    }
  },

  get_error_logs: async (args: unknown) => {
    const {
      service,
      last_minutes = 60,
      include_stack_traces = true,
      source = "auto",
      cloudwatch_log_group,
    } = args as {
      service?: string;
      last_minutes?: number;
      include_stack_traces?: boolean;
      source?: string;
      cloudwatch_log_group?: string;
    };

    // If CloudWatch source requested or configured
    if (source === "cloudwatch" || (source === "auto" && cloudwatch_log_group)) {
      const cwResult = await logToolHandlers.get_cloudwatch_logs({
        log_group: cloudwatch_log_group || `/aws/app/${service || "api"}`,
        filter_pattern: "ERROR",
        start_time_minutes_ago: last_minutes,
        limit: 200,
      }) as Record<string, unknown>;

      if (!cwResult.error) {
        const events = (cwResult.events as Array<{ message: string; timestamp: string }>) || [];
        const errors = events.filter(e => e.message?.toUpperCase().includes("ERROR") || e.message?.toUpperCase().includes("EXCEPTION") || e.message?.toUpperCase().includes("FATAL"));
        return {
          source: "cloudwatch",
          log_group: cloudwatch_log_group,
          service: service || "all",
          last_minutes,
          error_count: errors.length,
          errors: errors.map(e => ({
            timestamp: e.timestamp,
            level: "ERROR",
            message: e.message,
          })),
          timestamp: new Date().toISOString(),
        };
      }
    }

    // Fall back to disk-based log search
    const services = service ? [service] : ["fastapi", "api", "app", "nginx", "postgres", "node"];
    const allErrors: Array<{ file: string; timestamp?: string; level: string; message: string }> = [];

    for (const svc of services) {
      for (const p of getLogPaths(svc)) {
        if (!fs.existsSync(p)) continue;
        const lines = await tailFileLines(p, 500);
        for (const line of lines) {
          if (line.toUpperCase().includes("ERROR") || line.toUpperCase().includes("CRITICAL") || line.toUpperCase().includes("FATAL") || line.toUpperCase().includes("EXCEPTION") || line.toUpperCase().includes("TRACEBACK")) {
            allErrors.push({ file: p, level: "ERROR", message: include_stack_traces ? line : line.slice(0, 300) });
          }
        }
      }
    }

    // Count occurrences for deduplication
    const errorMap = new Map<string, { level: string; message: string; file: string; occurrences: number; first_seen?: string }>();
    for (const e of allErrors) {
      const key = e.message.slice(0, 100);
      const existing = errorMap.get(key);
      if (existing) { existing.occurrences++; } else { errorMap.set(key, { ...e, occurrences: 1 }); }
    }

    const deduplicated = Array.from(errorMap.values()).sort((a, b) => b.occurrences - a.occurrences);

    return {
      source: "disk",
      service: service || "all",
      last_minutes,
      error_count: allErrors.length,
      unique_errors: deduplicated.length,
      errors: deduplicated.slice(0, 50),
      severity_breakdown: {
        CRITICAL: deduplicated.filter(e => e.level === "CRITICAL").length,
        ERROR: deduplicated.filter(e => e.level === "ERROR").length,
      },
      note: deduplicated.length === 0 ? "No errors found on disk. If your app logs to CloudWatch, use source='cloudwatch' and set cloudwatch_log_group." : undefined,
      timestamp: new Date().toISOString(),
    };
  },
};
