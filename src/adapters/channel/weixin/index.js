const crypto = require("crypto");
const { listWeixinAccounts, resolveSelectedAccount } = require("./account-store");
const { loadPersistedContextTokens, persistContextToken } = require("./context-token-store");
const { runLoginFlow } = require("./login");
const { getConfig, sendTyping } = require("./api");
const { getUpdates, sendText } = require("./api");
const { createInboundFilter } = require("./message-utils");
const { sendWeixinMediaFile } = require("./media-send");
const { loadSyncBuffer, saveSyncBuffer } = require("./sync-buffer-store");
const { loadWeixinConfig, saveWeixinConfig, DEFAULT_MIN_WEIXIN_CHUNK } = require("./config-store");

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_WEIXIN_CHUNK = 3800;
const SEND_MESSAGE_CHUNK_INTERVAL_MS = 350;

function createWeixinChannelAdapter(config) {
  let selectedAccount = null;
  let contextTokenCache = null;
  const inboundFilter = createInboundFilter();
  let minWeixinChunk = loadWeixinConfig(config).minChunkChars;

  function ensureAccount() {
    if (!selectedAccount) {
      selectedAccount = resolveSelectedAccount(config);
      contextTokenCache = loadPersistedContextTokens(config, selectedAccount.accountId);
    }
    return selectedAccount;
  }

  function ensureContextTokenCache() {
    if (!contextTokenCache) {
      const account = ensureAccount();
      contextTokenCache = loadPersistedContextTokens(config, account.accountId);
    }
    return contextTokenCache;
  }

  function rememberContextToken(userId, contextToken) {
    const account = ensureAccount();
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    const normalizedToken = typeof contextToken === "string" ? contextToken.trim() : "";
    if (!normalizedUserId || !normalizedToken) {
      return "";
    }
    contextTokenCache = persistContextToken(config, account.accountId, normalizedUserId, normalizedToken);
    return normalizedToken;
  }

  function resolveContextToken(userId, explicitToken = "") {
    const normalizedExplicitToken = typeof explicitToken === "string" ? explicitToken.trim() : "";
    if (normalizedExplicitToken) {
      return normalizedExplicitToken;
    }
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    if (!normalizedUserId) {
      return "";
    }
    return ensureContextTokenCache()[normalizedUserId] || "";
  }

  function sendTextChunks({ userId, text, contextToken = "", preserveBlock = false }) {
    const account = ensureAccount();
    const resolvedToken = resolveContextToken(userId, contextToken);
    if (!resolvedToken) {
      throw new Error(`Missing context_token. Cannot reply to user ${userId}.`);
    }
    const content = String(text || "");
    if (!content.trim()) {
      return Promise.resolve();
    }
    const normalizedContent = normalizeWeixinReplyText(content);
    const sendChunks = chunkReplyTextForWeixin(normalizedContent);
    return sendChunks.reduce((promise, chunk, index) => promise
      .then(() => {
        const deliveryChunk = finalizeWeixinDeliveryChunk(chunk) || "Completed.";
        return sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: userId,
          text: deliveryChunk,
          contextToken: resolvedToken,
          clientId: `cb-${crypto.randomUUID()}`,
        }).catch((error) => {
          error.remainingText = sendChunks.slice(index).map(finalizeWeixinDeliveryChunk).join("\n\n");
          throw error;
        });
      })
      .then(() => {
        if (index < sendChunks.length - 1) {
          return sleep(SEND_MESSAGE_CHUNK_INTERVAL_MS);
        }
        return null;
      }), Promise.resolve());
  }

  return {
    describe() {
      return {
        id: "weixin",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.weixinBaseUrl,
        accountsDir: config.accountsDir,
        syncBufferDir: config.syncBufferDir,
      };
    },
    async login() {
      await runLoginFlow(config);
    },
    printAccounts() {
      const accounts = listWeixinAccounts(config);
      if (!accounts.length) {
        console.log("No saved WeChat account found. Run `npm run login` first.");
        return;
      }
      console.log("Saved accounts:");
      for (const account of accounts) {
        console.log(`- ${account.accountId}`);
        console.log(`  userId: ${account.userId || "(unknown)"}`);
        console.log(`  baseUrl: ${account.baseUrl || config.weixinBaseUrl}`);
        console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
      }
    },
    resolveAccount() {
      return ensureAccount();
    },
    getKnownContextTokens() {
      return { ...ensureContextTokenCache() };
    },
    loadSyncBuffer() {
      const account = ensureAccount();
      return loadSyncBuffer(config, account.accountId);
    },
    saveSyncBuffer(buffer) {
      const account = ensureAccount();
      saveSyncBuffer(config, account.accountId, buffer);
    },
    rememberContextToken,
    async getUpdates({ syncBuffer = "", timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
      const account = ensureAccount();
      const response = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        getUpdatesBuf: syncBuffer,
        timeoutMs,
      });
      const newBuf = typeof response?.get_updates_buf === "string" ? response.get_updates_buf.trim() : "";
      if (newBuf && newBuf !== syncBuffer) {
        this.saveSyncBuffer(newBuf);
      }
      const messages = Array.isArray(response?.msgs) ? response.msgs : [];
      for (const message of messages) {
        const userId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
        const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
        if (userId && contextToken) {
          rememberContextToken(userId, contextToken);
        }
      }
      return response;
    },
    normalizeIncomingMessage(message) {
      const account = ensureAccount();
      return inboundFilter.normalize(message, config, account.accountId);
    },
    async sendText({ userId, text, contextToken = "", preserveBlock = false }) {
      await sendTextChunks({ userId, text, contextToken, preserveBlock });
    },
    async sendTyping({ userId, status = 1, contextToken = "" }) {
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      if (!resolvedToken) {
        return;
      }
      const configResponse = await getConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: userId,
        contextToken: resolvedToken,
      }).catch(() => null);
      const typingTicket = typeof configResponse?.typing_ticket === "string"
        ? configResponse.typing_ticket.trim()
        : "";
      if (!typingTicket) {
        return;
      }
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: typingTicket,
          status,
        },
      });
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      if (!resolvedToken) {
        throw new Error(`Missing context_token. Cannot send a file to user ${userId}.`);
      }
      return sendWeixinMediaFile({
        filePath,
        to: userId,
        contextToken: resolvedToken,
        baseUrl: account.baseUrl,
        token: account.token,
        cdnBaseUrl: config.weixinCdnBaseUrl,
      });
    },
    setMinChunkChars(value) {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_WEIXIN_CHUNK) {
        minWeixinChunk = parsed;
        saveWeixinConfig(config, { minChunkChars: minWeixinChunk });
      }
      return minWeixinChunk;
    },
    getMinChunkChars() {
      return minWeixinChunk;
    },
  };
}

function splitUtf8(text, maxRunes) {
  const runes = Array.from(String(text || ""));
  if (!runes.length || runes.length <= maxRunes) {
    return [String(text || "")];
  }
  const chunks = [];
  while (runes.length) {
    chunks.push(runes.splice(0, maxRunes).join(""));
  }
  return chunks;
}

function normalizeWeixinReplyText(text) {
  return trimOuterBlankLines(normalizeLineEndings(text));
}

function finalizeWeixinDeliveryChunk(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) {
    return "";
  }
  return trimOuterBlankLines(normalized);
}

function stripChunkTailChineseFullStops(text) {
  return String(text || "").replace(/(^|[^。])。(?=(?:\s*["'"”’）)\]\u300d\u300f\u3011》])*\s*$)/u, "$1");
}

function chunkReplyText(text, limit = 3500) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const minBoundary = Math.floor(limit * 0.4);
    const cut = findLastPreferredBoundary(remaining, limit, minBoundary) || limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

function chunkReplyTextForWeixin(text) {
  const normalized = normalizeWeixinReplyText(text);
  if (!normalized.trim()) return [];
  const chunks = [];
  let current = "";
  let fence = null;
  let paragraphEnded = false;
  for (const line of normalized.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue;
    if (paragraphEnded && line.trim() && !fence) {
      // Keep a heading or an introductory label with the content it introduces.
      const previousLine = current.split("\n").filter((part) => part.trim()).at(-1) || "";
      const continuesCode = /^(?: {4}|\t)/.test(line) && /^(?: {4}|\t)/.test(previousLine);
      if (!continuesCode && !/^(?:#{1,6}\s+[^\n]+|[^\n]*[:：])\s*$/.test(current.trim())) {
        chunks.push(current);
        current = "";
      }
      paragraphEnded = false;
    }
    current += line;
    const marker = line.trimEnd().match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    if (!fence && !line.trim()) paragraphEnded = true;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
function mergeShortChunks(chunks, maxLength, minLength) {
  if (!chunks.length) {
    return chunks;
  }
  const merged = [];
  let buffer = chunks[0];
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isShort = buffer.length < minLength && chunk.length < minLength;
    const joined = `${buffer}${chunk}`;
    if (isShort && joined.length <= maxLength) {
      buffer = joined;
    } else {
      merged.push(buffer);
      buffer = chunk;
    }
  }
  merged.push(buffer);
  return merged;
}

function packChunksForWeixinDelivery(chunks) {
  // Legacy callers may still supply limits; never merge or discard their tail.
  return Array.isArray(chunks)
    ? chunks.map(normalizeLineEndings).filter((chunk) => chunk.trim())
    : [];
}
function splitTextAtBoundaries(text, boundaries) {
  const units = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start) {
      continue;
    }
    const unit = text.slice(start, boundary);
    if (unit.trim()) {
      units.push(unit);
    }
    start = boundary;
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    units.push(tail);
  }
  return units;
}

function findLastPreferredBoundary(text, maxBoundary = text.length, minBoundary = 0) {
  const boundaries = collectStreamingBoundaries(text);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary > maxBoundary) {
      continue;
    }
    if (boundary > minBoundary) {
      return boundary;
    }
    break;
  }
  return 0;
}

function collectStreamingBoundaries(text) {
  const boundaries = new Set();

  const regex = /\n\s*\n+/g;
  let match = regex.exec(text);
  while (match) {
    boundaries.add(match.index + match[0].length);
    match = regex.exec(text);
  }

  const listRegex = /\n(?:(?:[-*])\s+|(?:\d+\.)\s+)/g;
  match = listRegex.exec(text);
  while (match) {
    boundaries.add(match.index + 1);
    match = listRegex.exec(text);
  }

  for (let index = 0; index < text.length; index += 1) {
    const endOfPunctuation = findBoundaryPunctuationEnd(text, index);
    if (!endOfPunctuation) {
      continue;
    }

    let end = endOfPunctuation;
    while (end < text.length && /["'"”’）)\]\u300d\u300f\u3011》]/u.test(text[end])) {
      end += 1;
    }
    while (end < text.length && /[\t \n]/.test(text[end])) {
      end += 1;
    }
    boundaries.add(end);
    index = endOfPunctuation - 1;
  }

  return Array.from(boundaries).sort((left, right) => left - right);
}

function findBoundaryPunctuationEnd(text, index) {
  const char = text[index];
  if (/[\u3002\uff01\uff1f!?]/u.test(char)) {
    return consumeRepeatedChar(text, index, char);
  }
  if (char === ".") {
    const end = consumeRepeatedChar(text, index, ".");
    return end - index >= 3 ? end : 0;
  }
  if (char === "…") {
    return consumeRepeatedChar(text, index, "…");
  }
  return 0;
}

function consumeRepeatedChar(text, index, char) {
  let end = index + 1;
  while (end < text.length && text[end] === char) {
    end += 1;
  }
  return end;
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createWeixinChannelAdapter,
  splitUtf8,
  normalizeWeixinReplyText,
  finalizeWeixinDeliveryChunk,
  stripChunkTailChineseFullStops,
  chunkReplyText,
  chunkReplyTextForWeixin,
  mergeShortChunks,
  packChunksForWeixinDelivery,
  splitTextAtBoundaries,
  findLastPreferredBoundary,
  collectStreamingBoundaries,
  findBoundaryPunctuationEnd,
  trimOuterBlankLines,
};
