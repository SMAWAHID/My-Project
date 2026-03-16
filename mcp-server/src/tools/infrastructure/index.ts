import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as fs from "fs";

const execAsync = promisify(exec);

export const infraTools: Tool[] = [
  {
    name: "check_cpu_usage",
    description: "Check real CPU usage and load averages using os module and /proc/stat. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        include_per_core: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "check_memory_usage",
    description: "Check real RAM and swap usage from /proc/meminfo. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        include_process_breakdown: { type: "boolean", default: false },
        top_n_processes: { type: "number", default: 10 },
      },
    },
  },
  {
    name: "check_disk_usage",
    description: "Check real disk space usage using 'df'. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "/" },
        include_inodes: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "check_system_load",
    description: "Check system load averages (1, 5, 15 min) from os.loadavg(). READ-ONLY.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_network_connections",
    description: "Check active network connections using 'ss' or 'netstat'. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Filter by port" },
        state: { type: "string", enum: ["ESTABLISHED", "LISTEN", "TIME_WAIT", "CLOSE_WAIT", "ALL"], default: "ALL" },
      },
    },
  },
  {
    name: "check_open_ports",
    description: "List all open listening ports using 'ss -tlnp'. READ-ONLY.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_running_processes",
    description: "List running processes sorted by CPU or memory using 'ps aux'. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        sort_by: { type: "string", enum: ["cpu", "memory", "pid"], default: "cpu" },
        top_n: { type: "number", default: 20 },
        filter_name: { type: "string", description: "Filter by process name" },
      },
    },
  },
  {
    name: "get_uptime",
    description: "Get real system uptime and last reboot time. READ-ONLY.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isLinux() { return process.platform === "linux"; }
function isWindows() { return process.platform === "win32"; }

async function tryExec(cmd: string, timeout = 5000): Promise<string | null> {
  try {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseProcMeminfo(): Record<string, number> {
  if (!isLinux()) return {};
  try {
    const content = fs.readFileSync("/proc/meminfo", "utf-8");
    const result: Record<string, number> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+):\s+(\d+)/);
      if (match) result[match[1]] = parseInt(match[2]) * 1024; // kB to bytes
    }
    return result;
  } catch { return {}; }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
export const infraToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  check_cpu_usage: async (args: unknown) => {
    const { include_per_core = true } = args as { include_per_core?: boolean };
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    // Calculate real per-core usage from cpu.times
    const perCore = cpus.map((cpu, i) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      const usage = total > 0 ? Math.round((1 - idle / total) * 100 * 10) / 10 : 0;
      return { core: i, model: cpu.model, speed_mhz: cpu.speed, usage_percent: usage };
    });

    const avgUsage = perCore.reduce((s, c) => s + c.usage_percent, 0) / perCore.length;
    const normalizedLoad = loadAvg[0] / cpus.length;

    // Top CPU processes
    let topProcesses: unknown[] = [];
    const psOut = await tryExec("ps aux --sort=-%cpu --no-headers | head -10");
    if (psOut) {
      topProcesses = psOut.split("\n").slice(0, 10).map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          user: parts[0], pid: parts[1], cpu_percent: parseFloat(parts[2]),
          mem_percent: parseFloat(parts[3]), command: parts.slice(10).join(" ").slice(0, 60),
        };
      });
    }

    return {
      avg_usage_percent: Math.round(avgUsage * 10) / 10,
      load_average: { "1min": loadAvg[0], "5min": loadAvg[1], "15min": loadAvg[2] },
      normalized_load_1min: Math.round(normalizedLoad * 100) / 100,
      core_count: cpus.length,
      per_core: include_per_core ? perCore : null,
      top_cpu_processes: topProcesses,
      alert: normalizedLoad > 1.5 ? "CRITICAL: CPU overloaded" : normalizedLoad > 0.8 ? "WARNING: High CPU load" : null,
      timestamp: new Date().toISOString(),
    };
  },

  check_memory_usage: async (args: unknown) => {
    const { include_process_breakdown = false, top_n_processes = 10 } = args as {
      include_process_breakdown?: boolean; top_n_processes?: number;
    };

    let totalBytes = os.totalmem();
    let freeBytes = os.freemem();
    let availableBytes = freeBytes;
    let swapTotal = 0, swapFree = 0;

    // Use /proc/meminfo for more accurate numbers on Linux
    const meminfo = parseProcMeminfo();
    if (Object.keys(meminfo).length > 0) {
      totalBytes = meminfo["MemTotal"] || totalBytes;
      freeBytes = meminfo["MemFree"] || freeBytes;
      availableBytes = meminfo["MemAvailable"] || freeBytes;
      swapTotal = meminfo["SwapTotal"] || 0;
      swapFree = meminfo["SwapFree"] || 0;
    }

    const usedBytes = totalBytes - availableBytes;
    const usedPct = Math.round((usedBytes / totalBytes) * 100 * 10) / 10;
    const round = (b: number) => Math.round(b / 1024 / 1024 / 1024 * 100) / 100;

    let topProcesses: unknown[] = [];
    if (include_process_breakdown) {
      const psOut = await tryExec(`ps aux --sort=-%mem --no-headers | head -${top_n_processes}`);
      if (psOut) {
        topProcesses = psOut.split("\n").map(line => {
          const parts = line.trim().split(/\s+/);
          return {
            pid: parts[1], name: parts[10]?.split("/").pop() || parts[10],
            mem_percent: parseFloat(parts[3]),
            mem_mb: Math.round(parseInt(parts[5] || "0") / 1024),
            cpu_percent: parseFloat(parts[2]),
            command: parts.slice(10).join(" ").slice(0, 60),
          };
        });
      }
    }

    return {
      total_gb: round(totalBytes),
      used_gb: round(usedBytes),
      free_gb: round(freeBytes),
      available_gb: round(availableBytes),
      used_percent: usedPct,
      swap: swapTotal > 0 ? {
        total_gb: round(swapTotal),
        used_gb: round(swapTotal - swapFree),
        free_gb: round(swapFree),
        used_percent: Math.round(((swapTotal - swapFree) / swapTotal) * 100 * 10) / 10,
      } : { available: false },
      top_processes: topProcesses,
      alert: usedPct > 90 ? `CRITICAL: Memory at ${usedPct}%` : usedPct > 80 ? `WARNING: Memory at ${usedPct}%` : null,
      timestamp: new Date().toISOString(),
    };
  },

  check_disk_usage: async (args: unknown) => {
    const { path: checkPath = "/", include_inodes = false } = args as {
      path?: string; include_inodes?: boolean;
    };

    const filesystems: unknown[] = [];

    // Use df for real disk info
    const dfFlags = isLinux() ? "-hP" : "-h";
    const dfOut = await tryExec(`df ${dfFlags} 2>/dev/null || df -h`);
    if (dfOut) {
      const lines = dfOut.split("\n").slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 6) continue;
        const usedPct = parseInt(parts[4]);
        filesystems.push({
          filesystem: parts[0],
          size: parts[1],
          used: parts[2],
          available: parts[3],
          used_percent: isNaN(usedPct) ? 0 : usedPct,
          mount: parts[5],
          alert: usedPct > 90 ? `CRITICAL: ${parts[5]} at ${parts[4]} capacity` :
                 usedPct > 80 ? `WARNING: ${parts[5]} at ${parts[4]} capacity` : null,
        });
      }
    }

    // Largest directories
    const largestDirs: unknown[] = [];
    const duOut = await tryExec(`du -sh /var/log/* 2>/dev/null | sort -rh | head -10`);
    if (duOut) {
      for (const line of duOut.split("\n").filter(Boolean)) {
        const [size, ...pathParts] = line.split("\t");
        largestDirs.push({ path: pathParts.join("\t"), size });
      }
    }

    const alerts = (filesystems as Array<{ alert: string | null }>)
      .filter(f => f.alert).map(f => f.alert!);

    return {
      filesystems,
      largest_log_dirs: largestDirs,
      alerts,
      timestamp: new Date().toISOString(),
    };
  },

  check_system_load: async () => {
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    const normalized1 = loadAvg[0] / cpuCount;

    // Also grab from /proc/loadavg on Linux for more precision
    let procLoad = null;
    if (isLinux()) {
      const content = await tryExec("cat /proc/loadavg");
      if (content) procLoad = content;
    }

    return {
      load_average: {
        "1min": Math.round(loadAvg[0] * 100) / 100,
        "5min": Math.round(loadAvg[1] * 100) / 100,
        "15min": Math.round(loadAvg[2] * 100) / 100,
      },
      cpu_count: cpuCount,
      normalized_1min: Math.round(normalized1 * 100) / 100,
      proc_loadavg: procLoad,
      interpretation: normalized1 > 1.5 ? "OVERLOADED" : normalized1 > 0.8 ? "HIGH" : "NORMAL",
      timestamp: new Date().toISOString(),
    };
  },

  check_network_connections: async (args: unknown) => {
    const { port, state = "ALL" } = args as { port?: number; state?: string };

    let summary: Record<string, number> = {};
    let connections: unknown[] = [];

    // Use ss (modern) or netstat (fallback)
    const ssOut = await tryExec("ss -tun 2>/dev/null | tail -n +2 | head -500");
    if (ssOut) {
      const lines = ssOut.split("\n").filter(Boolean);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        const connState = parts[1] || "UNKNOWN";
        summary[connState] = (summary[connState] || 0) + 1;
        if (state === "ALL" || connState === state) {
          connections.push({
            protocol: parts[0],
            state: connState,
            local: parts[4],
            remote: parts[5],
          });
        }
      }
    } else {
      const netstatOut = await tryExec("netstat -tun 2>/dev/null | tail -n +3 | head -200");
      if (netstatOut) {
        const lines = netstatOut.split("\n").filter(Boolean);
        for (const line of lines) {
          const parts = line.split(/\s+/);
          const connState = parts[5] || "UNKNOWN";
          summary[connState] = (summary[connState] || 0) + 1;
        }
      }
    }

    if (port) {
      connections = connections.filter(c => (c as { local: string }).local?.includes(`:${port}`) || (c as { remote: string }).remote?.includes(`:${port}`));
    }

    const total = Object.values(summary).reduce((a, b) => a + b, 0);
    const closeWait = summary["CLOSE-WAIT"] || 0;
    const timeWait = summary["TIME-WAIT"] || 0;

    return {
      summary: { ...summary, TOTAL: total },
      connections: connections.slice(0, 100),
      alerts: [
        closeWait > 20 ? `${closeWait} CLOSE_WAIT connections — possible connection leak` : null,
        timeWait > 100 ? `${timeWait} TIME_WAIT connections — high connection churn` : null,
      ].filter(Boolean),
      timestamp: new Date().toISOString(),
    };
  },

  check_open_ports: async () => {
    // ss -tlnp shows TCP listening ports with process info
    const ssOut = await tryExec("ss -tlnp 2>/dev/null") ||
                  await tryExec("netstat -tlnp 2>/dev/null") ||
                  await tryExec("netstat -an 2>/dev/null | grep LISTEN");

    const ports: unknown[] = [];
    if (ssOut) {
      const lines = ssOut.split("\n").filter(Boolean).slice(1);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 4) continue;
        const localAddr = parts[3] || parts[4] || "";
        const portMatch = localAddr.match(/:(\d+)$/);
        if (!portMatch) continue;
        const portNum = parseInt(portMatch[1]);
        // Extract process name from ss output (users:(("nginx",pid=892,...)))
        const processMatch = line.match(/users:\(\("([^"]+)"/);
        const pidMatch = line.match(/pid=(\d+)/);
        ports.push({
          port: portNum,
          bind: localAddr.replace(`:${portNum}`, ""),
          service: processMatch?.[1] || "unknown",
          pid: pidMatch ? parseInt(pidMatch[1]) : null,
          raw: line.trim(),
        });
      }
    }

    return {
      listening_ports: ports,
      total: ports.length,
      note: ports.length === 0 ? "Could not read open ports. Try running with elevated permissions." : undefined,
      timestamp: new Date().toISOString(),
    };
  },

  list_running_processes: async (args: unknown) => {
    const { sort_by = "cpu", top_n = 20, filter_name } = args as {
      sort_by?: string; top_n?: number; filter_name?: string;
    };

    const sortFlag = sort_by === "memory" ? "-%mem" : sort_by === "pid" ? "pid" : "-%cpu";
    let psCmd = `ps aux --sort=${sortFlag} --no-headers | head -${top_n + 5}`;
    if (isWindows()) {
      psCmd = `tasklist /fo csv /nh 2>nul`;
    }

    const psOut = await tryExec(psCmd);
    if (!psOut) {
      return { error: "Could not run ps command", platform: process.platform, timestamp: new Date().toISOString() };
    }

    let processes = psOut.split("\n").filter(Boolean).map(line => {
      if (isWindows()) {
        const parts = line.split('","').map(p => p.replace(/"/g, ""));
        return { name: parts[0], pid: parts[1], session: parts[2], mem_kb: parts[4] };
      }
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0],
        pid: parseInt(parts[1]),
        cpu_percent: parseFloat(parts[2]),
        mem_percent: parseFloat(parts[3]),
        mem_kb: parseInt(parts[5] || "0"),
        mem_mb: Math.round(parseInt(parts[5] || "0") / 1024),
        status: parts[7] || "?",
        started: parts[8],
        name: parts[10]?.split("/").pop() || parts[10],
        command: parts.slice(10).join(" ").slice(0, 80),
      };
    });

    if (filter_name) {
      processes = processes.filter(p =>
        p.command?.toLowerCase().includes(filter_name.toLowerCase()) ||
        p.name?.toLowerCase().includes(filter_name.toLowerCase())
      );
    }

    // Check for zombie processes
    const zombieOut = await tryExec("ps aux | grep 'Z' | grep -v grep | wc -l");
    const zombieCount = zombieOut ? parseInt(zombieOut) : 0;

    return {
      processes: processes.slice(0, top_n),
      total_shown: Math.min(processes.length, top_n),
      zombie_count: zombieCount,
      sort_by,
      alerts: zombieCount > 0 ? [`${zombieCount} zombie process(es) detected`] : [],
      timestamp: new Date().toISOString(),
    };
  },

  get_uptime: async () => {
    const uptimeSeconds = os.uptime();

    // Try to get last reboot reason on Linux
    let lastRebootReason: string | null = null;
    if (isLinux()) {
      const dmesgOut = await tryExec("last reboot 2>/dev/null | head -3");
      if (dmesgOut) lastRebootReason = dmesgOut.split("\n")[0]?.trim() || null;
    }

    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    return {
      uptime_seconds: uptimeSeconds,
      uptime_human: days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`,
      last_reboot: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
      recent_reboot_history: lastRebootReason,
      alert: uptimeSeconds < 3600 ? "System rebooted within the last hour" : null,
      timestamp: new Date().toISOString(),
    };
  },
};
