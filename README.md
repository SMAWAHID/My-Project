# AI DevOps Investigator 🔬

> AI-powered production incident investigation platform. Diagnose 500 errors, crashes, slow queries, and failed deployments using an AI agent that systematically investigates your infrastructure.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SYSTEM ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    HTTP     ┌──────────────┐    HTTP    ┌──────┐  │
│  │   Next.js    │ ──────────► │  AI Agent    │ ─────────► │ MCP  │  │
│  │  Frontend    │             │  Service     │            │Server│  │
│  │  :3000       │ ◄────────── │  :3002       │ ◄───────── │:3001 │  │
│  └──────────────┘  SSE/Poll   └──────┬───────┘            └──┬───┘  │
│                                      │                        │      │
│                               Claude API                 Tool calls  │
│                               (Anthropic)                     │      │
│                                                               │      │
│                                              ┌────────────────┼────┐ │
│                                              │ TOOLS          │    │ │
│                                              ├────────────────┤    │ │
│                                              │ 📋 Log Tools   │    │ │
│                                              │ 🖥 Infra Tools │    │ │
│                                              │ ⚙️  PM2 Tools   │    │ │
│                                              │ 🗄  DB Tools    │    │ │
│                                              │ 🚀 Deploy Tools│    │ │
│                                              └────────────────┘    │ │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Port | Tech | Purpose |
|-----------|------|------|---------|
| **Frontend** | 3000 | Next.js 14, TypeScript, TailwindCSS | Investigation dashboard |
| **Agent** | 3002 | Node.js, TypeScript, Anthropic SDK | AI investigator orchestrator |
| **MCP Server** | 3001 | Node.js, TypeScript, MCP SDK | Tool execution server |

---

## Project Structure

```
ai-devops-investigator/
├── frontend/                    # Next.js dashboard
│   ├── app/
│   │   ├── layout.tsx           # Root layout with fonts/theme
│   │   ├── page.tsx             # Main investigation dashboard
│   │   └── globals.css          # Design system CSS
│   ├── types/index.ts           # Shared TypeScript types
│   ├── lib/api.ts               # Agent API client
│   └── package.json
│
├── agent/                       # AI Investigator Service
│   ├── src/
│   │   ├── index.ts             # Express HTTP server
│   │   ├── investigator.ts      # Core AI agent loop
│   │   ├── types/index.ts       # TypeScript types
│   │   ├── prompts/system.ts    # System prompts for Claude
│   │   ├── utils/logger.ts      # Winston logger
│   │   └── examples/
│   │       └── investigation-flow.ts  # Documented example
│   └── package.json
│
├── mcp-server/                  # MCP Tool Server
│   ├── src/
│   │   ├── index.ts             # MCP + HTTP server
│   │   ├── utils/logger.ts
│   │   └── tools/
│   │       ├── logs/index.ts    # get_logs, search_logs, tail_logs, ...
│   │       ├── infrastructure/  # check_cpu, check_memory, ...
│   │       ├── pm2/             # get_pm2_status, get_pm2_logs, ...
│   │       ├── database/        # query_database, check_db_connections, ...
│   │       └── deployment/      # get_deployments, get_github_commits, ...
│   └── package.json
│
├── docker-compose.yml           # Full stack deployment
├── .env.example                 # Environment variables template
└── README.md
```

---

## Development Setup

This section covers running all three services locally for development with hot-reload.

### Prerequisites

Make sure you have these installed on your local machine:

```bash
node --version   # v20 or higher
npm --version    # v10 or higher
```

### Step 1 — Clone and install dependencies

```bash
git clone https://github.com/yourorg/ai-devops-investigator
cd ai-devops-investigator

# Install dependencies for all three workspaces at once
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in the required values. At minimum you need the Anthropic key to run the AI agent:

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Service ports (defaults work fine for local dev)
MCP_HTTP_PORT=3001
AGENT_PORT=3002

# URLs each service uses to reach the others
MCP_SERVER_URL=http://localhost:3001
NEXT_PUBLIC_AGENT_URL=http://localhost:3002
```

Everything else (AWS, GitHub, databases) is optional. Tools will return simulated data when credentials are not provided.

### Step 3 — Start all services

You need three separate terminal windows, one per service.

**Terminal 1 — MCP Tool Server**

```bash
cd mcp-server
npm run dev
# Listening on http://localhost:3001
# GET  /health  → health check
# GET  /tools   → lists all 27 tools
# POST /tools/:name → executes a tool
```

**Terminal 2 — AI Agent**

```bash
cd agent
npm run dev
# Listening on http://localhost:3002
# POST /investigations        → start investigation
# GET  /investigations/:id    → poll status
# POST /investigations/:id/tool-approval → approve/reject tool
```

**Terminal 3 — Next.js Frontend**

```bash
cd frontend
npm run dev
# Listening on http://localhost:3000
```

### Step 4 — Open the dashboard

Navigate to `http://localhost:3000` and type your first incident question:

> "Why is my FastAPI server returning 500 errors?"

> **Note:** The frontend works in demo mode even without the backend running. It renders a realistic mock investigation so you can explore the UI without any credentials.

### Step 5 — Verify each service is healthy

```bash
curl http://localhost:3001/health   # MCP Server
curl http://localhost:3002/health   # AI Agent
```

Both should return JSON with `"status": "healthy"`.

### Development tips

```bash
# Run all three services concurrently from the root (uses concurrently)
npm run dev

# Lint all workspaces
npm run lint

# Build all workspaces (checks TypeScript)
npm run build

# Test a specific tool directly without the UI
curl -X POST http://localhost:3001/tools/check_cpu_usage \
  -H "Content-Type: application/json" \
  -d '{}'

# Start an investigation from the CLI
curl -X POST http://localhost:3002/investigations \
  -H "Content-Type: application/json" \
  -d '{"incident_description": "Why is my API returning 500 errors?"}'
```

---

## Production Deployment on EC2 (Ubuntu + PM2)

This section covers a full production setup on a fresh AWS EC2 Ubuntu 22.04 instance using PM2 as the process manager, with Nginx as a reverse proxy.

### EC2 Instance Recommendations

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| Instance type | t3.small | t3.medium |
| RAM | 2 GB | 4 GB |
| Storage | 20 GB | 40 GB |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

Open these ports in your EC2 Security Group:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 22 | TCP | Your IP | SSH |
| 80 | TCP | 0.0.0.0/0 | HTTP (Nginx) |
| 443 | TCP | 0.0.0.0/0 | HTTPS (Nginx) |

Ports 3001 and 3002 should remain **closed** to the public — Nginx will proxy them internally.

---

### Step 1 — Connect and update the server

```bash
ssh -i your-key.pem ubuntu@YOUR_EC2_PUBLIC_IP

sudo apt update && sudo apt upgrade -y
```

---

### Step 2 — Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version   # v20.x.x
npm --version    # 10.x.x
```

---

### Step 3 — Install PM2 and Nginx globally

```bash
sudo npm install -g pm2

sudo apt install -y nginx

# Verify
pm2 --version
nginx -v
```

---

### Step 4 — Clone the project

```bash
cd /home/ubuntu
git clone https://github.com/yourorg/ai-devops-investigator
cd ai-devops-investigator
```

---

### Step 5 — Install dependencies and build all services

```bash
# Install all workspace dependencies
npm install

# Build MCP Server (TypeScript → dist/)
cd mcp-server && npm run build && cd ..

# Build AI Agent (TypeScript → dist/)
cd agent && npm run build && cd ..

# Build Next.js (creates .next/standalone)
cd frontend && npm run build && cd ..
```

---

### Step 6 — Configure production environment

```bash
cp .env.example .env
nano .env
```

Fill in all values for production:

```env
# ── Required ────────────────────────────────────────────────
NODE_ENV=production
ANTHROPIC_API_KEY=sk-ant-your-key-here

# ── Service config ───────────────────────────────────────────
MCP_HTTP_PORT=3001
AGENT_PORT=3002

# Internal URLs (services talk to each other on localhost)
MCP_SERVER_URL=http://localhost:3001
NEXT_PUBLIC_AGENT_URL=https://your-domain.com   # or http://YOUR_EC2_IP

# ── AWS CloudWatch ───────────────────────────────────────────
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# ── GitHub ───────────────────────────────────────────────────
GITHUB_TOKEN=ghp_...

# ── Databases (use read-only credentials) ───────────────────
POSTGRES_HOST=your-rds.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_DB=production
POSTGRES_USER=readonly_investigator
POSTGRES_PASSWORD=...

REDIS_HOST=your-elasticache.amazonaws.com
REDIS_PORT=6379

# ── Logging ──────────────────────────────────────────────────
LOG_LEVEL=info
```

---

### Step 7 — Create the PM2 ecosystem file

Create `ecosystem.config.js` in the project root:

```bash
nano /home/ubuntu/ai-devops-investigator/ecosystem.config.js
```

Paste the following:

```js
require('dotenv').config();

module.exports = {
  apps: [
    // ── MCP Tool Server ──────────────────────────────────────
    {
      name: 'mcp-server',
      script: './mcp-server/dist/index.js',
      cwd: '/home/ubuntu/ai-devops-investigator',
      instances: 1,
      exec_mode: 'fork',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        MCP_HTTP_PORT: 3001,
      },
      log_file: '/home/ubuntu/logs/mcp-server.log',
      out_file: '/home/ubuntu/logs/mcp-server-out.log',
      error_file: '/home/ubuntu/logs/mcp-server-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,
    },

    // ── AI Agent Service ─────────────────────────────────────
    {
      name: 'agent',
      script: './agent/dist/index.js',
      cwd: '/home/ubuntu/ai-devops-investigator',
      instances: 1,
      exec_mode: 'fork',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        AGENT_PORT: 3002,
        MCP_SERVER_URL: 'http://localhost:3001',
      },
      log_file: '/home/ubuntu/logs/agent.log',
      out_file: '/home/ubuntu/logs/agent-out.log',
      error_file: '/home/ubuntu/logs/agent-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '1G',
      restart_delay: 3000,
      max_restarts: 10,
    },

    // ── Next.js Frontend ─────────────────────────────────────
    {
      name: 'frontend',
      script: './frontend/.next/standalone/server.js',
      cwd: '/home/ubuntu/ai-devops-investigator',
      instances: 1,
      exec_mode: 'fork',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '0.0.0.0',
      },
      log_file: '/home/ubuntu/logs/frontend.log',
      out_file: '/home/ubuntu/logs/frontend-out.log',
      error_file: '/home/ubuntu/logs/frontend-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '512M',
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
```

---

### Step 8 — Create log directory and start PM2

```bash
mkdir -p /home/ubuntu/logs

# Start all three services
cd /home/ubuntu/ai-devops-investigator
pm2 start ecosystem.config.js

# Check all are running
pm2 status
```

You should see all three apps with status `online`:

```
┌────┬────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name       │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ mcp-server │ fork     │ 0    │ online    │ 0%       │ 45mb     │
│ 1  │ agent      │ fork     │ 0    │ online    │ 0%       │ 80mb     │
│ 2  │ frontend   │ fork     │ 0    │ online    │ 0%       │ 120mb    │
└────┴────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

---

### Step 9 — Save PM2 and enable on reboot

```bash
# Save the current process list
pm2 save

# Generate and install the systemd startup script
pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Run the command that pm2 outputs, it looks like:
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

PM2 will now automatically restart all three services if the EC2 instance reboots.

---

### Step 10 — Configure Nginx as a reverse proxy

```bash
sudo nano /etc/nginx/sites-available/ai-devops-investigator
```

Paste this configuration:

```nginx
server {
    listen 80;
    server_name your-domain.com;   # or your EC2 public IP

    # ── Frontend (Next.js) ─────────────────────────────────
    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # ── AI Agent API ────────────────────────────────────────
    location /api/agent/ {
        rewrite ^/api/agent/(.*)$ /$1 break;
        proxy_pass         http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;   # AI investigations can take time
    }

    # ── MCP Server (internal only, no public route) ────────
    # Port 3001 is NOT exposed publicly — agent calls it on localhost

    # ── Next.js static assets ──────────────────────────────
    location /_next/static/ {
        proxy_pass http://localhost:3000;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    client_max_body_size 10M;
    keepalive_timeout    65;
}
```

Enable the site and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/ai-devops-investigator \
           /etc/nginx/sites-enabled/

# Test the config for syntax errors
sudo nginx -t

# Reload
sudo systemctl reload nginx
sudo systemctl enable nginx
```

---

### Step 11 — (Optional) Enable HTTPS with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot --nginx -d your-domain.com

# Certbot auto-renews. Verify the timer is active:
sudo systemctl status certbot.timer
```

---

### Step 12 — Verify the full stack

```bash
# Check all PM2 processes
pm2 status

# Tail logs from all services at once
pm2 logs

# Tail a single service
pm2 logs mcp-server
pm2 logs agent
pm2 logs frontend

# Health checks
curl http://localhost:3001/health   # MCP Server
curl http://localhost:3002/health   # AI Agent
curl http://localhost:3000          # Frontend (HTML response)

# Nginx
sudo systemctl status nginx
```

Open your browser at `http://your-domain.com` (or your EC2 public IP) — the dashboard should load.

---

### PM2 Day-to-Day Commands

```bash
# View all processes
pm2 status

# Restart a single service (e.g. after a config change)
pm2 restart mcp-server
pm2 restart agent
pm2 restart frontend

# Restart all at once
pm2 restart all

# Zero-downtime reload (for the frontend)
pm2 reload frontend

# Stop everything
pm2 stop all

# View real-time logs
pm2 logs                     # all services
pm2 logs agent --lines 100   # last 100 lines for agent

# Monitor CPU/RAM in the terminal
pm2 monit

# View detailed info for one process
pm2 describe agent
```

---

### Deploying Updates

When you push a new version, run this on the EC2 instance:

```bash
cd /home/ubuntu/ai-devops-investigator

# Pull latest code
git pull origin main

# Reinstall dependencies (if package.json changed)
npm install

# Rebuild changed services
cd mcp-server && npm run build && cd ..
cd agent      && npm run build && cd ..
cd frontend   && npm run build && cd ..

# Restart all services with the new builds
pm2 restart all

# Confirm everything is still healthy
pm2 status
curl http://localhost:3001/health
curl http://localhost:3002/health
```

---

### Troubleshooting

**A service shows `errored` in pm2 status**

```bash
pm2 logs mcp-server --lines 50   # read the error
pm2 restart mcp-server           # attempt restart
```

**Frontend shows blank page**

```bash
# Check the standalone build exists
ls frontend/.next/standalone/server.js

# If missing, rebuild
cd frontend && npm run build
pm2 restart frontend
```

**Agent can't reach MCP Server**

```bash
# Confirm MCP is listening
curl http://localhost:3001/health

# Check the env var is correct
pm2 describe agent | grep MCP_SERVER_URL
# Should show http://localhost:3001
```

**Nginx returns 502 Bad Gateway**

```bash
# Check the upstream service is running
pm2 status

# Check Nginx error log
sudo tail -50 /var/log/nginx/error.log

# Reload Nginx after any config change
sudo nginx -t && sudo systemctl reload nginx
```

---

## MCP Tools Reference

### 📋 Log Tools
| Tool | Description | Key Args |
|------|-------------|----------|
| `get_logs` | Retrieve service logs | `service`, `last_minutes`, `log_level` |
| `search_logs` | Search for patterns | `pattern`, `service`, `last_hours` |
| `tail_logs` | Latest N log lines | `service`, `lines` |
| `get_cloudwatch_logs` | AWS CloudWatch | `log_group`, `filter_pattern` |
| `get_error_logs` | Error-only logs | `service`, `include_stack_traces` |

### 🖥️ Infrastructure Tools
| Tool | Description |
|------|-------------|
| `check_cpu_usage` | CPU utilization per core |
| `check_memory_usage` | RAM & swap stats |
| `check_disk_usage` | Filesystem usage |
| `check_system_load` | Load averages |
| `check_network_connections` | Active connections |
| `check_open_ports` | Listening ports |
| `list_running_processes` | Top processes |
| `get_uptime` | System uptime |

### ⚙️ PM2 Tools
| Tool | Description |
|------|-------------|
| `get_pm2_status` | Process status, restarts |
| `get_pm2_logs` | PM2 process logs |
| `get_pm2_restarts` | Crash history |

### 🗄️ Database Tools
| Tool | Description |
|------|-------------|
| `query_database` | SELECT-only queries |
| `check_db_connections` | Pool status |
| `get_slow_queries` | Slow query log |
| `check_db_size` | Table sizes |
| `check_db_locks` | Deadlocks, blocking |

### 🚀 Deployment Tools
| Tool | Description |
|------|-------------|
| `get_deployments` | Recent deploys |
| `get_github_commits` | Commit history |
| `get_github_actions_runs` | CI/CD runs |
| `get_recent_merges` | Merged PRs |

---

## Example Investigation

**Question:** "Why is my FastAPI server returning 500 errors?"

**AI Investigation Steps:**
1. 🧠 Form hypotheses (DB, OOM, crash, deployment)
2. 🔧 `get_error_logs(service="fastapi", last_minutes=30)` → 47 DB connection errors
3. 👁 Observation: asyncpg.TooManyConnectionsError dominant
4. 🔧 `check_db_connections(database_type="postgresql")` → 94/100 connections used
5. 💡 Hypothesis: Connection pool exhausted
6. 🔧 `get_deployments(service="fastapi-api")` → v2.4.7 deployed 28min ago
7. 🔧 `get_github_commits(repo="org/api")` → PR #847 changed connection.py
8. ✅ Root cause: Pool size reduced 20→5 per worker + connection leak

**Report:**
- **Root Cause:** PR #847 modified connection pool config
- **Confidence:** 91%
- **Immediate Fix:** `pm2 deploy production revert`
- **Long-term:** Add PgBouncer, increase max_connections

---

## Safety Design

The system is designed with strict **READ-ONLY** constraints:

- ✅ All MCP tools are read-only
- ✅ `query_database` rejects non-SELECT statements
- ✅ AI cannot execute tools without user approval
- ✅ Every tool call is logged
- ✅ No write access to any system
- ✅ No SSH, no shell execution without explicit policy

---

## Connecting Real Infrastructure

### PostgreSQL
```env
POSTGRES_HOST=your-rds-endpoint.amazonaws.com
POSTGRES_USER=readonly_user
POSTGRES_PASSWORD=secure_password
POSTGRES_DB=production
```

### AWS CloudWatch
```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Create an IAM user with CloudWatch read-only permissions:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:DescribeLogGroups"
    ],
    "Resource": "*"
  }]
}
```

### GitHub
```env
GITHUB_TOKEN=ghp_your_fine_grained_token
```

---

## Future Improvements

| Feature | Priority | Effort |
|---------|----------|--------|
| Server-Sent Events for real-time updates | High | Low |
| Investigation persistence (PostgreSQL) | High | Medium |
| Postmortem auto-generation (PDF) | Medium | Medium |
| Slack/PagerDuty integration | Medium | Medium |
| Custom investigation patterns/playbooks | Medium | High |
| Multi-environment support | Low | Medium |
| Grafana/Datadog metrics integration | Low | Medium |
| Investigation replay/sharing | Low | Low |

---

## License

MIT
