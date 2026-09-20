const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { buildCodexMcpConfigArgs, resolveCodexMcpServerConfigs, resolveCodexProjectToolMcpServerConfig } = require("../src/adapters/runtime/codex/mcp-config");
const root = path.resolve(__dirname, "..");
const env = {
  CYBERBOSS_ARONG_MEMORY_SCRIPT: 'F:\\fixture folder\\mcp\\main.js',
  CYBERBOSS_ARONG_MEMORY_OWNER_ID: 'test_owner',
};
function load(relative, mocks = {}, processOverride = process) {
  const filename = path.join(root, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name),
    module, exports: module.exports, __dirname: path.dirname(filename), process: processOverride,
    Buffer, setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}
function assertBoth(args) {
  assert.ok(args.includes('mcp_servers.arong_memory.command="node"'));
  assert.ok(args.includes(`mcp_servers.arong_memory.args=[${JSON.stringify(env.CYBERBOSS_ARONG_MEMORY_SCRIPT)}]`));
  assert.ok(args.includes('mcp_servers.arong_memory.env.OWNER_ID="test_owner"'));
  assert.ok(args.some((arg) => arg.startsWith('mcp_servers.cyberboss_tools.command=')));
  assert.ok(args.some((arg) => arg.startsWith('mcp_servers.cyberboss_tools.tools.')));
  assert.ok(!args.some((arg) => arg.startsWith('mcp_servers.arong_memory.tools.')));
  assert.ok(!args.some((arg) => arg.startsWith('mcp_servers.cyberboss_tools.env.OWNER_ID=')));
}
test("resolver preserves Cyberboss and enables Arong only from environment", () => {
  const legacy = resolveCodexProjectToolMcpServerConfig({ cyberbossHome: root });
  assert.deepEqual(resolveCodexMcpServerConfigs({ cyberbossHome: root, env: {} }), [legacy]);
  const configs = resolveCodexMcpServerConfigs({ cyberbossHome: root, env });
  assert.deepEqual(configs[0], legacy);
  assert.deepEqual(configs[1], { name: "arong_memory", command: "node", args: [env.CYBERBOSS_ARONG_MEMORY_SCRIPT], env: { OWNER_ID: "test_owner" } });
  assert.equal(env.OWNER_ID, undefined);
  assert.equal(resolveCodexMcpServerConfigs({ cyberbossHome: root, env: { ...env, CYBERBOSS_ARONG_MEMORY_COMMAND: "custom-node" } })[1].command, "custom-node");
  assert.throws(() => resolveCodexMcpServerConfigs({ env: { CYBERBOSS_ARONG_MEMORY_SCRIPT: "main.js" } }), /OWNER_ID is required/);
});
test("config builder accepts legacy objects and arrays, isolates approvals and escapes env", () => {
  const legacy = resolveCodexProjectToolMcpServerConfig({ cyberbossHome: root });
  assert.deepEqual(buildCodexMcpConfigArgs(legacy), buildCodexMcpConfigArgs([legacy]));
  assert.deepEqual(buildCodexMcpConfigArgs(null), []);
  assert.deepEqual(buildCodexMcpConfigArgs([]), []);
  assert.deepEqual(buildCodexMcpConfigArgs([null, false, {}, { command: "" }]), []);
  assertBoth(buildCodexMcpConfigArgs(resolveCodexMcpServerConfigs({ cyberbossHome: root, env })));
  const value = 'a "quote"\\path\nnext';
  assert.ok(buildCodexMcpConfigArgs({ name: "arong_memory", command: "node", env: { OWNER_ID: value } }).includes(`mcp_servers.arong_memory.env.OWNER_ID=${JSON.stringify(value)}`));
  assert.deepEqual(buildCodexMcpConfigArgs({ ...legacy, name: undefined }), buildCodexMcpConfigArgs(legacy));
});
test("adapter and RPC spawn pass both MCP servers without global OWNER_ID", async () => {
  let captured;
  const fakeProcess = { env: { ...env }, execPath: process.execPath };
  const rpc = load("src/adapters/runtime/codex/rpc-client.js", {
    child_process: { spawn(command, args, options) {
      captured = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      return child;
    } },
  });
  const adapterModule = load("src/adapters/runtime/codex/index.js", {
    "./rpc-client": rpc,
    "./session-store": { SessionStore: class {} },
    "./mcp-config": { resolveCodexMcpServerConfigs: () => resolveCodexMcpServerConfigs({ cyberbossHome: root, env: fakeProcess.env }) },
  }, fakeProcess);
  const client = adapterModule.createCodexRuntimeAdapter({}).createClient();
  await client.connectSpawn();
  assertBoth(captured.args);
  assert.equal(captured.args.at(-1), "app-server");
  assert.equal(captured.options.env.OWNER_ID, undefined);
  const legacy = resolveCodexProjectToolMcpServerConfig({ cyberbossHome: root });
  await new rpc.CodexRpcClient({ mcpServerConfig: legacy, env: {} }).connectSpawn();
  assert.ok(captured.args.includes(buildCodexMcpConfigArgs(legacy)[1]));
});
for (const platform of ["win32", "linux"]) {
test(`shared startup on ${platform} preserves MCP arguments and reuses ready servers`, async () => {
  let captured;
  let ready = false;
  const fakeProcess = { env: { ...env }, platform, cwd: () => root, kill() {} };
  const shared = load("scripts/shared-common.js", {
    dotenv: { config() {} },
    fs: { mkdirSync() {}, readFileSync() { throw new Error("missing pid"); }, openSync() { return 1; }, writeFileSync() {} },
    http: { get(options, callback) {
      queueMicrotask(() => callback({ statusCode: ready ? 200 : 503, resume() {} }));
      return new EventEmitter();
    } },
    child_process: { spawn(command, args, options) {
      captured = { command, args, options };
      ready = true;
      return { pid: 123, unref() {} };
    } },
    "../src/adapters/runtime/codex/mcp-config": {
      buildCodexMcpConfigArgs,
      resolveCodexMcpServerConfigs: (options) => resolveCodexMcpServerConfigs({ ...options, env: fakeProcess.env }),
    },
  }, fakeProcess);
  assert.equal((await shared.ensureSharedAppServer()).status, "started");
  assertBoth(captured.args);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.detached, true);
  const expectedArgs = [
    ...buildCodexMcpConfigArgs(resolveCodexMcpServerConfigs({ cyberbossHome: root, env })),
    "app-server", "--listen", shared.listenUrl,
  ];
  assert.equal(captured.command, platform === "win32" ? "cmd.exe" : "codex");
  assert.deepEqual(Array.from(captured.args), platform === "win32" ? ["/c", "codex", ...expectedArgs] : expectedArgs);
  if (platform === "win32" && process.platform === "win32") {
    // Exercise Windows argument parsing with an argv recorder, never Codex.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-argv-"));
    try {
      const recorder = path.join(fixtureDir, "record args.js");
      fs.writeFileSync(recorder, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const shim = path.join(fixtureDir, "codex.cmd");
      fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
      for (const launcher of [[process.execPath, recorder], [shim]]) {
        const result = spawnSync(captured.command, ["/c", ...launcher, ...captured.args.slice(2)], {
          shell: captured.options.shell, windowsHide: captured.options.windowsHide, encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.deepEqual(JSON.parse(result.stdout), expectedArgs);
      }
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  }
  assert.equal(captured.args.slice(-3).join(" "), `app-server --listen ${shared.listenUrl}`);
  assert.equal(captured.options.env.OWNER_ID, undefined);
  captured = null;
  assert.equal((await shared.ensureSharedAppServer()).status, "already_running_unknown_pid");
  assert.equal(captured, null);
  fakeProcess.env.CYBERBOSS_RUNTIME = "claudecode";
  assert.equal((await shared.ensureSharedAppServer()).status, "skipped");
});
}
