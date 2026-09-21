const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { chunkReplyTextForWeixin, packChunksForWeixinDelivery } = require("../src/adapters/channel/weixin");

test("paragraphs are lossless; sentences, URLs, lists, emoji and code remain intact", () => {
  for (const text of [
    "主人，刚才那个小细节让我笑了。想起我们上次聊到的事，觉得很暖。",
    "第一段。\n\n第二段？不是采访，是接着聊。\n\n最后一段🙂。",
    "说明：\n\n- 一起看 https://example.com/a?x=1\n- 再讨论下一步。",
    "先看这里。\n\n```js\nconst a = 1;\n\nconsole.log(a);\n```\n\n后续说明。",
    "## 分析\n\n先检查证据，再下结论。",
    "~~~\nfirst\n\nsecond\n~~~",
  ]) {
    const chunks = chunkReplyTextForWeixin(text);
    assert.equal(chunks.join(""), text);
  }
  assert.equal(chunkReplyTextForWeixin("完整的一段。还有下一句话！").length, 1);
  assert.equal(chunkReplyTextForWeixin("说明：\n\n- 第一项\n- 第二项").length, 1);
  assert.equal(chunkReplyTextForWeixin("## 分析\n\n具体说明。").length, 1);
  assert.equal(chunkReplyTextForWeixin("```js\none\n\ntwo\n```").length, 1);
  assert.equal(chunkReplyTextForWeixin("js:\n    const a = 1;\n    \n    console.log(a);").length, 1);
});
test("no bubble quota or fixed character cuts and no loss beyond the former quota", () => {
  const paragraphs = Array.from({ length: 15 }, (_, i) => `${i}：${"完整内容🙂".repeat(1000)}。`);
  const text = paragraphs.join("\n\n");
  const chunks = chunkReplyTextForWeixin(text, 3800);
  assert.equal(chunks.length, 15);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(packChunksForWeixinDelivery(chunks, 10, 3800), chunks);
  assert.deepEqual(chunkReplyTextForWeixin("没有标点🙂".repeat(2000)), ["没有标点🙂".repeat(2000)]);
});
function adapterHarness(sendText) {
  const filename = path.resolve(__dirname, "../src/adapters/channel/weixin/index.js");
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const mocks = {
    "./api": { sendText },
    "./account-store": { resolveSelectedAccount: () => ({ accountId: "a", token: "fixture", baseUrl: "fixture" }) },
    "./context-token-store": { loadPersistedContextTokens: () => ({}), persistContextToken() {} },
    "./config-store": { loadWeixinConfig: () => ({ minChunkChars: 20 }), DEFAULT_MIN_WEIXIN_CHUNK: 20 },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, require: (name) => mocks[name] || localRequire(name), setTimeout: (callback) => callback(),
  }, { filename });
  return module.exports.createWeixinChannelAdapter({});
}
test("adapter sends more than ten paragraphs sequentially, preserving punctuation", async () => {
  const sent = [];
  const adapter = adapterHarness(async ({ text }) => { sent.push(text); });
  const paragraphs = Array.from({ length: 12 }, (_, i) => `第${i}段，保持完整。`);
  await adapter.sendText({ userId: "u", contextToken: "token", text: paragraphs.join("\n\n") });
  assert.deepEqual(sent, paragraphs);
  sent.length = 0;
  await adapter.sendText({ userId: "u", contextToken: "token", text: "第一段。\n\n第二段。", preserveBlock: true });
  assert.deepEqual(sent, ["第一段。", "第二段。"]);
});
test("partial delivery failures retain only the unsent paragraphs for retry", async () => {
  const sent = [];
  const adapter = adapterHarness(async ({ text }) => {
    if (sent.length === 1) throw new Error("fixture failure");
    sent.push(text);
  });
  await assert.rejects(adapter.sendText({ userId: "u", contextToken: "token", text: "第一段。\n\n第二段。\n\n第三段。" }), (error) => {
    assert.equal(error.remainingText, "第二段。\n\n第三段。");
    return true;
  });
  assert.deepEqual(sent, ["第一段。"]);
});
test("operations prompt allows natural paragraphs without the old ten-chunk directive", () => {
  const text = fs.readFileSync(path.resolve(__dirname, "../templates/weixin-operations.md"), "utf8");
  assert.match(text, /without a fixed number of bubbles/);
  assert.doesNotMatch(text, /at most 10|within 10 chunks|If a task is getting long/);
});

