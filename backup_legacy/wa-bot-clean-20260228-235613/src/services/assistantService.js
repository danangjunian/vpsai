const axios = require("axios");
const { normalizeText } = require("../utils/text");

class AssistantService {
  constructor(options) {
    const cfg = options || {};
    this.apiKey = String(cfg.openaiApiKey || "").trim();
    this.model = String(cfg.openaiModel || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.openaiBaseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.openaiTimeoutMs || 15000));
    this.reminderService = cfg.reminderService || null;
  }

  isReady() {
    return Boolean(this.apiKey);
  }

  async handle(payload) {
    const input = payload && typeof payload === "object" ? payload : {};
    const text = normalizeText(input.text || "");
    const userPhone = String(input.userPhone || "").trim();
    if (!text) return { reply: "" };

    const action = await this.decideAssistantAction(text, input.context || {});

    if (action.type === "create_reminder" && this.reminderService) {
      const dueAt = normalizeText(action.due_at_iso || "");
      const task = normalizeText(action.task || text);
      if (!dueAt) {
        return { reply: "Waktu reminder belum jelas. Sebutkan tanggal/jam yang kamu mau." };
      }
      const row = this.reminderService.addReminder(userPhone, task, dueAt);
      if (!row) return { reply: "Reminder gagal dibuat." };
      return {
        reply: [
          "Siap, reminder dibuat.",
          "Task: " + row.text,
          "Waktu: " + row.dueAt
        ].join("\n")
      };
    }

    if (action.type === "list_reminder" && this.reminderService) {
      const rows = this.reminderService.listReminders(userPhone);
      if (!rows.length) return { reply: "Belum ada reminder aktif." };
      const lines = ["Reminder aktif:"];
      for (let i = 0; i < rows.length; i++) {
        lines.push((i + 1) + ". " + rows[i].text + " | " + rows[i].dueAt);
      }
      return { reply: lines.join("\n") };
    }

    if (action.type === "delete_reminder" && this.reminderService) {
      const idx = Number(action.reminder_index || 0);
      const ok = this.reminderService.deleteReminderByIndex(userPhone, idx);
      return { reply: ok ? "Reminder berhasil dihapus." : "Nomor reminder tidak valid." };
    }

    return { reply: normalizeText(action.reply || "Siap.") };
  }

  async decideAssistantAction(text, context) {
    if (!this.isReady()) {
      return { type: "reply", reply: "Siap. Saya bantu." };
    }

    const prompt = {
      text: text,
      context: context && typeof context === "object" ? context : {},
      timezone: "Asia/Jakarta",
      now_iso: new Date().toISOString()
    };

    try {
      const res = await axios.post(this.baseUrl + "/chat/completions", {
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Kamu adalah Assistant Action Planner.",
              "Kamu HARUS output JSON valid saja.",
              "Pilih salah satu type berikut:",
              "- reply",
              "- create_reminder",
              "- list_reminder",
              "- delete_reminder",
              "Schema:",
              "{",
              '  "type": "reply|create_reminder|list_reminder|delete_reminder",',
              '  "reply": "string",',
              '  "task": "string|null",',
              '  "due_at_iso": "YYYY-MM-DDTHH:mm:00+07:00|null",',
              '  "reminder_index": "number|null"',
              "}",
              "Aturan:",
              "1) Jika user minta pengingat/reminder -> create_reminder.",
              "2) Jika user minta lihat reminder -> list_reminder.",
              "3) Jika user minta hapus reminder nomor tertentu -> delete_reminder.",
              "4) Selain itu -> reply natural, singkat.",
              "5) Jangan bahas data spreadsheet di sini."
            ].join("\n")
          },
          { role: "user", content: JSON.stringify(prompt) }
        ]
      }, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json"
        }
      });

      const parsed = JSON.parse(extractContent_(res && res.data ? res.data : "{}"));
      const out = parsed && typeof parsed === "object" ? parsed : {};
      const type = String(out.type || "reply").trim().toLowerCase();
      if (!["reply", "create_reminder", "list_reminder", "delete_reminder"].includes(type)) {
        return { type: "reply", reply: normalizeText(out.reply || "Siap.") };
      }
      return {
        type,
        reply: normalizeText(out.reply || ""),
        task: normalizeText(out.task || ""),
        due_at_iso: normalizeText(out.due_at_iso || ""),
        reminder_index: Number(out.reminder_index || 0)
      };
    } catch (err) {
      return { type: "reply", reply: "Siap." };
    }
  }
}

function extractContent_(response) {
  const choices = response && Array.isArray(response.choices) ? response.choices : [];
  if (!choices.length) return "{}";
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === "string") return msg.content.trim() || "{}";
  if (!Array.isArray(msg.content)) return "{}";
  const merged = msg.content
    .map((x) => (x && typeof x.text === "string" ? x.text : ""))
    .join("")
    .trim();
  return merged || "{}";
}

module.exports = AssistantService;
