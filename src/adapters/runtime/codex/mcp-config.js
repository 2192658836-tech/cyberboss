const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");

function resolveCodexProjectToolMcpServerConfig({ cyberbossHome = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
  };
}

function resolveCodexMcpServerConfigs({ cyberbossHome = "", env = process.env } = {}) {
  const configs = [];
  const projectConfig = resolveCodexProjectToolMcpServerConfig({
    cyberbossHome: cyberbossHome || env.CYBERBOSS_HOME,
  });
  if (projectConfig) {
    configs.push(projectConfig);
  }
  const script = normalizeNonEmptyString(env.CYBERBOSS_ARONG_MEMORY_SCRIPT);
  if (script) {
    const ownerId = normalizeNonEmptyString(env.CYBERBOSS_ARONG_MEMORY_OWNER_ID);
    if (!ownerId) {
      throw new Error("CYBERBOSS_ARONG_MEMORY_OWNER_ID is required when CYBERBOSS_ARONG_MEMORY_SCRIPT is configured");
    }
    configs.push({
      name: "arong_memory",
      command: normalizeNonEmptyString(env.CYBERBOSS_ARONG_MEMORY_COMMAND) || "node",
      args: [script],
      env: { OWNER_ID: ownerId },
    });
  }
  return configs;
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  const configs = Array.isArray(mcpServerConfig) ? mcpServerConfig : [mcpServerConfig];
  return configs.flatMap(buildSingleServerConfigArgs);
}

function buildSingleServerConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
    return [];
  }
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "cyberboss_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = Array.isArray(mcpServerConfig.args)
    ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  if (!command) {
    return [];
  }
  const configArgs = [
    "-c",
    `mcp_servers.${name}.command=${quoteTomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${formatTomlArray(args)}`,
  ];
  for (const [key, value] of Object.entries(mcpServerConfig.env || {})) {
    const envKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteTomlString(key);
    configArgs.push("-c", `mcp_servers.${name}.env.${envKey}=${quoteTomlString(value)}`);
  }
  for (const toolName of name === "cyberboss_tools" ? listProjectToolNames() : []) {
    configArgs.push(
      "-c",
      `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
  resolveCodexMcpServerConfigs,
};
