const axios = require("axios");
const { SYSTEM_PROMPT } = require("./systemPrompt");
const { warn, error } = require("../utils/logger");

class AIAgent {
  constructor(options) {
    const cfg = options || {};
    this.apiKey = String(cfg.apiKey || "").trim();
    this.model = String(cfg.model || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 20000));
    this.toolExecutor = cfg.toolExecutor;
    this.tools = this.toolExecutor && typeof this.toolExecutor.getToolDefinitions === "function"
      ? this.toolExecutor.getToolDefinitions()
      : [];
    this.histories = new Map();
    this.maxHistoryMessages = Math.max(10, Number(cfg.maxHistoryMessages || 36));
    this.maxToolRounds = Math.max(2, Number(cfg.maxToolRounds || 8));
  }

  isReady() {
    return Boolean(this.apiKey);
  }

  async handleMessage(input) {
    const payload = input && typeof input === "object" ? input : {};
    const userPhone = String(payload.userPhone || "").trim() || "unknown";
    const text = String(payload.text || "").trim();
    if (!text) return "";

    if (!this.isReady()) {
      return "OpenAI API key belum diatur.";
    }

    const key = userPhone;
    const history = this.getHistory(key);
    const turnMessages = history.concat([{ role: "user", content: text }]);

    const firstPass = await this.runAgentLoop(turnMessages, {
      userPhone: userPhone,
      userText: text
    });
    let finalReply = String(firstPass.reply || "").trim();
    if (!finalReply) {
      const detail = String(firstPass.error || "").trim();
      finalReply = detail
        ? ("Proses tidak menghasilkan jawaban final. Detail: " + detail)
        : "Proses tidak menghasilkan jawaban final.";
    }

    const previousAssistant = findLastAssistantText(history);
    if (previousAssistant && normalizeForCompare(previousAssistant) === normalizeForCompare(finalReply)) {
      const retryMessages = firstPass.messages.concat([
        {
          role: "user",
          content: "Jangan ulang jawaban sebelumnya. Lanjutkan proses berdasarkan pesan user terakhir."
        }
      ]);
      const secondPass = await this.runAgentLoop(retryMessages, {
        userPhone: userPhone,
        userText: text
      });
      const retryReply = String(secondPass.reply || "").trim();
      if (retryReply && normalizeForCompare(retryReply) !== normalizeForCompare(previousAssistant)) {
        finalReply = retryReply;
        this.setHistory(key, trimHistory(secondPass.messages, this.maxHistoryMessages));
        return finalReply;
      }
    }

    this.setHistory(key, trimHistory(firstPass.messages, this.maxHistoryMessages));
    return finalReply;
  }

  async runAgentLoop(inputMessages, context) {
    const messages = Array.isArray(inputMessages) ? inputMessages.slice() : [];

    for (let round = 0; round < this.maxToolRounds; round++) {
      const completion = await this.createCompletion(messages);
      const aiMessage = completion && completion.aiMessage ? completion.aiMessage : null;
      if (!aiMessage) {
        const detail = String(completion && completion.errorMessage ? completion.errorMessage : "").trim();
        return {
          reply: detail
            ? ("Proses dihentikan karena error OpenAI: " + detail)
            : "Proses dihentikan karena OpenAI tidak mengembalikan respons.",
          messages: messages,
          error: detail || "OPENAI_EMPTY_RESPONSE"
        };
      }

      const toolCalls = asToolCalls(aiMessage);
      messages.push(buildAssistantMessage(aiMessage));

      if (toolCalls.length === 0) {
        const text = extractTextContent(aiMessage.content);
        return {
          reply: text,
          messages: messages
        };
      }

      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call && call.function ? String(call.function.name || "").trim() : "";
        const rawArgs = call && call.function ? call.function.arguments : "";
        const parsedArgs = safeJsonParse(rawArgs);

        let result;
        try {
          console.log("TOOL CALLED:", toolName);
          result = await this.toolExecutor.execute(toolName, parsedArgs, context);
          console.log("TOOL RESULT:", result);
        } catch (err) {
          console.error("TOOL ERROR:", err);
          error("tool_execute_failed", { tool: toolName, message: err.message });
          result = {
            status: "error",
            message: "Tool execution failed: " + String(err.message || err)
          };
          console.log("TOOL RESULT:", result);
        }

        messages.push({
          role: "tool",
          tool_call_id: String(call.id || ""),
          name: toolName,
          content: safeJsonStringify(result)
        });
      }
    }

    warn("tool_round_limit_reached", { maxToolRounds: this.maxToolRounds });
    return {
      reply: "Proses dihentikan karena melebihi batas langkah internal (" + this.maxToolRounds + ").",
      messages: messages,
      error: "TOOL_ROUND_LIMIT_REACHED"
    };
  }

  async createCompletion(messages) {
    try {
      const res = await axios.post(
        this.baseUrl + "/chat/completions",
        {
          model: this.model,
          temperature: 0.1,
          messages: [{ role: "system", content: SYSTEM_PROMPT }].concat(sanitizeMessages(messages)),
          tools: this.tools,
          tool_choice: "auto"
        },
        {
          timeout: this.timeoutMs,
          headers: {
            Authorization: "Bearer " + this.apiKey,
            "Content-Type": "application/json"
          }
        }
      );

      const choices = res && res.data && Array.isArray(res.data.choices) ? res.data.choices : [];
      if (!choices.length) {
        return {
          aiMessage: null,
          errorMessage: "OPENAI_CHOICES_EMPTY"
        };
      }
      return {
        aiMessage: choices[0] && choices[0].message ? choices[0].message : null,
        errorMessage: ""
      };
    } catch (err) {
      error("openai_completion_failed", {
        message: err.message,
        status: Number(err && err.response && err.response.status ? err.response.status : 0)
      });
      const status = Number(err && err.response && err.response.status ? err.response.status : 0);
      const code = String(err && err.code ? err.code : "").trim();
      const message = String(err && err.message ? err.message : "").trim();
      return {
        aiMessage: null,
        errorMessage: [status > 0 ? ("HTTP " + status) : "", code, message].filter(Boolean).join(" - ") || "OPENAI_REQUEST_FAILED"
      };
    }
  }

  getHistory(userKey) {
    const arr = this.histories.get(String(userKey || "")) || [];
    return Array.isArray(arr) ? arr.slice() : [];
  }

  setHistory(userKey, messages) {
    this.histories.set(String(userKey || ""), Array.isArray(messages) ? messages.slice() : []);
  }
}

function sanitizeMessages(messages) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];

  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").trim();
    if (!role) continue;

    if (role === "assistant") {
      const item = {
        role: "assistant",
        content: m.content === null || m.content === undefined ? "" : m.content
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        item.tool_calls = m.tool_calls.map((tc) => ({
          id: String(tc && tc.id ? tc.id : ""),
          type: "function",
          function: {
            name: String(tc && tc.function && tc.function.name ? tc.function.name : ""),
            arguments: String(tc && tc.function && tc.function.arguments ? tc.function.arguments : "{}")
          }
        }));
      }
      out.push(item);
      continue;
    }

    if (role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: String(m.tool_call_id || ""),
        name: String(m.name || ""),
        content: String(m.content || "")
      });
      continue;
    }

    if (role === "user" || role === "system") {
      out.push({
        role: role,
        content: String(m.content || "")
      });
    }
  }

  return out;
}

function buildAssistantMessage(message) {
  const item = {
    role: "assistant",
    content: message && message.content !== undefined ? message.content : ""
  };

  const toolCalls = asToolCalls(message);
  if (toolCalls.length) {
    item.tool_calls = toolCalls.map((call) => ({
      id: String(call.id || ""),
      type: "function",
      function: {
        name: String(call.function && call.function.name ? call.function.name : ""),
        arguments: String(call.function && call.function.arguments ? call.function.arguments : "{}")
      }
    }));
  }
  return item;
}

function asToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter((x) => x && x.type === "function" && x.function && x.function.name);
}

function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const merged = content
      .map((x) => {
        if (!x || typeof x !== "object") return "";
        if (typeof x.text === "string") return x.text;
        if (typeof x.content === "string") return x.content;
        return "";
      })
      .join("")
      .trim();
    return merged;
  }
  return "";
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch (err) {
    return JSON.stringify({ status: "error", message: "tool result stringify failed" });
  }
}

function trimHistory(messages, maxMessages) {
  const arr = Array.isArray(messages) ? messages : [];
  const max = Math.max(10, Number(maxMessages || 30));
  if (arr.length <= max) return arr.slice();
  return arr.slice(arr.length - max);
}

function normalizeForCompare(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findLastAssistantText(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const row = arr[i];
    if (row && row.role === "assistant") {
      const text = extractTextContent(row.content);
      if (text) return text;
    }
  }
  return "";
}

module.exports = AIAgent;
