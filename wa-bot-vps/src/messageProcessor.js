const menuText = require("./menuText");
const {
  normalizeInputCols,
  parseLabeledInput,
  parseLabeledUpdate,
  validateStockCols
} = require("./utils");

const pendingMotorMasukByConversation_ = new Map();
const MOTOR_MASUK_PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const pendingMotorLakuByConversation_ = new Map();
const MOTOR_LAKU_PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const MOTOR_LAKU_LIST_MAX = 20;

const MOTOR_MASUK_TEMPLATE_TEXT = [
  "NAMA MOTOR:",
  "TAHUN:",
  "PLAT:",
  "SURAT-SURAT:",
  "TAHUN PLAT:",
  "PAJAK:",
  "HARGA JUAL:",
  "HARGA BELI:"
].join("\n");

async function processIncomingText(text, dataService, messageMeta) {
  const bodyText = String(text || "").trim();
  const lower = bodyText.toLowerCase();
  const convoKey = getConversationKey_(messageMeta);

  if (!bodyText) {
    return { reply: "NO_MESSAGE", saveResult: null };
  }

  cleanupPendingMotorMasuk_();
  cleanupPendingMotorLaku_();

  if (isMotorMasukCommand_(bodyText)) {
    pendingMotorLakuByConversation_.delete(convoKey);
    pendingMotorMasukByConversation_.set(convoKey, {
      stage: "awaiting_details",
      createdAt: Date.now()
    });
    return {
      reply: [
        "Silakan isi template motor masuk berikut:",
        MOTOR_MASUK_TEMPLATE_TEXT
      ].join("\n\n"),
      saveResult: null
    };
  }

  const motorTerjualKeyword = parseMotorTerjualKeyword_(bodyText);
  if (motorTerjualKeyword !== null) {
    const command = motorTerjualKeyword
      ? ("motor " + motorTerjualKeyword + " terjual")
      : "motor terjual";
    const result = await dataService.executeText(command, messageMeta);
    return {
      reply: String((result && result.reply) || "OK"),
      saveResult: result && result.saveResult ? result.saveResult : null
    };
  }

  const motorLakuKeyword = parseMotorLakuKeyword_(bodyText);
  if (motorLakuKeyword !== null) {
    if (!motorLakuKeyword) {
      return { reply: "Format salah. Gunakan: motor <nama motor> laku", saveResult: null };
    }

    const lookup = await dataService.executeText("data motor " + motorLakuKeyword, messageMeta);
    const options = parseMotorRowsFromDataReply_(lookup && lookup.reply);
    if (!options.length) {
      const fallbackReply = String((lookup && lookup.reply) || "").trim();
      return {
        reply: fallbackReply || ('Data motor "' + motorLakuKeyword + '" tidak ditemukan.'),
        saveResult: null
      };
    }

    const shownOptions = options.slice(0, MOTOR_LAKU_LIST_MAX);
    pendingMotorMasukByConversation_.delete(convoKey);
    pendingMotorLakuByConversation_.set(convoKey, {
      stage: "awaiting_selection",
      createdAt: Date.now(),
      keyword: motorLakuKeyword,
      options: shownOptions
    });

    return {
      reply: formatMotorLakuOptionsReply_(motorLakuKeyword, shownOptions, options.length),
      saveResult: null
    };
  }

  const pendingMotorMasuk = pendingMotorMasukByConversation_.get(convoKey);
  if (pendingMotorMasuk) {
    return handlePendingMotorMasuk_(pendingMotorMasuk, bodyText, lower, dataService, messageMeta, convoKey);
  }

  const pendingMotorLaku = pendingMotorLakuByConversation_.get(convoKey);
  if (pendingMotorLaku) {
    return handlePendingMotorLaku_(pendingMotorLaku, bodyText, lower, dataService, messageMeta, convoKey);
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

function parseMotorTerjualKeyword_(text) {
  const m = String(text || "").trim().match(/^motor(?:\s+(.+?))?\s+terjual$/i);
  if (!m) return null;
  return m[1] ? String(m[1]).trim() : "";
}

async function handlePendingMotorMasuk_(pending, bodyText, lower, dataService, messageMeta, convoKey) {
  if (lower === "batal") {
    pendingMotorMasukByConversation_.delete(convoKey);
    return { reply: "Input motor masuk dibatalkan.", saveResult: null };
  }

  if (pending.stage === "awaiting_details") {
    const parsed = parseLabeledInput(bodyText);
    if (!parsed.matched) {
      return {
        reply: [
          "Format belum sesuai template motor masuk.",
          "Kirim ulang sesuai format berikut:",
          MOTOR_MASUK_TEMPLATE_TEXT,
          "",
          "Atau ketik BATAL untuk membatalkan."
        ].join("\n"),
        saveResult: null
      };
    }

    const validation = validateStockCols(parsed.cols);
    if (!validation.ok) {
      return { reply: "Format salah: " + validation.error, saveResult: null };
    }

    const cols = validation.data;
    pendingMotorMasukByConversation_.set(convoKey, {
      stage: "awaiting_confirm",
      createdAt: Date.now(),
      cols: cols
    });

    return {
      reply: [
        "Konfirmasi data motor masuk:",
        formatMotorMasukSummary_(cols),
        "",
        "Ketik OK untuk simpan / BATAL untuk batal"
      ].join("\n"),
      saveResult: null
    };
  }

  if (pending.stage === "awaiting_confirm") {
    if (lower !== "ok") {
      return { reply: "Ketik OK untuk simpan / BATAL untuk batal", saveResult: null };
    }

    const saved = await dataService.saveStock(pending.cols || [], messageMeta);
    pendingMotorMasukByConversation_.delete(convoKey);
    const normalized = normalizeOperationResult_(saved, "Data tersimpan");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  pendingMotorMasukByConversation_.delete(convoKey);
  return { reply: "Sesi motor masuk tidak valid. Ketik motor masuk untuk mulai ulang.", saveResult: null };
}

async function handlePendingMotorLaku_(pending, bodyText, lower, dataService, messageMeta, convoKey) {
  if (lower === "batal") {
    pendingMotorLakuByConversation_.delete(convoKey);
    return { reply: "Proses motor laku dibatalkan.", saveResult: null };
  }

  if (pending.stage === "awaiting_selection") {
    const selected = parseMotorLakuSelection_(bodyText, pending.options);
    if (!selected.ok) {
      return {
        reply: [
          selected.error || "Format salah.",
          "Gunakan format: no <pilihan> laku <harga>",
          "Contoh: no 2 laku 7000000",
          "Ketik BATAL untuk membatalkan."
        ].join("\n"),
        saveResult: null
      };
    }

    pendingMotorLakuByConversation_.set(convoKey, {
      stage: "awaiting_confirm",
      createdAt: Date.now(),
      selected: selected.option,
      hargaLaku: selected.hargaLaku
    });

    return {
      reply:
        "NO " + selected.option.no +
        " akan ditandai terjual harga " + selected.hargaLaku +
        ". OK / BATAL",
      saveResult: null
    };
  }

  if (pending.stage === "awaiting_confirm") {
    if (lower !== "ok") {
      return { reply: "Ketik OK untuk simpan / BATAL untuk batal", saveResult: null };
    }

    const cols = [
      String((pending.selected && pending.selected.no) || "").trim(),
      "",
      String(pending.hargaLaku || "").trim(),
      "",
      "terjual"
    ];
    const updated = await dataService.updateSold(cols, messageMeta);
    pendingMotorLakuByConversation_.delete(convoKey);
    const normalized = normalizeOperationResult_(updated, "Data terupdate");
    return {
      reply: normalized.reply,
      saveResult: normalized.saveResult
    };
  }

  pendingMotorLakuByConversation_.delete(convoKey);
  return { reply: "Sesi motor laku tidak valid. Ketik motor <nama> laku untuk mulai ulang.", saveResult: null };
}

function isMotorMasukCommand_(text) {
  return /^motor\s+masuk$/i.test(String(text || "").trim());
}

function parseMotorLakuKeyword_(text) {
  const m = String(text || "").trim().match(/^motor\s+(.+?)\s+laku$/i);
  if (!m) return null;
  return String(m[1] || "").trim();
}

function parseMotorRowsFromDataReply_(replyText) {
  const text = String(replyText || "").trim();
  if (!text) return [];

  const blocks = text.split(/\n\s*\n/);
  const rows = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = String(blocks[i] || "").trim();
    if (!block) continue;

    const noRaw = extractLabelValue_(block, "NO");
    const nama = extractLabelValue_(block, "NAMA MOTOR");
    const tahun = extractLabelValue_(block, "TAHUN");
    const plat = extractLabelValue_(block, "PLAT");
    const no = String(noRaw || "").replace(/[^\d]/g, "").trim();
    if (!no || !nama) continue;

    rows.push({
      no: no,
      nama: nama,
      tahun: tahun || "-",
      plat: plat || "-"
    });
  }

  return rows;
}

function extractLabelValue_(textBlock, label) {
  const pattern = new RegExp("^\\s*" + escapeRegex_(label) + "\\s*:\\s*(.*)$", "im");
  const m = String(textBlock || "").match(pattern);
  return m ? String(m[1] || "").trim() : "";
}

function escapeRegex_(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatMotorLakuOptionsReply_(keyword, options, totalFound) {
  const lines = [
    'Ditemukan ' + totalFound + ' data motor "' + keyword + '".',
    "Pilih motor yang terjual:"
  ];

  for (let i = 0; i < options.length; i++) {
    const item = options[i];
    const tahun = item.tahun && item.tahun !== "-" ? " " + item.tahun : "";
    lines.push(
      (i + 1) +
      ". NO: " + item.no +
      " - " + item.nama + tahun +
      " - Plat " + (item.plat || "-")
    );
  }

  if (totalFound > options.length) {
    lines.push("");
    lines.push(
      "Daftar dipotong ke " + options.length +
      " baris pertama dari total " + totalFound + " data."
    );
  }

  lines.push("");
  lines.push("Balas: no <pilihan> laku <harga>");
  lines.push("Contoh: no 2 laku 7000000");
  lines.push("Ketik BATAL untuk batal.");
  return lines.join("\n");
}

function parseMotorLakuSelection_(text, options) {
  const m = String(text || "").trim().match(/^no\s+(\d+)\s+laku\s+(.+)$/i);
  if (!m) {
    return { ok: false, error: "Format pilihan tidak sesuai." };
  }

  const rawSelection = Number(m[1]);
  if (!rawSelection || rawSelection < 1) {
    return { ok: false, error: "Nomor pilihan tidak valid." };
  }

  const hargaLaku = normalizeHargaLaku_(m[2]);
  if (!hargaLaku) {
    return { ok: false, error: "Harga laku tidak valid." };
  }

  const list = Array.isArray(options) ? options : [];
  let chosen = null;

  if (rawSelection <= list.length) {
    chosen = list[rawSelection - 1];
  } else {
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].no) === String(rawSelection)) {
        chosen = list[i];
        break;
      }
    }
  }

  if (!chosen) {
    return { ok: false, error: "Pilihan tidak ditemukan di daftar." };
  }

  return {
    ok: true,
    option: chosen,
    hargaLaku: hargaLaku
  };
}

function normalizeHargaLaku_(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d\-.]/g, "");
  if (!cleaned) return "";

  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (Math.round(n) !== n) return String(n);
  return String(Math.trunc(n));
}

function formatMotorMasukSummary_(cols) {
  return [
    "NAMA MOTOR: " + displayValue_(cols[0]),
    "TAHUN: " + displayValue_(cols[1]),
    "PLAT: " + displayValue_(cols[2]),
    "SURAT-SURAT: " + displayValue_(cols[3]),
    "TAHUN PLAT: " + displayValue_(cols[4]),
    "PAJAK: " + displayValue_(cols[5]),
    "HARGA JUAL: " + displayValue_(cols[6]),
    "HARGA BELI: " + displayValue_(cols[8])
  ].join("\n");
}

function displayValue_(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  return s || "-";
}

function getConversationKey_(messageMeta) {
  const meta = messageMeta && typeof messageMeta === "object" ? messageMeta : {};
  const sender = normalizeId_(meta.sender);
  const chat = normalizeId_(meta.chatJid || meta.chat_jid);
  return sender + "|" + chat;
}

function normalizeId_(value) {
  return String(value === undefined || value === null ? "" : value).trim().toLowerCase();
}

function cleanupPendingMotorMasuk_() {
  const now = Date.now();
  const entries = Array.from(pendingMotorMasukByConversation_.entries());
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const key = item[0];
    const state = item[1] || {};
    const createdAt = Number(state.createdAt || 0);
    if (!createdAt || now - createdAt > MOTOR_MASUK_PENDING_TTL_MS) {
      pendingMotorMasukByConversation_.delete(key);
    }
  }
}

function cleanupPendingMotorLaku_() {
  const now = Date.now();
  const entries = Array.from(pendingMotorLakuByConversation_.entries());
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    const key = item[0];
    const state = item[1] || {};
    const createdAt = Number(state.createdAt || 0);
    if (!createdAt || now - createdAt > MOTOR_LAKU_PENDING_TTL_MS) {
      pendingMotorLakuByConversation_.delete(key);
    }
  }
}

module.exports = {
  processIncomingText,
  toWebhookResult
};
