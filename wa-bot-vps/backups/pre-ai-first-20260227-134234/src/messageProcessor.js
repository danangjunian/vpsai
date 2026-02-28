const {
  getSession,
  setSession,
  clearSession,
  normalizeSessionKey
} = require("./sessionStore");

const SINGLE_WORD_STOPWORDS_ = {
  halo: true,
  hai: true,
  hi: true,
  ping: true,
  tes: true,
  test: true,
  menu: true,
  ok: true,
  oke: true,
  batal: true,
  cancel: true
};

const EDIT_LABEL_TO_UPDATE_KEY_ = {
  namamotor: "nama_motor",
  tahun: "tahun",
  plat: "plat",
  suratsurat: "surat_surat",
  tahunplat: "tahun_plat",
  pajak: "pajak",
  hargajual: "harga_jual",
  hargabeli: "harga_beli",
  hargalaku: "harga_laku",
  tglterjual: "tgl_terjual",
  tanggalterjual: "tgl_terjual",
  status: "status"
};

const SOLD_CONFIRMATION_SIGNAL_REGEX_ = /\b(?:sudah\s+terjual|sudah\s+laku|ada\s+yang\s+terjual|terjual|laku)\b/i;
const SOLD_CONFIRMATION_MOTOR_PATTERN_REGEX_ = /\bmotor\b[\w\s-]{0,80}\bterjual\b/i;
const SOLD_CONFIRMATION_NEGATION_REGEX_ = /\b(?:belum|bukan|tidak|gak|ga|nggak)\s+(?:terjual|laku)\b/i;
const MOTOR_NAME_NOISE_TOKENS_ = {
  ada: true,
  dong: true,
  deh: true,
  nih: true,
  ya: true,
  yg: true,
  yang: true
};

const AWARENESS_ACTION_VERB_REGEX_ = /\b(edit|ubah|ganti|hapus|delete|input|tambah|catat|simpan|konfirmasi|confirm|tandai|mark)\b/i;
const AWARENESS_VIEW_VERB_REGEX_ = /\b(cek|lihat|data|info|daftar|tampilkan)\b/i;
const AWARENESS_SOLD_WORD_REGEX_ = /\b(terjual|laku)\b/i;
const AWARENESS_SOLD_CLEAR_ACTION_REGEX_ = /\b(konfirmasi|confirm|tandai|mark)\b|\b(input|isi|set|update)\s+harga\s+laku\b|\bharga\s+laku\b|\blaku\s+\d{4,}\b/i;
const AWARENESS_SOLD_ANNOUNCEMENT_REGEX_ = /\bada\s+motor\s+.+\b(terjual|laku)\b/i;

async function processIncomingText(text, dataService, messageMeta, aiCommandParser) {
  const raw = normalizeText_(text);
  if (!raw) {
    return { reply: "NO_MESSAGE", saveResult: null };
  }

  const sessionKey = normalizeSessionKey(resolveSessionIdentity_(messageMeta));
  const session = sessionKey ? getSession(sessionKey) : null;

  if (session && session.mode) {
    if (isCancelCommand_(raw)) {
      clearSession(sessionKey);
      return { reply: "Oke, proses dibatalkan.", saveResult: null };
    }

    if (session.mode === "awaiting_edit_selection") {
      return await handleEditSelectionSession_(raw, session, dataService, sessionKey);
    }

    if (session.mode === "awaiting_edit_template") {
      return await handleEditTemplateSession_(raw, session, dataService, sessionKey);
    }

    if (session.mode === "awaiting_action_selection") {
      const pickedNo = extractNumericSelection_(raw);
      if (!pickedNo) {
        return { reply: "Yang mana? Sebutkan nomor saja.", saveResult: null };
      }
      return await handleActionSelectionSession_(pickedNo, session, dataService, sessionKey);
    }

    if (session.mode === "awaiting_intent_clarification") {
      return await handleIntentClarificationSession_(raw, session, dataService, sessionKey);
    }

    clearSession(sessionKey);
    return { reply: "Sesi sebelumnya sudah tidak valid. Ulangi perintahnya ya.", saveResult: null };
  }

  if (isNumericOnly_(raw)) {
    return { reply: "Nomor untuk proses apa?", saveResult: null };
  }

  let parsed = await parseIntent_(raw, aiCommandParser);
  if (!parsed || !parsed.intent) {
    if (isGreeting_(raw)) {
      return { reply: "ARJUN MOTOR disini.. ada yang bisa dibantu?", saveResult: null };
    }
    return { reply: "Maaf, perintah belum jelas. Bisa dijelaskan lagi?", saveResult: null };
  }

  const awareness = applyIntentAwarenessLayer_(raw, parsed);
  if (awareness && awareness.parsed) {
    parsed = awareness.parsed;
  }
  if (awareness && awareness.shouldClarify) {
    const clarifyName = String(awareness.motorName || parsed.name || "").trim();
    if (sessionKey) {
      setSession(sessionKey, {
        mode: "awaiting_intent_clarification",
        basePayload: {
          entity: "motor",
          name: clarifyName,
          no: normalizeNo_(parsed.no || ""),
          status: "terjual"
        },
        awareness: {
          confidence: awareness.confidence,
          level: awareness.level
        }
      });
    }
    return {
      reply: buildSoldIntentClarificationReply_(clarifyName),
      saveResult: null
    };
  }
  if (awareness && awareness.shouldFallback) {
    return { reply: "Maaf, perintah belum jelas. Bisa dijelaskan lagi?", saveResult: null };
  }

  if (parsed.need_clarification) {
    const question = String(parsed.clarification_question || "").trim();
    return { reply: question || "Boleh diperjelas dulu maksudnya?", saveResult: null };
  }

  const payload = buildPayloadFromIntent_(parsed);
  const intentKind = normalizeIntentKind_(String(parsed.intent || payload.intent || ""));

  if (!payload.intent && intentKind !== "UNKNOWN") {
    return { reply: "Maaf, perintah belum jelas. Bisa dijelaskan lagi?", saveResult: null };
  }

  if (intentKind === "CEK_DATA") {
    return await handleCekDataIntent_(payload, dataService, sessionKey);
  }

  if (intentKind === "EDIT_DATA") {
    return await handleEditDataIntent_(raw, payload, dataService, sessionKey);
  }

  const response = await executeDataSafe_(dataService, payload);
  return handleDataResponse_(response, payload, sessionKey);
}

function resolveSessionIdentity_(messageMeta) {
  const meta = messageMeta && typeof messageMeta === "object" ? messageMeta : {};
  return String(meta.sender || meta.chatJid || meta.chat_jid || "").trim();
}

async function parseIntent_(text, aiCommandParser) {
  const heuristic = heuristicParseIntent_(text);
  if (!aiCommandParser || typeof aiCommandParser.parseToIntent !== "function") return heuristic;
  if (typeof aiCommandParser.isEnabled === "function" && !aiCommandParser.isEnabled()) return heuristic;

  try {
    const ai = await aiCommandParser.parseToIntent(text, {
      heuristic: heuristic
    });
    if (ai && ai.intent) {
      const aiKind = normalizeIntentKind_(ai.intent);
      const heuristicKind = normalizeIntentKind_(heuristic.intent);
      if (aiKind === "UNKNOWN" && heuristicKind !== "UNKNOWN") {
        return heuristic;
      }
      return ai;
    }
  } catch (err) {
    // fallback ke heuristic
  }

  return heuristic;
}

function heuristicParseIntent_(text) {
  const raw = normalizeText_(text);
  const lower = raw.toLowerCase();
  const motorNameCandidate = extractMotorNameCandidate_(lower);
  const result = {
    intent: "",
    entity: "",
    name: "",
    no: "",
    status: "",
    filters: {},
    updates: {},
    confidence: 0.3,
    need_clarification: false,
    clarification_question: ""
  };

  if (!raw) return result;

  if (/\b(pengeluaran|expense|biaya)\b/.test(lower)) {
    result.entity = "expense";
  } else {
    result.entity = "motor";
  }

  if (
    result.entity === "motor" &&
    hasKonfirmasiTerjualSignal_(lower) &&
    hasValidMotorNameForSoldIntent_(motorNameCandidate)
  ) {
    result.intent = "KONFIRMASI_TERJUAL";
    result.status = "terjual";
    result.name = motorNameCandidate;
    result.confidence = 0.75;
  } else if (/\b(hapus|delete|hapuskan)\b/.test(lower)) {
    result.intent = "DELETE_DATA";
  } else if (/\b(edit|ubah|ganti|koreksi|revisi)\b/.test(lower)) {
    result.intent = "EDIT_DATA";
  } else if (/\b(tambah|input|catat|simpan|masuk)\b/.test(lower)) {
    result.intent = "ADD_DATA";
  } else if (/\b(tandai|mark)\b/.test(lower) && /\b(terjual|laku)\b/.test(lower)) {
    result.intent = "MARK_SOLD";
  } else if (/\b(cek|lihat|info|data|stok|berapa|daftar)\b/.test(lower)) {
    result.intent = "CEK_DATA";
  }

  if (/\b(terjual|laku)\b/.test(lower)) result.status = "terjual";
  if (/\b(stok|aktif|belum terjual|unsold)\b/.test(lower)) result.status = "belum_terjual";

  result.no = extractNo_(lower);
  if (result.entity === "motor" && !result.name) {
    result.name = motorNameCandidate;
  }

  if (!result.intent && looksLikeSingleWordMotorQuery_(lower)) {
    result.intent = "CEK_DATA";
    result.entity = "motor";
    result.name = lower.trim();
    result.confidence = 0.45;
  }

  return result;
}

function buildPayloadFromIntent_(intent) {
  const src = intent || {};
  const rawIntent = String(src.intent || "").trim();
  const payload = {
    intent: normalizeIntentForExecutor_(rawIntent),
    entity: String(src.entity || "").trim(),
    name: String(src.name || "").trim(),
    no: normalizeNo_(src.no || ""),
    status: String(src.status || "").trim(),
    filters: src.filters && typeof src.filters === "object" ? src.filters : {},
    updates: src.updates && typeof src.updates === "object" ? src.updates : {}
  };
  if (!payload.entity && payload.intent) payload.entity = "motor";
  return payload;
}

function normalizeIntentKind_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^\w]+/g, "_");
  if (token === "GET_DATA" || token === "CEK_DATA") return "CEK_DATA";
  if (token === "EDIT_DATA") return "EDIT_DATA";
  if (token === "ADD_DATA") return "ADD_DATA";
  if (token === "DELETE_DATA") return "DELETE_DATA";
  if (token === "MARK_SOLD" || token === "KONFIRMASI_TERJUAL") return "MARK_SOLD";
  return "UNKNOWN";
}

function normalizeIntentForExecutor_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^\w]+/g, "_");
  if (!token || token === "UNKNOWN") return "";
  if (token === "CEK_DATA" || token === "GET_DATA") return "GET_DATA";
  if (token === "EDIT_DATA") return "EDIT_DATA";
  if (token === "ADD_DATA") return "ADD_DATA";
  if (token === "DELETE_DATA") return "DELETE_DATA";
  if (token === "MARK_SOLD" || token === "KONFIRMASI_TERJUAL") return "MARK_SOLD";
  return "";
}

async function handleCekDataIntent_(payload, dataService, sessionKey) {
  const queryPayload = Object.assign({}, payload, {
    intent: "GET_DATA",
    entity: payload.entity || "motor"
  });

  if (shouldExpandGlobalSingleWordQuery_(queryPayload)) {
    queryPayload.limit = 200;
  }

  const response = await executeDataSafe_(dataService, queryPayload);
  const res = response && typeof response === "object" ? response : {};
  const status = String(res.status || "").trim().toUpperCase();

  if (sessionKey) clearSession(sessionKey);

  if (status === "SINGLE") {
    return { reply: formatSingleReply_("GET_DATA", queryPayload.entity, res.data), saveResult: null };
  }

  if (status === "MULTIPLE") {
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) return { reply: notFoundReply_(queryPayload.entity), saveResult: null };

    if (queryPayload.entity === "motor" && shouldExpandGlobalSingleWordQuery_(queryPayload)) {
      const details = await fetchDetailRowsForCek_(list, queryPayload.entity, dataService);
      return {
        reply: formatCekExpandedReply_(queryPayload.entity, details, list),
        saveResult: null
      };
    }

    return {
      reply: formatCekSummaryReply_(queryPayload.entity, list),
      saveResult: null
    };
  }

  if (status === "NOT_FOUND") {
    return { reply: notFoundReply_(queryPayload.entity), saveResult: null };
  }

  if (status === "ERROR") {
    return { reply: String(res.error || "Terjadi error di server.").trim(), saveResult: null };
  }

  return { reply: "Terjadi error. Coba lagi nanti.", saveResult: null };
}

async function handleEditDataIntent_(rawText, payload, dataService, sessionKey) {
  const entity = String(payload.entity || "motor").toLowerCase();
  if (entity !== "motor") {
    const response = await executeDataSafe_(dataService, Object.assign({}, payload, { intent: "EDIT_DATA" }));
    return handleDataResponse_(response, payload, sessionKey);
  }

  const directNo = normalizeNo_(payload.no);
  const hasUpdates = hasAnyUpdateValue_(payload.updates);

  // Jika user sudah kirim NO + updates lengkap, eksekusi langsung.
  if (directNo && hasUpdates) {
    const directPayload = Object.assign({}, payload, {
      intent: "EDIT_DATA",
      entity: "motor",
      no: directNo
    });
    const response = await executeDataSafe_(dataService, directPayload);
    return handleEditExecutionResponse_(response, sessionKey, true);
  }

  // Alur edit by selection: cari target dulu via GET_DATA.
  const lookupPayload = {
    intent: "GET_DATA",
    entity: "motor",
    name: String(payload.name || "").trim(),
    no: directNo,
    status: String(payload.status || "").trim(),
    filters: payload.filters && typeof payload.filters === "object" ? payload.filters : {},
    limit: 200
  };

  const lookupResponse = await executeDataSafe_(dataService, lookupPayload);
  const res = lookupResponse && typeof lookupResponse === "object" ? lookupResponse : {};
  const status = String(res.status || "").trim().toUpperCase();

  if (status === "NOT_FOUND") {
    if (sessionKey) clearSession(sessionKey);
    return { reply: notFoundReply_("motor"), saveResult: null };
  }

  if (status === "ERROR") {
    if (sessionKey) clearSession(sessionKey);
    return { reply: String(res.error || "Terjadi error di server.").trim(), saveResult: null };
  }

  if (status === "SINGLE") {
    const detail = res.data && typeof res.data === "object" ? res.data : {};
    const selectedNo = normalizeNo_(detail.no || directNo);
    if (!selectedNo) {
      if (sessionKey) clearSession(sessionKey);
      return { reply: "NO motor tidak terbaca. Ulangi perintah edit data.", saveResult: null };
    }

    if (sessionKey) {
      setSession(sessionKey, {
        mode: "awaiting_edit_template",
        intent: "EDIT_DATA",
        entity: "motor",
        selectedNo: selectedNo,
        candidateList: [],
        pendingPayload: {
          intent: "EDIT_DATA",
          entity: "motor",
          no: selectedNo,
          updates: {}
        }
      });
    }

    return {
      reply: buildMotorEditTemplateReply_(detail),
      saveResult: null
    };
  }

  if (status === "MULTIPLE") {
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) {
      if (sessionKey) clearSession(sessionKey);
      return { reply: notFoundReply_("motor"), saveResult: null };
    }

    if (sessionKey) {
      setSession(sessionKey, {
        mode: "awaiting_edit_selection",
        intent: "EDIT_DATA",
        entity: "motor",
        selectedNo: null,
        candidateList: list,
        pendingPayload: {
          intent: "EDIT_DATA",
          entity: "motor",
          no: "",
          updates: {}
        }
      });
    }

    return {
      reply: formatEditSelectionReply_(list),
      saveResult: null
    };
  }

  if (sessionKey) clearSession(sessionKey);
  return { reply: "Terjadi error. Coba lagi nanti.", saveResult: null };
}

async function handleEditSelectionSession_(rawText, session, dataService, sessionKey) {
  const pickedNo = extractNumericSelection_(rawText);
  if (!pickedNo) {
    return { reply: "Pilih NO motor yang mau diedit.", saveResult: null };
  }

  const normalizedPicked = normalizeNo_(pickedNo);
  const candidates = Array.isArray(session.candidateList) ? session.candidateList : [];
  const selected = candidates.find(function (item) {
    return normalizeNo_(item && item.no) === normalizedPicked;
  });

  if (!selected) {
    return { reply: "NO tidak ada di daftar. Pilih NO yang tersedia.", saveResult: null };
  }

  const detailResponse = await executeDataSafe_(dataService, {
    intent: "GET_DATA",
    entity: "motor",
    no: normalizedPicked
  });
  const status = String(detailResponse && detailResponse.status || "").trim().toUpperCase();
  if (status !== "SINGLE") {
    return { reply: "Gagal ambil detail motor terpilih. Coba lagi.", saveResult: null };
  }

  const detail = detailResponse.data && typeof detailResponse.data === "object"
    ? detailResponse.data
    : {};
  const selectedNo = normalizeNo_(detail.no || normalizedPicked);
  if (!selectedNo) {
    return { reply: "NO motor tidak valid. Coba pilih ulang.", saveResult: null };
  }

  if (sessionKey) {
    setSession(sessionKey, {
      mode: "awaiting_edit_template",
      intent: "EDIT_DATA",
      entity: "motor",
      selectedNo: selectedNo,
      candidateList: [],
      pendingPayload: {
        intent: "EDIT_DATA",
        entity: "motor",
        no: selectedNo,
        updates: {}
      }
    });
  }

  return {
    reply: buildMotorEditTemplateReply_(detail),
    saveResult: null
  };
}

async function handleEditTemplateSession_(rawText, session, dataService, sessionKey) {
  const selectedNo = normalizeNo_(session && session.selectedNo);
  if (!selectedNo) {
    if (sessionKey) clearSession(sessionKey);
    return { reply: "Sesi edit tidak valid. Ulangi perintah edit data.", saveResult: null };
  }

  const parsed = parseMotorEditTemplate_(rawText);
  if (!parsed.ok) {
    return {
      reply: parsed.error + "\n\n" + buildEditTemplateHelpText_(),
      saveResult: null
    };
  }

  if (parsed.no && normalizeNo_(parsed.no) !== selectedNo) {
    return {
      reply: "NO pada template tidak sesuai. Gunakan NO: " + selectedNo,
      saveResult: null
    };
  }

  const execPayload = {
    intent: "EDIT_DATA",
    entity: "motor",
    no: selectedNo,
    updates: parsed.updates
  };

  const response = await executeDataSafe_(dataService, execPayload);
  return handleEditExecutionResponse_(response, sessionKey, false);
}

function handleEditExecutionResponse_(response, sessionKey, clearOnError) {
  const res = response && typeof response === "object" ? response : {};
  const status = String(res.status || "").trim().toUpperCase();

  if (status === "SINGLE") {
    if (sessionKey) clearSession(sessionKey);
    return { reply: "Siap, data motor berhasil diperbarui.", saveResult: null };
  }

  if (status === "NOT_FOUND") {
    if (sessionKey) clearSession(sessionKey);
    return { reply: notFoundReply_("motor"), saveResult: null };
  }

  if (status === "ERROR") {
    if (clearOnError && sessionKey) clearSession(sessionKey);
    return { reply: String(res.error || "Gagal update data motor.").trim(), saveResult: null };
  }

  if (clearOnError && sessionKey) clearSession(sessionKey);
  return { reply: "Terjadi error. Coba lagi nanti.", saveResult: null };
}

async function handleActionSelectionSession_(pickedNo, session, dataService, sessionKey) {
  const candidates = Array.isArray(session.candidateList) ? session.candidateList : [];
  if (!candidates.length) {
    clearSession(sessionKey);
    return { reply: "Daftar pilihan sudah kosong. Ulangi perintah ya.", saveResult: null };
  }

  const normalizedPicked = normalizeNo_(pickedNo);
  const selected = candidates.find(function (item) {
    return normalizeNo_(item && item.no) === normalizedPicked;
  });

  if (!selected) {
    return { reply: "Nomor tidak ada di daftar. Sebutkan NO yang tersedia.", saveResult: null };
  }

  const basePayload = session.pendingPayload && typeof session.pendingPayload === "object"
    ? session.pendingPayload
    : {
      intent: session.intent,
      entity: session.entity,
      filters: session.filters || {}
    };

  const payload = Object.assign({}, basePayload, { no: normalizedPicked });
  const response = await executeDataSafe_(dataService, payload);
  return handleDataResponse_(response, payload, sessionKey);
}

async function handleIntentClarificationSession_(rawText, session, dataService, sessionKey) {
  const choice = resolveIntentClarificationChoice_(rawText);
  if (!choice) {
    const base = session && session.basePayload && typeof session.basePayload === "object"
      ? session.basePayload
      : {};
    return {
      reply: buildSoldIntentClarificationReply_(String(base.name || "").trim()) + "\nBalas 1 atau 2.",
      saveResult: null
    };
  }

  const base = session && session.basePayload && typeof session.basePayload === "object"
    ? session.basePayload
    : {};
  const name = String(base.name || "").trim();
  const no = normalizeNo_(base.no || "");

  if (sessionKey) clearSession(sessionKey);

  if (choice === 1) {
    return await handleCekDataIntent_({
      intent: "GET_DATA",
      entity: "motor",
      name: name,
      no: no,
      status: "terjual",
      filters: {},
      updates: {}
    }, dataService, sessionKey);
  }

  const payload = {
    intent: "MARK_SOLD",
    entity: "motor",
    name: name,
    no: no,
    status: "terjual",
    filters: {},
    updates: {}
  };
  const response = await executeDataSafe_(dataService, payload);
  return handleDataResponse_(response, payload, sessionKey);
}

async function executeDataSafe_(dataService, payload) {
  if (!dataService || typeof dataService.executeData !== "function") {
    return { status: "ERROR", error: "DATA_SERVICE_UNAVAILABLE" };
  }
  try {
    return await dataService.executeData(payload);
  } catch (err) {
    return { status: "ERROR", error: String(err && err.message ? err.message : err) };
  }
}

function handleDataResponse_(response, payload, sessionKey) {
  const res = response && typeof response === "object" ? response : {};
  const status = String(res.status || "").trim().toUpperCase();

  if (status === "MULTIPLE") {
    const list = Array.isArray(res.data) ? res.data : [];
    if (!list.length) {
      if (sessionKey) clearSession(sessionKey);
      return { reply: notFoundReply_(payload.entity), saveResult: null };
    }

    if (sessionKey) {
      setSession(sessionKey, {
        mode: "awaiting_action_selection",
        intent: payload.intent,
        entity: payload.entity,
        filters: payload.filters || {},
        candidateList: list,
        selectedNo: null,
        pendingPayload: payload
      });
    }

    return {
      reply: formatMultipleReply_(payload.entity, list),
      saveResult: null
    };
  }

  if (status === "SINGLE") {
    if (sessionKey) clearSession(sessionKey);
    return {
      reply: formatSingleReply_(payload.intent, payload.entity, res.data),
      saveResult: null
    };
  }

  if (status === "NOT_FOUND") {
    if (sessionKey) clearSession(sessionKey);
    return { reply: notFoundReply_(payload.entity), saveResult: null };
  }

  if (status === "ERROR") {
    if (sessionKey) clearSession(sessionKey);
    return {
      reply: String(res.error || "Terjadi error di server.").trim(),
      saveResult: null
    };
  }

  if (sessionKey) clearSession(sessionKey);
  return {
    reply: "Terjadi error. Coba lagi nanti.",
    saveResult: null
  };
}

async function fetchDetailRowsForCek_(list, entity, dataService) {
  const details = [];
  const items = Array.isArray(list) ? list : [];

  for (let i = 0; i < items.length; i++) {
    const no = normalizeNo_(items[i] && items[i].no);
    if (!no) {
      details.push(null);
      continue;
    }

    const detailRes = await executeDataSafe_(dataService, {
      intent: "GET_DATA",
      entity: entity,
      no: no
    });
    const status = String(detailRes && detailRes.status || "").trim().toUpperCase();
    if (status === "SINGLE" && detailRes.data && typeof detailRes.data === "object") {
      details.push(detailRes.data);
    } else {
      details.push(null);
    }
  }

  return details;
}

function shouldExpandGlobalSingleWordQuery_(payload) {
  if (!payload || String(payload.entity || "").toLowerCase() !== "motor") return false;
  if (normalizeNo_(payload.no)) return false;

  const name = String(payload.name || "").trim();
  const tokens = splitTokens_(name);
  if (tokens.length !== 1) return false;
  return tokens[0].length >= 2;
}

function formatCekExpandedReply_(entity, details, fallbackList) {
  const e = String(entity || "").toLowerCase();
  const blocks = [];
  const detailRows = Array.isArray(details) ? details : [];
  const listRows = Array.isArray(fallbackList) ? fallbackList : [];

  for (let i = 0; i < detailRows.length; i++) {
    const detail = detailRows[i];
    if (detail && typeof detail === "object") {
      if (e === "expense") {
        blocks.push(formatExpenseDetailBlock_(detail));
      } else {
        blocks.push(formatMotorDetailBlock_(detail));
      }
      continue;
    }

    const item = listRows[i] || {};
    if (e === "expense") {
      blocks.push(
        [
          "NO: " + displayCell_(item.no),
          "Tanggal: " + displayCell_(item.tanggal),
          "Keterangan: " + displayCell_(item.keterangan),
          "Total pengeluaran: Rp" + formatRupiah_(item.total_pengeluaran || 0)
        ].join("\n")
      );
    } else {
      blocks.push(
        [
          "NO: " + displayCell_(item.no),
          "Nama: " + displayCell_(item.nama),
          "Plat: " + displayCell_(item.plat)
        ].join("\n")
      );
    }
  }

  if (!blocks.length) return notFoundReply_(entity);
  return ["Data ditemukan:", "", blocks.join("\n\n")].join("\n");
}

function formatCekSummaryReply_(entity, list) {
  const e = String(entity || "").toLowerCase();
  const items = Array.isArray(list) ? list : [];
  const lines = ["Data ditemukan:"];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    if (e === "expense") {
      lines.push(
        "NO " + displayCell_(item.no) +
        " | " + displayCell_(item.tanggal) +
        " | " + displayCell_(item.keterangan) +
        " | Rp" + formatRupiah_(item.total_pengeluaran || 0)
      );
    } else {
      lines.push(
        "NO " + displayCell_(item.no) +
        " | " + displayCell_(item.nama) +
        " | Plat " + displayCell_(item.plat)
      );
    }
  }

  lines.push("");
  lines.push("Jika data terlalu banyak, kirim nama motor lebih spesifik.");
  return lines.join("\n");
}

function formatEditSelectionReply_(list) {
  const items = Array.isArray(list) ? list : [];
  const lines = ["Ditemukan beberapa data motor. Pilih NO yang mau diedit:"];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    lines.push(
      "NO " + displayCell_(item.no) +
      " | " + displayCell_(item.nama) +
      " | Plat " + displayCell_(item.plat)
    );
  }

  lines.push("");
  lines.push("Ketik NO motor yang dipilih.");
  return lines.join("\n");
}

function buildMotorEditTemplateReply_(detail) {
  const d = detail && typeof detail === "object" ? detail : {};
  return [
    "Template edit data motor:",
    "NO: " + displayCell_(d.no),
    "NAMA MOTOR: " + displayCell_(d.nama),
    "TAHUN: " + displayCell_(d.tahun),
    "PLAT: " + displayCell_(d.plat),
    "SURAT-SURAT: " + displayCell_(d.surat_surat),
    "TAHUN PLAT: " + displayCell_(d.tahun_plat),
    "PAJAK: " + displayCell_(d.pajak),
    "HARGA JUAL: " + formatMaybeCurrency_(d.harga_jual),
    "HARGA BELI: " + formatMaybeCurrency_(d.harga_beli),
    "",
    "Edit nilai yang perlu lalu kirim ulang template ini.",
    "Ketik BATAL untuk batalkan."
  ].join("\n");
}

function parseMotorEditTemplate_(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const updates = {};
  let recognized = 0;
  let templateNo = "";

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "");
    const m = line.match(/^\s*[-*]?\s*([A-Za-z0-9 _\/-]+?)\s*:\s*(.*)\s*$/);
    if (!m) continue;

    const labelRaw = String(m[1] || "").trim();
    const valueRaw = String(m[2] || "").trim();
    if (!labelRaw) continue;

    const key = normalizeLabelKey_(labelRaw);
    if (key === "no" || key === "nomor") {
      templateNo = normalizeNo_(valueRaw);
      recognized++;
      continue;
    }

    const updateKey = EDIT_LABEL_TO_UPDATE_KEY_[key];
    if (!updateKey) continue;
    recognized++;

    if (!isMeaningfulTemplateValue_(valueRaw)) continue;
    if (updateKey === "harga_jual" || updateKey === "harga_beli" || updateKey === "harga_laku") {
      const parsedNumber = parseLooseNumber_(valueRaw);
      if (parsedNumber === null) {
        return { ok: false, error: "Nilai angka tidak valid pada field " + labelRaw + "." };
      }
      updates[updateKey] = parsedNumber;
      continue;
    }

    updates[updateKey] = valueRaw;
  }

  if (!recognized) {
    return { ok: false, error: "Format template belum terbaca." };
  }

  if (!hasAnyUpdateValue_(updates)) {
    return { ok: false, error: "Belum ada nilai yang diubah pada template." };
  }

  return { ok: true, no: templateNo, updates: updates };
}

function buildEditTemplateHelpText_() {
  return [
    "Gunakan format label seperti ini:",
    "NO:",
    "NAMA MOTOR:",
    "TAHUN:",
    "PLAT:",
    "SURAT-SURAT:",
    "TAHUN PLAT:",
    "PAJAK:",
    "HARGA JUAL:",
    "HARGA BELI:"
  ].join("\n");
}

function isMeaningfulTemplateValue_(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v === "-" || v === "x" || v === "_") return false;
  return true;
}

function normalizeLabelKey_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function hasAnyUpdateValue_(updates) {
  const obj = updates && typeof updates === "object" ? updates : {};
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const val = obj[keys[i]];
    if (val === null || val === undefined) continue;
    if (typeof val === "number" && isFinite(val)) return true;
    if (String(val).trim() !== "") return true;
  }
  return false;
}

function parseLooseNumber_(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/\./g, "").replace(",", ".").replace(/[^\d\-\.]/g, "");
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  return n;
}

function formatMultipleReply_(entity, list) {
  const items = Array.isArray(list) ? list : [];
  const lines = ["Data ditemukan:"];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    if (entity === "expense") {
      lines.push(
        "NO " + displayCell_(item.no) +
        " | " + displayCell_(item.tanggal) +
        " | " + displayCell_(item.keterangan) +
        " | Rp" + formatRupiah_(item.total_pengeluaran || 0)
      );
    } else {
      lines.push(
        "NO " + displayCell_(item.no) +
        " | " + displayCell_(item.nama) +
        " | Plat " + displayCell_(item.plat)
      );
    }
  }
  lines.push("", "Sebutkan NO yang dipilih.");
  return lines.join("\n");
}

function formatSingleReply_(intent, entity, data) {
  const i = String(intent || "").toUpperCase();
  const e = String(entity || "").toLowerCase();
  const d = data && typeof data === "object" ? data : {};

  if (i === "ADD_DATA") {
    if (e === "expense") return "Siap, pengeluaran berhasil dicatat.";
    return "Siap, data motor berhasil ditambahkan.";
  }
  if (i === "EDIT_DATA") {
    if (e === "expense") return "Siap, data pengeluaran berhasil diperbarui.";
    return "Siap, data motor berhasil diperbarui.";
  }
  if (i === "DELETE_DATA") {
    if (e === "expense") return "Siap, data pengeluaran sudah dihapus.";
    return "Siap, data motor sudah dihapus.";
  }
  if (i === "MARK_SOLD") {
    return "Siap, motor berhasil ditandai terjual.";
  }

  if (e === "expense") {
    return formatExpenseDetailBlock_(d, true);
  }

  return formatMotorDetailBlock_(d, true);
}

function formatExpenseDetailBlock_(d, withHeader) {
  const lines = [];
  if (withHeader) lines.push("Detail pengeluaran:");
  lines.push("NO: " + displayCell_(d.no));
  lines.push("Tanggal: " + displayCell_(d.tanggal));
  lines.push("Keterangan: " + displayCell_(d.keterangan));
  lines.push("Total pengeluaran: Rp" + formatRupiah_(d.total_pengeluaran || 0));
  return lines.join("\n");
}

function formatMotorDetailBlock_(d, withHeader) {
  const lines = [];
  if (withHeader) lines.push("Detail motor:");
  lines.push("NO: " + displayCell_(d.no));
  lines.push("Nama: " + displayCell_(d.nama));
  lines.push("Tahun: " + displayCell_(d.tahun));
  lines.push("Plat: " + displayCell_(d.plat));
  lines.push("Surat-surat: " + displayCell_(d.surat_surat));
  lines.push("Tahun plat: " + displayCell_(d.tahun_plat));
  lines.push("Pajak: " + displayCell_(d.pajak));
  lines.push("Status: " + displayCell_(d.status));
  lines.push("Harga jual: " + formatMaybeCurrency_(d.harga_jual));
  lines.push("Harga beli: " + formatMaybeCurrency_(d.harga_beli));
  lines.push("Harga laku: " + formatMaybeCurrency_(d.harga_laku));
  lines.push("Tanggal terjual: " + displayCell_(d.tgl_terjual));
  return lines.join("\n");
}

function notFoundReply_(entity) {
  return entity === "expense"
    ? "Data pengeluaran yang kamu maksud belum ditemukan."
    : "Data motor yang kamu maksud belum ditemukan.";
}

function applyIntentAwarenessLayer_(rawText, parsed) {
  const src = parsed && typeof parsed === "object" ? Object.assign({}, parsed) : {};
  const lower = normalizeText_(rawText).toLowerCase();
  const signals = collectIntentAwarenessSignals_(lower, src);
  const confidence = computeIntentAwarenessConfidence_(src, signals);
  const level = confidence >= 0.7 ? "high" : (confidence >= 0.4 ? "medium" : "low");

  if (!signals.isMotorContext || !signals.hasSoldWord) {
    return {
      parsed: src,
      confidence: confidence,
      level: level,
      shouldClarify: false,
      shouldFallback: false,
      motorName: signals.motorName
    };
  }

  if (signals.hasClearSoldAction || signals.hasSoldAnnouncement) {
    src.intent = "KONFIRMASI_TERJUAL";
    src.entity = "motor";
    src.status = "terjual";
    if (signals.motorName) src.name = signals.motorName;
    return {
      parsed: src,
      confidence: Math.max(confidence, 0.7),
      level: "high",
      shouldClarify: false,
      shouldFallback: false,
      motorName: signals.motorName
    };
  }

  if (signals.hasViewVerb) {
    src.intent = "CEK_DATA";
    src.entity = "motor";
    src.status = "terjual";
    if (signals.motorName) src.name = signals.motorName;
    return {
      parsed: src,
      confidence: Math.max(confidence, 0.7),
      level: "high",
      shouldClarify: false,
      shouldFallback: false,
      motorName: signals.motorName
    };
  }

  if (signals.hasAmbiguousSoldConflict) {
    return {
      parsed: src,
      confidence: Math.max(confidence, 0.4),
      level: "medium",
      shouldClarify: true,
      shouldFallback: false,
      motorName: signals.motorName
    };
  }

  if (level === "low") {
    return {
      parsed: src,
      confidence: confidence,
      level: level,
      shouldClarify: false,
      shouldFallback: true,
      motorName: signals.motorName
    };
  }

  return {
    parsed: src,
    confidence: confidence,
    level: level,
    shouldClarify: false,
    shouldFallback: false,
    motorName: signals.motorName
  };
}

function collectIntentAwarenessSignals_(textLower, parsed) {
  const text = String(textLower || "").trim().toLowerCase();
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const intentKind = normalizeIntentKind_(src.intent || "");
  const parsedEntity = String(src.entity || "").trim().toLowerCase();
  const rawMotorName = String(src.name || "").trim() || extractMotorNameCandidate_(text);
  const motorName = sanitizeMotorNameForIntent_(rawMotorName);
  const hasValidMotorName = hasValidMotorNameForSoldIntent_(motorName);
  const hasActionVerb = AWARENESS_ACTION_VERB_REGEX_.test(text);
  const hasViewVerb = AWARENESS_VIEW_VERB_REGEX_.test(text);
  const hasSoldWord = AWARENESS_SOLD_WORD_REGEX_.test(text);
  const hasClearSoldAction = AWARENESS_SOLD_CLEAR_ACTION_REGEX_.test(text);
  const hasSoldAnnouncement = AWARENESS_SOLD_ANNOUNCEMENT_REGEX_.test(text);
  const isMotorContext = parsedEntity === "motor" || intentKind === "MARK_SOLD" || text.indexOf("motor") !== -1;
  const hasAmbiguousSoldConflict = Boolean(
    isMotorContext &&
    hasSoldWord &&
    hasValidMotorName &&
    !hasClearSoldAction &&
    !hasViewVerb &&
    !hasSoldAnnouncement
  );

  return {
    intentKind: intentKind,
    motorName: motorName,
    hasValidMotorName: hasValidMotorName,
    hasActionVerb: hasActionVerb,
    hasViewVerb: hasViewVerb,
    hasSoldWord: hasSoldWord,
    hasClearSoldAction: hasClearSoldAction,
    hasSoldAnnouncement: hasSoldAnnouncement,
    isMotorContext: isMotorContext,
    hasAmbiguousSoldConflict: hasAmbiguousSoldConflict
  };
}

function computeIntentAwarenessConfidence_(parsed, signals) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const s = signals && typeof signals === "object" ? signals : {};
  let score = 0.2;

  if (s.hasValidMotorName) score += 0.25;
  if (s.hasActionVerb) score += 0.25;
  if (s.hasViewVerb) score += 0.25;
  if (s.hasSoldWord) score += 0.15;
  if (s.hasClearSoldAction) score += 0.1;
  if (s.hasSoldAnnouncement) score += 0.1;
  if (normalizeNo_(src.no || "")) score += 0.05;
  if (s.hasAmbiguousSoldConflict) score -= 0.1;
  if (s.hasSoldWord && !s.hasValidMotorName && !s.hasViewVerb && !s.hasActionVerb) score -= 0.2;

  if (score < 0) return 0;
  if (score > 1) return 1;
  return Number(score.toFixed(2));
}

function buildSoldIntentClarificationReply_(motorName) {
  const name = String(motorName || "").trim();
  const targetText = name ? ("motor " + name) : "motor";
  return [
    "Apakah maksud kamu:",
    "1. Melihat data " + targetText + " yang sudah terjual",
    "2. Mengonfirmasi " + targetText + " telah terjual"
  ].join("\n");
}

function resolveIntentClarificationChoice_(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return 0;

  if (/^(1|satu)\b/.test(raw)) return 1;
  if (/^(2|dua)\b/.test(raw)) return 2;

  const n = extractNumericSelection_(raw);
  if (n === "1") return 1;
  if (n === "2") return 2;

  if (/\b(cek|lihat|data|info)\b/.test(raw)) return 1;
  if (/\b(konfirmasi|confirm|tandai|terjual|laku)\b/.test(raw)) return 2;
  return 0;
}

function extractNumericSelection_(text) {
  const t = normalizeText_(text);
  const m = t.match(/\d{1,8}/);
  return m ? String(m[0]) : "";
}

function extractNo_(text) {
  const m = String(text || "").match(/\b(?:no|nomor)\D*(\d{1,8})\b/);
  if (m) return m[1];
  const any = String(text || "").match(/\d{1,8}/);
  return any ? any[0] : "";
}

function extractMotorNameCandidate_(textLower) {
  const raw = String(textLower || "").trim();
  if (!raw) return "";

  const byMotor = raw.match(/\bmotor\s+(.+)$/);
  if (byMotor && byMotor[1]) {
    return cleanupNameCandidate_(byMotor[1]);
  }

  return cleanupNameCandidate_(raw);
}

function cleanupNameCandidate_(raw) {
  return String(raw || "")
    .replace(/\b(cek|data|edit|harga|jual|laku|terjual|stok|motor|yang|sudah|belum|aktif|hapus|delete|tambah|input|catat|simpan|ubah|ganti|koreksi|revisi|tandai|mark)\b/g, " ")
    .replace(/\b(no|nomor)\b\s*\d+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKonfirmasiTerjualSignal_(textLower) {
  const text = String(textLower || "").trim().toLowerCase();
  if (!text) return false;
  if (SOLD_CONFIRMATION_NEGATION_REGEX_.test(text)) return false;
  return SOLD_CONFIRMATION_SIGNAL_REGEX_.test(text) || SOLD_CONFIRMATION_MOTOR_PATTERN_REGEX_.test(text);
}

function hasValidMotorNameForSoldIntent_(name) {
  const candidate = String(name || "").trim().toLowerCase();
  if (!candidate) return false;
  if (/^\d+$/.test(candidate)) return false;

  const tokens = splitTokens_(candidate);
  if (!tokens.length) return false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (MOTOR_NAME_NOISE_TOKENS_[token]) continue;
    if (token.length < 2) continue;
    if (!/[a-z0-9]/.test(token)) continue;
    return true;
  }

  return false;
}

function sanitizeMotorNameForIntent_(name) {
  const tokens = splitTokens_(String(name || "").toLowerCase());
  if (!tokens.length) return "";

  const cleaned = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (MOTOR_NAME_NOISE_TOKENS_[token]) continue;
    if (!/[a-z0-9]/.test(token)) continue;
    cleaned.push(token);
  }
  return cleaned.join(" ").trim();
}

function looksLikeSingleWordMotorQuery_(lowerText) {
  const text = String(lowerText || "").trim();
  if (!text) return false;
  if (text.indexOf(" ") !== -1) return false;
  if (SINGLE_WORD_STOPWORDS_[text]) return false;
  if (text.length < 2) return false;
  return /^[a-z0-9\-]+$/.test(text);
}

function splitTokens_(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .map(function (v) { return v.trim(); })
    .filter(function (v) { return v !== ""; });
}

function isNumericOnly_(text) {
  return /^\d{1,8}$/.test(String(text || "").trim());
}

function isCancelCommand_(text) {
  const t = String(text || "").trim().toLowerCase();
  return t === "batal" || t === "cancel" || t === "batalkan";
}

function isGreeting_(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (t === "." || t === "p" || t === "ping") return true;
  return (
    t === "halo" ||
    t === "hai" ||
    t === "hi" ||
    t === "tes" ||
    t === "test"
  );
}

function normalizeNo_(value) {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

function normalizeText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function displayCell_(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  return s || "-";
}

function formatRupiah_(value) {
  const n = Math.round(Number(value) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return sign + String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatMaybeCurrency_(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number" && isFinite(value)) return "Rp" + formatRupiah_(value);
  const parsed = parseLooseNumber_(value);
  if (parsed !== null) return "Rp" + formatRupiah_(parsed);
  return String(value);
}

function toWebhookResult(saveResult) {
  if (!saveResult) return "OK";
  return saveResult.ok ? "OK" : "ERROR_" + String(saveResult.error || "ERROR");
}

module.exports = {
  processIncomingText,
  toWebhookResult
};

