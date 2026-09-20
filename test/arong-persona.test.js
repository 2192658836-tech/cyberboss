const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { loadWechatInstructions, buildInstructionRefreshText } = require("../src/adapters/runtime/shared-instructions");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arong-persona-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { arongPersonaFile: path.join(dir, "persona.md"), weixinInstructionsFile: path.join(dir, "default.md"), weixinOperationsFile: path.join(dir, "operations.md"), sessionsFile: path.join(dir, "sessions.json"), userGender: "male" };
  fs.writeFileSync(config.arongPersonaFile, "阿嵘 persona 她 {{USER_NAME}}");
  fs.writeFileSync(config.weixinInstructionsFile, "DEFAULT PERSONA");
  fs.writeFileSync(config.weixinOperationsFile, "OPERATIONS");
  return config;
}
test("external persona replaces default, preserves raw text and includes operations", (t) => {
  const config = fixture(t);
  assert.equal(loadWechatInstructions(config), "阿嵘 persona 她 {{USER_NAME}}\n\nOPERATIONS");
  assert.equal(loadWechatInstructions({ ...config, arongPersonaFile: "" }), "DEFAULT PERSONA\n\nOPERATIONS");
});
test("missing, unreadable and empty persona report errors instead of falling back", (t) => {
  const config = fixture(t);
  assert.throws(() => loadWechatInstructions({ ...config, arongPersonaFile: path.join(path.dirname(config.arongPersonaFile), "missing.md") }), /CYBERBOSS_ARONG_PERSONA_FILE/);
  fs.writeFileSync(config.arongPersonaFile, " \n\t");
  assert.throws(() => loadWechatInstructions(config), /is empty/);
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    if (file === config.arongPersonaFile) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original.call(this, file, ...args);
  });
  assert.throws(() => loadWechatInstructions(config), /Cannot read.*permission denied/);
});
test("reread loads updated persona even with unchanged mtime", (t) => {
  const config = fixture(t);
  const stat = fs.statSync(config.arongPersonaFile);
  assert.match(buildInstructionRefreshText(config), /阿嵘 persona/);
  fs.writeFileSync(config.arongPersonaFile, "UPDATED PERSONA");
  fs.utimesSync(config.arongPersonaFile, stat.atime, stat.mtime);
  assert.match(buildInstructionRefreshText(config), /UPDATED PERSONA/);
});
function adapterFactory() {
  const filename = path.resolve(__dirname, "../src/adapters/runtime/codex/index.js");
  const requireLocal = createRequire(filename);
  const sent = [];
  let fail = false;
  class Client {
    constructor() { this.listeners = new Set(); }
    async connect() {}
    async initialize() {}
    async listModels() { return {}; }
    async close() {}
    async startThread() { return { result: { thread: { id: "new-thread" } } }; }
    async resumeThread() {}
    onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async sendUserMessage(params) {
      if (fail) { fail = false; throw new Error("send failed"); }
      sent.push(params);
      queueMicrotask(() => { for (const listener of this.listeners) listener({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: "turn-1" } } }); });
      return { result: { turn: { id: "turn-1" } } };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, process, setTimeout, clearTimeout,
    require(name) {
      if (name === "./rpc-client") return { CodexRpcClient: Client };
      if (name === "./mcp-config") return { resolveCodexMcpServerConfigs: () => [] };
      return requireLocal(name);
    },
  }, { filename });
  return { create: module.exports.createCodexRuntimeAdapter, sent, failNext: () => { fail = true; } };
}
for (const restored of [false, true]) {
  test(`${restored ? "restored" : "new"} thread injects once, retries failed sends and reloads on reread/restart`, async (t) => {
    const config = fixture(t);
    const { create, sent, failNext } = adapterFactory();
    const adapter = create(config);
    const args = { bindingKey: "binding", workspaceRoot: path.dirname(config.sessionsFile), text: "hello" };
    if (restored) adapter.getSessionStore().setThreadIdForWorkspace(args.bindingKey, args.workspaceRoot, "old-thread");
    failNext();
    await assert.rejects(adapter.sendTurn(args), /send failed/);
    const first = await adapter.sendTurn(args);
    assert.equal(first.threadId, restored ? "old-thread" : "new-thread");
    assert.match(sent.at(-1).text, /阿嵘 persona/);
    assert.match(sent.at(-1).text, /OPERATIONS/);
    assert.doesNotMatch(sent.at(-1).text, /DEFAULT PERSONA/);
    await adapter.sendTurn(args);
    assert.equal(sent.at(-1).text, "hello");
    fs.writeFileSync(config.arongPersonaFile, "UPDATED PERSONA");
    await adapter.refreshThreadInstructions({ threadId: first.threadId, workspaceRoot: args.workspaceRoot });
    assert.match(sent.at(-1).text, /UPDATED PERSONA/);
    const restarted = create(config);
    await restarted.sendTurn(args);
    assert.match(sent.at(-1).text, /UPDATED PERSONA/);
    await restarted.close();
    await adapter.close();
  });
}
test("config reads the persona path from environment", (t) => {
  const original = process.env.CYBERBOSS_ARONG_PERSONA_FILE;
  t.after(() => { if (original === undefined) delete process.env.CYBERBOSS_ARONG_PERSONA_FILE; else process.env.CYBERBOSS_ARONG_PERSONA_FILE = original; });
  process.env.CYBERBOSS_ARONG_PERSONA_FILE = "persona.md";
  assert.equal(require("../src/core/config").readConfig().arongPersonaFile, "persona.md");
});

test("WeChat startup rejects invalid persona before resolving the account", async (t) => {
  const config = fixture(t);
  fs.writeFileSync(config.arongPersonaFile, "");
  const { CyberbossApp } = require("../src/core/app");
  await assert.rejects(CyberbossApp.prototype.start.call({
    config,
    channelAdapter: { resolveAccount() { assert.fail("account resolution must not run"); } },
  }), /CYBERBOSS_ARONG_PERSONA_FILE is empty/);
});
