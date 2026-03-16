/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    AGENT_URL: process.env.AGENT_URL || "http://localhost:3002",
    MCP_URL: process.env.MCP_URL || "http://localhost:3001",
  },
};

module.exports = nextConfig;
