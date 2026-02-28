class ToolExecutor {
  constructor(options) {
    const cfg = options || {};
    this.apps = cfg.appsScriptClient;
    this.reminders = cfg.reminderService;
  }

  getToolDefinitions() {
    return [
      defineTool(
        "get_motor_data",
        "Ambil data stok motor dari spreadsheet. Default exclude sold kecuali include_sold=true.",
        {
          type: "object",
          properties: {
            keyword: { type: "string" },
            no: { type: "string" },
            include_sold: { type: "boolean" },
            status: { type: "string", enum: ["all", "terjual", "belum_terjual"] },
            limit: { type: "number" }
          },
          additionalProperties: false
        }
      ),
      defineTool(
        "insert_motor",
        "Input data motor baru ke spreadsheet STOK MOTOR.",
        {
          type: "object",
          properties: {
            nama_motor: { type: "string" },
            tahun: { type: "string" },
            plat: { type: "string" },
            surat_surat: { type: "string" },
            tahun_plat: { type: "string" },
            pajak: { type: "string" },
            harga_jual: { type: ["number", "string"] },
            harga_beli: { type: ["number", "string"] }
          },
          required: ["nama_motor"],
          additionalProperties: false
        }
      ),
      defineTool(
        "update_motor",
        "Edit data motor di spreadsheet STOK MOTOR berdasarkan NO.",
        {
          type: "object",
          properties: {
            no: { type: "string" },
            nama_motor: { type: "string" },
            tahun: { type: "string" },
            plat: { type: "string" },
            surat_surat: { type: "string" },
            tahun_plat: { type: "string" },
            pajak: { type: "string" },
            harga_jual: { type: ["number", "string"] },
            harga_beli: { type: ["number", "string"] },
            harga_laku: { type: ["number", "string"] },
            tgl_terjual: { type: "string" },
            status: { type: ["string", "boolean"] }
          },
          required: ["no"],
          additionalProperties: false
        }
      ),
      defineTool(
        "delete_motor",
        "Hapus data motor dari spreadsheet STOK MOTOR berdasarkan NO.",
        {
          type: "object",
          properties: {
            no: { type: "string" }
          },
          required: ["no"],
          additionalProperties: false
        }
      ),
      defineTool(
        "confirm_sold",
        "Konfirmasi motor terjual di spreadsheet STOK MOTOR (wajib isi harga_laku).",
        {
          type: "object",
          properties: {
            no: { type: "string" },
            nama_motor: { type: "string" },
            harga_laku: { type: ["number", "string"] },
            tgl_terjual: { type: "string" },
            harga_jual: { type: ["number", "string"] }
          },
          required: ["harga_laku"],
          additionalProperties: false
        }
      ),
      defineTool(
        "get_pengeluaran",
        "Ambil data pengeluaran harian dari spreadsheet.",
        {
          type: "object",
          properties: {
            no: { type: "string" },
            tanggal: { type: "string" },
            date_from: { type: "string" },
            date_to: { type: "string" },
            limit: { type: "number" }
          },
          additionalProperties: false
        }
      ),
      defineTool(
        "get_total_pendapatan",
        "Ambil total pendapatan dari spreadsheet TOTAL ASET.",
        {
          type: "object",
          properties: {
            metric_label: { type: "string" }
          },
          additionalProperties: false
        }
      ),
      defineTool(
        "get_total_aset_data",
        "Ambil data dari sheet TOTAL ASET. Jika metric_label dikirim, ambil nilai metric itu. Jika kosong, ambil semua data TOTAL ASET.",
        {
          type: "object",
          properties: {
            metric_label: { type: "string" },
            label: { type: "string" },
            metric: { type: "string" }
          },
          additionalProperties: false
        }
      ),
      defineTool(
        "insert_pengeluaran",
        "Input pengeluaran harian baru ke spreadsheet.",
        {
          type: "object",
          properties: {
            keterangan: { type: "string" },
            total_pengeluaran: { type: ["number", "string"] },
            tanggal: { type: "string" }
          },
          required: ["keterangan", "total_pengeluaran"],
          additionalProperties: false
        }
      ),
      defineTool(
        "update_pengeluaran",
        "Edit pengeluaran harian berdasarkan NO.",
        {
          type: "object",
          properties: {
            no: { type: "string" },
            keterangan: { type: "string" },
            total_pengeluaran: { type: ["number", "string"] },
            tanggal: { type: "string" }
          },
          required: ["no"],
          additionalProperties: false
        }
      ),
      defineTool(
        "create_reminder",
        "Buat reminder custom. due_at harus ISO datetime yang valid.",
        {
          type: "object",
          properties: {
            text: { type: "string" },
            due_at: { type: "string" },
            phone: { type: "string" }
          },
          required: ["text", "due_at"],
          additionalProperties: false
        }
      ),
      defineTool(
        "list_reminders",
        "Lihat daftar reminder aktif untuk user.",
        {
          type: "object",
          properties: {
            phone: { type: "string" }
          },
          additionalProperties: false
        }
      ),
      defineTool(
        "update_reminder",
        "Ubah reminder berdasarkan reminder_id.",
        {
          type: "object",
          properties: {
            reminder_id: { type: "string" },
            text: { type: "string" },
            due_at: { type: "string" },
            phone: { type: "string" }
          },
          required: ["reminder_id"],
          additionalProperties: false
        }
      ),
      defineTool(
        "delete_reminder",
        "Hapus reminder berdasarkan reminder_id.",
        {
          type: "object",
          properties: {
            reminder_id: { type: "string" },
            phone: { type: "string" }
          },
          required: ["reminder_id"],
          additionalProperties: false
        }
      )
    ];
  }

  async execute(name, rawArgs, context) {
    const args = asObject(rawArgs);
    const ctx = context && typeof context === "object" ? context : {};
    const userPhone = String(ctx.userPhone || "").trim();
    const userText = String(ctx.userText || "").trim();

    if (name === "get_motor_data") {
      const allowSold = isExplicitSoldViewRequest(userText);
      const guardedArgs = enforceMotorSoldPolicy(args, allowSold);
      const result = await this.apps.getMotorData(guardedArgs);
      return applyMotorSoldFilter(result, allowSold);
    }
    if (name === "insert_motor") return this.apps.insertMotor(args);
    if (name === "update_motor") return this.apps.updateMotor(args);
    if (name === "delete_motor") return this.apps.deleteMotor(args);
    if (name === "confirm_sold") return this.apps.confirmSold(args);
    if (name === "get_pengeluaran") return this.apps.getPengeluaran(args);
    if (name === "get_total_pendapatan") return this.apps.getTotalPendapatan(args);
    if (name === "get_total_aset_data") return this.apps.getTotalAsetData(args);
    if (name === "insert_pengeluaran") return this.apps.insertPengeluaran(args);
    if (name === "update_pengeluaran") return this.apps.updatePengeluaran(args);

    if (name === "create_reminder") {
      return this.reminders.createReminder({
        phone: String(args.phone || userPhone || "").trim(),
        text: String(args.text || "").trim(),
        dueAt: String(args.due_at || "").trim()
      });
    }
    if (name === "list_reminders") {
      return this.reminders.listReminders({
        phone: String(args.phone || userPhone || "").trim()
      });
    }
    if (name === "update_reminder") {
      return this.reminders.updateReminder({
        phone: String(args.phone || userPhone || "").trim(),
        reminderId: String(args.reminder_id || "").trim(),
        text: String(args.text || "").trim(),
        dueAt: String(args.due_at || "").trim()
      });
    }
    if (name === "delete_reminder") {
      return this.reminders.deleteReminder({
        phone: String(args.phone || userPhone || "").trim(),
        reminderId: String(args.reminder_id || "").trim()
      });
    }

    return {
      status: "error",
      message: "Unknown tool: " + String(name || "")
    };
  }
}

function defineTool(name, description, parameters) {
  return {
    type: "function",
    function: {
      name: String(name || "").trim(),
      description: String(description || "").trim(),
      parameters: parameters || { type: "object", properties: {}, additionalProperties: false }
    }
  };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function enforceMotorSoldPolicy(args, allowSold) {
  const out = Object.assign({}, asObject(args));
  const status = String(out.status || "").trim().toLowerCase();

  if (allowSold) {
    if (!status) out.status = "terjual";
    if (out.include_sold !== true) out.include_sold = true;
    return out;
  }

  out.include_sold = false;
  if (!status || status === "all" || status === "terjual") {
    out.status = "belum_terjual";
  }
  return out;
}

function applyMotorSoldFilter(result, allowSold) {
  if (allowSold) return result;
  if (!result || typeof result !== "object") return result;
  if (String(result.status || "").toLowerCase() !== "success") return result;

  const data = result.data;
  if (!Array.isArray(data)) return result;
  const filtered = data.filter((row) => !isSoldRow(row));
  return Object.assign({}, result, { data: filtered });
}

function isSoldRow(row) {
  const src = row && typeof row === "object" ? row : {};
  const status = String(src.status || "").toLowerCase().trim();
  if (
    status === "terjual" ||
    status === "sold" ||
    status === "laku" ||
    status === "done" ||
    status === "true" ||
    status === "1"
  ) {
    return true;
  }

  const hargaLaku = String(src.harga_laku || "").trim();
  const tglTerjual = String(src.tgl_terjual || "").trim();
  return Boolean(hargaLaku || tglTerjual);
}

function isExplicitSoldViewRequest(text) {
  const t = normalizeText(text);
  if (!t) return false;

  const soldToken = /\b(terjual|sudah terjual|yang terjual|laku|sudah laku|status terjual)\b/.test(t);
  if (!soldToken) return false;

  const viewToken = /\b(lihat|tampilkan|tampilin|data|daftar|list|info|cek|show)\b/.test(t);
  const followupToken = /\byang\s+(sudah\s+)?(terjual|laku)\b/.test(t);
  const negatedConfirm = /\b(konfirmasi|confirm|baru\s+saja|ada\s+motor)\b/.test(t);

  if (negatedConfirm && !viewToken && !followupToken) return false;
  return viewToken || followupToken;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = ToolExecutor;
