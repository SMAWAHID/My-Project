/**
 * EXAMPLE INVESTIGATION FLOW
 * ==========================
 * 
 * Scenario: "Why is my FastAPI server returning 500 errors?"
 * 
 * This file documents the complete conversation between the
 * frontend, agent, and MCP server during a real investigation.
 */

// ─── Step 1: User submits incident ───────────────────────────────────────
const incidentRequest = {
  incident_description: "Why is my FastAPI server returning 500 errors?",
  context: {
    service: "fastapi",
    environment: "production",
    time_range_minutes: 60,
    known_symptoms: [
      "500 errors started ~30 minutes ago",
      "Users cannot checkout",
      "Sentry showing 'asyncpg.TooManyConnectionsError'"
    ]
  }
};

// ─── Step 2: Agent sends to Claude with system prompt ────────────────────
// Claude receives: DEVOPS_INVESTIGATOR_SYSTEM_PROMPT + incident description
// Claude forms hypotheses:
//   1. DB connection pool exhausted (high probability given Sentry error)
//   2. Application crash/OOM (medium)
//   3. Infrastructure overload (low)
//   4. Bad deployment (medium)

// ─── Step 3: Claude requests first tool ──────────────────────────────────
const toolRequest1 = {
  name: "get_error_logs",
  input: {
    service: "fastapi",
    last_minutes: 30,
    include_stack_traces: true
  }
};
// Agent sends to frontend: "Waiting for approval"
// Frontend shows: ToolApprovalPanel

// User approves → Agent calls MCP server:
// POST http://localhost:3001/tools/get_error_logs
// Body: { service: "fastapi", last_minutes: 30, include_stack_traces: true }

// MCP Server response:
const errorLogResult = {
  service: "fastapi",
  error_count: 47,
  errors: [
    {
      timestamp: "2024-01-15T14:03:12Z",
      level: "ERROR",
      message: "asyncpg.exceptions.TooManyConnectionsError: remaining connection slots are reserved for non-replication superuser connections",
      stack_trace: `Traceback (most recent call last):
  File "/app/api/routes/checkout.py", line 45, in checkout
    conn = await db_pool.acquire(timeout=30)
asyncio.exceptions.TimeoutError: pool connection timeout after 30s`,
      occurrences: 47,
      first_seen: "2024-01-15T14:03:12Z"
    }
  ]
};

// ─── Step 4: Claude analyzes, requests next tool ─────────────────────────
// Claude observation: "DB connection errors confirmed. Now check pool status."

const toolRequest2 = {
  name: "check_db_connections",
  input: { database_type: "postgresql", include_per_database: true }
};

// MCP Server response:
const dbConnectionResult = {
  max_connections: 100,
  current_connections: 94,
  active_queries: 23,
  idle_in_transaction: 12,
  waiting_connections: 14,
  connection_utilization_percent: 94,
  alerts: [
    "CRITICAL: 94% of max connections in use (94/100)",
    "12 connections idle in transaction (connection leak suspected)",
    "14 queries waiting for connections"
  ]
};

// ─── Step 5: Claude checks deployment ────────────────────────────────────
const toolRequest3 = {
  name: "get_deployments",
  input: { service: "fastapi-api", last_n: 5, include_rollbacks: true }
};

const deploymentResult = {
  deployments: [
    {
      id: "deploy-2024-0847",
      version: "v2.4.7",
      deployed_at: "2024-01-15T13:58:00Z",  // 5 minutes before errors!
      deployed_by: "ci-cd-bot",
      status: "success",
      commit_message: "feat: add bulk order processing endpoint",
      changed_files: ["api/routes/orders.py", "api/db/connection.py"],  // ← connection.py changed!
      health_check_after: "failed",
      note: "Deployment succeeded but health checks failed 3 minutes after"
    }
  ],
  correlation: "Errors began 3 minutes after v2.4.7 deployment. LIKELY ROOT CAUSE."
};

// ─── Step 6: Claude checks the commit diff ───────────────────────────────
const toolRequest4 = {
  name: "get_github_commits",
  input: { repo: "myorg/fastapi-service", branch: "main", last_n: 3 }
};

const commitResult = {
  commits: [
    {
      sha: "a3f9b2c",
      message: "feat: add bulk order processing endpoint",
      changed_files: ["api/db/connection.py"],
      risk_assessment: "HIGH: Modified db/connection.py - connection pool max_size changed from 20 to 5",
      pr_number: 847,
      pr_title: "Bulk Order Processing API"
    }
  ]
};

// ─── Step 7: Claude generates root cause report ───────────────────────────
const finalReport = {
  summary: "PostgreSQL connection pool exhausted after v2.4.7 reduced pool size from 20 to 5 per worker",
  root_cause: "PR #847 modified api/db/connection.py, changing max_pool_size from 20 to 5 per uvicorn worker. With 4 workers, total connections = 20, but 12 leaked as idle-in-transaction sessions, exhausting PostgreSQL's max_connections=100 within minutes of deployment.",
  contributing_factors: [
    "Connection pool max_size reduced: 20 → 5 per worker in v2.4.7",
    "Missing async context manager in new bulk order endpoint causing connection leaks",
    "PostgreSQL max_connections=100 is insufficient for production workload",
    "No connection pool monitoring or alerting in place"
  ],
  confidence: 91,
  severity: "critical",
  timeline_of_events: [
    "13:58 - v2.4.7 deployed (changed connection pool settings)",
    "14:01 - DB connections climb: 60 → 80",
    "14:03 - First 500 errors appear",
    "14:07 - Connections hit 94/100 — cascade failure",
    "14:15 - PagerDuty fires, incident declared",
    "14:28 - AI investigation started",
    "14:35 - Root cause identified"
  ],
  suggested_fixes: [
    {
      title: "IMMEDIATE: Rollback v2.4.7",
      priority: "immediate",
      effort: "low",
      risk: "safe",
      commands: [
        "pm2 deploy ecosystem.config.js production revert",
        "# OR manually:",
        "git revert a3f9b2c && git push origin main"
      ]
    },
    {
      title: "Fix connection leak in bulk order endpoint",
      priority: "immediate",
      effort: "low",
      risk: "safe",
      description: "Use 'async with db_pool.acquire() as conn:' pattern instead of manual acquire/release"
    },
    {
      title: "Restore pool size and add pgbouncer",
      priority: "short_term",
      effort: "medium",
      risk: "safe",
      commands: [
        "# Restore in connection.py:",
        "max_size=20  # per worker",
        "",
        "# Install PgBouncer:",
        "sudo apt install pgbouncer",
        "sudo systemctl enable pgbouncer pgbouncer.service"
      ]
    },
    {
      title: "Increase max_connections and add monitoring",
      priority: "short_term",
      effort: "low",
      risk: "medium",
      commands: [
        "# In postgresql.conf:",
        "max_connections = 200",
        "# Requires PostgreSQL restart"
      ]
    }
  ],
  immediate_actions: [
    "Rollback v2.4.7 to v2.4.6 NOW to restore service",
    "Manually terminate idle-in-transaction sessions",
    "Page DBA to monitor connection recovery"
  ],
  postmortem_notes: "This incident was caused by an under-reviewed connection pool configuration change. Recommend: (1) Add automated tests that validate connection pool config, (2) Add deployment health checks that verify DB connection count stays within safe bounds, (3) Add Grafana alert for DB connections > 70%."
};

export { incidentRequest, finalReport };
