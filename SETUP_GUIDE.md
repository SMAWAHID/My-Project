# AI DevOps Investigator — Complete Setup Guide

How to connect real AWS CloudWatch logs, PostgreSQL, GitHub, and run the system locally or on a server.

---

## Table of Contents

1. [What You Need](#prerequisites)
2. [Quick Start (Demo Mode — no credentials needed)](#quick-start)
3. [Connecting Real AWS CloudWatch Logs](#aws-cloudwatch)
4. [Connecting a Real PostgreSQL / RDS Database](#postgresql)
5. [Connecting GitHub](#github)
6. [Reading Local / EC2 Server Logs](#local-logs)
7. [Running on an EC2 Server (Production)](#ec2-production)
8. [Full .env Reference](#env-reference)
9. [Testing Each Integration](#testing)
10. [Troubleshooting](#troubleshooting)

---

## 1. What You Need {#prerequisites}

**Required:**
- Node.js 20+ (`node --version`)
- A Groq API key (free) OR Anthropic API key — [console.groq.com](https://console.groq.com) or [console.anthropic.com](https://console.anthropic.com)

**Optional (for real data):**
- AWS credentials with CloudWatch Logs read access
- PostgreSQL database credentials
- GitHub personal access token

---

## 2. Quick Start (Demo Mode) {#quick-start}

No AWS keys needed — runs on mock data so you can see the full AI investigation flow immediately.

```bash
# 1. Clone / unzip the project
cd ai-devops-investigator

# 2. Copy the example env file
cp .env.example .env

# 3. Add your Groq or Anthropic key
notepad .env          # Windows
nano .env             # Mac / Linux

# Paste one of these:
GROQ_API_KEY=gsk_xxxxxxxxxxxxx
# OR
ANTHROPIC_API_KEY=sk-ant-xxxxx

# 4. Install dependencies
npm install

# 5. Run all three services
npm run dev
```

Open http://localhost:3000 — the app is running.

Ask it: "Why is my FastAPI server returning 500 errors?" and it will run a demo investigation using mock data.

---

## 3. Connecting Real AWS CloudWatch Logs {#aws-cloudwatch}

### Step 1 — Create an IAM user with read-only CloudWatch access

Go to AWS Console → IAM → Users → Create User

Attach this inline policy (minimum required permissions):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents"
      ],
      "Resource": "*"
    }
  ]
}
```

Or attach the AWS managed policy `CloudWatchLogsReadOnlyAccess`.

After creating the user, go to **Security Credentials → Access Keys → Create Access Key**.
Choose "Application running outside AWS". Copy both the **Access Key ID** and **Secret Access Key**.

### Step 2 — Add credentials to your .env file

```bash
AWS_REGION=us-east-1                          # your region (us-east-1, eu-west-1, etc.)
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

### Step 3 — Find your log group names

In AWS Console → CloudWatch → Log Groups — copy the exact log group name.

Common patterns:
| Service | Typical Log Group |
|---------|-------------------|
| ECS Fargate | `/ecs/my-service-name` |
| Lambda | `/aws/lambda/my-function-name` |
| EC2 with CloudWatch Agent | `/var/log/app/api` (custom) |
| Elastic Beanstalk | `/aws/elasticbeanstalk/env-name/var/log/eb-activity.log` |
| EKS | `/aws/eks/my-cluster/application` |
| API Gateway | `API-Gateway-Execution-Logs_xxxxx/prod` |
| RDS PostgreSQL | `/aws/rds/instance/my-db/postgresql` |

### Step 4 — Ask the AI to investigate

Start the app and ask:

> "My Lambda function /aws/lambda/payment-processor is throwing errors — why?"

The AI will automatically call `get_cloudwatch_logs` with your log group and show you real log data.

Or ask the AI to use a specific log group:

> "Check CloudWatch log group /ecs/api-service for errors in the last 30 minutes"

### Using AWS Profiles (alternative to keys)

If you already have `~/.aws/credentials` configured:

```bash
# In .env, set just this (leave KEY/SECRET blank):
AWS_PROFILE=production
AWS_REGION=us-east-1
```

---

## 4. Connecting a Real PostgreSQL / RDS Database {#postgresql}

### Local PostgreSQL

```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=myapp_production
POSTGRES_USER=readonly_user
POSTGRES_PASSWORD=yourpassword
```

### AWS RDS

1. Go to RDS Console → your database → **Connectivity & security**
2. Copy the **Endpoint** (looks like: `mydb.abc123.us-east-1.rds.amazonaws.com`)
3. Make sure your security group allows inbound on port 5432 from your IP

```bash
POSTGRES_HOST=mydb.abc123.us-east-1.rds.amazonaws.com
POSTGRES_PORT=5432
POSTGRES_DB=production
POSTGRES_USER=app_user
POSTGRES_PASSWORD=your-rds-password
```

### Create a read-only database user (recommended)

Connect to your DB as admin and run:

```sql
-- Create read-only user
CREATE USER devops_investigator WITH PASSWORD 'strong-random-password';

-- Grant read access to your database
GRANT CONNECT ON DATABASE production TO devops_investigator;
GRANT USAGE ON SCHEMA public TO devops_investigator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO devops_investigator;

-- For future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
  GRANT SELECT ON TABLES TO devops_investigator;
```

The tool enforces SELECT-only at application level too — writes are blocked even if the user has write permissions.

### What the database tools do with real credentials

- `check_db_connections` — queries `pg_stat_activity` to show live connection counts
- `get_slow_queries` — queries `pg_stat_activity` and `pg_stat_statements` for slow queries
- `check_db_locks` — queries `pg_locks` to find blocked/blocking queries
- `check_db_size` — queries `pg_database_size` and `pg_relation_size` for table sizes
- `query_database` — runs any SELECT you give it directly

---

## 5. Connecting GitHub {#github}

### Create a Personal Access Token

1. Go to github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. Set expiration (90 days recommended for dev use)
3. Under **Repository permissions**, grant:
   - **Contents**: Read-only
   - **Actions**: Read-only
   - **Deployments**: Read-only
   - **Pull requests**: Read-only

```bash
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
GITHUB_REPO=myorg/my-api-repo           # your main repo (owner/repo format)
```

### What GitHub tools do with real credentials

- `get_github_commits` — fetches real commits, flags ones touching config/db/deploy files
- `get_github_actions_runs` — shows real CI/CD workflow run history and failures
- `get_recent_merges` — finds PRs merged in the last 48h, flags high-risk ones
- `get_deployments` — reads GitHub Deployments API (if you use it)

### Test it

Ask: "What was deployed in the last 24 hours?"

The AI will call `get_github_commits` on your repo and `get_github_actions_runs` to correlate deploys with issues.

---

## 6. Reading Local / EC2 Server Logs {#local-logs}

If you run the MCP server **on the same EC2 instance** as your application, it can read log files directly from disk.

### Configure log paths

```bash
LOG_BASE_PATH=/var/log           # Default. Directory where service logs live.
PM2_LOG_PATH=/root/.pm2/logs    # PM2 log directory
```

### Typical log file locations

| Service | Log path |
|---------|----------|
| PM2 app named "api" | `/root/.pm2/logs/api-out.log`, `/root/.pm2/logs/api-error.log` |
| Nginx | `/var/log/nginx/access.log`, `/var/log/nginx/error.log` |
| PostgreSQL | `/var/log/postgresql/postgresql-14-main.log` |
| System | `/var/log/syslog`, `/var/log/messages` |
| Custom app | `/var/log/myapp/app.log` |

### The AI will look in these paths automatically

When you ask "check logs for my api service", the tool checks:
- `/var/log/api/api.log`
- `/var/log/api/app.log`
- `/var/log/api/error.log`
- `/root/.pm2/logs/api-out.log`
- `/root/.pm2/logs/api-error.log`

If none of those match, use `search_logs` and specify the pattern.

### Run MCP server on the same machine as your app

For best results, run all three services (frontend, agent, mcp-server) on the EC2 machine where your application runs. The MCP server needs local filesystem access to read logs.

---

## 7. Running on an EC2 Server (Production) {#ec2-production}

### Recommended server specs

| Load | Instance type | Note |
|------|--------------|-------|
| Personal / small team | t3.small (2GB RAM) | Minimum |
| Team use | t3.medium (4GB RAM) | Recommended |
| Heavy usage | t3.large (8GB RAM) | For many concurrent investigations |

### Security Group rules

| Type | Port | Source | Purpose |
|------|------|--------|---------|
| HTTP | 80 | 0.0.0.0/0 | Web UI access |
| HTTPS | 443 | 0.0.0.0/0 | Web UI (with SSL) |
| SSH | 22 | Your IP only | Server management |
| Custom TCP | 3001 | 127.0.0.1 | MCP server (localhost only) |
| Custom TCP | 3002 | 127.0.0.1 | Agent (localhost only) |

**Important:** 3001 and 3002 should NOT be publicly accessible. Only expose port 80/443 via Nginx.

### Install and deploy

```bash
# 1. SSH into your EC2 instance
ssh -i your-key.pem ubuntu@your-ec2-ip

# 2. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Install PM2 and Nginx
sudo npm install -g pm2
sudo apt-get install -y nginx

# 4. Clone your project
git clone https://github.com/yourorg/ai-devops-investigator.git
cd ai-devops-investigator

# 5. Create .env from example
cp .env.example .env
nano .env    # Fill in your API keys and credentials

# 6. Install dependencies
npm install

# 7. Build all packages
npm run build

# 8. Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup     # Follow the printed command to enable auto-start on reboot
```

### Configure Nginx as reverse proxy

```bash
sudo nano /etc/nginx/sites-available/devops-ai
```

Paste this config (replace `your-domain.com` or use your IP):

```nginx
server {
    listen 80;
    server_name your-domain.com;   # or _ for any hostname

    # Frontend (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    # Agent API (for frontend to call)
    location /api/agent/ {
        proxy_pass http://127.0.0.1:3002/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/devops-ai /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Add HTTPS (free with Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```

Certbot automatically renews every 90 days.

### Update the app after code changes

```bash
cd ai-devops-investigator
git pull
npm install
npm run build
pm2 restart all
```

---

## 8. Full .env Reference {#env-reference}

```bash
# ─── AI — pick ONE ────────────────────────────────────────────────────────────
GROQ_API_KEY=gsk_xxxxxxxxxx           # Free at console.groq.com (recommended)
# OR
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxx   # Paid at console.anthropic.com

# ─── Service URLs ─────────────────────────────────────────────────────────────
MCP_SERVER_URL=http://localhost:3001
AGENT_URL=http://localhost:3002
NEXT_PUBLIC_AGENT_URL=http://localhost:3002   # On EC2 with Nginx: http://your-domain.com/api/agent

# ─── AWS CloudWatch ───────────────────────────────────────────────────────────
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# AWS_SESSION_TOKEN=                  # Only needed for temporary credentials
# AWS_PROFILE=production              # Alternative to KEY/SECRET if using ~/.aws/credentials

# ─── GitHub ───────────────────────────────────────────────────────────────────
GITHUB_TOKEN=github_pat_xxxxxxxxxx
GITHUB_REPO=myorg/my-api-repo         # Default repo for commit/action queries

# ─── PostgreSQL / RDS ─────────────────────────────────────────────────────────
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=production
POSTGRES_USER=devops_investigator
POSTGRES_PASSWORD=strong-password-here

# ─── Log file paths ───────────────────────────────────────────────────────────
LOG_BASE_PATH=/var/log
PM2_LOG_PATH=/root/.pm2/logs

# ─── Port config ──────────────────────────────────────────────────────────────
MCP_HTTP_PORT=3001
AGENT_PORT=3002
```

---

## 9. Testing Each Integration {#testing}

Once the app is running (`npm run dev`), use these prompts to verify each integration:

### Test AWS CloudWatch

> "Check CloudWatch log group /ecs/my-service for errors in the last 15 minutes"

Expected: Real CloudWatch events or a clear "credentials not configured" message if keys are missing.

### Test PostgreSQL

> "How many active database connections are there right now?"

Expected: Real connection counts from `pg_stat_activity` or "not configured" with setup instructions.

### Test GitHub

> "What commits were pushed to main in the last 24 hours?"

Expected: Real commit list or "not configured" with setup steps.

### Test local logs

> "Show me the last 50 lines of nginx error logs"

Expected: Real lines from `/var/log/nginx/error.log` if running on the same machine.

### Full integration test

> "Our API started throwing 500 errors 20 minutes ago — investigate everything"

The AI will pull from all configured sources simultaneously.

---

## 10. Troubleshooting {#troubleshooting}

### "AWS credentials not configured"
- Check `.env` has `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
- Restart services after editing `.env`: `pm2 restart all` or re-run `npm run dev`
- Verify the IAM user has `CloudWatchLogsReadOnlyAccess` or the inline policy above

### "No log files found for service X"
- The MCP server needs to run on the same machine as your app to read disk logs
- Check `LOG_BASE_PATH` and `PM2_LOG_PATH` in `.env`
- Use `get_cloudwatch_logs` instead if your app sends logs to CloudWatch

### "GitHub API 404 Not Found"
- Check `GITHUB_REPO` is in `owner/repo` format (e.g. `mycompany/api-server`)
- Check your token has `repo` read permissions
- For private repos, token must be from an account with repo access

### "PostgreSQL connection refused"
- Confirm `POSTGRES_HOST` — for RDS use the full endpoint, not `localhost`
- Check RDS security group allows inbound from your EC2 instance's IP
- Test connectivity: `psql -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB`

### Agent not responding (502 on EC2)
- Check all three PM2 processes are running: `pm2 status`
- Check agent logs: `pm2 logs agent`
- Verify Nginx is proxying correctly: `sudo nginx -t`

### Build errors on Windows
- Fix 1 (path errors in imports): Change `../types/index.js` → `./types/index.js` in `agent/src/investigator.ts`
- Fix 2 (tsconfig): Add `"baseUrl": "."` and `"paths": { "@/*": ["./*"] }` to `frontend/tsconfig.json`
- Fix 3 (node_modules locked): Run PowerShell as Admin, then `Remove-Item -Recurse -Force node_modules && npm install`

### GROQ_API_KEY missing error
- Make sure `.env` is in the ROOT folder (ai-devops-investigator/.env), not inside agent/ or frontend/
- Restart dev server after editing `.env`

