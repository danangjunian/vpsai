async function processIncomingText(text, dataService, messageMeta, aiCommandParser) {
  const bodyText = normalizeText_(text);
  if (!bodyText) {
    return { reply: "NO_MESSAGE", saveResult: null };
  }

  const preAi = await tryAiPreNormalize_(bodyText, dataService, messageMeta, aiCommandParser);
  if (preAi) {
    return preAi;
  }

  const primary = normalizeResult_(await dataService.executeText(bodyText, messageMeta));
  if (!shouldTryAiFallback_(primary, aiCommandParser)) {
    return primary;
  }

  const aiResult = await aiCommandParser.parseToCommand(bodyText, {
    source: messageMeta && messageMeta.source,
    appScriptReply: primary.reply
  });
  if (!aiResult || !aiResult.command) {
    return primary;
  }

  const normalizedOriginal = normalizeFlatText_(bodyText).toLowerCase();
  const normalizedAiCommand = normalizeFlatText_(aiResult.command).toLowerCase();
  if (!normalizedAiCommand || normalizedAiCommand === normalizedOriginal) {
    return primary;
  }

  const secondaryMeta = withDerivedMessageId_(messageMeta, "ai_secondary");
  const secondary = normalizeResult_(await dataService.executeText(aiResult.command, secondaryMeta));
  if (isSessionBlockingReply_(primary.reply) && isNonSessionCommand_(aiResult.command) && isUnknownCommandReply_(secondary.reply)) {
    try {
      const cancelMeta = withDerivedMessageId_(messageMeta, "ai_cancel");
      await dataService.executeText("batal", cancelMeta);
      const retryMeta = withDerivedMessageId_(messageMeta, "ai_retry");
      const retried = normalizeResult_(await dataService.executeText(aiResult.command, retryMeta));
      if (!isUnknownCommandReply_(retried.reply)) {
        console.log('[ai-text] auto-cancel session and mapped "' + bodyText + '" -> "' + aiResult.command + '"');
        return retried;
      }
    } catch (err) {
      // abaikan, fallback ke response utama
    }
  }

  if (isUnknownCommandReply_(secondary.reply)) {
    return primary;
  }

  console.log('[ai-text] mapped "' + bodyText + '" -> "' + aiResult.command + '"');
  return secondary;
}

async function tryAiPreNormalize_(bodyText, dataService, messageMeta, aiCommandParser) {
  if (!canTryAiPreNormalize_(bodyText, aiCommandParser)) return null;

  const aiResult = await aiCommandParser.parseToCommand(bodyText, {
    source: messageMeta && messageMeta.source,
    appScriptReply: ""
  });
  if (!aiResult || !aiResult.command) return null;

  const normalizedOriginal = normalizeFlatText_(bodyText).toLowerCase();
  const normalizedAiCommand = normalizeFlatText_(aiResult.command).toLowerCase();
  if (!normalizedAiCommand || normalizedAiCommand === normalizedOriginal) return null;
  if (!isSafePreAiCommand_(normalizedAiCommand)) return null;

  const mapped = normalizeResult_(await dataService.executeText(aiResult.command, messageMeta));
  if (isUnknownCommandReply_(mapped.reply) || isRecoverableSessionReply_(mapped.reply)) return null;

  console.log('[ai-text] pre-mapped "' + bodyText + '" -> "' + aiResult.command + '"');
  return mapped;
}

function canTryAiPreNormalize_(bodyText, aiCommandParser) {
  if (!aiCommandParser || typeof aiCommandParser.parseToCommand !== "function") return false;
  if (typeof aiCommandParser.isEnabled === "function" && !aiCommandParser.isEnabled()) return false;

  const text = normalizeText_(bodyText).toLowerCase();
  if (!text) return false;

  // Jangan ganggu format eksplisit/struktural.
  if (text.indexOf("input#") === 0 || text.indexOf("update#") === 0) return false;
  if (/^\s*(?:no|pilih)\s+\d+/.test(text)) return false;
  if (/^\s*\d+\s+\d+/.test(text)) return false;
  if (/(^|\n)\s*[a-z\- ]+\s*:/.test(text)) return false;
  if (text === "ok" || text === "batal") return false;

  // Pre-AI dipakai untuk bahasa natural/campuran.
  return hasConversationalHint_(text);
}

function hasConversationalHint_(text) {
  const t = normalizeFlatText_(text).toLowerCase();
  if (!t) return false;

  const hints = [
    "udah",
    "sudah",
    "tolong",
    "dong",
    "donk",
    "mau",
    "saya",
    "aku",
    "cekin",
    "please",
    "pls",
    "yang ",
    " yg "
  ];

  for (let i = 0; i < hints.length; i++) {
    if (t.indexOf(hints[i]) !== -1) return true;
  }
  return false;
}

function isSafePreAiCommand_(commandText) {
  const cmd = normalizeFlatText_(commandText).toLowerCase();
  if (!cmd) return false;
  if (isSelectionOrCommitCommand_(cmd)) return false;
  return true;
}

function shouldTryAiFallback_(result, aiCommandParser) {
  if (!aiCommandParser || typeof aiCommandParser.parseToCommand !== "function") return false;
  if (typeof aiCommandParser.isEnabled === "function" && !aiCommandParser.isEnabled()) return false;

  const saveResult = result && result.saveResult ? result.saveResult : null;
  if (saveResult && saveResult.ok) return false;

  return (
    isUnknownCommandReply_(result && result.reply) ||
    isRecoverableSessionReply_(result && result.reply)
  );
}

function isUnknownCommandReply_(reply) {
  const text = normalizeFlatText_(reply).toLowerCase();
  if (!text) return false;

  return (
    text.indexOf("perintah tidak dikenali") !== -1 ||
    text.indexOf("format salah") !== -1 ||
    text.indexOf("format pilihan tidak sesuai") !== -1 ||
    text.indexOf("format belum sesuai") !== -1
  );
}

function isSessionBlockingReply_(reply) {
  const text = normalizeFlatText_(reply).toLowerCase();
  if (!text) return false;

  return (
    text.indexOf("format pilihan tidak sesuai") !== -1 ||
    text.indexOf("ketik ok untuk simpan / batal untuk batal") !== -1 ||
    text.indexOf("proses motor laku dibatalkan") !== -1
  );
}

function isRecoverableSessionReply_(reply) {
  const text = normalizeFlatText_(reply).toLowerCase();
  if (!text) return false;

  return (
    text.indexOf("tidak ditemukan") !== -1 ||
    text.indexOf("coba nama lain") !== -1 ||
    text.indexOf("pilihan tidak ditemukan di daftar") !== -1
  );
}

function isNonSessionCommand_(commandText) {
  const cmd = normalizeFlatText_(commandText).toLowerCase();
  if (!cmd) return false;
  if (cmd === "batal" || cmd === "ok") return false;
  return !isSelectionOrCommitCommand_(cmd);
}

function isSelectionOrCommitCommand_(commandText) {
  const cmd = normalizeFlatText_(commandText).toLowerCase();
  if (!cmd) return false;
  if (cmd === "ok") return true;
  if (/^no\s+\d+\s+laku\s+\d+/.test(cmd)) return true;
  if (/^pilih\s+\d+\s+laku\s+\d+/.test(cmd)) return true;
  if (/^\d+\s+\d+/.test(cmd)) return true;
  if (/^no\s+\d+\s+\d+/.test(cmd)) return true;
  if (/^pilih\s+\d+\s+\d+/.test(cmd)) return true;
  return false;
}

function normalizeResult_(result) {
  return {
    reply: String((result && result.reply) || "OK"),
    saveResult: result && result.saveResult ? result.saveResult : null
  };
}

function normalizeText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normalizeFlatText_(value) {
  return normalizeText_(value).replace(/\s+/g, " ").trim();
}

function withDerivedMessageId_(messageMeta, suffix) {
  const meta = messageMeta && typeof messageMeta === "object" ? Object.assign({}, messageMeta) : {};
  const base = normalizeFlatText_(meta.messageId || meta.message_id);
  const tag = normalizeFlatText_(suffix || "alt").replace(/[^\w\-]/g, "_") || "alt";
  const randomTail = Math.random().toString(36).slice(2, 8);
  const derived = (base || "vps") + "__" + tag + "__" + randomTail;
  meta.messageId = derived;
  meta.message_id = derived;
  return meta;
}

function toWebhookResult(saveResult) {
  if (!saveResult) return "OK";
  return saveResult.ok ? "OK_SAVED_ROW_" + saveResult.row : "ERROR_" + saveResult.error;
}

module.exports = {
  processIncomingText,
  toWebhookResult
};
