const menuText = require("./menuText");
const {
  normalizeInputCols,
  parseLabeledInput,
  parseLabeledUpdate,
  validateStockCols
} = require("./utils");

async function processIncomingText(text, dataService, messageMeta) {
  const bodyText = String(text || "").trim();
  const lower = bodyText.toLowerCase();

  if (!bodyText) {
    return { reply: "NO_MESSAGE", saveResult: null };
  }

  if (lower === "halo" || lower === "hi" || lower === "menu") {
    return { reply: menuText, saveResult: null };
  }

  const keyword = parseDataMotorKeyword_(bodyText);
  if (keyword !== null) {
    if (!keyword) {
      return { reply: "Format salah. Gunakan: data motor <nama motor> atau cek data motor <nama motor>", saveResult: null };
    }

    // Kirim format kanonik ke Apps Script agar konsisten lintas deployment.
    const result = await dataService.executeText("data motor " + keyword, messageMeta);
    return {
      reply: String((result && result.reply) || "OK"),
      saveResult: result && result.saveResult ? result.saveResult : null
    };
  }

  if (lower.startsWith("input#")) {
    const body = bodyText.slice(6).trim();
    const rawCols = body.split(";").map(function (s) { return s.trim(); });
    const cols = normalizeInputCols(rawCols);
    const validation = validateStockCols(cols);
    if (!validation.ok) {
      return { reply: "Format salah: " + validation.error, saveResult: null };
    }

    const saved = await dataService.saveStock(validation.data, messageMeta);
    const normalized = normalizeOperationResult_(saved, "Data tersimpan");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  if (lower.startsWith("update#")) {
    const body = bodyText.slice(7).trim();
    const cols = body.split(";").map(function (s) { return s.trim(); });
    const updated = await dataService.updateSold(cols, messageMeta);
    const normalized = normalizeOperationResult_(updated, "Data terupdate");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  const parsedUpdate = parseLabeledUpdate(bodyText);
  if (parsedUpdate.matched) {
    const updated = await dataService.updateSold(parsedUpdate.cols, messageMeta);
    const normalized = normalizeOperationResult_(updated, "Data terupdate");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  const parsedInput = parseLabeledInput(bodyText);
  if (parsedInput.matched) {
    const validation = validateStockCols(parsedInput.cols);
    if (!validation.ok) {
      return { reply: "Format salah: " + validation.error, saveResult: null };
    }

    const saved = await dataService.saveStock(validation.data, messageMeta);
    const normalized = normalizeOperationResult_(saved, "Data tersimpan");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  return { reply: "Perintah tidak dikenali. Ketik HALO untuk lihat format.", saveResult: null };
}

function normalizeOperationResult_(result, defaultPrefix) {
  if (typeof result === "number") {
    return {
      reply: defaultPrefix + " di baris " + result,
      saveResult: { ok: true, row: result }
    };
  }

  const row =
    result && result.row !== undefined && result.row !== null && String(result.row).trim() !== ""
      ? Number(result.row)
      : null;
  const hasRow = row !== null && !Number.isNaN(row);
  const rawReply = result && result.reply ? String(result.reply) : "";
  const replyText = rawReply && rawReply !== "OK"
    ? rawReply
    : (hasRow ? defaultPrefix + " di baris " + row : defaultPrefix);

  if (result && result.saveResult) {
    return {
      reply: replyText,
      saveResult: result.saveResult
    };
  }

  return {
    reply: replyText,
    saveResult: hasRow ? { ok: true, row: row } : null
  };
}

function toWebhookResult(saveResult) {
  if (!saveResult) return "OK";
  return saveResult.ok ? "OK_SAVED_ROW_" + saveResult.row : "ERROR_" + saveResult.error;
}

function parseDataMotorKeyword_(text) {
  const m = String(text || "").trim().match(/^(?:cek\s+)?data\s+motor(?:\s+(.+))?$/i);
  if (!m) return null;
  return m[1] ? String(m[1]).trim() : "";
}

module.exports = {
  processIncomingText,
  toWebhookResult
};
