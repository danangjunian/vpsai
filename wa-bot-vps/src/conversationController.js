class ConversationController {
  constructor(options) {
    const cfg = options || {};
    this.aiEngine = cfg.aiEngine;
    this.dataExecutor = cfg.dataExecutor;
    this.agentExecutor = cfg.agentExecutor || null;
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

    if (isCancelMessage_(userMessage)) {
      this.clearPending_(sessionKey);
      const cancelled = "Proses dibatalkan.";
      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: { mode: "AGENT", intent: "GENERAL_CHAT", target_sheet: null, parameters: {} },
        reply_text: cancelled,
        note: "cancel"
      });
      return { reply: cancelled, saveResult: null };
    }

    const pending = this.getPending_(sessionKey);
    const memoryRows = await this.dataExecutor.getRecentMemory(10);

    if (pending && isConfirmSoldPendingKind_(pending.kind)) {
      const pendingResult = await this.handlePendingConfirmSold_({
        userMessage: userMessage,
        sessionKey: sessionKey,
        pending: pending
      });
      if (pendingResult) {
        await this.appendMemorySafe_({
          session_key: sessionKey,
          user_text: userMessage,
          ai_json: { mode: "DATA", intent: "CONFIRM_SOLD", target_sheet: "STOK_MOTOR", parameters: {} },
          executor_json: pendingResult.saveResult || null,
          reply_text: pendingResult.reply,
          note: pendingResult.note || "pending_confirm_sold"
        });
        return { reply: pendingResult.reply, saveResult: pendingResult.saveResult || null };
      }
    }

    let decisionRaw = null;
    try {
      decisionRaw = await this.aiEngine.decide({
        userMessage: userMessage,
        memoryRows: memoryRows,
        pendingClarification: pending
      });
    } catch (err) {
      const failReply = "Maaf, AI sedang sibuk membaca pesan. Coba kirim ulang sebentar lagi.";
      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: null,
        reply_text: failReply,
        note: "decision_error"
      });
      return { reply: failReply, saveResult: null };
    }

    let decision = normalizeDecisionShape_(decisionRaw);
    await this.appendMemorySafe_({
      session_key: sessionKey,
      user_text: userMessage,
      ai_json: decision,
      note: "decision"
    });

    if (decision.mode === "AGENT") {
      this.clearPending_(sessionKey);
      return this.handleAgentMode_({
        userMessage: userMessage,
        messageMeta: messageMeta,
        sessionKey: sessionKey,
        decision: decision,
        memoryRows: memoryRows
      });
    }

    if (normalizeIntentToken_(decision.intent) === "CONFIRM_SOLD" && normalizeSheetToken_(decision.target_sheet) === "STOK_MOTOR") {
      const confirmSoldResult = await this.prepareConfirmSoldFlow_({
        userMessage: userMessage,
        sessionKey: sessionKey,
        pending: pending,
        decision: decision
      });

      if (confirmSoldResult && confirmSoldResult.handled) {
        await this.appendMemorySafe_({
          session_key: sessionKey,
          user_text: userMessage,
          ai_json: decision,
          reply_text: String(confirmSoldResult.reply || ""),
          note: String(confirmSoldResult.note || "confirm_sold_flow")
        });
        return { reply: String(confirmSoldResult.reply || ""), saveResult: confirmSoldResult.saveResult || null };
      }

      if (confirmSoldResult && confirmSoldResult.decision) {
        decision = confirmSoldResult.decision;
      }
    }

    const strictViewQuestion = buildStrictStokMotorViewQuestion_(decision);
    if (strictViewQuestion) {
      const nextAttempts =
        pending &&
        pending.kind === "clarification" &&
        normalizeText_(pending.question || "").toLowerCase() === normalizeText_(strictViewQuestion).toLowerCase()
          ? Number(pending.attempts || 1) + 1
          : 1;

      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "clarification",
        attempts: nextAttempts,
        target_sheet: "STOK_MOTOR",
        decision: decision,
        question: strictViewQuestion
      });

      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        reply_text: strictViewQuestion,
        note: "strict_view_guard"
      });

      return { reply: strictViewQuestion, saveResult: null };
    }

    const hardInputTemplate = buildHardInputTemplateReply_(decision, pending);
    if (hardInputTemplate) {
      const previousAttempts =
        pending &&
        pending.kind === "input_template" &&
        String(pending.target_sheet || "") === String(decision.target_sheet || "")
          ? Number(pending.attempts || 0)
          : 0;

      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "input_template",
        attempts: previousAttempts + 1,
        target_sheet: String(decision.target_sheet || ""),
        question: hardInputTemplate
      });

      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        reply_text: hardInputTemplate,
        note: "hard_input_template"
      });
      return { reply: hardInputTemplate, saveResult: null };
    }

    const needClarify = Boolean(
      decision.needs_clarification ||
      Number(decision.confidence || 0) < this.minConfidence ||
      !String(decision.target_sheet || "").trim()
    );

    if (needClarify) {
      let question = String(decision.clarification_question || "").trim() ||
        await this.composeClarificationQuestionSafe_(userMessage, decision);

      const sameQuestion = Boolean(
        pending &&
        pending.kind === "clarification" &&
        normalizeText_(pending.question || "").toLowerCase() === normalizeText_(question).toLowerCase()
      );
      const attempts = sameQuestion ? (Number(pending.attempts || 1) + 1) : 1;
      if (attempts >= 3) {
        question = buildNoLoopClarification_(decision, question);
      }

      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "clarification",
        attempts: attempts,
        decision: decision,
        question: question
      });

      await this.appendMemorySafe_({
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

    const intentToken = normalizeIntentToken_(decision.intent);
    const mustWaitExecutor = Boolean(EXECUTOR_REQUIRED_INTENTS[intentToken]);
    const hasExecutorResponse = Boolean(executorResult && typeof executorResult === "object");

    if (mustWaitExecutor && !hasExecutorResponse) {
      const blockedReply = "Gagal menerima respons dari Apps Script. Coba lagi beberapa saat.";
      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        executor_json: { error: executionError || "NO_EXECUTOR_RESPONSE" },
        reply_text: blockedReply,
        note: "blocked_no_executor_response"
      });
      return { reply: blockedReply, saveResult: null };
    }

    if (mustWaitExecutor && !isExecutorResponseUsable_(executorResult)) {
      const blockedReply = "Respons data dari Apps Script tidak valid. Coba lagi setelah sinkronisasi deployment.";
      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        executor_json: executorResult || { error: executionError || "INVALID_EXECUTOR_RESPONSE" },
        reply_text: blockedReply,
        note: "blocked_invalid_executor_response"
      });
      return { reply: blockedReply, saveResult: executorResult || null };
    }

    const dataExecutionResult = buildDataExecutionResult_(executorResult, executionError);

    if (intentToken === "INPUT_DATA") {
      const finalInputReply = buildInputDataFinalReply_(decision, executorResult, executionError);
      await this.appendMemorySafe_({
        session_key: sessionKey,
        user_text: userMessage,
        ai_json: decision,
        executor_json: executorResult || { error: executionError },
        reply_text: finalInputReply,
        note: "final_reply_input_data"
      });
      return { reply: finalInputReply, saveResult: executorResult || null };
    }

    let finalReply = "";
    try {
      const finalReplyRaw = await this.aiEngine.composeFinalReply({
        userMessage: userMessage,
        decision: decision,
        executorResult: executorResult,
        dataExecutionResult: dataExecutionResult,
        executionError: executionError
      });
      finalReply = String(finalReplyRaw || "").trim();
    } catch (err) {
      finalReply = "";
    }

    if (!finalReply) {
      finalReply = buildDataFallbackReply_(intentToken, executorResult, executionError);
    }

    if (mustWaitExecutor && shouldBlockNotFoundText_(dataExecutionResult, finalReply)) {
      finalReply = "Data ditemukan di sistem. Coba ulangi perintah supaya jawaban ditampilkan ulang.";
    }

    await this.appendMemorySafe_({
      session_key: sessionKey,
      user_text: userMessage,
      ai_json: decision,
      executor_json: executorResult || { error: executionError },
      reply_text: finalReply,
      note: "final_reply_data"
    });

    return {
      reply: finalReply,
      saveResult: executorResult || null
    };
  }

  async handleAgentMode_(ctx) {
    const userMessage = String(ctx.userMessage || "");
    const decision = ctx.decision && typeof ctx.decision === "object" ? ctx.decision : {};
    const sessionKey = String(ctx.sessionKey || "");
    const messageMeta = ctx.messageMeta && typeof ctx.messageMeta === "object" ? ctx.messageMeta : {};
    const memoryRows = Array.isArray(ctx.memoryRows) ? ctx.memoryRows : [];

    const sender = normalizeSessionToken_(messageMeta.sender || "");
    const chatJid = String(messageMeta.chatJid || "").trim();

    let agentResult = {
      status: "success",
      data: { action: "GENERAL_REPLY" },
      error: null
    };

    if (this.agentExecutor && typeof this.agentExecutor.execute === "function") {
      try {
        agentResult = await this.agentExecutor.execute({
          action: decision.agent_action,
          payload: decision.agent_payload,
          user_message: userMessage,
          session_key: sessionKey,
          sender: sender,
          chat_jid: chatJid
        });
      } catch (err) {
        agentResult = {
          status: "error",
          data: { action: normalizeAgentActionToken_(decision.agent_action) || "GENERAL_REPLY" },
          error: { message: String(err && err.message ? err.message : err || "AGENT_EXECUTOR_ERROR") }
        };
      }
    }

    const action = normalizeAgentActionToken_(
      agentResult &&
      agentResult.data &&
      typeof agentResult.data === "object" &&
      agentResult.data.action !== undefined
        ? agentResult.data.action
        : decision.agent_action
    );

    let reply = "";
    if (action === "GENERAL_REPLY") {
      reply = await this.composeGeneralReplySafe_(userMessage, decision, memoryRows);
    } else {
      try {
        reply = String(await this.aiEngine.composeAgentReply({
          userMessage: userMessage,
          decision: decision,
          agentResult: agentResult
        }) || "").trim();
      } catch (err) {
        reply = "";
      }
    }

    if (!reply) {
      reply = buildAgentFallbackReply_(action, agentResult);
    }

    await this.appendMemorySafe_({
      session_key: sessionKey,
      user_text: userMessage,
      ai_json: decision,
      executor_json: { agent_result: agentResult },
      reply_text: reply,
      note: "final_reply_agent"
    });

    return { reply: reply, saveResult: agentResult };
  }

  async prepareConfirmSoldFlow_(ctx) {
    const payload = ctx && typeof ctx === "object" ? ctx : {};
    const userMessage = normalizeText_(payload.userMessage || "");
    const sessionKey = String(payload.sessionKey || "").trim();
    const decision = payload.decision && typeof payload.decision === "object" ? payload.decision : {};
    const params = ensurePlainObject_(decision.parameters);

    const identifier = await this.extractMotorIdentifierSafe_(params, userMessage);
    if (!identifier.no && !identifier.nama_motor) {
      const reply = buildConfirmSoldAskMotorReply_();
      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "confirm_sold_select",
        attempts: 1,
        target_sheet: "STOK_MOTOR",
        candidates: [],
        question: reply
      });
      return { handled: true, reply: reply, note: "confirm_sold_need_identifier" };
    }

    const lookup = {};
    if (identifier.no) {
      lookup.no = identifier.no;
    } else if (identifier.nama_motor) {
      lookup.nama_motor = identifier.nama_motor;
    }

    const query = await this.queryUnsoldMotorCandidates_(lookup);
    if (!query.ok) {
      const detail = query.error || "Terjadi kendala saat membaca data STOK MOTOR.";
      return {
        handled: true,
        reply: "Gagal membaca data motor: " + detail,
        saveResult: query.result || null,
        note: "confirm_sold_query_error"
      };
    }

    const candidates = Array.isArray(query.candidates) ? query.candidates : [];
    if (!candidates.length) {
      const identifierText = identifier.no
        ? "NO " + identifier.no
        : ("\"" + String(identifier.nama_motor || "").trim() + "\"");
      const reply = [
        "Motor dengan " + identifierText + " tidak ditemukan di stok aktif.",
        "Silakan sebutkan NO motor atau nama motor lain."
      ].join("\n");
      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "confirm_sold_select",
        attempts: 1,
        target_sheet: "STOK_MOTOR",
        candidates: [],
        question: reply
      });
      return { handled: true, reply: reply, note: "confirm_sold_not_found" };
    }

    if (candidates.length === 1) {
      const selected = candidates[0];
      const template = buildConfirmSoldTemplateReply_(selected);
      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "confirm_sold_fill",
        attempts: 1,
        target_sheet: "STOK_MOTOR",
        selected_no: selected.no,
        selected_nama_motor: selected.nama_motor,
        selected_plat: selected.plat,
        question: template
      });
      return { handled: true, reply: template, note: "confirm_sold_template" };
    }

    const selectionReply = buildConfirmSoldSelectionReply_(candidates, false);
    this.setPending_(sessionKey, {
      askedAt: Date.now(),
      kind: "confirm_sold_select",
      attempts: 1,
      target_sheet: "STOK_MOTOR",
      candidates: candidates,
      question: selectionReply
    });

    return { handled: true, reply: selectionReply, note: "confirm_sold_select" };
  }

  async handlePendingConfirmSold_(ctx) {
    const payload = ctx && typeof ctx === "object" ? ctx : {};
    const userMessage = normalizeText_(payload.userMessage || "");
    const sessionKey = String(payload.sessionKey || "").trim();
    const pending = payload.pending && typeof payload.pending === "object" ? payload.pending : {};
    const kind = String(pending.kind || "").trim().toLowerCase();

    if (kind === "confirm_sold_select") {
      const candidates = normalizeMotorCandidates_(pending.candidates);

      if (!candidates.length) {
        return this.prepareConfirmSoldFlow_({
          userMessage: userMessage,
          sessionKey: sessionKey,
          decision: {
            intent: "CONFIRM_SOLD",
            target_sheet: "STOK_MOTOR",
            parameters: {}
          }
        });
      }

      const selected = pickCandidateFromUserText_(userMessage, candidates);
      if (!selected) {
        const maybeIdentifier = await this.extractMotorIdentifierSafe_({}, userMessage);
        if (
          (maybeIdentifier.no || maybeIdentifier.nama_motor) &&
          !hasCandidateMatchByIdentifier_(maybeIdentifier, candidates)
        ) {
          return this.prepareConfirmSoldFlow_({
            userMessage: userMessage,
            sessionKey: sessionKey,
            decision: {
              intent: "CONFIRM_SOLD",
              target_sheet: "STOK_MOTOR",
              parameters: maybeIdentifier
            }
          });
        }

        const nextAttempts = Number(pending.attempts || 1) + 1;
        const reply = buildConfirmSoldSelectionReply_(candidates, true);
        this.setPending_(sessionKey, {
          askedAt: Date.now(),
          kind: "confirm_sold_select",
          attempts: nextAttempts,
          target_sheet: "STOK_MOTOR",
          candidates: candidates,
          question: reply
        });
        return { reply: reply, saveResult: null, note: "confirm_sold_wait_selection" };
      }

      const template = buildConfirmSoldTemplateReply_(selected);
      this.setPending_(sessionKey, {
        askedAt: Date.now(),
        kind: "confirm_sold_fill",
        attempts: 1,
        target_sheet: "STOK_MOTOR",
        selected_no: selected.no,
        selected_nama_motor: selected.nama_motor,
        selected_plat: selected.plat,
        question: template
      });
      return { reply: template, saveResult: null, note: "confirm_sold_template_after_selection" };
    }

    if (kind === "confirm_sold_fill") {
      const selectedNo = normalizeNo_(pending.selected_no);
      const selected = {
        no: selectedNo,
        nama_motor: String(pending.selected_nama_motor || "").trim(),
        plat: String(pending.selected_plat || "").trim()
      };

      if (!selectedNo) {
        this.clearPending_(sessionKey);
        return {
          reply: "Sesi konfirmasi terjual sudah kedaluwarsa. Ulangi dengan sebutkan motor yang terjual.",
          saveResult: null,
          note: "confirm_sold_pending_expired"
        };
      }

      const parsedInput = parseConfirmSoldInput_(userMessage);
      if (!(typeof parsedInput.harga_laku === "number" && isFinite(parsedInput.harga_laku) && parsedInput.harga_laku > 0)) {
        const attempts = Number(pending.attempts || 1) + 1;
        const template = buildConfirmSoldTemplateReply_(selected);
        const reply = [
          "Harga laku belum terbaca atau tidak valid.",
          "Isi ulang dengan format ini:",
          template
        ].join("\n");
        this.setPending_(sessionKey, {
          askedAt: Date.now(),
          kind: "confirm_sold_fill",
          attempts: attempts,
          target_sheet: "STOK_MOTOR",
          selected_no: selected.no,
          selected_nama_motor: selected.nama_motor,
          selected_plat: selected.plat,
          question: template
        });
        return { reply: reply, saveResult: null, note: "confirm_sold_wait_price" };
      }

      const parameters = {
        no: selected.no,
        harga_laku: parsedInput.harga_laku
      };
      if (parsedInput.tgl_terjual) parameters.tgl_terjual = parsedInput.tgl_terjual;
      if (typeof parsedInput.harga_jual === "number" && isFinite(parsedInput.harga_jual) && parsedInput.harga_jual > 0) {
        parameters.harga_jual = parsedInput.harga_jual;
      }

      let saveResult = null;
      let executionError = "";
      try {
        saveResult = await this.dataExecutor.executeData({
          intent: "CONFIRM_SOLD",
          target_sheet: "STOK_MOTOR",
          parameters: parameters
        });
      } catch (err) {
        executionError = String(err && err.message ? err.message : err || "EXECUTOR_ERROR");
      }

      if (!isSuccessResult_(saveResult)) {
        const detail = executionError || extractErrorMessage_(saveResult) || "Terjadi kendala saat konfirmasi.";
        const attempts = Number(pending.attempts || 1) + 1;
        const template = buildConfirmSoldTemplateReply_(selected);
        const reply = [
          "Konfirmasi belum berhasil: " + detail,
          "Silakan isi lagi dengan format ini:",
          template
        ].join("\n");
        this.setPending_(sessionKey, {
          askedAt: Date.now(),
          kind: "confirm_sold_fill",
          attempts: attempts,
          target_sheet: "STOK_MOTOR",
          selected_no: selected.no,
          selected_nama_motor: selected.nama_motor,
          selected_plat: selected.plat,
          question: template
        });
        return { reply: reply, saveResult: saveResult || null, note: "confirm_sold_execute_error" };
      }

      this.clearPending_(sessionKey);
      const reply = buildConfirmSoldSuccessReply_(selected, parsedInput, saveResult);
      return { reply: reply, saveResult: saveResult, note: "confirm_sold_success" };
    }

    return null;
  }

  async extractMotorIdentifierSafe_(decisionParams, userMessage) {
    const params = ensurePlainObject_(decisionParams);
    const noFromParams = normalizeNo_(pickFirstFilledParam_(params, ["no", "nomor", "id"]));
    const nameFromParams = normalizeText_(pickFirstFilledParam_(params, [
      "nama_motor",
      "nama",
      "name",
      "motor_name",
      "keyword",
      "query"
    ]));

    if (noFromParams || nameFromParams) {
      return {
        no: noFromParams,
        nama_motor: nameFromParams
      };
    }

    if (this.aiEngine && typeof this.aiEngine.tryExtractMotorIdentifier_ === "function") {
      try {
        const extracted = await this.aiEngine.tryExtractMotorIdentifier_(userMessage);
        const aiNo = normalizeNo_(extracted && extracted.no);
        const aiName = normalizeText_(extracted && extracted.nama_motor);
        if (aiNo || aiName) {
          return {
            no: aiNo,
            nama_motor: aiName
          };
        }
      } catch (err) {
        // ignore ai extraction fallback error
      }
    }

    const raw = normalizeText_(userMessage);
    const directNo = extractSingleNoFromText_(raw);
    if (directNo) {
      return { no: directNo, nama_motor: "" };
    }

    const fallbackName = extractPossibleMotorName_(raw);
    return { no: "", nama_motor: fallbackName };
  }

  async queryUnsoldMotorCandidates_(lookup) {
    const search = lookup && typeof lookup === "object" ? lookup : {};
    const params = {
      status: "belum_terjual",
      include_sold: false,
      limit: 100
    };

    const queryNo = normalizeNo_(search.no);
    const queryName = normalizeText_(search.nama_motor || search.nama);
    if (queryNo) params.no = queryNo;
    if (!queryNo && queryName) params.nama_motor = queryName;

    let result = null;
    let executionError = "";
    try {
      result = await this.dataExecutor.executeData({
        intent: "VIEW_DATA",
        target_sheet: "STOK_MOTOR",
        parameters: params
      });
    } catch (err) {
      executionError = String(err && err.message ? err.message : err || "EXECUTOR_ERROR");
    }

    if (!isSuccessResult_(result)) {
      return {
        ok: false,
        candidates: [],
        result: result || null,
        error: executionError || extractErrorMessage_(result) || "Gagal membaca STOK_MOTOR."
      };
    }

    const rows = asArrayDataRows_(result && result.data);
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const candidate = normalizeMotorCandidate_(rows[i]);
      if (!candidate) continue;
      if (candidate.status === "terjual") continue;
      out.push(candidate);
    }

    return {
      ok: true,
      candidates: dedupeCandidatesByNo_(out),
      result: result,
      error: ""
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

    const out = Object.assign({}, item);
    out.asked_at = new Date(askedAt).toISOString();
    out.kind = String(item.kind || "clarification");
    out.attempts = Number(item.attempts || 1);
    out.target_sheet = String(item.target_sheet || "");
    out.previous_decision = item.decision || null;
    out.previous_question = String(item.question || "");
    delete out.askedAt;
    delete out.decision;
    delete out.question;
    return out;
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

  async composeGeneralReplySafe_(userMessage, decision, memoryRows) {
    try {
      const text = await this.aiEngine.composeGeneralReply({
        userMessage: userMessage,
        decision: decision,
        memoryRows: memoryRows
      });
      const reply = String(text || "").trim();
      return reply || "Siap, saya bantu.";
    } catch (err) {
      return "Siap, saya bantu.";
    }
  }

  async composeClarificationQuestionSafe_(userMessage, decision) {
    try {
      const text = await this.aiEngine.composeClarificationQuestion({
        userMessage: userMessage,
        decision: decision
      });
      const q = String(text || "").trim();
      return q || "Boleh diperjelas dulu maksudnya?";
    } catch (err) {
      return "Boleh diperjelas dulu maksudnya?";
    }
  }

  async appendMemorySafe_(entry) {
    try {
      await this.dataExecutor.appendMemory(entry);
    } catch (err) {
      // ignore memory failure
    }
  }
}

function normalizeDecisionShape_(decision) {
  const src = decision && typeof decision === "object" ? decision : {};
  const mode = normalizeModeToken_(src.mode);
  const parsedIntent = normalizeIntentToken_(src.intent);

  let normalizedMode = mode;
  if (!normalizedMode) {
    normalizedMode = isDataIntent_(parsedIntent) ? "DATA" : "AGENT";
  }

  const out = {
    mode: normalizedMode,
    intent: "GENERAL_CHAT",
    target_sheet: null,
    parameters: {},
    agent_action: "GENERAL_REPLY",
    agent_payload: {},
    confidence: clamp01_(Number(src.confidence)),
    needs_clarification: Boolean(src.needs_clarification),
    clarification_question: normalizeOptionalString_(src.clarification_question)
  };

  if (normalizedMode === "DATA") {
    out.intent = isDataIntent_(parsedIntent) ? parsedIntent : "";
    out.target_sheet = normalizeSheetToken_(src.target_sheet);
    out.parameters = ensurePlainObject_(src.parameters);
    out.agent_action = "GENERAL_REPLY";
    out.agent_payload = {};

    if (!out.intent) {
      out.mode = "AGENT";
      out.intent = "GENERAL_CHAT";
      out.target_sheet = null;
      out.parameters = {};
    }
  }

  if (out.mode === "AGENT") {
    out.intent = "GENERAL_CHAT";
    out.target_sheet = null;
    out.parameters = {};
    out.agent_action = normalizeAgentActionToken_(src.agent_action);
    out.agent_payload = ensurePlainObject_(src.agent_payload);
    out.needs_clarification = false;
    out.clarification_question = null;
  }

  return out;
}

function normalizeModeToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (token === "DATA") return "DATA";
  if (token === "AGENT") return "AGENT";
  return "";
}

function normalizeIntentToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const alias = {
    INPUT_DATA: "INPUT_DATA",
    EDIT_DATA: "EDIT_DATA",
    VIEW_DATA: "VIEW_DATA",
    DELETE_DATA: "DELETE_DATA",
    CONFIRM_SOLD: "CONFIRM_SOLD",
    CEK_DATA: "VIEW_DATA",
    HAPUS_DATA: "DELETE_DATA",
    KONFIRMASI_TERJUAL: "CONFIRM_SOLD",
    GENERAL_CHAT: "GENERAL_CHAT"
  };
  return alias[token] || "";
}

function normalizeSheetToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const allowed = {
    STOK_MOTOR: true,
    PENGELUARAN_HARIAN: true,
    TOTAL_ASET: true,
    AI_MEMORY: true
  };
  return allowed[token] ? token : "";
}

function normalizeAgentActionToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const alias = {
    GENERAL_REPLY: "GENERAL_REPLY",
    GENERAL: "GENERAL_REPLY",
    NONE: "GENERAL_REPLY",
    CREATE_REMINDER: "CREATE_REMINDER",
    ADD_REMINDER: "CREATE_REMINDER",
    SET_REMINDER: "CREATE_REMINDER",
    LIST_REMINDERS: "LIST_REMINDERS",
    SHOW_REMINDERS: "LIST_REMINDERS",
    GET_REMINDERS: "LIST_REMINDERS",
    DELETE_REMINDER: "DELETE_REMINDER",
    REMOVE_REMINDER: "DELETE_REMINDER",
    COMPLETE_REMINDER: "COMPLETE_REMINDER",
    DONE_REMINDER: "COMPLETE_REMINDER"
  };
  return alias[token] || "GENERAL_REPLY";
}

function isDataIntent_(intent) {
  return Boolean(EXECUTOR_REQUIRED_INTENTS[intent]);
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

function normalizeOptionalString_(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text || null;
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clamp01_(value) {
  if (!isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}

function isCancelMessage_(text) {
  const raw = normalizeText_(text).toLowerCase();
  if (!raw) return false;
  return raw === "batal" ||
    raw === "cancel" ||
    raw === "batalkan" ||
    raw === "ga jadi" ||
    raw === "gak jadi" ||
    raw === "tidak jadi" ||
    raw === "nggak jadi";
}

function buildDataExecutionResult_(executorResult, executionError) {
  const result = executorResult && typeof executorResult === "object" ? executorResult : null;
  return {
    type: "DATA_EXECUTION_RESULT",
    received: Boolean(result),
    status: String(result && result.status || "").trim().toLowerCase() || "error",
    empty: isExecutorDataEmpty_(result),
    data: result && result.data !== undefined ? result.data : null,
    error: result && result.error !== undefined
      ? result.error
      : (executionError ? { message: String(executionError) } : null),
    raw: result || null
  };
}

function isExecutorDataEmpty_(result) {
  if (!result || typeof result !== "object") return false;
  const status = String(result.status || "").trim().toLowerCase();
  if (status !== "success") return false;

  const data = result.data;
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "string") return data.trim() === "";
  if (typeof data === "object") return Object.keys(data).length === 0;
  return false;
}

function shouldBlockNotFoundText_(dataExecutionResult, replyText) {
  const execution = dataExecutionResult && typeof dataExecutionResult === "object" ? dataExecutionResult : {};
  const status = String(execution.status || "").trim().toLowerCase();
  const isEmpty = Boolean(execution.empty);
  if (status !== "success") return false;
  if (isEmpty) return false;
  const text = normalizeText_(replyText).toLowerCase();
  return text.indexOf("tidak ditemukan") !== -1;
}

function isExecutorResponseUsable_(result) {
  const src = result && typeof result === "object" ? result : null;
  if (!src) return false;
  const data = src.data && typeof src.data === "object" ? src.data : null;
  if (!data) return true;
  if (!Object.prototype.hasOwnProperty.call(data, "payload_preview")) return true;
  return String(data.service || "").trim() !== "apps_script_data_executor";
}

function isSuccessResult_(result) {
  const status = String(result && result.status || "").trim().toLowerCase();
  return status === "success";
}

function extractErrorMessage_(result) {
  const src = result && typeof result === "object" ? result : {};
  if (!src.error) return "";
  if (typeof src.error === "string") return src.error;
  if (src.error && typeof src.error === "object") {
    if (src.error.message) return String(src.error.message);
    if (src.error.code) return String(src.error.code);
  }
  return "";
}

function buildInputDataFinalReply_(decision, executorResult, executionError) {
  const d = decision && typeof decision === "object" ? decision : {};
  const targetSheet = String(d.target_sheet || "").trim().toUpperCase();
  const result = executorResult && typeof executorResult === "object" ? executorResult : null;

  if (!isSuccessResult_(result)) {
    const detail = executionError || extractErrorMessage_(result) || "Gagal menyimpan data.";
    return "Gagal menyimpan data: " + detail;
  }

  if (targetSheet === "PENGELUARAN_HARIAN") {
    return "Pengeluaran berhasil disimpan.";
  }
  if (targetSheet === "STOK_MOTOR") {
    const no = normalizeNo_(result && result.data && result.data.no);
    if (no) return "Data motor berhasil disimpan. NO " + no + ".";
    return "Data motor berhasil disimpan.";
  }

  return "Data berhasil disimpan.";
}

function buildDataFallbackReply_(intentToken, executorResult, executionError) {
  if (!isSuccessResult_(executorResult)) {
    const detail = executionError || extractErrorMessage_(executorResult) || "Terjadi kendala saat memproses data.";
    return "Gagal memproses data: " + detail;
  }

  if (intentToken === "VIEW_DATA") {
    return "Data berhasil diambil.";
  }
  if (intentToken === "EDIT_DATA") {
    return "Data berhasil diperbarui.";
  }
  if (intentToken === "DELETE_DATA") {
    return "Data berhasil dihapus.";
  }
  if (intentToken === "CONFIRM_SOLD") {
    return "Konfirmasi terjual berhasil diproses.";
  }

  return "Permintaan berhasil diproses.";
}

function buildHardInputTemplateReply_(decision, pending) {
  const d = decision && typeof decision === "object" ? decision : {};
  const intent = normalizeIntentToken_(d.intent);
  if (intent !== "INPUT_DATA") return "";

  const targetSheet = String(d.target_sheet || "").trim().toUpperCase();
  const params = d.parameters && typeof d.parameters === "object" ? d.parameters : {};

  if (targetSheet === "STOK_MOTOR") {
    const missing = getMissingMotorInputFields_(params);
    if (!missing.length) return "";

    const repeated = Boolean(
      pending &&
      pending.kind === "input_template" &&
      String(pending.target_sheet || "").toUpperCase() === "STOK_MOTOR"
    );
    if (repeated) {
      return [
        "Data belum lengkap. Mohon isi field yang masih kosong:",
        missing.join("\n")
      ].join("\n");
    }

    return [
      "Silakan isi data berikut:",
      "NAMA MOTOR:",
      "TAHUN:",
      "PLAT:",
      "SURAT-SURAT:",
      "TAHUN PLAT:",
      "PAJAK:",
      "HARGA JUAL:",
      "HARGA BELI:"
    ].join("\n");
  }

  if (targetSheet === "PENGELUARAN_HARIAN") {
    const missing = getMissingExpenseInputFields_(params);
    if (!missing.length) return "";

    const repeated = Boolean(
      pending &&
      pending.kind === "input_template" &&
      String(pending.target_sheet || "").toUpperCase() === "PENGELUARAN_HARIAN"
    );
    if (repeated) {
      return [
        "Data pengeluaran belum lengkap. Mohon isi:",
        missing.join("\n")
      ].join("\n");
    }

    return [
      "Silakan isi:",
      "KETERANGAN:",
      "TOTAL:"
    ].join("\n");
  }

  return "";
}

function getMissingMotorInputFields_(params) {
  const src = params && typeof params === "object" ? params : {};
  const out = [];
  if (!pickFirstFilledParam_(src, ["nama_motor", "nama", "name", "motor_name"])) out.push("NAMA MOTOR:");
  if (!pickFirstFilledParam_(src, ["tahun"])) out.push("TAHUN:");
  if (!pickFirstFilledParam_(src, ["plat"])) out.push("PLAT:");
  if (!pickFirstFilledParam_(src, ["surat_surat", "surat"])) out.push("SURAT-SURAT:");
  if (!pickFirstFilledParam_(src, ["tahun_plat", "tahunplat", "thn_plat"])) out.push("TAHUN PLAT:");
  if (!pickFirstFilledParam_(src, ["pajak"])) out.push("PAJAK:");
  if (!pickFirstFilledParam_(src, ["harga_jual", "hargaJual", "jual"])) out.push("HARGA JUAL:");
  if (!pickFirstFilledParam_(src, ["harga_beli", "hargaBeli", "beli"])) out.push("HARGA BELI:");
  return out;
}

function getMissingExpenseInputFields_(params) {
  const src = params && typeof params === "object" ? params : {};
  const out = [];
  if (!pickFirstFilledParam_(src, ["keterangan", "catatan", "deskripsi", "detail"])) out.push("KETERANGAN:");
  if (!pickFirstFilledParam_(src, ["total_pengeluaran", "nominal", "jumlah", "biaya", "total"])) out.push("TOTAL:");
  return out;
}

function buildNoLoopClarification_(decision, fallbackQuestion) {
  const d = decision && typeof decision === "object" ? decision : {};
  const intent = normalizeIntentToken_(d.intent);
  const target = String(d.target_sheet || "").trim().toUpperCase();

  if (intent === "VIEW_DATA" && target === "STOK_MOTOR") {
    return [
      "Agar saya tidak salah ambil data, sebutkan salah satu:",
      "1. NO motor",
      "2. Nama motor yang ingin dicek"
    ].join("\n");
  }

  if (intent === "CONFIRM_SOLD" && target === "STOK_MOTOR") {
    return [
      "Agar konfirmasi tidak salah, sebutkan motor yang dimaksud:",
      "1. NO motor, atau",
      "2. Nama motor"
    ].join("\n");
  }

  if (intent === "INPUT_DATA" && target === "PENGELUARAN_HARIAN") {
    return [
      "Agar langsung tersimpan, kirim dengan format ini:",
      "KETERANGAN:",
      "TOTAL:"
    ].join("\n");
  }

  return String(fallbackQuestion || "Boleh diperjelas dulu maksudnya?");
}

function buildAgentFallbackReply_(action, agentResult) {
  const status = String(agentResult && agentResult.status || "").trim().toLowerCase();
  const errorMessage = extractAgentErrorMessage_(agentResult);

  if (status === "incomplete") {
    return errorMessage || "Detail pengingat belum lengkap. Tolong beri jam atau waktu.";
  }
  if (status === "error") {
    return "Gagal memproses permintaan asisten: " + (errorMessage || "terjadi kendala.");
  }

  const data = agentResult && agentResult.data && typeof agentResult.data === "object"
    ? agentResult.data
    : {};

  if (action === "CREATE_REMINDER") {
    const reminder = data.reminder && typeof data.reminder === "object" ? data.reminder : {};
    const text = String(reminder.text || "").trim();
    const dueLocal = String(reminder.due_at_local || "").trim();
    const out = ["Siap, pengingat sudah dibuat."];
    if (text) out.push("Task: " + text);
    if (dueLocal) out.push("Waktu: " + dueLocal);
    return out.join("\n");
  }

  if (action === "LIST_REMINDERS") {
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];
    if (!reminders.length) return "Belum ada reminder aktif.";
    const lines = ["Reminder aktif:"];
    for (let i = 0; i < reminders.length; i++) {
      const row = reminders[i] || {};
      const idx = Number(row.index || (i + 1));
      const text = String(row.text || "").trim();
      const when = String(row.due_at_local || "").trim();
      lines.push(idx + ". " + text + (when ? " (" + when + ")" : ""));
    }
    return lines.join("\n");
  }

  if (action === "DELETE_REMINDER") {
    return "Reminder berhasil dihapus.";
  }

  if (action === "COMPLETE_REMINDER") {
    return "Reminder sudah ditandai selesai.";
  }

  return "Siap.";
}

function extractAgentErrorMessage_(agentResult) {
  const src = agentResult && typeof agentResult === "object" ? agentResult : {};
  if (!src.error) return "";
  if (typeof src.error === "string") return src.error;
  if (src.error && typeof src.error === "object") {
    if (src.error.message) return String(src.error.message);
    if (src.error.code) return String(src.error.code);
  }
  return "";
}

function pickFirstFilledParam_(obj, keys) {
  const src = obj && typeof obj === "object" ? obj : {};
  const list = Array.isArray(keys) ? keys : [];
  for (let i = 0; i < list.length; i++) {
    const key = String(list[i] || "").trim();
    if (!key) continue;
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && isFinite(value)) return String(value);
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeNo_(value) {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

function isConfirmSoldPendingKind_(kind) {
  const token = String(kind || "").trim().toLowerCase();
  return token === "confirm_sold_select" || token === "confirm_sold_fill";
}

function buildStrictStokMotorViewQuestion_(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const intent = normalizeIntentToken_(d.intent);
  const sheet = normalizeSheetToken_(d.target_sheet);
  if (intent !== "VIEW_DATA" || sheet !== "STOK_MOTOR") return "";
  if (hasMotorIdentifierInParams_(d.parameters)) return "";
  return "Motor mana yang mau dicek? Sebutkan nama motor atau NO motor.";
}

function hasMotorIdentifierInParams_(params) {
  const src = ensurePlainObject_(params);
  const no = normalizeNo_(pickFirstFilledParam_(src, ["no", "nomor", "id"]));
  if (no) return true;
  const name = normalizeText_(pickFirstFilledParam_(src, [
    "nama_motor",
    "nama",
    "name",
    "motor_name",
    "keyword",
    "query"
  ]));
  return Boolean(name);
}

function buildConfirmSoldAskMotorReply_() {
  return [
    "Motor mana yang mau dikonfirmasi terjual?",
    "Sebutkan nama motor atau NO motor."
  ].join("\n");
}

function buildConfirmSoldSelectionReply_(candidates, isRetry) {
  const list = normalizeMotorCandidates_(candidates);
  if (!list.length) return buildConfirmSoldAskMotorReply_();

  const lines = [];
  if (isRetry) {
    lines.push("Pilihan belum terbaca. Pilih salah satu motor di bawah ini dengan kirim NO motor:");
  } else {
    lines.push("Ditemukan beberapa motor yang cocok. Pilih NO motor yang mau dikonfirmasi terjual:");
  }

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const detail = [];
    detail.push("NO " + row.no);
    if (row.nama_motor) detail.push(row.nama_motor);
    if (row.plat) detail.push("Plat " + row.plat);
    lines.push((i + 1) + ". " + detail.join(" | "));
  }

  lines.push("Balas dengan NO motor.");
  return lines.join("\n");
}

function buildConfirmSoldTemplateReply_(candidate) {
  const row = normalizeMotorCandidate_(candidate) || {};
  const lines = [];
  lines.push("Konfirmasi Motor Terjual - No " + String(row.no || "-"));
  if (row.nama_motor) lines.push("NAMA MOTOR: " + row.nama_motor);
  if (row.plat) lines.push("PLAT: " + row.plat);
  lines.push("HARGA LAKU:");
  lines.push("TANGGAL TERJUAL:");
  return lines.join("\n");
}

function buildConfirmSoldSuccessReply_(selected, parsedInput, saveResult) {
  const row = selected && typeof selected === "object" ? selected : {};
  const parsed = parsedInput && typeof parsedInput === "object" ? parsedInput : {};
  const result = saveResult && typeof saveResult === "object" ? saveResult : {};
  const data = result.data && typeof result.data === "object" ? result.data : {};

  const no = normalizeNo_(data.no || row.no);
  const nama = String(row.nama_motor || "").trim();
  const harga = typeof parsed.harga_laku === "number" && isFinite(parsed.harga_laku)
    ? Math.round(parsed.harga_laku)
    : 0;
  const tanggal = String(parsed.tgl_terjual || "").trim() || "hari ini";

  const out = ["Konfirmasi terjual berhasil disimpan."];
  if (no) out.push("NO: " + no);
  if (nama) out.push("Nama: " + nama);
  if (harga > 0) out.push("Harga Laku: " + formatIdrNumber_(harga));
  out.push("Tanggal Terjual: " + tanggal);
  return out.join("\n");
}

function parseConfirmSoldInput_(text) {
  const raw = normalizeText_(text);
  const out = {
    harga_laku: null,
    tgl_terjual: null,
    harga_jual: null
  };
  if (!raw) return out;

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = normalizeSearchText_(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();
    if (!value) continue;

    if (key.indexOf("hargalaku") !== -1 || key === "laku") {
      const parsedHarga = parseCurrencyValue_(value);
      if (parsedHarga !== null) out.harga_laku = parsedHarga;
      continue;
    }
    if (key.indexOf("hargajual") !== -1) {
      const parsedJual = parseCurrencyValue_(value);
      if (parsedJual !== null) out.harga_jual = parsedJual;
      continue;
    }
    if (key.indexOf("tanggalterjual") !== -1 || key.indexOf("tglterjual") !== -1) {
      const parsedDate = parseDateToken_(value);
      if (parsedDate) out.tgl_terjual = parsedDate;
      continue;
    }
  }

  if (!(typeof out.harga_laku === "number" && isFinite(out.harga_laku) && out.harga_laku > 0)) {
    const directHarga = parseCurrencyValue_(raw);
    if (directHarga !== null && directHarga > 0) {
      out.harga_laku = directHarga;
    }
  }

  if (!out.tgl_terjual) {
    const dateFromBody = parseDateToken_(raw);
    if (dateFromBody) out.tgl_terjual = dateFromBody;
  }

  return out;
}

function parseDateToken_(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let m = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (m) {
    let yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    const dt = new Date(yy, Number(m[2]) - 1, Number(m[1]));
    if (!isNaN(dt.getTime())) return formatDateIso_(dt);
  }

  m = raw.match(/\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(dt.getTime())) return formatDateIso_(dt);
  }

  if (normalizeSearchText_(raw).indexOf("hariini") !== -1) {
    return formatDateIso_(new Date());
  }

  return "";
}

function formatDateIso_(dateObj) {
  const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd;
}

function parseCurrencyValue_(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!raw) return null;

  let multiplier = 1;
  if (/\b(m|miliar|milyar)\b/.test(raw)) multiplier = 1000000000;
  else if (/\b(jt|juta)\b/.test(raw)) multiplier = 1000000;
  else if (/\b(rb|ribu)\b/.test(raw)) multiplier = 1000;

  if (multiplier > 1) {
    const decimalMatch = raw.match(/-?\d+(?:[.,]\d+)?/);
    if (decimalMatch) {
      const n = Number(String(decimalMatch[0]).replace(",", "."));
      if (isFinite(n)) return Math.round(n * multiplier);
    }
  }

  const cleaned = raw.replace(/\./g, "").replace(/,/g, ".").replace(/[^0-9\-.]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  if (!isFinite(n)) return null;
  return Math.round(n * multiplier);
}

function asArrayDataRows_(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

function normalizeMotorCandidate_(row) {
  const src = row && typeof row === "object" ? row : {};
  const no = normalizeNo_(src.no || src.nomor || src.id);
  if (!no) return null;
  return {
    no: no,
    nama_motor: normalizeText_(src.nama_motor || src.nama || src.name || src.motor_name),
    plat: normalizeText_(src.plat),
    status: normalizeSearchText_(src.status)
  };
}

function dedupeCandidatesByNo_(list) {
  const rows = Array.isArray(list) ? list : [];
  const seen = {};
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = normalizeMotorCandidate_(rows[i]);
    if (!row) continue;
    if (seen[row.no]) continue;
    seen[row.no] = true;
    out.push(row);
  }
  return out;
}

function normalizeMotorCandidates_(candidates) {
  return dedupeCandidatesByNo_(Array.isArray(candidates) ? candidates : []);
}

function pickCandidateFromUserText_(text, candidates) {
  const list = normalizeMotorCandidates_(candidates);
  if (!list.length) return null;

  const msg = normalizeText_(text);
  const msgNo = extractSingleNoFromText_(msg);
  if (msgNo) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].no === msgNo) return list[i];
    }
  }

  const query = normalizeSearchText_(msg);
  if (!query) return null;
  const matches = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const name = normalizeSearchText_(row.nama_motor);
    const plat = normalizeSearchText_(row.plat);
    if (name && (name.indexOf(query) !== -1 || query.indexOf(name) !== -1)) {
      matches.push(row);
      continue;
    }
    if (plat && (plat.indexOf(query) !== -1 || query.indexOf(plat) !== -1)) {
      matches.push(row);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function hasCandidateMatchByIdentifier_(identifier, candidates) {
  const id = identifier && typeof identifier === "object" ? identifier : {};
  const list = normalizeMotorCandidates_(candidates);
  if (!list.length) return false;

  const no = normalizeNo_(id.no);
  if (no) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].no === no) return true;
    }
    return false;
  }

  const name = normalizeSearchText_(id.nama_motor);
  if (!name) return false;
  for (let i = 0; i < list.length; i++) {
    const candidateName = normalizeSearchText_(list[i].nama_motor);
    if (!candidateName) continue;
    if (candidateName.indexOf(name) !== -1 || name.indexOf(candidateName) !== -1) {
      return true;
    }
  }
  return false;
}

function normalizeSearchText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function extractSingleNoFromText_(text) {
  const raw = normalizeText_(text);
  if (!raw) return "";

  const direct = raw.match(/\bno(?:mor)?\s*[:\-]?\s*(\d{1,6})\b/i);
  if (direct && direct[1]) return normalizeNo_(direct[1]);

  const onlyNumber = raw.match(/^\s*(\d{1,6})\s*$/);
  if (onlyNumber && onlyNumber[1]) return normalizeNo_(onlyNumber[1]);

  return "";
}

function extractPossibleMotorName_(text) {
  const raw = normalizeText_(text);
  if (!raw) return "";
  const stripped = raw
    .replace(/\b(konfirmasi|confirm|terjual|laku|motor|yang|ini|itu|dong|tolong|please|mau|ada|sudah|baru)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  if (normalizeNo_(stripped)) return "";
  return stripped;
}

function formatIdrNumber_(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return String(value || "");
  const rounded = Math.round(n);
  return "Rp " + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const EXECUTOR_REQUIRED_INTENTS = {
  INPUT_DATA: true,
  VIEW_DATA: true,
  EDIT_DATA: true,
  DELETE_DATA: true,
  CONFIRM_SOLD: true
};

module.exports = ConversationController;
