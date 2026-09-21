const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function localClock(now) {
  const iso = new Date(now + 8 * 3600000).toISOString();
  return { day: iso.slice(0, 10), hour: Number(iso.slice(11, 13)) };
}
function quiet(now) { const { hour } = localClock(now); return hour >= 1 && hour < 8; }
function statePath(config) { return config.checkinStateFile || path.join(path.dirname(config.checkinConfigFile), "checkin-state.json"); }
class CheckinStateStore {
  constructor({ filePath, random = Math.random }) { this.filePath = filePath; this.random = random; }
  read() {
    try { return JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  update(accountId, senderId, fn) {
    const all = this.read();
    const key = JSON.stringify([accountId, senderId]);
    const state = all[key] || {};
    const before = JSON.stringify(state);
    const result = fn(state);
    if (JSON.stringify(state) === before) return result;
    all[key] = state;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(all, null, 2));
    fs.renameSync(temp, this.filePath);
    return result;
  }
  interval() { return 1800000 + Math.floor(this.random() * 900001); }
  userMessage(accountId, senderId, time) {
    const at = Date.parse(time);
    if (!Number.isFinite(at)) return;
    this.update(accountId, senderId, (s) => {
      if (at <= (s.lastUserMessageAt || 0)) return;
      s.lastUserMessageAt = at;
      s.nextCheckinAt = at + this.interval();
      delete s.pending;
    });
  }
  reserve(accountId, senderId, now = Date.now()) {
    return this.update(accountId, senderId, (s) => {
      if (s.pending && s.pending.expiresAt <= now) delete s.pending;
      if (s.pending || quiet(now)) return null;
      const { day, hour } = localClock(now);
      const morning = hour === 8 && s.morningSentDay !== day;
      // A real user message always starts a fresh undisturbed interval.
      if (s.nextCheckinAt > now) return null;
      if (!s.nextCheckinAt && !morning) { s.nextCheckinAt = now + this.interval(); return null; }
      const pending = { id: crypto.randomUUID(), kind: morning ? "morning" : "followup", day, expiresAt: now + 600000 };
      s.pending = pending;
      return { ...pending, accountId, senderId };
    });
  }
  canSend(token, now = Date.now()) {
    const s = this.read()[JSON.stringify([token.accountId, token.senderId])] || {};
    const { day, hour } = localClock(now);
    return !quiet(now) && s.pending?.id === token.id && s.pending.expiresAt > now
      && (token.kind !== "morning" || (hour === 8 && token.day === day && s.morningSentDay !== day));
  }
  sent(token, now = Date.now(), text = "") {
    this.update(token.accountId, token.senderId, (s) => {
      s.lastProactiveMessageAt = now;
      s.lastProactiveText = text;
      if (token.kind === "morning") s.morningSentDay = localClock(now).day;
      // Do not overwrite a newer inbound message's timer during an async send.
      if (s.pending?.id === token.id) { delete s.pending; s.nextCheckinAt = now + this.interval(); }
    });
  }
  release(token, now = Date.now()) {
    this.update(token.accountId, token.senderId, (s) => {
      if (s.pending?.id === token.id) { delete s.pending; s.nextCheckinAt = now + 60000; }
    });
  }
}
module.exports = { CheckinStateStore, statePath, localClock, quiet };
