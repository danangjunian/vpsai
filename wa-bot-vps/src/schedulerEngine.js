class SchedulerEngine {
  constructor(options) {
    const cfg = options || {};
    this.enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);
    this.pollIntervalMs = Math.max(5000, Number(cfg.pollIntervalMs || 20000));
    this.batchSize = Math.max(1, Math.min(50, Number(cfg.batchSize || 10)));
    this.taskMemoryStore = cfg.taskMemoryStore;
    this.sendText = typeof cfg.sendText === "function" ? cfg.sendText : null;
    this.debug = Boolean(cfg.debug);

    this.timer = null;
    this.inFlight = false;

    if (!this.taskMemoryStore || typeof this.taskMemoryStore.claimDueReminders !== "function") {
      throw new Error("SchedulerEngine membutuhkan taskMemoryStore.claimDueReminders");
    }
  }

  start() {
    if (!this.enabled) return false;
    if (!this.sendText) return false;
    if (this.timer) return true;

    const self = this;
    this.timer = setInterval(function () {
      self.tick().catch(function (err) {
        if (self.debug) {
          console.error("[scheduler] tick error:", err.message);
        }
      });
    }, this.pollIntervalMs);

    this.tick().catch(function () {
      // ignore first tick error
    });

    return true;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() {
    return Boolean(this.timer);
  }

  async tick() {
    if (!this.enabled) return;
    if (!this.sendText) return;
    if (this.inFlight) return;

    this.inFlight = true;
    try {
      const due = this.taskMemoryStore.claimDueReminders(new Date(), this.batchSize);
      if (!Array.isArray(due) || !due.length) return;

      for (let i = 0; i < due.length; i++) {
        const row = due[i] || {};
        const target = normalizeWaNumber_(row.target_number || row.sender);
        const text = buildReminderMessage_(row);
        if (!target || !text) {
          this.taskMemoryStore.releaseReminder(row.id, "INVALID_REMINDER_PAYLOAD");
          continue;
        }

        try {
          await this.sendText(target, text, { source: "SCHEDULER", reminder: row });
          this.taskMemoryStore.markReminderSent(row.id, new Date().toISOString());
        } catch (err) {
          this.taskMemoryStore.releaseReminder(
            row.id,
            String(err && err.message ? err.message : err || "SEND_FAILED")
          );
        }
      }
    } finally {
      this.inFlight = false;
    }
  }
}

function buildReminderMessage_(reminder) {
  const row = reminder && typeof reminder === "object" ? reminder : {};
  const text = String(row.text || "").trim();
  if (!text) return "";

  const dueAt = formatDateTime_(row.due_at);
  const out = [
    "Pengingat:",
    text
  ];
  if (dueAt) {
    out.push("Waktu: " + dueAt);
  }
  return out.join("\n");
}

function formatDateTime_(value) {
  const d = value instanceof Date ? value : new Date(String(value || ""));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
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

module.exports = SchedulerEngine;
