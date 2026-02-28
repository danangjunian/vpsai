class ConversationController {
  constructor(options) {
    const cfg = options || {};
    this.aiEngine = cfg.aiEngine;
    this.dataExecutor = cfg.dataExecutor;
    this.minConfidence = Number(cfg.minConfidence || 0.75);
    this.pendingTtlMs = Math.max(60 * 1000, Number(cfg.pendingTtlMs || (15 * 60 * 1000)));
    this.pendingClarifications = new Map();

    if (!this.aiEngine || typeof this.aiEngine.decide !== "function") {
      throw new Error("ConversationController membutuhkan aiEngine.decide");
    }
    if (!this.dataExecutor || typeof this.dataExecutor.executeDecision !== "function") {
      throw new Error("ConversationController membutuhkan dataExecutor.executeDecision");
    }
  }

  async processIncomingText(text, messageMeta) {
    const userMessage = normalizeText_(text);
    if (!userMessage) {
      return { reply: "", saveResult: null };
    }

    this.cleanupPending_();
    const sessionKey = buildSessionKey_(messageMeta);
    const pending = this.getPending_(sessionKey);
    const memoryRows = await this.dataExecutor.getRecentMemory(10);

    const decision = await this.aiEngine.decide({
      userMessage: userMessage,
      memoryRows: memoryRows,
      pendingClarification: pending
    });

    await this.dataExecutor.appendMemory({
      session_key: sessionKey,
      user_text: userMessage,
      ai_json: decision,
      note: "decision"
    });

    const needClarify = Boolean(
      decision && (decision.needs_clarification || Number(decision.confidence || 0) < this.minConfidence)
    );

    if (needClarify) {
      const question = String(decision && decision.clarification_question || "").trim() ||
        await this.aiEngine.composeClarificationQuestion({
          userMessage: userMessage,
          decision: decision
        });

      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        decision: decision,
        question: question
      });

      await this.dataExecutor.appendMemory({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        reply_text: question,
        note: "clarification"
      });

      return { reply: question, saveResult: null };
    }

    this.clearPending_(sessionKey);

    let executorResult = null;
    let executionError = "";

    try {
      executorResult = await this.dataExecutor.executeDecision(decision);
    } catch (err) {
      executionError = String(err && err.message ? err.message : err || "EXECUTOR_ERROR");
    }

    const finalReply = await this.aiEngine.composeFinalReply({
      userMessage: userMessage,
      decision: decision,
      executorResult: executorResult,
      executionError: executionError
    });

    await this.dataExecutor.appendMemory({
      session_key: sessionKey,
      user_text: userMessage,
      ai_json: decision,
      executor_json: executorResult || { error: executionError },
      reply_text: finalReply,
      note: "final_reply"
    });

    return {
      reply: finalReply,
      saveResult: executorResult
    };
  }

  getPending_(sessionKey) {
    const key = String(sessionKey || "").trim();
    if (!key) return null;

    const item = this.pendingClarifications.get(key);
    if (!item) return null;

    const askedAt = Number(item.askedAt || 0);
    if (!askedAt || Date.now() - askedAt > this.pendingTtlMs) {
      this.pendingClarifications.delete(key);
      return null;
    }

    return {
      asked_at: new Date(askedAt).toISOString(),
      previous_decision: item.decision || null,
      previous_question: String(item.question || "")
    };
  }

  setPending_(sessionKey, value) {
    const key = String(sessionKey || "").trim();
    if (!key) return;
    this.pendingClarifications.set(key, value && typeof value === "object" ? value : {});
  }

  clearPending_(sessionKey) {
    const key = String(sessionKey || "").trim();
    if (!key) return;
    this.pendingClarifications.delete(key);
  }

  cleanupPending_() {
    const now = Date.now();
    const entries = Array.from(this.pendingClarifications.entries());
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const item = entries[i][1] || {};
      const askedAt = Number(item.askedAt || 0);
      if (!askedAt || now - askedAt > this.pendingTtlMs) {
        this.pendingClarifications.delete(key);
      }
    }
  }
}

function buildSessionKey_(messageMeta) {
  const meta = messageMeta && typeof messageMeta === "object" ? messageMeta : {};
  const sender = normalizeSessionToken_(meta.sender || meta.chatJid || meta.chat_jid || "");
  const chat = normalizeSessionToken_(meta.chatJid || meta.chat_jid || meta.sender || "");
  return sender + "|" + chat;
}

function normalizeSessionToken_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "-";
  const noPlus = raw.replace(/^\+/, "");
  const beforeAt = noPlus.split("@")[0];
  const beforeDevice = beforeAt.split(":")[0];
  const digits = beforeDevice.replace(/[^\d]/g, "");
  return digits || beforeDevice || "-";
}

function normalizeText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

module.exports = ConversationController;
