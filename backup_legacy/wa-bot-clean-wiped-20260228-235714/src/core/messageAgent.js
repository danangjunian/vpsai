const { INTENTS, TARGET_SHEETS } = require("../constants/intents");
const MOTOR_T = require("../templates/motorTemplates");
const EXPENSE_T = require("../templates/expenseTemplates");
const { resolveMotorEntity } = require("./entityResolver");
const { normalizeNo, normalizeText, parseNumber, formatIdr } = require("../utils/text");

class MessageAgent {
  constructor(options) {
    const cfg = options || {};
    this.aiBrain = cfg.aiBrain;
    this.dataService = cfg.dataService;
    this.assistantService = cfg.assistantService;
    this.reminderService = cfg.reminderService || null;
    this.confidenceThreshold = Math.max(0, Math.min(1, Number(cfg.confidenceThreshold || 0.75)));
    this.sessionTtlMs = Math.max(60 * 1000, Number(cfg.sessionTtlMs || 30 * 60 * 1000));
    this.stateByPhone = new Map();
    this.dataActionHandlers = {
      view_data: this.handleViewData.bind(this),
      input_data: this.handleInputData.bind(this),
      edit_data: this.handleEditData.bind(this),
      delete_data: this.handleDeleteData.bind(this),
      confirm_sold: this.handleConfirmSold.bind(this)
    };
  }

  async handleIncoming(input) {
    const req = input && typeof input === "object" ? input : {};
    const text = String(req.text === undefined || req.text === null ? "" : req.text)
      .replace(/\r/g, "")
      .trim();
    const userPhone = String(req.userPhone || "").trim();
    if (!text || !userPhone) return "";

    this.cleanupStates();
    const current = this.getState(userPhone);
    const result = await this.handleMessage(text, current, { userPhone, chatPhone: req.chatPhone || userPhone });
    this.stateByPhone.set(userPhone, result.nextState);
    return String(result.reply || "").trim();
  }

  async handleMessage(userMessage, conversationState, meta) {
    const state = cloneState_(conversationState);
    pushHistory_(state, "user", userMessage);

    let plan = await this.aiBrain.planAction(userMessage, state);
    const selectionPlan = buildSelectionFollowUpPlan_(userMessage, state);
    if (selectionPlan && (plan.mode === "assistant" || plan.needs_clarification === true || plan.action === "clarification")) {
      plan = selectionPlan;
    }
    const planNeedsClarification =
      plan.needs_clarification === true ||
      String(plan.action || "").toLowerCase() === "clarification" ||
      Number(plan.confidence || 0) < this.confidenceThreshold;

    if (planNeedsClarification) {
      const followUp = await this.aiBrain.understandFollowUp(userMessage, state);
      const followUpReply = buildFollowUpReply_(followUp, state);
      if (followUpReply) {
        const next = cloneState_(state);
        next.updated_at = Date.now();
        pushHistory_(next, "assistant", followUpReply);
        return { reply: followUpReply, nextState: next };
      }
      const reply = normalizeText(
        plan.clarification_question || "Biar tidak salah proses, bisa jelaskan lagi maksudmu?"
      );
      const next = cloneState_(state);
      next.last_action_status = "clarification";
      next.updated_at = Date.now();
      pushHistory_(next, "assistant", reply);
      return { reply, nextState: next };
    }

    let execution = null;
    let decision = mapPlanToDecision_(plan);
    if (plan.mode === "assistant") {
      execution = await this.handleAssistantPlan(userMessage, plan, state, meta || {});
    } else {
      const handler = this.dataActionHandlers[plan.action];
      if (!handler) {
        execution = {
          reply: "Aksi data belum dikenali. Jelaskan lagi kebutuhan datanya.",
          rows: [],
          status: "clarification"
        };
      } else {
        execution = await handler(userMessage, decision, state, meta || {});
      }
    }
    const resultRows = Array.isArray(execution.rows) ? execution.rows : [];
    const outcome = normalizeExecutionOutcome_(execution);

    let finalReply = String(execution.reply || "").trim();
    if (decision.intent === "view_data" && plan.mode === "data") {
      const checked = await this.aiBrain.selfCheckDataReply({
        userMessage,
        decision,
        rows: resultRows,
        draftReply: finalReply
      });
      if (checked && String(checked.final_reply || "").trim() && checked.approved === false) {
        finalReply = String(checked.final_reply || "").trim();
      }
    }

    const next = cloneState_(state);
    next.last_intent = toIntentToken_(decision.intent);
    next.last_entity = normalizeText(execution.entity || decision.entity || "");
    next.last_result_ids = resultRows.map((r) => normalizeNo(r.no || r.id || r.nomor)).filter(Boolean);
    next.last_result_rows = resultRows;
    next.conversation_mode = plan.mode === "data" ? "data" : "assistant";
    next.last_action_status = outcome.status;
    next.last_error_message = outcome.error_message || "";
    next.last_missing_fields = Array.isArray(outcome.missing_fields) ? outcome.missing_fields.slice() : [];
    next.last_target_sheet = normalizeTargetSheet_(decision.target_sheet);
    next.updated_at = Date.now();
    pushHistory_(next, "assistant", finalReply);

    return { reply: finalReply, nextState: next };
  }

  async handleViewData(userMessage, decision, state) {
    const targetSheet = normalizeTargetSheet_(decision.target_sheet);
    if (targetSheet === TARGET_SHEETS.PENGELUARAN_HARIAN) {
      const res = await this.dataService.getExpenses({});
      if (!this.dataService.isSuccess(res)) {
        const msg = "Gagal membaca data pengeluaran: " + this.dataService.getErrorMessage(res);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      const rows = this.dataService.rows(res);
      const reply = rows.length
        ? rows.map((row) => [
          "NO: " + String(row.no || ""),
          "Tanggal: " + String(row.tanggal || ""),
          "Keterangan: " + String(row.keterangan || ""),
          "Total Pengeluaran: " + String(row.total_pengeluaran || "")
        ].join("\n")).join("\n\n")
        : "Data pengeluaran belum ada.";
      return { reply, rows, status: "success" };
    }

    if (targetSheet === TARGET_SHEETS.TOTAL_ASET) {
      const res = await this.dataService.execute(INTENTS.VIEW_DATA, TARGET_SHEETS.TOTAL_ASET, {});
      if (!this.dataService.isSuccess(res)) {
        const msg = "Gagal membaca data total aset: " + this.dataService.getErrorMessage(res);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      const rows = this.dataService.rows(res);
      const reply = rows.length ? JSON.stringify(rows, null, 2) : "Data total aset belum ada.";
      return { reply, rows, status: "success" };
    }

    const includeSold = decision.include_sold === true;
    const rawScope = normalizeScope_(decision.scope || (decision.parameters && decision.parameters.scope), decision.entity);
    const entity = normalizeEntityForLookup_(decision.entity || "");
    const scope = resolveScopeByContext_(rawScope, userMessage, entity);
    const specificity = normalizeSpecificity_(decision.specificity);
    const requestedFields = normalizeFieldArray_(decision.parameters && decision.parameters.fields);

    let baseRows = [];
    if (scope === "last_result" && Array.isArray(state.last_result_rows) && state.last_result_rows.length) {
      baseRows = state.last_result_rows.slice();
    } else {
      const res = await this.dataService.getMotors({
        includeSold: includeSold,
        soldOnly: includeSold,
        limit: 500
      });
      if (!this.dataService.isSuccess(res)) {
        const msg = "Gagal membaca data motor: " + this.dataService.getErrorMessage(res);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      baseRows = this.dataService.rows(res);
    }

    if (scope === "last_result" && !baseRows.length) {
      const reload = await this.dataService.getMotors({
        includeSold: includeSold,
        soldOnly: includeSold,
        limit: 500
      });
      if (!this.dataService.isSuccess(reload)) {
        const msg = "Gagal membaca data motor: " + this.dataService.getErrorMessage(reload);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      baseRows = this.dataService.rows(reload);
    }

    const cleanedRows = cleanMotorRows_(baseRows);
    const filteredBySold = filterBySold_(cleanedRows, includeSold);

    let selectedRows = filteredBySold;
    const applyEntityFilter = scope !== "all" && entity !== "";
    if (applyEntityFilter) {
      const resolved = resolveMotorEntity(entity, filteredBySold);
      if (resolved.status === "NOT_FOUND") {
        if (!includeSold) {
          const soldRes = await this.dataService.getMotors({ includeSold: true, soldOnly: true, limit: 500 });
          if (this.dataService.isSuccess(soldRes)) {
            const soldRows = cleanMotorRows_(this.dataService.rows(soldRes));
            const soldMatch = resolveMotorEntity(entity, soldRows);
            if (soldMatch.status !== "NOT_FOUND" && soldMatch.matches.length) {
              return {
                reply: "Motor '" + entity + "' ada di data terjual. Kalau mau, bilang: lihat data terjual " + entity + ".",
                rows: [],
                status: "clarification"
              };
            }
          }
        }
        return {
          reply: "Saya belum menemukan data motor '" + entity + "'. Coba tulis nama motor lebih spesifik atau NO motornya.",
          rows: [],
          status: "clarification"
        };
      }
      if (resolved.status === "ONE_FUZZY" || resolved.status === "MULTI_FUZZY") {
        const rows = resolved.matches.map((m) => m.raw || m);
        return {
          reply: [
            "Apakah yang dimaksud salah satu dari ini?",
            MOTOR_T.buildMotorList(rows),
            "Balas dengan nama/no yang benar."
          ].join("\n"),
          rows,
          status: "clarification"
        };
      }
      selectedRows = resolved.matches.map((m) => m.raw || m);
    }

    if (!selectedRows.length) {
      return {
        reply: "Data motor belum ditemukan untuk permintaan ini. Coba sebut nama motor yang ingin dicek.",
        rows: [],
        status: "clarification"
      };
    }

    const reply = renderMotorReply_(selectedRows, specificity, requestedFields);
    return { reply, rows: selectedRows, entity: applyEntityFilter ? entity : "", status: "success" };
  }

  async handleInputData(userMessage, decision) {
    const targetSheet = normalizeTargetSheet_(decision.target_sheet);
    const params = decision.parameters && typeof decision.parameters === "object" ? decision.parameters : {};
    const parsedMotorTemplate = extractMotorInputFromText_(userMessage);
    const parsedExpenseTemplate = extractExpenseInputFromText_(userMessage);

    if (targetSheet === TARGET_SHEETS.PENGELUARAN_HARIAN) {
      const prepared = {
        keterangan: normalizeText(params.keterangan || parsedExpenseTemplate.keterangan || ""),
        total_pengeluaran: parseNumber(
          params.total_pengeluaran !== undefined ? params.total_pengeluaran : parsedExpenseTemplate.total_pengeluaran
        )
      };
      if (!prepared.keterangan || !(prepared.total_pengeluaran > 0)) {
        return {
          reply: [
            "Data pengeluaran belum lengkap.",
            "Mohon lengkapi keterangan dan total pengeluaran.",
            "",
            EXPENSE_T.INPUT_EXPENSE_TEMPLATE
          ].join("\n"),
          rows: [],
          status: "clarification",
          missing_fields: ["keterangan", "total_pengeluaran"]
        };
      }
      const res = await this.dataService.inputExpense(prepared);
      if (!this.dataService.isSuccess(res)) {
        const msg = "Gagal input pengeluaran: " + this.dataService.getErrorMessage(res);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      return { reply: "Pengeluaran berhasil disimpan.", rows: this.dataService.rows(res), status: "success" };
    }

    const prepared = {
      nama_motor: normalizeText(params.nama_motor || params.nama || parsedMotorTemplate.nama_motor || ""),
      tahun: normalizeText(params.tahun || parsedMotorTemplate.tahun || ""),
      plat: normalizeText(params.plat || parsedMotorTemplate.plat || "").toUpperCase(),
      surat_surat: normalizeText(params.surat_surat || params.surat || parsedMotorTemplate.surat_surat || ""),
      tahun_plat: normalizeText(params.tahun_plat || parsedMotorTemplate.tahun_plat || ""),
      pajak: normalizeText(params.pajak || parsedMotorTemplate.pajak || ""),
      harga_jual: parseNumber(params.harga_jual !== undefined ? params.harga_jual : parsedMotorTemplate.harga_jual),
      harga_beli: parseNumber(params.harga_beli !== undefined ? params.harga_beli : parsedMotorTemplate.harga_beli)
    };

    const missing = [];
    const required = ["nama_motor", "tahun", "plat", "surat_surat", "tahun_plat", "pajak", "harga_jual", "harga_beli"];
    for (let i = 0; i < required.length; i++) {
      const k = required[i];
      const v = prepared[k];
      if (v === undefined || v === null || String(v).trim() === "") missing.push(k);
    }
    if (missing.length) {
      return {
        reply: [
          "Data motor belum lengkap.",
          "Field yang masih kosong: " + missing.join(", "),
          "",
          MOTOR_T.INPUT_MOTOR_TEMPLATE
        ].join("\n"),
        rows: [],
        status: "clarification",
        missing_fields: missing
      };
    }

    const res = await this.dataService.inputMotor(prepared);
    if (!this.dataService.isSuccess(res)) {
      const recovered = await this.tryRecoverInputMotor_(prepared);
      if (recovered) {
        return {
          reply: "Data motor berhasil disimpan.",
          rows: [recovered],
          entity: recovered.nama_motor || prepared.nama_motor,
          status: "success"
        };
      }
      const msg = "Gagal input data motor: " + this.dataService.getErrorMessage(res);
      return {
        reply: [
          msg,
          "Saya belum menyimpan data apa pun. Silakan kirim ulang template yang sama, nanti saya proses lagi."
        ].join("\n"),
        rows: [],
        status: "error",
        error_message: msg
      };
    }
    return { reply: "Data motor berhasil disimpan.", rows: this.dataService.rows(res), status: "success" };
  }

  async handleEditData(userMessage, decision) {
    const targetSheet = normalizeTargetSheet_(decision.target_sheet);
    const params = decision.parameters && typeof decision.parameters === "object" ? decision.parameters : {};

    if (targetSheet !== TARGET_SHEETS.STOK_MOTOR) {
      return { reply: "Edit untuk data ini belum didukung.", rows: [], status: "clarification" };
    }

    const prepared = {
      no: normalizeNo(params.no || params.nomor || ""),
      nama_motor: normalizeText(params.nama_motor || ""),
      tahun: normalizeText(params.tahun || ""),
      plat: normalizeText(params.plat || "").toUpperCase(),
      surat_surat: normalizeText(params.surat_surat || params.surat || ""),
      tahun_plat: normalizeText(params.tahun_plat || ""),
      pajak: normalizeText(params.pajak || "")
    };
    const hargaJual = parseNumber(params.harga_jual);
    const hargaBeli = parseNumber(params.harga_beli);
    if (hargaJual !== null) prepared.harga_jual = hargaJual;
    if (hargaBeli !== null) prepared.harga_beli = hargaBeli;

    if (!prepared.no) {
      if (!normalizeText(decision.entity || "")) {
        return { reply: MOTOR_T.EDIT_MOTOR_TEMPLATE, rows: [], status: "clarification" };
      }
      const lookup = await this.dataService.getMotors({ includeSold: true, limit: 500 });
      if (!this.dataService.isSuccess(lookup)) {
        const msg = "Gagal membaca data motor: " + this.dataService.getErrorMessage(lookup);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      const resolved = resolveMotorEntity(normalizeEntityForLookup_(decision.entity), cleanMotorRows_(this.dataService.rows(lookup)));
      if (resolved.status === "NOT_FOUND") {
        return {
          reply: "Data motor '" + decision.entity + "' tidak ditemukan. Coba kirim nama/no motor yang lebih spesifik.",
          rows: [],
          status: "clarification"
        };
      }
      if (resolved.matches.length > 1) {
        const rows = resolved.matches.map((m) => m.raw || m);
        return { reply: MOTOR_T.buildMotorList(rows), rows, status: "clarification" };
      }
      const one = resolved.matches[0].raw || resolved.matches[0];
      return {
        reply: [
          "Silakan diedit",
          "",
          "NO: " + String(one.no || ""),
          "NAMA MOTOR: " + String(one.nama_motor || ""),
          "TAHUN: " + String(one.tahun || ""),
          "PLAT: " + String(one.plat || ""),
          "SURAT-SURAT: " + String(one.surat_surat || ""),
          "TAHUN PLAT: " + String(one.tahun_plat || ""),
          "PAJAK: " + String(one.pajak || ""),
          "HARGA JUAL: " + String(one.harga_jual || ""),
          "HARGA BELI: " + String(one.harga_beli || "")
        ].join("\n"),
        rows: [one],
        status: "clarification"
      };
    }

    if (!hasEditableFields_(prepared)) {
      return { reply: MOTOR_T.EDIT_MOTOR_TEMPLATE, rows: [], status: "clarification" };
    }

    const res = await this.dataService.editMotor(prepared);
    if (!this.dataService.isSuccess(res)) {
      const msg = "Gagal edit data motor: " + this.dataService.getErrorMessage(res);
      return { reply: msg, rows: [], status: "error", error_message: msg };
    }
    return { reply: "Data motor berhasil diedit.", rows: this.dataService.rows(res), status: "success" };
  }

  async handleDeleteData(userMessage, decision) {
    const targetSheet = normalizeTargetSheet_(decision.target_sheet);
    const params = decision.parameters && typeof decision.parameters === "object" ? decision.parameters : {};
    const no = normalizeNo(params.no || params.nomor || "");
    if (!no) return { reply: "Sebutkan NO data yang akan dihapus.", rows: [], status: "clarification" };

    if (targetSheet === TARGET_SHEETS.PENGELUARAN_HARIAN) {
      const res = await this.dataService.deleteExpense(no);
      if (!this.dataService.isSuccess(res)) {
        const msg = "Gagal hapus data pengeluaran: " + this.dataService.getErrorMessage(res);
        return { reply: msg, rows: [], status: "error", error_message: msg };
      }
      return { reply: "Data pengeluaran berhasil dihapus.", rows: this.dataService.rows(res), status: "success" };
    }

    const res = await this.dataService.deleteMotor(no);
    if (!this.dataService.isSuccess(res)) {
      const msg = "Gagal hapus data motor: " + this.dataService.getErrorMessage(res);
      return { reply: msg, rows: [], status: "error", error_message: msg };
    }
    return { reply: "Data motor berhasil dihapus.", rows: this.dataService.rows(res), status: "success" };
  }

  async handleConfirmSold(userMessage, decision) {
    const params = decision.parameters && typeof decision.parameters === "object" ? decision.parameters : {};
    let no = normalizeNo(params.no || params.nomor || "");
    const hargaLaku = parseNumber(params.harga_laku || params.harga || params.laku);

    const lookup = await this.dataService.getMotors({ includeSold: false, soldOnly: false, limit: 500 });
    if (!this.dataService.isSuccess(lookup)) {
      const msg = "Gagal membaca data motor: " + this.dataService.getErrorMessage(lookup);
      return { reply: msg, rows: [], status: "error", error_message: msg };
    }
    const rows = cleanMotorRows_(this.dataService.rows(lookup));

    let selected = null;
    if (no) {
      selected = rows.find((r) => normalizeNo(r.no || r.id || r.nomor) === no) || null;
    } else if (normalizeText(decision.entity || "")) {
      const resolved = resolveMotorEntity(normalizeEntityForLookup_(decision.entity), rows);
      if (resolved.status === "NOT_FOUND") {
        return {
          reply: "Saya belum menemukan motor yang dimaksud. Sebutkan nama motor atau NO yang tepat.",
          rows: [],
          status: "clarification"
        };
      }
      if (resolved.matches.length > 1) {
        const many = resolved.matches.map((m) => m.raw || m);
        return { reply: MOTOR_T.buildMotorList(many), rows: many, status: "clarification" };
      }
      selected = resolved.matches[0].raw || resolved.matches[0];
      no = normalizeNo(selected.no || "");
    } else {
      return {
        reply: "Motor apa yang telah terjual? Sebutkan nama motor atau NO agar saya konfirmasi.",
        rows: [],
        status: "clarification"
      };
    }

    if (!selected) {
      return {
        reply: "Data motor tidak ditemukan. Sebutkan nama/no motor yang mau dikonfirmasi.",
        rows: [],
        status: "clarification"
      };
    }

    if (!(typeof hargaLaku === "number" && isFinite(hargaLaku) && hargaLaku > 0)) {
      return {
        reply: MOTOR_T.buildConfirmSoldPrefill(selected),
        rows: [selected],
        entity: selected.nama_motor || "",
        status: "clarification",
        missing_fields: ["harga_laku"]
      };
    }

    const res = await this.dataService.confirmMotorSold(no, hargaLaku);
    if (!this.dataService.isSuccess(res)) {
      const msg = "Gagal konfirmasi motor terjual: " + this.dataService.getErrorMessage(res);
      return { reply: msg, rows: [], status: "error", error_message: msg };
    }

    return {
      reply: [
        "Konfirmasi motor terjual berhasil.",
        "NO: " + no,
        "Harga Laku: " + formatIdr(hargaLaku)
      ].join("\n"),
      rows: this.dataService.rows(res),
      entity: selected.nama_motor || "",
      status: "success"
    };
  }

  async handleAssistantPlan(userMessage, plan, state, meta) {
    const action = String(plan && plan.action || "").toLowerCase();
    const params = plan && plan.parameters && typeof plan.parameters === "object" ? plan.parameters : {};
    const reminderService = this.reminderService || (this.assistantService && this.assistantService.reminderService);
    const userPhone = String(meta && meta.userPhone || "").trim();

    if (action === "create_reminder" && reminderService) {
      const dueAt = normalizeText(params.due_at_iso || params.due_at || "");
      const task = normalizeText(params.task || params.text || plan.assistant_reply || userMessage);
      if (!dueAt || !task) {
        return {
          reply: "Waktu atau isi reminder belum jelas. Sebutkan task dan waktu reminder yang kamu mau.",
          rows: [],
          status: "clarification"
        };
      }
      const row = reminderService.addReminder(userPhone, task, dueAt);
      if (!row) {
        return {
          reply: "Reminder gagal dibuat. Coba kirim format waktu yang lebih jelas.",
          rows: [],
          status: "error",
          error_message: "create_reminder_failed"
        };
      }
      return {
        reply: [
          "Siap, reminder sudah dibuat.",
          "Task: " + String(row.text || ""),
          "Waktu: " + String(row.dueAt || "")
        ].join("\n"),
        rows: [],
        status: "success"
      };
    }

    if (action === "list_reminder" && reminderService) {
      const rows = reminderService.listReminders(userPhone);
      if (!rows.length) {
        return { reply: "Belum ada reminder aktif.", rows: [], status: "success" };
      }
      const lines = ["Reminder aktif:"];
      for (let i = 0; i < rows.length; i++) {
        lines.push((i + 1) + ". " + String(rows[i].text || "") + " | " + String(rows[i].dueAt || ""));
      }
      return { reply: lines.join("\n"), rows: [], status: "success" };
    }

    if (action === "delete_reminder" && reminderService) {
      const index = Number(params.reminder_index || params.index || 0);
      const ok = reminderService.deleteReminderByIndex(userPhone, index);
      return {
        reply: ok ? "Reminder berhasil dihapus." : "Nomor reminder tidak valid.",
        rows: [],
        status: ok ? "success" : "clarification"
      };
    }

    if (normalizeText(plan.assistant_reply || "")) {
      return { reply: String(plan.assistant_reply || "").trim(), rows: [], status: "success" };
    }

    if (this.assistantService && typeof this.assistantService.handle === "function") {
      const assistant = await this.assistantService.handle({
        text: userMessage,
        userPhone: userPhone,
        context: {
          last_intent: state.last_intent || "",
          last_entity: state.last_entity || "",
          last_result_ids: Array.isArray(state.last_result_ids) ? state.last_result_ids : [],
          plan: plan
        }
      });
      return { reply: String(assistant.reply || "Siap.").trim(), rows: [], status: "success" };
    }

    return { reply: "Siap.", rows: [], status: "success" };
  }

  async tryRecoverInputMotor_(prepared) {
    const p = prepared && typeof prepared === "object" ? prepared : {};
    const nama = normalizeText(p.nama_motor || "");
    if (!nama) return null;

    const lookup = await this.dataService.getMotors({
      includeSold: true,
      limit: 200,
      keyword: nama
    });
    if (!this.dataService.isSuccess(lookup)) return null;

    const rows = cleanMotorRows_(this.dataService.rows(lookup));
    if (!rows.length) return null;

    const tahun = normalizeText(p.tahun || "");
    const plat = normalizePlateKey_(p.plat || "");
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNama = normalizeText(row.nama_motor || "");
      const rowTahun = normalizeText(row.tahun || "");
      const rowPlat = normalizePlateKey_(row.plat || "");
      if (rowNama !== nama) continue;
      if (tahun && rowTahun && rowTahun !== tahun) continue;
      if (plat && rowPlat && rowPlat !== plat) continue;
      return row;
    }

    return null;
  }

  getState(userPhone) {
    const current = this.stateByPhone.get(userPhone);
    if (!current) return newState_();
    return cloneState_(current);
  }

  cleanupStates() {
    const now = Date.now();
    const entries = Array.from(this.stateByPhone.entries());
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i][0];
      const state = entries[i][1];
      const ts = Number(state && state.updated_at ? state.updated_at : 0);
      if (!ts || now - ts > this.sessionTtlMs) {
        this.stateByPhone.delete(key);
      }
    }
  }
}

function isDataIntent_(intent) {
  return [
    "view_data",
    "input_data",
    "edit_data",
    "delete_data",
    "confirm_sold"
  ].includes(String(intent || "").toLowerCase());
}

function toIntentToken_(intent) {
  const token = String(intent || "").toLowerCase();
  if (token === "view_data") return INTENTS.VIEW_DATA;
  if (token === "input_data") return INTENTS.INPUT_DATA;
  if (token === "edit_data") return INTENTS.EDIT_DATA;
  if (token === "delete_data") return INTENTS.DELETE_DATA;
  if (token === "confirm_sold") return INTENTS.CONFIRM_SOLD;
  return INTENTS.ASSISTANT;
}

function normalizeTargetSheet_(value) {
  const token = String(value || "").trim().toUpperCase();
  if (token === TARGET_SHEETS.PENGELUARAN_HARIAN) return TARGET_SHEETS.PENGELUARAN_HARIAN;
  if (token === TARGET_SHEETS.TOTAL_ASET) return TARGET_SHEETS.TOTAL_ASET;
  return TARGET_SHEETS.STOK_MOTOR;
}

function normalizeScope_(scopeValue, entity) {
  const scope = String(scopeValue || "").trim().toLowerCase();
  if (scope === "last_result" || scope === "single" || scope === "all") return scope;
  return normalizeText(entity || "") ? "single" : "all";
}

function resolveScopeByContext_(scope, userMessage, entity) {
  if (scope !== "last_result") return scope;
  return entity ? "single" : "all";
}

function normalizeSpecificity_(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "specific_field" || token === "confirmation_only") return token;
  return "full";
}

function normalizeFieldArray_(input) {
  const arr = Array.isArray(input) ? input : [];
  return arr.map((x) => normalizeText(x)).filter(Boolean);
}

function mapPlanToDecision_(plan) {
  const p = plan && typeof plan === "object" ? plan : {};
  const action = String(p.action || "").toLowerCase();
  const tokenToIntent = {
    view_data: "view_data",
    input_data: "input_data",
    edit_data: "edit_data",
    delete_data: "delete_data",
    confirm_sold: "confirm_sold"
  };
  const parameters = p.parameters && typeof p.parameters === "object" ? { ...p.parameters } : {};
  if (Array.isArray(p.fields) && p.fields.length) parameters.fields = p.fields.slice();
  return {
    intent: tokenToIntent[action] || "assistant_mode",
    target_sheet: normalizeTargetSheet_(p.target_sheet || TARGET_SHEETS.STOK_MOTOR),
    entity: normalizeText(p.entity || ""),
    scope: normalizeScope_(p.scope, p.entity),
    specificity: String(p.detail_level || "").toLowerCase() === "specific_field" ? "specific_field" : "full",
    include_sold: p.include_sold === true,
    confidence: Number(p.confidence || 0.8),
    parameters
  };
}

function buildSelectionFollowUpPlan_(userMessage, state) {
  const rawNo = normalizeNo(userMessage || "");
  if (!rawNo) return null;

  const current = state && typeof state === "object" ? state : {};
  const lastStatus = String(current.last_action_status || "").toLowerCase();
  const lastIntent = String(current.last_intent || "").toUpperCase();
  const rows = Array.isArray(current.last_result_rows) ? current.last_result_rows : [];
  if (lastStatus !== "clarification" || !rows.length) return null;

  const match = rows.find((r) => normalizeNo(r && (r.no || r.id || r.nomor)) === rawNo);
  if (!match) return null;

  if (lastIntent === INTENTS.CONFIRM_SOLD) {
    return {
      mode: "data",
      action: "confirm_sold",
      target_sheet: TARGET_SHEETS.STOK_MOTOR,
      entity: normalizeText(match.nama_motor || ""),
      scope: "single",
      parameters: { no: rawNo },
      detail_level: "full",
      fields: [],
      include_sold: false,
      needs_clarification: false,
      clarification_question: "",
      assistant_reply: "",
      confidence: 0.95
    };
  }

  if (lastIntent === INTENTS.EDIT_DATA) {
    return {
      mode: "data",
      action: "edit_data",
      target_sheet: TARGET_SHEETS.STOK_MOTOR,
      entity: normalizeText(match.nama_motor || ""),
      scope: "single",
      parameters: { no: rawNo },
      detail_level: "full",
      fields: [],
      include_sold: true,
      needs_clarification: false,
      clarification_question: "",
      assistant_reply: "",
      confidence: 0.9
    };
  }

  return null;
}

function hasEditableFields_(obj) {
  const keys = ["nama_motor", "tahun", "plat", "surat_surat", "tahun_plat", "pajak", "harga_jual", "harga_beli"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const val = obj[key];
    if (val !== undefined && val !== null && String(val).trim() !== "") return true;
  }
  return false;
}

function isSoldRow_(row) {
  const r = row && typeof row === "object" ? row : {};
  const status = normalizeText(r.status || "").toLowerCase();
  if (status === "terjual" || status === "laku" || status === "sold" || status === "true" || status === "1") return true;
  const hargaLaku = parseNumber(r.harga_laku);
  if (typeof hargaLaku === "number" && isFinite(hargaLaku) && hargaLaku > 0) return true;
  return normalizeText(r.tgl_terjual || "") !== "";
}

function filterBySold_(rows, includeSold) {
  const list = Array.isArray(rows) ? rows : [];
  if (includeSold) return list.filter((row) => isSoldRow_(row));
  return list.filter((row) => !isSoldRow_(row));
}

function cleanMotorRows_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const row = list[i] && typeof list[i] === "object" ? list[i] : {};
    const no = normalizeNo(row.no || row.id || row.nomor);
    if (!no || seen.has(no)) continue;
    if (!hasMeaningfulMotorData_(row)) continue;
    seen.add(no);
    out.push(row);
  }

  return out;
}

function hasMeaningfulMotorData_(row) {
  const r = row && typeof row === "object" ? row : {};
  if (normalizeText(r.nama_motor || "")) return true;
  if (normalizeText(r.tahun || "")) return true;
  if (normalizeText(r.plat || "")) return true;
  if (normalizeText(r.surat_surat || "")) return true;
  if (parseNumber(r.harga_jual) !== null) return true;
  if (parseNumber(r.harga_beli) !== null) return true;
  if (parseNumber(r.harga_laku) !== null) return true;
  return false;
}

function normalizeEntityForLookup_(value) {
  return normalizeText(value || "");
}

function normalizePlateKey_(value) {
  return String(value === undefined || value === null ? "" : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function extractMotorInputFromText_(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};

  const labels = {
    nama_motor: /^NAMA\s*MOTOR\s*:\s*(.*)$/i,
    tahun: /^TAHUN\s*:\s*(.*)$/i,
    plat: /^PLAT\s*:\s*(.*)$/i,
    surat_surat: /^SURAT[\s\-]*SURAT\s*:\s*(.*)$/i,
    tahun_plat: /^TAHUN\s*PLAT\s*:\s*(.*)$/i,
    pajak: /^PAJAK\s*:\s*(.*)$/i,
    harga_jual: /^HARGA\s*JUAL\s*:\s*(.*)$/i,
    harga_beli: /^HARGA\s*BELI\s*:\s*(.*)$/i
  };

  const out = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = "";

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;

    let foundKey = "";
    let foundValue = "";

    const keys = Object.keys(labels);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const m = line.match(labels[key]);
      if (m) {
        foundKey = key;
        foundValue = String(m[1] || "").trim();
        break;
      }
    }

    if (foundKey) {
      currentKey = foundKey;
      if (foundValue) {
        out[currentKey] = appendFieldValue_(out[currentKey], foundValue);
      } else if (!out[currentKey]) {
        out[currentKey] = "";
      }
      continue;
    }

    if (!currentKey) continue;
    if (/^[-•\u2022]/.test(line)) {
      out[currentKey] = appendFieldValue_(out[currentKey], line.replace(/^[-•\u2022]\s*/, "").trim());
      continue;
    }
    out[currentKey] = appendFieldValue_(out[currentKey], line);
  }

  if (out.surat_surat) {
    out.surat_surat = normalizeSuratOption_(out.surat_surat);
  }

  const inline = extractMotorInputInline_(raw);
  const keys = Object.keys(inline);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!normalizeText(out[key] || "")) out[key] = inline[key];
  }

  return out;
}

function extractMotorInputInline_(rawText) {
  const raw = String(rawText || "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return {};

  const labels = [
    { key: "nama_motor", token: "NAMA\\s*MOTOR" },
    { key: "tahun", token: "TAHUN" },
    { key: "plat", token: "PLAT" },
    { key: "surat_surat", token: "SURAT[\\s\\-]*SURAT" },
    { key: "tahun_plat", token: "TAHUN\\s*PLAT" },
    { key: "pajak", token: "PAJAK" },
    { key: "harga_jual", token: "HARGA\\s*JUAL" },
    { key: "harga_beli", token: "HARGA\\s*BELI" }
  ];

  const out = {};
  for (let i = 0; i < labels.length; i++) {
    const current = labels[i];
    const next = [];
    for (let j = 0; j < labels.length; j++) {
      if (j === i) continue;
      next.push(labels[j].token + "\\s*:");
    }

    const pattern = new RegExp(current.token + "\\s*:\\s*(.*?)(?=(?:" + next.join("|") + ")|$)", "i");
    const m = raw.match(pattern);
    if (!m) continue;
    const value = normalizeText(m[1] || "");
    if (!value) continue;
    out[current.key] = value;
  }

  if (out.surat_surat) {
    out.surat_surat = normalizeSuratOption_(out.surat_surat);
  }
  return out;
}

function extractExpenseInputFromText_(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  const lines = raw.split(/\r?\n/);
  const out = {};

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;
    const ket = line.match(/^(?:1[\.\)]\s*)?(?:keterangan|catatan|deskripsi)\s*:\s*(.*)$/i);
    if (ket) {
      out.keterangan = String(ket[1] || "").trim();
      continue;
    }
    const total = line.match(/^(?:2[\.\)]\s*)?(?:total\s*pengeluaran|nominal|jumlah|biaya|total)\s*:\s*(.*)$/i);
    if (total) {
      out.total_pengeluaran = String(total[1] || "").trim();
    }
  }

  return out;
}

function appendFieldValue_(current, value) {
  const a = normalizeText(current || "");
  const b = normalizeText(value || "");
  if (!b) return a;
  if (!a) return b;
  return a + " - " + b;
}

function normalizeSuratOption_(value) {
  const raw = String(value || "");
  if (!raw) return "";

  const candidates = [
    { label: "Lengkap hidup", re: /lengkap\s*hidup/i },
    { label: "Lengkap mati", re: /lengkap\s*mati/i },
    { label: "BPKB ONLY", re: /bpkb\s*only/i }
  ];

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const m = raw.match(candidates[i].re);
    if (!m || typeof m.index !== "number") continue;
    if (!best || m.index < best.index) {
      best = { index: m.index, label: candidates[i].label };
    }
  }

  return best ? best.label : normalizeText(raw);
}

function renderMotorReply_(rows, specificity, requestedFields) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "Data motor tidak ditemukan.";

  if (specificity === "specific_field" && requestedFields.length) {
    return list.map((row) => {
      const lines = [];
      for (let i = 0; i < requestedFields.length; i++) {
        const key = requestedFields[i];
        if (!key) continue;
        const value = key.indexOf("harga") !== -1 ? formatIdr(row[key] || "") : String(row[key] || "");
        lines.push(key + ": " + value);
      }
      return lines.join("\n");
    }).join("\n\n");
  }

  return list.map((row) => MOTOR_T.buildMotorDetail(row)).join("\n\n");
}

function normalizeExecutionOutcome_(execution) {
  const src = execution && typeof execution === "object" ? execution : {};
  const token = String(src.status || "").trim().toLowerCase();
  const status = token === "error" || token === "clarification" || token === "success"
    ? token
    : "success";
  return {
    status,
    error_message: normalizeText(src.error_message || ""),
    missing_fields: Array.isArray(src.missing_fields) ? src.missing_fields.map((x) => normalizeText(x)).filter(Boolean) : []
  };
}

function buildFollowUpReply_(followUp, state) {
  const f = followUp && typeof followUp === "object" ? followUp : {};
  const type = String(f.type || "none").trim().toLowerCase();
  const confidence = Number(f.confidence || 0);
  if (!type || type === "none" || !isFinite(confidence) || confidence < 0.82) return "";

  const actionStatus = String(state && state.last_action_status ? state.last_action_status : "").toLowerCase();
  const lastIntent = String(state && state.last_intent ? state.last_intent : "").toUpperCase();
  const targetSheet = normalizeTargetSheet_(state && state.last_target_sheet ? state.last_target_sheet : "");
  const lastError = normalizeText(state && state.last_error_message ? state.last_error_message : "");
  const missing = Array.isArray(state && state.last_missing_fields ? state.last_missing_fields : [])
    ? state.last_missing_fields.filter(Boolean)
    : [];

  if (type === "ask_last_error_reason" && actionStatus === "error" && lastError) {
    return [
      "Proses sebelumnya gagal saat eksekusi data.",
      "Detail error: " + lastError,
      "Kalau mau, kirim ulang instruksi terakhir dan saya proses lagi."
    ].join("\n");
  }

  if (type === "ask_last_action_status" && actionStatus) {
    if (actionStatus === "success") {
      if (lastIntent === INTENTS.INPUT_DATA) return "Proses input data terakhir sudah berhasil disimpan.";
      if (lastIntent === INTENTS.EDIT_DATA) return "Proses edit data terakhir sudah berhasil.";
      if (lastIntent === INTENTS.CONFIRM_SOLD) return "Konfirmasi motor terjual terakhir sudah berhasil.";
      if (lastIntent === INTENTS.DELETE_DATA) return "Proses hapus data terakhir sudah berhasil.";
      if (lastIntent === INTENTS.VIEW_DATA) return "Permintaan lihat data terakhir sudah berhasil ditampilkan.";
      return "Proses terakhir sudah berhasil.";
    }
    if (actionStatus === "error") {
      return [
        "Proses terakhir belum berhasil.",
        lastError ? ("Detail error: " + lastError) : "Ada kendala saat eksekusi data."
      ].join("\n");
    }
    if (actionStatus === "clarification") {
      if (missing.length) {
        return "Proses terakhir belum dijalankan karena data belum lengkap: " + missing.join(", ") + ".";
      }
      return "Proses terakhir belum dijalankan karena masih perlu klarifikasi data.";
    }
  }

  if (type === "request_retry_last_action") {
    if (lastIntent === INTENTS.INPUT_DATA) {
      if (targetSheet === TARGET_SHEETS.PENGELUARAN_HARIAN) return EXPENSE_T.INPUT_EXPENSE_TEMPLATE;
      return MOTOR_T.INPUT_MOTOR_TEMPLATE;
    }
    if (lastIntent === INTENTS.EDIT_DATA) return MOTOR_T.EDIT_MOTOR_TEMPLATE;
    if (lastIntent === INTENTS.CONFIRM_SOLD) return MOTOR_T.CONFIRM_SOLD_TEMPLATE;
  }

  return "";
}

function newState_() {
  return {
    last_intent: "",
    last_entity: "",
    last_result_ids: [],
    last_result_rows: [],
    last_action_status: "",
    last_error_message: "",
    last_target_sheet: TARGET_SHEETS.STOK_MOTOR,
    last_missing_fields: [],
    conversation_mode: "assistant",
    history: [],
    updated_at: Date.now()
  };
}

function cloneState_(state) {
  const s = state && typeof state === "object" ? state : newState_();
  return {
    last_intent: String(s.last_intent || ""),
    last_entity: String(s.last_entity || ""),
    last_result_ids: Array.isArray(s.last_result_ids) ? s.last_result_ids.slice() : [],
    last_result_rows: Array.isArray(s.last_result_rows) ? s.last_result_rows.slice() : [],
    last_action_status: String(s.last_action_status || ""),
    last_error_message: String(s.last_error_message || ""),
    last_target_sheet: normalizeTargetSheet_(s.last_target_sheet || TARGET_SHEETS.STOK_MOTOR),
    last_missing_fields: Array.isArray(s.last_missing_fields) ? s.last_missing_fields.slice() : [],
    conversation_mode: String(s.conversation_mode || "assistant"),
    history: Array.isArray(s.history) ? s.history.slice() : [],
    updated_at: Number(s.updated_at || Date.now())
  };
}

function pushHistory_(state, role, text) {
  if (!state || typeof state !== "object") return;
  const item = {
    role: String(role || ""),
    text: normalizeText(text || ""),
    at: new Date().toISOString()
  };
  const history = Array.isArray(state.history) ? state.history : [];
  history.push(item);
  state.history = history.slice(-12);
}

module.exports = MessageAgent;
