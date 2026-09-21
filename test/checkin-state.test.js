const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CheckinStateStore, quiet, localClock } = require("../src/core/checkin-state-store");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const at = (time) => Date.parse(`2026-09-21T${time}:00+08:00`);
function fixture(t, random = () => 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-checkin-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new CheckinStateStore({ filePath: path.join(dir, "state.json"), random });
}
const state = (store) => store.read()['["a","u"]'];
test("Shanghai quiet hours and day boundaries are independent of host timezone", () => {
  assert.equal(quiet(at("00:59")), false);
  assert.equal(quiet(at("01:00")), true);
  assert.equal(quiet(at("07:59")), true);
  assert.equal(quiet(at("08:00")), false);
  assert.equal(localClock(at("00:00")).day, "2026-09-21");
});
test("morning once daily, persisted schedule and repeating followups", (t) => {
  const store = fixture(t);
  assert.equal(store.reserve("a", "u", at("07:59")), null);
  const morning = store.reserve("a", "u", at("08:00"));
  assert.equal(morning.kind, "morning");
  assert.equal(store.reserve("a", "u", at("08:01")), null);
  store.sent(morning, at("08:00"));
  const restarted = new CheckinStateStore({ filePath: store.filePath, random: () => 0 });
  assert.equal(restarted.reserve("a", "u", at("08:29")), null);
  let token = restarted.reserve("a", "u", at("08:30"));
  assert.equal(token.kind, "followup");
  restarted.sent(token, at("08:30"));
  token = restarted.reserve("a", "u", at("09:00"));
  assert.equal(token.kind, "followup");
  restarted.sent(token, at("09:00"));
  assert.equal(state(store).morningSentDay, "2026-09-21");
  assert.equal(restarted.reserve("a", "u", at("08:00") + 86400000).kind, "morning");
});
test("real messages reset timer, cancel pending contacts, and ignore replayed messages", (t) => {
  const store = fixture(t);
  const pending = store.reserve("a", "u", at("08:00"));
  store.userMessage("a", "u", new Date(at("08:01")).toISOString());
  assert.equal(store.canSend(pending, at("08:02")), false);
  assert.equal(store.reserve("a", "u", at("08:30")), null);
  const deadline = state(store).nextCheckinAt;
  store.userMessage("a", "u", new Date(at("08:01")).toISOString());
  assert.equal(state(store).nextCheckinAt, deadline);
  assert.equal(store.reserve("a", "u", at("08:31")).kind, "morning");
});
test("random 30-45 minute deadline is persisted, not rerolled after restart", (t) => {
  const store = fixture(t, () => 0.9999999);
  store.userMessage("a", "u", new Date(at("10:00")).toISOString());
  assert.equal(state(store).nextCheckinAt, at("10:45"));
  const restarted = new CheckinStateStore({ filePath: store.filePath, random: () => 0 });
  assert.equal(restarted.reserve("a", "u", at("10:44")), null);
  assert.equal(state(store).nextCheckinAt, at("10:45"));
  assert.equal(restarted.reserve("a", "u", at("10:45")).kind, "followup");
});
test("delayed morning expires at 09:00 and nighttime contacts cannot send", (t) => {
  const store = fixture(t);
  const morning = store.reserve("a", "u", at("08:59"));
  assert.equal(store.canSend(morning, at("09:00")), false);
  store.userMessage("a", "u", new Date(at("00:25") + 86400000).toISOString());
  const token = store.reserve("a", "u", at("00:55") + 86400000);
  assert.equal(store.canSend(token, at("01:00") + 86400000), false);
  assert.equal(store.reserve("a", "u", at("07:00") + 86400000), null);
});
test("queue preserves checkin identity and dispatcher forbids silent only for checkins", (t) => {
  const store = fixture(t);
  const checkin = store.reserve("a", "u", at("08:00"));
  const queue = new SystemMessageQueueStore({ filePath: path.join(path.dirname(store.filePath), "queue.json") });
  queue.enqueue({ id: "q", accountId: "a", senderId: "u", workspaceRoot: "/workspace", text: "trigger", checkin });
  const dispatcher = new SystemMessageDispatcher({ queueStore: queue, config: {}, accountId: "a" });
  const prepared = dispatcher.buildPreparedMessage(dispatcher.drainPending()[0], "token");
  assert.deepEqual(prepared.checkin, checkin);
  assert.match(prepared.text, /never silent/);
  assert.match(prepared.text, /first natural good morning/);
});
async function deliver(store, token, sendText, text = '{"action":"silent"}') {
  const stream = new StreamDelivery({ channelAdapter: { sendText }, sessionStore: { findBindingForThreadId() {} }, checkinStateStore: store });
  stream.queueReplyTargetForThread("thread", { userId: "u", contextToken: "ctx", provider: "system", checkin: token });
  await stream.handleRuntimeEvent({ type: "runtime.turn.started", payload: { threadId: "thread", turnId: "turn" } });
  await stream.handleRuntimeEvent({ type: "runtime.reply.completed", payload: { threadId: "thread", turnId: "turn", itemId: "item", text } });
  await stream.handleRuntimeEvent({ type: "runtime.turn.completed", payload: { threadId: "thread", turnId: "turn" } });
}
test("silent morning becomes a greeting and only successful delivery marks it sent", async (t) => {
  const store = fixture(t);
  t.mock.method(Date, "now", () => at("08:00"));
  const token = store.reserve("a", "u");
  const sent = [];
  await deliver(store, token, async (payload) => sent.push(payload));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /早安/);
  assert.equal(state(store).morningSentDay, "2026-09-21");
  assert.equal(state(store).lastProactiveMessageAt, at("08:00"));
  await deliver(store, token, async (payload) => sent.push(payload));
  assert.equal(sent.length, 1);
});
test("send failures do not mark morning sent and never defer stale checkins", async (t) => {
  const store = fixture(t);
  t.mock.method(Date, "now", () => at("08:00"));
  const token = store.reserve("a", "u");
  await deliver(store, token, async () => { throw new Error("fixture delivery failed"); });
  assert.equal(state(store).morningSentDay, undefined);
  assert.equal(state(store).lastProactiveMessageAt, undefined);
  assert.equal(store.reserve("a", "u", at("08:00")), null);
  assert.equal(store.reserve("a", "u", at("08:01")).kind, "morning");
});
test("user returning during generation suppresses the pending message", async (t) => {
  const store = fixture(t);
  t.mock.method(Date, "now", () => at("08:02"));
  const token = store.reserve("a", "u", at("08:00"));
  store.userMessage("a", "u", new Date(at("08:01")).toISOString());
  await deliver(store, token, async () => assert.fail("must not send"));
});

test("quiet hours beginning during generation suppress delivery", async (t) => {
  const store = fixture(t);
  store.userMessage("a", "u", new Date(at("00:25")).toISOString());
  const token = store.reserve("a", "u", at("00:55"));
  t.mock.method(Date, "now", () => at("01:00"));
  await deliver(store, token, async () => assert.fail("quiet hours must gate the actual send"));
});
test("followups reject exact repeated text and persist the next interval", async (t) => {
  const store = fixture(t);
  let now = at("08:00");
  t.mock.method(Date, "now", () => now);
  const sent = [];
  await deliver(store, store.reserve("a", "u"), async (p) => sent.push(p), '{"action":"send_message","message":"早安，今天慢慢来。"}');
  now = at("08:30");
  await deliver(store, store.reserve("a", "u"), async (p) => sent.push(p), '{"action":"send_message","message":"早安，今天慢慢来。"}');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].text, sent[0].text);
  assert.equal(state(store).nextCheckinAt, at("09:00"));
});
test("real inbound commands and attachments reset state before message dispatch", async (t) => {
  const { CyberbossApp } = require("../src/core/app");
  const store = fixture(t);
  const normalized = { accountId: "a", senderId: "u", receivedAt: new Date(at("10:00")).toISOString(), text: "/status", attachments: [] };
  await CyberbossApp.prototype.handleIncomingMessage.call({
    channelAdapter: { normalizeIncomingMessage: () => normalized },
    checkinStateStore: store,
    primeDeferredRepliesForSender() { assert.equal(state(store).lastUserMessageAt, at("10:00")); },
    async handlePreparedMessage() {},
  }, {});
  assert.equal(state(store).nextCheckinAt, at("10:30"));
});
test("restart retains pending identity and abandons an expired attempt", (t) => {
  const store = fixture(t);
  const token = store.reserve("a", "u", at("08:00"));
  const restarted = new CheckinStateStore({ filePath: store.filePath, random: () => 0 });
  assert.equal(restarted.reserve("a", "u", at("08:01")), null);
  assert.equal(restarted.canSend(token, at("08:01")), true);
  const next = restarted.reserve("a", "u", at("08:10"));
  assert.notEqual(next.id, token.id);
  assert.equal(restarted.canSend(token, at("08:10")), false);
});
