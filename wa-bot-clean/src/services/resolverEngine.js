const { error } = require("../utils/logger");
const ConversationEngine = require("./conversationEngine");

const SYSTEM_FETCH_ERROR = "Maaf, saya tidak dapat mengambil data dari sistem saat ini.";
const EMPTY_RESULT_MESSAGE = "Tidak ditemukan data yang sesuai.";
const INVALID_CONTEXT_MESSAGE = "Context sebelumnya tidak lagi valid. Silakan pilih data motor kembali.";
const AMBIGUITY_MESSAGE = "Terdapat beberapa motor yang cocok. Pilih nomor motor yang dimaksud.";
const PARTIAL_RETRY_MESSAGE = "Maaf, ada item yang belum berhasil diproses. Saya akan memproses ulang.";
const PARTIAL_FAILURE_MESSAGE = "Beberapa data belum berhasil diproses.";
const DATASET_SAFETY_MESSAGE = "Saya perlu memastikan data mana yang dimaksud.";

const MOTOR_FULL_FIELDS = [
  "no",
  "nama_motor",
  "tahun",
  "plat",
  "surat_surat",
  "tahun_plat",
  "pajak",
  "harga_beli",
  "harga_jual",
  "harga_laku",
  "sold"
];

const EXPENSE_FULL_FIELDS = [
  "no",
  "tanggal",
  "keterangan",
  "total_pengeluaran"
];

const SUPPORTED_METRICS = [
  "",
  "list",
  "count",
  "sum",
  "profit",
  "revenue"
];

const SUPPORTED_ENTITIES = [
  "motor",
  "sales",
  "pengeluaran",
  "global_summary",
  "reminder",
  "general"
];

class ResolverEngine {
  constructor(options) {
    const cfg = options || {};
    this.toolExecutor = cfg.toolExecutor;
    this.apps = cfg.appsScriptClient;
    this.reminders = cfg.reminderService;
    this.timezone = String(cfg.timezone || "Asia/Jakarta").trim() || "Asia/Jakarta";
    this.conversation = cfg.conversationEngine instanceof ConversationEngine
      ? cfg.conversationEngine
      : new ConversationEngine();
    if (this.apps && typeof this.apps === "object") {
      const currentTimeout = Number(this.apps.timeoutMs || 0);
      if (!currentTimeout || currentTimeout < 30000) {
        this.apps.timeoutMs = 30000;
      }
    }
  }

  getSession(context) {
    return this.conversation.getSession(context);
  }

  resetAllSessions() {
    this.conversation.resetAllSessions();
  }

  clearSession(session) {
    this.conversation.resetSession(session);
  }

  getSessionSnapshot(context) {
    return this.conversation.getSessionSnapshot(context);
  }

  async resolve(payload, context) {
    const parsed = normalizeParsed(payload);
    const session = this.getSession(context);
    this.conversation.expireSession(session);
    if (this.conversation.prepareTurn) this.conversation.prepareTurn(session, parsed);

    if (parsed.user_context === "reset_flow") {
      this.clearSession(session);
      return { handled: true, reply: "Baik, konteks sebelumnya saya reset. Silakan jelaskan lagi data atau aksi yang Anda maksud." };
    }

    if (!session.pendingAction && parsed.user_context === "force_execute") {
      return { handled: true, reply: "Tidak ada proses yang sedang menunggu untuk dilanjutkan." };
    }

    const pendingDisposition = this.conversation.decidePendingDisposition
      ? this.conversation.decidePendingDisposition(session, parsed)
      : "none";

    if (pendingDisposition === "reset") {
      this.clearSession(session);
      return { handled: true, reply: "Baik, konteks sebelumnya saya reset. Silakan jelaskan lagi data atau aksi yang Anda maksud." };
    }

    if (pendingDisposition === "cancel") {
      this.conversation.clearConversation(session);
      return { handled: true, reply: "Baik, proses sebelumnya saya batalkan." };
    }

    if (pendingDisposition === "supersede") {
      this.conversation.clearConversation(session);
    }

    if (session.pendingAction && pendingDisposition !== "supersede") {
      const pendingResult = await this.continuePendingAction(parsed, context, session);
      if (pendingResult && pendingResult.handled) return pendingResult;
    }

    if (isVerificationOnlyCorrection(parsed) || shouldHandleResultVerification(parsed, context, session)) {
      const verification = await this.handleResultVerification(parsed, context, session);
      if (verification && verification.handled) return verification;
    }

    if (parsed.action === "correction") {
      return this.handleCorrection(parsed, context, session);
    }

    if (parsed.action === "query") {
      return this.handleQuery(parsed, context, session);
    }

    if (parsed.action === "reminder") {
      return this.handleReminder(parsed, context, session);
    }

    if (parsed.action === "create" || parsed.action === "update" || parsed.action === "delete" || parsed.action === "confirm") {
      return this.handleAction(parsed, context, session);
    }

    this.conversation.touch(session);
    return { handled: false, reply: "" };
  }

  async handleCorrection(parsed, context, session) {
    if (
      !normalizeCorrectionType(parsed && parsed.correction_type)
      && !hasSelectorContent(parsed && parsed.selector)
      && !hasMeaningfulFilterEntries(parsed && parsed.filters)
      && !hasNonEmptyMutationPayload(parsed && parsed.mutation_payload)
      && !(Array.isArray(parsed && parsed.projection) && parsed.projection.length)
      && !hasDateRange(parsed && parsed.temporal)
    ) {
      const verification = await this.handleResultVerification(parsed, context, session);
      if (verification && verification.handled) return verification;
    }

    const rewrite = rewriteCorrectionSemanticPayload(parsed, session);
    if (rewrite.resetOnly) {
      this.conversation.clearQueryContext(session);
       if (this.conversation.clearCorrectionWindow) this.conversation.clearCorrectionWindow(session);
      return { handled: true, reply: "Baik, konteks sebelumnya saya abaikan. Silakan jelaskan lagi data atau aksi yang Anda maksud." };
    }
    if (!rewrite.payload) {
      return { handled: true, reply: "Maaf, saya belum punya konteks sebelumnya yang valid untuk dikoreksi." };
    }

    const rewritten = normalizeParsed(rewrite.payload);
    if (rewritten.action === "query") {
      const plan = buildQueryPlan(rewritten, null, { mergePrevious: false });
      const invalidContextReply = this.resolveInvalidContextReference(rewritten, session);
      if (invalidContextReply) return { handled: true, reply: invalidContextReply };
      const ambiguityReply = this.resolveAmbiguousReference(rewritten, plan, session);
      if (ambiguityReply) return { handled: true, reply: ambiguityReply };
      const contextProjection = this.resolveContextProjection(rewritten, plan, session);
      if (contextProjection) {
        this.conversation.rememberQuery(session, plan, contextProjection.rows || [], contextProjection.source || "", rewritten);
        return {
          handled: true,
          reply: "Maaf, saya salah memahami sebelumnya. Saya hitung ulang dengan parameter yang benar.\n" + String(contextProjection.reply || "")
        };
      }
      const executed = await this.executeQueryPlan(plan, context);
      if (!executed.handled) return executed;
      if (executed.systemError) return executed;
      if (!executed.rows || !executed.rows.length) {
        if (hasFreshReferenceConstraints(rewritten)) {
          this.conversation.invalidateQueryContext(session, "empty_after_correction");
          return { handled: true, reply: EMPTY_RESULT_MESSAGE };
        }
        this.conversation.invalidateQueryContext(session, "empty_after_correction");
        return { handled: true, reply: INVALID_CONTEXT_MESSAGE };
      }
      this.conversation.rememberQuery(session, plan, executed.rows || [], executed.source || "", rewritten);
      return {
        handled: true,
        reply: "Maaf, saya salah memahami sebelumnya. Saya hitung ulang dengan parameter yang benar.\n" + String(executed.reply || "")
      };
    }

    if (rewritten.action === "reminder") {
      return this.handleReminder(rewritten, context, session);
    }

    if (rewritten.action === "create" || rewritten.action === "update" || rewritten.action === "delete" || rewritten.action === "confirm") {
      const successfulRevision = await this.handleSuccessfulActionCorrection(rewritten, context, session);
      if (successfulRevision && successfulRevision.handled) return successfulRevision;
      return this.handleAction(rewritten, context, session);
    }

    return { handled: true, reply: "Maaf, saya belum bisa menerapkan koreksi itu pada konteks saat ini." };
  }

  async handleQuery(parsed, context, session) {
    const plan = buildQueryPlan(parsed, session.lastQuery, {
      mergePrevious: shouldMergeWithPreviousQuery(parsed, session.lastQuery)
    });
    const invalidContextReply = this.resolveInvalidContextReference(parsed, session);
    if (invalidContextReply) return { handled: true, reply: invalidContextReply };
    const detachedProjectionReply = this.resolveDetachedProjection(parsed, plan, session);
    if (detachedProjectionReply) return { handled: true, reply: detachedProjectionReply };
    const ambiguityReply = this.resolveAmbiguousReference(parsed, plan, session);
    if (ambiguityReply) return { handled: true, reply: ambiguityReply };
    const contextProjection = this.resolveContextProjection(parsed, plan, session);
    if (contextProjection) {
      this.conversation.rememberQuery(session, plan, contextProjection.rows || [], contextProjection.source || "", parsed);
      return contextProjection;
    }
    const executed = await this.executeQueryPlan(plan, context);
    if (!executed.handled) return executed;

    if (executed.rows && executed.rows.length) {
      this.conversation.rememberQuery(session, plan, executed.rows || [], executed.source || "", parsed);
    } else if (normalizeReferenceMode(parsed.reference_mode || (parsed.reference && parsed.reference.mode)) === "last_query") {
      this.conversation.invalidateQueryContext(session, "empty_reference_query");
      if (hasFreshReferenceConstraints(parsed)) {
        return { handled: true, reply: EMPTY_RESULT_MESSAGE };
      }
      return { handled: true, reply: INVALID_CONTEXT_MESSAGE };
    }

    return executed;
  }

  async handleAction(parsed, context, session) {
    const lowConfidenceReply = lowConfidenceMutationReply(parsed);
    if (lowConfidenceReply) return { handled: true, reply: lowConfidenceReply };
    const safetyReply = this.enforceMutationTargetSafety(parsed, session);
    if (safetyReply) return { handled: true, reply: safetyReply };
    if (parsed.action === "create" && parsed.entity === "motor") return this.handleCreateMotor(parsed, context, session);
    if (parsed.action === "create" && parsed.entity === "pengeluaran") return this.handleCreateExpense(parsed, context, session);
    if (parsed.action === "update" && parsed.entity === "motor") return this.handleEditMotor(parsed, context, session);
    if (parsed.action === "delete" && parsed.entity === "motor") return this.handleDeleteMotor(parsed, context, session);
    if (parsed.action === "confirm" && (parsed.entity === "sales" || parsed.entity === "motor")) return this.handleConfirmSale(parsed, context, session);
    this.conversation.touch(session);
    return { handled: false, reply: "" };
  }

  enforceMutationTargetSafety(parsed, session) {
    const current = parsed && typeof parsed === "object" ? parsed : {};
    const action = normalizeAction(current.action);
    if (action === "create" || action === "reminder" || action === "query" || action === "chat" || action === "correction") return "";

    if (hasExplicitMutationTarget(current, session)) return "";
    return buildStructuredReply("AMBIGUITY REQUEST", DATASET_SAFETY_MESSAGE);
  }

  async postActionAudit(batch, executor, metadata) {
    return this.verifyExecutionResult(batch, executor, metadata);
  }

  async verifyExecutionResult(batch, executor, metadata) {
    const current = normalizeVerificationBatch(batch);
    const anchorMismatch = current.executedTargets > 0 && current.anchors.length < current.executedTargets;
    if ((!current.expectedTargets || current.executedTargets >= current.expectedTargets) && !anchorMismatch) {
      return current;
    }

    if (!current.failures.length || typeof executor !== "function") {
      current.partialFailure = true;
      return current;
    }

    const retried = await retryMutationFailures(current.failures, executor);
    const merged = mergeMutationBatchResults(current, retried);
    merged.retryAttempted = true;
    merged.partialFailure = merged.executedTargets < merged.expectedTargets || (merged.executedTargets > 0 && merged.anchors.length < merged.executedTargets);
    if (merged.retryAttempted) {
      merged.verificationNotice = PARTIAL_RETRY_MESSAGE;
    }
    return merged;
  }

  async handleResultVerification(parsed, context, session) {
    const state = session && typeof session === "object" ? session : null;
    if (!state) return null;

    const receipt = extractActionReceipt(state);
    if (receipt) {
      if (Number(receipt.expectedTargets || 0) > Number(receipt.executedTargets || 0) || (Array.isArray(receipt.failures) && receipt.failures.length)) {
        const retriedReceipt = await this.retryReceiptFailures(receipt, context, state);
        if (retriedReceipt && retriedReceipt !== receipt) {
          this.conversation.rememberCompletion(state, retriedReceipt);
          return {
            handled: true,
            reply: buildStructuredReply("CORRECTION CONFIRMED", [
              PARTIAL_RETRY_MESSAGE,
              buildActionReceiptReply(retriedReceipt)
            ].filter(Boolean).join("\n"))
          };
        }

      return {
        handled: true,
        reply: buildStructuredReply("CORRECTION CONFIRMED", buildActionReceiptReply(receipt))
      };
      }

      return {
        handled: true,
        reply: buildStructuredReply("CORRECTION CONFIRMED", buildSatisfiedReceiptReply(receipt))
      };
    }

    const queryContext = state.lastQueryContext && typeof state.lastQueryContext === "object"
      ? state.lastQueryContext
      : null;
    if (queryContext && state.lastQuery) {
      const executed = await this.executeQueryPlan(state.lastQuery, context);
      if (!executed.handled) return executed;
      if (executed.systemError) return executed;
      if (executed.rows && executed.rows.length) {
        this.conversation.rememberQuery(state, state.lastQuery, executed.rows || [], executed.source || "", state.lastSemanticPayload || null);
        const previousCount = Number(queryContext.rows_returned || 0);
        const currentCount = Array.isArray(executed.rows) ? executed.rows.length : 0;
        if (currentCount > previousCount) {
          return {
            handled: true,
            reply: buildStructuredReply("CORRECTION CONFIRMED", [
              "Maaf, tadi ada data yang belum saya tampilkan.",
              String(executed.reply || "")
            ].join("\n"))
          };
        }
        return {
          handled: true,
          reply: buildStructuredReply("QUERY RESULT", currentCount <= 1
            ? "Data yang saya temukan memang hanya satu."
            : "Data yang saya temukan memang hanya " + currentCount + ".")
        };
      }
      return { handled: true, reply: buildStructuredReply("QUERY RESULT", EMPTY_RESULT_MESSAGE) };
    }

    return null;
  }

  async retryReceiptFailures(receipt, context, session) {
    const current = receipt && typeof receipt === "object" ? receipt : null;
    if (!current || !Array.isArray(current.failures) || !current.failures.length) return current;
    const executor = this.buildReceiptRetryExecutor(current, context);
    if (!executor) return current;

    const retried = await retryMutationFailures(current.failures, executor);
    const merged = mergeReceiptWithRetry(current, retried);
    if (merged.executedTargets <= Number(current.executedTargets || 0)) return current;
    return merged;
  }

  buildReceiptRetryExecutor(receipt, context) {
    const current = receipt && typeof receipt === "object" ? receipt : null;
    if (!current) return null;
    const action = normalizeAction(current.action);
    const entity = canonicalEntity(current.entity);

    if (action === "create" && entity === "motor") {
      return async (target) => this.executeInsertMotorTarget(context, target);
    }
    if (action === "create" && entity === "pengeluaran") {
      return async (target) => this.executeInsertExpenseTarget(context, target);
    }
    if (action === "confirm" && entity === "sales") {
      return async (target) => this.executeConfirmSaleTarget(context, target && target.row, target && target.price);
    }
    if (action === "update" && entity === "motor") {
      return async (target) => this.executeUpdateMotorTarget(context, target && target.row, target && target.patch);
    }
    if (action === "delete" && entity === "motor") {
      return async (target) => this.executeDeleteMotorTarget(context, target && target.row, target && target.no);
    }
    return null;
  }

  async handleReminder(parsed, context, session) {
    this.conversation.enterCollect(session);
    const payload = applyEntityDefaults("reminder", mergeReminderPayload({}, parsed.mutation_payload), this.timezone);
    const dueAt = normalizeText(payload.due_at);
    const text = normalizeText(payload.text || parsed.value);
    if (!dueAt || !text) {
      return { handled: true, reply: "Waktu atau isi reminder belum jelas. Contoh: ingatkan aku besok jam 9 makan." };
    }
    this.conversation.enterExecute(session);
    const result = await this.toolExecutor.execute("create_reminder", {
      phone: String(context && context.userPhone || "").trim(),
      due_at: dueAt,
      text: text
    }, context);

    if (!isSuccess(result)) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: normalizeToolError(result, "Gagal membuat reminder.") };
    }
    this.conversation.completeWithReceipt(session, {
      action: "reminder",
      entity: "reminder"
    });

    return { handled: true, reply: "Reminder disimpan untuk " + formatDateTimeForReply(dueAt, this.timezone) + ": " + text };
  }

  async handleCreateMotor(parsed, context, session) {
    this.conversation.enterCollect(session);
    const targets = normalizeTargets(parsed.mutation_payload, parsed.targets);
    const payloads = targets.map((target) => mergeMotorPayload({}, target && target.mutation_payload));
    const total = Math.max(payloads.length || 0, Math.max(1, Number(parsed.count || 0) || 1));
    const payload = payloads[0] || mergeMotorPayload({}, parsed.mutation_payload);

    if (!hasMotorPayload(payload)) {
      const blocks = [];
      for (let i = 1; i <= total; i++) blocks.push(buildInputMotorTemplate(i, total));
      return { handled: true, reply: blocks.join("\n\n") };
    }

    const incompleteTargets = payloads
      .map((item, index) => ({ index: index, payload: item, missing: missingMotorFields(item) }))
      .filter((item) => item.missing.length > 0);
    const completePayloads = payloads.filter((item) => missingMotorFields(item).length === 0);
    if (payloads.length > 1 && completePayloads.length > 0) {
      const response = await this.finalizeInsertMotor(context, session, completePayloads, payloads.length);
      if (incompleteTargets.length) {
        response.reply = appendSupplementalReply(response.reply, buildMultiTargetMissingReply("motor", incompleteTargets));
      }
      return response;
    }
    if (payloads.length > 1 && incompleteTargets.length > 0) {
      return { handled: true, reply: buildMultiTargetMissingReply("motor", incompleteTargets) };
    }

    const missing = missingMotorFields(payload);
    if (!missing.length && payloads.length <= 1) {
      return this.finalizeInsertMotor(context, session, payload);
    }
    if (payloads.length > 1) {
      return this.finalizeInsertMotor(context, session, payloads);
    }

    this.conversation.enterCollect(session, {
      action: "create",
      entity: "motor",
      payload: payload,
      missingFields: missing,
      semanticPayload: cloneJson(parsed)
    });
    return { handled: true, reply: buildMotorMissingReply(missing) };
  }

  async handleCreateExpense(parsed, context, session) {
    this.conversation.enterCollect(session);
    const targets = normalizeTargets(parsed.mutation_payload, parsed.targets);
    const payloads = targets.map((target) => applyEntityDefaults("pengeluaran", mergeExpensePayload({}, target && target.mutation_payload), this.timezone));
    const payload = payloads[0] || applyEntityDefaults("pengeluaran", mergeExpensePayload({}, parsed.mutation_payload), this.timezone);
    if (!hasExpensePayload(payload)) {
      return { handled: true, reply: buildInputExpenseTemplate() };
    }

    const incompleteTargets = payloads
      .map((item, index) => ({ index: index, payload: item, missing: missingExpenseFields(item) }))
      .filter((item) => item.missing.length > 0);
    const completePayloads = payloads.filter((item) => missingExpenseFields(item).length === 0);
    if (payloads.length > 1 && completePayloads.length > 0) {
      const response = await this.finalizeInsertExpense(context, session, completePayloads, payloads.length);
      if (incompleteTargets.length) {
        response.reply = appendSupplementalReply(response.reply, buildMultiTargetMissingReply("pengeluaran", incompleteTargets));
      }
      return response;
    }
    if (payloads.length > 1 && incompleteTargets.length > 0) {
      return { handled: true, reply: buildMultiTargetMissingReply("pengeluaran", incompleteTargets) };
    }

    const missing = missingExpenseFields(payload);
    if (!missing.length && payloads.length <= 1) {
      return this.finalizeInsertExpense(context, session, payload);
    }
    if (payloads.length > 1) {
      return this.finalizeInsertExpense(context, session, payloads);
    }

    this.conversation.enterCollect(session, {
      action: "create",
      entity: "pengeluaran",
      payload: payload,
      missingFields: missing,
      semanticPayload: cloneJson(parsed)
    });
    return { handled: true, reply: buildExpenseMissingReply(missing) };
  }

  async handleConfirmSale(parsed, context, session) {
    const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
    if (targets.length > 1) {
      return this.handleMultiConfirmSale(parsed, context, session, targets);
    }

    const candidates = await this.resolveMotorCandidates(extractMotorSelectionFilters(parsed), { sold: false });
    if (candidates.systemError) return candidates;
    if (candidates.needsSelector) {
      return { handled: true, reply: "Motor apa yang mau dikonfirmasi terjual?" };
    }
    if (!candidates.rows.length) {
      return { handled: true, reply: EMPTY_RESULT_MESSAGE };
    }
    if (candidates.rows.length > 1) {
      this.conversation.enterCollect(session, {
        action: "confirm",
        entity: "sales",
        stage: "select",
        candidates: cloneJson(candidates.rows),
        payload: mergeMotorPayload({}, parsed.mutation_payload),
        semanticPayload: cloneJson(parsed)
      });
      return { handled: true, reply: formatMotorRows(candidates.rows, [], { full: true }) };
    }

    const selected = candidates.rows[0];
    const price = extractSalePrice(parsed);
    if (price > 0) return this.finalizeConfirmSale(context, session, selected, price);

    this.conversation.enterCollect(session, {
      action: "confirm",
      entity: "sales",
      stage: "price",
      selectedRow: cloneJson(selected),
      payload: mergeMotorPayload({}, parsed.mutation_payload),
      semanticPayload: cloneJson(parsed)
    });
    return { handled: true, reply: buildConfirmSaleTemplate(selected) };
  }

  async handleEditMotor(parsed, context, session) {
    const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
    if (targets.length > 1) {
      return this.handleMultiEditMotor(parsed, context, session, targets);
    }

    const patch = buildEditPatch(parsed);
    if (patch.error) return { handled: true, reply: patch.error };

    const candidates = await this.resolveMotorCandidates(extractMotorSelectionFilters(parsed), { includeSold: true });
    if (candidates.systemError) return candidates;
    if (candidates.needsSelector) {
      return { handled: true, reply: "Motor mana yang ingin diedit?" };
    }
    if (!candidates.rows.length) {
      return { handled: true, reply: EMPTY_RESULT_MESSAGE };
    }
    if (candidates.rows.length > 1) {
      this.conversation.enterCollect(session, {
        action: "update",
        entity: "motor",
        stage: "select",
        candidates: cloneJson(candidates.rows),
        patch: patch.patch,
        semanticPayload: cloneJson(parsed)
      });
      return { handled: true, reply: formatMotorRows(candidates.rows, [], { full: true }) };
    }

    const selected = candidates.rows[0];
    if (!patch.hasPatch) {
      this.conversation.enterCollect(session, {
        action: "update",
        entity: "motor",
        stage: "patch",
        selectedRow: cloneJson(selected),
        patch: patch.patch,
        semanticPayload: cloneJson(parsed)
      });
      return { handled: true, reply: buildEditPrompt(selected) };
    }

    return this.finalizeEditMotor(context, session, selected, patch.patch);
  }

  async handleDeleteMotor(parsed, context, session) {
    const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
    if (targets.length > 1) {
      return this.handleMultiDeleteMotor(parsed, context, session, targets);
    }

    const candidates = await this.resolveMotorCandidates(extractMotorSelectionFilters(parsed), { includeSold: true });
    if (candidates.systemError) return candidates;
    if (candidates.needsSelector) {
      return { handled: true, reply: "Motor mana yang ingin dihapus?" };
    }
    if (!candidates.rows.length) {
      return { handled: true, reply: EMPTY_RESULT_MESSAGE };
    }
    if (candidates.rows.length > 1) {
      this.conversation.enterCollect(session, {
        action: "delete",
        entity: "motor",
        stage: "select",
        candidates: cloneJson(candidates.rows),
        semanticPayload: cloneJson(parsed)
      });
      return { handled: true, reply: formatMotorRows(candidates.rows, [], { full: true }) };
    }

    return this.finalizeDeleteMotor(context, session, candidates.rows[0]);
  }

  async continuePendingAction(parsed, context, session) {
    const pending = session.pendingAction;
    if (!pending || typeof pending !== "object") return { handled: false, reply: "" };

    if (parsed.user_context === "cancel_pending") {
      this.conversation.complete(session);
      return { handled: true, reply: "Baik, proses sebelumnya saya batalkan." };
    }

    if (pending.action === "create" && pending.entity === "motor") {
      if (parsed.user_context === "force_execute") {
        return this.finalizeInsertMotor(context, session, pending.payload || {});
      }

      const merged = mergeMotorPayload(pending.payload, parsed.mutation_payload);
      if (hasMotorPayload(merged) && !sameJson(merged, pending.payload)) {
        pending.payload = merged;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
        pending.missingFields = missingMotorFields(merged);
        if (!pending.missingFields.length) {
          return this.finalizeInsertMotor(context, session, merged);
        }
        this.conversation.enterCollect(session, pending);
        return { handled: true, reply: buildMotorMissingReply(pending.missingFields) };
      }
      return { handled: true, reply: buildMotorMissingReply(pending.missingFields || []) };
    }

    if (pending.action === "create" && pending.entity === "pengeluaran") {
      if (parsed.user_context === "force_execute") {
        return this.finalizeInsertExpense(context, session, pending.payload || {});
      }

      const merged = mergeExpensePayload(pending.payload, parsed.mutation_payload);
      if (hasExpensePayload(merged) && !sameJson(merged, pending.payload)) {
        pending.payload = merged;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
        pending.missingFields = missingExpenseFields(merged);
        if (!pending.missingFields.length) {
          return this.finalizeInsertExpense(context, session, merged);
        }
        this.conversation.enterCollect(session, pending);
        return { handled: true, reply: buildExpenseMissingReply(pending.missingFields) };
      }
      return { handled: true, reply: buildExpenseMissingReply(pending.missingFields || []) };
    }

    if (pending.action === "confirm" && pending.stage === "select") {
      const mergedPayload = mergeMotorPayload(pending.payload || {}, parsed.mutation_payload);
      if (!sameJson(mergedPayload, pending.payload || {})) {
        pending.payload = mergedPayload;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
      }
      const selected = selectCandidate(pending.candidates, parsed);
      if (!selected) {
        this.conversation.enterCollect(session, pending);
        return {
          handled: true,
          reply: parseFlexibleNumber(pending.payload && pending.payload.harga_laku) > 0
            ? "Baik, harga laku saya perbarui menjadi " + rupiah(parseFlexibleNumber(pending.payload.harga_laku)) + ". Pilih nomor motor yang dimaksud."
            : "Terdapat beberapa motor yang cocok. Pilih nomor motor yang dimaksud."
        };
      }

      const price = extractSalePriceFromPending(parsed, pending);
      if (price > 0) return this.finalizeConfirmSale(context, session, selected, price);

      this.conversation.enterCollect(session, {
        action: "confirm",
        entity: "sales",
        stage: "price",
        selectedRow: cloneJson(selected),
        payload: pending.payload || {},
        semanticPayload: pending.semanticPayload || cloneJson(parsed)
      });
      return { handled: true, reply: buildConfirmSaleTemplate(selected) };
    }

    if (pending.action === "confirm" && pending.stage === "price") {
      const mergedPayload = mergeMotorPayload(pending.payload || {}, parsed.mutation_payload);
      if (!sameJson(mergedPayload, pending.payload || {})) {
        pending.payload = mergedPayload;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
      }
      const price = extractSalePriceFromPending(parsed, pending);
      if (price > 0) return this.finalizeConfirmSale(context, session, pending.selectedRow, price);
      return { handled: true, reply: buildConfirmSaleTemplate(pending.selectedRow) };
    }

    if (pending.action === "update" && pending.stage === "select") {
      const patch = buildEditPatch(parsed, pending.patch || {});
      if (!sameJson(patch.patch || {}, pending.patch || {})) {
        pending.patch = patch.patch;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
      }
      const selected = selectCandidate(pending.candidates, parsed);
      if (!selected) {
        this.conversation.enterCollect(session, pending);
        return { handled: true, reply: "Terdapat beberapa motor yang cocok. Pilih nomor motor yang dimaksud." };
      }
      if (patch.error) return { handled: true, reply: patch.error };
      if (patch.hasPatch) return this.finalizeEditMotor(context, session, selected, patch.patch);

      this.conversation.enterCollect(session, {
        action: "update",
        entity: "motor",
        stage: "patch",
        selectedRow: cloneJson(selected),
        patch: pending.patch || {},
        semanticPayload: pending.semanticPayload || cloneJson(parsed)
      });
      return { handled: true, reply: buildEditPrompt(selected) };
    }

    if (pending.action === "update" && pending.stage === "patch") {
      const patch = buildEditPatch(parsed, pending.patch || {});
      if (!sameJson(patch.patch || {}, pending.patch || {})) {
        pending.patch = patch.patch;
        pending.semanticPayload = rewritePendingSemanticPayload(pending.semanticPayload, parsed, pending);
      }
      if (patch.error) return { handled: true, reply: patch.error };
      if (patch.hasPatch) return this.finalizeEditMotor(context, session, pending.selectedRow, patch.patch);
      return { handled: true, reply: buildEditPrompt(pending.selectedRow) };
    }

    if (pending.action === "delete" && pending.stage === "select") {
      const selected = selectCandidate(pending.candidates, parsed);
      if (!selected) {
        this.conversation.enterCollect(session, pending);
        return { handled: true, reply: "Terdapat beberapa motor yang cocok. Pilih nomor motor yang dimaksud." };
      }
      return this.finalizeDeleteMotor(context, session, selected);
    }

    return { handled: false, reply: "" };
  }

  async finalizeInsertMotor(context, session, payload, expectedTargetsOverride) {
    this.conversation.enterExecute(session);
    const targets = normalizeTargets(payload, null).map((item) => mergeMotorPayload({}, item && item.mutation_payload ? item.mutation_payload : item));
    let batch = await executeMutationLoop(targets, async (target) => this.executeInsertMotorTarget(context, target));
    batch = await this.postActionAudit(batch, async (target) => this.executeInsertMotorTarget(context, target), {
      action: "create",
      entity: "motor"
    });
    if (!batch.results.length) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: batch.firstError || "Gagal input data motor." };
    }
    const expectedTargets = Math.max(batch.results.length, Number(expectedTargetsOverride || batch.expectedTargets || batch.results.length));
    this.conversation.completeWithReceipt(session, {
      action: "create",
      entity: "motor",
      payload: cloneJson(batch.primaryPayload || {}),
      targets: batch.results.map((item) => buildActionTarget(item)),
      anchors: batch.anchors,
      failures: batch.failures,
      expectedTargets: expectedTargets,
      executedTargets: batch.results.length
    });
    return { handled: true, reply: buildMutationReply("create", "motor", Object.assign({}, batch, {
      expectedTargets: expectedTargets
    }), {
      single: "Motor berhasil ditambahkan.",
      multi: "Motor berhasil ditambahkan:"
    }) };
  }

  async finalizeInsertExpense(context, session, payload, expectedTargetsOverride) {
    this.conversation.enterExecute(session);
    const targets = normalizeTargets(payload, null).map((item) => applyEntityDefaults(
      "pengeluaran",
      mergeExpensePayload({}, item && item.mutation_payload ? item.mutation_payload : item),
      this.timezone
    ));
    let batch = await executeMutationLoop(targets, async (target) => this.executeInsertExpenseTarget(context, target));
    batch = await this.postActionAudit(batch, async (target) => this.executeInsertExpenseTarget(context, target), {
      action: "create",
      entity: "pengeluaran"
    });
    if (!batch.results.length) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: batch.firstError || "Gagal input pengeluaran." };
    }
    const expectedTargets = Math.max(batch.results.length, Number(expectedTargetsOverride || batch.expectedTargets || batch.results.length));
    this.conversation.completeWithReceipt(session, {
      action: "create",
      entity: "pengeluaran",
      payload: cloneJson(batch.primaryPayload || {}),
      targets: batch.results.map((item) => buildActionTarget(item)),
      anchors: batch.anchors,
      failures: batch.failures,
      expectedTargets: expectedTargets,
      executedTargets: batch.results.length
    });
    return { handled: true, reply: buildMutationReply("create", "pengeluaran", Object.assign({}, batch, {
      expectedTargets: expectedTargets
    }), {
      single: "Pengeluaran berhasil dicatat:",
      multi: "Pengeluaran berhasil dicatat:"
    }) };
  }

  async finalizeConfirmSale(context, session, row, price, expectedTargetsOverride) {
    this.conversation.enterExecute(session);
    const preparedTargets = Array.isArray(row)
      ? row.map((item) => ({
        row: item && item.row ? item.row : null,
        price: parseFlexibleNumber(item && item.price)
      }))
      : normalizeTargets({
        no: normalizeNo(row && row.no),
        nama_motor: normalizeText(row && row.nama_motor),
        plat: normalizeText(row && row.plat),
        harga_laku: price
      }, null).map((item) => ({
        row: row,
        price: parseFlexibleNumber(item && item.mutation_payload ? item.mutation_payload.harga_laku : item.harga_laku || price)
      }));
    const targets = preparedTargets.filter((item) => item && item.row && parseFlexibleNumber(item.price) > 0);
    let batch = await executeMutationLoop(targets, async (target) => this.executeConfirmSaleTarget(context, target.row, target.price));
    batch = await this.postActionAudit(batch, async (target) => this.executeConfirmSaleTarget(context, target.row, target.price), {
      action: "confirm",
      entity: "sales"
    });
    if (!batch.results.length) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: batch.firstError || "Gagal konfirmasi penjualan." };
    }
    const expectedTargets = Math.max(batch.results.length, Number(expectedTargetsOverride || batch.expectedTargets || batch.results.length));
    this.conversation.completeWithReceipt(session, {
      action: "confirm",
      entity: "sales",
      payload: cloneJson(batch.primaryPayload || {}),
      targets: batch.results.map((item) => buildActionTarget(item)),
      anchors: batch.anchors,
      failures: batch.failures,
      expectedTargets: expectedTargets,
      executedTargets: batch.results.length
    });
    return { handled: true, reply: buildMutationReply("confirm", "sales", Object.assign({}, batch, {
      expectedTargets: expectedTargets
    }), {
      single: "Konfirmasi motor terjual berhasil disimpan.",
      multi: "Konfirmasi motor terjual berhasil disimpan:"
    }) };
  }

  async finalizeEditMotor(context, session, row, patch, expectedTargetsOverride) {
    this.conversation.enterExecute(session);
    const preparedTargets = Array.isArray(row)
      ? row.map((item) => ({
        row: item && item.row ? item.row : null,
        patch: item && item.patch && typeof item.patch === "object" ? cloneJson(item.patch) : {}
      }))
      : normalizeTargets(Object.assign({ no: normalizeNo(row && row.no) }, patch), null).map((item) => ({
        row: row,
        patch: Object.assign({}, patch, item && item.mutation_payload ? item.mutation_payload : {})
      }));
    const targets = preparedTargets.filter((item) => item && item.row && item.patch && Object.keys(item.patch).length > 0);
    let batch = await executeMutationLoop(targets, async (target) => this.executeUpdateMotorTarget(context, target.row, target.patch));
    batch = await this.postActionAudit(batch, async (target) => this.executeUpdateMotorTarget(context, target.row, target.patch), {
      action: "update",
      entity: "motor"
    });
    if (!batch.results.length) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: batch.firstError || "Gagal mengubah data motor." };
    }
    const expectedTargets = Math.max(batch.results.length, Number(expectedTargetsOverride || batch.expectedTargets || batch.results.length));
    this.conversation.completeWithReceipt(session, {
      action: "update",
      entity: "motor",
      payload: cloneJson(batch.primaryPayload || {}),
      targets: batch.results.map((item) => buildActionTarget(item)),
      anchors: batch.anchors,
      failures: batch.failures,
      expectedTargets: expectedTargets,
      executedTargets: batch.results.length
    });
    return { handled: true, reply: buildMutationReply("update", "motor", Object.assign({}, batch, {
      expectedTargets: expectedTargets
    }), {
      single: "Data motor berhasil diperbarui.",
      multi: "Data motor berhasil diperbarui:"
    }) };
  }

  async finalizeDeleteMotor(context, session, row, expectedTargetsOverride) {
    this.conversation.enterExecute(session);
    const preparedTargets = Array.isArray(row)
      ? row.map((item) => ({
        row: item && item.row ? item.row : null,
        no: normalizeNo(item && item.no || (item && item.row && item.row.no))
      }))
      : normalizeTargets({ no: normalizeNo(row && row.no) }, null).map((item) => ({
        row: row,
        no: normalizeNo(item && item.mutation_payload ? item.mutation_payload.no : item.no || row.no)
      }));
    const targets = preparedTargets.filter((item) => item && item.row && item.no);
    let batch = await executeMutationLoop(targets, async (target) => this.executeDeleteMotorTarget(context, target.row, target.no));
    batch = await this.postActionAudit(batch, async (target) => this.executeDeleteMotorTarget(context, target.row, target.no), {
      action: "delete",
      entity: "motor"
    });
    if (!batch.results.length) {
      this.conversation.complete(session);
      this.conversation.rememberFailure(session);
      return { handled: true, reply: batch.firstError || "Gagal menghapus data motor." };
    }
    const expectedTargets = Math.max(batch.results.length, Number(expectedTargetsOverride || batch.expectedTargets || batch.results.length));
    this.conversation.completeWithReceipt(session, {
      action: "delete",
      entity: "motor",
      payload: cloneJson(batch.primaryPayload || {}),
      targets: batch.results.map((item) => buildActionTarget(item)),
      anchors: batch.anchors,
      failures: batch.failures,
      expectedTargets: expectedTargets,
      executedTargets: batch.results.length
    });
    return { handled: true, reply: buildMutationReply("delete", "motor", Object.assign({}, batch, {
      expectedTargets: expectedTargets
    }), {
      single: "Data motor berhasil dibersihkan.",
      multi: "Data motor berhasil dibersihkan:"
    }) };
  }

  async handleMultiConfirmSale(parsed, context, session, rawTargets) {
    const targets = normalizeTargets(parsed.mutation_payload, rawTargets);
    const prepared = [];
    const issues = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const targetParsed = buildTargetSemanticPayload(parsed, target);
      const filters = deriveMotorSelectionFilters(targetParsed, target);
      const candidates = await this.resolveMotorCandidates(filters, { sold: false });
      if (candidates.systemError) return candidates;
      if (candidates.needsSelector) {
        issues.push(describeTargetIssue("motor", i, target, "Motor yang mau dikonfirmasi terjual belum jelas."));
        continue;
      }
      if (!candidates.rows.length) {
        issues.push(describeTargetIssue("motor", i, target, EMPTY_RESULT_MESSAGE));
        continue;
      }
      if (candidates.rows.length > 1) {
        issues.push(describeTargetIssue("motor", i, target, "Terdapat beberapa motor yang cocok. Sebutkan nomor motor yang dimaksud."));
        continue;
      }

      const price = extractSalePrice(targetParsed);
      if (price <= 0) {
        issues.push(describeTargetIssue("motor", i, target, "Harga laku belum diisi."));
        continue;
      }

      prepared.push({
        row: candidates.rows[0],
        price: price
      });
    }

    if (!prepared.length) {
      return { handled: true, reply: issues[0] || "Gagal konfirmasi penjualan." };
    }

    const response = await this.finalizeConfirmSale(context, session, prepared, null, targets.length);
    response.reply = appendBatchIssues(response.reply, issues, targets.length, prepared.length);
    return response;
  }

  async handleMultiEditMotor(parsed, context, session, rawTargets) {
    const targets = normalizeTargets(parsed.mutation_payload, rawTargets);
    const prepared = [];
    const issues = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const targetParsed = buildTargetSemanticPayload(parsed, target);
      const patch = buildEditPatch(targetParsed);
      if (patch.error) {
        issues.push(describeTargetIssue("motor", i, target, patch.error));
        continue;
      }
      if (!patch.hasPatch) {
        issues.push(describeTargetIssue("motor", i, target, "Data yang ingin diubah belum jelas."));
        continue;
      }

      const filters = deriveMotorSelectionFilters(targetParsed, target);
      const candidates = await this.resolveMotorCandidates(filters, { includeSold: true });
      if (candidates.systemError) return candidates;
      if (candidates.needsSelector) {
        issues.push(describeTargetIssue("motor", i, target, "Motor yang ingin diedit belum jelas."));
        continue;
      }
      if (!candidates.rows.length) {
        issues.push(describeTargetIssue("motor", i, target, EMPTY_RESULT_MESSAGE));
        continue;
      }
      if (candidates.rows.length > 1) {
        issues.push(describeTargetIssue("motor", i, target, "Terdapat beberapa motor yang cocok. Sebutkan nomor motor yang dimaksud."));
        continue;
      }

      prepared.push({
        row: candidates.rows[0],
        patch: patch.patch
      });
    }

    if (!prepared.length) {
      return { handled: true, reply: issues[0] || "Gagal mengubah data motor." };
    }

    const response = await this.finalizeEditMotor(context, session, prepared, null, targets.length);
    response.reply = appendBatchIssues(response.reply, issues, targets.length, prepared.length);
    return response;
  }

  async handleMultiDeleteMotor(parsed, context, session, rawTargets) {
    const targets = normalizeTargets(parsed.mutation_payload, rawTargets);
    const prepared = [];
    const issues = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const targetParsed = buildTargetSemanticPayload(parsed, target);
      const filters = deriveMotorSelectionFilters(targetParsed, target);
      const candidates = await this.resolveMotorCandidates(filters, { includeSold: true });
      if (candidates.systemError) return candidates;
      if (candidates.needsSelector) {
        issues.push(describeTargetIssue("motor", i, target, "Motor yang ingin dihapus belum jelas."));
        continue;
      }
      if (!candidates.rows.length) {
        issues.push(describeTargetIssue("motor", i, target, EMPTY_RESULT_MESSAGE));
        continue;
      }
      if (candidates.rows.length > 1) {
        issues.push(describeTargetIssue("motor", i, target, "Terdapat beberapa motor yang cocok. Sebutkan nomor motor yang dimaksud."));
        continue;
      }

      prepared.push({
        row: candidates.rows[0],
        no: normalizeNo(candidates.rows[0].no)
      });
    }

    if (!prepared.length) {
      return { handled: true, reply: issues[0] || "Gagal menghapus data motor." };
    }

    const response = await this.finalizeDeleteMotor(context, session, prepared, targets.length);
    response.reply = appendBatchIssues(response.reply, issues, targets.length, prepared.length);
    return response;
  }

  async executeInsertMotorTarget(context, payload) {
    const normalized = mergeMotorPayload({}, payload);
    const result = await this.toolExecutor.execute("insert_motor", normalized, context);
    if (!isSuccess(result)) {
      return {
        ok: false,
        error: normalizeToolError(result, "Gagal input data motor."),
        payload: normalized
      };
    }

    const no = normalizeNo(result && result.data && result.data.no || normalized.no);
    const label = normalizeText(result && result.data && result.data.nama_motor || normalized.nama_motor);
    return {
      ok: true,
      entity: "motor",
      no: no,
      row_id: no,
      label: label,
      payload: Object.assign({}, normalized, { no: no }),
      rawResult: result
    };
  }

  async executeInsertExpenseTarget(context, payload) {
    const normalized = applyEntityDefaults("pengeluaran", mergeExpensePayload({}, payload), this.timezone);
    const result = await this.toolExecutor.execute("insert_pengeluaran", normalized, context);
    if (!isSuccess(result)) {
      return {
        ok: false,
        error: normalizeToolError(result, "Gagal input pengeluaran."),
        payload: normalized
      };
    }

    const no = normalizeNo(result && result.data && result.data.no || normalized.no);
    const label = normalizeText(normalized.keterangan);
    return {
      ok: true,
      entity: "pengeluaran",
      no: no,
      row_id: no,
      label: label,
      payload: Object.assign({}, normalized, { no: no }),
      rawResult: result
    };
  }

  async executeConfirmSaleTarget(context, row, price) {
    const currentRow = row && typeof row === "object" ? row : {};
    const no = normalizeNo(currentRow.no);
    const amount = parseFlexibleNumber(price);
    const result = await this.toolExecutor.execute("confirm_sold", {
      no: no,
      nama_motor: normalizeText(currentRow.nama_motor),
      harga_laku: amount
    }, context);
    if (!isSuccess(result)) {
      return {
        ok: false,
        error: normalizeToolError(result, "Gagal konfirmasi penjualan."),
        payload: { no: no, nama_motor: normalizeText(currentRow.nama_motor), harga_laku: amount }
      };
    }

    return {
      ok: true,
      entity: "sales",
      no: no,
      row_id: no,
      label: normalizeText(currentRow.nama_motor),
      payload: {
        no: no,
        nama_motor: normalizeText(currentRow.nama_motor),
        plat: normalizeText(currentRow.plat),
        harga_laku: amount
      },
      rawResult: result
    };
  }

  async executeUpdateMotorTarget(context, row, patch) {
    const currentRow = row && typeof row === "object" ? row : {};
    const no = normalizeNo(currentRow.no);
    const body = Object.assign({ no: no }, patch || {});
    const result = await this.toolExecutor.execute("update_motor", body, context);
    if (!isSuccess(result)) {
      return {
        ok: false,
        error: normalizeToolError(result, "Gagal mengubah data motor."),
        payload: body
      };
    }

    return {
      ok: true,
      entity: "motor",
      no: no,
      row_id: no,
      label: normalizeText(currentRow.nama_motor),
      payload: Object.assign({
        no: no,
        nama_motor: normalizeText(currentRow.nama_motor),
        plat: normalizeText(currentRow.plat)
      }, patch || {}),
      rawResult: result
    };
  }

  async executeDeleteMotorTarget(context, row, no) {
    const currentRow = row && typeof row === "object" ? row : {};
    const targetNo = normalizeNo(no || currentRow.no);
    const result = await this.toolExecutor.execute("delete_motor", { no: targetNo }, context);
    if (!isSuccess(result)) {
      return {
        ok: false,
        error: normalizeToolError(result, "Gagal menghapus data motor."),
        payload: { no: targetNo }
      };
    }

    return {
      ok: true,
      entity: "motor",
      no: targetNo,
      row_id: targetNo,
      label: normalizeText(currentRow.nama_motor),
      payload: {
        no: targetNo,
        nama_motor: normalizeText(currentRow.nama_motor),
        plat: normalizeText(currentRow.plat)
      },
      rawResult: result
    };
  }

  resolveAmbiguousReference(parsed, plan, session) {
    const current = session && typeof session === "object" ? session : null;
    if (!current || !current.ambiguityFlag || !Array.isArray(current.candidateRows) || current.candidateRows.length <= 1) return "";
    if (normalizeReferenceMode(plan && plan.reference && plan.reference.mode) !== "last_query") return "";
    if (!Array.isArray(plan && plan.projection) || !plan.projection.length) return "";
    if (hasExplicitDisambiguatingSelector(parsed, current.lastQuery)) return "";
    return AMBIGUITY_MESSAGE;
  }

  resolveInvalidContextReference(parsed, session) {
    const current = session && typeof session === "object" ? session : null;
    if (!current || !current.invalidQueryContext) return "";
    const referenceMode = normalizeReferenceMode(parsed && (parsed.reference_mode || (parsed.reference && parsed.reference.mode)));
    if (referenceMode !== "last_query" && !isProjectionOnlySemanticQuery(parsed)) return "";
    return INVALID_CONTEXT_MESSAGE;
  }

  resolveDetachedProjection(parsed, plan, session) {
    const current = session && typeof session === "object" ? session : null;
    if (!current) return "";
    if (!isDetachedProjectionPlan(plan)) return "";
    if (normalizeReferenceMode(parsed && (parsed.reference_mode || (parsed.reference && parsed.reference.mode))) === "last_query") return "";
    if (current.ambiguityFlag && Array.isArray(current.candidateRows) && current.candidateRows.length > 1) {
      return AMBIGUITY_MESSAGE;
    }
    if (current.invalidQueryContext || current.lastQuery) {
      return INVALID_CONTEXT_MESSAGE;
    }
    return "Permintaan datanya belum cukup jelas. Sebutkan lagi motor yang dimaksud.";
  }

  resolveContextProjection(parsed, plan, session) {
    const current = session && typeof session === "object" ? session : null;
    if (!current || !Array.isArray(current.lastRows) || current.lastRows.length !== 1) return null;
    if (current.ambiguityFlag) return null;
    if (normalizeReferenceMode(plan && plan.reference && plan.reference.mode) !== "last_query") return null;
    if (!Array.isArray(plan && plan.projection) || !plan.projection.length) return null;
    if (!isProjectionOnlyReferencePlan(plan, current.lastQuery)) return null;
    const source = String(current.lastSource || "").trim() || String(selectDataSource(plan).source || "").trim();
    if (!source) return null;
    return {
      handled: true,
      reply: formatResponse(plan, source, { kind: "rows", value: current.lastRows.slice() }, current.lastRows.slice()),
      rows: current.lastRows.slice(),
      source: source
    };
  }

  resolveTargetReference(parsed, context, session, options) {
    return resolveTargetReference(parsed, context, session, options);
  }

  async handleSuccessfulActionCorrection(parsed, context, session) {
    const state = session && typeof session === "object" ? session : null;
    const successful = state && state.lastSuccessfulAction && typeof state.lastSuccessfulAction === "object"
      ? state.lastSuccessfulAction
      : null;
    if (!successful || Number(state.correctionWindowRemaining || 0) <= 0) return null;

    const receipt = extractActionReceipt(state);
    const resolvedTarget = this.resolveTargetReference(parsed, context, state, { receipt: receipt });
    if (resolvedTarget && resolvedTarget.ambiguous) {
      return {
        handled: true,
        reply: buildAnchorDisambiguationReply(receipt)
      };
    }
    if (resolvedTarget && resolvedTarget.invalid) {
      return {
        handled: true,
        reply: buildStructuredReply("AMBIGUITY REQUEST", "Koreksi terakhir harus merujuk pada item yang baru saya proses.")
      };
    }

    const action = normalizeAction(successful.action);
    const entity = canonicalEntity(successful.entity);
    const payload = successful.payload && typeof successful.payload === "object" ? successful.payload : {};

    if ((action === "create" || action === "update") && entity === "pengeluaran") {
      const anchor = resolvedTarget && resolvedTarget.anchor ? resolvedTarget.anchor : pickDefaultReceiptAnchor(receipt);
      const no = normalizeNo(anchor && anchor.no || payload.no);
      const revised = applyEntityDefaults("pengeluaran", mergeExpensePayload(payload, parsed.mutation_payload), this.timezone);
      if (!no) return null;
      this.conversation.enterExecute(state);
      const result = await this.toolExecutor.execute("update_pengeluaran", {
        no: no,
        tanggal: revised.tanggal || "",
        keterangan: revised.keterangan || "",
        total_pengeluaran: revised.total_pengeluaran === undefined ? revised.total : revised.total_pengeluaran
      }, context);
      if (!isSuccess(result)) {
        this.conversation.complete(state);
        this.conversation.rememberFailure(state);
        return { handled: true, reply: normalizeToolError(result, "Gagal memperbarui pengeluaran.") };
      }
      this.conversation.completeWithReceipt(state, {
        action: "update",
        entity: "pengeluaran",
        payload: Object.assign({}, revised, { no: no }),
        targets: [ buildActionTarget({
          no: no,
          row_id: no,
          label: normalizeText(anchor && anchor.label || revised.keterangan),
          payload: Object.assign({}, revised, { no: no })
        }) ],
        anchors: buildReceiptAnchorsFromTarget({
          no: no,
          row_id: no,
          label: normalizeText(anchor && anchor.label || revised.keterangan),
          payload: Object.assign({}, revised, { no: no })
        }),
        expectedTargets: 1,
        executedTargets: 1
      });
      return {
        handled: true,
        reply: buildStructuredReply("CORRECTION CONFIRMED", [
          "Pengeluaran berhasil diperbarui:",
          expenseSummaryLine(revised)
        ].join("\n"))
      };
    }

    if (action === "confirm" && entity === "sales") {
      const anchor = resolvedTarget && resolvedTarget.anchor ? resolvedTarget.anchor : pickDefaultReceiptAnchor(receipt);
      if (!anchor || !normalizeNo(anchor.no)) {
        return {
          handled: true,
          reply: buildAnchorDisambiguationReply(receipt)
        };
      }
      const no = normalizeNo(anchor.no);
      const revised = mergeMotorPayload(payload, parsed.mutation_payload);
      const price = parseFlexibleNumber(revised.harga_laku);
      if (!no || price <= 0) return null;
      this.conversation.enterExecute(state);
      const result = await this.toolExecutor.execute("confirm_sold", {
        no: no,
        nama_motor: normalizeText(anchor.label || revised.nama_motor),
        harga_laku: price
      }, context);
      if (!isSuccess(result)) {
        this.conversation.complete(state);
        this.conversation.rememberFailure(state);
        return { handled: true, reply: normalizeToolError(result, "Gagal memperbarui konfirmasi penjualan.") };
      }
      this.conversation.completeWithReceipt(state, {
        action: "confirm",
        entity: "sales",
        payload: Object.assign({}, payload, {
          harga_laku: price,
          no: no,
          nama_motor: normalizeText(anchor.label || revised.nama_motor)
        }),
        targets: [ buildActionTarget({
          no: no,
          row_id: no,
          label: normalizeText(anchor.label || revised.nama_motor),
          payload: Object.assign({}, payload, {
            harga_laku: price,
            no: no,
            nama_motor: normalizeText(anchor.label || revised.nama_motor)
          })
        }) ],
        anchors: buildReceiptAnchorsFromTarget({
          no: no,
          row_id: no,
          label: normalizeText(anchor.label || revised.nama_motor),
          payload: Object.assign({}, payload, {
            harga_laku: price,
            no: no,
            nama_motor: normalizeText(anchor.label || revised.nama_motor)
          })
        }),
        expectedTargets: 1,
        executedTargets: 1
      });
      return {
        handled: true,
        reply: buildStructuredReply("CORRECTION CONFIRMED", [
          "Konfirmasi motor terjual berhasil diperbarui.",
          "NO: " + no,
          "Nama Motor: " + normalizeText(revised.nama_motor),
          "Harga Laku: " + rupiah(price)
        ].join("\n"))
      };
    }

    if ((action === "create" || action === "update") && entity === "motor") {
      const anchor = resolvedTarget && resolvedTarget.anchor ? resolvedTarget.anchor : pickDefaultReceiptAnchor(receipt);
      if (!anchor || !normalizeNo(anchor.no)) {
        return {
          handled: true,
          reply: buildAnchorDisambiguationReply(receipt)
        };
      }
      const lockedRow = {
        no: normalizeNo(anchor.no),
        nama_motor: normalizeText(anchor.label || payload.nama_motor),
        plat: normalizeText(payload.plat)
      };
      const patch = buildEditPatch(parsed);
      if (patch.error) return { handled: true, reply: patch.error };
      if (!patch.hasPatch) {
        this.conversation.enterCollect(state, {
          action: "update",
          entity: "motor",
          stage: "patch",
          selectedRow: cloneJson(lockedRow),
          patch: {},
          anchorLocked: true,
          semanticPayload: cloneJson(parsed)
        });
        return {
          handled: true,
          reply: buildStructuredReply(
            "AMBIGUITY REQUEST",
            "Perubahan untuk " + normalizeText(lockedRow.nama_motor || ("NO " + lockedRow.no)) + " belum lengkap.\n" + buildEditPrompt(lockedRow)
          )
        };
      }

      this.conversation.enterExecute(state);
      const result = await this.toolExecutor.execute("update_motor", Object.assign({ no: lockedRow.no }, patch.patch), context);
      if (!isSuccess(result)) {
        this.conversation.complete(state);
        this.conversation.rememberFailure(state);
        return { handled: true, reply: normalizeToolError(result, "Gagal memperbarui data motor.") };
      }
      this.conversation.completeWithReceipt(state, {
        action: "update",
        entity: "motor",
        payload: Object.assign({}, patch.patch, {
          no: lockedRow.no,
          nama_motor: lockedRow.nama_motor,
          plat: lockedRow.plat
        }),
        targets: [ buildActionTarget({
          no: lockedRow.no,
          row_id: lockedRow.no,
          label: lockedRow.nama_motor,
          payload: Object.assign({}, patch.patch, {
            no: lockedRow.no,
            nama_motor: lockedRow.nama_motor,
            plat: lockedRow.plat
          })
        }) ],
        anchors: buildReceiptAnchorsFromTarget({
          no: lockedRow.no,
          row_id: lockedRow.no,
          label: lockedRow.nama_motor,
          payload: Object.assign({}, patch.patch, {
            no: lockedRow.no,
            nama_motor: lockedRow.nama_motor,
            plat: lockedRow.plat
          })
        }),
        expectedTargets: 1,
        executedTargets: 1
      });
      return {
        handled: true,
        reply: buildStructuredReply("CORRECTION CONFIRMED", [
          "Data motor berhasil diperbarui.",
          "NO: " + lockedRow.no,
          lockedRow.nama_motor ? "Nama Motor: " + lockedRow.nama_motor : ""
        ].filter(Boolean).join("\n"))
      };
    }

    return null;
  }

  async resolveMotorCandidates(filters, options) {
    const opts = options && typeof options === "object" ? options : {};
    const plan = buildQueryPlan({
      action: "query",
      entity: "motor",
      metric: "list",
      selector: buildSelectorFromFilters(filters || {}),
      projection: [],
      filters: filters || {},
      temporal: {}
    }, null, { mergePrevious: false });

    if (opts.sold === true) plan.filters.sold = true;
    if (opts.sold === false) plan.filters.sold = false;
    if (opts.includeSold === true) plan.filters.sold = "all";

    if (!hasMotorSelector(plan.filters)) {
      return { needsSelector: true, rows: [] };
    }

    const fetched = await this.fetchDataset("motor");
    if (!fetched.ok) {
      return {
        handled: true,
        systemError: true,
        reply: SYSTEM_FETCH_ERROR,
        rows: [],
        source: "motor"
      };
    }

    return {
      rows: this.applyFilters(fetched.rows, plan, "motor"),
      source: "motor"
    };
  }

  async executeQueryPlan(plan, context) {
    const selection = selectDataSource(plan);
    if (selection.error) {
      return { handled: true, reply: selection.error, rows: [], source: "" };
    }

    const fetched = await this.fetchDataset(selection.source, context);
    if (!fetched.ok) {
      return {
        handled: true,
        systemError: true,
        reply: SYSTEM_FETCH_ERROR,
        rows: [],
        source: selection.source
      };
    }

    const filtered = this.applyFilters(fetched.rows, plan, selection.source);
    if (!filtered.length) {
      return { handled: true, reply: EMPTY_RESULT_MESSAGE, rows: [], source: selection.source };
    }

    const metricResult = this.applyMetric(filtered, plan, selection.source);
    return {
      handled: true,
      reply: formatResponse(plan, selection.source, metricResult, filtered),
      rows: filtered,
      source: selection.source
    };
  }

  async fetchDataset(source, context) {
    const attempts = source === "reminder" ? 1 : 3;
    const timeoutMs = source === "reminder" ? 0 : 30000;
    let lastFailure = "Sumber data tidak dikenal.";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (source === "motor") {
          const result = await withTimeoutGuard(
            this.apps.getMotorData({ include_sold: true, status: "all", limit: 500 }),
            timeoutMs,
            "motor_read_timeout"
          );
          if (isSuccess(result) && Array.isArray(result.data)) {
            return { ok: true, rows: result.data.map(normalizeMotorRow).filter(Boolean) };
          }
          lastFailure = extractMessage(result) || "Data motor tidak valid.";
        } else if (source === "expense") {
          const result = await withTimeoutGuard(
            this.apps.getPengeluaran({ limit: 500 }),
            timeoutMs,
            "expense_read_timeout"
          );
          if (isSuccess(result) && Array.isArray(result.data)) {
            return { ok: true, rows: result.data.map((row, index) => normalizeExpenseRow(row, index)).filter(Boolean) };
          }
          lastFailure = extractMessage(result) || "Data pengeluaran tidak valid.";
        } else if (source === "total_aset") {
          const result = await withTimeoutGuard(
            this.apps.getTotalAsetData({}),
            timeoutMs,
            "total_aset_read_timeout"
          );
          if (isSuccess(result) && Array.isArray(result.data)) {
            return { ok: true, rows: normalizeTotalAsetRows(result.data) };
          }
          lastFailure = extractMessage(result) || "Data ringkasan global tidak valid.";
        } else if (source === "reminder") {
          const result = await this.reminders.listReminders({
            phone: String(context && context.userPhone || "").trim()
          });
          if (isSuccess(result) && Array.isArray(result.data)) {
            return { ok: true, rows: result.data.map(normalizeReminderRow).filter(Boolean) };
          }
          lastFailure = extractMessage(result) || "Data reminder tidak valid.";
        } else {
          return { ok: false, message: lastFailure };
        }
      } catch (err) {
        lastFailure = String(err && err.message ? err.message : err);
        error("fetch_dataset_failed", {
          source: source,
          attempt: attempt,
          message: lastFailure
        });
      }
      if (attempt < attempts) {
        await sleep(250 * attempt);
      }
    }
    return { ok: false, message: lastFailure };
  }

  applyFilters(rows, plan, source) {
    let result = Array.isArray(rows) ? rows.slice() : [];
    const filters = plan && plan.filters && typeof plan.filters === "object" ? plan.filters : {};
    const selector = plan && plan.selector && typeof plan.selector === "object" ? plan.selector : emptySelector();
    const defs = fieldDefinitions(source);

    const exactNo = normalizeNo(
      selector.attributes && selector.attributes.no
      || (Array.isArray(selector.ids) && selector.ids[0])
      || filters.no
      || filters.nomor_motor
    );
    if (source === "motor" && exactNo) {
      result = result.filter((row) => normalizeNo(row && row.no) === exactNo);
    }

    if (source === "motor" && !exactNo) {
      const selectorNames = Array.isArray(selector.names) ? selector.names.filter(Boolean) : [];
      const selectorName = normalizeText(selector.attributes && selector.attributes.nama_motor);
      const names = selectorNames.concat(selectorName ? [selectorName] : []).filter(Boolean);
      if (names.length) {
        result = result.filter((row) => names.some((expected) => valueMatches(row, defs.nama_motor, expected, "nama_motor")));
      }

      const selectorPlat = normalizeText(selector.attributes && selector.attributes.plat);
      if (selectorPlat) {
        result = result.filter((row) => valueMatches(row, defs.plat, selectorPlat, "plat"));
      }
    }

    Object.keys(filters).forEach((rawKey) => {
      const value = filters[rawKey];
      if (isEmptyFilterValue(value)) return;
      if (source === "motor" && (rawKey === "no" || rawKey === "nomor_motor")) return;
      const field = resolveFieldKey(source, rawKey);
      if (!field || !defs[field]) return;
      result = result.filter((row) => valueMatches(row, defs[field], value, field));
    });

    const range = normalizeDateRange(plan && plan.temporal);
    if (hasDateRange(range)) {
      const rangeField = resolveDateField(source, plan);
      if (!rangeField || !defs[rangeField]) return [];
      const built = buildDateRange(range, this.timezone);
      result = result.filter((row) => inDateRange(defs[rangeField].get(row), built));
    }

    if (source === "motor" || source === "expense") {
      return dedupeByOfficialNumber(result);
    }
    return result;
  }

  applyMetric(rows, plan, source) {
    const metric = canonicalMetric(plan.metric) || "list";
    const list = Array.isArray(rows) ? rows : [];

    if (metric === "list") return { kind: "rows", value: list };
    if (metric === "count") return { kind: "scalar", value: list.length };

    if (metric === "profit") {
      const total = list.reduce((sum, row) => sum + (parseFlexibleNumber(row.harga_laku) - parseFlexibleNumber(row.harga_beli)), 0);
      return { kind: "scalar", value: Math.round(total) };
    }

    if (metric === "revenue") {
      const total = list.reduce((sum, row) => sum + parseFlexibleNumber(row.harga_laku), 0);
      return { kind: "scalar", value: Math.round(total) };
    }

    if (metric === "sum") {
      const field = resolveMetricField(plan, source);
      const total = list.reduce((sum, row) => sum + parseFlexibleNumber(readFieldValue(source, field, row)), 0);
      return { kind: "scalar", value: Math.round(total), field: field };
    }

    return { kind: "rows", value: list };
  }
}

function normalizeParsed(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const normalized = {
    action: normalizeAction(src.action),
    entity: canonicalEntity(src.entity),
    metric: canonicalMetric(src.metric),
    availability_state: normalizeAvailabilityState(src.availability_state),
    confidence: normalizeConfidence(src.confidence),
    correction_type: normalizeCorrectionType(src.correction_type),
    target_field: normalizeText(src.target_field),
    new_value: normalizeNewValue(src.new_value),
    selector: normalizeSelector(src.selector),
    filters: normalizeFilters(src.filters, src.entity),
    projection: normalizeFieldList(src.projection, src.entity),
    mutation_payload: normalizeMutationData(src.mutation_payload, src.entity),
    temporal: normalizeDateRange(src.temporal),
    reference: normalizeReference(src.reference),
    user_context: normalizeText(src.user_context),
    value: src.value === undefined || src.value === null ? "" : src.value,
    count: toCount(src.count),
    targets: normalizeActionTargets(src.targets, src.entity)
  };
  normalized.mutation_payload = repairMutationDataByEntity(normalized);
  normalized.fields = normalized.projection.slice();
  normalized.data = cloneJson(normalized.mutation_payload);
  normalized.reference_mode = normalizeReferenceMode(normalized.reference.mode);
  normalized.reminder_time = normalizeText(normalized.mutation_payload.due_at);
  normalized.reminder_text = normalizeText(normalized.mutation_payload.text);
  normalized.reminder_recurrence = normalizeText(normalized.mutation_payload.recurrence);
  return normalized;
}

function normalizeConfidence(value) {
  if (typeof value === "number" && isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

function normalizeCorrectionType(value) {
  const raw = normalizeText(value).toLowerCase();
  return [
    "",
    "selector_refinement",
    "selector_replacement",
    "payload_adjustment",
    "full_query_reset"
  ].indexOf(raw) !== -1 ? raw : "";
}

function normalizeNewValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && isFinite(value)) return value;
  const numeric = parseFlexibleNumber(value);
  return numeric > 0 ? numeric : normalizeText(value);
}

function normalizeAction(value) {
  const raw = normalizeText(value).toLowerCase();
  return [ "query", "create", "update", "delete", "confirm", "reminder", "chat", "correction" ].indexOf(raw) !== -1 ? raw : "chat";
}

function normalizeReferenceMode(value) {
  const raw = normalizeText(value).toLowerCase();
  return [ "", "new_request", "pending_action", "last_query" ].indexOf(raw) !== -1 ? raw : "";
}

function canonicalEntity(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "general";
  return SUPPORTED_ENTITIES.indexOf(raw) !== -1
    ? raw
    : "general";
}

function canonicalMetric(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";
  return SUPPORTED_METRICS.indexOf(raw) !== -1 ? raw : "";
}

function normalizeReference(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    mode: normalizeReferenceMode(src.mode),
    target: normalizeText(src.target)
  };
}

function emptySelector() {
  return {
    ids: [],
    names: [],
    attributes: {
      no: "",
      nama_motor: "",
      plat: ""
    }
  };
}

function normalizeSelector(value) {
  const src = value && typeof value === "object" ? value : {};
  const attrs = src.attributes && typeof src.attributes === "object" ? src.attributes : {};
  const ids = Array.isArray(src.ids) ? src.ids : [];
  const names = Array.isArray(src.names) ? src.names : [];
  return {
    ids: ids.map((item) => normalizeNo(item)).filter(Boolean).filter(uniqueOnly),
    names: names.map((item) => normalizeText(item)).filter(Boolean).filter(uniqueOnly),
    attributes: {
      no: normalizeNo(attrs.no),
      nama_motor: normalizeText(attrs.nama_motor),
      plat: normalizeText(attrs.plat)
    }
  };
}

function uniqueOnly(value, index, array) {
  return array.indexOf(value) === index;
}

function normalizeMutationData(value, entity) {
  const normalized = canonicalEntity(entity);
  if (normalized === "pengeluaran") return normalizeExpensePayload(value);
  if (normalized === "reminder") return normalizeReminderPayload(value);
  return normalizeMotorPayload(value);
}

function normalizeActionTargets(value, entity) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => normalizeActionTarget(item, entity))
    .filter(Boolean);
}

function normalizeActionTarget(value, entity) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  const effectiveEntity = inferTargetEntity(src, entity);
  const structured = hasStructuredTargetFields(src);
  const projectionSource = Array.isArray(src.projection) ? src.projection : src.fields;
  const mutationSource = structured
    ? (src.mutation_payload !== undefined ? src.mutation_payload : (src.payload !== undefined ? src.payload : {}))
    : src;
  const normalized = {
    selector: structured ? normalizeSelector(src.selector) : emptySelector(),
    filters: structured ? normalizeFilters(src.filters, effectiveEntity) : {},
    projection: structured ? normalizeFieldList(projectionSource, effectiveEntity) : [],
    mutation_payload: normalizeMutationData(mutationSource, effectiveEntity),
    temporal: structured ? normalizeDateRange(src.temporal) : normalizeDateRange({}),
    value: structured && src.value !== undefined && src.value !== null ? src.value : "",
    count: structured ? toCount(src.count) : 0
  };
  return hasTargetContent(normalized) ? normalized : null;
}

function inferTargetEntity(value, fallbackEntity) {
  const src = value && typeof value === "object" ? value : {};
  const explicit = canonicalEntity(src.entity || fallbackEntity);
  if (explicit !== "general") return explicit;
  const payload = src.mutation_payload && typeof src.mutation_payload === "object"
    ? src.mutation_payload
    : src;
  if (payload && typeof payload === "object") {
    if (!isUnset(payload.keterangan) || !isUnset(payload.total) || !isUnset(payload.total_pengeluaran) || !isUnset(payload.tanggal)) {
      return "pengeluaran";
    }
    if (!isUnset(payload.due_at) || !isUnset(payload.text) || !isUnset(payload.recurrence)) {
      return "reminder";
    }
  }
  return "motor";
}

function hasStructuredTargetFields(value) {
  const src = value && typeof value === "object" ? value : {};
  return Object.prototype.hasOwnProperty.call(src, "selector")
    || Object.prototype.hasOwnProperty.call(src, "filters")
    || Object.prototype.hasOwnProperty.call(src, "projection")
    || Object.prototype.hasOwnProperty.call(src, "fields")
    || Object.prototype.hasOwnProperty.call(src, "mutation_payload")
    || Object.prototype.hasOwnProperty.call(src, "payload")
    || Object.prototype.hasOwnProperty.call(src, "value")
    || Object.prototype.hasOwnProperty.call(src, "count")
    || Object.prototype.hasOwnProperty.call(src, "temporal");
}

function hasTargetContent(target) {
  const src = target && typeof target === "object" ? target : {};
  return hasSelectorContent(src.selector)
    || hasObjectEntries(src.filters)
    || (Array.isArray(src.projection) && src.projection.length > 0)
    || hasNonEmptyMutationPayload(src.mutation_payload)
    || !isEmptyValue(src.value)
    || Number(src.count || 0) > 0
    || hasDateRange(src.temporal);
}

function hasSelectorContent(selector) {
  const src = selector && typeof selector === "object" ? selector : emptySelector();
  return (Array.isArray(src.ids) && src.ids.length > 0)
    || (Array.isArray(src.names) && src.names.length > 0)
    || !isEmptyValue(src.attributes && src.attributes.no)
    || !isEmptyValue(src.attributes && src.attributes.nama_motor)
    || !isEmptyValue(src.attributes && src.attributes.plat);
}

function hasObjectEntries(value) {
  const src = value && typeof value === "object" ? value : {};
  return Object.keys(src).some((key) => !isEmptyFilterValue(src[key]));
}

function hasNonEmptyMutationPayload(value) {
  const src = value && typeof value === "object" ? value : {};
  return Object.keys(src).some((key) => !isEmptyValue(src[key]));
}

function normalizeTargets(payload, targets) {
  const directTargets = Array.isArray(targets) ? targets.filter((item) => item && typeof item === "object") : [];
  if (directTargets.length && directTargets.every(hasStructuredTargetFields)) {
    return directTargets
      .map((item) => cloneJson(item))
      .filter((item) => hasTargetContent(item));
  }

  const normalizedTargets = normalizeActionTargets(targets, inferTargetEntity(payload, ""));
  if (normalizedTargets.length) return normalizedTargets;

  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeActionTarget(item, inferTargetEntity(item, "")))
      .filter(Boolean);
  }

  if (payload && typeof payload === "object" && Object.keys(payload).length) {
    const wrapped = normalizeActionTarget(payload, inferTargetEntity(payload, ""));
    return wrapped ? [ wrapped ] : [];
  }

  return [];
}

function repairMutationDataByEntity(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const entity = canonicalEntity(payload.entity);
  if (entity === "pengeluaran") return repairExpensePayload(payload);
  if (entity === "reminder") return repairReminderPayload(payload);
  return payload.mutation_payload && typeof payload.mutation_payload === "object" ? payload.mutation_payload : {};
}

function repairExpensePayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const src = normalizeExpensePayload(payload.mutation_payload);
  const repaired = Object.assign({}, src);

  if (isEmptyValue(repaired.keterangan)) {
    const textCandidates = [
      payload.mutation_payload && payload.mutation_payload.nama_motor,
      payload.mutation_payload && payload.mutation_payload.plat,
      payload.mutation_payload && payload.mutation_payload.surat_surat,
      payload.value
    ];
    for (let i = 0; i < textCandidates.length; i++) {
      const text = normalizeText(textCandidates[i]);
      if (text) {
        repaired.keterangan = text;
        break;
      }
    }
  }

  if (isEmptyValue(repaired.total_pengeluaran) && isEmptyValue(repaired.total)) {
    const numericCandidates = [
      payload.mutation_payload && payload.mutation_payload.total_pengeluaran,
      payload.mutation_payload && payload.mutation_payload.total,
      payload.mutation_payload && payload.mutation_payload.harga_laku,
      payload.mutation_payload && payload.mutation_payload.harga_jual,
      payload.mutation_payload && payload.mutation_payload.harga_beli,
      payload.mutation_payload && payload.mutation_payload.pajak,
      payload.mutation_payload && payload.mutation_payload.tahun_plat,
      payload.mutation_payload && payload.mutation_payload.tahun,
      payload.count
    ]
      .map((item) => parseFlexibleNumber(item))
      .filter((item) => item > 0);

    if (numericCandidates.length) {
      repaired.total_pengeluaran = numericCandidates[0];
      repaired.total = numericCandidates[0];
    }
  }

  return repaired;
}

function rewriteCorrectionSemanticPayload(parsed, session) {
  const correction = normalizeParsed(parsed);
  const correctionType = resolveCorrectionType(correction, session);

  if (correctionType === "full_query_reset") {
    const resetPayload = buildResetSemanticPayload(correction);
    return {
      payload: hasStandaloneSemanticShape(resetPayload) ? resetPayload : null,
      resetOnly: !hasStandaloneSemanticShape(resetPayload)
    };
  }

  const base = resolveCorrectionBaseSemanticPayload(correction, session);
  if (!base) return { payload: null, resetOnly: false };

  let rewritten = createSemanticDraft(base, correction);
  rewritten.action = normalizeAction(base.action || rewritten.action);
  rewritten.entity = canonicalEntity(base.entity || rewritten.entity);
  rewritten.metric = canonicalMetric(base.metric || rewritten.metric);
  rewritten.correction_type = correctionType;
  rewritten.target_field = correction.target_field;
  rewritten.new_value = correction.new_value;
  rewritten.reference = normalizeCorrectionReference(correction.reference, session);

  if (correctionType === "selector_replacement") {
    rewritten.selector = replaceSelector(rewritten.selector, correction);
    rewritten.filters = mergeFilters(
      stripSelectorFilters(rewritten.filters),
      stripSelectorFilters(correction.filters),
      rewritten.entity
    );
    rewritten.mutation_payload = stripSelectorMutationFields(rewritten.entity, rewritten.mutation_payload);
  } else if (correctionType === "payload_adjustment") {
    rewritten.mutation_payload = mergeEntityMutationPayload(
      rewritten.entity,
      rewritten.mutation_payload,
      correction.mutation_payload
    );
  } else {
    rewritten.selector = mergeSelector(rewritten.selector, correction.selector, "last_query");
    rewritten.filters = mergeFilters(rewritten.filters, correction.filters, rewritten.entity);
  }

  rewritten = applyTargetFieldCorrection(rewritten, correction);

  if (Array.isArray(correction.projection) && correction.projection.length) {
    rewritten.projection = correction.projection.slice();
  }
  if (hasDateRange(correction.temporal)) {
    rewritten.temporal = mergeTemporal(rewritten.temporal, correction.temporal, "last_query");
  }
  if (canonicalMetric(correction.metric)) {
    rewritten.metric = canonicalMetric(correction.metric);
  }
  if (canonicalEntity(correction.entity) && canonicalEntity(correction.entity) !== "general") {
    rewritten.entity = canonicalEntity(correction.entity) || rewritten.entity;
  }

  return {
    payload: normalizeParsed(rewritten),
    resetOnly: false
  };
}

function resolveCorrectionType(parsed, session) {
  const explicit = normalizeCorrectionType(parsed && parsed.correction_type);
  if (explicit) return explicit;

  const current = parsed && typeof parsed === "object" ? parsed : {};
  const base = resolveCorrectionBaseSemanticPayload(current, session);
  if (!hasStandaloneSemanticShape(current)) return "full_query_reset";

  const currentSelector = normalizeSelector(current.selector);
  const baseSelector = normalizeSelector(base && base.selector);
  if (hasSelector(currentSelector) && hasSelector(baseSelector) && !sameSelector(currentSelector, baseSelector)) {
    return "selector_replacement";
  }
  if (!isEmptyValue(current.target_field) && [ "no", "nomor_motor", "nama_motor", "plat" ].indexOf(normalizeText(current.target_field).toLowerCase()) !== -1) {
    return "selector_replacement";
  }
  if (hasAnyMutationPayload(current.mutation_payload)) return "payload_adjustment";

  if (hasSelector(currentSelector) || hasNonEmptyQueryFilters(current.filters) || hasDateRange(current.temporal) || (Array.isArray(current.projection) && current.projection.length)) {
    return "selector_refinement";
  }

  return "full_query_reset";
}

function resolveCorrectionBaseSemanticPayload(parsed, session) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const state = session && typeof session === "object" ? session : {};
  const mode = normalizeReferenceMode(current.reference_mode);

  if (mode === "pending_action") {
    const pendingBase = extractPendingSemanticPayload(state.pendingAction);
    if (pendingBase) return pendingBase;
  }
  if (mode === "last_query") {
    const lastSemantic = normalizeStoredSemanticPayload(state.lastSemanticPayload);
    if (lastSemantic) return lastSemantic;
    return semanticPayloadFromPlan(state.lastQuery);
  }

  const lastSuccessful = extractSuccessfulSemanticPayload(state.lastSuccessfulAction, state.correctionWindowRemaining);
  if (lastSuccessful && (current.correction_type === "payload_adjustment" || hasAnyMutationPayload(current.mutation_payload) || normalizeAction(current.action) === "correction")) {
    return lastSuccessful;
  }

  const pendingBase = extractPendingSemanticPayload(state.pendingAction);
  if (pendingBase && (current.correction_type === "payload_adjustment" || hasAnyMutationPayload(current.mutation_payload))) {
    return pendingBase;
  }

  const lastSemantic = normalizeStoredSemanticPayload(state.lastSemanticPayload);
  if (lastSemantic) return lastSemantic;
  return semanticPayloadFromPlan(state.lastQuery);
}

function extractSuccessfulSemanticPayload(successfulAction, correctionWindowRemaining) {
  if (!successfulAction || typeof successfulAction !== "object") return null;
  if (Number(correctionWindowRemaining || 0) <= 0) return null;
  return buildSemanticPayloadFromSuccessfulAction(successfulAction);
}

function extractPendingSemanticPayload(pendingAction) {
  const pending = pendingAction && typeof pendingAction === "object" ? pendingAction : null;
  if (!pending) return null;
  if (pending.semanticPayload && typeof pending.semanticPayload === "object") {
    return normalizeStoredSemanticPayload(pending.semanticPayload);
  }
  return buildSemanticPayloadFromPending(pending);
}

function normalizeStoredSemanticPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const normalized = normalizeParsed(payload);
  return createSemanticDraft(normalized);
}

function semanticPayloadFromPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  return normalizeParsed({
    action: "query",
    entity: plan.entity,
    metric: plan.metric,
    selector: plan.selector,
    filters: plan.filters,
    projection: plan.projection,
    mutation_payload: {},
    temporal: plan.temporal,
    reference: plan.reference,
    confidence: 1
  });
}

function buildResetSemanticPayload(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const candidate = createSemanticDraft(current);
  const hasFreshSemantic = hasFreshSemanticContribution(current);
  candidate.action = hasFreshSemantic ? inferSemanticAction(candidate) : "chat";
  candidate.entity = hasFreshSemantic ? canonicalEntity(candidate.entity) : "general";
  candidate.correction_type = "";
  candidate.target_field = "";
  candidate.new_value = "";
  candidate.reference = { mode: "", target: "" };
  candidate.user_context = "";
  if (!hasFreshSemantic) {
    candidate.selector = emptySelector();
    candidate.filters = {};
    candidate.projection = [];
    candidate.mutation_payload = {};
    candidate.temporal = normalizeDateRange(null);
    candidate.metric = "";
    candidate.value = "";
    candidate.count = 0;
  }
  return candidate;
}

function hasStandaloneSemanticShape(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  return Boolean(
    hasSelector(current.selector)
    || hasNonEmptyQueryFilters(current.filters)
    || hasAnyMutationPayload(current.mutation_payload)
    || hasDateRange(current.temporal)
    || (Array.isArray(current.projection) && current.projection.length)
    || canonicalMetric(current.metric)
    || (canonicalEntity(current.entity) && canonicalEntity(current.entity) !== "general" && hasFreshSemanticContribution(current))
  );
}

function hasFreshSemanticContribution(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  return Boolean(
    hasSelector(current.selector)
    || hasNonEmptyQueryFilters(current.filters)
    || hasAnyMutationPayload(current.mutation_payload)
    || hasDateRange(current.temporal)
    || (Array.isArray(current.projection) && current.projection.length)
    || canonicalMetric(current.metric)
    || !isEmptyValue(current.value)
    || Number(current.count || 0) > 0
  );
}

function inferSemanticAction(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (hasAnyMutationPayload(current.mutation_payload)) {
    if (canonicalEntity(current.entity) === "sales") return "confirm";
    if (canonicalEntity(current.entity) === "pengeluaran") return "create";
    if (canonicalEntity(current.entity) === "reminder") return "reminder";
    return "create";
  }
  return "query";
}

function createSemanticDraft(base, override) {
  const source = base && typeof base === "object" ? base : {};
  const next = override && typeof override === "object" ? override : {};
  return {
    action: normalizeAction(next.action || source.action || "query"),
    entity: canonicalEntity(next.entity || source.entity || "general"),
    metric: canonicalMetric(next.metric || source.metric),
    confidence: normalizeConfidence(next.confidence !== null && next.confidence !== undefined ? next.confidence : source.confidence),
    correction_type: normalizeCorrectionType(next.correction_type || source.correction_type),
    target_field: normalizeText(next.target_field || source.target_field),
    new_value: next.new_value !== undefined ? normalizeNewValue(next.new_value) : normalizeNewValue(source.new_value),
    selector: normalizeSelector(next.selector || source.selector),
    filters: normalizeFilters(next.filters || source.filters, next.entity || source.entity),
    projection: normalizeFieldList(next.projection || source.projection, next.entity || source.entity),
    mutation_payload: normalizeMutationData(next.mutation_payload || source.mutation_payload, next.entity || source.entity),
    temporal: normalizeDateRange(next.temporal || source.temporal),
    reference: normalizeReference(next.reference || source.reference),
    user_context: normalizeText(next.user_context || source.user_context),
    value: next.value === undefined ? (source.value === undefined ? "" : source.value) : next.value,
    count: next.count === undefined ? toCount(source.count) : toCount(next.count)
  };
}

function normalizeCorrectionReference(reference, session) {
  const current = normalizeReference(reference);
  if (current.mode) return current;
  if (session && session.pendingAction) return { mode: "pending_action", target: "pending_action" };
  return { mode: "last_query", target: "previous_query" };
}

function replaceSelector(baseSelector, parsed) {
  const current = normalizeSelector(baseSelector);
  const replacement = normalizeSelector(parsed && parsed.selector);
  if (hasSelector(replacement)) {
    const next = emptySelector();
    replacement.ids.forEach((item) => {
      const normalized = normalizeNo(item);
      if (normalized && current.ids.indexOf(normalized) === -1 && next.ids.indexOf(normalized) === -1) next.ids.push(normalized);
    });
    replacement.names.forEach((item) => {
      const normalized = normalizeText(item);
      if (normalized && current.names.indexOf(normalized) === -1 && next.names.indexOf(normalized) === -1) next.names.push(normalized);
    });
    if (normalizeNo(replacement.attributes.no) && normalizeNo(replacement.attributes.no) !== normalizeNo(current.attributes.no)) {
      next.attributes.no = normalizeNo(replacement.attributes.no);
    }
    if (normalizeText(replacement.attributes.nama_motor) && normalizeText(replacement.attributes.nama_motor) !== normalizeText(current.attributes.nama_motor)) {
      next.attributes.nama_motor = normalizeText(replacement.attributes.nama_motor);
    }
    if (normalizeText(replacement.attributes.plat) && normalizeText(replacement.attributes.plat) !== normalizeText(current.attributes.plat)) {
      next.attributes.plat = normalizeText(replacement.attributes.plat);
    }
    if (hasSelector(next)) return next;
  }

  const mutation = parsed && parsed.mutation_payload && typeof parsed.mutation_payload === "object"
    ? parsed.mutation_payload
    : {};
  const nextFromMutation = emptySelector();
  const mutationNo = normalizeNo(mutation.no);
  const mutationName = normalizeText(mutation.nama_motor);
  const mutationPlat = normalizeText(mutation.plat);
  if (mutationNo && mutationNo !== normalizeNo(current.attributes.no)) {
    nextFromMutation.ids = [mutationNo];
    nextFromMutation.attributes.no = mutationNo;
  }
  if (mutationName && mutationName !== normalizeText(current.attributes.nama_motor)) {
    nextFromMutation.names = [mutationName];
    nextFromMutation.attributes.nama_motor = mutationName;
  }
  if (mutationPlat && mutationPlat !== normalizeText(current.attributes.plat)) {
    nextFromMutation.attributes.plat = mutationPlat;
  }
  if (hasSelector(nextFromMutation)) return nextFromMutation;

  const targetField = normalizeText(parsed && parsed.target_field).toLowerCase();
  const newValue = parsed ? parsed.new_value : "";
  if (!targetField || isEmptyValue(newValue)) return current;

  const next = emptySelector();
  if (targetField === "no" || targetField === "nomor_motor") {
    const no = normalizeNo(newValue);
    next.ids = no ? [no] : [];
    next.attributes.no = no;
    return next;
  }
  if (targetField === "nama_motor") {
    const name = normalizeText(newValue);
    next.names = name ? [name] : [];
    next.attributes.nama_motor = name;
    return next;
  }
  if (targetField === "plat") {
    next.attributes.plat = normalizeText(newValue);
    return next;
  }
  return current;
}

function stripSelectorFilters(filters) {
  const current = filters && typeof filters === "object" ? Object.assign({}, filters) : {};
  delete current.no;
  delete current.nomor_motor;
  delete current.nama_motor;
  delete current.plat;
  return current;
}

function stripSelectorMutationFields(entity, payload) {
  const target = canonicalEntity(entity);
  if (target === "pengeluaran") return mergeExpensePayload({}, payload);
  if (target === "reminder") return mergeReminderPayload({}, payload);
  const current = mergeMotorPayload({}, payload);
  delete current.no;
  delete current.nama_motor;
  delete current.plat;
  return current;
}

function applyTargetFieldCorrection(payload, parsed) {
  const current = payload && typeof payload === "object" ? payload : createSemanticDraft(null);
  const correction = parsed && typeof parsed === "object" ? parsed : {};
  const targetField = normalizeText(correction.target_field);
  if (!targetField || isEmptyValue(correction.new_value)) return current;

  const source = selectSourceKeyForEntity(current.entity);
  const field = resolveFieldKey(source, targetField);
  if (!field) return current;

  if (current.correction_type === "payload_adjustment") {
    current.mutation_payload = assignMutationField(current.entity, current.mutation_payload, field, correction.new_value);
    return current;
  }

  if (field === "no") {
    const no = normalizeNo(correction.new_value);
    current.selector = normalizeSelector({
      ids: no ? [no] : [],
      names: [],
      attributes: { no: no, nama_motor: "", plat: "" }
    });
    return current;
  }

  if (field === "nama_motor") {
    const name = normalizeText(correction.new_value);
    current.selector = normalizeSelector({
      ids: [],
      names: name ? [name] : [],
      attributes: { no: "", nama_motor: name, plat: "" }
    });
    return current;
  }

  if (field === "plat") {
    current.selector = mergeSelector(current.selector, {
      ids: [],
      names: [],
      attributes: { no: "", nama_motor: "", plat: normalizeText(correction.new_value) }
    }, "last_query");
    return current;
  }

  current.filters = Object.assign({}, current.filters, {
    [field]: normalizeFilterValue(correction.new_value)
  });
  return current;
}

function assignMutationField(entity, payload, field, value) {
  const target = canonicalEntity(entity);
  if (target === "pengeluaran") {
    const next = mergeExpensePayload({}, payload);
    next[field] = normalizeMutationFieldValue(target, field, value);
    return next;
  }
  if (target === "reminder") {
    const next = mergeReminderPayload({}, payload);
    next[field] = normalizeMutationFieldValue(target, field, value);
    return next;
  }
  const next = mergeMotorPayload({}, payload);
  next[field] = normalizeMutationFieldValue(target, field, value);
  return next;
}

function mergeEntityMutationPayload(entity, basePayload, patchPayload) {
  const target = canonicalEntity(entity);
  if (target === "pengeluaran") return mergeExpensePayload(basePayload, patchPayload);
  if (target === "reminder") return mergeReminderPayload(basePayload, patchPayload);
  return mergeMotorPayload(basePayload, patchPayload);
}

function normalizeMutationFieldValue(entity, field, value) {
  const target = canonicalEntity(entity);
  if (field === "no") return normalizeNo(value);
  if ([ "tahun", "tahun_plat", "pajak", "harga_jual", "harga_beli", "harga_laku", "total", "total_pengeluaran" ].indexOf(field) !== -1) {
    return parseFlexibleNumber(value);
  }
  if (target === "reminder" && field === "due_at") return normalizeText(value);
  return normalizeText(value);
}

function hasAnyMutationPayload(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  return Object.keys(current).some((key) => !isEmptyValue(current[key]));
}

function buildSemanticPayloadFromPending(pending) {
  const current = pending && typeof pending === "object" ? pending : {};
  const entity = canonicalEntity(current.entity || (current.action === "confirm" ? "sales" : "general"));
  return normalizeParsed({
    action: normalizePendingAction(current.action),
    entity: entity,
    selector: normalizeSelector({
      ids: current.selectedRow && current.selectedRow.no ? [normalizeNo(current.selectedRow.no)] : [],
      names: current.selectedRow && current.selectedRow.nama_motor ? [normalizeText(current.selectedRow.nama_motor)] : [],
      attributes: {
        no: current.selectedRow ? normalizeNo(current.selectedRow.no) : "",
        nama_motor: current.selectedRow ? normalizeText(current.selectedRow.nama_motor) : "",
        plat: ""
      }
    }),
    mutation_payload: current.patch || current.payload || {},
    reference: { mode: "pending_action", target: "pending_action" },
    confidence: 1
  });
}

function buildSemanticPayloadFromSuccessfulAction(action) {
  const current = action && typeof action === "object" ? action : {};
  const entity = canonicalEntity(current.entity || "general");
  const payload = current.payload && typeof current.payload === "object" ? current.payload : {};
  if (!entity || entity === "general") return null;

  const semantic = {
    action: normalizeAction(current.action),
    entity: entity,
    selector: emptySelector(),
    filters: {},
    projection: [],
    mutation_payload: {},
    temporal: normalizeDateRange(null),
    reference: { mode: "last_query", target: "previous_query" },
    confidence: 1
  };

  if (entity === "pengeluaran") {
    semantic.action = "create";
    semantic.selector = normalizeSelector({
      ids: payload.no ? [normalizeNo(payload.no)] : [],
      names: [],
      attributes: {
        no: normalizeNo(payload.no),
        nama_motor: "",
        plat: ""
      }
    });
    semantic.mutation_payload = normalizeExpensePayload(payload);
    return normalizeParsed(semantic);
  }

  if (entity === "sales") {
    semantic.action = "confirm";
    semantic.selector = normalizeSelector({
      ids: payload.no ? [normalizeNo(payload.no)] : [],
      names: payload.nama_motor ? [normalizeText(payload.nama_motor)] : [],
      attributes: {
        no: normalizeNo(payload.no),
        nama_motor: normalizeText(payload.nama_motor),
        plat: ""
      }
    });
    semantic.mutation_payload = normalizeMotorPayload(payload);
    return normalizeParsed(semantic);
  }

  if (entity === "motor") {
    semantic.action = normalizeAction(current.action || "create");
    semantic.selector = normalizeSelector({
      ids: payload.no ? [normalizeNo(payload.no)] : [],
      names: payload.nama_motor ? [normalizeText(payload.nama_motor)] : [],
      attributes: {
        no: normalizeNo(payload.no),
        nama_motor: normalizeText(payload.nama_motor),
        plat: normalizeText(payload.plat)
      }
    });
    semantic.mutation_payload = normalizeMotorPayload(payload);
    return normalizeParsed(semantic);
  }

  if (entity === "reminder") {
    semantic.action = "reminder";
    semantic.mutation_payload = normalizeReminderPayload(payload);
    return normalizeParsed(semantic);
  }

  return null;
}

function normalizePendingAction(action) {
  const raw = normalizeText(action).toLowerCase();
  if (raw === "confirm") return "confirm";
  if (raw === "delete") return "delete";
  if (raw === "update") return "update";
  if (raw === "create") return "create";
  return "query";
}

function rewritePendingSemanticPayload(basePayload, parsed, pending) {
  const state = { pendingAction: pending, lastSemanticPayload: null, lastQuery: null };
  const rewrite = rewriteCorrectionSemanticPayload(Object.assign({}, parsed, {
    reference: { mode: "pending_action", target: "pending_action" }
  }), state);
  if (rewrite && rewrite.payload) return rewrite.payload;

  const base = normalizeStoredSemanticPayload(basePayload) || buildSemanticPayloadFromPending(pending);
  const draft = createSemanticDraft(base, {
    action: normalizePendingAction(pending && pending.action),
    entity: pending && pending.entity
  });
  draft.mutation_payload = mergeEntityMutationPayload(draft.entity, draft.mutation_payload, parsed.mutation_payload);
  return normalizeParsed(draft);
}

function shouldMergeWithPreviousQuery(parsed, previousPlan) {
  if (!previousPlan || typeof previousPlan !== "object") return false;
  if (normalizeAction(parsed.action) === "correction") return true;
  return normalizeReferenceMode(parsed.reference_mode) === "last_query";
}

function buildQueryPlan(parsed, previousPlan, options) {
  const opts = options && typeof options === "object" ? options : {};
  const usePrevious = Boolean(opts.mergePrevious && previousPlan && typeof previousPlan === "object");
  const base = usePrevious ? cloneJson(previousPlan) : {
    action: "query",
    entity: "general",
    metric: "list",
    selector: emptySelector(),
    filters: {},
    projection: [],
    temporal: normalizeDateRange(null)
  };

  const parsedMetric = canonicalMetric(parsed.metric);
  const provisionalEntity = canonicalEntity(parsed.entity || base.entity || "general");
  const projection = normalizeFieldList(
    Array.isArray(parsed.projection) && parsed.projection.length
      ? parsed.projection
      : (usePrevious && normalizeReferenceMode(parsed.reference_mode) === "last_query" ? base.projection : []),
    provisionalEntity
  );
  const selector = mergeSelector(usePrevious ? base.selector : emptySelector(), parsed.selector, parsed.reference_mode);
  const filters = mergeFilters(usePrevious ? base.filters : {}, parsed.filters, provisionalEntity);
  const temporal = mergeTemporal(usePrevious ? base.temporal : normalizeDateRange(null), parsed.temporal, parsed.reference_mode);
  const entity = normalizeQueryEntity(provisionalEntity, parsedMetric || base.metric, selector, filters, projection);
  const availabilityState = normalizeAvailabilityState(parsed.availability_state);
  const metric = resolveQueryMetric({
    parsedMetric: parsedMetric,
    baseMetric: base.metric,
    usePrevious: usePrevious,
    referenceMode: parsed.reference_mode,
    projection: projection,
    selector: selector,
    filters: filters,
    availabilityState: availabilityState
  });

  const plan = {
    action: "query",
    entity: entity,
    metric: metric,
    selector: normalizeSelector(selector),
    filters: normalizeFilters(filters, entity),
    projection: projection,
    fields: projection.slice(),
    temporal: normalizeDateRange(temporal),
    reference: parsed.reference && typeof parsed.reference === "object" ? cloneJson(parsed.reference) : { mode: "", target: "" },
    availability_state: availabilityState
  };

  if (hasExactNumberSelector(plan.selector) && plan.projection.length) {
    plan.metric = "";
    if (plan.entity !== "pengeluaran" && plan.entity !== "reminder") {
      plan.entity = "motor";
    }
  }

  if (plan.entity === "reminder" && !plan.metric) {
    plan.metric = "list";
  }
  if (plan.availability_state === "sold") {
    plan.filters.sold = true;
  } else if (plan.availability_state === "available") {
    plan.filters.sold = false;
  } else if (plan.availability_state === "all") {
    plan.filters.sold = "all";
  } else if (plan.entity === "sales" || isSalesMetric(plan.metric)) {
    if (isUnset(plan.filters.sold)) plan.filters.sold = true;
  } else if (plan.entity === "motor") {
    if (isUnset(plan.filters.sold)) plan.filters.sold = false;
  } else {
    delete plan.filters.sold;
  }

  if (plan.metric === "sum" && !plan.projection.length) {
    const selection = selectDataSource(plan);
    const metricField = resolveMetricField(plan, selection.source || "motor");
    if (metricField) {
      plan.projection = [ metricField ];
      plan.fields = plan.projection.slice();
    }
  }

  sanitizeTemporalSummaryLeak(plan, parsed);

  plan.selector_predicates = cloneJson(plan.selector);
  plan.filter_predicates = cloneJson(plan.filters);
  plan.projection_fields = plan.projection.slice();
  plan.mutation_payload = {};
  plan.temporal_window = cloneJson(plan.temporal);

  return plan;
}

function isProjectionOnlyReferencePlan(plan, previousPlan) {
  const current = plan && typeof plan === "object" ? plan : null;
  const previous = previousPlan && typeof previousPlan === "object" ? previousPlan : null;
  if (!current || !previous) return false;
  if (normalizeReferenceMode(current.reference && current.reference.mode) !== "last_query") return false;
  if (!Array.isArray(current.projection) || !current.projection.length) return false;
  return sameSelector(current.selector, previous.selector)
    && sameJson(normalizeFilters(current.filters, current.entity), normalizeFilters(previous.filters, previous.entity))
    && sameJson(normalizeDateRange(current.temporal), normalizeDateRange(previous.temporal));
}

function isDetachedProjectionPlan(plan) {
  const current = plan && typeof plan === "object" ? plan : null;
  if (!current) return false;
  if (!Array.isArray(current.projection) || current.projection.length === 0) return false;
  if (hasSelector(current.selector)) return false;
  if (hasNonEmptyQueryFilters(current.filters)) return false;
  if (hasDateRange(current.temporal)) return false;
  return !canonicalMetric(current.metric);
}

function isProjectionOnlySemanticQuery(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (normalizeAction(current.action) !== "query") return false;
  if (!Array.isArray(current.projection) || current.projection.length === 0) return false;
  if (hasSelector(current.selector)) return false;
  if (hasNonEmptyQueryFilters(current.filters)) return false;
  if (hasDateRange(current.temporal)) return false;
  const metric = canonicalMetric(current.metric);
  return !metric || metric === "list";
}

function sanitizeTemporalSummaryLeak(plan, parsed) {
  const current = plan && typeof plan === "object" ? plan : null;
  if (!current) return;
  if (canonicalEntity(current.entity) !== "sales") return;
  if (canonicalMetric(current.metric) !== "profit") return;
  if (!hasDateRange(current.temporal)) return;
  if (hasSelector(current.selector)) return;

  const activeKeys = Object.keys(current.filters || {}).filter((key) => {
    if (key === "sold") return current.filters[key] === true || current.filters[key] === false || current.filters[key] === "all";
    return !isEmptyFilterValue(current.filters[key]);
  });
  if (activeKeys.length !== 2 || activeKeys.indexOf("sold") === -1 || activeKeys.indexOf("tahun") === -1) return;

  const confidence = Number(parsed && parsed.confidence || 0);
  if (confidence >= 0.75) return;

  const filterYear = parseFlexibleNumber(current.filters.tahun);
  const currentYear = new Date().getFullYear();
  if (!filterYear || filterYear !== currentYear) return;

  delete current.filters.tahun;
}

function hasFreshReferenceConstraints(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (hasSelector(current.selector)) return true;
  if (hasNonEmptyQueryFilters(current.filters)) return true;
  if (hasDateRange(current.temporal)) return true;
  return false;
}

function resolveQueryMetric(options) {
  const cfg = options && typeof options === "object" ? options : {};
  const parsedMetric = canonicalMetric(cfg.parsedMetric);
  const baseMetric = canonicalMetric(cfg.baseMetric);
  const referenceMode = normalizeReferenceMode(cfg.referenceMode);
  const projection = Array.isArray(cfg.projection) ? cfg.projection : [];
  const selector = cfg.selector && typeof cfg.selector === "object" ? cfg.selector : emptySelector();
  const filters = cfg.filters && typeof cfg.filters === "object" ? cfg.filters : {};
  const availabilityState = normalizeAvailabilityState(cfg.availabilityState);

  if (parsedMetric) return parsedMetric;
  if (projection.length) return "";
  if (hasSelector(selector) || hasNonEmptyQueryFilters(filters) || availabilityState) return "list";
  if (cfg.usePrevious && referenceMode === "last_query" && baseMetric) return baseMetric;
  return "list";
}

function isStandaloneExplicitQuery(parsed) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const metric = canonicalMetric(src.metric);
  const entity = canonicalEntity(src.entity);
  const fields = normalizeFieldList(src.projection, entity);
  const filters = normalizeFilters(src.filters, entity);
  const selector = normalizeSelector(src.selector);
  const temporal = normalizeDateRange(src.temporal);

  if (hasNonEmptyQueryFilters(filters)) return true;
  if (hasSelector(selector)) return true;
  if (hasDateRange(temporal)) return true;
  if (fields.length) return true;
  if (metric === "count" || metric === "sum" || metric === "profit" || metric === "revenue") return true;
  if (entity === "sales" || entity === "pengeluaran" || entity === "global_summary" || entity === "reminder") return true;
  return false;
}

function hasNonEmptyQueryFilters(filters) {
  const src = filters && typeof filters === "object" ? filters : {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === "date_range") {
      if (hasDateRange(src[key])) return true;
      continue;
    }
    if (!isEmptyFilterValue(src[key])) return true;
  }
  return false;
}

function normalizeQueryEntity(entity, metric, selector, filters, projection) {
  const baseEntity = canonicalEntity(entity);
  const canonical = canonicalMetric(metric);
  const sold = normalizeSoldValue(filters && filters.sold);

  if (canonical === "profit" || canonical === "revenue") return "sales";
  if (baseEntity === "sales" || baseEntity === "pengeluaran" || baseEntity === "motor" || baseEntity === "reminder") return baseEntity;

  const hasMotorSignal = hasMotorQuerySignal(selector, filters, projection);
  const hasExpenseSignal = hasExpenseQuerySignal(filters, projection);
  if (baseEntity === "global_summary") {
    if (sold === true) return "sales";
    if (hasMotorSignal) return "motor";
    return "global_summary";
  }

  if (baseEntity === "general") {
    if (hasReminderQuerySignal(filters, projection)) return "reminder";
    if (hasExpenseSignal) return "pengeluaran";
    if (sold === true) return "sales";
    if (hasMotorSignal) return "motor";
  }

  return baseEntity;
}

function hasMotorQuerySignal(selector, filters, projection) {
  const sel = selector && typeof selector === "object" ? selector : emptySelector();
  const src = filters && typeof filters === "object" ? filters : {};
  const watchedFilters = [
    "nama_motor",
    "nomor_motor",
    "tahun",
    "pajak",
    "surat",
    "harga_beli",
    "harga_jual",
    "harga_laku",
    "plat",
    "tahun_plat",
    "sold",
    "tanggal_masuk",
    "tanggal_terjual"
  ];
  if (hasSelector(sel)) return true;
  for (let i = 0; i < watchedFilters.length; i++) {
    if (!isEmptyFilterValue(src[watchedFilters[i]])) return true;
  }

  const list = Array.isArray(projection) ? projection : [];
  return list.length > 0;
}

function hasExpenseQuerySignal(filters, projection) {
  const src = filters && typeof filters === "object" ? filters : {};
  if (!isEmptyFilterValue(src.keterangan)) return true;
  if (!isEmptyFilterValue(src.total_pengeluaran)) return true;
  const list = Array.isArray(projection) ? projection : [];
  for (let i = 0; i < list.length; i++) {
    const field = normalizeText(list[i]).toLowerCase();
    if (field === "keterangan" || field === "tanggal" || field === "total" || field === "total_pengeluaran") return true;
  }
  return false;
}

function hasReminderQuerySignal(filters, projection) {
  const src = filters && typeof filters === "object" ? filters : {};
  if (!isEmptyFilterValue(src.reminder_text) || !isEmptyFilterValue(src.due_at)) return true;
  const list = Array.isArray(projection) ? projection : [];
  for (let i = 0; i < list.length; i++) {
    const field = normalizeText(list[i]).toLowerCase();
    if (field === "text" || field === "due_at" || field === "reminder_text") return true;
  }
  return false;
}

function hasSelector(selector) {
  const src = selector && typeof selector === "object" ? selector : emptySelector();
  const attrs = src.attributes && typeof src.attributes === "object" ? src.attributes : {};
  return Boolean(
    (Array.isArray(src.ids) && src.ids.length)
    || (Array.isArray(src.names) && src.names.length)
    || normalizeNo(attrs.no)
    || normalizeText(attrs.nama_motor)
    || normalizeText(attrs.plat)
  );
}

function hasExactNumberSelector(selector) {
  const src = selector && typeof selector === "object" ? selector : emptySelector();
  return Boolean(
    normalizeNo(src.attributes && src.attributes.no)
    || (Array.isArray(src.ids) && src.ids.some((item) => normalizeNo(item)))
  );
}

function hasExplicitDisambiguatingSelector(parsed, lastQuery) {
  const currentSelector = normalizeSelector(parsed && parsed.selector);
  if (hasExactNumberSelector(currentSelector)) return true;
  if (!hasSelector(currentSelector)) return false;
  const previousSelector = normalizeSelector(lastQuery && lastQuery.selector);
  return !sameSelector(currentSelector, previousSelector);
}

function sameSelector(left, right) {
  const a = normalizeSelector(left);
  const b = normalizeSelector(right);
  return sameJson(a, b);
}

function buildSelectorFromFilters(filters) {
  const src = filters && typeof filters === "object" ? filters : {};
  return normalizeSelector({
    ids: normalizeNo(src.no || src.nomor_motor) ? [ normalizeNo(src.no || src.nomor_motor) ] : [],
    names: normalizeText(src.nama_motor) ? [ normalizeText(src.nama_motor) ] : [],
    attributes: {
      no: normalizeNo(src.no || src.nomor_motor),
      nama_motor: normalizeText(src.nama_motor),
      plat: normalizeText(src.plat)
    }
  });
}

function mergeSelector(baseSelector, nextSelector, referenceMode) {
  const base = normalizeSelector(baseSelector);
  const next = normalizeSelector(nextSelector);
  const mode = normalizeReferenceMode(referenceMode);
  const useBase = mode === "last_query";
  const attrs = Object.assign({}, useBase ? base.attributes : emptySelector().attributes);
  if (normalizeNo(next.attributes.no)) attrs.no = normalizeNo(next.attributes.no);
  if (normalizeText(next.attributes.nama_motor)) attrs.nama_motor = normalizeText(next.attributes.nama_motor);
  if (normalizeText(next.attributes.plat)) attrs.plat = normalizeText(next.attributes.plat);
  return {
    ids: (useBase ? base.ids.slice() : []).concat(next.ids || []).filter(Boolean).filter(uniqueOnly),
    names: (useBase ? base.names.slice() : []).concat(next.names || []).filter(Boolean).filter(uniqueOnly),
    attributes: attrs
  };
}

function mergeTemporal(baseTemporal, nextTemporal, referenceMode) {
  const mode = normalizeReferenceMode(referenceMode);
  if (mode !== "last_query") return normalizeDateRange(nextTemporal);
  const base = normalizeDateRange(baseTemporal);
  const next = normalizeDateRange(nextTemporal);
  return hasDateRange(next) ? next : base;
}

function mergeFilters(baseFilters, nextFilters, entity) {
  const base = baseFilters && typeof baseFilters === "object" ? cloneJson(baseFilters) : {};
  const next = normalizeFilters(nextFilters, entity);
  const merged = Object.assign({}, base);
  Object.keys(next).forEach((key) => {
    if (isEmptyFilterValue(next[key])) return;
    merged[key] = cloneJson(next[key]);
  });
  return merged;
}

function normalizeFilters(filters, entity) {
  const src = filters && typeof filters === "object" ? filters : {};
  const source = selectSourceKeyForEntity(entity);
  const out = {};

  Object.keys(src).forEach((rawKey) => {
    const loweredKey = normalizeText(rawKey).toLowerCase();
    const value = src[rawKey];

    if (loweredKey === "date_range") {
      out.date_range = normalizeDateRange(value);
      return;
    }

    if (loweredKey === "sold") {
      out.sold = normalizeSoldValue(value);
      return;
    }

    const field = resolveFieldKey(source, loweredKey);
    if (!field) return;
    if (field === "sold") {
      out.sold = normalizeSoldValue(value);
      return;
    }
    out[field] = normalizeFilterValue(value);
  });

  if (!out.date_range) out.date_range = normalizeDateRange(src.date_range);
  return out;
}

function normalizeFieldList(fields, entity) {
  const list = Array.isArray(fields) ? fields : [];
  const source = selectSourceKeyForEntity(entity);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const field = resolveFieldKey(source, list[i]);
    if (!field) continue;
    if (out.indexOf(field) === -1) out.push(field);
  }
  return out;
}

function normalizeDateRange(value) {
  const src = value && typeof value === "object" ? value : {};
  const normalized = {
    preset: normalizeText(src.preset),
    last_days: parseFlexibleNumber(src.last_days),
    start_date: normalizeText(src.start_date),
    end_date: normalizeText(src.end_date),
    raw: normalizeText(src.raw)
  };
  if (Number(normalized.last_days || 0) > 0 && !normalized.start_date && !normalized.end_date) {
    normalized.preset = "";
  }
  return normalized;
}

function normalizeSoldValue(value) {
  if (value === true || value === false) return value;
  if (value === "all") return "all";
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";
  if (raw === "all") return "all";
  if (raw === "true") return true;
  if (raw === "false") return false;
  return "";
}

function normalizeAvailabilityState(value) {
  const raw = normalizeText(value).toLowerCase();
  return [ "", "available", "sold", "all" ].indexOf(raw) !== -1 ? raw : "";
}

function normalizeFilterValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && isFinite(value)) return value;
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const text = normalizeText(value);
  if (!text) return "";
  const numeric = parseFlexibleNumber(text);
  return numeric > 0 && /^[-+0-9.,\sA-Za-z]+$/.test(text) ? numeric : text;
}

function normalizeMotorPayload(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    no: normalizePayloadValue(src.no),
    nama_motor: normalizeText(src.nama_motor),
    tahun: normalizePayloadValue(src.tahun),
    plat: normalizeText(src.plat),
    surat_surat: normalizeText(src.surat_surat),
    tahun_plat: normalizePayloadValue(src.tahun_plat),
    pajak: normalizePayloadValue(src.pajak),
    harga_jual: normalizePayloadValue(src.harga_jual),
    harga_beli: normalizePayloadValue(src.harga_beli),
    harga_laku: normalizePayloadValue(src.harga_laku),
    sold: normalizeSoldValue(src.sold),
    tanggal_terjual: normalizeText(src.tanggal_terjual)
  };
}

function normalizeExpensePayload(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    tanggal: normalizeText(src.tanggal),
    keterangan: normalizeText(src.keterangan),
    total: normalizePayloadValue(src.total),
    total_pengeluaran: normalizePayloadValue(src.total_pengeluaran === undefined ? src.total : src.total_pengeluaran)
  };
}

function normalizeReminderPayload(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    due_at: normalizeText(src.due_at),
    text: normalizeText(src.text),
    recurrence: normalizeText(src.recurrence)
  };
}

function repairReminderPayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const src = normalizeReminderPayload(payload.mutation_payload);
  if (!src.text) src.text = normalizeText(payload.value);
  return src;
}

function normalizePayloadValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && isFinite(value)) return Math.round(value);
  const text = normalizeText(value);
  if (!text) return null;
  const numeric = parseFlexibleNumber(text);
  return numeric > 0 ? numeric : text;
}

function selectDataSource(plan) {
  const entity = canonicalEntity(plan && plan.entity);
  const range = normalizeDateRange(plan && plan.temporal ? plan.temporal : null);
  if (entity === "general") {
    return { error: "Permintaan datanya belum cukup jelas untuk ditentukan sumbernya." };
  }
  if (entity === "pengeluaran") return { source: "expense" };
  if (entity === "reminder") return { source: "reminder" };
  if (entity === "global_summary") {
    if (hasDateRange(range)) {
      return { error: "Permintaan dengan filter waktu harus dihitung langsung dari data transaksi, bukan dari ringkasan global." };
    }
    return { source: "total_aset" };
  }
  return { source: "motor" };
}

function selectSourceKeyForEntity(entity) {
  const normalized = canonicalEntity(entity);
  if (normalized === "pengeluaran") return "expense";
  if (normalized === "global_summary") return "total_aset";
  if (normalized === "reminder") return "reminder";
  return "motor";
}

function formatResponse(plan, source, metricResult, rows) {
  let body = "";
  if (metricResult.kind === "rows") {
    if (source === "expense") body = formatExpenseRows(rows, plan.projection);
    else if (source === "reminder") body = formatReminderRows(rows, plan.projection);
    else if (source === "total_aset") body = formatTotalAsetRows(rows);
    else body = formatMotorRows(rows, plan.fields, {
      full: !Array.isArray(plan.fields) || !plan.fields.length
    });
    return buildStructuredReply("QUERY RESULT", body);
  }
  body = formatMetricValue(plan, source, metricResult);
  return buildStructuredReply("QUERY RESULT", body);
}

function formatMetricValue(plan, source, metricResult) {
  const metric = canonicalMetric(plan.metric) || "count";
  const value = Number(metricResult && metricResult.value || 0);

  if (metric === "count") {
    if (source === "expense") return "Jumlah data pengeluaran: " + value + ".";
    if (source === "reminder") return "Jumlah reminder aktif: " + value + ".";
    if (plan.filters && plan.filters.sold === true) return "Jumlah unit terjual: " + value + ".";
    return "Saat ini terdapat " + value + " unit motor yang tersedia.";
  }

  if (metric === "profit") return "Total keuntungan: " + rupiah(value) + ".";
  if (metric === "revenue") return "Total penjualan: " + rupiah(value) + ".";

  if (metric === "sum") {
    const field = resolveFieldKey(source, metricResult.field || (Array.isArray(plan.projection) ? plan.projection[0] : ""));
    const label = field && fieldDefinitions(source)[field] ? fieldDefinitions(source)[field].label : "Total";
    return label + ": " + rupiah(value) + ".";
  }

  return String(value);
}

function formatMotorRows(rows, fields, options) {
  const list = Array.isArray(rows) ? rows : [];
  const full = options && options.full === true;
  const selectedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];

  if (!full && selectedFields.length === 1) {
    const def = MOTOR_FIELDS[selectedFields[0]];
    if (def) {
      return list.map((row) => [
        "NO: " + normalizeNo(row.no),
        def.label + ": " + def.display(row)
      ].join("\n")).join("\n\n");
    }
  }

  const blockFields = full || !selectedFields.length ? MOTOR_FULL_FIELDS : selectedFields;
  return list
    .map((row) => blockFields.map((field) => formatFieldLine("motor", field, row)).filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatExpenseRows(rows, fields) {
  const list = Array.isArray(rows) ? rows : [];
  const selectedFields = Array.isArray(fields) && fields.length ? fields : EXPENSE_FULL_FIELDS;
  return list
    .map((row) => selectedFields.map((field) => formatFieldLine("expense", field, row)).filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatReminderRows(rows, fields) {
  const list = Array.isArray(rows) ? rows : [];
  const selectedFields = Array.isArray(fields) && fields.length ? fields : [ "id", "due_at", "text" ];
  return list
    .map((row) => selectedFields.map((field) => formatFieldLine("reminder", field, row)).filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatTotalAsetRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => [
      formatFieldLine("total_aset", "row", row),
      formatFieldLine("total_aset", "values", row)
    ].filter(Boolean).join("\n"))
    .join("\n\n");
}

function formatFieldLine(source, field, row) {
  const defs = fieldDefinitions(source);
  const key = resolveFieldKey(source, field);
  if (!key || !defs[key]) return "";
  const def = defs[key];
  return def.label + ": " + def.display(row);
}

function fieldDefinitions(source) {
  if (source === "expense") return EXPENSE_FIELDS;
  if (source === "reminder") return REMINDER_FIELDS;
  if (source === "total_aset") return TOTAL_ASET_FIELDS;
  return MOTOR_FIELDS;
}

function resolveFieldKey(source, value) {
  const defs = fieldDefinitions(source);
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "";

  const normalized = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  let bestKey = "";
  let bestScore = 0;

  Object.keys(defs).forEach((key) => {
    const def = defs[key];
    const candidates = [ key, normalizeText(def.label) ].concat(Array.isArray(def.aliases) ? def.aliases : []);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = normalizeText(candidates[i]).toLowerCase();
      if (!candidate) continue;
      if (candidate === normalized) {
        bestKey = key;
        bestScore = 1;
        return;
      }
      const score = stringMatchScore(candidate, normalized);
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }
  });

  return bestScore >= 0.82 ? bestKey : "";
}

function valueMatches(row, def, expected, fieldKey) {
  const actual = def.get(row);
  return valueMatchesByField(actual, def, expected, fieldKey);
}

function valueMatchesByField(actual, def, expected, fieldKey) {
  const key = normalizeText(fieldKey).toLowerCase();

  if (def.type === "boolean") {
    const wanted = normalizeSoldValue(expected);
    if (wanted === "" || wanted === "all") return true;
    return Boolean(actual) === Boolean(wanted);
  }

  if (def.type === "number") {
    const expectedNumber = parseFlexibleNumber(expected);
    if (expectedNumber > 0 || expectedNumber === 0) {
      return Number(actual || 0) === Number(expectedNumber || 0);
    }
    return stringMatchScore(def.display(row), expected) >= 0.82;
  }

  if (def.type === "date") {
    const expectedDate = toDate(expected);
    if (!(expectedDate instanceof Date) || isNaN(expectedDate.getTime())) return false;
    return sameDay(actual, expectedDate);
  }

  const expectedText = normalizeSchemaText(expected);
  const actualText = normalizeSchemaText(actual);
  if (!expectedText) return true;

  if (key === "plat") {
    const expectedToken = expectedText.split(" ")[0];
    const actualToken = actualText.split(" ")[0];
    if (!expectedToken || !actualToken) return false;
    if (expectedToken.length <= 2) return actualToken === expectedToken;
    return actualToken.indexOf(expectedToken) === 0 || actualText.indexOf(expectedText) === 0;
  }

  if (key === "surat_surat") {
    return actualText === expectedText || stringMatchScore(actualText, expectedText) >= 0.9;
  }

  if (key === "nama_motor") {
    return tokenSubsetMatch(actualText, expectedText) || stringMatchScore(actualText, expectedText) >= 0.82;
  }

  if (expectedText.length <= 2) {
    return actualText === expectedText;
  }

  return actualText === expectedText || actualText.indexOf(expectedText) === 0 || stringMatchScore(actualText, expectedText) >= 0.86;
}

function resolveDateField(source, plan) {
  if (source === "expense") return "tanggal";
  if (source === "reminder") return "due_at";
  if (source !== "motor") return "";

  const filters = plan && plan.filters && typeof plan.filters === "object" ? plan.filters : {};
  if (!isEmptyFilterValue(filters.tanggal_masuk)) return "tanggal_masuk";
  if (!isEmptyFilterValue(filters.tanggal_terjual)) return "tanggal_terjual";
  if (canonicalEntity(plan.entity) === "sales") return "tanggal_terjual";
  if (filters.sold === true) return "tanggal_terjual";
  if (isSalesMetric(plan.metric)) return "tanggal_terjual";
  return "tanggal_masuk";
}

function resolveMetricField(plan, source) {
  const fields = Array.isArray(plan.projection) ? plan.projection : [];
  for (let i = 0; i < fields.length; i++) {
    const field = resolveFieldKey(source, fields[i]);
    const def = field && fieldDefinitions(source)[field] ? fieldDefinitions(source)[field] : null;
    if (def && def.type === "number") return field;
  }
  if (source === "expense") return "total_pengeluaran";
  if (source === "motor" && (canonicalEntity(plan.entity) === "sales" || plan.filters.sold === true || isSalesMetric(plan.metric))) return "harga_laku";
  if (source === "motor") return "harga_beli";
  return "";
}

function readFieldValue(source, field, row) {
  const defs = fieldDefinitions(source);
  const key = resolveFieldKey(source, field);
  if (!key || !defs[key]) return "";
  return defs[key].get(row);
}

function hasMotorSelector(filters) {
  const src = filters && typeof filters === "object" ? filters : {};
  return Boolean(normalizeNo(src.no || src.nomor_motor) || normalizeText(src.nama_motor));
}

function buildInputMotorTemplate(index, total) {
  const header = total > 1
    ? "Silakan isi template motor masuk ke-" + index + " berikut:"
    : "Silakan isi template motor masuk berikut:";
  return [
    header,
    "",
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

function buildInputExpenseTemplate() {
  return [
    "Silakan isi pengeluaran berikut:",
    "",
    "TANGGAL:",
    "KETERANGAN:",
    "TOTAL:"
  ].join("\n");
}

function buildMotorMissingReply(missing) {
  const fields = Array.isArray(missing) ? missing.filter(Boolean) : [];
  return [
    "Data motor belum lengkap.",
    "",
    "Field kosong:",
    fields.length ? fields.map((item) => String(item).toUpperCase()).join("\n") : "-",
    "",
    "Apakah mau langsung disimpan?",
    "Balas: iya",
    "",
    "Atau isi saja field yang masih kosong."
  ].join("\n");
}

function buildExpenseMissingReply(missing) {
  const fields = Array.isArray(missing) ? missing.filter(Boolean) : [];
  return [
    "Data pengeluaran belum lengkap.",
    "",
    "Field kosong:",
    fields.length ? fields.map((item) => String(item).toUpperCase()).join("\n") : "-",
    "",
    "Apakah mau langsung disimpan?",
    "Balas: iya",
    "",
    "Atau isi saja field yang masih kosong."
  ].join("\n");
}

function expenseSummaryLine(payload) {
  const src = normalizeExpensePayload(payload);
  return safeText(src.keterangan) + " - " + compactRupiah(src.total_pengeluaran === undefined ? src.total : src.total_pengeluaran);
}

function buildConfirmSaleTemplate(row) {
  return [
    "Silakan isi harga laku:",
    "NO: " + normalizeNo(row.no),
    "Nama Motor: " + normalizeText(row.nama_motor),
    "Harga Laku:"
  ].join("\n");
}

function buildEditPrompt(row) {
  return [
    "Silakan sebutkan field yang ingin diedit untuk motor berikut:",
    "NO: " + normalizeNo(row.no),
    "Nama Motor: " + normalizeText(row.nama_motor)
  ].join("\n");
}

function buildEditPatch(parsed, basePatch) {
  const patch = basePatch && typeof basePatch === "object" ? cloneJson(basePatch) : {};
  const payload = parsed.mutation_payload && typeof parsed.mutation_payload === "object"
    ? normalizeMotorPayload(parsed.mutation_payload)
    : {};

  Object.keys(payload).forEach((rawKey) => {
    if (isEmptyValue(payload[rawKey])) return;
    const key = resolveFieldKey("motor", rawKey);
    if (!key || key === "no" || key === "sold" || key === "tanggal_terjual" || key === "tanggal_masuk") return;
    patch[key] = sanitizePatchValue(key, payload[rawKey]);
  });

  if (Array.isArray(parsed.projection) && parsed.projection.length) {
    const key = resolveFieldKey("motor", parsed.projection[0]);
    if (key) {
      let value = parsed.value;
      if ([ "harga_beli", "harga_jual", "harga_laku" ].indexOf(key) !== -1) value = parseFlexibleNumber(parsed.value);
      if (!isEmptyValue(value)) {
        patch[key] = sanitizePatchValue(key, value);
      }
    }
  }

  const hasPatch = Object.keys(patch).length > 0;
  if (!hasPatch && parseFlexibleNumber(parsed.value) > 0) {
    return {
      hasPatch: false,
      patch: patch,
      error: "Harga mana yang ingin diubah, harga jual atau harga beli?"
    };
  }

  return {
    hasPatch: hasPatch,
    patch: patch,
    error: ""
  };
}

function sanitizePatchValue(field, value) {
  if ([ "harga_beli", "harga_jual", "harga_laku" ].indexOf(field) !== -1) return parseFlexibleNumber(value);
  if ([ "tahun", "tahun_plat", "pajak" ].indexOf(field) !== -1) {
    const numeric = parseFlexibleNumber(value);
    return numeric > 0 ? String(numeric) : normalizeText(value);
  }
  if (field === "plat") return normalizeText(value).toUpperCase();
  return normalizeText(value);
}

function selectCandidate(candidates, parsed) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const selector = extractMotorSelectionFilters(parsed);
  const no = normalizeNo(selector.no || selector.nomor_motor || parsed.value || "");
  if (no) {
    const byNo = rows.find((row) => normalizeNo(row.no) === no);
    return byNo || null;
  }

  const name = normalizeText(selector.nama_motor || parsed.value);
  if (name) {
    const ranked = rows
      .map((row) => ({ row: row, score: stringMatchScore(row.nama_motor, name) }))
      .sort((left, right) => right.score - left.score);
    if (ranked.length && ranked[0].score >= 0.82) return ranked[0].row;
  }

  return null;
}

function extractMotorSelectionFilters(parsed) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const selector = normalizeSelector(src.selector);
  const rawFilters = src.filters && typeof src.filters === "object" ? cloneJson(src.filters) : {};
  const filters = {};

  [ "no", "nomor_motor", "nama_motor", "plat", "tahun", "pajak", "surat_surat", "tahun_plat" ].forEach((key) => {
    if (!isEmptyFilterValue(rawFilters[key])) filters[key] = rawFilters[key];
  });

  if (isEmptyFilterValue(filters.no) && !isEmptyFilterValue(selector.attributes.no)) {
    filters.no = normalizeNo(selector.attributes.no);
  }
  if (isEmptyFilterValue(filters.no) && Array.isArray(selector.ids) && selector.ids.length) {
    filters.no = normalizeNo(selector.ids[0]);
  }
  if (isEmptyFilterValue(filters.no) && !isEmptyFilterValue(filters.nomor_motor)) {
    filters.no = normalizeNo(filters.nomor_motor);
  }
  if (isEmptyFilterValue(filters.nomor_motor) && !isEmptyFilterValue(selector.attributes.no)) {
    filters.nomor_motor = normalizeNo(selector.attributes.no);
  }
  if (isEmptyFilterValue(filters.nama_motor) && !isEmptyFilterValue(selector.attributes.nama_motor)) {
    filters.nama_motor = normalizeText(selector.attributes.nama_motor);
  }
  if (isEmptyFilterValue(filters.nama_motor) && Array.isArray(selector.names) && selector.names.length === 1) {
    filters.nama_motor = normalizeText(selector.names[0]);
  }
  if (isEmptyFilterValue(filters.plat) && !isEmptyFilterValue(selector.attributes.plat)) {
    filters.plat = normalizeText(selector.attributes.plat);
  }
  if (isEmptyFilterValue(filters.no) && !isEmptyValue(src.value)) {
    const derivedNo = normalizeNo(src.value);
    if (derivedNo) filters.no = derivedNo;
  }
  return filters;
}

function formatDateTimeForReply(value, timezone) {
  const raw = normalizeText(value);
  const naive = parseNaiveDateTimeParts(raw);
  if (naive) {
    const formattedDate = [
      String(naive.day).padStart(2, "0"),
      String(naive.month).padStart(2, "0"),
      String(naive.year).padStart(4, "0")
    ].join("/");
    return formattedDate + ", " + String(naive.hour).padStart(2, "0") + ":" + String(naive.minute).padStart(2, "0");
  }
  const date = raw ? new Date(raw) : null;
  if (!date || isNaN(date.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: timezone || "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date).replace(/\./g, ":");
  } catch (err) {
    return raw;
  }
}

function extractSalePrice(parsed) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const data = src.data && typeof src.data === "object" ? src.data : {};
  const direct = parseFlexibleNumber(data.harga_laku);
  if (direct > 0) return direct;
  return parseFlexibleNumber(src.value);
}

function extractSalePriceFromPending(parsed, pending) {
  const direct = extractSalePrice(parsed);
  if (direct > 0) return direct;
  const payload = pending && pending.payload && typeof pending.payload === "object" ? pending.payload : {};
  return parseFlexibleNumber(payload.harga_laku);
}

function buildTargetSemanticPayload(parsed, target) {
  const base = parsed && typeof parsed === "object" ? parsed : {};
  const current = target && typeof target === "object" ? target : {};
  const entity = canonicalEntity(base.entity);
  const selector = hasSelectorContent(current.selector) ? current.selector : base.selector;
  const filters = Object.assign({}, cloneJson(base.filters || {}), cloneJson(current.filters || {}));
  const projection = Array.isArray(current.projection) && current.projection.length
    ? current.projection.slice()
    : (Array.isArray(base.projection) ? base.projection.slice() : []);
  const mutationPayload = mergeMutationPayloadByEntity(entity, base.mutation_payload, current.mutation_payload);
  const temporal = hasDateRange(current.temporal) ? current.temporal : base.temporal;
  const value = !isEmptyValue(current.value) ? current.value : base.value;

  return normalizeParsed({
    action: base.action,
    entity: entity,
    metric: base.metric,
    availability_state: base.availability_state,
    correction_type: base.correction_type,
    target_field: base.target_field,
    new_value: base.new_value,
    selector: selector,
    filters: filters,
    projection: projection,
    mutation_payload: mutationPayload,
    temporal: temporal,
    reference: base.reference,
    user_context: base.user_context,
    value: value,
    count: current.count || base.count
  });
}

function mergeMutationPayloadByEntity(entity, basePayload, targetPayload) {
  const normalized = canonicalEntity(entity);
  if (normalized === "pengeluaran") return mergeExpensePayload(basePayload || {}, targetPayload || {});
  if (normalized === "reminder") return mergeReminderPayload(basePayload || {}, targetPayload || {});
  return mergeMotorPayload(basePayload || {}, targetPayload || {});
}

function deriveMotorSelectionFilters(parsed, target) {
  const filters = extractMotorSelectionFilters(parsed);
  const payload = target && target.mutation_payload && typeof target.mutation_payload === "object"
    ? normalizeMotorPayload(target.mutation_payload)
    : {};

  if (isEmptyFilterValue(filters.no) && !isEmptyValue(payload.no)) filters.no = normalizeNo(payload.no);
  if (isEmptyFilterValue(filters.nomor_motor) && !isEmptyValue(payload.no)) filters.nomor_motor = normalizeNo(payload.no);
  if (isEmptyFilterValue(filters.nama_motor) && !isEmptyValue(payload.nama_motor)) filters.nama_motor = normalizeText(payload.nama_motor);
  if (isEmptyFilterValue(filters.plat) && !isEmptyValue(payload.plat)) filters.plat = normalizeText(payload.plat);
  if (isEmptyFilterValue(filters.tahun) && !isEmptyValue(payload.tahun)) filters.tahun = payload.tahun;
  if (isEmptyFilterValue(filters.pajak) && !isEmptyValue(payload.pajak)) filters.pajak = payload.pajak;
  if (isEmptyFilterValue(filters.surat_surat) && !isEmptyValue(payload.surat_surat)) filters.surat_surat = payload.surat_surat;
  if (isEmptyFilterValue(filters.tahun_plat) && !isEmptyValue(payload.tahun_plat)) filters.tahun_plat = payload.tahun_plat;

  return filters;
}

async function executeMutationLoop(targets, executor) {
  const queue = Array.isArray(targets) ? targets.slice() : [];
  const successes = [];
  const failures = [];
  let pending = queue.map((target, index) => ({ target: target, index: index }));
  let pass = 0;

  while (pending.length && pass < 2) {
    const nextPending = [];
    for (const item of pending) {
      try {
        const result = await executor(item.target, item.index);
        if (result && result.ok) {
          successes.push(Object.assign({ index: item.index }, result));
        } else {
          nextPending.push(item);
          failures.push({
            index: item.index,
            error: normalizeText(result && result.error),
            payload: cloneJson(result && result.payload),
            target: cloneJson(item.target)
          });
        }
      } catch (err) {
        nextPending.push(item);
        failures.push({
          index: item.index,
          error: normalizeText(err && err.message),
          payload: cloneJson(item.target),
          target: cloneJson(item.target)
        });
      }
    }
    pending = nextPending;
    pass += 1;
  }

  const anchors = successes.map((item) => ({
    no: normalizeNo(item.no),
    row_id: normalizeText(item.row_id || item.no),
    label: normalizeText(item.label)
  })).filter((item) => item.no || item.label);

  const primary = successes.length
    ? cloneJson(successes[successes.length - 1].payload || {})
    : {};

  const unresolved = dedupeFailureEntries(failures, successes);
  return {
    expectedTargets: queue.length,
    results: successes,
    anchors: anchors,
    failures: unresolved,
    primaryPayload: primary,
    firstError: unresolved.length ? normalizeText(unresolved[0].error) : ""
  };
}

async function retryMutationFailures(failures, executor) {
  const unresolved = Array.isArray(failures) ? failures.filter((item) => item && item.target) : [];
  const successes = [];
  const nextFailures = [];
  for (const item of unresolved) {
    try {
      const result = await executor(item.target, Number(item.index || 0));
      if (result && result.ok) {
        successes.push(Object.assign({ index: Number(item.index || 0) }, result));
      } else {
        nextFailures.push({
          index: Number(item.index || 0),
          error: normalizeText(result && result.error),
          payload: cloneJson(result && result.payload),
          target: cloneJson(item.target)
        });
      }
    } catch (err) {
      nextFailures.push({
        index: Number(item.index || 0),
        error: normalizeText(err && err.message),
        payload: cloneJson(item && item.payload),
        target: cloneJson(item.target)
      });
    }
  }
  return normalizeVerificationBatch({
    expectedTargets: unresolved.length,
    results: successes,
    failures: nextFailures,
    primaryPayload: successes.length ? cloneJson(successes[successes.length - 1].payload || {}) : {}
  });
}

function normalizeVerificationBatch(batch) {
  const current = batch && typeof batch === "object" ? batch : {};
  const results = Array.isArray(current.results) ? current.results.slice() : [];
  const anchors = Array.isArray(current.anchors)
    ? current.anchors.map((item) => ({
      no: normalizeNo(item && item.no),
      row_id: normalizeText(item && item.row_id || item && item.no),
      label: normalizeText(item && item.label)
    })).filter((item) => item.no || item.label)
    : results.map((item) => ({
      no: normalizeNo(item && item.no),
      row_id: normalizeText(item && item.row_id || item && item.no),
      label: normalizeText(item && item.label)
    })).filter((item) => item.no || item.label);
  const failures = Array.isArray(current.failures) ? current.failures.map((item) => ({
    index: Number(item && item.index || 0),
    error: normalizeText(item && item.error),
    payload: cloneJson(item && item.payload),
    target: cloneJson(item && item.target)
  })) : [];
  return {
    expectedTargets: Math.max(results.length, Number(current.expectedTargets || 0)),
    executedTargets: results.length,
    results: results,
    anchors: anchors,
    failures: failures,
    primaryPayload: cloneJson(current.primaryPayload || (results.length ? results[results.length - 1].payload || {} : {})),
    firstError: normalizeText(current.firstError || (failures.length ? failures[0].error : "")),
    verificationNotice: normalizeText(current.verificationNotice),
    retryAttempted: Boolean(current.retryAttempted),
    partialFailure: Boolean(current.partialFailure)
  };
}

function mergeMutationBatchResults(primaryBatch, retriedBatch) {
  const primary = normalizeVerificationBatch(primaryBatch);
  const retry = normalizeVerificationBatch(retriedBatch);
  const resultMap = new Map();
  primary.results.forEach((item) => resultMap.set(Number(item.index || 0), item));
  retry.results.forEach((item) => resultMap.set(Number(item.index || 0), item));
  const results = Array.from(resultMap.values()).sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
  const successfulIndexes = new Set(results.map((item) => Number(item.index || 0)));
  const failures = primary.failures
    .concat(retry.failures)
    .filter((item) => !successfulIndexes.has(Number(item.index || 0)));
  const dedupedFailures = dedupeFailureEntries(failures, results);
  return normalizeVerificationBatch({
    expectedTargets: Math.max(primary.expectedTargets, retry.expectedTargets, results.length),
    results: results,
    failures: dedupedFailures,
    primaryPayload: results.length ? cloneJson(results[results.length - 1].payload || {}) : cloneJson(primary.primaryPayload || {}),
    firstError: dedupedFailures.length ? normalizeText(dedupedFailures[0].error) : ""
  });
}

function mergeReceiptWithRetry(receipt, retriedBatch) {
  const current = receipt && typeof receipt === "object" ? receipt : {};
  const merged = mergeMutationBatchResults({
    expectedTargets: Number(current.expectedTargets || 0),
    results: normalizeReceiptTargetsToResults(current.targets),
    failures: Array.isArray(current.failures) ? current.failures : [],
    primaryPayload: current.targets && current.targets.length ? current.targets[current.targets.length - 1].payload : {}
  }, retriedBatch);
  return {
    action: normalizeAction(current.action),
    entity: canonicalEntity(current.entity),
    payload: cloneJson(merged.primaryPayload || {}),
    targets: merged.results.map((item) => buildActionTarget(item)),
    anchors: merged.anchors,
    expectedTargets: merged.expectedTargets,
    executedTargets: merged.results.length,
    failures: merged.failures,
    completedAt: Number(current.timestamp || Date.now())
  };
}

function normalizeReceiptTargetsToResults(targets) {
  return (Array.isArray(targets) ? targets : []).map((item, index) => ({
    ok: true,
    index: index,
    no: normalizeNo(item && item.no),
    row_id: normalizeText(item && item.row_id || item && item.no),
    label: normalizeText(item && item.label),
    payload: cloneJson(item && item.payload)
  }));
}

function buildActionTarget(result) {
  const current = result && typeof result === "object" ? result : {};
  return {
    no: normalizeNo(current.no || (current.payload && current.payload.no)),
    row_id: normalizeText(current.row_id || current.no || (current.payload && current.payload.no)),
    label: normalizeText(current.label || (current.payload && (current.payload.nama_motor || current.payload.keterangan || current.payload.text))),
    payload: cloneJson(current.payload)
  };
}

function buildReceiptAnchorsFromTarget(result) {
  const target = buildActionTarget(result);
  if (!target.no && !target.label) return [];
  return [{
    no: target.no,
    row_id: target.row_id || target.no,
    label: target.label
  }];
}

function extractActionReceipt(session) {
  const state = session && typeof session === "object" ? session : {};
  if (state.lastActionReceipt && typeof state.lastActionReceipt === "object") return state.lastActionReceipt;
  const successful = state.lastSuccessfulAction && typeof state.lastSuccessfulAction === "object" ? state.lastSuccessfulAction : null;
  if (!successful) return null;
  return {
    action: normalizeAction(successful.action),
    entity: canonicalEntity(successful.entity),
    targets: Array.isArray(successful.targets) ? successful.targets.map((item) => buildActionTarget(item)) : [],
    anchors: Array.isArray(successful.anchors) ? successful.anchors.map((item) => ({
      no: normalizeNo(item && item.no),
      row_id: normalizeText(item && item.row_id || item && item.no),
      label: normalizeText(item && item.label)
    })) : [],
    expectedTargets: Math.max(0, Number(successful.expectedTargets || 0)),
    executedTargets: Math.max(0, Number(successful.executedTargets || 0)),
    failures: Array.isArray(successful.failures) ? successful.failures.map((item) => ({
      index: Number(item && item.index || 0),
      error: normalizeText(item && item.error),
      payload: cloneJson(item && item.payload),
      target: cloneJson(item && item.target)
    })) : [],
    timestamp: Number(successful.completedAt || Date.now())
  };
}

function pickDefaultReceiptAnchor(receipt) {
  const current = receipt && typeof receipt === "object" ? receipt : {};
  const anchors = Array.isArray(current.anchors) ? current.anchors : [];
  if (anchors.length === 1) return anchors[0];
  if (anchors.length > 1) return anchors[anchors.length - 1];
  const targets = Array.isArray(current.targets) ? current.targets : [];
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) return targets[targets.length - 1];
  return null;
}

function buildActionReceiptReply(receipt, options) {
  const current = receipt && typeof receipt === "object" ? receipt : {};
  const opts = options && typeof options === "object" ? options : {};
  const lines = [];
  if (opts.preface) lines.push(String(opts.preface));
  lines.push(buildSatisfiedReceiptReply(current));
  return lines.filter(Boolean).join("\n");
}

function buildSatisfiedReceiptReply(receipt) {
  const current = receipt && typeof receipt === "object" ? receipt : {};
  const action = normalizeAction(current.action);
  const entity = canonicalEntity(current.entity);
  const targets = Array.isArray(current.targets) ? current.targets : [];
  const batch = {
    results: normalizeReceiptTargetsToResults(targets),
    failures: Array.isArray(current.failures) ? current.failures : [],
    expectedTargets: Number(current.expectedTargets || targets.length || 0),
    executedTargets: Number(current.executedTargets || targets.length || 0),
    verificationNotice: normalizeText(current.verificationNotice)
  };
  const labels = mutationReplyLabels(action, entity);
  return buildMutationReply(action, entity, batch, labels);
}

function mutationReplyLabels(action, entity) {
  if (action === "create" && entity === "motor") return { single: "Motor berhasil ditambahkan.", multi: "Motor berhasil ditambahkan:" };
  if (action === "create" && entity === "pengeluaran") return { single: "Pengeluaran berhasil dicatat:", multi: "Pengeluaran berhasil dicatat:" };
  if (action === "confirm" && entity === "sales") return { single: "Konfirmasi motor terjual berhasil disimpan.", multi: "Konfirmasi motor terjual berhasil disimpan:" };
  if (action === "update" && entity === "motor") return { single: "Data motor berhasil diperbarui.", multi: "Data motor berhasil diperbarui:" };
  if (action === "delete" && entity === "motor") return { single: "Data motor berhasil dibersihkan.", multi: "Data motor berhasil dibersihkan:" };
  return { single: "Perubahan berhasil disimpan.", multi: "Perubahan berhasil disimpan:" };
}

function shouldHandleResultVerification(parsed, context, session) {
  const state = session && typeof session === "object" ? session : null;
  if (!state || state.pendingAction) return false;
  if (!extractActionReceipt(state) && !(state.lastQueryContext && typeof state.lastQueryContext === "object")) return false;
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (normalizeAction(current.action) !== "correction") return false;
  if (normalizeCorrectionType(current.correction_type)) return false;
  if (hasSelectorContent(current.selector)) return false;
  if (hasMeaningfulFilterEntries(current.filters)) return false;
  if (hasNonEmptyMutationPayload(current.mutation_payload)) return false;
  if (Array.isArray(current.projection) && current.projection.length) return false;
  if (hasDateRange(current.temporal)) return false;
  return true;
}

function hasExplicitMutationTarget(parsed, session) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (hasSelectorContent(current.selector)) return true;
  if (hasMeaningfulFilterEntries(current.filters)) return true;

  const targets = Array.isArray(current.targets) ? current.targets : [];
  if (targets.some((target) => {
    const entry = target && typeof target === "object" ? target : {};
    return hasSelectorContent(entry.selector)
      || hasMeaningfulFilterEntries(entry.filters)
      || normalizeNo(entry.no || (entry.mutation_payload && entry.mutation_payload.no))
      || normalizeText(entry.label || (entry.mutation_payload && entry.mutation_payload.nama_motor));
  })) {
    return true;
  }

  const state = session && typeof session === "object" ? session : {};
  if (state.pendingAction && typeof state.pendingAction === "object") {
    if (state.pendingAction.selectedRow && normalizeNo(state.pendingAction.selectedRow.no)) return true;
    if (Array.isArray(state.pendingAction.candidates) && state.pendingAction.candidates.length > 0) return true;
  }

  const receipt = extractActionReceipt(state);
  if (receipt && Array.isArray(receipt.anchors) && receipt.anchors.length === 1) return true;
  if (Array.isArray(state.lastReferenceTargets) && state.lastReferenceTargets.length === 1) return true;
  return false;
}

function isVerificationOnlyCorrection(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (normalizeAction(current.action) !== "correction") return false;
  if (normalizeCorrectionType(current.correction_type)) return false;
  if (hasSelectorContent(current.selector)) return false;
  if (hasMeaningfulFilterEntries(current.filters)) return false;
  if (hasNonEmptyMutationPayload(current.mutation_payload)) return false;
  if (Array.isArray(current.projection) && current.projection.length) return false;
  if (hasDateRange(current.temporal)) return false;
  return true;
}

function lowConfidenceMutationReply(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const action = normalizeAction(current.action);
  if ([ "create", "update", "delete", "confirm" ].indexOf(action) === -1) return "";
  const confidence = Number(current.confidence || 0);
  if (confidence >= 0.6) return "";
  const entity = canonicalEntity(current.entity);
  if (entity === "pengeluaran") {
    return buildStructuredReply("AMBIGUITY REQUEST", "Saya belum cukup yakin data pengeluaran yang dimaksud. Tolong jelaskan lagi keterangannya dan nominalnya.");
  }
  if (entity === "motor" || entity === "sales") {
    return buildStructuredReply("AMBIGUITY REQUEST", "Saya belum cukup yakin data motor yang dimaksud. Tolong jelaskan lagi nama motor, nomor, atau perubahan yang ingin disimpan.");
  }
  return buildStructuredReply("AMBIGUITY REQUEST", "Saya belum cukup yakin data yang dimaksud. Tolong jelaskan lagi sebelum saya menjalankan perubahan.");
}

function hasMeaningfulFilterEntries(filters) {
  const src = filters && typeof filters === "object" ? filters : {};
  return Object.keys(src).some((key) => {
    if (normalizeText(key).toLowerCase() === "date_range") {
      return hasDateRange(src[key]);
    }
    return !isEmptyFilterValue(src[key]);
  });
}

function resolveTargetReference(parsed, context, session, options) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const state = session && typeof session === "object" ? session : {};
  const receipt = options && options.receipt && typeof options.receipt === "object"
    ? options.receipt
    : extractActionReceipt(state);
  const anchors = Array.isArray(receipt && receipt.anchors) && receipt.anchors.length
    ? receipt.anchors.filter(Boolean)
    : (Array.isArray(state.lastReferenceTargets) ? state.lastReferenceTargets.filter(Boolean) : []);
  if (!anchors.length) return { anchor: null };

  const selector = current.selector && typeof current.selector === "object" ? current.selector : emptySelector();
  const exactNo = normalizeNo(selector.attributes && selector.attributes.no || (Array.isArray(selector.ids) && selector.ids[0]));
  if (exactNo) {
    const matched = anchors.find((item) => normalizeNo(item && item.no) === exactNo);
    return matched ? { anchor: matched } : { invalid: true };
  }

  const labelCandidates = []
    .concat(Array.isArray(selector.names) ? selector.names : [])
    .concat(normalizeText(selector.attributes && selector.attributes.nama_motor) || []);
  const resolvedByLabel = resolveAnchorByLabel(anchors, labelCandidates);
  if (resolvedByLabel) return { anchor: resolvedByLabel };

  const rawText = normalizeText(context && context.userText);
  const ordinalAnchor = resolveAnchorByOrdinal(anchors, rawText);
  if (ordinalAnchor) return { anchor: ordinalAnchor };
  const rawLabelAnchor = resolveAnchorByRawText(anchors, rawText);
  if (rawLabelAnchor) return { anchor: rawLabelAnchor };

  if (anchors.length === 1) return { anchor: anchors[0] };
  return { ambiguous: true, anchors: anchors };
}

function resolveAnchorByLabel(anchors, candidates) {
  const list = Array.isArray(anchors) ? anchors : [];
  const labels = Array.isArray(candidates) ? candidates : [];
  let best = null;
  let bestScore = 0;
  for (const candidate of labels) {
    const expected = normalizeSchemaText(candidate);
    if (!expected) continue;
    for (const anchor of list) {
      const actual = normalizeSchemaText(anchor && anchor.label);
      if (!actual) continue;
      if (actual === expected) return anchor;
      const score = stringMatchScore(actual, expected);
      if (score > bestScore) {
        bestScore = score;
        best = anchor;
      }
    }
  }
  return bestScore >= 0.82 ? best : null;
}

function resolveAnchorByOrdinal(anchors, rawText) {
  const list = Array.isArray(anchors) ? anchors : [];
  const text = normalizeSchemaText(rawText);
  if (!text || !list.length) return null;
  if (/\b(pertama|awal|1)\b/.test(text)) return list[0] || null;
  if (/\b(kedua|2)\b/.test(text)) return list[1] || null;
  if (/\b(ketiga|3)\b/.test(text)) return list[2] || null;
  if (/\b(terakhir|paling akhir|tadi|itu)\b/.test(text)) return list[list.length - 1] || null;
  return null;
}

function resolveAnchorByRawText(anchors, rawText) {
  const text = normalizeSchemaText(rawText);
  if (!text) return null;
  return resolveAnchorByLabel(anchors, [ text ]);
}

function buildAnchorDisambiguationReply(receipt) {
  const current = receipt && typeof receipt === "object" ? receipt : {};
  const anchors = Array.isArray(current.anchors) ? current.anchors : [];
  if (!anchors.length) return buildStructuredReply("AMBIGUITY REQUEST", "Saya perlu tahu item yang dimaksud dari hasil terakhir.");
  const labels = anchors
    .map((item) => normalizeText(item && item.label))
    .filter(Boolean);
  if (labels.length === anchors.length && labels.length > 1) {
    const natural = labels.length === 2
      ? labels.join(" atau ")
      : labels.slice(0, -1).join(", ") + ", atau " + labels[labels.length - 1];
    return buildStructuredReply("AMBIGUITY REQUEST", "Yang mana yang dimaksud? " + natural + "?");
  }
  const lines = [
    "Saya perlu tahu item yang dimaksud dari hasil terakhir."
  ];
  anchors.forEach((item) => {
    lines.push("NO " + safeText(item.no) + " - " + (normalizeText(item.label) || "Item"));
  });
  return buildStructuredReply("AMBIGUITY REQUEST", lines.join("\n"));
}

function dedupeFailureEntries(failures, successes) {
  const successIndexes = new Set((Array.isArray(successes) ? successes : []).map((item) => Number(item.index)));
  const seen = new Set();
  return (Array.isArray(failures) ? failures : []).filter((item) => {
    const index = Number(item && item.index);
    if (successIndexes.has(index)) return false;
    const key = String(index) + "|" + normalizeText(item && item.error);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildMutationReply(action, entity, batch, labels) {
  const opts = labels && typeof labels === "object" ? labels : {};
  const info = batch && typeof batch === "object" ? batch : {};
  const results = Array.isArray(info.results) ? info.results : [];
  const expected = Math.max(results.length, Number(info.expectedTargets || results.length));
  const partial = results.length < expected;

  if (!results.length) return normalizeText(info.firstError) || "";
  if (results.length === 1) {
    const single = opts.single || "Perubahan berhasil disimpan.";
    const singleReply = buildSingleMutationReply(action, entity, results[0], single, partial, expected);
    const lines = [];
    if (normalizeText(info.verificationNotice)) lines.push(normalizeText(info.verificationNotice));
    if ((partial || (Array.isArray(info.failures) && info.failures.length)) && !normalizeText(info.verificationNotice)) {
      lines.push(PARTIAL_FAILURE_MESSAGE);
    }
    lines.push(singleReply);
    if (Array.isArray(info.failures) && info.failures.length) {
      lines.push("");
      lines.push("Yang belum berhasil diproses:");
      info.failures.forEach((item) => lines.push(formatFailureLine(item)));
    }
    return buildStructuredReply("ACTION SUCCESS", lines.filter(Boolean).join("\n"));
  }

  const lines = [];
  if (normalizeText(info.verificationNotice)) lines.push(normalizeText(info.verificationNotice));
  if ((partial || (Array.isArray(info.failures) && info.failures.length)) && !normalizeText(info.verificationNotice)) {
    lines.push(PARTIAL_FAILURE_MESSAGE);
  }
  lines.push(opts.multi || "Perubahan berhasil disimpan:");
  if (partial) lines.push("Berhasil " + results.length + " dari " + expected + " item.");
  results.forEach((item) => lines.push(formatMutationResultLine(action, entity, item)));
  if (Array.isArray(info.failures) && info.failures.length) {
    lines.push("");
    lines.push("Yang belum berhasil diproses:");
    info.failures.forEach((item) => lines.push(formatFailureLine(item)));
  }
  return buildStructuredReply("ACTION SUCCESS", lines.filter(Boolean).join("\n"));
}

function buildStructuredReply(kind, body) {
  const label = normalizeText(kind).toUpperCase();
  const content = String(body === undefined || body === null ? "" : body).trim();
  if (!label) return content;
  if (!content) return label;
  return [ label, "", content ].join("\n");
}

function buildSingleMutationReply(action, entity, result, header, partial, expected) {
  const lines = [ header ];
  if (partial && expected > 1) lines.push("Berhasil 1 dari " + expected + " item.");

  if (action === "create" && entity === "motor") {
    const suffix = appendInsertSuffix(result && result.rawResult || {}) || (normalizeNo(result && result.no) ? (" NO: " + normalizeNo(result && result.no) + ".") : "");
    if (suffix) return header + suffix;
    if (!isEmptyValue(result && result.label)) return [ header, "Nama Motor: " + normalizeText(result.label) ].join("\n");
    return header;
  }
  if (action === "create" && entity === "pengeluaran") {
    lines.push(expenseSummaryLine(result && result.payload || {}));
    return lines.join("\n");
  }
  if (action === "confirm" && entity === "sales") {
    lines.push("NO: " + normalizeNo(result && result.no));
    lines.push("Nama Motor: " + normalizeText(result && result.payload && result.payload.nama_motor || result && result.label));
    lines.push("Harga Laku: " + rupiah(result && result.payload && result.payload.harga_laku));
    return lines.join("\n");
  }
  if (action === "update" && entity === "motor") {
    lines.push("NO: " + normalizeNo(result && result.no));
    if (!isEmptyValue(result && result.label)) lines.push("Nama Motor: " + normalizeText(result.label));
    return lines.join("\n");
  }
  if (action === "delete" && entity === "motor") {
    lines.push("NO: " + normalizeNo(result && result.no));
    if (!isEmptyValue(result && result.label)) lines.push("Nama Motor: " + normalizeText(result.label));
    return lines.join("\n");
  }

  return lines.join("\n");
}

function formatMutationResultLine(action, entity, result) {
  const no = normalizeNo(result && result.no);
  const label = normalizeText(result && result.label);
  if (entity === "pengeluaran") {
    const payload = result && result.payload && typeof result.payload === "object" ? result.payload : {};
    const summary = expenseSummaryLine(payload);
    return "NO " + safeText(no) + " - " + (label || summary);
  }
  if (action === "confirm" && entity === "sales") {
    const price = rupiah(result && result.payload && result.payload.harga_laku);
    return "NO " + safeText(no) + " - " + (label || "Motor") + " - " + price;
  }
  return "NO " + safeText(no) + " - " + (label || summarizeMutationPayload(entity, result && result.payload || {}) || "Item");
}

function formatFailureLine(item) {
  const current = item && typeof item === "object" ? item : {};
  const index = Number(current.index || 0) + 1;
  const payload = current.payload && typeof current.payload === "object" ? current.payload : {};
  const label = normalizeText(payload.nama_motor || payload.keterangan);
  const base = label ? ("Item " + index + " (" + label + ")") : ("Item " + index);
  const detail = normalizeText(current.error);
  return detail ? (base + ": " + detail) : base;
}

function buildMultiTargetMissingReply(entity, incompleteTargets) {
  const items = Array.isArray(incompleteTargets) ? incompleteTargets : [];
  if (!items.length) return "";
  const lines = [
    entity === "pengeluaran" ? "Beberapa data pengeluaran belum lengkap." : "Beberapa data motor belum lengkap."
  ];
  items.forEach((item) => {
    const index = Number(item && item.index || 0) + 1;
    const payload = item && item.payload && typeof item.payload === "object" ? item.payload : {};
    const label = summarizeMutationPayload(entity, payload) || ("Item " + index);
    const missing = Array.isArray(item && item.missing) ? item.missing.filter(Boolean) : [];
    lines.push(label + ": " + (missing.length ? missing.join(", ") : "data belum lengkap"));
  });
  return lines.join("\n");
}

function appendBatchIssues(reply, issues, expectedTargets, preparedTargets) {
  const text = String(reply === undefined || reply === null ? "" : reply);
  const currentIssues = (Array.isArray(issues) ? issues : []).filter(Boolean);
  if (!currentIssues.length) return text;
  if (preparedTargets <= 0) return currentIssues[0];
  const lines = [ text ];
  if (preparedTargets < expectedTargets) {
    lines.push("");
    lines.push("Item yang belum berhasil diproses:");
    currentIssues.forEach((item) => lines.push(item));
  }
  return lines.filter(Boolean).join("\n");
}

function appendSupplementalReply(reply, extraText) {
  const base = String(reply === undefined || reply === null ? "" : reply).trim();
  const extra = String(extraText === undefined || extraText === null ? "" : extraText).trim();
  if (!base) return extra;
  if (!extra) return base;
  return base + "\n\n" + extra;
}

function describeTargetIssue(entity, index, target, message) {
  const current = target && typeof target === "object" ? target : {};
  const payload = current.mutation_payload && typeof current.mutation_payload === "object"
    ? current.mutation_payload
    : {};
  const label = summarizeMutationPayload(entity, payload) || ("Item " + (Number(index || 0) + 1));
  return label + ": " + normalizeText(message || "gagal diproses");
}

function mergeMotorPayload(base, patch) {
  const current = normalizeMotorPayload(base);
  const next = normalizeMotorPayload(patch);
  const out = {};
  Object.keys(current).forEach((key) => {
    out[key] = !isEmptyValue(next[key]) ? next[key] : current[key];
  });
  return out;
}

function mergeExpensePayload(base, patch) {
  const current = normalizeExpensePayload(base);
  const next = normalizeExpensePayload(patch);
  return {
    tanggal: !isEmptyValue(next.tanggal) ? next.tanggal : current.tanggal,
    keterangan: !isEmptyValue(next.keterangan) ? next.keterangan : current.keterangan,
    total: !isEmptyValue(next.total) ? next.total : current.total,
    total_pengeluaran: !isEmptyValue(next.total_pengeluaran) ? next.total_pengeluaran : current.total_pengeluaran
  };
}

function mergeReminderPayload(base, patch) {
  const current = normalizeReminderPayload(base);
  const next = normalizeReminderPayload(patch);
  return {
    due_at: !isEmptyValue(next.due_at) ? next.due_at : current.due_at,
    text: !isEmptyValue(next.text) ? next.text : current.text,
    recurrence: !isEmptyValue(next.recurrence) ? next.recurrence : current.recurrence
  };
}

function hasMotorPayload(payload) {
  const src = normalizeMotorPayload(payload);
  return Object.keys(src).some((key) => !isEmptyValue(src[key]));
}

function hasExpensePayload(payload) {
  const src = normalizeExpensePayload(payload);
  return Object.keys(src).some((key) => !isEmptyValue(src[key]));
}

function applyEntityDefaults(entity, payload, timezone) {
  const target = canonicalEntity(entity);
  if (target === "pengeluaran") {
    const out = mergeExpensePayload({}, payload);
    if (isEmptyValue(out.tanggal)) {
      out.tanggal = formatDate(dateOnly(new Date(), normalizeText(timezone) || "Asia/Jakarta"));
    }
    if (isEmptyValue(out.total_pengeluaran) && !isEmptyValue(out.total)) {
      out.total_pengeluaran = out.total;
    }
    return out;
  }
  if (target === "reminder") {
    const out = mergeReminderPayload({}, payload);
    out.due_at = resolveReminderDueAt(out.due_at, normalizeText(timezone) || "Asia/Jakarta");
    return out;
  }
  return payload;
}

function summarizeMutationPayload(entity, payload) {
  const target = canonicalEntity(entity);
  if (target === "pengeluaran") {
    const src = normalizeExpensePayload(payload);
    const label = normalizeText(src.keterangan);
    if (label) return label;
    const total = parseFlexibleNumber(src.total_pengeluaran);
    return total > 0 ? compactRupiah(total) : "";
  }
  const src = normalizeMotorPayload(payload);
  const no = normalizeNo(src.no);
  const name = normalizeText(src.nama_motor);
  if (name) return name;
  if (no) return "NO " + no;
  return "";
}

function missingMotorFields(payload) {
  const labels = {
    nama_motor: "Nama motor",
    tahun: "Tahun",
    plat: "Plat",
    surat_surat: "Surat-surat",
    tahun_plat: "Tahun plat",
    pajak: "Pajak",
    harga_jual: "Harga jual",
    harga_beli: "Harga beli"
  };
  const src = normalizeMotorPayload(payload);
  return Object.keys(labels).filter((key) => isEmptyValue(src[key])).map((key) => labels[key]);
}

function missingExpenseFields(payload) {
  const labels = {
    tanggal: "Tanggal",
    keterangan: "Keterangan",
    total: "Total"
  };
  const src = normalizeExpensePayload(payload);
  return Object.keys(labels).filter((key) => {
    if (key === "total") return isEmptyValue(src.total) && isEmptyValue(src.total_pengeluaran);
    return isEmptyValue(src[key]);
  }).map((key) => labels[key]);
}

function normalizeMotorRow(row) {
  const src = row && typeof row === "object" ? row : {};
  const no = normalizeNo(src.no);
  if (!no) return null;
  const hargaLaku = parseFlexibleNumber(src.harga_laku);
  const tglTerjual = toDate(src.tgl_terjual);
  const sold = normalizeText(src.status).toLowerCase() === "terjual"
    || hargaLaku > 0
    || (tglTerjual instanceof Date && !isNaN(tglTerjual.getTime()));

  return {
    no: no,
    nama_motor: normalizeText(src.nama_motor),
    tahun: normalizeText(src.tahun),
    plat: normalizeText(src.plat),
    surat_surat: normalizeText(src.surat_surat),
    tahun_plat: normalizeText(src.tahun_plat),
    pajak: normalizeText(src.pajak),
    harga_beli: parseFlexibleNumber(src.harga_beli),
    harga_jual: parseFlexibleNumber(src.harga_jual),
    harga_laku: hargaLaku,
    tgl_terjual: tglTerjual,
    tanggal_masuk: toDate(src.tanggal_masuk || src.tgl_masuk),
    isSold: sold
  };
}

function normalizeExpenseRow(row, fallbackIndex) {
  const src = row && typeof row === "object" ? row : {};
  const no = normalizeNo(src.row || src.no || (Number(fallbackIndex || 0) > 0 ? Number(fallbackIndex) + 2 : ""));
  if (!no) return null;
  return {
    no: no,
    row: Number(src.row || 0),
    tanggal: toDate(src.tanggal),
    keterangan: normalizeText(src.keterangan),
    total_pengeluaran: parseFlexibleNumber(src.total_pengeluaran)
  };
}

function normalizeReminderRow(row) {
  const src = row && typeof row === "object" ? row : {};
  const id = normalizeText(src.id);
  if (!id) return null;
  return {
    id: id,
    phone: normalizeText(src.phone),
    text: normalizeText(src.text),
    due_at: normalizeText(src.dueAt || src.due_at),
    sent: Boolean(src.sent)
  };
}

function selectorOverridesSuccessfulTarget(parsed, payload) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const selector = normalizeSelector(current.selector);
  const targetNo = normalizeNo(payload && payload.no);
  const targetName = normalizeText(payload && payload.nama_motor).toLowerCase();

  if (hasExactNumberSelector(selector)) {
    const incomingNo = normalizeNo(selector.attributes && selector.attributes.no || (Array.isArray(selector.ids) && selector.ids[0]));
    if (incomingNo && incomingNo !== targetNo) return true;
  }

  const incomingName = normalizeText(selector.attributes && selector.attributes.nama_motor || (Array.isArray(selector.names) && selector.names[0])).toLowerCase();
  if (incomingName && targetName && incomingName !== targetName) return true;

  return false;
}

function normalizeTotalAsetRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object" && Array.isArray(row.values))
    .map((row) => ({
      row: Number(row.row || 0),
      values: row.values.map((value) => normalizeText(value)).filter(Boolean)
    }))
    .filter((row) => row.values.length > 0);
}

function normalizeToolError(result, baseText) {
  const message = extractMessage(result);
  return message ? (baseText + " " + message) : baseText;
}

function extractMessage(value) {
  if (!value || typeof value !== "object") return "";
  if (value.message) return normalizeText(value.message);
  if (value.error && typeof value.error === "object" && value.error.message) {
    return normalizeText(value.error.message);
  }
  return "";
}

function appendInsertSuffix(result) {
  const no = normalizeNo(result && result.data && result.data.no);
  return no ? (" NO: " + no + ".") : "";
}

function isSuccess(value) {
  return value && typeof value === "object" && String(value.status || "").toLowerCase() === "success";
}

function hasDateRange(value) {
  const range = normalizeDateRange(value);
  return Boolean(range.last_days || range.start_date || range.end_date || range.preset || range.raw);
}

function isSalesMetric(metric) {
  const normalized = canonicalMetric(metric);
  return normalized === "profit" || normalized === "revenue";
}

function safeText(value) {
  return isEmptyValue(value) ? "-" : String(value);
}

function safeMoney(value) {
  return isEmptyValue(value) ? "-" : rupiah(value);
}

function dedupeByOfficialNumber(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const no = normalizeNo(row && row.no);
    if (!no || seen.has(no)) return false;
    seen.add(no);
    return true;
  });
}

function sameJson(left, right) {
  return JSON.stringify(left || null) === JSON.stringify(right || null);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function isUnset(value) {
  return value === undefined || value === null || value === "";
}

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" ? !value.trim() : false;
}

function isEmptyFilterValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.length === 0;
    if (value instanceof Date) return isNaN(value.getTime());
    return Object.keys(value).every((key) => isEmptyFilterValue(value[key]));
  }
  return false;
}

function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeNo(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^0-9]/g, "");
}

function toCount(value) {
  const numeric = parseFlexibleNumber(value);
  return numeric > 0 ? Math.floor(numeric) : 0;
}

function parseFlexibleNumber(value) {
  if (typeof value === "number" && isFinite(value)) return Math.round(value);
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return 0;

  const text = raw
    .toLowerCase()
    .replace(/rp\.?/g, " ")
    .replace(/idr/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const factor = {
    triliun: 1e12,
    t: 1e12,
    miliar: 1e9,
    milyar: 1e9,
    b: 1e9,
    juta: 1e6,
    jt: 1e6,
    ribu: 1e3,
    rb: 1e3,
    k: 1e3
  };

  let total = 0;
  let found = false;
  const amountPattern = /(-?\d+(?:[.,]\d+)?)\s*(triliun|miliar|milyar|juta|jt|ribu|rb|k|t|b)\b/g;
  let match;
  while ((match = amountPattern.exec(text)) !== null) {
    const number = parseLocaleNumber(match[1]);
    if (number !== null) {
      total += number * (factor[String(match[2]).toLowerCase()] || 1);
      found = true;
    }
  }

  if (found) return Math.round(total);

  const plain = parseLocaleNumber(text);
  return plain === null ? 0 : Math.round(plain);
}

function normalizeSchemaText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSubsetMatch(actual, expected) {
  const target = normalizeSchemaText(actual);
  const wanted = normalizeSchemaText(expected);
  if (!target || !wanted) return false;
  const tokens = wanted.split(" ").filter(Boolean);
  return tokens.every((token) => target.indexOf(token) !== -1);
}

function parseLocaleNumber(value) {
  let text = String(value === undefined || value === null ? "" : value).trim().replace(/[^0-9,.-]/g, "");
  if (!text) return null;

  const hasDot = text.indexOf(".") !== -1;
  const hasComma = text.indexOf(",") !== -1;
  if (hasDot && hasComma) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".")
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (hasComma) {
    text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "");
  } else if (hasDot && !/\.\d{1,2}$/.test(text)) {
    text = text.replace(/\./g, "");
  }

  const numeric = Number(text);
  return isFinite(numeric) ? numeric : null;
}

function rupiah(value) {
  const numeric = parseFlexibleNumber(value);
  return "Rp " + String(Math.round(numeric)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function compactRupiah(value) {
  const numeric = parseFlexibleNumber(value);
  return "Rp" + String(Math.round(numeric)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function toDate(value, timezone) {
  const tz = normalizeText(timezone) || "Asia/Jakarta";
  if (value instanceof Date && !isNaN(value.getTime())) return dateOnly(value, tz);
  const raw = normalizeText(value);
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return new Date(year, Number(match[2]) - 1, Number(match[1]));
  }

  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : dateOnly(parsed, tz);
}

function resolveReminderDueAt(value, timezone) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const naive = parseNaiveDateTimeParts(raw);
  if (naive) {
    return zonedLocalDateTimeToIso(naive, timezone);
  }
  const parsedDate = toDate(raw, timezone);
  if (parsedDate instanceof Date && !isNaN(parsedDate.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return zonedLocalDateTimeToIso({
      year: parsedDate.getFullYear(),
      month: parsedDate.getMonth() + 1,
      day: parsedDate.getDate(),
      hour: 0,
      minute: 0,
      second: 0
    }, timezone);
  }
  const timeMatch = raw.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (timeMatch) {
    const base = dateOnly(new Date(), timezone);
    return zonedLocalDateTimeToIso({
      year: base.getFullYear(),
      month: base.getMonth() + 1,
      day: base.getDate(),
      hour: Math.max(0, Math.min(23, Number(timeMatch[1]))),
      minute: Math.max(0, Math.min(59, Number(timeMatch[2] || 0))),
      second: 0
    }, timezone);
  }
  const direct = new Date(raw);
  if (!isNaN(direct.getTime())) return direct.toISOString();
  return raw;
}

function parseNaiveDateTimeParts(value) {
  const raw = normalizeText(value);
  if (!raw) return null;

  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] || 0)
    };
  }

  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: 0,
      minute: 0,
      second: 0
    };
  }

  return null;
}

function zonedLocalDateTimeToIso(parts, timezone) {
  const current = parts && typeof parts === "object" ? parts : null;
  if (!current) return "";
  const tz = normalizeText(timezone) || "Asia/Jakarta";
  const baseUtc = Date.UTC(
    Number(current.year || 0),
    Number(current.month || 1) - 1,
    Number(current.day || 1),
    Number(current.hour || 0),
    Number(current.minute || 0),
    Number(current.second || 0)
  );

  let candidate = baseUtc;
  for (let i = 0; i < 3; i++) {
    const offset = getTimeZoneOffsetMs(new Date(candidate), tz);
    const next = baseUtc - offset;
    if (Math.abs(next - candidate) < 1000) {
      candidate = next;
      break;
    }
    candidate = next;
  }

  return new Date(candidate).toISOString();
}

function getTimeZoneOffsetMs(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  parts.forEach((part) => {
    if (part.type === "year") year = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "day") day = Number(part.value);
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
    if (part.type === "second") second = Number(part.value);
  });

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - date.getTime();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function withTimeoutGuard(promise, timeoutMs, code) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(String(code || "timeout"))), Math.max(1000, Number(timeoutMs || 0)));
    })
  ]);
}

function dateOnly(dateObj, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(dateObj);

  let year = "";
  let month = "";
  let day = "";
  parts.forEach((part) => {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
  });

  return new Date(Number(year), Number(month) - 1, Number(day));
}

function addDays(dateObj, delta) {
  const date = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  date.setDate(date.getDate() + Number(delta || 0));
  return date;
}

function buildDateRange(value, timezone) {
  const range = normalizeDateRange(value);
  const tz = normalizeText(timezone) || "Asia/Jakarta";
  const today = dateOnly(new Date(), tz);

  let start = toDate(range.start_date, tz);
  let end = toDate(range.end_date, tz);

  if (!start && !end && Number(range.last_days || 0) > 0) {
    start = addDays(today, -(Number(range.last_days) - 1));
    end = today;
  }

  if (!start && !end) {
    const preset = normalizeText(range.preset).toLowerCase();
    if (preset === "today") {
      start = today;
      end = today;
    } else if (preset === "week") {
      start = addDays(today, -6);
      end = today;
    } else if (preset === "month") {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = today;
    }
  }

  return { start: start, end: end };
}

function inDateRange(value, range) {
  const date = toDate(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const start = range && range.start instanceof Date && !isNaN(range.start.getTime()) ? range.start : null;
  const end = range && range.end instanceof Date && !isNaN(range.end.getTime()) ? range.end : null;
  if (start && date.getTime() < start.getTime()) return false;
  if (end && date.getTime() > end.getTime()) return false;
  return true;
}

function sameDay(left, right) {
  const a = toDate(left);
  const b = toDate(right);
  if (!(a instanceof Date) || isNaN(a.getTime())) return false;
  if (!(b instanceof Date) || isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatDate(value) {
  const date = toDate(value);
  if (!(date instanceof Date) || isNaN(date.getTime())) return "-";
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function stringMatchScore(actual, expected) {
  const left = normalizeComparable(actual);
  const right = normalizeComparable(expected);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.indexOf(right) !== -1 || right.indexOf(left) !== -1) return 0.96;

  const leftTokens = splitTokens(left);
  const rightTokens = splitTokens(right);
  const tokenCover = rightTokens.length ? rightTokens.every((token) => left.indexOf(token) !== -1) : false;
  if (tokenCover) return 0.93;

  const charScore = similarity(collapse(left), collapse(right));
  const tokenScore = averageTokenSimilarity(leftTokens, rightTokens);
  return Math.max(charScore, tokenScore);
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function splitTokens(value) {
  const raw = normalizeComparable(value);
  return raw ? raw.split(" ").filter(Boolean) : [];
}

function collapse(value) {
  return normalizeComparable(value).replace(/[^a-z0-9]/g, "");
}

function averageTokenSimilarity(left, right) {
  const a = Array.isArray(left) ? left.filter(Boolean) : [];
  const b = Array.isArray(right) ? right.filter(Boolean) : [];
  if (!a.length || !b.length) return 0;

  let total = 0;
  for (let i = 0; i < a.length; i++) {
    let best = 0;
    for (let j = 0; j < b.length; j++) {
      const score = similarity(collapse(a[i]), collapse(b[j]));
      if (score > best) best = score;
    }
    total += best;
  }
  return total / a.length;
}

function similarity(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const size = Math.max(a.length, b.length) || 1;
  return Math.max(0, 1 - (distance / size));
}

function levenshtein(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[b.length];
}

const MOTOR_FIELDS = {
  no: {
    label: "NO",
    aliases: [ "no", "nomor", "nomor_motor", "motor_number" ],
    type: "string",
    get: (row) => normalizeNo(row.no),
    display: (row) => normalizeNo(row.no)
  },
  nama_motor: {
    label: "Nama Motor",
    aliases: [ "nama_motor", "nama", "motor", "motor_name" ],
    type: "string",
    get: (row) => normalizeText(row.nama_motor),
    display: (row) => normalizeText(row.nama_motor)
  },
  tahun: {
    label: "Tahun",
    aliases: [ "tahun" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.tahun),
    display: (row) => normalizeText(row.tahun)
  },
  plat: {
    label: "Plat",
    aliases: [ "plat" ],
    type: "string",
    get: (row) => normalizeText(row.plat),
    display: (row) => normalizeText(row.plat)
  },
  surat_surat: {
    label: "Surat",
    aliases: [ "surat", "surat_surat" ],
    type: "string",
    get: (row) => normalizeText(row.surat_surat),
    display: (row) => normalizeText(row.surat_surat)
  },
  tahun_plat: {
    label: "Tahun Plat",
    aliases: [ "tahun_plat", "tahunplat" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.tahun_plat),
    display: (row) => normalizeText(row.tahun_plat)
  },
  pajak: {
    label: "Pajak",
    aliases: [ "pajak" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.pajak),
    display: (row) => normalizeText(row.pajak)
  },
  harga_beli: {
    label: "Harga Beli",
    aliases: [ "harga_beli", "buy_price" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.harga_beli),
    display: (row) => rupiah(row.harga_beli)
  },
  harga_jual: {
    label: "Harga Jual",
    aliases: [ "harga_jual", "sell_price" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.harga_jual),
    display: (row) => rupiah(row.harga_jual)
  },
  harga_laku: {
    label: "Harga Laku",
    aliases: [ "harga_laku", "sold_price" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.harga_laku),
    display: (row) => parseFlexibleNumber(row.harga_laku) > 0 ? rupiah(row.harga_laku) : "-"
  },
  sold: {
    label: "Status",
    aliases: [ "sold", "status", "status_terjual" ],
    type: "boolean",
    get: (row) => Boolean(row.isSold),
    display: (row) => row.isSold ? "Terjual" : "Belum terjual"
  },
  tanggal_terjual: {
    label: "Tanggal Terjual",
    aliases: [ "tanggal_terjual", "tgl_terjual" ],
    type: "date",
    get: (row) => toDate(row.tgl_terjual),
    display: (row) => formatDate(row.tgl_terjual)
  },
  tanggal_masuk: {
    label: "Tanggal Masuk",
    aliases: [ "tanggal_masuk", "tgl_masuk" ],
    type: "date",
    get: (row) => toDate(row.tanggal_masuk),
    display: (row) => formatDate(row.tanggal_masuk)
  }
};

const EXPENSE_FIELDS = {
  no: {
    label: "NO",
    aliases: [ "no", "nomor" ],
    type: "string",
    get: (row) => normalizeNo(row.no),
    display: (row) => normalizeNo(row.no)
  },
  tanggal: {
    label: "Tanggal",
    aliases: [ "tanggal", "date" ],
    type: "date",
    get: (row) => toDate(row.tanggal),
    display: (row) => formatDate(row.tanggal)
  },
  keterangan: {
    label: "Keterangan",
    aliases: [ "keterangan", "deskripsi", "detail" ],
    type: "string",
    get: (row) => normalizeText(row.keterangan),
    display: (row) => normalizeText(row.keterangan)
  },
  total_pengeluaran: {
    label: "Total",
    aliases: [ "total", "nominal", "total_pengeluaran" ],
    type: "number",
    get: (row) => parseFlexibleNumber(row.total_pengeluaran),
    display: (row) => rupiah(row.total_pengeluaran)
  }
};

const REMINDER_FIELDS = {
  id: {
    label: "ID",
    aliases: [ "id", "reminder_id" ],
    type: "string",
    get: (row) => normalizeText(row.id),
    display: (row) => normalizeText(row.id)
  },
  due_at: {
    label: "Waktu",
    aliases: [ "due_at", "waktu", "jadwal" ],
    type: "date",
    get: (row) => toDate(row.due_at),
    display: (row) => formatDateTimeForReply(row.due_at, "Asia/Jakarta")
  },
  text: {
    label: "Pesan",
    aliases: [ "text", "pesan", "reminder_text" ],
    type: "string",
    get: (row) => normalizeText(row.text),
    display: (row) => normalizeText(row.text)
  },
  sent: {
    label: "Status",
    aliases: [ "sent", "status" ],
    type: "boolean",
    get: (row) => Boolean(row.sent),
    display: (row) => row.sent ? "Terkirim" : "Pending"
  }
};

const TOTAL_ASET_FIELDS = {
  row: {
    label: "ROW",
    aliases: [ "row" ],
    type: "number",
    get: (row) => Number(row.row || 0),
    display: (row) => String(Number(row.row || 0))
  },
  values: {
    label: "Nilai",
    aliases: [ "values", "nilai" ],
    type: "string",
    get: (row) => Array.isArray(row.values) ? row.values.join(" | ") : "",
    display: (row) => Array.isArray(row.values) ? row.values.join(" | ") : ""
  }
};

module.exports = ResolverEngine;
