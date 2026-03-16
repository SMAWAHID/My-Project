import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const deployTools: Tool[] = [
  {
    name: "get_deployments",
    description: "Get recent deployment history from GitHub Releases, Actions, or deployment tags. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service or repo name" },
        repo: { type: "string", description: "GitHub repo as owner/repo (e.g. myorg/api). Falls back to GITHUB_REPO env var." },
        last_n: { type: "number", default: 10 },
        include_rollbacks: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "get_github_commits",
    description: "Get recent Git commits from GitHub API. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo — falls back to GITHUB_REPO env var" },
        branch: { type: "string", default: "main" },
        last_n: { type: "number", default: 20 },
        since_hours: { type: "number", description: "Commits in last N hours" },
        path: { type: "string", description: "Filter commits by file path" },
      },
    },
  },
  {
    name: "get_github_actions_runs",
    description: "Get GitHub Actions workflow run history and status. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo — falls back to GITHUB_REPO env var" },
        workflow_name: { type: "string", description: "Workflow filename (e.g. deploy.yml) or ID" },
        last_n: { type: "number", default: 10 },
        status: { type: "string", enum: ["success", "failure", "cancelled", "all"], default: "all" },
      },
    },
  },
  {
    name: "get_recent_merges",
    description: "Get recently merged pull requests from GitHub. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo — falls back to GITHUB_REPO env var" },
        last_hours: { type: "number", default: 48 },
        base_branch: { type: "string", default: "main" },
      },
    },
  },
];

// ─── GitHub API helper ────────────────────────────────────────────────────────
async function githubFetch(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function getRepo(args: Record<string, unknown>): string | null {
  return (args.repo as string) || process.env.GITHUB_REPO || null;
}

function notConfigured() {
  return {
    error: "GitHub not configured",
    setup_required: [
      "Set GITHUB_TOKEN=ghp_... in your .env file",
      "Set GITHUB_REPO=owner/repo (e.g. myorg/api) in your .env file",
      "Token needs: repo scope (read access to code, commits, actions)",
    ],
    timestamp: new Date().toISOString(),
  };
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
export const deployToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  get_deployments: async (args: unknown) => {
    const params = args as Record<string, unknown>;
    const repo = getRepo(params);
    if (!repo) return notConfigured();

    try {
      // GitHub Deployments API
      const deploymentsData = await githubFetch(`/repos/${repo}/deployments?per_page=${params.last_n || 10}`) as Array<Record<string, unknown>>;

      const deployments = await Promise.all(
        deploymentsData.slice(0, 10).map(async (d) => {
          let status = "unknown";
          try {
            const statuses = await githubFetch(`/repos/${repo}/deployments/${d.id}/statuses`) as Array<Record<string, unknown>>;
            status = (statuses[0]?.state as string) || "unknown";
          } catch { /* ignore */ }

          return {
            id: d.id,
            ref: d.ref,
            environment: d.environment,
            description: d.description,
            creator: (d.creator as Record<string, unknown>)?.login,
            created_at: d.created_at,
            status,
            sha: (d.sha as string)?.slice(0, 8),
          };
        })
      );

      const failed = deployments.filter(d => d.status === "failure" || d.status === "error");

      return {
        repo,
        deployments,
        recent_failures: failed,
        alerts: failed.length > 0 ? [`${failed.length} recent failed deployments detected`] : [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, repo, hint: "If you don't use GitHub Deployments API, check get_github_actions_runs for deploy workflow history", timestamp: new Date().toISOString() };
    }
  },

  get_github_commits: async (args: unknown) => {
    const params = args as Record<string, unknown>;
    const repo = getRepo(params);
    if (!repo) return notConfigured();

    try {
      const branch = (params.branch as string) || "main";
      const last_n = (params.last_n as number) || 20;
      const since_hours = params.since_hours as number | undefined;
      const path = params.path as string | undefined;

      let url = `/repos/${repo}/commits?sha=${branch}&per_page=${last_n}`;
      if (since_hours) {
        const since = new Date(Date.now() - since_hours * 3600 * 1000).toISOString();
        url += `&since=${since}`;
      }
      if (path) url += `&path=${encodeURIComponent(path)}`;

      const data = await githubFetch(url) as Array<Record<string, unknown>>;

      const commits = data.map(c => {
        const commit = c.commit as Record<string, unknown>;
        const author = commit?.author as Record<string, unknown>;
        const committer = c.committer as Record<string, unknown>;
        return {
          sha: (c.sha as string)?.slice(0, 8),
          full_sha: c.sha,
          message: (commit?.message as string)?.split("\n")[0],
          author: author?.name || committer?.login,
          date: author?.date,
          url: c.html_url,
        };
      });

      // Flag commits that touched sensitive files
      const sensitivePatterns = ["db/", "config/", "migration", "connection", "pool", "deploy", ".env"];
      const flagged = commits.filter(c =>
        sensitivePatterns.some(p => c.message?.toLowerCase().includes(p))
      );

      return {
        repo,
        branch,
        commit_count: commits.length,
        commits,
        flagged_commits: flagged,
        alerts: flagged.length > 0 ? [`${flagged.length} commits touched configuration/database/deployment files`] : [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, repo, timestamp: new Date().toISOString() };
    }
  },

  get_github_actions_runs: async (args: unknown) => {
    const params = args as Record<string, unknown>;
    const repo = getRepo(params);
    if (!repo) return notConfigured();

    try {
      const last_n = (params.last_n as number) || 10;
      const status = (params.status as string) || "all";

      let url = `/repos/${repo}/actions/runs?per_page=${last_n}`;
      if (status !== "all") url += `&status=${status}`;
      if (params.workflow_name) {
        // Get workflow ID first
        const workflows = await githubFetch(`/repos/${repo}/actions/workflows`) as { workflows: Array<{ id: number; name: string; path: string }> };
        const wf = workflows.workflows?.find(w => w.name === params.workflow_name || w.path.includes(params.workflow_name as string));
        if (wf) url = `/repos/${repo}/actions/workflows/${wf.id}/runs?per_page=${last_n}`;
      }

      const data = await githubFetch(url) as { workflow_runs: Array<Record<string, unknown>> };
      const runs = (data.workflow_runs || []).map(r => ({
        id: r.id,
        name: r.name,
        workflow_id: r.workflow_id,
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        commit: (r.head_sha as string)?.slice(0, 8),
        commit_message: (r.head_commit as Record<string, unknown>)?.message,
        triggered_by: (r.triggering_actor as Record<string, unknown>)?.login || (r.actor as Record<string, unknown>)?.login,
        created_at: r.created_at,
        updated_at: r.updated_at,
        run_duration_seconds: r.updated_at && r.created_at
          ? Math.round((new Date(r.updated_at as string).getTime() - new Date(r.created_at as string).getTime()) / 1000)
          : null,
        url: r.html_url,
      }));

      const failures = runs.filter(r => r.conclusion === "failure" || r.conclusion === "timed_out");

      return {
        repo,
        total_runs: runs.length,
        runs,
        failures,
        alerts: failures.length > 0 ? [`${failures.length} failed workflow runs in recent history`] : [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, repo, timestamp: new Date().toISOString() };
    }
  },

  get_recent_merges: async (args: unknown) => {
    const params = args as Record<string, unknown>;
    const repo = getRepo(params);
    if (!repo) return notConfigured();

    try {
      const last_hours = (params.last_hours as number) || 48;
      const base_branch = (params.base_branch as string) || "main";
      const since = new Date(Date.now() - last_hours * 3600 * 1000).toISOString();

      const data = await githubFetch(
        `/repos/${repo}/pulls?state=closed&base=${base_branch}&sort=updated&direction=desc&per_page=30`
      ) as Array<Record<string, unknown>>;

      const merged = data
        .filter(pr => pr.merged_at && new Date(pr.merged_at as string) > new Date(since))
        .map(pr => ({
          number: pr.number,
          title: pr.title,
          author: (pr.user as Record<string, unknown>)?.login,
          merged_at: pr.merged_at,
          merged_by: (pr.merged_by as Record<string, unknown>)?.login,
          sha: (pr.merge_commit_sha as string)?.slice(0, 8),
          changed_files: pr.changed_files,
          additions: pr.additions,
          deletions: pr.deletions,
          labels: ((pr.labels as Array<Record<string, unknown>>) || []).map(l => l.name),
          url: pr.html_url,
        }));

      // Flag high-risk merges
      const risky = merged.filter(pr =>
        (pr.changed_files as number) > 20 ||
        pr.labels?.includes("database") ||
        pr.labels?.includes("infrastructure") ||
        pr.title?.toString().toLowerCase().match(/migration|config|deploy|database|connection/)
      );

      return {
        repo,
        base_branch,
        hours_checked: last_hours,
        total_merged: merged.length,
        merges: merged,
        high_risk_merges: risky,
        alerts: risky.length > 0
          ? [`${risky.length} potentially risky PRs merged in last ${last_hours}h (database/infra/config changes)`]
          : [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, repo, timestamp: new Date().toISOString() };
    }
  },
};
