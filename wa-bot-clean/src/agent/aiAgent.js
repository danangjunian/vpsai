const axios = require("axios");
const { error, warn, info } = require("../utils/logger");

const PARSER_ACTIONS = ["query", "create", "update", "delete", "confirm", "reminder", "chat", "correction"];
const PARSER_ENTITIES = ["motor", "sales", "pengeluaran", "global_summary", "reminder", "general"];
const PARSER_METRICS = ["", "list", "count", "sum", "profit", "revenue"];
const PARSER_AVAILABILITY_STATES = ["", "available", "sold", "all"];
const PARSER_USER_CONTEXTS = ["", "force_execute", "cancel_pending", "reset_flow"];
const PARSER_REFERENCE_MODES = ["", "new_request", "pending_action", "last_query"];
const PARSER_CORRECTION_TYPES = ["", "selector_refinement", "selector_replacement", "payload_adjustment", "full_query_reset"];

class AIAgent {
  constructor(options) {
    const cfg = options || {};
    this.apiKey = String(cfg.apiKey || "").trim();
    this.model = String(cfg.model || "gpt-4o-mini").trim() || "gpt-4o-mini";
    this.baseUrl = String(cfg.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(30000, Number(cfg.timeoutMs || 20000));
    this.timezone = String(cfg.timezone || "Asia/Jakarta").trim() || "Asia/Jakarta";
    this.transcriptionModel = String(cfg.transcriptionModel || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe";
    this.resolver = cfg.resolver;
    this.histories = new Map();
    this.maxHistoryMessages = Math.max(8, Number(cfg.maxHistoryMessages || 24));
  }

  isReady() {
    return Boolean(this.apiKey);
  }

  async handleMessage(input) {
    const payload = input && typeof input === "object" ? input : {};
    const userPhone = String(payload.userPhone || "").trim() || "unknown";
    const baseContext = {
      userPhone: userPhone,
      chatPhone: String(payload.chatPhone || "").trim()
    };

    if (!this.isReady()) return "OpenAI API key belum diatur.";
    if (!this.resolver || typeof this.resolver.resolve !== "function") {
      return "Resolver belum siap di VPS.";
    }

    const initialSessionSnapshot = this.resolver.getSessionSnapshot
      ? this.resolver.getSessionSnapshot(baseContext)
      : {};
    const prepared = await this.prepareUserTurn(payload, initialSessionSnapshot);
    if (prepared.directReply) {
      this.pushHistory(userPhone, { role: "assistant", content: String(prepared.directReply) });
      return String(prepared.directReply);
    }
    if (!prepared.hasUsableInput) return "";

    const context = {
      userPhone: userPhone,
      chatPhone: String(payload.chatPhone || "").trim(),
      userText: prepared.plainText,
      hasImage: prepared.hasImage,
      hasAudio: prepared.hasAudio,
      mediaError: prepared.mediaError,
      inputKind: prepared.inputKind
    };
    const liveSession = this.resolver.getSession ? this.resolver.getSession(context) : null;
    if (liveSession && this.resolver.conversation && typeof this.resolver.conversation.rememberUserTurn === "function") {
      this.resolver.conversation.rememberUserTurn(liveSession, prepared.plainText);
    }

    const sessionSnapshot = this.resolver.getSessionSnapshot
      ? this.resolver.getSessionSnapshot(context)
      : {};

    const recentHistory = this.getHistory(userPhone).slice(-8);
    let parsed = prepared.semanticPayload
      ? normalizeSemanticPayload_(prepared.semanticPayload, {
        seedText: prepared.plainText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      })
      : await this.parseSemanticQuery(prepared.openaiContent, context, sessionSnapshot, recentHistory, {
        messageType: prepared.messageType
      });
    parsed = enrichSemanticPayloadWithPreparedData_(parsed, prepared, sessionSnapshot, this.timezone);
    const apologyNeeded = Boolean(prepared.prefaceApology || Number(parsed && parsed.confidence || 0) < 0.65);
    info("semantic_parsed", { user: userPhone, parsed: parsed });

    const lowConfidenceMutationReply = buildLowConfidenceMutationReply_(parsed);
    if (lowConfidenceMutationReply) {
      if (liveSession && this.resolver.conversation && typeof this.resolver.conversation.rememberAssistantReply === "function") {
        this.resolver.conversation.rememberAssistantReply(liveSession, lowConfidenceMutationReply);
      }
      this.pushHistory(userPhone, { role: "user", content: historyUserLabel_(prepared) });
      this.pushHistory(userPhone, { role: "assistant", content: lowConfidenceMutationReply });
      return lowConfidenceMutationReply;
    }

    const pendingBootstrap = buildPendingBootstrap_(parsed);
    if (pendingBootstrap && liveSession && this.resolver.conversation) {
      this.resolver.conversation.enterCollect(liveSession, pendingBootstrap.pendingAction);
      if (typeof this.resolver.conversation.rememberAssistantReply === "function") {
        this.resolver.conversation.rememberAssistantReply(liveSession, pendingBootstrap.reply);
      }
      this.pushHistory(userPhone, { role: "user", content: historyUserLabel_(prepared) });
      this.pushHistory(userPhone, { role: "assistant", content: pendingBootstrap.reply });
      return pendingBootstrap.reply;
    }

    const resolved = await this.resolver.resolve(parsed, context);
    if (resolved && resolved.handled) {
      let reply = String(resolved.reply || "");
      if (apologyNeeded && reply && !/^maaf[, ]/i.test(reply)) {
        reply = "Maaf, saya salah memahami.\n" + reply;
      }
      if (liveSession && this.resolver.conversation && typeof this.resolver.conversation.shouldRepairRepeatedQuestion === "function") {
        if (this.resolver.conversation.shouldRepairRepeatedQuestion(liveSession, reply)) {
          reply = this.resolver.conversation.buildRepairReply(liveSession);
        }
        if (typeof this.resolver.conversation.rememberAssistantReply === "function") {
          this.resolver.conversation.rememberAssistantReply(liveSession, reply);
        }
      }
      this.pushHistory(userPhone, { role: "user", content: historyUserLabel_(prepared) });
      this.pushHistory(userPhone, { role: "assistant", content: reply });
      return reply.trim();
    }

    const chatReply = await this.generateGeneralChatReply(userPhone, prepared.openaiContent, sessionSnapshot, recentHistory);
    if (liveSession && this.resolver.conversation && typeof this.resolver.conversation.rememberAssistantReply === "function") {
      this.resolver.conversation.rememberAssistantReply(liveSession, chatReply);
    }
    this.pushHistory(userPhone, { role: "user", content: historyUserLabel_(prepared) });
    this.pushHistory(userPhone, { role: "assistant", content: chatReply });
    return chatReply;
  }

  async parseSemanticQuery(userContent, context, sessionSnapshot, recentHistory, turnHints) {
    const seedText = extractSeedText_(userContent);
    const isolatedSessionText = JSON.stringify(buildParserSessionContext_(sessionSnapshot, {
      timezone: this.timezone,
      isolated: true,
      preIntentType: turnHints && turnHints.messageType
    }));
    const contextualSessionText = JSON.stringify(buildParserSessionContext_(sessionSnapshot, {
      timezone: this.timezone,
      isolated: false,
      preIntentType: turnHints && turnHints.messageType
    }));
    const systemPrompt = [
      "Kamu adalah semantic parser untuk AI agent asisten pribadi pemilik usaha motor.",
      "Tugasmu hanya mengubah bahasa manusia menjadi JSON semantik yang kanonik dan valid.",
      "Jangan menjawab natural. Jangan menghitung angka. Jangan memilih kandidat data. Jangan membuat keputusan bisnis.",
      "Action yang valid hanya: query, create, update, delete, confirm, reminder, chat, correction.",
      "Entity yang valid hanya: motor, sales, pengeluaran, global_summary, reminder, general.",
      "Metric yang valid hanya: list, count, sum, profit, revenue, atau string kosong.",
      "Availability state yang valid hanya: available, sold, all, atau string kosong.",
      "Reference mode yang valid hanya: new_request, pending_action, last_query, atau string kosong.",
      "Schema semantik harus memisahkan selector, filters, projection, mutation_payload, temporal, reference, dan targets.",
      "Schema semantik juga harus memisahkan availability_state dari sold filter.",
      "SESSION_CONTEXT.pre_intent_type adalah hasil pre-interpretation layer. Gunakan itu sebagai sinyal protokol, terutama untuk CONFIRMATION, CORRECTION, RECHECK, dan RESET.",
      "availability_state=available berarti ready, tersedia, stok yang masih ada, atau belum laku.",
      "availability_state=sold berarti yang sudah terjual atau sudah laku.",
      "Jika availability_state dipakai, jangan membalik sold polarity secara implisit.",
      "Query tidak boleh mengisi mutation_payload kecuali benar-benar ada perubahan data yang ingin disimpan.",
      "Mutation tidak boleh memakai filters untuk membawa nilai bisnis baru; nilai baru harus ada di mutation_payload.",
      "Semua batasan query harus masuk ke filters dan akan dievaluasi resolver dengan logika AND.",
      "Date range harus ditulis secara kanonik di temporal: preset=today|week|month, atau last_days, atau start_date/end_date.",
      "Field sold harus bernilai true, false, all, atau null.",
      "Jika user menyebut angka seperti 5 jt, 4,5 juta, atau 5.000.000, ubah menjadi angka penuh pada field numerik terkait.",
      "Reference mode = pending_action hanya jika SESSION_CONTEXT memang menunjukkan ada pending action dan pesan user semantikanya melanjutkan alur itu.",
      "Reference mode = last_query hanya jika pesan user jelas merujuk hasil query sebelumnya tanpa target baru yang eksplisit.",
      "Reference mode = new_request jika user memulai tugas baru yang berdiri sendiri.",
      "Jangan mewariskan metric, selector, atau polarity dari SESSION_CONTEXT jika pesan sekarang adalah permintaan baru yang eksplisit.",
      "Jika user menyebut target baru yang lengkap, abaikan metric dari query sebelumnya dan bangun query baru.",
      "Jika pesan membahas pencarian, daftar, hitung, filter, stok, hasil, atau ringkasan atas data yang sudah ada, gunakan action=query.",
      "Jika pesan membahas pencatatan atau penambahan data baru, gunakan action=create.",
      "Jika pesan melaporkan perubahan status data yang harus dicatat, seperti penjualan yang sudah terjadi, gunakan action=confirm atau update sesuai semantikanya, bukan query.",
      "Jangan memakai action=create hanya karena user menyebut entity dan beberapa nilai field. Bedakan antara filter data lama dan input data baru secara semantik.",
      "Jika user hanya menyebut nama motor atau atribut motor untuk mencari data yang sudah ada, itu lebih cenderung query daripada create.",
      "Jika user menyebut deskripsi biaya dan nominal pengeluaran, itu lebih cenderung create entity=pengeluaran daripada query.",
      "Jika nama field disebut eksplisit, tempatkan nilainya pada field yang sama; jangan memindahkan nilai pajak ke tahun, atau harga jual ke field lain.",
      "Nilai multi-token harus dipertahankan utuh, misalnya 'lengkap hidup', 'BPKB ONLY', 'tahun plat', atau nama motor dua kata.",
      "Jika user menyebut lebih dari satu target, gunakan selector.names atau selector.ids sebagai array, jangan gabungkan menjadi satu string.",
      "Parser tidak mengetahui nama sheet, kolom spreadsheet, atau rumus bisnis.",
      "Jika SESSION_CONTEXT.has_pending_action=true, prioritaskan continuation terhadap pending action. Jangan membuat intent baru kecuali user jelas memulai request baru.",
      "Jika SESSION_CONTEXT.conversation_state adalah PENDING_CREATE atau PENDING_CONFIRM, anggap persetujuan singkat sebagai continuation, bukan intent baru.",
      "Jika tidak ada pending action aktif, jangan merekonstruksi selector, patch, atau data mutasi dari history lama. Gunakan hanya informasi eksplisit pada pesan sekarang.",
      "Jika tidak ada pending action aktif, persetujuan singkat atau perintah lanjut singkat tidak boleh diubah menjadi mutasi baru hanya karena ada aksi lama di RECENT_HISTORY.",
      "Jika user memberi persetujuan singkat untuk melanjutkan alur yang sedang pending, jangan salin data lama ke mutation_payload atau filters baru. Cukup isi user_context yang sesuai dan reference.mode=pending_action.",
      "Kalimat koreksi seperti menyangkal, membetulkan, atau mengganti parameter sebelumnya harus dipetakan ke action=correction dengan perubahan struktur baru yang eksplisit.",
      "Follow-up yang hanya meminta satu field dari hasil sebelumnya tetap action=query dengan projection yang sesuai, bukan correction.",
      "Untuk correction, isi correction_type dengan salah satu: selector_refinement, selector_replacement, payload_adjustment, full_query_reset.",
      "selector_refinement berarti mempersempit atau menambah batasan pada query sebelumnya tanpa mengganti entity.",
      "selector_replacement berarti mengganti selector lama dengan selector baru, misalnya mengganti nomor atau nama target.",
      "payload_adjustment berarti mengubah mutation_payload tanpa mengganti selector utama.",
      "full_query_reset berarti query sebelumnya harus diabaikan dan konteks pencarian direset.",
      "Correction harus memakai konteks struktural dari SESSION_CONTEXT.last_semantic_payload atau pending action, bukan menyalin ulang query lama dari teks mentah.",
      "SESSION_CONTEXT.last_action_receipt dapat berisi anchors hasil mutation terakhir. Jika user merujuk item hasil mutation terakhir, gunakan selector yang cocok dengan anchor itu dan jangan mengarang target baru.",
      "SESSION_CONTEXT.last_reference_targets berisi label/no referensi terakhir yang aman dipakai untuk menyelesaikan rujukan seperti 'yang Kirana', 'yang pertama', atau 'yang tadi'.",
      "SESSION_CONTEXT.last_query_context dapat dipakai untuk mengevaluasi apakah user sedang mempertanyakan kelengkapan atau jumlah hasil query sebelumnya.",
      "Untuk correction yang merujuk query sebelumnya, isi reference.mode=last_query dan reference.target='previous_query'.",
      "Untuk correction yang merujuk alur mutasi yang masih pending, isi reference.mode=pending_action dan reference.target='pending_action'.",
      "Jika user memperbaiki nomor target, taruh nomor baru di selector dan target_field='no'.",
      "Jika user memperbaiki nilai harga atau field mutasi lain, taruh nilai baru di mutation_payload dan target_field ke field terkait.",
      "Jika user hanya menambahkan pembatas baru ke hasil sebelumnya, gunakan filters atau selector tambahan dan correction_type=selector_refinement.",
      "Contoh correction 1: setelah 'motor vario', pesan 'yang tahun 2019' -> action=correction, correction_type=selector_refinement, entity=motor, filters.tahun=2019, reference.mode=last_query.",
      "Contoh correction 2: setelah 'motor nomor 17', pesan 'bukan 17, 18' -> action=correction, correction_type=selector_replacement, selector.attributes.no=18, target_field='no', new_value=18, reference.mode=last_query.",
      "Contoh correction 3: setelah 'motor vario laku 7 juta', pesan 'bukan 7 juta, 6 juta' -> action=correction, correction_type=payload_adjustment, mutation_payload.harga_laku=6000000, target_field='harga_laku', new_value=6000000, reference.mode=pending_action jika alur masih berjalan.",
      "Contoh correction 3b: setelah aksi sukses 'input pengeluaran kopi 15k', pesan 'bukan kopi, teh' -> action=correction, correction_type=payload_adjustment, mutation_payload.keterangan='teh', tanpa menyalin payload lama lain yang tidak berubah.",
      "Contoh correction 3c: setelah aksi sukses 'motor beat laku 5 juta', pesan 'bukan beat, vario' -> action=correction, correction_type=selector_replacement, selector.attributes.nama_motor='vario', tanpa membawa NO lama atau nama lama ke selector baru.",
      "Contoh correction 3d: setelah aksi sukses multi-motor, pesan 'yang Kirana tahunnya salah' -> action=correction, entity=motor, selector.names=['Kirana'], target_field='tahun', reference.target='previous_action'. Jika nilai baru belum disebut, mutation_payload boleh kosong.",
      "Jika SESSION_CONTEXT.pre_intent_type=RECHECK dan SESSION_CONTEXT.last_query_context atau SESSION_CONTEXT.last_action_receipt tersedia, jangan jatuh ke chat/general. Gunakan action=correction yang merujuk hasil sebelumnya.",
      "Jika SESSION_CONTEXT.pre_intent_type=CONFIRMATION dan SESSION_CONTEXT.has_pending_action=true, prioritaskan continuation terhadap pending action.",
      "Jika SESSION_CONTEXT.pre_intent_type=RESET, gunakan action=correction dengan correction_type=full_query_reset.",
      "Contoh correction 4: setelah query salah konteks, pesan 'bukan itu maksudku' tanpa target baru -> action=correction, correction_type=full_query_reset, reference.mode=last_query.",
      "Jika user mempertanyakan hasil sebelumnya seperti merasa item kurang, hasil tidak lengkap, atau jumlahnya tidak sesuai, gunakan action=correction yang merujuk hasil sebelumnya. Jika itu evaluasi hasil query, gunakan reference.mode=last_query. Jika itu evaluasi hasil mutation terakhir, gunakan reference.target='previous_action'. Jangan jatuh ke chat/general.",
      "Contoh evaluasi 1: setelah hasil query, pesan 'mana yang lain?' -> action=correction, entity sama dengan query sebelumnya, reference.mode=last_query, correction_type kosong.",
      "Contoh evaluasi 2: setelah hasil mutation multi-item, pesan 'kok cuma dua?' -> action=correction, reference.target='previous_action', correction_type kosong.",
      "Contoh follow-up projection 1: setelah 'motor vario', pesan 'yang ini pajaknya berapa' -> action=query, entity=motor, projection=['pajak'], reference.mode=last_query.",
      "Contoh follow-up projection 2: setelah 'motor beat', pesan 'yang tahun berapa' -> action=query, entity=motor, projection=['tahun'], reference.mode=last_query.",
      "Jika SESSION_CONTEXT.invalid_query_context=true dan user tetap mengirim follow-up yang jelas masih merujuk konteks sebelumnya, tetap gunakan reference.mode=last_query agar resolver dapat meminta pemilihan ulang konteks.",
      "Jangan meminta konfirmasi eksplisit untuk input yang sudah lengkap. Resolver yang menentukan validasi dan eksekusi.",
      "Jika user semantikanya berarti lanjut simpan meski data belum lengkap, isi user_context dengan force_execute.",
      "Jika user ingin membatalkan alur pending, isi user_context dengan cancel_pending.",
      "Jika user ingin mengulang dari awal, isi user_context dengan reset_flow.",
      "Jika confidence di bawah 0.65, tetap keluarkan payload terbaik tetapi jangan mengarang selector, mutation_payload, atau reference.",
      "Aturan semantik generik: jika pesan hanya menyebut entity yang sudah ada lalu atribut+nilai untuk mencari data, maka itu query, bukan create.",
      "Aturan semantik generik: jika user tidak menyebut metric secara eksplisit, default query adalah list/detail, bukan count.",
      "Aturan semantik generik: jika pesan menyebut nomor atau NO motor lalu menanyakan satu field, isi selector.attributes.no dan projection field itu, metric harus kosong.",
      "Aturan semantik generik: jika pesan menanyakan keuntungan, laba, atau profit, gunakan action=query entity=sales dan metric=profit, bukan chat.",
      "Aturan semantik generik: jika pesan menanyakan hasil penjualan, total penjualan, pendapatan penjualan, atau omzet, gunakan action=query entity=sales dan metric=revenue, bukan chat.",
      "Aturan semantik generik: jika pesan berisi deskripsi biaya + nominal, gunakan action=create entity=pengeluaran dengan mutation_payload.keterangan dan mutation_payload.total_pengeluaran.",
      "Aturan semantik generik: jika user meminta total atau jumlah pengeluaran pada rentang waktu tertentu, gunakan action=query entity=pengeluaran dan metric=sum.",
      "Aturan semantik generik: jika user meminta daftar atau melihat pengeluaran pada rentang waktu tertentu tanpa meminta total, gunakan action=query entity=pengeluaran dan metric=list.",
      "Aturan semantik generik: jika pesan berisi reminder atau pengingat, gunakan action=reminder entity=reminder dan ekstrak waktu+pesan bila keduanya tersedia.",
      "Aturan semantik generik: jika user meminta melihat, menampilkan, atau mendaftar reminder yang sudah ada, gunakan action=query entity=reminder dan metric=list.",
      "Contoh semantik 1: 'motor harga jual 7 juta' -> action=query, entity=motor, filters.harga_jual=7000000, mutation_payload kosong.",
      "Contoh semantik 2: 'motor beat pajak 2030' -> action=query, entity=motor, selector.names=['beat'], filters.pajak=2030.",
      "Contoh semantik 3: 'motor nomor 7 pajaknya berapa' -> action=query, entity=motor, selector.attributes.no=7, projection=['pajak'], metric kosong.",
      "Contoh semantik 4a: 'profit 7 hari' atau 'keuntungan minggu ini' -> action=query, entity=sales, metric=profit, temporal sesuai rentang waktu.",
      "Contoh semantik 4b: 'hasil penjualan minggu ini' -> action=query, entity=sales, metric=revenue, temporal sesuai rentang waktu.",
      "Contoh semantik 5: 'beli bensin 30k' -> action=create, entity=pengeluaran, mutation_payload.keterangan='bensin', mutation_payload.total_pengeluaran=30000.",
      "Contoh semantik 6: 'motor apa saja yang ready' -> action=query, entity=motor, metric=list, availability_state=available.",
      "Contoh semantik 7: 'ada berapa motor yang ready' -> action=query, entity=motor, metric=count, availability_state=available.",
      "Contoh semantik 8: 'ingatkan aku jam 7 olahraga' -> action=reminder, entity=reminder, mutation_payload.due_at berisi waktu valid dan mutation_payload.text='olahraga'.",
      "Contoh semantik 9: 'daftar reminder' -> action=query, entity=reminder, metric=list.",
      "Contoh semantik 10: 'total pengeluaran hari ini' -> action=query, entity=pengeluaran, metric=sum, temporal.preset='today'.",
      "Contoh semantik 11: 'pengeluaran 3 hari' -> action=query, entity=pengeluaran, metric=list, temporal.last_days=3.",
      "Untuk input motor gunakan action=create entity=motor dan isi mutation_payload atau targets jika user memberi beberapa item sekaligus.",
      "Untuk edit motor gunakan action=update entity=motor, selector untuk memilih motor, dan mutation_payload untuk nilai baru.",
      "Untuk hapus motor gunakan action=delete entity=motor dengan selector pemilih motor.",
      "Untuk konfirmasi motor terjual gunakan action=confirm entity=sales, selector untuk memilih motor, dan mutation_payload.harga_laku jika sudah ada. Jika user memberi beberapa item sekaligus, gunakan targets.",
      "Untuk input pengeluaran gunakan action=create entity=pengeluaran dan isi mutation_payload atau targets jika user memberi beberapa item sekaligus.",
      "Untuk daftar atau pengelolaan reminder gunakan entity=reminder.",
      "Selector dipakai untuk identifikasi target, projection untuk field yang ingin ditampilkan, filters untuk batasan dataset, temporal untuk waktu, mutation_payload untuk nilai baru.",
      "JSON harus valid dan lengkap sesuai schema. Jangan menambahkan narasi apa pun."
    ].join("\n");

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: "SESSION_CONTEXT: " + isolatedSessionText },
      { role: "system", content: "PARSER_MODE: CURRENT_INPUT_ONLY. Jangan gunakan last_query atau history untuk menentukan action/entity/metric kecuali reference.mode sudah eksplisit." }
    ];
    messages.push({ role: "user", content: userContent });

    try {
      const parsed = await this.runSemanticParse_(sanitizeMessages(messages));
      let normalized = normalizeSemanticPayload_(parsed, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });

      if (shouldReparseSemanticPayload_(normalized)) {
        const repaired = await this.repairSemanticQuery_(userContent, isolatedSessionText, normalized, seedText);
        if (repaired) normalized = repaired;
      }

      normalized = normalizeSemanticPayload_(normalized, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });

      normalized = stabilizeSemanticStructure_(normalized, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });

      if (needsGeneralSemanticRecovery_(normalized, seedText)) {
        const recovered = await this.recoverSemanticQuery_(userContent, isolatedSessionText, normalized, seedText);
        if (recovered) {
          normalized = stabilizeSemanticStructure_(recovered, {
            seedText: seedText,
            timezone: this.timezone,
            now: new Date(),
            sessionSnapshot: sessionSnapshot || {}
          });
        }
      }

      normalized = await this.resolveGenericTaskAmbiguity_(userContent, isolatedSessionText, normalized, seedText, sessionSnapshot);
      normalized = await this.resolveInventoryListingAmbiguity_(userContent, normalized, seedText);
      normalized = await this.resolveProjectionFieldAmbiguity_(userContent, contextualSessionText, normalized, seedText, sessionSnapshot);
      normalized = await this.resolveReferenceModeAmbiguity_(userContent, contextualSessionText, normalized, seedText, sessionSnapshot);
      normalized = await this.resolveFinancialMetricAmbiguity_(userContent, normalized);

      if (needsInventoryMetricResolution_(normalized)) {
        const refinedMetric = await this.inferInventoryMetric_(userContent, normalized);
        if (refinedMetric) {
          normalized.metric = refinedMetric;
        }
      }

      normalized = stabilizeSemanticStructure_(normalized, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });

      return normalized;
    } catch (err) {
      warn("semantic_parse_failed", { message: String(err && err.message ? err.message : err) });
      return normalizeSemanticPayload_({ action: "chat", entity: "general" }, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });
    }
  }

  async runSemanticParse_(messages) {
    const payload = {
      model: this.model,
      temperature: 0,
      messages: sanitizeMessages(messages),
      response_format: buildParserSchema_()
    };
    const aiMessage = await this.callOpenAI(payload);
    return safeJsonParse(extractMessageText(aiMessage));
  }

  async repairSemanticQuery_(userContent, sessionText, initialPayload, seedText) {
    const repairPrompt = [
      "Kamu meninjau hasil semantic parsing awal yang kemungkinan masih salah klasifikasi.",
      "Perbaiki hanya struktur JSON semantik. Jangan menjawab natural.",
      "Jaga kontrak yang sama: action, entity, selector, filters, projection, mutation_payload, temporal, reference, confidence, availability_state.",
      "Utamakan stabilitas semantik berikut:",
      "1. query atribut tidak boleh berubah menjadi mutation",
      "2. follow-up yang meminta field dari context sebelumnya tetap action=query dengan projection",
      "3. reminder harus punya due_at dan text yang konsisten",
      "4. query baru yang eksplisit tidak boleh mewarisi metric lama",
      "5. jika pesan jelas meminta data/reminder/mutasi, jangan jatuh ke chat/general",
      "6. inventory-wide request harus dibedakan antara count vs list secara semantik, bukan berdasarkan context lama",
      "7. frasa laporan penjualan yang menyebut target motor + harga laku harus diparse sebagai confirm entity=sales, bukan query",
      "8. evaluasi hasil sebelumnya seperti mempertanyakan item yang kurang atau jumlah yang tidak sesuai harus diparse sebagai correction terhadap hasil sebelumnya, bukan chat/general",
      "9. jika SESSION_CONTEXT.last_action_receipt punya anchor target, gunakan anchor itu sebagai reference untuk correction",
      "Jangan menambah narasi."
    ].join("\n");

    const messages = [
      { role: "system", content: repairPrompt },
      { role: "system", content: "SESSION_CONTEXT: " + sessionText },
      { role: "system", content: "INITIAL_PARSE: " + JSON.stringify(initialPayload) },
      { role: "user", content: userContent }
    ];

    try {
      const parsed = await this.runSemanticParse_(messages);
      return normalizeSemanticPayload_(parsed, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: null
      });
    } catch (err) {
      warn("semantic_reparse_failed", { message: String(err && err.message ? err.message : err) });
      return null;
    }
  }

  async generateGeneralChatReply(userPhone, userContent, sessionSnapshot, recentHistory) {
    const history = Array.isArray(recentHistory) ? recentHistory.slice(-8) : this.getHistory(userPhone).slice(-8);
    const messages = [
      {
        role: "system",
        content: [
          "Kamu asisten pribadi yang natural, ringkas, dan teliti.",
          "Jawab dalam Bahasa Indonesia yang natural.",
          "Jika user mengoreksi, akui dan perbaiki.",
          "Untuk data spreadsheet, jangan mengarang angka atau baris data.",
          "Jika ada gambar non-struk, kamu boleh mendeskripsikan isi gambar secara umum dan sopan."
        ].join("\n")
      },
      {
        role: "system",
        content: "SESSION_CONTEXT: " + JSON.stringify({ session: sessionSnapshot || {}, timezone: this.timezone })
      }
    ];

    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      if (!item || typeof item !== "object") continue;
      messages.push({
        role: String(item.role || "user"),
        content: String(item.content || "")
      });
    }

    messages.push({ role: "user", content: userContent });

    const payload = {
      model: this.model,
      temperature: 0.3,
      messages: sanitizeMessages(messages)
    };

    try {
      const aiMessage = await this.callOpenAI(payload);
      const text = extractMessageText(aiMessage);
      return text || "Baik, saya siap bantu.";
    } catch (err) {
      error("general_chat_failed", { message: String(err && err.message ? err.message : err) });
      return "Saya siap bantu. Coba ulangi dengan kalimat yang lebih jelas.";
    }
  }

  async prepareUserTurn(input, sessionSnapshot) {
    const payload = input && typeof input === "object" ? input : {};
    const baseText = normalizeUserText(payload.text);
    const imageDataUrl = String(payload.imageDataUrl || "").trim();
    const mediaError = String(payload.mediaError || "").trim();

    let transcribedText = normalizeUserText(payload.transcribedText);
    let transcriptionError = "";

    if (!transcribedText && Buffer.isBuffer(payload.audioBuffer) && payload.audioBuffer.length > 0) {
      try {
        transcribedText = await this.transcribeAudio(
          payload.audioBuffer,
          String(payload.audioMimeType || "audio/ogg").trim() || "audio/ogg",
          String(payload.audioFilename || "voice-note.ogg").trim() || "voice-note.ogg"
        );
        if (transcribedText) {
          info("audio_transcribed", {
            length: transcribedText.length,
            mimeType: String(payload.audioMimeType || "audio/ogg")
          });
        }
      } catch (err) {
        transcriptionError = String(err && err.message ? err.message : err);
        error("audio_transcription_failed", { message: transcriptionError });
      }
    }

    if (!baseText && !transcribedText && !imageDataUrl && transcriptionError) {
      return {
        hasUsableInput: false,
        directReply: "Maaf, voice note belum berhasil saya baca. Coba kirim ulang voice atau kirim teks.",
        plainText: "",
        openaiContent: "",
        hasImage: false,
        hasAudio: true,
        mediaError: mediaError,
        inputKind: "audio"
      };
    }

    const textParts = [];
    if (baseText) textParts.push(baseText);
    if (transcribedText) textParts.push(baseText ? ("Transkrip voice admin:\n" + transcribedText) : transcribedText);
    if (mediaError) textParts.push("Catatan media: " + mediaError);
    if (transcriptionError) textParts.push("Catatan audio: transkripsi gagal (" + transcriptionError + ").");

    const plainText = textParts.join("\n\n").trim();
    const hasImage = Boolean(imageDataUrl);
    const hasAudio = Boolean(transcribedText || (Buffer.isBuffer(payload.audioBuffer) && payload.audioBuffer.length > 0));

    if (!plainText && !hasImage) {
      return {
        hasUsableInput: false,
        directReply: "",
        openaiContent: "",
        plainText: "",
        hasImage: false,
        hasAudio: false,
        mediaError: mediaError,
        inputKind: "text"
      };
    }

    let inputKind = "text";
    if (hasImage) inputKind = "image";
    else if (hasAudio) inputKind = "audio";

    let openaiContent = plainText;
    if (hasImage) {
      const leadText = plainText || "Admin mengirim gambar. Analisis isi gambar dan konteksnya.";
      openaiContent = [
        { type: "text", text: leadText },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ];
    }

    const interpretation = this.interpretUserTurn(plainText, sessionSnapshot);
    const lineTargets = extractStructuredTargets_(plainText, sessionSnapshot);

    return {
      hasUsableInput: true,
      directReply: "",
      openaiContent: openaiContent,
      plainText: plainText || (hasImage ? "[gambar]" : ""),
      hasImage: hasImage,
      hasAudio: hasAudio,
      mediaError: mediaError,
      inputKind: inputKind,
      semanticPayload: interpretation.semanticPayload,
      prefaceApology: interpretation.prefaceApology,
      lineTargets: lineTargets,
      messageType: interpretation.messageType
    };
  }

  interpretUserTurn(plainText, sessionSnapshot) {
    return interpretUserTurn_(plainText, sessionSnapshot);
  }

  async transcribeAudio(buffer, mimeType, fileName) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";

    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType || "audio/ogg" });
    form.append("file", blob, sanitizeFileName(fileName || buildAudioFileName(mimeType)));
    form.append("model", this.transcriptionModel);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + "/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + this.apiKey },
        body: form,
        signal: controller.signal
      });

      const raw = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status + " - " + raw.slice(0, 500));

      let parsed = {};
      try { parsed = JSON.parse(raw); } catch (err) { parsed = {}; }
      return String(parsed && parsed.text ? parsed.text : "").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async callOpenAI(payload) {
    const maxAttempts = 4;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log("OPENAI REQUEST:", JSON.stringify(payload, null, 2));
        const res = await axios.post(this.baseUrl + "/chat/completions", payload, {
          timeout: this.timeoutMs,
          headers: {
            Authorization: "Bearer " + this.apiKey,
            "Content-Type": "application/json"
          }
        });
        const choices = res && res.data && Array.isArray(res.data.choices) ? res.data.choices : [];
        if (!choices.length || !choices[0] || !choices[0].message) throw new Error("OPENAI_CHOICES_EMPTY");
        return choices[0].message;
      } catch (err) {
        lastErr = err;
        console.error("OPENAI ERROR BODY:", err && err.response ? err.response.data : null);
        if (!isRetryableOpenAIError(err) || attempt >= maxAttempts) break;
        await sleep_(750 * attempt);
      }
    }
    throw lastErr || new Error("OPENAI_REQUEST_FAILED");
  }

  getHistory(userKey) {
    const arr = this.histories.get(String(userKey || "")) || [];
    return Array.isArray(arr) ? arr.slice() : [];
  }

  pushHistory(userKey, message) {
    const key = String(userKey || "");
    const old = this.getHistory(key);
    old.push({ role: String(message && message.role || "user"), content: String(message && message.content || "") });
    if (old.length > this.maxHistoryMessages) {
      this.histories.set(key, old.slice(old.length - this.maxHistoryMessages));
      return;
    }
    this.histories.set(key, old);
  }

  async inferInventoryMetric_(userContent, semanticPayload) {
    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier semantik untuk query inventory.",
          "Tugasmu hanya memilih metric yang paling tepat: count atau list.",
          "Pilih count jika user meminta jumlah, kuantitas, total unit, ukuran stok, atau besaran inventory.",
          "Pilih list jika user meminta daftar item, motor apa saja, tampilkan data, atau detail record.",
          "Gunakan makna kalimat, bukan context sebelumnya.",
          "Jawab hanya JSON valid dengan schema {\"metric\":\"count|list\",\"confidence\":0..1}."
        ].join("\n")
      },
      {
        role: "system",
        content: "SEMANTIC_PAYLOAD: " + JSON.stringify(semanticPayload)
      },
      {
        role: "user",
        content: userContent
      }
    ];

    try {
      const payload = {
        model: this.model,
        temperature: 0,
        messages: sanitizeMessages(messages),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "inventory_metric_classifier",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                metric: { type: "string", enum: ["count", "list"] },
                confidence: { type: "number" }
              },
              required: ["metric", "confidence"]
            }
          }
        }
      };
      const aiMessage = await this.callOpenAI(payload);
      const parsed = safeJsonParse(extractMessageText(aiMessage));
      const metric = normalizeMetric_(parsed && parsed.metric);
      const confidence = normalizeConfidence_(parsed && parsed.confidence);
      if ((metric === "count" || metric === "list") && confidence >= 0.65) {
        return metric;
      }
    } catch (err) {
      warn("inventory_metric_inference_failed", { message: String(err && err.message ? err.message : err) });
    }
    return "";
  }

  async recoverSemanticQuery_(userContent, sessionText, initialPayload, seedText) {
    const messages = [
      {
        role: "system",
        content: [
          "Kamu sedang memperbaiki hasil semantic parsing yang terlalu cepat jatuh ke chat/general.",
          "Tinjau ulang maksud user dan hasilkan JSON semantik penuh dengan schema yang sama.",
          "Jangan gunakan chat/general jika permintaan sebenarnya berkaitan dengan data motor, penjualan, pengeluaran, reminder, atau mutasi data.",
          "Bedakan antara permintaan jumlah/count, daftar/list, projection field, reminder, create pengeluaran, create motor, confirm penjualan, dan query atribut.",
          "Jika user meminta diingatkan pada waktu tertentu, atau menyebut jadwal pengingat dengan pesan yang harus diingat, gunakan action=reminder entity=reminder.",
          "Reminder harus mengisi mutation_payload.due_at dan mutation_payload.text secara bersamaan bila informasinya tersedia secara semantik.",
          "Jika user meminta stok, unit tersedia, motor ready, atau daftar motor yang masih ada, jangan gunakan chat/general. Itu selalu query entity=motor dengan metric count atau list.",
          "Jika user meminta keuntungan, laba, atau profit, jangan gunakan chat/general. Itu query finansial entity=sales dengan metric=profit.",
          "Jika user meminta hasil penjualan, total penjualan, pendapatan penjualan, atau omzet, jangan gunakan chat/general. Itu query finansial entity=sales dengan metric=revenue.",
          "Jika user meminta total pengeluaran pada rentang waktu tertentu, jangan gunakan chat/general. Itu query entity=pengeluaran dengan metric=sum.",
          "Jika user meminta daftar pengeluaran pada rentang waktu tertentu tanpa total/jumlah, jangan gunakan chat/general. Itu query entity=pengeluaran dengan metric=list.",
          "Jika user meminta daftar atau melihat reminder yang sudah ada, jangan gunakan chat/general. Itu query entity=reminder dengan metric=list.",
          "Jika user menyebut entity + atribut + nilai untuk mencari data, itu query, bukan create.",
          "Jika user menyebut deskripsi biaya + nominal, itu create entity=pengeluaran, bukan chat.",
          "Jika SESSION_CONTEXT masih memuat pending action atau last query, dan user sedang membetulkan, menolak, atau mengganti bagian dari konteks itu, gunakan action=correction alih-alih chat/general.",
          "Jika user menyatakan konteks sebelumnya salah tanpa target baru yang jelas, gunakan correction_type=full_query_reset.",
          "Jika user mengganti selector atau angka dari alur sebelumnya, gunakan correction_type selector_replacement, selector_refinement, atau payload_adjustment sesuai bentuk struktur barunya.",
          "Jika masih ada makna data atau reminder yang masuk akal, pilih struktur task yang paling mungkin daripada chat/general.",
          "Contoh: 'ingatkan aku jam 7 olahraga' -> action=reminder, entity=reminder, mutation_payload.due_at berisi waktu valid, mutation_payload.text='olahraga'.",
          "Contoh: 'motor apa saja yang ready' -> action=query, entity=motor, metric=list, availability_state=available.",
          "Contoh: 'total unit motor di gudang' -> action=query, entity=motor, metric=count, availability_state=available.",
          "Contoh: 'keuntungan minggu ini' -> action=query, entity=sales, metric=profit, temporal.preset='week'.",
          "Contoh: 'hasil penjualan minggu ini' -> action=query, entity=sales, metric=revenue, temporal.preset='week'.",
          "Contoh: 'total pengeluaran hari ini' -> action=query, entity=pengeluaran, metric=sum, temporal.preset='today'.",
          "Contoh: 'pengeluaran 3 hari' -> action=query, entity=pengeluaran, metric=list, temporal.last_days=3.",
          "Contoh: 'daftar reminder' -> action=query, entity=reminder, metric=list.",
          "Contoh: setelah flow penjualan, 'bukan 7 juta, 6 juta' -> action=correction, correction_type=payload_adjustment, mutation_payload.harga_laku=6000000.",
          "Contoh: setelah flow sebelumnya salah, 'bukan itu maksudku' -> action=correction, correction_type=full_query_reset.",
          "Tetap jawab hanya JSON valid."
        ].join("\n")
      },
      {
        role: "system",
        content: "SESSION_CONTEXT: " + sessionText
      },
      {
        role: "system",
        content: "INITIAL_PARSE: " + JSON.stringify(initialPayload)
      },
      {
        role: "user",
        content: userContent
      }
    ];

    try {
      const parsed = await this.runSemanticParse_(messages);
      return normalizeSemanticPayload_(parsed, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: null
      });
    } catch (err) {
      warn("semantic_recovery_failed", { message: String(err && err.message ? err.message : err) });
      return null;
    }
  }

  async resolveGenericTaskAmbiguity_(userContent, sessionText, semanticPayload, seedText, sessionSnapshot) {
    const current = semanticPayload && typeof semanticPayload === "object"
      ? JSON.parse(JSON.stringify(semanticPayload))
      : semanticPayload;
    if (!needsGenericTaskReview_(current)) return current;

    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier semantic task untuk parser AI agent.",
          "Tugasmu memperbaiki payload semantik yang masih terlalu umum atau jatuh ke chat/general.",
          "Gunakan makna permintaan secara keseluruhan, bukan aturan literal.",
          "Bedakan secara generik antara query data, mutasi data, reminder, correction, dan chat.",
          "Jika user meminta stok, ketersediaan, daftar unit, hasil penjualan, keuntungan, reminder, atau pengeluaran, jangan biarkan payload tetap chat/general bila sebenarnya ada struktur task yang jelas.",
          "Jika metric tidak disebut eksplisit pada query data, default-kan ke list/detail, bukan count.",
          "Jika user meminta stok atau ketersediaan motor tanpa selector spesifik, gunakan entity=motor dan availability_state=available.",
          "Jika user meminta hasil penjualan, gunakan metric=revenue. Jika user meminta laba/keuntungan, gunakan metric=profit.",
          "Jika user meminta total/jumlah pengeluaran pada rentang waktu, gunakan entity=pengeluaran dan metric=sum.",
          "Jika user meminta daftar pengeluaran pada rentang waktu tanpa total/jumlah, gunakan entity=pengeluaran dan metric=list.",
          "Jika user meminta daftar reminder, gunakan entity=reminder dan metric=list.",
          "Jawab hanya JSON semantik penuh dengan schema yang sama."
        ].join("\n")
      },
      { role: "system", content: "SESSION_CONTEXT: " + sessionText },
      { role: "system", content: "CURRENT_SEMANTIC_PAYLOAD: " + JSON.stringify(current) },
      { role: "user", content: userContent }
    ];

    try {
      const parsed = await this.runSemanticParse_(messages);
      const normalized = normalizeSemanticPayload_(parsed, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });
      const stabilized = stabilizeSemanticStructure_(normalized, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });
      if (normalizeConfidence_(stabilized && stabilized.confidence) < 0.55) return current;
      if (normalizeAction_(stabilized && stabilized.action) === "chat" && normalizeText(stabilized && stabilized.entity).toLowerCase() === "general") {
        return current;
      }
      return stabilized;
    } catch (err) {
      warn("generic_task_inference_failed", { message: String(err && err.message ? err.message : err) });
      return current;
    }
  }

  async resolveInventoryListingAmbiguity_(userContent, semanticPayload, seedText) {
    const current = semanticPayload && typeof semanticPayload === "object"
      ? JSON.parse(JSON.stringify(semanticPayload))
      : semanticPayload;
    if (!needsInventoryListingReview_(current)) return current;

    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier semantik untuk broad inventory listing request.",
          "Tugasmu hanya menentukan apakah pesan user adalah permintaan melihat stok motor yang tersedia saat ini.",
          "Gunakan makna permintaan secara keseluruhan, bukan aturan literal kata.",
          "Jika ini permintaan listing/count atas inventory motor yang tersedia, pilih inventory_intent=inventory.",
          "Jika ini bukan inventory listing request, pilih inventory_intent=none.",
          "Metric yang valid hanya: list atau count.",
          "Permintaan dataset luas seperti melihat stok motor, daftar motor ready, unit yang tersedia, atau stok yang masih ada termasuk inventory listing request.",
          "Inventory listing request tidak membutuhkan selector spesifik, angka, atau field tertentu. Penyebutan dataset motor/stok motor saja sudah cukup jika maksud user adalah melihat daftar unit yang tersedia.",
          "Contoh inventory listing request: 'motor apa saja yang ready', 'tampilkan semua stok motor', 'tampilkan semua motor yang ready', 'daftar semua motor', 'motor yang tersedia sekarang', 'stok motor ready', 'motor apa saja yang belum terjual'.",
          "Contoh inventory count request: 'berapa stok motor sekarang', 'ada berapa motor yang ready', 'jumlah unit motor tersedia'.",
          "Jika user meminta daftar atau tampilan inventory motor yang tersedia, pilih inventory_intent=inventory dan metric=list, jangan none.",
          "Jawab hanya JSON valid dengan schema {\"inventory_intent\":\"inventory|none\",\"metric\":\"list|count\",\"confidence\":0..1}."
        ].join("\n")
      },
      {
        role: "system",
        content: "CURRENT_SEMANTIC_PAYLOAD: " + JSON.stringify(current)
      },
      {
        role: "user",
        content: userContent
      }
    ];

    try {
      const payload = {
        model: this.model,
        temperature: 0,
        messages: sanitizeMessages(messages),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "inventory_listing_classifier",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                inventory_intent: { type: "string", enum: ["inventory", "none"] },
                metric: { type: "string", enum: ["list", "count"] },
                confidence: { type: "number" }
              },
              required: ["inventory_intent", "metric", "confidence"]
            }
          }
        }
      };
      const aiMessage = await this.callOpenAI(payload);
      const parsed = safeJsonParse(extractMessageText(aiMessage));
      const intent = normalizeText(parsed && parsed.inventory_intent).toLowerCase();
      const metric = normalizeMetric_(parsed && parsed.metric);
      const confidence = normalizeConfidence_(parsed && parsed.confidence);
      if (intent !== "inventory" || (metric !== "list" && metric !== "count") || confidence < 0.55) return current;

      current.action = "query";
      current.entity = "motor";
      current.metric = metric;
      current.availability_state = "available";
      current.selector = normalizeSelector_({});
      current.filters = normalizeFilters_({});
      current.filters.sold = false;
      current.projection = [];
      current.mutation_payload = normalizeData_({});
      current.temporal = normalizeDateRange_({});
      current.reference = { mode: "new_request", target: "" };
      current.context_isolated = true;

      return stabilizeSemanticStructure_(current, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: {}
      });
    } catch (err) {
      warn("inventory_listing_inference_failed", { message: String(err && err.message ? err.message : err) });
      return current;
    }
  }

  async resolveProjectionFieldAmbiguity_(userContent, sessionText, semanticPayload, seedText, sessionSnapshot) {
    const current = semanticPayload && typeof semanticPayload === "object"
      ? JSON.parse(JSON.stringify(semanticPayload))
      : semanticPayload;
    if (!needsProjectionFieldReview_(current, sessionSnapshot)) return current;

    const allowedFields = projectionFieldCandidates_(sessionSnapshot);
    if (!allowedFields.length) return current;

    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier field projection untuk semantic parser.",
          "Tugasmu hanya memilih field kanonik yang sedang ditanyakan user dari konteks query sebelumnya.",
          "Gunakan makna field, bukan bentuk literal kalimat.",
          "Jika user menanyakan satu atribut dari data sebelumnya, pilih satu field kanonik yang paling tepat.",
          "Jika tidak yakin, pilih string kosong.",
          "Jawab hanya JSON valid dengan schema {\"projection_field\":\"...\",\"confidence\":0..1}."
        ].join("\n")
      },
      { role: "system", content: "SESSION_CONTEXT: " + sessionText },
      { role: "system", content: "CURRENT_SEMANTIC_PAYLOAD: " + JSON.stringify(current) },
      { role: "system", content: "ALLOWED_FIELDS: " + JSON.stringify(allowedFields) },
      { role: "user", content: userContent }
    ];

    try {
      const payload = {
        model: this.model,
        temperature: 0,
        messages: sanitizeMessages(messages),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "projection_field_classifier",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                projection_field: {
                  type: "string",
                  enum: [""] .concat(allowedFields)
                },
                confidence: { type: "number" }
              },
              required: ["projection_field", "confidence"]
            }
          }
        }
      };
      const aiMessage = await this.callOpenAI(payload);
      const parsed = safeJsonParse(extractMessageText(aiMessage));
      const field = normalizeText(parsed && parsed.projection_field).toLowerCase();
      const confidence = normalizeConfidence_(parsed && parsed.confidence);
      if (!field || allowedFields.indexOf(field) === -1 || confidence < 0.65) return current;
      current.action = "query";
      current.entity = projectionFieldEntity_(sessionSnapshot, current.entity);
      current.metric = "";
      current.projection = [field];
      current.filters = normalizeFilters_({});
      current.selector = normalizeSelector_({});
      current.mutation_payload = normalizeData_({});
      current.reference = { mode: "last_query", target: "previous_query" };
      current.context_isolated = false;
      return stabilizeSemanticStructure_(current, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });
    } catch (err) {
      warn("projection_field_inference_failed", { message: String(err && err.message ? err.message : err) });
      return current;
    }
  }

  async resolveReferenceModeAmbiguity_(userContent, sessionText, semanticPayload, seedText, sessionSnapshot) {
    const current = semanticPayload && typeof semanticPayload === "object"
      ? JSON.parse(JSON.stringify(semanticPayload))
      : semanticPayload;
    if (!needsReferenceModeReview_(current, sessionSnapshot)) return current;

    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier referensi percakapan untuk semantic parser.",
          "Tugasmu hanya memilih apakah request sekarang adalah permintaan baru atau refinement atas query sebelumnya.",
          "Gunakan makna kalimat dan SESSION_CONTEXT, bukan aturan literal.",
          "reference_mode yang valid hanya: last_query, new_request, atau none.",
          "Pilih last_query jika makna request bergantung pada hasil query sebelumnya.",
          "Pilih last_query jika payload sekarang hanya menambahkan filter, refinement, atau projection atas target sebelumnya tanpa selector baru yang berdiri sendiri.",
          "Jika CURRENT_SEMANTIC_PAYLOAD tidak memiliki selector baru dan hanya berisi filter atau projection, lalu SESSION_CONTEXT.last_query masih valid, maka strong default-nya adalah last_query.",
          "Jika SESSION_CONTEXT.last_query masih valid dan request sekarang tidak menyebut target baru yang independen, utamakan last_query.",
          "Contoh: setelah 'motor beat', request 'yang pajaknya 2030' -> reference_mode=last_query.",
          "Contoh: setelah 'motor vario', request 'yang tahun 2019' -> reference_mode=last_query.",
          "Pilih new_request jika request berdiri sendiri dan memulai pencarian baru.",
          "Pilih none jika payload semantik yang ada tidak perlu perubahan reference mode.",
          "Jawab hanya JSON valid dengan schema {\"reference_mode\":\"last_query|new_request|none\",\"confidence\":0..1}."
        ].join("\n")
      },
      { role: "system", content: "SESSION_CONTEXT: " + sessionText },
      { role: "system", content: "CURRENT_SEMANTIC_PAYLOAD: " + JSON.stringify(current) },
      { role: "user", content: userContent }
    ];

    try {
      const payload = {
        model: this.model,
        temperature: 0,
        messages: sanitizeMessages(messages),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reference_mode_classifier",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                reference_mode: { type: "string", enum: ["last_query", "new_request", "none"] },
                confidence: { type: "number" }
              },
              required: ["reference_mode", "confidence"]
            }
          }
        }
      };
      const aiMessage = await this.callOpenAI(payload);
      const parsed = safeJsonParse(extractMessageText(aiMessage));
      const mode = normalizeReferenceMode_(parsed && parsed.reference_mode);
      const confidence = normalizeConfidence_(parsed && parsed.confidence);
      if (confidence < 0.55) {
        if (shouldFallbackToLastQueryReference_(current, sessionSnapshot, mode)) {
          current.reference = { mode: "last_query", target: "previous_query" };
          return stabilizeSemanticStructure_(current, {
            seedText: seedText,
            timezone: this.timezone,
            now: new Date(),
            sessionSnapshot: sessionSnapshot || {}
          });
        }
        return current;
      }

      if (mode === "last_query") {
        current.reference = { mode: "last_query", target: "previous_query" };
      } else if (mode === "new_request") {
        current.reference = { mode: "", target: "" };
      }
      if (!normalizeReferenceMode_(current.reference && current.reference.mode) && shouldFallbackToLastQueryReference_(current, sessionSnapshot, mode)) {
        current.reference = { mode: "last_query", target: "previous_query" };
      }
      return stabilizeSemanticStructure_(current, {
        seedText: seedText,
        timezone: this.timezone,
        now: new Date(),
        sessionSnapshot: sessionSnapshot || {}
      });
    } catch (err) {
      warn("reference_mode_inference_failed", { message: String(err && err.message ? err.message : err) });
      return current;
    }
  }

  async resolveFinancialMetricAmbiguity_(userContent, semanticPayload) {
    const current = semanticPayload && typeof semanticPayload === "object"
      ? JSON.parse(JSON.stringify(semanticPayload))
      : semanticPayload;
    if (!needsFinancialMetricReview_(current)) return current;

    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah classifier metric finansial untuk semantic parser.",
          "Tugasmu hanya memilih metric profit atau revenue.",
          "profit berarti laba/keuntungan = hasil penjualan dikurangi biaya beli.",
          "revenue berarti hasil penjualan/pendapatan penjualan/omzet tanpa pengurangan biaya beli.",
          "Gunakan makna kalimat, bukan context sebelumnya.",
          "Jawab hanya JSON valid dengan schema {\"metric\":\"profit|revenue\",\"confidence\":0..1}."
        ].join("\n")
      },
      { role: "system", content: "CURRENT_SEMANTIC_PAYLOAD: " + JSON.stringify(current) },
      { role: "user", content: userContent }
    ];

    try {
      const payload = {
        model: this.model,
        temperature: 0,
        messages: sanitizeMessages(messages),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "financial_metric_classifier",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                metric: { type: "string", enum: ["profit", "revenue"] },
                confidence: { type: "number" }
              },
              required: ["metric", "confidence"]
            }
          }
        }
      };
      const aiMessage = await this.callOpenAI(payload);
      const parsed = safeJsonParse(extractMessageText(aiMessage));
      const metric = normalizeMetric_(parsed && parsed.metric);
      const confidence = normalizeConfidence_(parsed && parsed.confidence);
      if ((metric === "profit" || metric === "revenue") && confidence >= 0.7) {
        current.metric = metric;
      }
      return current;
    } catch (err) {
      warn("financial_metric_inference_failed", { message: String(err && err.message ? err.message : err) });
      return current;
    }
  }
}

function buildParserSchema_() {
  return {
    type: "json_schema",
    json_schema: {
      name: "semantic_payload",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: PARSER_ACTIONS },
          entity: { type: "string", enum: PARSER_ENTITIES },
          metric: { type: "string", enum: PARSER_METRICS },
          availability_state: { type: "string", enum: PARSER_AVAILABILITY_STATES },
          confidence: { type: "number" },
          correction_type: { type: "string", enum: PARSER_CORRECTION_TYPES },
          target_field: { type: "string" },
          new_value: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "null" }
            ]
          },
          user_context: { type: "string", enum: PARSER_USER_CONTEXTS },
          value: { type: "string" },
          count: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
          projection: {
            type: "array",
            items: { type: "string" }
          },
          targets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                selector: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    ids: { type: "array", items: { type: "string" } },
                    names: { type: "array", items: { type: "string" } },
                    attributes: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        no: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                        nama_motor: { type: "string" },
                        plat: { type: "string" }
                      },
                      required: ["no", "nama_motor", "plat"]
                    }
                  },
                  required: ["ids", "names", "attributes"]
                },
                filters: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    nama_motor: { type: "string" },
                    nomor_motor: { type: "string" },
                    tahun: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    pajak: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    surat: { type: "string" },
                    harga_beli: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    harga_jual: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    harga_laku: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    plat: { type: "string" },
                    tahun_plat: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    sold: {
                      anyOf: [
                        { type: "boolean" },
                        { type: "string", enum: ["all"] },
                        { type: "null" }
                      ]
                    },
                    availability_state: {
                      anyOf: [
                        { type: "string", enum: ["available", "sold", "all"] },
                        { type: "null" }
                      ]
                    },
                    status_terjual: {
                      anyOf: [
                        { type: "boolean" },
                        { type: "string", enum: ["all"] },
                        { type: "null" }
                      ]
                    }
                  },
                  required: [
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
                    "availability_state",
                    "status_terjual"
                  ]
                },
                projection: { type: "array", items: { type: "string" } },
                mutation_payload: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    no: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    nama_motor: { type: "string" },
                    tahun: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    plat: { type: "string" },
                    surat_surat: { type: "string" },
                    surat: { type: "string" },
                    tahun_plat: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    pajak: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    harga_beli: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    harga_jual: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    harga_laku: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    tanggal: { type: "string" },
                    keterangan: { type: "string" },
                    total_pengeluaran: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                    due_at: { type: "string" },
                    reminder_text: { type: "string" }
                  },
                  required: [
                    "no",
                    "nama_motor",
                    "tahun",
                    "plat",
                    "surat_surat",
                    "surat",
                    "tahun_plat",
                    "pajak",
                    "harga_beli",
                    "harga_jual",
                    "harga_laku",
                    "tanggal",
                    "keterangan",
                    "total_pengeluaran",
                    "due_at",
                    "reminder_text"
                  ]
                },
                temporal: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    preset: { type: "string", enum: ["today", "week", "month", "all", "none"] },
                    last_days: { anyOf: [{ type: "number" }, { type: "null" }] },
                    start_date: { type: "string" },
                    end_date: { type: "string" }
                  },
                  required: ["preset", "last_days", "start_date", "end_date"]
                },
                value: { type: "string" },
                count: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] }
              },
              required: ["selector", "filters", "projection", "mutation_payload", "temporal", "value", "count"]
            }
          },
          selector: {
            type: "object",
            additionalProperties: false,
            properties: {
              ids: {
                type: "array",
                items: { type: "string" }
              },
              names: {
                type: "array",
                items: { type: "string" }
              },
              attributes: {
                type: "object",
                additionalProperties: false,
                properties: {
                  no: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
                  nama_motor: { type: "string" },
                  plat: { type: "string" }
                },
                required: ["no", "nama_motor", "plat"]
              }
            },
            required: ["ids", "names", "attributes"]
          },
          filters: {
            type: "object",
            additionalProperties: false,
            properties: {
              nama_motor: { type: "string" },
              nomor_motor: { type: "string" },
              tahun: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              pajak: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              surat: { type: "string" },
              harga_beli: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              harga_jual: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              harga_laku: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              plat: { type: "string" },
              tahun_plat: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              sold: {
                anyOf: [
                  { type: "boolean" },
                  { type: "string", enum: ["all"] },
                  { type: "null" }
                ]
              },
              tanggal_masuk: { anyOf: [{ type: "string" }, { type: "null" }] },
              tanggal_terjual: { anyOf: [{ type: "string" }, { type: "null" }] }
            },
            required: [
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
            ]
          },
          mutation_payload: {
            type: "object",
            additionalProperties: false,
            properties: {
              no: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              nama_motor: { type: "string" },
              tahun: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              plat: { type: "string" },
              surat_surat: { type: "string" },
              tahun_plat: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              pajak: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              harga_jual: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              harga_beli: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              harga_laku: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              sold: {
                anyOf: [
                  { type: "boolean" },
                  { type: "string", enum: ["all"] },
                  { type: "null" }
                ]
              },
              tanggal: { type: "string" },
              tanggal_terjual: { type: "string" },
              keterangan: { type: "string" },
              total_pengeluaran: { anyOf: [{ type: "number" }, { type: "string" }, { type: "null" }] },
              due_at: { type: "string" },
              text: { type: "string" },
              recurrence: { type: "string" }
            },
            required: [
              "no",
              "nama_motor",
              "tahun",
              "plat",
              "surat_surat",
              "tahun_plat",
              "pajak",
              "harga_jual",
              "harga_beli",
              "harga_laku",
              "sold",
              "tanggal",
              "tanggal_terjual",
              "keterangan",
              "total_pengeluaran",
              "due_at",
              "text",
              "recurrence"
            ]
          },
          temporal: {
            type: "object",
            additionalProperties: false,
            properties: {
              preset: {
                anyOf: [
                  { type: "string", enum: ["", "today", "week", "month"] },
                  { type: "null" }
                ]
              },
              last_days: { anyOf: [{ type: "number" }, { type: "null" }] },
              start_date: { anyOf: [{ type: "string" }, { type: "null" }] },
              end_date: { anyOf: [{ type: "string" }, { type: "null" }] },
              raw: { anyOf: [{ type: "string" }, { type: "null" }] }
            },
            required: ["preset", "last_days", "start_date", "end_date", "raw"]
          },
          reference: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: { type: "string", enum: PARSER_REFERENCE_MODES },
              target: { type: "string" }
            },
            required: ["mode", "target"]
          }
        },
        required: [
          "action",
          "entity",
          "metric",
          "availability_state",
          "confidence",
          "correction_type",
          "target_field",
          "new_value",
          "projection",
          "targets",
          "selector",
          "filters",
          "mutation_payload",
          "temporal",
          "reference",
          "user_context",
          "value",
          "count"
        ]
      }
    }
  };
}

function sanitizeMessages(messages) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").trim();
    if (!role) continue;
    if (role === "user" && Array.isArray(m.content)) {
      out.push({ role: "user", content: normalizeUserContent(m.content) });
      continue;
    }
    const normalizedContent = Array.isArray(m.content)
      ? normalizeUserContent(m.content)
      : (typeof m.content === "string" ? m.content : String(m.content === undefined || m.content === null ? "" : m.content));
    if (normalizedContent === "" || normalizedContent === null || normalizedContent === undefined) continue;
    out.push({ role: role, content: normalizedContent });
  }
  return out;
}

function normalizeUserContent(content) {
  if (Array.isArray(content)) {
    const out = [];
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") out.push({ type: "text", text: part.text });
      if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string") out.push({ type: "image_url", image_url: { url: part.image_url.url } });
    }
    return out.length ? out : "";
  }
  return String(content === undefined || content === null ? "" : content);
}

function normalizeSemanticPayload_(parsed, options) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const action = normalizeAction_(src.action);
  const normalized = {
    action: action,
    entity: normalizeText(src.entity),
    metric: normalizeMetric_(src.metric),
    availability_state: normalizeAvailabilityState_(src.availability_state),
    confidence: normalizeConfidence_(src.confidence),
    correction_type: normalizeCorrectionType_(src.correction_type),
    target_field: normalizeText(src.target_field),
    new_value: normalizeNewValue_(src.new_value),
    targets: normalizeSemanticTargets_(src.targets, src.entity),
    selector: normalizeSelector_(src.selector),
    filters: normalizeFilters_(src.filters),
    projection: normalizeFieldList_(src.projection),
    mutation_payload: normalizeData_(src.mutation_payload),
    temporal: normalizeDateRange_(src.temporal),
    reference: normalizeReference_(src.reference),
    context_isolated: false,
    user_context: normalizeUserContext_(src.user_context),
    value: normalizeText(src.value),
    count: normalizeNumberish(src.count)
  };
  return stabilizeSemanticPayload_(normalized, options);
}

function stabilizeSemanticPayload_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {
    action: "chat",
    entity: "general",
    metric: "",
    availability_state: "",
    confidence: 0.5,
    correction_type: "",
    target_field: "",
    new_value: "",
    targets: [],
    selector: normalizeSelector_({}),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_({}),
    temporal: normalizeDateRange_({}),
    reference: normalizeReference_({}),
    context_isolated: false,
    user_context: "",
    value: "",
    count: ""
  };
  const next = JSON.parse(JSON.stringify(current));

  if (next.action === "query" || next.action === "chat") {
    next.mutation_payload = normalizeData_({});
    next.targets = [];
    next.user_context = "";
  }

  if (next.action !== "correction") {
    next.correction_type = "";
    next.target_field = "";
    next.new_value = "";
  }

  if (next.reference && normalizeReferenceMode_(next.reference.mode) !== "last_query" && next.action !== "correction") {
    next.reference = {
      mode: normalizeReferenceMode_(next.reference.mode),
      target: normalizeText(next.reference.target)
    };
  }

  if (!next.metric) {
    if (Array.isArray(next.projection) && next.projection.length) {
      next.metric = "";
    } else if (next.action === "query" && next.entity !== "general" && next.entity !== "sales") {
      next.metric = "list";
    }
  }

  if (next.action === "query" && next.entity === "general" && next.metric === "profit") {
    next.entity = "sales";
  }

  if (next.action === "query" && next.availability_state) {
    next.filters.sold = null;
  }

  applyTemporalCanonicalization_(next, options);
  applyContextIsolation_(next);

  clearSpuriousReferenceInheritance_(next, options);
  applyReferenceProjectionHint_(next, options);
  pruneTemporalSummaryNoise_(next, options);
  next.mutation_payload = repairReminderDraft_(next, options);
  return next;
}

function stabilizeSemanticStructure_(payload, options) {
  const current = payload && typeof payload === "object" ? JSON.parse(JSON.stringify(payload)) : null;
  if (!current) return payload;

  if (
    current.action === "correction"
    && current.reference
    && normalizeReferenceMode_(current.reference.mode) === "last_query"
    && Array.isArray(current.projection)
    && current.projection.length
    && !hasSemanticSelector_(current.selector)
    && !hasSemanticFilters_(current.filters)
    && !hasAnySemanticMutation_(current.mutation_payload)
    && !normalizeText(current.target_field)
    && current.new_value === ""
  ) {
    current.action = "query";
    current.correction_type = "";
    current.target_field = "";
    current.new_value = "";
  }

  if (
    (current.action === "create" || current.action === "update" || current.action === "delete" || current.action === "confirm")
    && !hasSemanticSelector_(current.selector)
    && !hasSemanticFilters_(current.filters)
    && !hasAnySemanticMutation_(current.mutation_payload)
    && hasDateRangeSemantic_(current.temporal)
    && (normalizeMetric_(current.metric) || normalizeText(current.entity).toLowerCase() === "sales" || normalizeText(current.entity).toLowerCase() === "pengeluaran")
  ) {
    current.action = "query";
    current.correction_type = "";
    current.target_field = "";
    current.new_value = "";
  }

  if (
    current.action === "query"
    && (normalizeText(current.entity).toLowerCase() === "motor" || normalizeText(current.entity).toLowerCase() === "general")
    && (!Array.isArray(current.projection) || current.projection.length === 0)
    && !hasAnySemanticMutation_(current.mutation_payload)
    && parseSemanticNumber_(current.filters && current.filters.harga_laku) > 0
    && hasSemanticSelectionAnchor_(current)
  ) {
    current.action = "confirm";
    current.entity = "sales";
    current.mutation_payload = normalizeData_(Object.assign({}, current.mutation_payload, {
      harga_laku: parseSemanticNumber_(current.filters.harga_laku)
    }));
    current.filters = Object.assign({}, current.filters, { harga_laku: "" });
  }

  if (
    (current.action === "confirm" || current.action === "update")
    && normalizeText(current.entity).toLowerCase() === "sales"
    && !hasSemanticSelector_(current.selector)
    && !hasAnySemanticMutation_(current.mutation_payload)
    && hasSemanticFilters_(current.filters)
  ) {
    current.action = "query";
    current.entity = "motor";
    current.metric = normalizeMetric_(current.metric) || "list";
    current.correction_type = "";
  }

  if (
    (current.action === "confirm" || current.action === "update")
    && normalizeReferenceMode_(current.reference && current.reference.mode) === "pending_action"
    && hasAnySemanticMutation_(current.mutation_payload)
    && !hasSemanticSelector_(current.selector)
    && !hasSemanticFilters_(current.filters)
    && (!Array.isArray(current.projection) || current.projection.length === 0)
  ) {
    current.action = "correction";
    current.correction_type = "payload_adjustment";
    current.metric = "";
  }

  if (
    current.action === "query"
    && hasSemanticSelector_(current.selector)
    && Array.isArray(current.projection)
    && current.projection.length
  ) {
    current.metric = "";
  }

  if (
    current.action === "query"
    && normalizeText(current.entity).toLowerCase() === "motor"
    && !hasSemanticSelector_(current.selector)
    && !hasSemanticFilters_(current.filters)
    && (!Array.isArray(current.projection) || current.projection.length === 0)
    && (current.availability_state === "" || current.availability_state === "all")
  ) {
    current.availability_state = "available";
  }

  coerceSuccessfulActionCorrection_(current, options);
  sanitizeCorrectionPayloadAgainstSnapshot_(current, options);

  return current;
}

function repairReminderDraft_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (normalizeText(current.entity).toLowerCase() !== "reminder" || normalizeText(current.action).toLowerCase() !== "reminder") {
    return current.mutation_payload;
  }

  const draft = normalizeData_(current.mutation_payload);
  const seedText = normalizeText((options && options.seedText) || draft.text || current.value);
  const extracted = extractReminderDraft_(seedText, options);
  const needsRepair = !draft.due_at || !draft.text || isReminderDueAtSuspicious_(draft.due_at, options);
  if (!seedText) return draft;
  if (extracted.due_at) draft.due_at = extracted.due_at;
  draft.text = chooseReminderTextCandidate_(draft.text, extracted.text, seedText);
  if (!needsRepair && draft.due_at && draft.text) return draft;
  return draft;
}

function extractReminderDraft_(seedText, options) {
  const text = normalizeText(seedText);
  if (!text) return { due_at: "", text: "" };

  const reminder = { due_at: "", text: text };
  const date = normalizeCurrentDate_(options);
  const lower = text.toLowerCase();

  if (/(^|\s)besok(\s|$)/i.test(lower)) {
    date.setDate(date.getDate() + 1);
  }

  const timeMatch = lower.match(/(?:^|\s)jam\s+(\d{1,2})(?:[:.](\d{1,2}))?(?:\s|$)/i);
  if (timeMatch) {
    const hour = Math.max(0, Math.min(23, Number(timeMatch[1] || 0)));
    const minute = Math.max(0, Math.min(59, Number(timeMatch[2] || 0)));
    date.setHours(hour, minute, 0, 0);
    reminder.due_at = date.toISOString();
    const matchIndex = lower.indexOf(timeMatch[0]);
    const suffix = matchIndex >= 0 ? normalizeText(text.slice(matchIndex + timeMatch[0].length)) : "";
    const stripped = normalizeText(text.replace(timeMatch[0], " "));
    reminder.text = suffix || stripped;
  }

  return reminder;
}

function chooseReminderTextCandidate_(draftText, extractedText, seedText) {
  const current = normalizeText(draftText);
  const extracted = normalizeText(extractedText);
  const seed = normalizeText(seedText);
  if (!current) return extracted;
  if (!extracted) return current;

  const currentComparable = normalizeComparable_(current);
  const extractedComparable = normalizeComparable_(extracted);
  const seedComparable = normalizeComparable_(seed);

  if (currentComparable && currentComparable !== seedComparable) {
    if (!extractedComparable || extractedComparable === seedComparable) return current;
    if (extractedComparable.indexOf(currentComparable) !== -1 && currentComparable.length <= extractedComparable.length) {
      return current;
    }
  }

  if (extractedComparable && extractedComparable !== seedComparable) {
    if (!currentComparable || currentComparable === seedComparable) return extracted;
    if (currentComparable.indexOf(extractedComparable) !== -1 && extractedComparable.length < currentComparable.length) {
      return extracted;
    }
  }

  return current.length <= extracted.length ? current : extracted;
}

function shouldReparseSemanticPayload_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action === "chat" && current.entity === "general") return true;
  if (current.confidence !== null && current.confidence !== undefined && Number(current.confidence) < 0.7) return true;
  if (current.action === "query" && current.entity === "general") return true;
  if (current.action === "query" && current.entity === "motor" && current.availability_state && !current.metric && !hasSemanticSelector_(current.selector) && !hasSemanticFilters_(current.filters) && !current.projection.length) {
    return true;
  }
  if (current.action === "query" && current.entity === "motor" && current.availability_state && current.metric === "list" && !hasSemanticSelector_(current.selector) && !hasSemanticFilters_(current.filters) && !current.projection.length) {
    return true;
  }
  if (current.action === "reminder") {
    const reminder = current.mutation_payload && typeof current.mutation_payload === "object" ? current.mutation_payload : {};
    if (!normalizeText(reminder.due_at) || !normalizeText(reminder.text)) return true;
    if (isReminderDueAtSuspicious_(reminder.due_at)) return true;
  }
  return false;
}

function needsInventoryMetricResolution_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action !== "query") return false;
  if (normalizeText(current.entity).toLowerCase() !== "motor") return false;
  if (!normalizeAvailabilityState_(current.availability_state)) return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasSemanticFilters_(current.filters)) return false;
  if (Array.isArray(current.projection) && current.projection.length) return false;
  const metric = normalizeMetric_(current.metric);
  return metric === "" || metric === "list" || metric === "count";
}

function needsGeneralSemanticRecovery_(payload, seedText) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (!normalizeText(seedText)) return false;
  if (current.action !== "chat") return false;
  return normalizeText(current.entity).toLowerCase() === "general";
}

function needsGenericTaskReview_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action === "chat" && normalizeText(current.entity).toLowerCase() === "general") return true;
  if (current.action === "query" && normalizeText(current.entity).toLowerCase() === "general") return true;
  return false;
}

function needsInventoryListingReview_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  const action = normalizeAction_(current.action);
  const entity = normalizeText(current.entity).toLowerCase();
  if (action !== "chat" && !(action === "query" && entity === "general")) return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasSemanticFilters_(current.filters)) return false;
  if (hasAnySemanticMutation_(current.mutation_payload)) return false;
  if (Array.isArray(current.projection) && current.projection.length) return false;
  if (hasDateRangeSemantic_(current.temporal)) return false;
  const metric = normalizeMetric_(current.metric);
  return !metric || metric === "list" || metric === "count";
}

function applyReferenceProjectionHint_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action !== "query") return;
  if (!Array.isArray(current.projection) || current.projection.length === 0) return;
  if (hasSemanticSelector_(current.selector)) return;
  if (hasSemanticFilters_(current.filters)) return;
  if (hasAnySemanticMutation_(current.mutation_payload)) return;
  if (hasDateRangeSemantic_(current.temporal)) return;
  const metric = normalizeMetric_(current.metric);
  if (metric && metric !== "list") return;
  if (metric === "list") {
    current.metric = "";
  }
  const referenceMode = normalizeReferenceMode_(current.reference && current.reference.mode);
  if (referenceMode === "last_query" || referenceMode === "pending_action") return;

  const snapshot = options && options.sessionSnapshot && typeof options.sessionSnapshot === "object"
    ? options.sessionSnapshot
    : {};
  if (!snapshot.has_last_query || snapshot.invalid_query_context) return;

  current.reference = {
    mode: "last_query",
    target: "previous_query"
  };
  current.context_isolated = false;
  if ((!normalizeText(current.entity) || normalizeText(current.entity).toLowerCase() === "general") && snapshot.last_query && snapshot.last_query.entity) {
    current.entity = normalizeText(snapshot.last_query.entity);
  }
}

function clearSpuriousReferenceInheritance_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action !== "query") return;
  if (normalizeReferenceMode_(current.reference && current.reference.mode) !== "last_query") return;
  if (Array.isArray(current.projection) && current.projection.length) return;
  if (!hasSemanticSelector_(current.selector)) return;

  const snapshot = options && options.sessionSnapshot && typeof options.sessionSnapshot === "object"
    ? options.sessionSnapshot
    : {};
  const lastQuery = snapshot.last_query && typeof snapshot.last_query === "object"
    ? snapshot.last_query
    : null;
  const lastSelector = lastQuery && lastQuery.selector ? lastQuery.selector : null;
  if (!lastSelector) {
    current.reference = { mode: "", target: "" };
    return;
  }
  if (!sameSemanticSelector_(current.selector, lastSelector)) {
    current.reference = { mode: "", target: "" };
  }
}

function coerceSuccessfulActionCorrection_(current, options) {
  const snapshot = options && options.sessionSnapshot && typeof options.sessionSnapshot === "object"
    ? options.sessionSnapshot
    : null;
  if (!snapshot || !snapshot.last_successful_action || Number(snapshot.correction_window_remaining || 0) <= 0) return;
  if (snapshot.has_pending_action) return;
  if (current.action === "correction" || current.action === "query" || current.action === "chat" || current.action === "reminder") return;
  if (Array.isArray(current.projection) && current.projection.length) return;
  if (hasDateRangeSemantic_(current.temporal)) return;

  const successful = snapshot.last_successful_action && typeof snapshot.last_successful_action === "object"
    ? snapshot.last_successful_action
    : null;
  if (!successful) return;
  const successfulEntity = normalizeText(successful.entity).toLowerCase();
  const currentEntity = normalizeText(current.entity).toLowerCase();
  if (!successfulEntity || !currentEntity || !isCorrectionCompatibleEntity_(successfulEntity, currentEntity)) return;

  const successfulSelector = successfulActionSelector_(successful);
  const selectorChanged = hasSemanticSelector_(current.selector) && !sameSemanticSelector_(current.selector, successfulSelector);
  const payloadChanged = hasAnySemanticMutation_(current.mutation_payload);
  const overlapsSuccessful = selectorOverlapsSuccessful_(current.selector, successfulSelector);
  if (!selectorChanged && !payloadChanged) return;
  if (!selectorChanged && !payloadChanged) return;
  if (!selectorChanged && !overlapsSuccessful && !isPayloadOnlySuccessfulCorrectionCandidate_(current, successful)) return;

  current.action = "correction";
  current.metric = "";
  current.reference = { mode: "", target: "" };

  if (selectorChanged) {
    current.correction_type = "selector_replacement";
    current.selector = reduceSelectorToChangedComponents_(current.selector, successfulSelector);
    applyDerivedCorrectionTarget_(current, successfulSelector);
    return;
  }

  current.correction_type = "payload_adjustment";
  applyDerivedCorrectionTarget_(current, successfulSelector);
}

function sanitizeCorrectionPayloadAgainstSnapshot_(current, options) {
  if (!current || typeof current !== "object") return;
  if (current.action !== "correction") return;

  const snapshot = options && options.sessionSnapshot && typeof options.sessionSnapshot === "object"
    ? options.sessionSnapshot
    : {};
  if (!snapshot.has_pending_action && normalizeReferenceMode_(current.reference && current.reference.mode) === "pending_action") {
    current.reference = { mode: "", target: "" };
  }
  const baseSemantic = extractCorrectionBaseSemantic_(snapshot);
  if (!baseSemantic) return;

  const baseSelector = normalizeSelector_(baseSemantic.selector);
  const baseMutation = normalizeData_(baseSemantic.mutation_payload);
  const reducedSelector = reduceSelectorToChangedComponents_(current.selector, baseSelector);
  const changedMutation = reduceChangedMutationFields_(current.mutation_payload, baseMutation);

  if (
    current.correction_type === "selector_replacement"
    && !hasSemanticSelector_(reducedSelector)
    && hasAnySemanticMutation_(changedMutation)
  ) {
    current.correction_type = "payload_adjustment";
    current.selector = emptySemanticSelector_();
    current.filters = {};
    current.projection = [];
    current.metric = "";
    current.mutation_payload = changedMutation;
    if (!normalizeText(current.target_field)) {
      applyDerivedCorrectionTarget_(current, baseSelector);
    }
    if (!normalizeText(current.target_field)) {
      current.target_field = firstSemanticMutationField_(changedMutation);
      current.new_value = current.target_field ? changedMutation[current.target_field] : current.new_value;
    }
    return;
  }

  if (current.correction_type === "selector_replacement") {
    current.selector = reducedSelector;
    current.filters = stripSelectorSemanticFilters_(current.filters);
    current.mutation_payload = stripSelectorSemanticMutationFields_(current.mutation_payload);
    current.metric = "";
    return;
  }

  if (current.correction_type === "payload_adjustment") {
    current.selector = emptySemanticSelector_();
    current.filters = {};
    current.projection = [];
    current.metric = "";
    current.mutation_payload = changedMutation;
    if (!hasAnySemanticMutation_(current.mutation_payload) && normalizeText(current.target_field)) {
      current.mutation_payload = assignSemanticCorrectionField_(current.target_field, current.new_value, current.mutation_payload);
    }
    return;
  }

  if (current.correction_type === "selector_refinement") {
    current.mutation_payload = normalizeData_({});
    current.metric = "";
  }
}

function isCorrectionCompatibleEntity_(successfulEntity, currentEntity) {
  const successful = normalizeText(successfulEntity).toLowerCase();
  const current = normalizeText(currentEntity).toLowerCase();
  if (!successful || !current) return false;
  if (successful === current) return true;
  if ((successful === "sales" && current === "motor") || (successful === "motor" && current === "sales")) return true;
  return false;
}

function extractCorrectionBaseSemantic_(snapshot) {
  const session = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (session.has_last_semantic_payload && session.last_semantic_payload && typeof session.last_semantic_payload === "object") {
    return session.last_semantic_payload;
  }
  if (session.last_successful_action && typeof session.last_successful_action === "object") {
    const successful = session.last_successful_action;
    const payload = successful.payload && typeof successful.payload === "object" ? successful.payload : {};
    return {
      action: normalizeAction_(successful.action),
      entity: normalizeText(successful.entity),
      selector: successfulActionSelector_(successful),
      filters: {},
      projection: [],
      mutation_payload: payload,
      temporal: normalizeDateRange_({}),
      reference: normalizeReference_({})
    };
  }
  return null;
}

function stripSelectorSemanticFilters_(filters) {
  const src = filters && typeof filters === "object" ? JSON.parse(JSON.stringify(filters)) : {};
  delete src.nama_motor;
  delete src.nomor_motor;
  delete src.plat;
  delete src.no;
  return src;
}

function stripSelectorSemanticMutationFields_(payload) {
  const src = normalizeData_(payload);
  src.no = "";
  src.nama_motor = "";
  src.plat = "";
  return src;
}

function reduceChangedMutationFields_(currentPayload, basePayload) {
  const current = normalizeData_(currentPayload);
  const base = normalizeData_(basePayload);
  const next = normalizeData_({});
  Object.keys(current).forEach((key) => {
    const currentValue = current[key];
    if (isSemanticEmptyValue_(currentValue)) return;
    const baseValue = base[key];
    if (sameSemanticPrimitive_(currentValue, baseValue)) return;
    next[key] = currentValue;
  });
  return next;
}

function assignSemanticCorrectionField_(targetField, newValue, payload) {
  const next = normalizeData_(payload);
  const field = normalizeText(targetField).toLowerCase();
  if (!field) return next;
  if ([ "no", "nama_motor", "plat", "tahun", "tahun_plat", "pajak", "harga_jual", "harga_beli", "harga_laku", "tanggal", "tanggal_terjual", "keterangan", "total_pengeluaran", "due_at", "text", "recurrence" ].indexOf(field) === -1) return next;
  next[field] = normalizeFieldCorrectionValue_(field, newValue);
  return next;
}

function normalizeFieldCorrectionValue_(field, value) {
  if ([ "tahun", "tahun_plat", "pajak", "harga_jual", "harga_beli", "harga_laku", "total_pengeluaran" ].indexOf(field) !== -1) {
    return normalizeNumberish(value);
  }
  if (field === "no") return normalizeNumberish(value);
  return normalizeText(value);
}

function sameSemanticPrimitive_(left, right) {
  const a = normalizeComparableValue_(left);
  const b = normalizeComparableValue_(right);
  return a === b;
}

function firstSemanticMutationField_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  const keys = Object.keys(current);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!isSemanticEmptyValue_(current[key])) return key;
  }
  return "";
}

function normalizeComparableValue_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && isFinite(value)) return String(value);
  return normalizeComparable_(value);
}

function isPayloadOnlySuccessfulCorrectionCandidate_(current, successful) {
  const payload = current && typeof current === "object" ? current : {};
  const action = normalizeAction_(payload.action);
  if (!action || action === "query" || action === "chat" || action === "reminder") return false;
  if (hasSemanticSelector_(payload.selector)) return false;
  if (hasSemanticFilters_(payload.filters)) return false;
  if (hasDateRangeSemantic_(payload.temporal)) return false;
  if (Array.isArray(payload.projection) && payload.projection.length) return false;
  if (!hasAnySemanticMutation_(payload.mutation_payload)) return false;

  const successfulPayload = successful && successful.payload && typeof successful.payload === "object"
    ? successful.payload
    : {};
  const changed = reduceChangedMutationFields_(payload.mutation_payload, successfulPayload);
  return hasAnySemanticMutation_(changed);
}

function needsReferenceModeReview_(payload, sessionSnapshot) {
  const current = payload && typeof payload === "object" ? payload : {};
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  if (!snapshot.has_last_query || snapshot.invalid_query_context) return false;
  if (current.action !== "query") return false;
  if (hasAnySemanticMutation_(current.mutation_payload)) return false;
  if (hasDateRangeSemantic_(current.temporal)) return false;
  const metric = normalizeMetric_(current.metric);
  if (metric && metric !== "list") return false;

  const referenceMode = normalizeReferenceMode_(current.reference && current.reference.mode);
  if (referenceMode && referenceMode !== "new_request") return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasSemanticFilters_(current.filters)) return true;
  if (Array.isArray(current.projection) && current.projection.length) return true;
  return false;
}

function needsProjectionFieldReview_(payload, sessionSnapshot) {
  const current = payload && typeof payload === "object" ? payload : {};
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  if (!snapshot.has_last_query || snapshot.invalid_query_context) return false;
  if (current.action !== "query") return false;
  if (Array.isArray(current.projection) && current.projection.length) return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasSemanticFilters_(current.filters)) return false;
  if (hasAnySemanticMutation_(current.mutation_payload)) return false;
  if (hasDateRangeSemantic_(current.temporal)) return false;
  const metric = normalizeMetric_(current.metric);
  return !metric || metric === "list";
}

function projectionFieldCandidates_(sessionSnapshot) {
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  const lastQuery = snapshot.last_query && typeof snapshot.last_query === "object" ? snapshot.last_query : null;
  const entity = normalizeText(lastQuery && lastQuery.entity).toLowerCase();
  if (entity === "pengeluaran") return ["no", "tanggal", "keterangan", "total_pengeluaran"];
  if (entity === "reminder") return ["due_at", "text"];
  return ["no", "nama_motor", "tahun", "plat", "surat_surat", "tahun_plat", "pajak", "harga_beli", "harga_jual", "harga_laku", "sold"];
}

function projectionFieldEntity_(sessionSnapshot, fallbackEntity) {
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  const lastQuery = snapshot.last_query && typeof snapshot.last_query === "object" ? snapshot.last_query : null;
  const entity = normalizeText(lastQuery && lastQuery.entity).toLowerCase();
  return entity || normalizeText(fallbackEntity);
}

function shouldFallbackToLastQueryReference_(payload, sessionSnapshot, classifiedMode) {
  const current = payload && typeof payload === "object" ? payload : {};
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  if (!snapshot.has_last_query || snapshot.invalid_query_context) return false;
  if (normalizeText(classifiedMode).toLowerCase() === "new_request") return false;
  if (current.action !== "query") return false;
  if (hasAnySemanticMutation_(current.mutation_payload)) return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasDateRangeSemantic_(current.temporal)) return false;
  const metric = normalizeMetric_(current.metric);
  if (metric && metric !== "list") return false;
  if (!hasSemanticFilters_(current.filters) && !(Array.isArray(current.projection) && current.projection.length)) return false;
  const lastQuery = snapshot.last_query && typeof snapshot.last_query === "object" ? snapshot.last_query : null;
  const lastEntity = normalizeText(lastQuery && lastQuery.entity).toLowerCase();
  const currentEntity = normalizeText(current.entity).toLowerCase();
  if (!lastEntity) return false;
  if (currentEntity && currentEntity !== "general" && currentEntity !== lastEntity) return false;
  return true;
}

function needsFinancialMetricReview_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action !== "query") return false;
  if (normalizeText(current.entity).toLowerCase() !== "sales") return false;
  if (hasSemanticSelector_(current.selector)) return false;
  if (hasAnySemanticMutation_(current.mutation_payload)) return false;
  const metric = normalizeMetric_(current.metric);
  if (metric && metric !== "profit" && metric !== "revenue") return false;
  return true;
}

function successfulActionSelector_(successfulAction) {
  const action = successfulAction && typeof successfulAction === "object" ? successfulAction : {};
  const payload = action.payload && typeof action.payload === "object" ? action.payload : {};
  const no = normalizeNo(payload.no);
  const name = normalizeText(payload.nama_motor);
  const plat = normalizeText(payload.plat);
  return {
    ids: no ? [no] : [],
    names: name ? [name] : [],
    attributes: {
      no: no,
      nama_motor: name,
      plat: plat
    }
  };
}

function sameSemanticSelector_(left, right) {
  return JSON.stringify(normalizeSemanticSelectorForCompare_(left)) === JSON.stringify(normalizeSemanticSelectorForCompare_(right));
}

function normalizeSemanticSelectorForCompare_(value) {
  const selector = value && typeof value === "object" ? value : {};
  const attrs = selector.attributes && typeof selector.attributes === "object" ? selector.attributes : {};
  return {
    ids: normalizeStringArray_(selector.ids, true),
    names: normalizeStringArray_(selector.names, false).map((item) => normalizeComparable_(item)),
    attributes: {
      no: normalizeNo(attrs.no),
      nama_motor: normalizeComparable_(attrs.nama_motor),
      plat: normalizeComparable_(attrs.plat)
    }
  };
}

function selectorOverlapsSuccessful_(selector, successfulSelector) {
  const current = normalizeSemanticSelectorForCompare_(selector);
  const successful = normalizeSemanticSelectorForCompare_(successfulSelector);
  if (current.attributes.no && current.attributes.no === successful.attributes.no) return true;
  if (current.attributes.nama_motor && current.attributes.nama_motor === successful.attributes.nama_motor) return true;
  if (current.attributes.plat && current.attributes.plat === successful.attributes.plat) return true;
  if (current.ids.some((item) => successful.ids.indexOf(item) !== -1)) return true;
  if (current.names.some((item) => successful.names.indexOf(item) !== -1)) return true;
  return false;
}

function reduceSelectorToChangedComponents_(selector, successfulSelector) {
  const current = normalizeSelector_(selector);
  const successful = normalizeSemanticSelectorForCompare_(successfulSelector);
  const next = {
    ids: [],
    names: [],
    attributes: {
      no: "",
      nama_motor: "",
      plat: ""
    }
  };

  current.ids.forEach((item) => {
    if (successful.ids.indexOf(normalizeNo(item)) === -1) next.ids.push(normalizeNo(item));
  });
  current.names.forEach((item) => {
    if (successful.names.indexOf(normalizeComparable_(item)) === -1) next.names.push(normalizeText(item));
  });
  if (normalizeNo(current.attributes.no) && normalizeNo(current.attributes.no) !== successful.attributes.no) {
    next.attributes.no = normalizeNo(current.attributes.no);
  }
  if (normalizeText(current.attributes.nama_motor) && normalizeComparable_(current.attributes.nama_motor) !== successful.attributes.nama_motor) {
    next.attributes.nama_motor = normalizeText(current.attributes.nama_motor);
  }
  if (normalizeText(current.attributes.plat) && normalizeComparable_(current.attributes.plat) !== successful.attributes.plat) {
    next.attributes.plat = normalizeText(current.attributes.plat);
  }

  if (!hasSemanticSelector_(next)) return current;
  return next;
}

function applyDerivedCorrectionTarget_(payload, successfulSelector) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.correction_type === "payload_adjustment") {
    if (normalizeText(current.target_field)) return;
    const fields = ["harga_laku", "harga_jual", "harga_beli", "total_pengeluaran", "total", "keterangan", "text", "due_at"];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!isSemanticEmptyValue_(current.mutation_payload && current.mutation_payload[field])) {
        current.target_field = field;
        current.new_value = current.mutation_payload[field];
        return;
      }
    }
    return;
  }

  if (current.correction_type !== "selector_replacement") return;
  if (normalizeText(current.target_field)) return;
  const selector = normalizeSelector_(current.selector);
  const successful = normalizeSemanticSelectorForCompare_(successfulSelector);
  if (normalizeNo(selector.attributes.no) && normalizeNo(selector.attributes.no) !== successful.attributes.no) {
    current.target_field = "no";
    current.new_value = normalizeNo(selector.attributes.no);
    return;
  }
  if (normalizeText(selector.attributes.nama_motor) && normalizeComparable_(selector.attributes.nama_motor) !== successful.attributes.nama_motor) {
    current.target_field = "nama_motor";
    current.new_value = normalizeText(selector.attributes.nama_motor);
    return;
  }
  if (normalizeText(selector.attributes.plat) && normalizeComparable_(selector.attributes.plat) !== successful.attributes.plat) {
    current.target_field = "plat";
    current.new_value = normalizeText(selector.attributes.plat);
  }
}

function pruneTemporalSummaryNoise_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action !== "query") return;
  if (normalizeText(current.entity).toLowerCase() !== "sales") return;
  if (normalizeMetric_(current.metric) !== "profit") return;
  if (!hasDateRangeSemantic_(current.temporal)) return;
  if (hasSemanticSelector_(current.selector)) return;

  const filters = current.filters && typeof current.filters === "object" ? current.filters : {};
  const activeKeys = Object.keys(filters).filter((key) => {
    if (key === "sold") return filters[key] === true || filters[key] === false || filters[key] === "all";
    return !isSemanticEmptyValue_(filters[key]);
  });
  if (activeKeys.length !== 1 || activeKeys[0] !== "tahun") return;

  const currentYear = normalizeCurrentDate_(options).getFullYear();
  const leakedYear = Number(parseSemanticNumber_(filters.tahun) || 0);
  if (!leakedYear || leakedYear !== currentYear) return;
  if (Number(current.confidence || 0) >= 0.75) return;

  current.filters.tahun = "";
}

function hasDateRangeSemantic_(temporal) {
  const current = temporal && typeof temporal === "object" ? temporal : {};
  return Boolean(
    normalizeText(current.preset)
    || parseSemanticNumber_(current.last_days) > 0
    || normalizeText(current.start_date)
    || normalizeText(current.end_date)
    || normalizeText(current.raw)
  );
}

function hasSemanticSelectionAnchor_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (hasSemanticSelector_(current.selector)) return true;
  const filters = current.filters && typeof current.filters === "object" ? current.filters : {};
  return Boolean(
    normalizeText(filters.nama_motor)
    || normalizeText(filters.nomor_motor)
    || normalizeText(filters.plat)
  );
}

function hasAnySemanticMutation_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  return Object.keys(current).some((key) => {
    if (key === "sold") return current[key] === true || current[key] === false || current[key] === "all";
    return !isSemanticEmptyValue_(current[key]);
  });
}

function isSemanticEmptyValue_(value) {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.keys(value).every((key) => isSemanticEmptyValue_(value[key]));
  }
  return false;
}

function parseSemanticNumber_(value) {
  const normalized = normalizeNumberish(value);
  return typeof normalized === "number" && isFinite(normalized) ? normalized : 0;
}

function hasSemanticSelector_(selector) {
  const current = selector && typeof selector === "object" ? selector : {};
  const attrs = current.attributes && typeof current.attributes === "object" ? current.attributes : {};
  return Boolean(
    Array.isArray(current.ids) && current.ids.length
    || Array.isArray(current.names) && current.names.length
    || normalizeText(attrs.no)
    || normalizeText(attrs.nama_motor)
    || normalizeText(attrs.plat)
  );
}

function hasSemanticFilters_(filters) {
  const current = filters && typeof filters === "object" ? filters : {};
  return Object.keys(current).some((key) => {
    if (key === "sold") return current[key] === true || current[key] === false || current[key] === "all";
    return normalizeText(current[key]);
  });
}

function isReminderDueAtSuspicious_(value, options) {
  const text = normalizeText(value);
  if (!text) return true;
  const dueAt = new Date(text);
  if (isNaN(dueAt.getTime())) return true;
  const now = normalizeCurrentDate_(options);
  if (dueAt.getFullYear() < now.getFullYear() - 1) return true;
  if (dueAt.getTime() < now.getTime() - (24 * 60 * 60 * 1000)) return true;
  return false;
}

function normalizeCurrentDate_(options) {
  const current = options && options.now instanceof Date && !isNaN(options.now.getTime())
    ? options.now
    : new Date();
  return new Date(current.getTime());
}

function extractSeedText_(userContent) {
  if (typeof userContent === "string") return normalizeText(userContent);
  if (!Array.isArray(userContent)) return "";
  return userContent
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => normalizeText(part.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function currentDateTimeContext_(timezone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone || "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date()).replace(" ", "T");
  } catch (err) {
    return new Date().toISOString();
  }
}

function buildParserSessionContext_(sessionSnapshot, options) {
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  const opts = options && typeof options === "object" ? options : {};
  const isolated = Boolean(opts.isolated);
  const timezone = normalizeText(opts.timezone) || "Asia/Jakarta";
  const preIntentType = normalizeText(opts.preIntentType).toUpperCase() || "QUERY";
  const baseSession = {
    pre_intent_type: preIntentType,
    conversation_state: normalizeText(snapshot.conversation_state),
    has_pending_action: Boolean(snapshot.has_pending_action),
    pending_action_type: normalizeText(snapshot.pending_action_type),
    pending_missing_fields: Array.isArray(snapshot.pending_missing_fields) ? snapshot.pending_missing_fields.slice() : [],
    correction_window_remaining: Number(snapshot.correction_window_remaining || 0),
    last_action_entity: normalizeText(snapshot.last_action_entity),
    invalid_query_context: Boolean(snapshot.invalid_query_context),
    invalid_query_reason: normalizeText(snapshot.invalid_query_reason),
    has_last_reference_targets: Boolean(snapshot.has_last_reference_targets),
    last_reference_targets: Array.isArray(snapshot.last_reference_targets) ? snapshot.last_reference_targets.slice() : []
  };

  if (isolated) {
    return {
      timezone: timezone,
      current_datetime: currentDateTimeContext_(timezone),
      context_mode: "isolated",
      session: baseSession
    };
  }

  return {
    timezone: timezone,
    current_datetime: currentDateTimeContext_(timezone),
    context_mode: "referential",
    session: Object.assign({}, snapshot, baseSession)
  };
}

function applyContextIsolation_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  const mode = normalizeReferenceMode_(current.reference && current.reference.mode);
  const isolated = mode !== "last_query" && mode !== "pending_action";
  current.context_isolated = isolated;
  if (isolated && current.action !== "correction" && current.action !== "chat" && shouldDefaultToNewRequestReference_(current)) {
    current.reference = {
      mode: "new_request",
      target: ""
    };
  }
}

function applyTemporalCanonicalization_(payload, options) {
  const current = payload && typeof payload === "object" ? payload : {};
  current.temporal = normalizeDateRange_(current.temporal);
  const extracted = extractRelativeDayWindow_(options && options.seedText);
  if (extracted <= 0) return;
  current.temporal.last_days = extracted;
  if (!normalizeText(current.temporal.start_date) && !normalizeText(current.temporal.end_date)) {
    current.temporal.preset = "";
  }
  if (!normalizeText(current.temporal.raw) && normalizeText(options && options.seedText)) {
    current.temporal.raw = normalizeText(options.seedText);
  }
}

function extractRelativeDayWindow_(seedText) {
  const text = normalizeText(seedText).toLowerCase();
  if (!text) return 0;
  const patterns = [
    /\blast\s+(\d{1,3})\s+days?\b/i,
    /\b(\d{1,3})\s+days?\b(?:\s+last)?/i,
    /\b(\d{1,3})\s+hari\b(?:\s+terakhir)?/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (!match) continue;
    const value = parseSemanticNumber_(match[1]);
    if (value > 0) return value;
  }
  return 0;
}

function shouldDefaultToNewRequestReference_(payload) {
  const current = payload && typeof payload === "object" ? payload : {};
  if (current.action === "create" || current.action === "update" || current.action === "delete" || current.action === "confirm" || current.action === "reminder") {
    return true;
  }
  if (current.action !== "query") return false;
  if (hasSemanticSelector_(current.selector)) return true;
  if (hasDateRangeSemantic_(current.temporal)) return true;
  const metric = normalizeMetric_(current.metric);
  if (metric && metric !== "list") return true;
  const entity = normalizeText(current.entity).toLowerCase();
  if (entity === "sales" || entity === "pengeluaran" || entity === "global_summary" || entity === "reminder") return true;
  return false;
}

function normalizeConfidence_(value) {
  if (typeof value === "number" && isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return 0.5;
}

function normalizeCorrectionType_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_CORRECTION_TYPES.indexOf(raw) !== -1 ? raw : "";
}

function normalizeNewValue_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && isFinite(value)) return value;
  return normalizeNumberish(value);
}

function normalizeAction_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_ACTIONS.indexOf(raw) !== -1 ? raw : "chat";
}

function normalizeMetric_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_METRICS.indexOf(raw) !== -1 ? raw : "";
}

function normalizeAvailabilityState_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_AVAILABILITY_STATES.indexOf(raw) !== -1 ? raw : "";
}

function normalizeUserContext_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_USER_CONTEXTS.indexOf(raw) !== -1 ? raw : "";
}

function normalizeReferenceMode_(value) {
  const raw = normalizeText(value).toLowerCase();
  return PARSER_REFERENCE_MODES.indexOf(raw) !== -1 ? raw : "";
}

function normalizeReference_(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    mode: normalizeReferenceMode_(src.mode),
    target: normalizeText(src.target)
  };
}

function normalizeSelector_(value) {
  const src = value && typeof value === "object" ? value : {};
  const attrs = src.attributes && typeof src.attributes === "object" ? src.attributes : {};
  return {
    ids: normalizeStringArray_(src.ids, true),
    names: normalizeStringArray_(src.names, false),
    attributes: {
      no: normalizeNumberish(attrs.no),
      nama_motor: normalizeText(attrs.nama_motor),
      plat: normalizeText(attrs.plat)
    }
  };
}

function emptySemanticSelector_() {
  return normalizeSelector_({});
}

function normalizeStringArray_(value, numericOnly) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = numericOnly ? normalizeNo(list[i]) : normalizeText(list[i]);
    if (item && out.indexOf(item) === -1) out.push(item);
  }
  return out;
}

function normalizeSemanticTargets_(value, entity) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => normalizeSemanticTarget_(item, entity))
    .filter(Boolean);
}

function normalizeSemanticTarget_(value, entity) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  const normalized = {
    selector: normalizeSelector_(src.selector),
    filters: normalizeFilters_(src.filters),
    projection: normalizeFieldList_(src.projection || src.fields),
    mutation_payload: normalizeData_(src.mutation_payload !== undefined ? src.mutation_payload : src.payload),
    temporal: normalizeDateRange_(src.temporal),
    value: normalizeText(src.value),
    count: normalizeNumberish(src.count)
  };
  if (!hasSemanticSelector_(normalized.selector)
    && !hasSemanticFilters_(normalized.filters)
    && !(Array.isArray(normalized.projection) && normalized.projection.length)
    && !hasAnySemanticMutation_(normalized.mutation_payload)
    && !hasDateRangeSemantic_(normalized.temporal)
    && !normalized.value
    && !normalized.count) {
    return null;
  }
  return normalized;
}

function normalizeFieldList_(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const token = normalizeText(list[i]).toLowerCase();
    if (token && out.indexOf(token) === -1) out.push(token);
  }
  return out;
}

function normalizeFilters_(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    nama_motor: normalizeText(src.nama_motor),
    nomor_motor: normalizeNo(src.nomor_motor),
    tahun: normalizeNumberish(src.tahun),
    pajak: normalizeNumberish(src.pajak),
    surat: normalizeText(src.surat),
    harga_beli: normalizeNumberish(src.harga_beli),
    harga_jual: normalizeNumberish(src.harga_jual),
    harga_laku: normalizeNumberish(src.harga_laku),
    plat: normalizeText(src.plat),
    tahun_plat: normalizeNumberish(src.tahun_plat),
    sold: normalizeBooleanish(src.sold),
    tanggal_masuk: normalizeText(src.tanggal_masuk),
    tanggal_terjual: normalizeText(src.tanggal_terjual)
  };
}

function normalizeDateRange_(value) {
  const src = value && typeof value === "object" ? value : {};
  const normalized = {
    preset: normalizeText(src.preset),
    last_days: normalizeNumberish(src.last_days),
    start_date: normalizeText(src.start_date),
    end_date: normalizeText(src.end_date),
    raw: normalizeText(src.raw)
  };
  if (parseSemanticNumber_(normalized.last_days) > 0 && !normalized.start_date && !normalized.end_date) {
    normalized.preset = "";
  }
  return normalized;
}

function normalizeData_(value) {
  const src = value && typeof value === "object" ? value : {};
  return {
    no: normalizeNumberish(src.no),
    nama_motor: normalizeText(src.nama_motor),
    tahun: normalizeNumberish(src.tahun),
    plat: normalizeText(src.plat),
    surat_surat: normalizeText(src.surat_surat),
    tahun_plat: normalizeNumberish(src.tahun_plat),
    pajak: normalizeNumberish(src.pajak),
    harga_jual: normalizeNumberish(src.harga_jual),
    harga_beli: normalizeNumberish(src.harga_beli),
    harga_laku: normalizeNumberish(src.harga_laku),
    sold: normalizeBooleanish(src.sold),
    tanggal: normalizeText(src.tanggal),
    tanggal_terjual: normalizeText(src.tanggal_terjual),
    keterangan: normalizeText(src.keterangan),
    total_pengeluaran: normalizeNumberish(src.total_pengeluaran),
    due_at: normalizeText(src.due_at),
    text: normalizeText(src.text),
    recurrence: normalizeText(src.recurrence)
  };
}

function normalizeBooleanish(value) {
  if (value === true || value === false) return value;
  if (value === "all") return "all";
  if (value === null || value === undefined || value === "") return null;
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return null;
  if (raw === "all") return "all";
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function normalizeNumberish(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && isFinite(value)) return value;
  const n = parseFlexibleNumber_(value);
  return n === null ? normalizeText(value) : n;
}

function parseFlexibleNumber_(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/rp\.?/g, " ").replace(/idr/g, " ").replace(/\s+/g, " ").trim();
  const factor = { triliun: 1e12, t: 1e12, miliar: 1e9, milyar: 1e9, b: 1e9, juta: 1e6, jt: 1e6, ribu: 1e3, rb: 1e3, k: 1e3 };
  let total = 0;
  let found = false;
  const re = /(-?\d+(?:[.,]\d+)?)\s*(triliun|miliar|milyar|juta|jt|ribu|rb|k|t|b)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = parseLocaleNumber_(m[1]);
    if (num !== null) {
      total += num * (factor[String(m[2]).toLowerCase()] || 1);
      found = true;
    }
  }
  if (found) return Math.round(total);
  return parseLocaleNumber_(text);
}

function parseLocaleNumber_(value) {
  let s = String(value === undefined || value === null ? "" : value).trim().replace(/[^0-9,.\-]/g, "");
  if (!s) return null;
  const dot = s.indexOf(".") !== -1;
  const comma = s.indexOf(",") !== -1;
  if (dot && comma) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  else if (dot && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((x) => {
      if (!x || typeof x !== "object") return "";
      if (typeof x.text === "string") return x.text;
      if (typeof x.content === "string") return x.content;
      return "";
    }).join("").trim();
  }
  return "";
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (err) { return {}; }
}

function normalizeNo(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^0-9]/g, "");
}

function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
}

function normalizeComparable_(value) {
  return normalizeText(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUserText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\r/g, "").trim();
}

function enrichSemanticPayloadWithPreparedData_(payload, prepared, sessionSnapshot, timezone) {
  const current = normalizeSemanticPayload_(payload, {
    seedText: prepared && prepared.plainText,
    timezone: timezone || "Asia/Jakarta",
    now: new Date(),
    sessionSnapshot: sessionSnapshot || {}
  });
  const rawLines = prepared && Array.isArray(prepared.lineTargets) ? prepared.lineTargets : [];
  if (rawLines.length && (current.action === "create" || current.action === "update" || current.action === "delete" || current.action === "confirm")) {
    const builtTargets = buildSemanticTargetsFromLines_(rawLines, current, sessionSnapshot, timezone || "Asia/Jakarta");
    if (builtTargets.length) {
      current.targets = builtTargets;
      if (!hasAnySemanticMutation_(current.mutation_payload) && builtTargets.length === 1) {
        current.mutation_payload = normalizeData_(builtTargets[0].mutation_payload);
      }
    }
  }
  return stabilizeSemanticStructure_(current, {
    seedText: prepared && prepared.plainText,
    timezone: timezone || "Asia/Jakarta",
    now: new Date(),
    sessionSnapshot: sessionSnapshot || {}
  });
}

function interpretUserTurn_(plainText, sessionSnapshot) {
  const text = normalizeText(plainText);
  const normalized = normalizeDirectiveText_(text);
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  const messageType = classifyUserMessageType_(text, snapshot);
  if (!text) return { messageType: "QUERY", semanticPayload: null, prefaceApology: false };

  if (messageType === "CONFIRMATION" && snapshot.has_pending_action) {
    return {
      messageType: messageType,
      semanticPayload: buildPendingDirectivePayload_(snapshot, "force_execute"),
      prefaceApology: false
    };
  }

  if (snapshot.has_pending_action && isCancelDirective_(normalized)) {
    return {
      messageType: "CORRECTION",
      semanticPayload: buildPendingDirectivePayload_(snapshot, "cancel_pending"),
      prefaceApology: false
    };
  }

  if (messageType === "RESET") {
    return {
      messageType: messageType,
      semanticPayload: buildResetDirectivePayload_(snapshot),
      prefaceApology: true
    };
  }

  if (messageType === "RECHECK") {
    return {
      messageType: messageType,
      semanticPayload: buildResultRecheckPayload_(snapshot),
      prefaceApology: false
    };
  }

  if (messageType === "CORRECTION" && hasRepairableContext_(snapshot)) {
    return {
      messageType: messageType,
      semanticPayload: buildCorrectionDirectivePayload_(snapshot),
      prefaceApology: true
    };
  }

  return { messageType: messageType, semanticPayload: null, prefaceApology: false };
}

function extractConversationDirective_(plainText, sessionSnapshot) {
  const interpreted = interpretUserTurn_(plainText, sessionSnapshot);
  return {
    semanticPayload: interpreted.semanticPayload,
    prefaceApology: interpreted.prefaceApology
  };
}

function buildPendingDirectivePayload_(snapshot, userContext) {
  const pendingType = normalizeText(snapshot && snapshot.pending_action_type).toLowerCase();
  const parts = pendingType.split(":");
  const action = normalizeAction_(parts[0] || "chat");
  const entity = normalizeText(parts[1] || snapshot && snapshot.last_action_entity || "general");
  return {
    action: action,
    entity: entity || "general",
    metric: "",
    availability_state: "",
    confidence: 1,
    correction_type: "",
    target_field: "",
    new_value: "",
    targets: [],
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_({}),
    temporal: normalizeDateRange_({}),
    reference: {
      mode: "pending_action",
      target: "pending_action"
    },
    user_context: normalizeUserContext_(userContext),
    value: "",
    count: ""
  };
}

function buildResetDirectivePayload_(snapshot) {
  const referenceMode = snapshot && snapshot.has_pending_action ? "pending_action" : "last_query";
  return {
    action: "correction",
    entity: normalizeText(snapshot && snapshot.last_action_entity) || "general",
    metric: "",
    availability_state: "",
    confidence: 1,
    correction_type: "full_query_reset",
    target_field: "",
    new_value: "",
    targets: [],
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_({}),
    temporal: normalizeDateRange_({}),
    reference: {
      mode: referenceMode,
      target: referenceMode === "pending_action" ? "pending_action" : "previous_query"
    },
    user_context: referenceMode === "pending_action" ? "reset_flow" : "",
    value: "",
    count: ""
  };
}

function buildCorrectionDirectivePayload_(snapshot) {
  const hasActionReceipt = Boolean(snapshot && snapshot.last_action_receipt);
  const hasQueryContext = Boolean(snapshot && snapshot.last_query_context);
  const entity = normalizeText(
    snapshot && snapshot.last_action_entity
    || snapshot && snapshot.last_query_context && snapshot.last_query_context.entity
    || "general"
  );
  const referenceMode = snapshot && snapshot.has_pending_action
    ? "pending_action"
    : (hasQueryContext ? "last_query" : "new_request");
  const target = hasActionReceipt ? "previous_action" : (hasQueryContext ? "previous_query" : "");
  return {
    action: "correction",
    entity: entity || "general",
    metric: "",
    availability_state: "",
    confidence: 1,
    correction_type: "",
    target_field: "",
    new_value: "",
    targets: [],
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_({}),
    temporal: normalizeDateRange_({}),
    reference: {
      mode: referenceMode,
      target: target
    },
    user_context: "",
    value: "",
    count: ""
  };
}

function buildResultRecheckPayload_(snapshot) {
  const hasActionReceipt = Boolean(snapshot && snapshot.last_action_receipt);
  const hasQueryContext = Boolean(snapshot && snapshot.last_query_context);
  return {
    action: "correction",
    entity: normalizeText(
      snapshot && snapshot.last_action_entity
      || snapshot && snapshot.last_query_context && snapshot.last_query_context.entity
      || "general"
    ) || "general",
    metric: "",
    availability_state: "",
    confidence: 1,
    correction_type: "",
    target_field: "",
    new_value: "",
    targets: [],
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_({}),
    temporal: normalizeDateRange_({}),
    reference: {
      mode: hasQueryContext ? "last_query" : "new_request",
      target: hasActionReceipt ? "previous_action" : "previous_query"
    },
    user_context: "",
    value: "",
    count: ""
  };
}

function extractStructuredTargets_(plainText) {
  const text = String(plainText || "").replace(/\r/g, "");
  const lines = text.split("\n").map((line) => normalizeText(line)).filter(Boolean);
  if (lines.length < 2) return [];
  const direct = lines.filter((line) => !/^transkrip voice admin:$/i.test(line));
  const trimmedHead = shouldDropCollectionHeader_(direct) ? direct.slice(1) : direct.slice(1);
  const directScore = scoreStructuredLineSet_(direct);
  const tailScore = shouldDropCollectionHeader_(direct) ? directScore + 1 : scoreStructuredLineSet_(trimmedHead);
  return tailScore >= directScore ? trimmedHead : direct;
}

function scoreStructuredLineSet_(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return list.reduce((sum, line) => {
    const text = normalizeText(line);
    if (!text) return sum;
    if (text.length > 80) return sum;
    return sum + 1;
  }, 0);
}

function buildSemanticTargetsFromLines_(lines, semanticPayload, sessionSnapshot, timezone) {
  const list = Array.isArray(lines) ? lines : [];
  const current = semanticPayload && typeof semanticPayload === "object" ? semanticPayload : {};
  const entity = normalizeText(current.entity).toLowerCase();
  const action = normalizeAction_(current.action);
  const targets = [];
  for (let i = 0; i < list.length; i++) {
    const line = normalizeText(list[i]);
    if (!line) continue;
    let target = null;
    if (entity === "pengeluaran") target = buildExpenseTargetFromLine_(line, current, timezone);
    else if (entity === "sales") target = buildSalesTargetFromLine_(line, current);
    else target = buildMotorTargetFromLine_(line, current, action, sessionSnapshot);
    if (target) targets.push(target);
  }
  return targets;
}

function buildMotorTargetFromLine_(line, current, action, sessionSnapshot) {
  const text = stripListPrefix_(line);
  if (!text) return null;
  const basePayload = normalizeData_(current && current.mutation_payload);
  const target = {
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_(basePayload),
    temporal: normalizeDateRange_({}),
    value: "",
    count: ""
  };
  const noMatch = text.match(/\b(?:no|nomor)\s*([0-9]{1,6})\b/i);
  if (noMatch) {
    target.selector.attributes.no = normalizeNumberish(noMatch[1]);
  }
  const yearMatches = text.match(/\b(19[0-9]{2}|20[0-9]{2})\b/g) || [];
  if (action === "create" && yearMatches.length) {
    target.mutation_payload.tahun = normalizeNumberish(yearMatches[0]);
  }
  const stripped = text
    .replace(/\b(?:no|nomor)\s*[0-9]{1,6}\b/gi, " ")
    .replace(/\b(19[0-9]{2}|20[0-9]{2})\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (action === "create") {
    if (!stripped) return null;
    target.mutation_payload.nama_motor = stripped;
    return target;
  }
  if (target.selector.attributes.no) return target;
  if (stripped) {
    target.selector.names = [stripped];
    target.selector.attributes.nama_motor = stripped;
    if (action === "confirm") {
      const price = parseTrailingPrice_(text);
      if (price > 0) target.mutation_payload.harga_laku = price;
    }
    return target;
  }
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  if (snapshot.has_pending_action) return target;
  return null;
}

function buildExpenseTargetFromLine_(line, current, timezone) {
  const text = stripListPrefix_(line);
  if (!text) return null;
  const basePayload = normalizeData_(current && current.mutation_payload);
  const payload = normalizeData_(Object.assign({}, basePayload));
  const price = parseTrailingPrice_(text);
  const label = normalizeText(stripTrailingPrice_(text));
  if (!label && !price) return null;
  if (label) payload.keterangan = label;
  if (price > 0) payload.total_pengeluaran = price;
  if (!normalizeText(payload.tanggal)) {
    payload.tanggal = currentDateTimeContext_(timezone || "Asia/Jakarta").slice(0, 10);
  }
  return {
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: payload,
    temporal: normalizeDateRange_({}),
    value: "",
    count: ""
  };
}

function buildSalesTargetFromLine_(line, current) {
  const text = stripListPrefix_(line);
  if (!text) return null;
  const target = {
    selector: emptySemanticSelector_(),
    filters: normalizeFilters_({}),
    projection: [],
    mutation_payload: normalizeData_(current && current.mutation_payload),
    temporal: normalizeDateRange_({}),
    value: "",
    count: ""
  };
  const noMatch = text.match(/\b(?:no|nomor)\s*([0-9]{1,6})\b/i);
  if (noMatch) target.selector.attributes.no = normalizeNumberish(noMatch[1]);
  const price = parseTrailingPrice_(text);
  if (price > 0) target.mutation_payload.harga_laku = price;
  const label = normalizeText(
    stripTrailingPrice_(
      text.replace(/\b(?:no|nomor)\s*[0-9]{1,6}\b/gi, " ")
    )
  );
  if (label) {
    target.selector.names = [label];
    target.selector.attributes.nama_motor = label;
  }
  return hasSemanticSelector_(target.selector) || hasAnySemanticMutation_(target.mutation_payload)
    ? target
    : null;
}

function buildPendingBootstrap_(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  if (current.action !== "create") return null;
  const entity = normalizeText(current.entity).toLowerCase();
  const targets = Array.isArray(current.targets) ? current.targets : [];
  if (targets.length <= 1) return null;

  const payloads = targets
    .map((item) => normalizeData_(item && item.mutation_payload))
    .filter((item) => Object.keys(item).length > 0);
  if (payloads.length <= 1) return null;

  if (entity === "motor") {
    const incomplete = payloads
      .map((item) => missingMotorFieldsForDraft_(item))
      .filter((item) => item.length > 0);
    if (!incomplete.length) return null;
    const unionMissing = uniqueValues_(incomplete.flat());
    return {
      pendingAction: {
        action: "create",
        entity: "motor",
        payload: payloads,
        missingFields: unionMissing,
        semanticPayload: cloneSemantic_(current)
      },
      reply: buildDraftConfirmationReply_("motor", unionMissing)
    };
  }

  if (entity === "pengeluaran") {
    const incomplete = payloads
      .map((item) => missingExpenseFieldsForDraft_(item))
      .filter((item) => item.length > 0);
    if (!incomplete.length) return null;
    const unionMissing = uniqueValues_(incomplete.flat());
    return {
      pendingAction: {
        action: "create",
        entity: "pengeluaran",
        payload: payloads,
        missingFields: unionMissing,
        semanticPayload: cloneSemantic_(current)
      },
      reply: buildDraftConfirmationReply_("pengeluaran", unionMissing)
    };
  }

  return null;
}

function stripListPrefix_(value) {
  return normalizeText(value).replace(/^(?:[-*•]|\d+[.)])\s*/, "").trim();
}

function parseTrailingPrice_(value) {
  const match = String(value || "").match(/((?:rp\.?\s*)?-?\d[\d.,\s]*(?:triliun|miliar|milyar|juta|jt|ribu|rb|k|t|b)?)(?!.*(?:rp\.?\s*)?-?\d)/i);
  if (!match) return 0;
  return parseFlexibleNumber_(match[1]) || 0;
}

function stripTrailingPrice_(value) {
  return normalizeText(String(value || "").replace(/((?:rp\.?\s*)?-?\d[\d.,\s]*(?:triliun|miliar|milyar|juta|jt|ribu|rb|k|t|b)?)(?!.*(?:rp\.?\s*)?-?\d)/i, " "));
}

function normalizeDirectiveText_(value) {
  return normalizeText(value).toLowerCase().replace(/[.!?,]+/g, " ").replace(/\s+/g, " ").trim();
}

function classifyUserMessageType_(plainText, sessionSnapshot) {
  const text = normalizeText(plainText);
  const normalized = normalizeDirectiveText_(text);
  const snapshot = sessionSnapshot && typeof sessionSnapshot === "object" ? sessionSnapshot : {};
  if (!text) return "QUERY";
  if (isResetDirective_(normalized)) return "RESET";
  if (snapshot.has_pending_action && isConfirmationDirective_(normalized)) return "CONFIRMATION";
  if (isResultRecheckDirective_(normalized) && (snapshot.last_query_context || snapshot.last_action_receipt)) return "RECHECK";
  if (isCorrectionLikeDirective_(normalized) && hasRepairableContext_(snapshot)) return "CORRECTION";
  if (isQuestionLikeText_(text)) return "QUERY";
  if (String(text || "").indexOf("\n") !== -1) return "COMMAND";
  return "COMMAND";
}

function isConfirmationDirective_(value) {
  const normalized = normalizeDirectiveText_(value);
  return [ "iya", "ya", "ok", "oke", "lanjut", "simpan", "gas", "y" ].indexOf(normalized) !== -1;
}

function isCancelDirective_(value) {
  const normalized = normalizeDirectiveText_(value);
  return [ "batal", "cancel", "ga jadi", "gak jadi", "jangan jadi" ].indexOf(normalized) !== -1;
}

function isResetDirective_(value) {
  const normalized = normalizeDirectiveText_(value);
  return [
    "bukan",
    "salah",
    "bukan itu",
    "bukan itu maksudku",
    "bukan maksudku",
    "bukan yang ini",
    "maksudku"
  ].indexOf(normalized) !== -1;
}

function isCorrectionLikeDirective_(value) {
  const normalized = normalizeDirectiveText_(value);
  if (!normalized) return false;
  return [
    "bukan",
    "salah",
    "bukan itu",
    "bukan maksudku",
    "bukan itu maksudku",
    "bukan yang ini",
    "maksudku"
  ].indexOf(normalized) !== -1;
}

function isResultRecheckDirective_(value) {
  const normalized = normalizeDirectiveText_(value);
  if (!normalized) return false;
  if ([
    "kok cuma dua",
    "kok cuma satu",
    "mana yang lain",
    "yang lain mana",
    "yang lainnya",
    "emangnya cuma segitu"
  ].indexOf(normalized) !== -1) return true;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length > 8) return false;
  if (/^kok\b/i.test(normalized) && /\bcuma\b/i.test(normalized)) return true;
  if (/\blain(?:nya)?\b/i.test(normalized) && /\b(mana|yang)\b/i.test(normalized)) return true;
  if (/^harusnya\b/i.test(normalized) && /\b(ada|lebih|kurang|cuma|segitu)\b/i.test(normalized)) return true;
  return false;
}

function hasRepairableContext_(snapshot) {
  const current = snapshot && typeof snapshot === "object" ? snapshot : {};
  return Boolean(current.has_pending_action || current.last_action_receipt || current.last_query_context);
}

function isQuestionLikeText_(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (/[?？]$/.test(text)) return true;
  const normalized = normalizeDirectiveText_(text);
  return /\b(berapa|apa|mana|kok|kenapa|yang)\b/i.test(normalized);
}

function buildLowConfidenceMutationReply_(parsed) {
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const action = normalizeAction_(current.action);
  if ([ "create", "update", "delete", "confirm" ].indexOf(action) === -1) return "";
  if (Number(current.confidence || 0) >= 0.6) return "";

  const entity = normalizeText(current.entity).toLowerCase();
  if (entity === "pengeluaran") {
    return "Saya belum cukup yakin data pengeluaran yang dimaksud. Tolong jelaskan lagi keterangannya dan nominalnya.";
  }
  if (entity === "motor" || entity === "sales") {
    return "Saya belum cukup yakin data motor yang dimaksud. Tolong jelaskan lagi nama motor, nomor, atau perubahan yang ingin disimpan.";
  }
  return "Saya belum cukup yakin data yang dimaksud. Tolong jelaskan lagi sebelum saya menjalankan perubahan.";
}

function shouldDropCollectionHeader_(lines) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (list.length < 2) return false;
  const first = normalizeText(list[0]);
  if (!first || /\d/.test(first)) return false;
  const firstWordCount = first.split(/\s+/).filter(Boolean).length;
  if (firstWordCount < 2) return false;
  const rest = list.slice(1);
  if (!rest.length) return false;
  const shortRest = rest.every((line) => normalizeText(line).split(/\s+/).filter(Boolean).length <= 4);
  return shortRest;
}

function missingMotorFieldsForDraft_(payload) {
  const current = normalizeData_(payload);
  const required = [
    ["tahun", "TAHUN"],
    ["plat", "PLAT"],
    ["surat_surat", "SURAT-SURAT"],
    ["tahun_plat", "TAHUN PLAT"],
    ["pajak", "PAJAK"],
    ["harga_jual", "HARGA JUAL"],
    ["harga_beli", "HARGA BELI"]
  ];
  return required
    .filter(([key]) => isSemanticEmptyValue_(current[key]))
    .map(([, label]) => label);
}

function missingExpenseFieldsForDraft_(payload) {
  const current = normalizeData_(payload);
  const required = [
    ["keterangan", "KETERANGAN"],
    ["total_pengeluaran", "TOTAL PENGELUARAN"]
  ];
  return required
    .filter(([key]) => isSemanticEmptyValue_(current[key]))
    .map(([, label]) => label);
}

function buildDraftConfirmationReply_(entity, missingFields) {
  const labels = Array.isArray(missingFields) ? missingFields.filter(Boolean) : [];
  const title = entity === "pengeluaran"
    ? "Data pengeluaran belum lengkap."
    : "Data motor belum lengkap.";
  return [
    title,
    "",
    "Field kosong:",
    labels.length ? labels.join("\n") : "-",
    "",
    "Apakah mau langsung disimpan?",
    "Balas: iya",
    "",
    "Atau isi saja field yang masih kosong."
  ].join("\n");
}

function cloneSemantic_(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function uniqueValues_(values) {
  const list = Array.isArray(values) ? values : [];
  return list.filter((item, index) => item && list.indexOf(item) === index);
}

function sanitizeFileName(value) {
  const raw = String(value || "").trim() || "voice-note.ogg";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildAudioFileName(mimeType) {
  const mime = String(mimeType || "audio/ogg").toLowerCase();
  if (mime.indexOf("mpeg") !== -1 || mime.indexOf("mp3") !== -1) return "voice-note.mp3";
  if (mime.indexOf("wav") !== -1) return "voice-note.wav";
  if (mime.indexOf("mp4") !== -1 || mime.indexOf("m4a") !== -1) return "voice-note.m4a";
  return "voice-note.ogg";
}

function isRetryableOpenAIError(err) {
  const status = Number(err && err.response && err.response.status ? err.response.status : 0);
  const code = String(err && err.code ? err.code : "").toUpperCase();
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (code === "ECONNABORTED") return true;
  if (code === "ETIMEDOUT") return true;
  if (code === "ECONNRESET") return true;
  return false;
}

function historyUserLabel_(prepared) {
  const src = prepared && typeof prepared === "object" ? prepared : {};
  const text = String(src.plainText || "").trim();
  if (text) return text;
  if (src.hasImage) return "[gambar]";
  if (src.hasAudio) return "[voice]";
  return "[pesan]";
}

function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

module.exports = AIAgent;
