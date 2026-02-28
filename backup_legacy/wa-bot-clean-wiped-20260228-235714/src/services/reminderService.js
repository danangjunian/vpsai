const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { normalizePhone } = require("../utils/phone");
const { info, error } = require("../utils/logger");

class ReminderService {
  constructor(options) {
    const cfg = options || {};
    this.sendText = typeof cfg.sendText === "function" ? cfg.sendText : async () => false;
    this.timezone = String(cfg.timezone || "Asia/Jakarta").trim() || "Asia/Jakarta";
    this.runtimeFile = path.resolve(String(cfg.runtimeFile || "./runtime/reminders.json"));
    this.dailyTargets = [
      normalizePhone("6289521503899"),
      normalizePhone("6282228597780")
    ];
    this.jobs = [];
  }

  start() {
    this.stop();
    this.ensureFile();

    // Daily reminder 23:00 WIB
    this.jobs.push(cron.schedule("0 23 * * *", () => {
      this.sendDailyExpenseReminder().catch((err) => error("daily_reminder_failed", { message: err.message }));
    }, { timezone: this.timezone }));

    // Custom reminders check every minute
    this.jobs.push(cron.schedule("* * * * *", () => {
      this.runCustomReminders().catch((err) => error("custom_reminder_failed", { message: err.message }));
    }, { timezone: this.timezone }));

    info("reminder_service_started", { timezone: this.timezone });
  }

  stop() {
    while (this.jobs.length) {
      const j = this.jobs.pop();
      if (j && typeof j.stop === "function") j.stop();
    }
  }

  async sendDailyExpenseReminder() {
    const msg1 = "Pengingat pengeluaran harian hari ini.";
    const msg2 = [
      "Silakan isi:",
      "1. Keterangan:",
      "2. Total Pengeluaran:"
    ].join("\n");

    for (let i = 0; i < this.dailyTargets.length; i++) {
      const target = this.dailyTargets[i];
      if (!target) continue;
      await this.sendText(target, msg1);
      await sleep(300);
      await this.sendText(target, msg2);
      await sleep(300);
    }
  }

  addReminder(userPhone, taskText, dueAtIso) {
    const phone = normalizePhone(userPhone);
    const task = String(taskText || "").trim();
    const dueAt = String(dueAtIso || "").trim();
    if (!phone || !task || !dueAt) return null;

    const data = this.readData();
    const row = {
      id: Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      phone: phone,
      text: task,
      dueAt: dueAt,
      sent: false,
      createdAt: new Date().toISOString()
    };
    data.items.push(row);
    this.writeData(data);
    return row;
  }

  listReminders(userPhone) {
    const phone = normalizePhone(userPhone);
    if (!phone) return [];
    const data = this.readData();
    return data.items.filter((x) => x.phone === phone && !x.sent).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  }

  deleteReminderByIndex(userPhone, index) {
    const phone = normalizePhone(userPhone);
    const idx = Number(index || 0);
    if (!phone || !isFinite(idx) || idx <= 0) return false;

    const data = this.readData();
    const active = data.items
      .map((item, i) => ({ i, item }))
      .filter((x) => x.item.phone === phone && !x.item.sent)
      .sort((a, b) => String(a.item.dueAt).localeCompare(String(b.item.dueAt)));

    if (idx > active.length) return false;
    const targetIndex = active[idx - 1].i;
    data.items.splice(targetIndex, 1);
    this.writeData(data);
    return true;
  }

  async runCustomReminders() {
    const data = this.readData();
    const now = Date.now();
    let changed = false;

    for (let i = 0; i < data.items.length; i++) {
      const row = data.items[i];
      if (!row || row.sent) continue;
      const due = Date.parse(String(row.dueAt || ""));
      if (!isFinite(due) || due > now) continue;

      const ok = await this.sendText(row.phone, "Reminder: " + row.text);
      if (ok) {
        row.sent = true;
        row.sentAt = new Date().toISOString();
        changed = true;
      }
    }

    if (changed) this.writeData(data);
  }

  buildDueAtIso(dateToken, timeToken) {
    const time = normalizeTime(timeToken);
    if (!time) return "";

    const base = parseDateToken(dateToken);
    const dateStr = base.toISOString().slice(0, 10);
    return dateStr + "T" + time + ":00+07:00";
  }

  ensureFile() {
    const dir = path.dirname(this.runtimeFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.runtimeFile)) {
      fs.writeFileSync(this.runtimeFile, JSON.stringify({ items: [] }, null, 2), "utf8");
    }
  }

  readData() {
    this.ensureFile();
    try {
      const raw = String(fs.readFileSync(this.runtimeFile, "utf8") || "");
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return { items: [] };
      return parsed;
    } catch (err) {
      return { items: [] };
    }
  }

  writeData(data) {
    const safe = data && Array.isArray(data.items) ? data : { items: [] };
    fs.writeFileSync(this.runtimeFile, JSON.stringify(safe, null, 2), "utf8");
  }
}

function parseDateToken(token) {
  const t = String(token || "").trim().toLowerCase();
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!t || t === "hariini" || t === "today") return day;
  if (t === "besok" || t === "tomorrow") return new Date(day.getTime() + 24 * 3600 * 1000);
  if (t === "lusa") return new Date(day.getTime() + 2 * 24 * 3600 * 1000);

  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return d;
  }

  return day;
}

function normalizeTime(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms || 0)));
}

module.exports = ReminderService;
