import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

export const pm2Tools: Tool[] = [
  {
    name: "get_pm2_status",
    description: "Get REAL status of all PM2-managed processes by running 'pm2 jlist'. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "Filter to specific app name (optional)" },
      },
    },
  },
  {
    name: "get_pm2_logs",
    description: "Get REAL recent logs from PM2 log files on disk. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "PM2 app name" },
        lines: { type: "number", default: 100 },
        log_type: { type: "string", enum: ["out", "err", "all"], default: "all" },
      },
      required: ["app_name"],
    },
  },
  {
    name: "get_pm2_restarts",
    description: "Get restart history and crash information for PM2 processes. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        app_name: { type: "string", description: "App name (optional)" },
        last_hours: { type: "number", default: 24 },
      },
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function isPm2Available(): Promise<boolean> {
  try {
    await execAsync("pm2 --version");
    return true;
  } catch {
    return false;
  }
}

function pm2LogPaths(appName: string): { out: string[]; err: string[] } {
  const pm2Root = process.env.PM2_LOG_PATH ||
    (process.env.HOME ? path.join(process.env.HOME, ".pm2", "logs") : null) ||
    "/root/.pm2/logs";

  return {
    out: [
      path.join(pm2Root, `${appName}-out.log`),
      path.join(pm2Root, `${appName}-out-0.log`),
      `/home/ubuntu/.pm2/logs/${appName}-out.log`,
    ],
    err: [
      path.join(pm2Root, `${appName}-error.log`),
      path.join(pm2Root, `${appName}-err.log`),
      path.join(pm2Root, `${appName}-error-0.log`),
      `/home/ubuntu/.pm2/logs/${appName}-error.log`,
    ],
  };
}

function readLogFileTail(filePath: string, lines: number): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
export const pm2ToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  get_pm2_status: async (args: unknown) => {
    const { app_name } = args as { app_name?: string };
    const available = await isPm2Available();

    if (!available) {
      return {
        pm2_available: false,
        message: "PM2 is not installed or not in PATH on this machine",
        hint: "This tool is for servers running PM2. If your app runs in Docker/ECS, use list_ecs_services instead.",
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const { stdout } = await execAsync("pm2 jlist", { timeout: 10000 });
      const processes = JSON.parse(stdout) as Array<Record<string, unknown>>;

      const filtered = app_name
        ? processes.filter(p => (p.name as string)?.includes(app_name))
        : processes;

      const apps = filtered.map(p => {
        const monit = p.monit as Record<string, unknown> || {};
        const pm2Env = p.pm2_env as Record<string, unknown> || {};
        const status = pm2Env.status as string || "unknown";
        const uptimeMs = pm2Env.pm_uptime as number;
        const now = Date.now();

        return {
          name: p.name,
          pm_id: p.pm_id,
          status,
          pid: p.pid || null,
          cpu_percent: monit.cpu ?? 0,
          memory_mb: Math.round(((monit.memory as number) || 0) / 1024 / 1024),
          uptime: uptimeMs ? formatUptime(now - uptimeMs) : "0",
          uptime_ms: uptimeMs ? now - uptimeMs : 0,
          restarts: pm2Env.restart_time ?? 0,
          last_restart: pm2Env.created_at ? new Date(pm2Env.created_at as number).toISOString() : null,
          instances: pm2Env.instances ?? 1,
          exec_mode: pm2Env.exec_mode ?? "fork",
          script: pm2Env.pm_exec_path ?? pm2Env.script,
          node_version: pm2Env.node_version,
          version: pm2Env.version ?? "N/A",
          watch: pm2Env.watch ?? false,
          exit_code: pm2Env.exit_code ?? null,
          error: status === "errored" ? `Exit code ${pm2Env.exit_code ?? "?"}` : undefined,
        };
      });

      const errored = apps.filter(a => a.status === "errored" || a.status === "stopped");
      const highRestarts = apps.filter(a => (a.restarts as number) > 5);
      const highMemory = apps.filter(a => (a.memory_mb as number) > 500);

      const alerts: string[] = [
        ...errored.map(a => `${a.name} is in ${a.status} state (exit code: ${a.exit_code ?? "?"})`),
        ...highRestarts.map(a => `${a.name} has restarted ${a.restarts} times`),
        ...highMemory.map(a => `${a.name} is using ${a.memory_mb}MB RAM`),
      ];

      return {
        pm2_available: true,
        apps,
        summary: {
          total: apps.length,
          online: apps.filter(a => a.status === "online").length,
          errored: apps.filter(a => a.status === "errored").length,
          stopped: apps.filter(a => a.status === "stopped").length,
        },
        alerts,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, pm2_available: true, timestamp: new Date().toISOString() };
    }
  },

  get_pm2_logs: async (args: unknown) => {
    const { app_name, lines = 100, log_type = "all" } = args as {
      app_name: string; lines?: number; log_type?: string;
    };

    const available = await isPm2Available();
    if (!available) {
      return { pm2_available: false, message: "PM2 not installed", timestamp: new Date().toISOString() };
    }

    const logPaths = pm2LogPaths(app_name);
    const entries: Array<{ timestamp: string; type: string; app: string; message: string }> = [];
    const foundFiles: string[] = [];

    const readAndParse = (filePaths: string[], type: string) => {
      for (const p of filePaths) {
        if (fs.existsSync(p)) {
          foundFiles.push(p);
          const rawLines = readLogFileTail(p, lines);
          for (const line of rawLines) {
            // Try to parse PM2 JSON log format or plain text
            try {
              const parsed = JSON.parse(line);
              entries.push({
                timestamp: parsed.timestamp || new Date().toISOString(),
                type,
                app: app_name,
                message: parsed.message || line,
              });
            } catch {
              entries.push({
                timestamp: new Date().toISOString(),
                type,
                app: app_name,
                message: line,
              });
            }
          }
          break; // Use first found file per type
        }
      }
    };

    if (log_type === "out" || log_type === "all") readAndParse(logPaths.out, "out");
    if (log_type === "err" || log_type === "all") readAndParse(logPaths.err, "err");

    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const errorCount = entries.filter(e => e.type === "err").length;

    return {
      app: app_name,
      log_type,
      files_read: foundFiles,
      total_entries: entries.length,
      error_count: errorCount,
      entries: entries.slice(-lines),
      note: foundFiles.length === 0
        ? `No PM2 log files found for "${app_name}". PM2_LOG_PATH=${process.env.PM2_LOG_PATH || "not set"}`
        : undefined,
      timestamp: new Date().toISOString(),
    };
  },

  get_pm2_restarts: async (args: unknown) => {
    const { app_name, last_hours = 24 } = args as { app_name?: string; last_hours?: number };
    const available = await isPm2Available();

    if (!available) {
      return { pm2_available: false, message: "PM2 not installed", timestamp: new Date().toISOString() };
    }

    try {
      const { stdout } = await execAsync("pm2 jlist", { timeout: 10000 });
      const processes = JSON.parse(stdout) as Array<Record<string, unknown>>;

      const filtered = app_name
        ? processes.filter(p => (p.name as string)?.includes(app_name))
        : processes;

      const restartData = filtered.map(p => {
        const pm2Env = p.pm2_env as Record<string, unknown> || {};
        const restarts = (pm2Env.restart_time as number) ?? 0;
        const status = pm2Env.status as string;
        const exitCode = pm2Env.exit_code;

        return {
          app: p.name,
          status,
          restart_count: restarts,
          exit_code: exitCode ?? null,
          last_restart: pm2Env.created_at ? new Date(pm2Env.created_at as number).toISOString() : null,
          concern: restarts > 10
            ? `HIGH: ${restarts} restarts — likely crash loop`
            : restarts > 3
            ? `MODERATE: ${restarts} restarts in session`
            : null,
        };
      });

      const concerning = restartData.filter(r => r.concern);

      return {
        period_hours: last_hours,
        processes: restartData,
        concerning_processes: concerning,
        max_restarts: restartData.reduce((max, r) => Math.max(max, r.restart_count), 0),
        alerts: concerning.map(r => `${r.app}: ${r.concern}`),
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg, timestamp: new Date().toISOString() };
    }
  },
};
