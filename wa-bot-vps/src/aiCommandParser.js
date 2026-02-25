const axios = require("axios");

class AiCommandParser {
  constructor(options) {
    const cfg = options || {};
    this.enabled = Boolean(cfg.enabled);
    this.apiKey = String(cfg.apiKey || "").trim();
    this.model = String(cfg.model || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 15000));
    this.minConfidence = Number(cfg.minConfidence || 0.55);
    this.debug = Boolean(cfg.debug);
  }

  isEnabled() {
    return Boolean(this.enabled && this.apiKey);
  }

  async parseToCommand(userText, context) {
    const inputText = normalizeText_(userText);
    if (!this.isEnabled() || !inputText) return null;
    const ctx = context && typeof context === "object" ? context : {};
    const appScriptReply = String(ctx.appScriptReply || "").trim();

    // Heuristic cepat berbasis konteks sesi agar step 2/3 tetap natural.
    const contextualGuess = inferCommandFromSessionContext_(inputText, appScriptReply);
    if (contextualGuess) {
      return {
        command: contextualGuess,
        confidence: 0.99
      };
    }

    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: buildPromptMessages_(inputText, ctx)
    };

    try {
      const res = await axios.post(this.baseUrl + "/chat/completions", requestBody, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json"
        }
      });

      const content = extractAssistantContent_(res && res.data);
      if (!content) return null;

      const payload = safeJsonParse_(content);
      if (!payload || typeof payload !== "object") return null;

      const command = normalizeAiCommand_(
        payload.command !== undefined ? payload.command : payload.normalized_command,
        ctx
      );
      if (!command) return null;

      const confidence = Number(payload.confidence || 0);
      if (isFinite(confidence) && confidence > 0 && confidence < this.minConfidence) {
        if (this.debug) {
          console.log("[ai-text] skip by confidence", confidence, "command=", command);
        }
        return null;
      }

      return {
        command: command,
        confidence: isFinite(confidence) && confidence > 0 ? confidence : 0
      };
    } catch (err) {
      if (this.debug) {
        const detail = err && err.response && err.response.data ? err.response.data : "";
        console.warn("[ai-text] OpenAI error:", String(err && err.message ? err.message : err), detail);
      }
      return null;
    }
  }

  async rewriteReply(replyText, context) {
    const inputText = String(replyText || "").trim();
    if (!this.isEnabled() || !inputText) return "";
    if (inputText.length > 2400) return "";

    const requestBody = {
      model: this.model,
      temperature: 0.2,
      messages: buildReplyRewriteMessages_(inputText, context)
    };

    try {
      const res = await axios.post(this.baseUrl + "/chat/completions", requestBody, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json"
        }
      });

      const content = extractAssistantContent_(res && res.data);
      if (!content) return "";
      const normalized = normalizeReplyRewrite_(content);
      if (!normalized) return "";
      return normalized;
    } catch (err) {
      if (this.debug) {
        const detail = err && err.response && err.response.data ? err.response.data : "";
        console.warn("[ai-reply] OpenAI error:", String(err && err.message ? err.message : err), detail);
      }
      return "";
    }
  }
}

function buildPromptMessages_(text, context) {
  const safeText = String(text || "").trim();
  const ctx = context && typeof context === "object" ? context : {};
  const appScriptReply = String(ctx.appScriptReply || "").trim();
  const source = String(ctx.source || "").trim();

  return [
    {
      role: "system",
      content: [
        "Kamu adalah normalizer perintah WhatsApp untuk bot stok motor.",
        "Tugasmu: ubah kalimat user Indonesia menjadi SATU command valid.",
        "Balas WAJIB JSON object: {\"command\":\"...\",\"confidence\":0..1}.",
        "Jika ragu, isi command string kosong.",
        "Aturan penting:",
        "1) Hanya output command yang ada di daftar command di bawah.",
        "2) Gunakan lowercase.",
        "3) Satu baris saja, tanpa komentar.",
        "4) Nominal wajib angka bulat rupiah tanpa simbol (contoh 7500000).",
        "5) Jika user bilang motor terjual/laku dengan nama, map ke command motor laku/terjual berbasis nama.",
        "6) Jika user cek data terjual tanpa nama, map ke command data motor yang sudah terjual.",
        "7) Gunakan appscript_reply sebagai konteks sesi.",
        "8) Jika appscript_reply berisi 'Motor apa?', jawab command: motor <nama>.",
        "9) Jika appscript_reply meminta pilih nomor data, jawab: nomor <urutan>.",
        "10) Jika appscript_reply meminta format laku, jawab: no <pilihan> laku <harga>.",
        "11) Jika appscript_reply meminta format edit harga jual, jawab: no <no> <harga>.",
        "12) Jika appscript_reply meminta konfirmasi OK/BATAL, map bahasa harian ke ok atau batal.",
        "13) Jika appscript_reply meminta kirim template edit data, boleh kirim label minimal yang diubah, contoh: harga jual: 28000000.",
        "14) Jika appscript_reply meminta input pengeluaran harian, jawab label: keterangan: ... dan total pengeluaran: ...",
        "Daftar command yang diizinkan:",
        "- menu",
        "- motor masuk",
        "- motor laku",
        "- motor terjual",
        "- ada motor laku",
        "- ada motor terjual",
        "- motor <nama> laku",
        "- motor laku <nama>",
        "- motor <nama> terjual",
        "- motor terjual <nama>",
        "- motor <nama>",
        "- no <pilihan> laku <harga>",
        "- pilih <pilihan> laku <harga>",
        "- <pilihan> <harga>",
        "- ok",
        "- batal",
        "- data motor <nama>",
        "- cek data motor <nama>",
        "- cek stok motor <nama>",
        "- cek motor <nama>",
        "- data motor yang sudah terjual",
        "- data motor yang sudah laku",
        "- cek data motor yang sudah terjual",
        "- cek data motor yang sudah laku",
        "- cek motor yang sudah laku",
        "- cek motor yang sudah terjual",
        "- data motor <nama> yang sudah terjual",
        "- data motor <nama> yang sudah laku",
        "- cek data motor <nama> yang sudah terjual",
        "- cek data motor <nama> yang sudah laku",
        "- cek motor <nama> yang sudah laku",
        "- cek motor <nama> yang sudah terjual",
        "- motor <nama> yang sudah laku",
        "- motor <nama> yang sudah terjual",
        "- pengeluaran",
        "- pengeluaran hari ini",
        "- pengeluaran minggu ini",
        "- pengeluaran bulan ini",
        "- cek pengeluaran hari ini",
        "- cek pengeluaran minggu ini",
        "- cek pengeluaran bulan ini",
        "- laba hari ini",
        "- cek laba hari ini",
        "- keuntungan hari ini",
        "- cek keuntungan hari ini",
        "- laba minggu ini",
        "- cek laba minggu ini",
        "- keuntungan minggu ini",
        "- cek keuntungan minggu ini",
        "- laba bulan ini",
        "- cek laba bulan ini",
        "- keuntungan bulan ini",
        "- cek keuntungan bulan ini",
        "- total aset kendaraan",
        "- total kendaraan",
        "- total modal",
        "- total modal sekarang",
        "- edit harga jual motor <nama>",
        "- edit harga jual <nama>",
        "- edit data motor",
        "- edit data motor <nama>",
        "- nomor <urutan>",
        "- no <no> <harga>",
        "- pilih <urutan> <harga>",
        "- nama motor: <teks>",
        "- tahun: <teks>",
        "- plat: <teks>",
        "- surat-surat: <teks>",
        "- tahun plat: <teks>",
        "- pajak: <teks>",
        "- harga jual: <angka>",
        "- harga beli: <angka>",
        "- keterangan: <teks>",
        "- total pengeluaran: <angka>"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        user_text: safeText,
        source: source,
        appscript_reply: appScriptReply
      })
    }
  ];
}

function buildReplyRewriteMessages_(replyText, context) {
  const ctx = context && typeof context === "object" ? context : {};
  const userText = String(ctx.userText || "").trim();

  return [
    {
      role: "system",
      content: [
        "Kamu mengubah balasan bot WA stok motor menjadi bahasa Indonesia natural yang enak dibaca.",
        "Aturan:",
        "1) Tetap pertahankan maksud, angka, NO, harga, tanggal, dan status.",
        "2) Jika ada instruksi format/perintah (contoh: no <no> <harga>, OK/BATAL), jangan dihapus.",
        "3) Jika ada template field (contoh: NAMA MOTOR:, TAHUN:), tetap pertahankan label field.",
        "4) Boleh buat lebih ramah dan natural, tapi tetap ringkas.",
        "5) Output hanya teks balasan final, tanpa penjelasan tambahan."
      ].join("\\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        user_text: userText,
        original_reply: String(replyText || "")
      })
    }
  ];
}

function extractAssistantContent_(responseData) {
  const choices = responseData && Array.isArray(responseData.choices) ? responseData.choices : [];
  if (!choices.length) return "";
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const parts = [];
    for (let i = 0; i < msg.content.length; i++) {
      const chunk = msg.content[i];
      if (chunk && chunk.type === "text" && chunk.text) {
        parts.push(String(chunk.text));
      }
    }
    return parts.join("").trim();
  }
  return "";
}

function safeJsonParse_(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (err) {
    return null;
  }
}

function normalizeAiCommand_(value, context) {
  const rawText = String(value === undefined || value === null ? "" : value).trim();
  const raw = normalizeText_(rawText).replace(/\r?\n/g, " ");
  if (!raw) return "";
  if (raw.length > 500) return "";
  if (/[#;]/.test(raw)) return "";

  const ctx = context && typeof context === "object" ? context : {};
  const contextualGuess = inferCommandFromSessionContext_(raw, ctx.appScriptReply);
  if (contextualGuess) return contextualGuess;

  const lower = raw.toLowerCase();

  if (lower === "halo" || lower === "hi" || lower === "menu") return "menu";
  if (lower === "ok") return "ok";
  if (lower === "batal") return "batal";
  if (lower === "motor masuk") return "motor masuk";
  if (/^(?:ada\s+)?motor\s+laku$/i.test(lower)) return lower;
  if (/^(?:ada\s+)?motor\s+terjual$/i.test(lower)) return lower;

  const normalizedLaku = normalizeLakuSelectionCommand_(raw);
  if (normalizedLaku) return normalizedLaku;

  const normalizedEditHarga = normalizeEditHargaSelectionCommand_(raw);
  if (normalizedEditHarga) return normalizedEditHarga;

  if (/^motor\s+.+\s+laku$/i.test(raw)) return lower;
  if (/^motor\s+laku\s+.+$/i.test(raw)) return lower;
  if (/^motor\s+.+\s+terjual$/i.test(raw)) return lower;
  if (/^motor\s+terjual\s+.+$/i.test(raw)) return lower;
  if (/^motor\s+.+$/i.test(raw)) return lower;

  if (/^(?:cek\s+)?data\s+motor(?:\s+.+)?$/i.test(raw)) return lower;
  if (/^cek\s+stok\s+motor(?:\s+.+)?$/i.test(raw)) return lower;
  if (/^cek\s+motor(?:\s+.+)?$/i.test(raw)) return lower;

  if (/^(?:cek\s+)?(?:data\s+)?motor(?:\s+.+?)?\s+yang\s+sudah\s+(?:terjual|laku)$/i.test(raw)) {
    return lower;
  }
  if (/^motor\s+.+\s+yang\s+sudah\s+(?:terjual|laku)$/i.test(raw)) return lower;

  if (isExactOneOf_(lower, [
    "pengeluaran",
    "pengeluaran hari ini",
    "cek pengeluaran hari ini",
    "pengeluaran minggu ini",
    "cek pengeluaran minggu ini",
    "pengeluaran bulan ini",
    "cek pengeluaran bulan ini",
    "laba hari ini",
    "cek laba hari ini",
    "keuntungan hari ini",
    "cek keuntungan hari ini",
    "laba minggu ini",
    "cek laba minggu ini",
    "keuntungan minggu ini",
    "cek keuntungan minggu ini",
    "laba bulan ini",
    "cek laba bulan ini",
    "keuntungan bulan ini",
    "cek keuntungan bulan ini",
    "total aset kendaraan",
    "total kendaraan",
    "total modal",
    "total modal sekarang"
  ])) {
    return lower;
  }

  if (/^edit\s+harga\s+jual\s+motor\s+.+$/i.test(raw)) return lower;
  if (/^edit\s+harga\s+jual\s+.+$/i.test(raw)) return lower;
  if (/^edit\s+data\s+motor$/i.test(raw)) return lower;
  if (/^edit\s+data\s+motor\s+.+$/i.test(raw)) return lower;
  if (/^nomor\s+\d+$/i.test(raw)) return lower;

  const normalizedLabel = normalizeLabelTemplateCommand_(rawText);
  if (normalizedLabel) return normalizedLabel;

  return "";
}

function inferCommandFromSessionContext_(userText, appScriptReply) {
  const rawUser = String(userText === undefined || userText === null ? "" : userText).trim();
  const text = normalizeText_(rawUser).toLowerCase();
  const reply = normalizeText_(appScriptReply).toLowerCase();
  if (!text || !reply) return "";

  const decision = parseDecisionCommand_(text);
  if (decision && isReplyAskingConfirm_(reply)) {
    return decision;
  }

  if (isReplyAskingLakuSelection_(reply)) {
    const no = extractSelectionNumberFromText_(text);
    const harga = normalizeNominal_(text);
    if (no && harga && looksLikePriceSignal_(text, no, harga)) return "no " + no + " laku " + harga;
  }

  if (isReplyAskingEditHargaSelection_(reply)) {
    const no = extractSelectionNumberFromText_(text);
    const harga = normalizeNominal_(text);
    if (no && harga && looksLikePriceSignal_(text, no, harga)) return "no " + no + " " + harga;
  }

  if (isReplyAskingIndexSelection_(reply)) {
    const no = extractSelectionNumberFromText_(text);
    if (no) return "nomor " + no;
  }

  if (isReplyAskingMotorKeyword_(reply)) {
    const keyword = extractMotorKeyword_(rawUser);
    if (keyword) return "motor " + keyword;
  }

  if (isReplyAskingEditTemplate_(reply)) {
    const templateCmd = buildEditTemplateCommandFromNatural_(rawUser);
    if (templateCmd) return templateCmd;
  }

  if (isReplyAskingDailyExpenseInput_(reply)) {
    const expenseCmd = buildDailyExpenseTemplateCommandFromNatural_(rawUser);
    if (expenseCmd) return expenseCmd;
  }

  return "";
}

function parseDecisionCommand_(text) {
  const t = normalizeText_(text).toLowerCase();
  if (!t) return "";

  if (/\b(batal|cancel|ga jadi|gak jadi|nggak jadi|engga jadi|tidak jadi|stop)\b/.test(t)) {
    return "batal";
  }

  if (/\b(ok|oke|okay|iya|ya|yup|siap|sip|lanjut|gas|confirm|konfirmasi|benar|betul)\b/.test(t)) {
    return "ok";
  }

  return "";
}

function isReplyAskingConfirm_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("ketik ok untuk simpan / batal untuk batal") !== -1 ||
    r.indexOf("ok / batal") !== -1
  );
}

function isReplyAskingMotorKeyword_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return r.indexOf("motor apa?") !== -1;
}

function isReplyAskingIndexSelection_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("motor yang mana? pilih dari daftar berikut:") !== -1 ||
    r.indexOf("balas: nomor <urutan>") !== -1 ||
    r.indexOf("atau: pilih <urutan> / no <no> / <angka>") !== -1
  );
}

function isReplyAskingLakuSelection_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("balas: no <pilihan> laku <harga>") !== -1 ||
    r.indexOf("gunakan format: no <pilihan> laku <harga>") !== -1 ||
    r.indexOf("pilih motor yang terjual:") !== -1
  );
}

function isReplyAskingEditHargaSelection_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("pilih motor untuk edit harga jual:") !== -1 ||
    r.indexOf("gunakan format no motor: no <no> <harga>") !== -1
  );
}

function isReplyAskingEditTemplate_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("kirim ulang template di atas setelah diedit.") !== -1 ||
    r.indexOf("silakan diedit") !== -1
  );
}

function isReplyAskingDailyExpenseInput_(reply) {
  const r = normalizeText_(reply).toLowerCase();
  return (
    r.indexOf("pengeluaran hari ini berapa?") !== -1 ||
    (r.indexOf("keterangan :") !== -1 && r.indexOf("total pengeluaran :") !== -1)
  );
}

function extractMotorKeyword_(text) {
  let t = normalizeText_(text).toLowerCase();
  if (!t) return "";
  if (parseDecisionCommand_(t)) return "";

  t = t.replace(/[^\w\s-]/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  // Potong awalan percakapan umum.
  let prev = "";
  while (t && t !== prev) {
    prev = t;
    t = t.replace(/^(?:yang|motor|unit|itu|si|dong|donk|tolong|pls|please|mau|aku|saya|pilih)\s+/, "");
  }

  // Buang kata basa-basi umum di tengah/akhir.
  const fillers = {
    dong: true,
    donk: true,
    ya: true,
    yah: true,
    nih: true,
    aja: true,
    deh: true,
    bro: true,
    bos: true,
    kak: true,
    mas: true,
    mba: true,
    bang: true,
    tolong: true,
    please: true,
    pls: true
  };
  const words = t.split(" ").filter(function (w) {
    return w && !fillers[w];
  });
  if (!words.length) return "";

  const candidate = words.slice(0, 4).join(" ").trim();
  if (!candidate || /^\d+$/.test(candidate)) return "";
  return candidate;
}

function extractSelectionNumberFromText_(text) {
  const t = normalizeText_(text).toLowerCase();
  if (!t) return "";

  let m = t.match(/\b(?:no|nomor|pilih|urutan)\s*(\d{1,3})\b/);
  if (m) return normalizeOrdinal_(m[1]);

  m = t.match(/\bke[-\s]?(\d{1,3})\b/);
  if (m) return normalizeOrdinal_(m[1]);

  const byWord = extractOrdinalWordSelection_(t);
  if (byWord) return byWord;

  const numRegex = /\b(\d{1,3})\b/g;
  while ((m = numRegex.exec(t)) !== null) {
    const num = Number(m[1]);
    if (!isFinite(num) || num < 1 || num > 200) continue;
    const tail = t.slice(numRegex.lastIndex, numRegex.lastIndex + 12);
    if (/\b(jt|juta|rb|ribu|m|miliar|milyar)\b/.test(tail)) continue;
    return String(Math.trunc(num));
  }

  return "";
}

function looksLikePriceSignal_(text, no, harga) {
  const t = normalizeText_(text).toLowerCase();
  const selection = String(no || "").trim();
  const nominal = Number(harga || 0);
  if (!t || !selection || !isFinite(nominal) || nominal <= 0) return false;

  if (/\b(harga|laku|jual|rp|rupiah|jt|juta|rb|ribu|m|miliar|milyar)\b/.test(t)) return true;
  if (nominal >= 1000) return true;

  // Kalau nominal sama persis dengan nomor pilihan (contoh: "yang no 14"), anggap belum ada harga.
  if (String(Math.trunc(nominal)) === selection) return false;
  return nominal >= 100;
}

function extractOrdinalWordSelection_(text) {
  const t = normalizeText_(text).toLowerCase();
  const map = {
    pertama: 1,
    kedua: 2,
    ketiga: 3,
    keempat: 4,
    kelima: 5,
    keenam: 6,
    ketujuh: 7,
    kedelapan: 8,
    kesembilan: 9,
    kesepuluh: 10,
    satu: 1,
    dua: 2,
    tiga: 3,
    empat: 4,
    lima: 5,
    enam: 6,
    tujuh: 7,
    delapan: 8,
    sembilan: 9,
    sepuluh: 10
  };

  let m = t.match(/\b(?:no|nomor|pilih|urutan|yang)\s+(pertama|kedua|ketiga|keempat|kelima|keenam|ketujuh|kedelapan|kesembilan|kesepuluh|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh)\b/);
  if (m && map[m[1]]) return String(map[m[1]]);

  m = t.match(/\b(pertama|kedua|ketiga|keempat|kelima|keenam|ketujuh|kedelapan|kesembilan|kesepuluh)\b/);
  if (m && map[m[1]]) return String(map[m[1]]);

  return "";
}

function buildEditTemplateCommandFromNatural_(text) {
  const labeled = normalizeLabelTemplateCommand_(text);
  if (labeled) return labeled;

  const raw = normalizeText_(text).toLowerCase();
  if (!raw) return "";

  const lines = [];

  const hargaJual = findNominalAfterKeywords_(raw, ["harga jual", "jual"]);
  if (hargaJual) lines.push("harga jual: " + hargaJual);

  const hargaBeli = findNominalAfterKeywords_(raw, ["harga beli", "beli"]);
  if (hargaBeli) lines.push("harga beli: " + hargaBeli);

  const tahunPlat = findYearAfterKeywords_(raw, ["tahun plat", "thn plat", "plat tahun"]);
  if (tahunPlat) lines.push("tahun plat: " + tahunPlat);

  const pajak = findYearAfterKeywords_(raw, ["pajak"]);
  if (pajak) lines.push("pajak: " + pajak);

  const surat = normalizeSuratFromText_(raw);
  if (surat) lines.push("surat-surat: " + surat);

  return lines.join("\n").trim();
}

function buildDailyExpenseTemplateCommandFromNatural_(text) {
  const labeled = normalizeLabelTemplateCommand_(text);
  if (labeled && /total pengeluaran\s*:/i.test(labeled)) return labeled;

  const raw = normalizeText_(text);
  if (!raw) return "";

  const total = normalizeNominal_(raw);
  if (!total) return "";

  let ket = raw
    .replace(/\b(?:rp|rupiah|idr)\b/gi, " ")
    .replace(/\d[\d.,]*/g, " ")
    .replace(/\b(?:jt|juta|rb|ribu|m|miliar|milyar)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  ket = ket.replace(/^(?:pengeluaran|keluar|habis|buat|untuk)\s+/i, "").trim();
  if (!ket) ket = "pengeluaran harian";

  return "keterangan: " + ket + "\n" + "total pengeluaran: " + total;
}

function findNominalAfterKeywords_(text, keywords) {
  const src = normalizeText_(text).toLowerCase();
  const list = Array.isArray(keywords) ? keywords : [];
  for (let i = 0; i < list.length; i++) {
    const key = String(list[i] || "").trim().toLowerCase();
    if (!key) continue;
    const re = new RegExp(
      "\\b" + escapeRegex_(key) + "\\b(?:\\s*(?:nya)?)?(?:\\s*(?:jadi|=|:|ke|diubah(?:\\s*jadi)?|diganti(?:\\s*jadi)?))?\\s*([\\d][\\d.,\\s]*(?:\\s*(?:jt|juta|rb|ribu|m|miliar|milyar))?)",
      "i"
    );
    const m = src.match(re);
    if (!m) continue;
    const nominal = normalizeNominal_(m[1]);
    if (nominal) return nominal;
  }
  return "";
}

function findYearAfterKeywords_(text, keywords) {
  const src = normalizeText_(text).toLowerCase();
  const list = Array.isArray(keywords) ? keywords : [];
  for (let i = 0; i < list.length; i++) {
    const key = String(list[i] || "").trim().toLowerCase();
    if (!key) continue;
    const re = new RegExp("\\b" + escapeRegex_(key) + "\\b(?:\\s*(?:nya)?)?(?:\\s*(?:jadi|=|:|ke))?\\s*(19\\d{2}|20\\d{2})", "i");
    const m = src.match(re);
    if (m) return String(m[1]);
  }
  return "";
}

function normalizeSuratFromText_(text) {
  const t = normalizeText_(text).toLowerCase();
  if (!t) return "";
  if (t.indexOf("lengkap hidup") !== -1) return "Lengkap hidup";
  if (t.indexOf("lengkap mati") !== -1) return "Lengkap mati";
  if (t.indexOf("bpkb only") !== -1 || t.indexOf("bpkb saja") !== -1) return "BPKB ONLY";
  return "";
}

function normalizeLabelTemplateCommand_(text) {
  const raw = String(text === undefined || text === null ? "" : text).trim();
  if (!raw) return "";

  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line || line.indexOf(":") === -1) continue;
    const parts = line.split(":");
    const key = canonicalLabelByKey_(normalizeLabelKeyLocal_(parts.shift()));
    if (!key) continue;

    const valueRaw = parts.join(":").trim();
    if (!valueRaw) continue;

    const value = normalizeLabelValue_(key, valueRaw);
    if (!value) continue;

    out.push(key + ": " + value);
  }

  return out.join("\n").trim();
}

function normalizeLabelKeyLocal_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function canonicalLabelByKey_(key) {
  const k = String(key || "");
  if (k === "no" || k === "nomor") return "no";
  if (k === "namamotor") return "nama motor";
  if (k === "tahun") return "tahun";
  if (k === "plat") return "plat";
  if (k === "suratsurat") return "surat-surat";
  if (k === "tahunplat") return "tahun plat";
  if (k === "pajak") return "pajak";
  if (k === "hargajual") return "harga jual";
  if (k === "hargabeli") return "harga beli";
  if (k === "keterangan" || k === "ket") return "keterangan";
  if (
    k === "totalpengeluaran" ||
    k === "pengeluaran" ||
    k === "total" ||
    k === "nominal" ||
    k === "jumlah"
  ) {
    return "total pengeluaran";
  }
  return "";
}

function normalizeLabelValue_(label, value) {
  const key = String(label || "").toLowerCase();
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (key === "harga jual" || key === "harga beli" || key === "total pengeluaran") {
    const nominal = normalizeNominal_(raw);
    return nominal || raw;
  }

  if (key === "surat-surat") {
    return normalizeSuratFromText_(raw) || raw;
  }

  return raw;
}

function escapeRegex_(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLakuSelectionCommand_(raw) {
  let m = raw.match(/^no\s+(\d+)\s+laku\s+(.+)$/i);
  if (m) {
    const no = normalizeOrdinal_(m[1]);
    const harga = normalizeNominal_(m[2]);
    if (no && harga) return "no " + no + " laku " + harga;
    return "";
  }

  m = raw.match(/^pilih\s+(\d+)\s+laku\s+(.+)$/i);
  if (m) {
    const urutan = normalizeOrdinal_(m[1]);
    const harga = normalizeNominal_(m[2]);
    if (urutan && harga) return "pilih " + urutan + " laku " + harga;
    return "";
  }

  m = raw.match(/^(\d+)\s+(.+)$/);
  if (m) {
    const no = normalizeOrdinal_(m[1]);
    const harga = normalizeNominal_(m[2]);
    if (no && harga) return no + " " + harga;
  }

  return "";
}

function normalizeEditHargaSelectionCommand_(raw) {
  let m = raw.match(/^no\s+(\d+)\s+(.+)$/i);
  if (m && !/\blaku\b/i.test(raw)) {
    const no = normalizeOrdinal_(m[1]);
    const harga = normalizeNominal_(m[2]);
    if (no && harga) return "no " + no + " " + harga;
  }

  m = raw.match(/^pilih\s+(\d+)\s+(.+)$/i);
  if (m && !/\blaku\b/i.test(raw)) {
    const urutan = normalizeOrdinal_(m[1]);
    const harga = normalizeNominal_(m[2]);
    if (urutan && harga) return "pilih " + urutan + " " + harga;
  }

  return "";
}

function normalizeOrdinal_(value) {
  const n = Number(String(value || "").replace(/[^\d]/g, ""));
  if (!isFinite(n) || n < 1) return "";
  return String(Math.trunc(n));
}

function normalizeNominal_(value) {
  const raw = normalizeText_(value).toLowerCase();
  if (!raw) return "";

  const multiplier = inferNominalMultiplier_(raw);
  const numberCandidates = [];
  const m = raw.match(/\d[\d.,]*/g);
  if (m && m.length) {
    for (let i = 0; i < m.length; i++) {
      if (m[i]) numberCandidates.push(String(m[i]));
    }
  }
  if (!numberCandidates.length) return "";

  // Untuk kalimat campuran (misal: "nomor 2 harga 7 juta"), nominal biasanya angka terakhir.
  const numberPart = numberCandidates[numberCandidates.length - 1];
  const parsed = parseLooseNumber_(numberPart);
  if (!isFinite(parsed) || parsed <= 0) return "";

  const nominal = Math.round(parsed * multiplier);
  if (!isFinite(nominal) || nominal <= 0) return "";
  return String(nominal);
}

function inferNominalMultiplier_(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(m|milyar|miliar|billion)\b/.test(t)) return 1000000000;
  if (/\b(jt|juta)\b/.test(t)) return 1000000;
  if (/\b(rb|ribu)\b/.test(t)) return 1000;
  return 1;
}

function parseLooseNumber_(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;

  // 7.500.000 -> 7500000
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw)) {
    return Number(raw.replace(/\./g, "").replace(",", "."));
  }

  // 7,500,000 -> 7500000
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) {
    return Number(raw.replace(/,/g, ""));
  }

  return Number(raw.replace(",", "."));
}

function isExactOneOf_(value, list) {
  const v = String(value || "").trim().toLowerCase();
  const candidates = Array.isArray(list) ? list : [];
  for (let i = 0; i < candidates.length; i++) {
    if (v === String(candidates[i] || "").trim().toLowerCase()) return true;
  }
  return false;
}

function normalizeText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReplyRewrite_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

module.exports = AiCommandParser;
