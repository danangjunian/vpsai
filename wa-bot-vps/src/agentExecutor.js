const JAKARTA_UTC_OFFSET_MINUTES = 7 * 60;

class AgentExecutor {
  constructor(options) {
    const cfg = options || {};
    this.store = cfg.taskMemoryStore;
    this.defaultTimeZone = String(cfg.defaultTimeZone || "Asia/Jakarta").trim() || "Asia/Jakarta";

    if (!this.store || typeof this.store.createReminder !== "function") {
      throw new Error("AgentExecutor membutuhkan taskMemoryStore.");
    }
  }

  async execute(input) {
    const src = input && typeof input === "object" ? input : {};
    const action = normalizeAction_(src.action);
    const payload = ensurePlainObject_(src.payload);
    const userMessage = String(src.user_message || "").trim();
    const sessionKey = String(src.session_key || "").trim();
    const sender = normalizeWaNumber_(src.sender);
    const chatJid = String(src.chat_jid || "").trim();

    if (action === "CREATE_REMINDER") {
      return this.createReminder_({
        payload: payload,
        userMessage: userMessage,
        sessionKey: sessionKey,
        sender: sender,
        chatJid: chatJid
      });
    }

    if (action === "LIST_REMINDERS") {
      return this.listReminders_({
        payload: payload,
        sessionKey: sessionKey,
        sender: sender
      });
    }

    if (action === "DELETE_REMINDER" || action === "COMPLETE_REMINDER") {
      return this.updateReminderStatus_({
        action: action,
        payload: payload,
        sessionKey: sessionKey,
        sender: sender,
        userMessage: userMessage
      });
    }

    return {
      status: "success",
      data: {
        action: "GENERAL_REPLY"
      },
      error: null
    };
  }

  createReminder_(ctx) {
    const payload = ensurePlainObject_(ctx.payload);
    const userMessage = String(ctx.userMessage || "").trim();
    const taskText = extractReminderTaskText_(payload, userMessage);
    const dueAt = parseReminderDueAt_(payload, userMessage, new Date());

    if (!dueAt) {
      return {
        status: "incomplete",
        data: {
          action: "CREATE_REMINDER",
          missing: ["time"]
        },
        error: {
          code: "MISSING_TIME",
          message: "Jam pengingat belum jelas. Contoh: `ingatkan jam 21:00`."
        }
      };
    }

    const reminder = this.store.createReminder({
      session_key: ctx.sessionKey,
      sender: ctx.sender,
      chat_jid: ctx.chatJid,
      target_number: ctx.sender,
      text: taskText,
      due_at: dueAt.toISOString(),
      payload: payload
    });

    return {
      status: "success",
      data: {
        action: "CREATE_REMINDER",
        reminder: {
          id: reminder.id,
          text: reminder.text,
          due_at: reminder.due_at,
          due_at_local: formatJakartaDateTime_(new Date(reminder.due_at)),
          status: reminder.status
        }
      },
      error: null
    };
  }

  listReminders_(ctx) {
    const payload = ensurePlainObject_(ctx.payload);
    const includeDone = toBool_(payload.include_done);
    const rows = this.store.listReminders({
      session_key: ctx.sessionKey,
      sender: ctx.sender,
      include_done: includeDone,
      limit: payload.limit
    });

    return {
      status: "success",
      data: {
        action: "LIST_REMINDERS",
        total: rows.length,
        reminders: rows.map(function (row, idx) {
          return {
            index: idx + 1,
            id: row.id,
            text: row.text,
            due_at: row.due_at,
            due_at_local: formatJakartaDateTime_(new Date(row.due_at)),
            status: row.status
          };
        })
      },
      error: null
    };
  }

  updateReminderStatus_(ctx) {
    const payload = ensurePlainObject_(ctx.payload);
    const ref = extractReminderRef_(payload, ctx.userMessage);
    const status = ctx.action === "DELETE_REMINDER" ? "deleted" : "completed";

    if (!ref.id && !isFinite(ref.index)) {
      return {
        status: "incomplete",
        data: {
          action: ctx.action,
          missing: ["reminder_reference"]
        },
        error: {
          code: "MISSING_REMINDER_REF",
          message: "Sebutkan nomor reminder yang dimaksud. Contoh: `hapus reminder 2`."
        }
      };
    }

    const updated = this.store.updateReminderStatusByRef({
      session_key: ctx.sessionKey,
      sender: ctx.sender,
      id: ref.id,
      index: ref.index,
      status: status
    });

    if (!updated) {
      return {
        status: "error",
        data: {
          action: ctx.action
        },
        error: {
          code: "REMINDER_NOT_FOUND",
          message: "Reminder yang dipilih tidak ditemukan."
        }
      };
    }

    return {
      status: "success",
      data: {
        action: ctx.action,
        reminder: {
          id: updated.id,
          text: updated.text,
          due_at: updated.due_at,
          due_at_local: formatJakartaDateTime_(new Date(updated.due_at)),
          status: updated.status
        }
      },
      error: null
    };
  }
}

function normalizeAction_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const alias = {
    CREATE_REMINDER: "CREATE_REMINDER",
    ADD_REMINDER: "CREATE_REMINDER",
    SET_REMINDER: "CREATE_REMINDER",
    LIST_REMINDERS: "LIST_REMINDERS",
    SHOW_REMINDERS: "LIST_REMINDERS",
    GET_REMINDERS: "LIST_REMINDERS",
    DELETE_REMINDER: "DELETE_REMINDER",
    REMOVE_REMINDER: "DELETE_REMINDER",
    COMPLETE_REMINDER: "COMPLETE_REMINDER",
    DONE_REMINDER: "COMPLETE_REMINDER",
    GENERAL_REPLY: "GENERAL_REPLY",
    NONE: "GENERAL_REPLY"
  };
  return alias[token] || "GENERAL_REPLY";
}

function parseReminderDueAt_(payload, userMessage, now) {
  const src = ensurePlainObject_(payload);
  const nowDate = now instanceof Date ? now : new Date();

  const direct = toValidDate_(src.due_at || src.dueAt || src.datetime || src.date_time);
  if (direct) return direct;

  const textSource = [
    String(src.time || ""),
    String(src.time_text || ""),
    String(src.when || ""),
    String(src.date || ""),
    String(userMessage || "")
  ].join(" ").trim();

  if (!textSource) return null;

  const timeMatch = textSource.match(/(?:jam\s*)?(\d{1,2})(?:[:.](\d{1,2}))?/i);
  if (!timeMatch) return null;

  let hh = Number(timeMatch[1]);
  let mm = Number(timeMatch[2] || 0);
  if (!isFinite(hh) || hh < 0 || hh > 23) return null;
  if (!isFinite(mm) || mm < 0 || mm > 59) mm = 0;

  let dayOffset = 0;
  const lower = String(textSource || "").toLowerCase();
  if (lower.indexOf("lusa") !== -1) dayOffset = 2;
  else if (lower.indexOf("besok") !== -1) dayOffset = 1;

  const nowParts = toJakartaParts_(nowDate);
  let year = nowParts.year;
  let month = nowParts.month;
  let day = nowParts.day + dayOffset;

  const explicitDate = lower.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (explicitDate) {
    day = Number(explicitDate[1]);
    month = Number(explicitDate[2]);
    const yyRaw = Number(explicitDate[3] || year);
    year = yyRaw < 100 ? yyRaw + 2000 : yyRaw;
  }

  let due = fromJakartaParts_(year, month, day, hh, mm);
  if (dayOffset === 0 && !explicitDate) {
    if (due.getTime() <= nowDate.getTime() + (30 * 1000)) {
      due = fromJakartaParts_(nowParts.year, nowParts.month, nowParts.day + 1, hh, mm);
    }
  }

  return due;
}

function extractReminderTaskText_(payload, userMessage) {
  const src = ensurePlainObject_(payload);
  const direct = firstNonEmpty_([
    src.task,
    src.text,
    src.title,
    src.reminder_text,
    src.message
  ]);
  if (direct) return String(direct).trim();

  const raw = String(userMessage || "").trim();
  if (!raw) return "Pengingat";

  const cleaned = raw
    .replace(/\b(ingatkan|ingat|reminder|tolong|nanti|ya|dong)\b/gi, " ")
    .replace(/\b(besok|lusa|hari ini|jam)\b/gi, " ")
    .replace(/\d{1,2}([:.]\d{1,2})?/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "Pengingat dari chat";
}

function extractReminderRef_(payload, userMessage) {
  const src = ensurePlainObject_(payload);
  const id = String(src.reminder_id || src.id || "").trim();
  if (id) return { id: id, index: NaN };

  const idx = Number(src.index || src.no || src.nomor);
  if (isFinite(idx) && idx >= 1) return { id: "", index: Math.floor(idx) };

  const msg = String(userMessage || "");
  const m = msg.match(/\b(\d{1,3})\b/);
  if (m) {
    const parsed = Number(m[1]);
    if (isFinite(parsed) && parsed >= 1) return { id: "", index: parsed };
  }

  return { id: "", index: NaN };
}

function formatJakartaDateTime_(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(String(dateObj || ""));
  if (isNaN(d.getTime())) return "";
  const p = toJakartaParts_(d);
  return (
    String(p.day).padStart(2, "0") + "/" +
    String(p.month).padStart(2, "0") + "/" +
    String(p.year).padStart(4, "0") + " " +
    String(p.hour).padStart(2, "0") + ":" +
    String(p.minute).padStart(2, "0")
  );
}

function toJakartaParts_(dateObj) {
  const base = dateObj instanceof Date ? dateObj : new Date(String(dateObj || ""));
  const shifted = new Date(base.getTime() + (JAKARTA_UTC_OFFSET_MINUTES * 60000));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

function fromJakartaParts_(year, month, day, hour, minute) {
  const utcMs = Date.UTC(
    Number(year || 0),
    Number(month || 1) - 1,
    Number(day || 1),
    Number(hour || 0) - 7,
    Number(minute || 0),
    0,
    0
  );
  return new Date(utcMs);
}

function toValidDate_(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return null;
  return d;
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

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toBool_(value) {
  if (value === true || value === false) return value;
  const token = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!token) return false;
  return token === "1" || token === "true" || token === "yes" || token === "y" || token === "on";
}

function firstNonEmpty_(list) {
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i++) {
    const text = String(arr[i] === undefined || arr[i] === null ? "" : arr[i]).trim();
    if (text) return text;
  }
  return "";
}

module.exports = AgentExecutor;
