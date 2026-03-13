class ToolExecutor {
  constructor(options) {
    const cfg = options || {};
    this.apps = cfg.appsScriptClient;
    this.reminders = cfg.reminderService;
    this.recentInsertGuard = new Map();
  }

  async execute(name, rawArgs, context) {
    const toolName = String(name || "").trim();
    const args = sanitizeArgs(toolName, rawArgs);
    const ctx = context && typeof context === "object" ? context : {};
    const userPhone = String(ctx.userPhone || "").trim();
    console.log("TOOL CALLED:", toolName);

    const handlers = {
      insert_motor: async () => this.insertMotor(args),
      update_motor: async () => this.updateMotor(args),
      delete_motor: async () => this.deleteMotor(args),
      confirm_sold: async () => this.confirmSold(args),
      insert_pengeluaran: async () => this.apps.insertPengeluaran(stripInternal(args)),
      update_pengeluaran: async () => this.apps.updatePengeluaran(stripInternal(args)),
      create_reminder: async () => this.reminders.createReminder({
        phone: String(args.phone || userPhone || "").trim(),
        text: String(args.text || "").trim(),
        dueAt: String(args.due_at || "").trim()
      }),
      list_reminders: async () => this.reminders.listReminders({ phone: String(args.phone || userPhone || "").trim() }),
      update_reminder: async () => this.reminders.updateReminder({
        phone: String(args.phone || userPhone || "").trim(),
        reminderId: String(args.reminder_id || "").trim(),
        text: String(args.text || "").trim(),
        dueAt: String(args.due_at || "").trim()
      }),
      delete_reminder: async () => this.reminders.deleteReminder({
        phone: String(args.phone || userPhone || "").trim(),
        reminderId: String(args.reminder_id || "").trim()
      })
    };

    const fn = handlers[toolName];
    if (!fn) return { status: "error", message: "Unknown tool: " + toolName };

    try {
      const result = await fn();
      console.log("TOOL RESULT:", result);
      return result;
    } catch (err) {
      console.error("TOOL ERROR:", err);
      return { status: "error", message: String(err && err.message ? err.message : err) };
    }
  }

  async insertMotor(args) {
    if (args.__validation_error) return { status: "error", message: String(args.__validation_error) };
    const payload = ensureMotorInsertShape_(stripInternal(args));
    if (!hasAnyMotorInsertValue_(payload)) {
      return { status: "error", message: "Data motor belum tersedia untuk diproses." };
    }
    console.log("INSERT MOTOR:", payload);

    const signature = buildMotorInsertSignature_(payload);
    const guardKey = collapse_(payload.nama_motor) || "global";
    if (isRecentInsertDuplicate_(this.recentInsertGuard, guardKey, signature, 120000)) {
      return { status: "success", dedupe: true, message: "Insert duplikat dicegah.", data: null };
    }

    let result = null;
    try {
      result = await this.apps.insertMotor(payload);
    } catch (err) {
      result = { status: "error", message: String(err && err.message ? err.message : err) };
    }

    if (isSuccessResult_(result)) {
      rememberRecentInsert_(this.recentInsertGuard, guardKey, signature);
      return result;
    }

    if (isRetryableInsertIssue_(result)) {
      const existing = await findExistingInsertedMotor_(this.apps, payload);
      if (existing) {
        rememberRecentInsert_(this.recentInsertGuard, guardKey, signature);
        return {
          status: "success",
          dedupe: true,
          message: "Insert terdeteksi sudah masuk sebelumnya.",
          data: { no: normalizeNo(existing.no), nama_motor: normalizeText(existing.nama_motor) }
        };
      }
    }

    return result;
  }

  async updateMotor(args) {
    if (args.__validation_error) return { status: "error", message: String(args.__validation_error) };
    const no = normalizeNo(args.no);
    if (!no) return { status: "error", message: "no wajib diisi" };
    return this.apps.updateMotor(stripInternal(Object.assign({}, args, { no: no })));
  }

  async deleteMotor(args) {
    const no = normalizeNo(args.no);
    if (!no) return { status: "error", message: "no wajib diisi" };
    return this.apps.deleteMotor({ no: no });
  }

  async confirmSold(args) {
    if (args.__validation_error) return { status: "error", message: String(args.__validation_error) };
    const no = normalizeNo(args.no);
    if (!no) return { status: "error", message: "no wajib diisi" };
    return this.apps.confirmSold(stripInternal(Object.assign({}, args, { no: no })));
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stripInternal(args) {
  const src = asObject(args);
  const out = {};
  Object.keys(src).forEach((key) => {
    if (String(key || "").slice(0, 2) !== "__") out[key] = src[key];
  });
  return out;
}

function sanitizeArgs(toolName, rawArgs) {
  const src = Object.assign({}, asObject(rawArgs));
  if (["insert_motor", "update_motor", "confirm_sold", "delete_motor"].indexOf(toolName) !== -1) return sanitizeMotorArgs_(src);
  if (["insert_pengeluaran", "update_pengeluaran"].indexOf(toolName) !== -1) return sanitizeExpenseArgs_(src);
  return src;
}

function sanitizeMotorArgs_(src) {
  const out = Object.assign({}, src);
  if (out.no !== undefined) out.no = normalizeNo(out.no);
  if (out.nama_motor !== undefined) out.nama_motor = normalizeText(out.nama_motor);
  if (out.tahun !== undefined) out.tahun = normalizeText(out.tahun);
  if (out.plat !== undefined) out.plat = normalizeText(out.plat).toUpperCase();
  if (out.surat_surat !== undefined) {
    const surat = normalizeSurat_(out.surat_surat);
    if (surat.ok) out.surat_surat = surat.value;
    else {
      out.surat_surat = normalizeText(out.surat_surat);
      out.__validation_error = "SURAT-SURAT tidak valid. Gunakan salah satu: Lengkap hidup, Lengkap mati, BPKB ONLY.";
    }
  }
  if (out.tahun_plat !== undefined) out.tahun_plat = normalizeText(out.tahun_plat);
  if (out.pajak !== undefined) out.pajak = normalizeText(out.pajak);
  if (out.tgl_terjual !== undefined) out.tgl_terjual = normalizeText(out.tgl_terjual);
  if (out.harga_jual !== undefined) out.harga_jual = parseCurrency_(out.harga_jual);
  if (out.harga_beli !== undefined) out.harga_beli = parseCurrency_(out.harga_beli);
  if (out.harga_laku !== undefined) out.harga_laku = parseCurrency_(out.harga_laku);
  return out;
}

function sanitizeExpenseArgs_(src) {
  const out = Object.assign({}, src);
  if (out.no !== undefined) out.no = normalizeNo(out.no);
  if (out.keterangan !== undefined) out.keterangan = normalizeText(out.keterangan);
  if (out.tanggal !== undefined) out.tanggal = normalizeText(out.tanggal);
  if (out.date_from !== undefined) out.date_from = normalizeText(out.date_from);
  if (out.date_to !== undefined) out.date_to = normalizeText(out.date_to);
  if (out.limit !== undefined) out.limit = normalizeLimit_(out.limit, 1, 500, 50);
  if (out.total_pengeluaran !== undefined) out.total_pengeluaran = parseCurrency_(out.total_pengeluaran);
  return out;
}

function ensureMotorInsertShape_(value) {
  const src = asObject(value);
  return {
    nama_motor: insertValue_(src.nama_motor),
    tahun: insertValue_(src.tahun),
    plat: insertValue_(src.plat),
    surat_surat: insertValue_(src.surat_surat),
    tahun_plat: insertValue_(src.tahun_plat),
    pajak: insertValue_(src.pajak),
    harga_jual: insertValue_(src.harga_jual),
    harga_beli: insertValue_(src.harga_beli)
  };
}

function hasAnyMotorInsertValue_(value) {
  const src = ensureMotorInsertShape_(value);
  return Object.keys(src).some((key) => !isEmpty_(src[key]));
}

function buildMotorInsertSignature_(payload) {
  const src = ensureMotorInsertShape_(payload);
  return Object.keys(src).map((key) => key + "=" + signatureValue_(src[key])).join("|");
}

function signatureValue_(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && isFinite(value)) return String(Math.round(value));
  return collapse_(normalizeText(value));
}

function isRecentInsertDuplicate_(store, key, signature, ttlMs) {
  const row = store.get(String(key || ""));
  if (!row || typeof row !== "object") return false;
  if (String(row.signature || "") !== String(signature || "")) return false;
  const age = Date.now() - Number(row.ts || 0);
  return age >= 0 && age <= Math.max(1000, Number(ttlMs || 120000));
}

function rememberRecentInsert_(store, key, signature) {
  store.set(String(key || ""), { signature: String(signature || ""), ts: Date.now() });
}

function isRetryableInsertIssue_(result) {
  const text = normalizeText(result && result.message || "").toLowerCase();
  return Boolean(text && (/timeout|timed out|econnaborted|etimedout|socket hang up|gateway|http 5/.test(text)));
}

async function findExistingInsertedMotor_(apps, payload) {
  const src = ensureMotorInsertShape_(payload);
  if (!normalizeText(src.nama_motor)) return null;
  let fetched = null;
  try {
    fetched = await apps.getMotorData({ nama_motor: normalizeText(src.nama_motor), include_sold: true, status: "all", limit: 100 });
  } catch (err) {
    return null;
  }
  if (!isSuccessResult_(fetched)) return null;
  const rows = extractRows_(fetched);
  for (let i = 0; i < rows.length; i++) {
    if (rowMatchesInsert_(rows[i], src)) return rows[i];
  }
  return null;
}

function rowMatchesInsert_(row, payload) {
  const r = asObject(row);
  const p = ensureMotorInsertShape_(payload);
  if (collapse_(r.nama_motor) !== collapse_(p.nama_motor)) return false;
  if (!isEmpty_(p.tahun) && normalizeText(r.tahun) !== normalizeText(p.tahun)) return false;
  if (!isEmpty_(p.plat) && collapse_(r.plat) !== collapse_(p.plat)) return false;
  if (!isEmpty_(p.surat_surat) && collapse_(r.surat_surat) !== collapse_(p.surat_surat)) return false;
  if (!isEmpty_(p.tahun_plat) && normalizeText(r.tahun_plat) !== normalizeText(p.tahun_plat)) return false;
  if (!isEmpty_(p.pajak) && normalizeText(r.pajak) !== normalizeText(p.pajak)) return false;
  if (!isEmpty_(p.harga_jual) && parseCurrency_(r.harga_jual) !== parseCurrency_(p.harga_jual)) return false;
  if (!isEmpty_(p.harga_beli) && parseCurrency_(r.harga_beli) !== parseCurrency_(p.harga_beli)) return false;
  return true;
}

function normalizeSurat_(value) {
  const raw = normalizeText(value);
  if (!raw) return { ok: true, value: "" };
  const canonical = ["Lengkap hidup", "Lengkap mati", "BPKB ONLY"];
  let best = "";
  let score = 0;
  canonical.forEach((item) => {
    const s = sim_(collapse_(raw), collapse_(item));
    if (s > score) {
      score = s;
      best = item;
    }
  });
  return score >= 0.8 ? { ok: true, value: best } : { ok: false, value: raw };
}

function normalizeLimit_(value, min, max, defaultValue) {
  const n = Number(value);
  const lo = Number(min || 1);
  const hi = Number(max || 500);
  const fb = Number(defaultValue || lo);
  if (!isFinite(n)) return Math.min(Math.max(Math.floor(fb), lo), hi);
  return Math.min(Math.max(Math.floor(n), lo), hi);
}

function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeNo(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^0-9]/g, "");
}

function parseCurrency_(value) {
  if (typeof value === "number" && isFinite(value)) return Math.round(value);
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return 0;
  const text = raw.toLowerCase().replace(/rp\.?/g, " ").replace(/idr/g, " ").replace(/\s+/g, " ").trim();
  const unit = { triliun: 1e12, t: 1e12, miliar: 1e9, milyar: 1e9, b: 1e9, juta: 1e6, jt: 1e6, ribu: 1e3, rb: 1e3, k: 1e3 };
  let total = 0;
  let found = false;
  const re = /(-?\d+(?:[.,]\d+)?)\s*(triliun|miliar|milyar|juta|jt|ribu|rb|k|t|b)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = locale_(m[1]);
    if (n !== null) {
      total += n * (unit[String(m[2]).toLowerCase()] || 1);
      found = true;
    }
  }
  if (found) return Math.round(total);
  const plain = locale_(text);
  return plain === null ? 0 : Math.round(plain);
}

function locale_(value) {
  let s = String(value === undefined || value === null ? "" : value).trim().replace(/[^0-9,.\-]/g, "");
  if (!s) return null;
  const dot = s.indexOf(".") !== -1;
  const comma = s.indexOf(",") !== -1;
  if (dot && comma) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  else if (dot && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function extractRows_(value) {
  return isSuccessResult_(value) && Array.isArray(value.data) ? value.data.slice() : [];
}

function isSuccessResult_(value) {
  return value && typeof value === "object" && String(value.status || "") === "success";
}

function insertValue_(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  const text = String(value).trim();
  return text ? text : null;
}

function isEmpty_(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" ? !value.trim() : false;
}

function normalizeComparable_(value) {
  return normalizeText(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function collapse_(value) {
  return normalizeComparable_(value).replace(/[^a-z0-9]/g, "");
}

function sim_(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const d = lev_(x, y);
  const m = Math.max(x.length, y.length) || 1;
  return Math.max(0, 1 - (d / m));
}

function lev_(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const dp = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) dp[j] = j;
  for (let i = 1; i <= s.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const temp = dp[j];
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[t.length];
}

module.exports = ToolExecutor;
