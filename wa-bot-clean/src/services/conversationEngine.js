const FLOW_STATE = {
  IDLE: "IDLE",
  PENDING_CREATE: "PENDING_CREATE",
  PENDING_CONFIRM: "PENDING_CONFIRM",
  PENDING_CORRECTION: "PENDING_CORRECTION",
  PENDING_QUERY: "PENDING_QUERY",
  DONE: "DONE"
};

const REFERENCE_MODE = {
  NONE: "",
  NEW_REQUEST: "new_request",
  PENDING_ACTION: "pending_action",
  LAST_QUERY: "last_query"
};

class ConversationEngine {
  constructor() {
    this.sessions = new Map();
  }

  getSessionKey(context) {
    const ctx = context && typeof context === "object" ? context : {};
    return normalizeText(ctx.userPhone || ctx.chatPhone || "global");
  }

  getSession(context) {
    const key = this.getSessionKey(context);
    const existing = this.sessions.get(key);
    if (existing && typeof existing === "object") return existing;

    const fresh = {
      lastQuery: null,
      lastQueryContext: null,
      lastReferenceTargets: [],
      lastSemanticPayload: null,
      lastRows: [],
      lastSource: "",
      contextValid: false,
      ambiguityFlag: false,
      candidateRows: [],
      candidateEntity: "",
      lastProjection: [],
      invalidQueryContext: false,
      invalidQueryReason: "",
      pendingAction: null,
      lastCompletedAction: null,
      lastSuccessfulAction: null,
      lastActionReceipt: null,
      lastActionEntity: "",
      lastActionPayload: null,
      correctionWindowRemaining: 0,
      lastAssistantMessage: "",
      lastAssistantPromptKind: "",
      lastAssistantQuestionCount: 0,
      lastUserMessage: "",
      conversationState: FLOW_STATE.IDLE,
      updatedAt: Date.now()
    };
    this.sessions.set(key, fresh);
    return fresh;
  }

  resetAllSessions() {
    this.sessions.clear();
  }

  resetSession(session) {
    if (!session || typeof session !== "object") return;
    session.lastQuery = null;
    session.lastQueryContext = null;
    session.lastReferenceTargets = [];
    session.lastSemanticPayload = null;
    session.lastRows = [];
    session.lastSource = "";
    session.contextValid = false;
    session.ambiguityFlag = false;
    session.candidateRows = [];
    session.candidateEntity = "";
    session.lastProjection = [];
    session.invalidQueryContext = false;
    session.invalidQueryReason = "";
    session.pendingAction = null;
    session.lastCompletedAction = null;
    session.lastSuccessfulAction = null;
    session.lastActionReceipt = null;
    session.lastActionEntity = "";
    session.lastActionPayload = null;
    session.correctionWindowRemaining = 0;
    session.lastAssistantMessage = "";
    session.lastAssistantPromptKind = "";
    session.lastAssistantQuestionCount = 0;
    session.lastUserMessage = "";
    session.conversationState = FLOW_STATE.IDLE;
    session.updatedAt = Date.now();
  }

  clearConversation(session) {
    if (!session || typeof session !== "object") return;
    session.pendingAction = null;
    session.conversationState = deriveConversationState(session, null);
    session.updatedAt = Date.now();
  }

  prepareTurn(session, parsed) {
    if (!session || typeof session !== "object") return;
    const payload = parsed && typeof parsed === "object" ? parsed : {};
    const action = normalizeText(payload.action).toLowerCase();
    const referenceMode = normalizeReferenceMode(payload.reference_mode || (payload.reference && payload.reference.mode));

    if (action !== "correction" && session.correctionWindowRemaining > 0 && !isPostExecutionCorrectionCandidate(payload, session)) {
      session.correctionWindowRemaining = 0;
      session.lastSuccessfulAction = null;
    }

    if (
      referenceMode !== REFERENCE_MODE.LAST_QUERY
      && action !== "correction"
      && isExplicitNewRequestPayload(payload)
      && !isProjectionOnlyFollowupPayload(payload)
    ) {
      this.clearInvalidQueryContext(session);
      if (shouldResetIrrelevantTopicContext(session, payload, referenceMode)) {
        this.clearQueryContext(session);
        clearActionTopicContext(session);
      }
    }

    session.updatedAt = Date.now();
  }

  touch(session) {
    if (!session || typeof session !== "object") return;
    session.updatedAt = Date.now();
  }

  setPendingAction(session, pendingAction) {
    if (!session || typeof session !== "object") return;
    session.pendingAction = pendingAction && typeof pendingAction === "object"
      ? cloneJson(pendingAction)
      : null;
    session.conversationState = deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  expireSession(session, ttlMs) {
    const age = Date.now() - Number(session && session.updatedAt || 0);
    if (age <= Math.max(1000, Number(ttlMs || 2 * 60 * 60 * 1000))) return;
    this.resetSession(session);
  }

  enterCollect(session, pendingAction) {
    if (!session || typeof session !== "object") return;
    if (pendingAction && typeof pendingAction === "object") session.pendingAction = pendingAction;
    session.conversationState = deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  enterExecute(session) {
    if (!session || typeof session !== "object") return;
    session.conversationState = deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  complete(session) {
    if (!session || typeof session !== "object") return;
    session.conversationState = FLOW_STATE.DONE;
    session.pendingAction = null;
    session.updatedAt = Date.now();
    session.conversationState = FLOW_STATE.IDLE;
  }

  rememberCompletion(session, completedAction) {
    if (!session || typeof session !== "object") return;
    session.lastCompletedAction = completedAction && typeof completedAction === "object"
      ? Object.assign({ completedAt: Date.now() }, cloneJson(completedAction))
      : null;
    session.lastSuccessfulAction = session.lastCompletedAction
      ? cloneJson(session.lastCompletedAction)
      : null;
    session.lastActionEntity = session.lastSuccessfulAction
      ? normalizeText(session.lastSuccessfulAction.entity).toLowerCase()
      : "";
    session.lastActionPayload = session.lastSuccessfulAction && session.lastSuccessfulAction.payload
      ? cloneJson(session.lastSuccessfulAction.payload)
      : null;
    session.lastActionReceipt = buildActionReceipt(session.lastSuccessfulAction);
    session.lastReferenceTargets = buildReferenceTargets(session.lastActionReceipt, null);
    session.correctionWindowRemaining = session.lastSuccessfulAction ? 1 : 0;
    session.conversationState = session.lastSuccessfulAction
      ? FLOW_STATE.PENDING_CORRECTION
      : deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  clearCorrectionWindow(session) {
    if (!session || typeof session !== "object") return;
    session.correctionWindowRemaining = 0;
    session.lastSuccessfulAction = null;
    session.lastActionEntity = "";
    session.lastActionPayload = null;
    session.conversationState = deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  completeWithReceipt(session, completedAction) {
    this.complete(session);
    this.rememberCompletion(session, completedAction);
  }

  decidePendingDisposition(session, parsed) {
    const pending = session && session.pendingAction && typeof session.pendingAction === "object"
      ? session.pendingAction
      : null;
    if (!pending) return "none";

    const payload = parsed && typeof parsed === "object" ? parsed : {};
    const userContext = normalizeText(payload.user_context).toLowerCase();
    const referenceMode = normalizeReferenceMode(payload.reference_mode);
    const correctionType = normalizeText(payload.correction_type).toLowerCase();
    const prefersPending = referenceMode === REFERENCE_MODE.PENDING_ACTION;

    if (userContext === "cancel_pending") return "cancel";
    if (userContext === "reset_flow") return "reset";
    if (userContext === "force_execute") return "continue";
    if (referenceMode === REFERENCE_MODE.NEW_REQUEST || referenceMode === REFERENCE_MODE.LAST_QUERY) return "supersede";

    const action = normalizeText(payload.action).toLowerCase();
    const entity = normalizeText(payload.entity).toLowerCase();
    const pendingAction = normalizeText(pending.action).toLowerCase();
    const pendingEntity = normalizeText(pending.entity).toLowerCase();

    if (action === "query" || action === "reminder") return "supersede";
    if (action === "chat") return "continue";
    if (action === "correction") {
      if (correctionType === "full_query_reset") return "reset";
      if (referenceMode === REFERENCE_MODE.LAST_QUERY) return "supersede";
      if (referenceMode === REFERENCE_MODE.PENDING_ACTION) return "continue";
      return hasStructuredContribution(payload) ? "continue" : "supersede";
    }

    if (action && pendingAction && action !== pendingAction) {
      return hasStandalonePayload(payload) ? "supersede" : "continue";
    }

    if (entity && pendingEntity && entity !== pendingEntity) {
      return hasStandalonePayload(payload) ? "supersede" : "continue";
    }

    const incomingAnchor = extractPrimaryAnchor(payload);
    const pendingAnchor = extractPendingAnchor(pending);
    if (incomingAnchor && pendingAnchor && incomingAnchor !== pendingAnchor) {
      return "supersede";
    }

    if (prefersPending) return "continue";
    if (hasStructuredContribution(payload)) return "continue";
    if (hasStandalonePayload(payload)) return "supersede";
    return "continue";
  }

  rememberQuery(session, plan, rows, source, semanticPayload) {
    if (!session || typeof session !== "object") return;
    session.lastQuery = cloneJson(plan);
    session.lastQueryContext = {
      entity: normalizeText(plan && plan.entity).toLowerCase(),
      filters: cloneJson(plan && plan.filters || {}),
      rows_found: Array.isArray(rows) ? rows.length : 0,
      rows_returned: Array.isArray(rows) ? rows.length : 0,
      source: String(source || ""),
      metric: normalizeText(plan && plan.metric).toLowerCase(),
      projection: Array.isArray(plan && plan.projection) ? cloneJson(plan.projection) : [],
      timestamp: Date.now()
    };
    session.lastSemanticPayload = semanticPayload && typeof semanticPayload === "object"
      ? cloneJson(semanticPayload)
      : null;
    session.lastRows = cloneJson(rows || []);
    session.lastSource = String(source || "");
    session.lastReferenceTargets = buildReferenceTargets(null, rows || []);
    session.contextValid = Array.isArray(rows) && rows.length > 0;
    session.lastProjection = Array.isArray(plan && plan.projection)
      ? cloneJson(plan.projection)
      : [];
    session.ambiguityFlag = Array.isArray(rows) && rows.length > 1;
    session.candidateRows = session.ambiguityFlag ? cloneJson(rows || []) : [];
    session.candidateEntity = session.ambiguityFlag ? normalizeText(plan && plan.entity) : "";
    session.invalidQueryContext = false;
    session.invalidQueryReason = "";
    session.correctionWindowRemaining = 0;
    session.lastSuccessfulAction = null;
    session.conversationState = session.ambiguityFlag ? FLOW_STATE.PENDING_QUERY : FLOW_STATE.IDLE;
    session.updatedAt = Date.now();
  }

  clearQueryContext(session) {
    if (!session || typeof session !== "object") return;
    session.lastQuery = null;
    session.lastQueryContext = null;
    session.lastSemanticPayload = null;
    session.lastRows = [];
    session.lastSource = "";
    session.lastReferenceTargets = session.lastActionReceipt ? buildReferenceTargets(session.lastActionReceipt, null) : [];
    session.contextValid = false;
    session.ambiguityFlag = false;
    session.candidateRows = [];
    session.candidateEntity = "";
    session.lastProjection = [];
    session.invalidQueryContext = false;
    session.invalidQueryReason = "";
    session.conversationState = FLOW_STATE.IDLE;
    session.updatedAt = Date.now();
  }

  invalidateQueryContext(session, reason) {
    if (!session || typeof session !== "object") return;
    const previous = session.lastQueryContext && typeof session.lastQueryContext === "object"
      ? cloneJson(session.lastQueryContext)
      : null;
    session.lastQuery = null;
    session.lastQueryContext = previous
      ? Object.assign({}, previous, {
        context_valid: false,
        invalid_reason: normalizeText(reason),
        timestamp: Date.now()
      })
      : {
        entity: "",
        filters: {},
        rows_found: 0,
        rows_returned: 0,
        source: "",
        metric: "",
        projection: [],
        context_valid: false,
        invalid_reason: normalizeText(reason),
        timestamp: Date.now()
      };
    session.lastSemanticPayload = null;
    session.lastRows = [];
    session.lastSource = "";
    session.contextValid = false;
    session.ambiguityFlag = false;
    session.candidateRows = [];
    session.candidateEntity = "";
    session.lastProjection = [];
    session.invalidQueryContext = true;
    session.invalidQueryReason = normalizeText(reason);
    session.conversationState = FLOW_STATE.PENDING_QUERY;
    session.updatedAt = Date.now();
  }

  clearInvalidQueryContext(session) {
    if (!session || typeof session !== "object") return;
    session.invalidQueryContext = false;
    session.invalidQueryReason = "";
    session.contextValid = Boolean(session.lastQuery && Array.isArray(session.lastRows) && session.lastRows.length);
    if (session.lastQueryContext && typeof session.lastQueryContext === "object") {
      session.lastQueryContext.context_valid = session.contextValid;
      session.lastQueryContext.invalid_reason = "";
    }
    session.conversationState = deriveConversationState(session, session.pendingAction);
    session.updatedAt = Date.now();
  }

  rememberFailure(session) {
    if (!session || typeof session !== "object") return;
    session.lastCompletedAction = null;
    session.updatedAt = Date.now();
  }

  rememberUserTurn(session, userText) {
    if (!session || typeof session !== "object") return;
    session.lastUserMessage = normalizeText(userText);
    session.updatedAt = Date.now();
  }

  shouldRepairRepeatedQuestion(session, reply) {
    if (!session || typeof session !== "object") return false;
    const nextReply = normalizeText(reply);
    if (!nextReply || !isQuestionLike(nextReply)) return false;
    const lastReply = normalizeText(session.lastAssistantMessage);
    if (!lastReply) return false;
    const nextKind = classifyAssistantPromptKind(nextReply);
    const lastKind = normalizeText(session.lastAssistantPromptKind);
    if (nextReply === lastReply && Number(session.lastAssistantQuestionCount || 0) >= 1) return true;
    return Boolean(nextKind && lastKind && nextKind === lastKind && Number(session.lastAssistantQuestionCount || 0) >= 1);
  }

  buildRepairReply(session) {
    const state = session && typeof session === "object" ? session : {};
    if (state.lastActionReceipt && Number(state.correctionWindowRemaining || 0) > 0) {
      return "Maaf, saya salah memahami. Saya cek ulang hasil perubahan terakhir lebih dulu.";
    }
    if (state.lastQueryContext && typeof state.lastQueryContext === "object") {
      return "Maaf, saya salah memahami. Saya cek ulang hasil pencarian terakhir agar tidak mengulang klarifikasi yang sama.";
    }
    if (state.pendingAction && Array.isArray(state.pendingAction.missingFields) && state.pendingAction.missingFields.length) {
      return "Maaf, saya salah memahami. Balas iya untuk lanjut, atau isi data yang masih kurang.";
    }
    if (state.pendingAction && Array.isArray(state.pendingAction.candidates) && state.pendingAction.candidates.length > 1) {
      return "Maaf, saya salah memahami. Sebutkan nomor atau label target yang dimaksud agar saya tidak memilih data yang salah.";
    }
    if (state.invalidQueryContext) {
      return "Maaf, saya salah memahami. Context sebelumnya tidak lagi valid. Silakan pilih data kembali.";
    }
    return "Maaf, saya salah memahami. Silakan jelaskan kembali maksud Anda.";
  }

  rememberAssistantReply(session, reply) {
    if (!session || typeof session !== "object") return;
    const nextReply = normalizeText(reply);
    if (!nextReply) return;
    const lastReply = normalizeText(session.lastAssistantMessage);
    const nextKind = classifyAssistantPromptKind(nextReply);
    const lastKind = normalizeText(session.lastAssistantPromptKind);
    if (nextReply === lastReply && isQuestionLike(nextReply)) {
      session.lastAssistantQuestionCount = Number(session.lastAssistantQuestionCount || 0) + 1;
    } else if (nextKind && lastKind && nextKind === lastKind) {
      session.lastAssistantQuestionCount = Number(session.lastAssistantQuestionCount || 0) + 1;
    } else if (isQuestionLike(nextReply)) {
      session.lastAssistantQuestionCount = 1;
    } else {
      session.lastAssistantQuestionCount = 0;
    }
    session.lastAssistantMessage = nextReply;
    session.lastAssistantPromptKind = nextKind;
    session.updatedAt = Date.now();
  }

  getSessionSnapshot(context) {
    const session = this.getSession(context);
    const pending = session.pendingAction && typeof session.pendingAction === "object"
      ? session.pendingAction
      : null;
    return {
      has_last_query: Boolean(session.lastQuery),
      last_query: session.lastQuery || null,
      has_last_query_context: Boolean(session.lastQueryContext),
      last_query_context: session.lastQueryContext || null,
      has_last_reference_targets: Array.isArray(session.lastReferenceTargets) && session.lastReferenceTargets.length > 0,
      last_reference_targets: Array.isArray(session.lastReferenceTargets) ? cloneJson(session.lastReferenceTargets) : [],
      has_last_semantic_payload: Boolean(session.lastSemanticPayload),
      last_semantic_payload: session.lastSemanticPayload || null,
      last_source: String(session.lastSource || ""),
      context_valid: Boolean(session.contextValid),
      last_result_count: Array.isArray(session.lastRows) ? session.lastRows.length : 0,
      has_ambiguous_context: Boolean(session.ambiguityFlag),
      ambiguous_candidate_count: Array.isArray(session.candidateRows) ? session.candidateRows.length : 0,
      ambiguous_entity: String(session.candidateEntity || ""),
      invalid_query_context: Boolean(session.invalidQueryContext),
      invalid_query_reason: String(session.invalidQueryReason || ""),
      conversation_state: String(session.conversationState || FLOW_STATE.IDLE),
      has_pending_action: Boolean(pending),
      pending_action_type: pending ? (String(pending.action || "") + (pending.entity ? ":" + String(pending.entity) : "")) : "",
      pending_missing_fields: pending && Array.isArray(pending.missingFields) ? pending.missingFields.slice() : [],
      pending_candidate_count: pending && Array.isArray(pending.candidates) ? pending.candidates.length : 0,
      pending_selected_no: pending && pending.selectedRow ? normalizeNo(pending.selectedRow.no) : "",
      last_completed_action_type: session.lastCompletedAction
        ? (String(session.lastCompletedAction.action || "") + (session.lastCompletedAction.entity ? ":" + String(session.lastCompletedAction.entity) : ""))
        : "",
      last_completed_at: session.lastCompletedAction ? Number(session.lastCompletedAction.completedAt || 0) : 0,
      last_action_entity: String(session.lastActionEntity || ""),
      last_action_payload: session.lastActionPayload || null,
      last_action_receipt: session.lastActionReceipt || null,
      correction_window_remaining: Number(session.correctionWindowRemaining || 0),
      last_successful_action: session.lastSuccessfulAction || null,
      last_assistant_message: String(session.lastAssistantMessage || ""),
      last_assistant_prompt_kind: String(session.lastAssistantPromptKind || ""),
      repeated_assistant_questions: Number(session.lastAssistantQuestionCount || 0),
      last_user_message: String(session.lastUserMessage || "")
    };
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function buildActionReceipt(completedAction) {
  const action = completedAction && typeof completedAction === "object" ? completedAction : null;
  if (!action) return null;
  const anchors = Array.isArray(action.anchors)
    ? action.anchors.map(normalizeReceiptAnchor).filter(Boolean)
    : [];
  const targets = Array.isArray(action.targets)
    ? action.targets.map(normalizeReceiptTarget).filter(Boolean)
    : [];
  const failures = Array.isArray(action.failures)
    ? action.failures.map(normalizeReceiptFailure).filter(Boolean)
    : [];
  return {
    entity: normalizeText(action.entity).toLowerCase(),
    action: normalizeText(action.action).toLowerCase(),
    targets: targets,
    anchors: anchors,
    expectedTargets: Math.max(0, Number(action.expectedTargets || 0)),
    executedTargets: Math.max(0, Number(action.executedTargets || targets.length || anchors.length || 0)),
    failures: failures,
    timestamp: Number(action.completedAt || Date.now())
  };
}

function buildReferenceTargets(receipt, rows) {
  const anchors = receipt && Array.isArray(receipt.anchors) ? receipt.anchors : [];
  if (anchors.length) {
    return anchors
      .map(normalizeReferenceTarget)
      .filter(Boolean);
  }

  const targets = receipt && Array.isArray(receipt.targets) ? receipt.targets : [];
  if (targets.length) {
    return targets
      .map(normalizeReferenceTarget)
      .filter(Boolean);
  }

  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeReferenceTarget({
      no: row && row.no,
      row_id: row && row.no,
      label: row && (row.nama_motor || row.keterangan || row.text)
    }))
    .filter(Boolean);
}

function normalizeReferenceTarget(value) {
  const current = value && typeof value === "object" ? value : null;
  if (!current) return null;
  const no = normalizeNo(current.no || current.row_id);
  const rowId = normalizeText(current.row_id || no);
  const label = normalizeText(current.label || (current.payload && (current.payload.nama_motor || current.payload.keterangan || current.payload.text)));
  if (!no && !rowId && !label) return null;
  return {
    no: no,
    row_id: rowId,
    label: label
  };
}

function normalizeReceiptAnchor(value) {
  const current = value && typeof value === "object" ? value : null;
  if (!current) return null;
  const no = normalizeNo(current.no || current.row_id);
  const rowId = normalizeText(current.row_id || no);
  const label = normalizeText(current.label);
  if (!no && !rowId && !label) return null;
  return {
    no: no,
    row_id: rowId,
    label: label
  };
}

function normalizeReceiptTarget(value) {
  const current = value && typeof value === "object" ? value : null;
  if (!current) return null;
  const no = normalizeNo(current.no || current.row_id || (current.payload && current.payload.no));
  const rowId = normalizeText(current.row_id || no);
  const payload = current.payload && typeof current.payload === "object" ? cloneJson(current.payload) : null;
  const label = normalizeText(current.label || (payload && (payload.nama_motor || payload.keterangan)));
  if (!no && !rowId && !label && !payload) return null;
  return {
    no: no,
    row_id: rowId,
    label: label,
    payload: payload
  };
}

function normalizeReceiptFailure(value) {
  const current = value && typeof value === "object" ? value : null;
  if (!current) return null;
  const payload = current.payload && typeof current.payload === "object" ? cloneJson(current.payload) : null;
  const target = current.target && typeof current.target === "object" ? cloneJson(current.target) : null;
  const error = normalizeText(current.error);
  if (!payload && !target && !error) return null;
  return {
    index: Math.max(0, Number(current.index || 0)),
    error: error,
    payload: payload,
    target: target
  };
}

function normalizeNo(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^0-9]/g, "");
}

function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeReferenceMode(value) {
  const raw = normalizeText(value).toLowerCase();
  return [ "", "new_request", "pending_action", "last_query" ].indexOf(raw) !== -1 ? raw : "";
}

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.keys(value).every((key) => isEmptyValue(value[key]));
  }
  return false;
}

function hasStructuredContribution(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  return Boolean(
    hasAnyValue(payload.selector)
    || hasAnyValue(payload.filters)
    || hasAnyValue(payload.mutation_payload)
    || hasAnyValue(payload.temporal)
    || hasAnyValue(payload.reference)
    || isMeaningfulSemanticValue(payload.correction_type)
    || isMeaningfulSemanticValue(payload.target_field)
    || isMeaningfulSemanticValue(payload.new_value)
    || isMeaningfulSemanticValue(payload.projection)
    || isMeaningfulSemanticValue(payload.value)
    || isMeaningfulSemanticValue(payload.count)
    || isMeaningfulSemanticValue(payload.confidence)
  );
}

function hasStandalonePayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const action = normalizeText(payload.action).toLowerCase();
  if (!action || action === "chat") return false;
  if (action === "query") return hasStructuredContribution(payload) || normalizeReferenceMode(payload.reference_mode) === REFERENCE_MODE.NEW_REQUEST;
  if (action === "correction") return hasStructuredContribution(payload);
  return hasStructuredContribution(payload) || !isEmptyValue(payload.count);
}

function isExplicitNewRequestPayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const action = normalizeText(payload.action).toLowerCase();
  if (action === "chat" || action === "correction") return false;
  if (action === "create" || action === "update" || action === "delete" || action === "confirm" || action === "reminder") {
    return true;
  }
  if (action !== "query") return false;
  if (hasAnyValue(payload.selector)) return true;
  if (hasAnyValue(payload.filters)) return true;
  if (hasAnyValue(payload.temporal)) return true;
  if (!isEmptyValue(payload.metric)) return true;
  if (!isEmptyValue(payload.availability_state)) return true;
  return false;
}

function isProjectionOnlyFollowupPayload(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  if (normalizeText(payload.action).toLowerCase() !== "query") return false;
  if (!Array.isArray(payload.projection) || payload.projection.length === 0) return false;
  if (hasAnyValue(payload.selector)) return false;
  if (hasAnyValue(payload.filters)) return false;
  if (hasAnyValue(payload.temporal)) return false;
  const metric = normalizeText(payload.metric).toLowerCase();
  if (metric && metric !== "list") return false;
  return true;
}

function isPostExecutionCorrectionCandidate(parsed, session) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const state = session && typeof session === "object" ? session : {};
  const successful = state.lastSuccessfulAction && typeof state.lastSuccessfulAction === "object"
    ? state.lastSuccessfulAction
    : null;
  if (!successful || Number(state.correctionWindowRemaining || 0) <= 0) return false;
  if (state.pendingAction) return false;

  const action = normalizeText(payload.action).toLowerCase();
  if (!action || action === "query" || action === "chat" || action === "reminder") return false;
  if (hasAnyValue(payload.selector)) return false;
  if (hasAnyValue(payload.filters)) return false;
  if (hasAnyValue(payload.temporal)) return false;
  if (Array.isArray(payload.projection) && payload.projection.length) return false;

  const successfulEntity = normalizeText(successful.entity).toLowerCase();
  const currentEntity = normalizeText(payload.entity).toLowerCase();
  if (!entitiesAreCorrectionCompatible(successfulEntity, currentEntity)) return false;

  return hasAnyValue(payload.mutation_payload)
    || isMeaningfulSemanticValue(payload.target_field)
    || isMeaningfulSemanticValue(payload.new_value);
}

function entitiesAreCorrectionCompatible(left, right) {
  const a = normalizeText(left).toLowerCase();
  const b = normalizeText(right).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return (a === "sales" && b === "motor") || (a === "motor" && b === "sales");
}

function hasAnyValue(value) {
  const src = value && typeof value === "object" ? value : {};
  return Object.keys(src).some((key) => isMeaningfulSemanticValue(src[key]));
}

function isMeaningfulSemanticValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return isFinite(value) && value !== 0;
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some((item) => isMeaningfulSemanticValue(item));
  if (typeof value === "object") {
    return Object.keys(value).some((key) => isMeaningfulSemanticValue(value[key]));
  }
  return Boolean(value);
}

function extractPrimaryAnchor(parsed) {
  const payload = parsed && typeof parsed === "object" ? parsed : {};
  const entity = normalizeText(payload.entity).toLowerCase();
  const selector = payload.selector && typeof payload.selector === "object" ? payload.selector : {};
  const data = payload.mutation_payload && typeof payload.mutation_payload === "object" ? payload.mutation_payload : {};
  const filters = payload.filters && typeof payload.filters === "object" ? payload.filters : {};
  const selectorAttrs = selector.attributes && typeof selector.attributes === "object" ? selector.attributes : {};
  const selectorNames = Array.isArray(selector.names) ? selector.names : [];
  const selectorIds = Array.isArray(selector.ids) ? selector.ids : [];

  if (entity === "motor" || entity === "sales") {
    return normalizeText(
      selectorAttrs.no
      || selectorIds[0]
      || filters.nomor_motor
      || data.no
      || selectorAttrs.nama_motor
      || selectorNames[0]
      || filters.nama_motor
      || data.nama_motor
    ).toLowerCase();
  }
  if (entity === "pengeluaran") {
    return normalizeText(data.keterangan || filters.keterangan || payload.value).toLowerCase();
  }
  if (entity === "reminder") {
    return normalizeText(data.text || payload.value).toLowerCase();
  }
  return "";
}

function extractPendingAnchor(pending) {
  const payload = pending && typeof pending === "object" ? pending : {};
  const entity = normalizeText(payload.entity).toLowerCase();
  const data = payload.payload && typeof payload.payload === "object" ? payload.payload : {};
  const selected = payload.selectedRow && typeof payload.selectedRow === "object" ? payload.selectedRow : {};

  if (entity === "motor" || entity === "sales") {
    return normalizeText(selected.no || data.no || selected.nama_motor || data.nama_motor).toLowerCase();
  }
  if (entity === "pengeluaran") {
    return normalizeText(data.keterangan).toLowerCase();
  }
  if (entity === "reminder") {
    return normalizeText(data.text).toLowerCase();
  }
  return "";
}

function deriveConversationState(session, pendingAction) {
  const state = session && typeof session === "object" ? session : {};
  const pending = pendingAction && typeof pendingAction === "object"
    ? pendingAction
    : (state.pendingAction && typeof state.pendingAction === "object" ? state.pendingAction : null);
  if (pending) {
    const action = normalizeText(pending.action).toLowerCase();
    if (action === "query") return FLOW_STATE.PENDING_QUERY;
    if (action === "confirm" || action === "update" || action === "delete") return FLOW_STATE.PENDING_CONFIRM;
    return FLOW_STATE.PENDING_CREATE;
  }
  if (Number(state.correctionWindowRemaining || 0) > 0 && state.lastSuccessfulAction) {
    return FLOW_STATE.PENDING_CORRECTION;
  }
  if (state.invalidQueryContext || state.ambiguityFlag) {
    return FLOW_STATE.PENDING_QUERY;
  }
  return FLOW_STATE.IDLE;
}

function classifyAssistantPromptKind(reply) {
  const text = normalizeText(reply);
  if (!text) return "";
  const upper = text.toUpperCase();
  if (upper.indexOf("AMBIGUITY REQUEST") === 0) return "ambiguity_request";
  if (upper.indexOf("QUERY RESULT") === 0 && /pilih data motor kembali|permintaan datanya belum cukup jelas/i.test(text)) return "query_reset_request";
  if (/^data .*belum lengkap\b/i.test(text)) return "missing_data_request";
  if (/^waktu .*belum jelas\b/i.test(text)) return "reminder_clarification";
  if (/^terdapat beberapa\b/i.test(text) || /pilih nomor/i.test(text)) return "ambiguity_request";
  if (isQuestionLike(text)) return "clarification_request";
  return "";
}

function semanticDomainOfEntity(entity) {
  const raw = normalizeText(entity).toLowerCase();
  if (raw === "motor" || raw === "sales") return "inventory";
  if (raw === "pengeluaran") return "expense";
  if (raw === "reminder") return "reminder";
  if (raw === "global_summary") return "summary";
  return "";
}

function deriveActiveSemanticDomain(session) {
  const state = session && typeof session === "object" ? session : {};
  if (state.pendingAction && typeof state.pendingAction === "object") {
    return semanticDomainOfEntity(state.pendingAction.entity);
  }
  if (state.lastQueryContext && typeof state.lastQueryContext === "object" && normalizeText(state.lastQueryContext.entity)) {
    return semanticDomainOfEntity(state.lastQueryContext.entity);
  }
  if (normalizeText(state.lastActionEntity)) {
    return semanticDomainOfEntity(state.lastActionEntity);
  }
  return "";
}

function shouldResetIrrelevantTopicContext(session, payload, referenceMode) {
  if (referenceMode === REFERENCE_MODE.LAST_QUERY || referenceMode === REFERENCE_MODE.PENDING_ACTION) return false;
  const incoming = semanticDomainOfEntity(payload && payload.entity);
  if (!incoming) return false;
  const active = deriveActiveSemanticDomain(session);
  if (!active) return false;
  return incoming !== active;
}

function clearActionTopicContext(session) {
  if (!session || typeof session !== "object") return;
  session.lastCompletedAction = null;
  session.lastSuccessfulAction = null;
  session.lastActionReceipt = null;
  session.lastActionEntity = "";
  session.lastActionPayload = null;
  session.lastReferenceTargets = [];
  session.correctionWindowRemaining = 0;
}

function isQuestionLike(text) {
  const value = normalizeText(text);
  if (!value) return false;
  return /\?$/.test(value)
    || /^silakan\b/i.test(value)
    || /^data .*belum lengkap\b/i.test(value)
    || /^waktu .*belum jelas\b/i.test(value)
    || /^terdapat beberapa\b/i.test(value);
}

module.exports = ConversationEngine;
module.exports.FLOW_STATE = FLOW_STATE;
