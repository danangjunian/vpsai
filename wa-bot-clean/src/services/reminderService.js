const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { normalizePhone, parseAdminList } = require("../utils/phone");
const { info, error, warn } = require("../utils/logger");

class ReminderService {
  constructor(options) {
    const cfg = options || {};
    this.sendText = typeof cfg.sendText === "function" ? cfg.sendText : async () => false;
    this.timezone = String(cfg.timezone || "Asia/Jakarta").trim() || "Asia/Jakarta";
    this.dailyTime = normalizeDailyTime(cfg.dailyTime || "23:00");
    this.dailyTargets = parseAdminList(cfg.dailyTargets || "6289521503899,6282228597780");
    this.filePath = path.resolve(String(cfg.filePath || "./runtime/reminders.json"));
    this.jobs = [];
  }

  start() {
    this.stop();
    this.ensureStore();

    const cronExpr = dailyCronExpression(this.dailyTime);
    this.jobs.push(
      cron.schedule(
        cronExpr,
        () => {
          this.sendDailyReminder().catch((err) => error("daily_reminder_failed", { message: err.message }));
        },
        { timezone: this.timezone }
      )
    );

    this.jobs.push(
      cron.schedule(
        "* * * * *",
        () => {
          this.dispatchDueReminders().catch((err) => error("dispatch_due_reminder_failed", { message: err.message }));
        },
        { timezone: this.timezone }
      )
    );

    info("reminder_started", {
      timezone: this.timezone,
      dailyTime: this.dailyTime,
      dailyTargets: this.dailyTargets
    });
  }

  stop() {
    while (this.jobs.length > 0) {
      const job = this.jobs.pop();
      if (job && typeof job.stop === "function") job.stop();
    }
  }

  async sendDailyReminder() {
    const msg1 = "Pengingat pengeluaran hari ini.";
    const msg2 = ["Tolong diisi:", "1. Keterangan:", "2. Total pengeluaran:"].join("\n");

    for (let i = 0; i < this.dailyTargets.length; i++) {
      const phone = normalizePhone(this.dailyTargets[i]);
      if (!phone) continue;
      await this.sendText(phone, msg1);
      await sleep(300);
      await this.sendText(phone, msg2);
      await sleep(300);
    }
  }

  createReminder(input) {
    const payload = input && typeof input === "object" ? input : {};
    const phone = normalizePhone(payload.phone);
    const text = String(payload.text || "").trim();
    const dueAt = parseDueAt(payload.dueAt);
    if (!phone) return { status: "error", message: "phone wajib diisi" };
    if (!text) return { status: "error", message: "text wajib diisi" };
    if (!dueAt) return { status: "error", message: "due_at wajib format ISO datetime valid" };

    const data = this.readStore();
    const row = {
      id: generateId_(),
      phone: phone,
      text: text,
      dueAt: dueAt,
      sent: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.items.push(row);
    this.writeStore(data);
    return { status: "success", data: row };
  }

  listReminders(input) {
    const payload = input && typeof input === "object" ? input : {};
    const phone = normalizePhone(payload.phone);
    if (!phone) return { status: "error", message: "phone wajib diisi" };

    const data = this.readStore();
    const rows = data.items
      .filter((x) => x.phone === phone && !x.sent)
      .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));

    return { status: "success", data: rows };
  }

  updateReminder(input) {
    const payload = input && typeof input === "object" ? input : {};
    const phone = normalizePhone(payload.phone);
    const reminderId = String(payload.reminderId || "").trim();
    if (!phone) return { status: "error", message: "phone wajib diisi" };
    if (!reminderId) return { status: "error", message: "reminder_id wajib diisi" };

    const data = this.readStore();
    const row = data.items.find((x) => x.phone === phone && x.id === reminderId && !x.sent);
    if (!row) return { status: "error", message: "reminder tidak ditemukan" };

    const text = String(payload.text || "").trim();
    if (text) row.text = text;

    if (payload.dueAt !== undefined && payload.dueAt !== null && String(payload.dueAt).trim() !== "") {
      const dueAt = parseDueAt(payload.dueAt);
      if (!dueAt) return { status: "error", message: "due_at tidak valid" };
      row.dueAt = dueAt;
    }

    row.updatedAt = new Date().toISOString();
    this.writeStore(data);
    return { status: "success", data: row };
  }

  deleteReminder(input) {
    const payload = input && typeof input === "object" ? input : {};
    const phone = normalizePhone(payload.phone);
    const reminderId = String(payload.reminderId || "").trim();
    if (!phone) return { status: "error", message: "phone wajib diisi" };
    if (!reminderId) return { status: "error", message: "reminder_id wajib diisi" };

    const data = this.readStore();
    const before = data.items.length;
    data.items = data.items.filter((x) => !(x.phone === phone && x.id === reminderId));
    if (before === data.items.length) {
      return { status: "error", message: "reminder tidak ditemukan" };
    }
    this.writeStore(data);
    return { status: "success", data: { deleted: true, reminder_id: reminderId } };
  }

  async dispatchDueReminders() {
    const data = this.readStore();
    const now = Date.now();
    let changed = false;

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      if (!item || item.sent) continue;

      const dueTs = Date.parse(String(item.dueAt || ""));
      if (!isFinite(dueTs)) {
        item.sent = true;
        item.sentAt = new Date().toISOString();
        item.error = "INVALID_DUE_AT";
        changed = true;
        continue;
      }
      if (dueTs > now) continue;

      const ok = await this.sendText(item.phone, "Reminder: " + item.text);
      if (ok) {
        item.sent = true;
        item.sentAt = new Date().toISOString();
        item.updatedAt = new Date().toISOString();
      } else {
        item.lastAttemptAt = new Date().toISOString();
      }
      changed = true;
      await sleep(200);
    }

    if (changed) this.writeStore(data);
  }

  ensureStore() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ items: [] }, null, 2), "utf8");
    }
  }

  readStore() {
    this.ensureStore();
    try {
      const raw = String(fs.readFileSync(this.filePath, "utf8") || "");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return { items: [] };
      return parsed;
    } catch (err) {
      warn("reminder_store_corrupt", { message: err.message });
      return { items: [] };
    }
  }

  writeStore(data) {
    const safe = data && Array.isArray(data.items) ? data : { items: [] };
    fs.writeFileSync(this.filePath, JSON.stringify(safe, null, 2), "utf8");
  }
}

function parseDueAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const ts = Date.parse(raw);
  if (!isFinite(ts)) return "";
  return new Date(ts).toISOString();
}

function dailyCronExpression(timeStr) {
  const time = normalizeDailyTime(timeStr);
  const parts = time.split(":");
  return String(Number(parts[1])) + " " + String(Number(parts[0])) + " * * *";
}

function normalizeDailyTime(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "23:00";
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function generateId_() {
  return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms || 0)));
}

module.exports = ReminderService;
