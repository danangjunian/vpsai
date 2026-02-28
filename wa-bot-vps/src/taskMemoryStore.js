const fs = require("fs");
const path = require("path");

class TaskMemoryStore {
  constructor(options) {
    const cfg = options || {};
    this.filePath = path.resolve(process.cwd(), String(cfg.filePath || "./runtime/agent-memory.json"));
    this.maxReminders = Math.max(100, Number(cfg.maxReminders || 5000));
    this.debug = Boolean(cfg.debug);

    ensureDir_(path.dirname(this.filePath));
    this.state = loadState_(this.filePath);
    this.persist_();
  }

  createReminder(input) {
    const src = input && typeof input === "object" ? input : {};
    const nowIso = new Date().toISOString();
    const dueAt = toIsoString_(src.due_at);
    if (!dueAt) {
      throw new Error("due_at tidak valid.");
    }

    const reminder = {
      id: buildId_("rmd"),
      session_key: String(src.session_key || "").trim(),
      sender: normalizeWaNumber_(src.sender),
      chat_jid: String(src.chat_jid || "").trim(),
      target_number: normalizeWaNumber_(src.target_number || src.sender),
      text: String(src.text || "").trim(),
      due_at: dueAt,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
      sent_at: "",
      last_error: "",
      last_attempt_at: "",
      payload: ensurePlainObject_(src.payload)
    };

    if (!reminder.text) {
      throw new Error("text reminder kosong.");
    }
    if (!reminder.target_number) {
      throw new Error("target_number kosong.");
    }

    this.state.reminders.push(reminder);
    if (this.state.reminders.length > this.maxReminders) {
      this.state.reminders = this.state.reminders.slice(this.state.reminders.length - this.maxReminders);
    }
    this.persist_();
    return clone_(reminder);
  }

  listReminders(filter) {
    const src = filter && typeof filter === "object" ? filter : {};
    const sessionKey = String(src.session_key || "").trim();
    const sender = normalizeWaNumber_(src.sender);
    const includeDone = Boolean(src.include_done);
    const max = Math.max(1, Math.min(100, Number(src.limit || 20)));

    const out = [];
    const rows = Array.isArray(this.state.reminders) ? this.state.reminders : [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || typeof row !== "object") continue;

      if (sessionKey && String(row.session_key || "") !== sessionKey) continue;
      if (!sessionKey && sender && normalizeWaNumber_(row.sender) !== sender) continue;
      if (!includeDone && row.status !== "pending" && row.status !== "dispatching") continue;

      out.push(clone_(row));
    }

    out.sort(function (a, b) {
      return String(a.due_at || "").localeCompare(String(b.due_at || ""));
    });

    return out.slice(0, max);
  }

  updateReminderStatusByRef(filter) {
    const src = filter && typeof filter === "object" ? filter : {};
    const status = String(src.status || "").trim().toLowerCase();
    if (!status) return null;

    const reminder = this.resolveReminderByRef_(src);
    if (!reminder) return null;

    const nowIso = new Date().toISOString();
    reminder.status = status;
    reminder.updated_at = nowIso;
    if (status === "completed" || status === "deleted" || status === "sent") {
      reminder.sent_at = reminder.sent_at || nowIso;
    }
    this.persist_();
    return clone_(reminder);
  }

  claimDueReminders(nowDate, limit) {
    const now = nowDate instanceof Date ? nowDate : new Date();
    const nowMs = now.getTime();
    if (!isFinite(nowMs)) return [];

    const max = Math.max(1, Math.min(50, Number(limit || 10)));
    const rows = Array.isArray(this.state.reminders) ? this.state.reminders : [];
    const due = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.status !== "pending") continue;
      const dueMs = Date.parse(String(row.due_at || ""));
      if (!isFinite(dueMs) || dueMs > nowMs) continue;

      row.status = "dispatching";
      row.updated_at = now.toISOString();
      row.last_attempt_at = now.toISOString();
      due.push(clone_(row));
      if (due.length >= max) break;
    }

    if (due.length) this.persist_();
    return due;
  }

  markReminderSent(id, sentAt) {
    const token = String(id || "").trim();
    if (!token) return null;

    const reminder = this.findById_(token);
    if (!reminder) return null;

    const at = toIsoString_(sentAt) || new Date().toISOString();
    reminder.status = "sent";
    reminder.sent_at = at;
    reminder.updated_at = at;
    reminder.last_error = "";
    this.persist_();
    return clone_(reminder);
  }

  releaseReminder(id, errorText) {
    const token = String(id || "").trim();
    if (!token) return null;

    const reminder = this.findById_(token);
    if (!reminder) return null;

    reminder.status = "pending";
    reminder.updated_at = new Date().toISOString();
    reminder.last_error = String(errorText || "").trim();
    this.persist_();
    return clone_(reminder);
  }

  findById_(id) {
    const token = String(id || "").trim();
    if (!token) return null;
    const rows = Array.isArray(this.state.reminders) ? this.state.reminders : [];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i] && rows[i].id || "") === token) return rows[i];
    }
    return null;
  }

  resolveReminderByRef_(filter) {
    const src = filter && typeof filter === "object" ? filter : {};
    const refId = String(src.id || src.reminder_id || "").trim();
    if (refId) return this.findById_(refId);

    const indexValue = Number(src.index);
    if (isFinite(indexValue) && indexValue >= 1) {
      const list = this.listReminders({
        session_key: src.session_key,
        sender: src.sender,
        include_done: Boolean(src.include_done),
        limit: 100
      });
      const selected = list[indexValue - 1];
      if (!selected) return null;
      return this.findById_(selected.id);
    }

    return null;
  }

  persist_() {
    const payload = JSON.stringify(this.state, null, 2);
    fs.writeFileSync(this.filePath, payload, "utf8");
  }
}

function loadState_(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      reminders: []
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(String(raw || ""));
    const src = parsed && typeof parsed === "object" ? parsed : {};
    const reminders = Array.isArray(src.reminders) ? src.reminders : [];
    return {
      version: 1,
      reminders: reminders
    };
  } catch (err) {
    return {
      version: 1,
      reminders: []
    };
  }
}

function normalizeWaNumber_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const noPlus = raw.replace(/^\+/, "");
  const beforeAt = noPlus.split("@")[0];
  const beforeDevice = beforeAt.split(":")[0];
  const digits = beforeDevice.replace(/[^\d]/g, "");
  return digits || beforeDevice;
}

function buildId_(prefix) {
  const rnd = Math.random().toString(36).slice(2, 9);
  return String(prefix || "id") + "_" + Date.now() + "_" + rnd;
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIsoString_(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}

function clone_(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir_(dirPath) {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

module.exports = TaskMemoryStore;
