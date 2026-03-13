require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const AppsScriptClient = require('../src/services/appsScriptClient');
const ReminderService = require('../src/services/reminderService');
const ToolExecutor = require('../src/services/toolExecutor');
const ConversationEngine = require('../src/services/conversationEngine');
const ResolverEngine = require('../src/services/resolverEngine');
const AIAgent = require('../src/agent/aiAgent');

const runtimeDir = __dirname;
const progressPath = path.join(runtimeDir, 'stress-batch1-progress.log');
const resultsPath = path.join(runtimeDir, 'stress-batch1-results.json');
const reminderStorePath = path.join(runtimeDir, 'stress-batch1-reminders.json');

fs.writeFileSync(progressPath, '', 'utf8');
try { if (fs.existsSync(reminderStorePath)) fs.unlinkSync(reminderStorePath); } catch (_) {}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = (...args) => {
  const text = args.map((x) => typeof x === 'string' ? x : safeStringify(x)).join(' ');
  if (
    text.startsWith('APPS_SCRIPT_') ||
    text.startsWith('TOOL CALLED:') ||
    text.startsWith('TOOL RESULT:') ||
    text.startsWith('TOOL ERROR:') ||
    text.startsWith('OPENAI REQUEST:')
  ) {
    return;
  }
  originalConsoleLog(...args);
};
console.error = (...args) => {
  const text = args.map((x) => typeof x === 'string' ? x : safeStringify(x)).join(' ');
  if (text.startsWith('APPS_SCRIPT_ERROR:')) return;
  originalConsoleError(...args);
};

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (err) { return String(v); }
}

function appendProgress(line) {
  fs.appendFileSync(progressPath, '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCases() {
  const mk = (id, query, phone, category) => ({ id, query, phone, category });
  return [
    mk(1, 'motor vario', '6289900000001', 'query_motor'),
    mk(2, 'lihat motor beat', '6289900000002', 'query_motor'),
    mk(3, 'motor apa saja yang ada', '6289900000003', 'query_motor'),
    mk(4, 'tampilkan semua stok motor', '6289900000004', 'query_motor'),
    mk(5, 'berapa stok motor sekarang', '6289900000005', 'stok'),
    mk(6, 'motor apa saja yang ready', '6289900000006', 'stok'),
    mk(7, 'stok motor yang belum terjual', '6289900000007', 'stok'),
    mk(8, 'motor pajak 2030', '6289900000008', 'filter_motor'),
    mk(9, 'motor tahun 2019', '6289900000009', 'filter_motor'),
    mk(10, 'motor yang suratnya lengkap hidup', '6289900000010', 'filter_motor'),
    mk(11, 'motor harga jual 7 juta', '6289900000011', 'filter_motor'),
    mk(12, 'motor harga beli 4 juta', '6289900000012', 'filter_motor'),
    mk(13, 'motor yang platnya S', '6289900000013', 'filter_motor'),
    mk(14, 'motor yang tahun platnya 2030', '6289900000014', 'filter_motor'),
    mk(15, 'motor vario tahun 2019', '6289900000015', 'multi_filter'),
    mk(16, 'motor beat pajak 2030', '6289900000016', 'multi_filter'),
    mk(17, 'lihat data motor beat dan vario', '6289900000017', 'multi_query'),
    mk(18, 'motor nomor 17', '6289900000018', 'query_nomor'),
    mk(19, 'motor no 12', '6289900000019', 'query_nomor'),
    mk(20, 'motor nomor 7 pajaknya berapa', '6289900000020', 'query_nomor'),
    mk(21, 'motor nomor 10 suratnya apa', '6289900000021', 'query_nomor'),
    mk(22, 'motor nomor 15 tahun berapa', '6289900000022', 'query_nomor'),
    mk(23, 'motor yang sudah terjual', '6289900000023', 'penjualan_query'),
    mk(24, 'berapa motor yang sudah laku', '6289900000024', 'penjualan_query'),
    mk(25, 'motor terjual minggu ini', '6289900000025', 'penjualan_query'),
    mk(26, 'motor yang laku hari ini', '6289900000026', 'penjualan_query'),
    mk(27, 'apa saja motor yang sudah laku', '6289900000027', 'penjualan_query'),
    mk(28, 'keuntungan minggu ini', '6289900000028', 'keuangan'),
    mk(29, 'profit 7 hari', '6289900000029', 'keuangan'),
    mk(30, 'berapa keuntungan 3 hari ini', '6289900000030', 'keuangan'),
    mk(31, 'pendapatan dari penjualan minggu ini', '6289900000031', 'keuangan'),
    mk(32, 'laba dari penjualan 7 hari terakhir', '6289900000032', 'keuangan'),
    mk(33, 'pengeluaran hari ini', '6289900000033', 'pengeluaran_query'),
    mk(34, 'berapa total pengeluaran minggu ini', '6289900000034', 'pengeluaran_query'),
    mk(35, 'input pengeluaran rokok 20k', '6289900000035', 'pengeluaran_input'),
    mk(36, 'input pengeluaran kopi 15k', '6289900000036', 'pengeluaran_input'),
    mk(37, 'beli bensin 30k', '6289900000037', 'pengeluaran_input'),
    mk(38, 'motor masuk vario 2019 pajak 2030 harga 7 juta beli 6 juta', '6289900000038', 'motor_input'),
    mk(39, 'tambah motor vario tahun 2019', '6289900000039', 'motor_input'),
    mk(40, 'langsung input saja', '6289900000039', 'motor_input_followup'),
    mk(41, 'motor vario laku 7 juta', '6289900000041', 'confirm_sale'),
    mk(42, 'edit harga jual motor vario jadi 7 juta', '6289900000042', 'edit_motor'),
    mk(43, 'motor vario', '6289900000043', 'followup_context'),
    mk(44, 'yang ini pajaknya berapa', '6289900000043', 'followup_context'),
    mk(45, 'harga belinya berapa', '6289900000043', 'followup_context'),
    mk(46, 'tahun berapa', '6289900000043', 'followup_context'),
    mk(47, 'ingatkan aku jam 9 makan', '6289900000047', 'reminder'),
    mk(48, 'daftar reminder', '6289900000047', 'reminder'),
    mk(49, 'bukan itu maksudku', '6289900000043', 'correction'),
    mk(50, 'maksudku yang lain', '6289900000043', 'correction')
  ];
}

async function main() {
  appendProgress('START batch 1');

  const apps = new AppsScriptClient({
    webhookUrl: process.env.APPS_SCRIPT_WEBHOOK_URL,
    timeoutMs: Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000),
    internalApiKey: process.env.APPS_SCRIPT_INTERNAL_API_KEY
  });

  let fakeMotorNo = 9000;
  let fakeExpenseNo = 7000;
  apps.insertMotor = async (payload) => ({ status: 'success', simulated: true, data: { no: String(++fakeMotorNo), nama_motor: String(payload && payload.nama_motor || '') } });
  apps.updateMotor = async (payload) => ({ status: 'success', simulated: true, data: { no: String(payload && payload.no || ''), updated: true } });
  apps.deleteMotor = async (payload) => ({ status: 'success', simulated: true, data: { no: String(payload && payload.no || ''), deleted: true } });
  apps.confirmSold = async (payload) => ({ status: 'success', simulated: true, data: { no: String(payload && payload.no || ''), confirmed: true, harga_laku: payload && payload.harga_laku } });
  apps.insertPengeluaran = async (payload) => ({ status: 'success', simulated: true, data: { no: String(++fakeExpenseNo), tanggal: String(payload && payload.tanggal || ''), keterangan: String(payload && payload.keterangan || ''), total_pengeluaran: payload && payload.total_pengeluaran } });
  apps.updatePengeluaran = async (payload) => ({ status: 'success', simulated: true, data: { no: String(payload && payload.no || ''), updated: true } });

  const reminderService = new ReminderService({
    sendText: async () => true,
    timezone: process.env.DAILY_REMINDER_TZ || 'Asia/Jakarta',
    dailyTime: process.env.DAILY_REMINDER_TIME || '23:00',
    dailyTargets: process.env.DAILY_REMINDER_TARGETS || '',
    filePath: reminderStorePath
  });

  const toolExecutor = new ToolExecutor({ appsScriptClient: apps, reminderService });
  const conversationEngine = new ConversationEngine();
  const resolver = new ResolverEngine({
    toolExecutor,
    appsScriptClient: apps,
    reminderService,
    timezone: 'Asia/Jakarta',
    conversationEngine
  });
  const ai = new AIAgent({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 15000),
    timezone: 'Asia/Jakarta',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    resolver,
    maxHistoryMessages: 40
  });

  const cases = buildCases();
  const results = [];

  for (let i = 0; i < cases.length; i++) {
    const item = cases[i];
    const startedAt = Date.now();
    const context = {
      userPhone: item.phone,
      chatPhone: item.phone,
      userText: item.query,
      hasImage: false,
      hasAudio: false,
      mediaError: '',
      inputKind: 'text'
    };

    const record = {
      id: item.id,
      category: item.category,
      phone: item.phone,
      query: item.query,
      startedAt: new Date(startedAt).toISOString()
    };

    try {
      const prepared = await ai.prepareUserTurn({ userPhone: item.phone, chatPhone: item.phone, text: item.query });
      record.prepared = {
        hasUsableInput: prepared.hasUsableInput,
        directReply: prepared.directReply || '',
        plainText: prepared.plainText || '',
        inputKind: prepared.inputKind || 'text'
      };
      if (prepared.directReply) {
        record.reply = String(prepared.directReply || '');
        ai.pushHistory(item.phone, { role: 'assistant', content: record.reply });
      } else if (!prepared.hasUsableInput) {
        record.reply = '';
      } else {
        context.userText = prepared.plainText;
        const sessionBefore = resolver.getSessionSnapshot(context);
        const recentHistory = ai.getHistory(item.phone).slice(-8);
        const parsed = await ai.parseSemanticQuery(prepared.openaiContent, context, sessionBefore, recentHistory);
        record.sessionBefore = sessionBefore;
        record.parsed = parsed;
        const resolved = await resolver.resolve(parsed, context);
        record.resolved = resolved;
        if (resolved && resolved.handled) {
          record.reply = String(resolved.reply || '').trim();
          ai.pushHistory(item.phone, { role: 'user', content: item.query });
          ai.pushHistory(item.phone, { role: 'assistant', content: record.reply });
        } else {
          const chatReply = await ai.generateGeneralChatReply(item.phone, prepared.openaiContent, resolver.getSessionSnapshot(context), recentHistory);
          record.reply = String(chatReply || '').trim();
          record.fallbackChat = true;
          ai.pushHistory(item.phone, { role: 'user', content: item.query });
          ai.pushHistory(item.phone, { role: 'assistant', content: record.reply });
        }
        record.sessionAfter = resolver.getSessionSnapshot(context);
      }
    } catch (err) {
      record.error = {
        message: String(err && err.message ? err.message : err),
        stack: String(err && err.stack ? err.stack : '')
      };
    }

    record.durationMs = Date.now() - startedAt;
    results.push(record);
    appendProgress('DONE ' + item.id + '/50 | ' + item.category + ' | ' + item.query + ' | ' + (record.error ? ('ERROR: ' + record.error.message) : ('REPLY: ' + String(record.reply || '').replace(/\s+/g, ' ').slice(0, 160))));
    fs.writeFileSync(resultsPath, JSON.stringify({ finished: false, completed: i + 1, total: cases.length, results }, null, 2), 'utf8');
    if (i < cases.length - 1) await sleep(2500);
  }

  fs.writeFileSync(resultsPath, JSON.stringify({ finished: true, completed: cases.length, total: cases.length, results }, null, 2), 'utf8');
  appendProgress('FINISHED batch 1');
}

main().catch((err) => {
  appendProgress('FATAL ' + String(err && err.message ? err.message : err));
  try {
    fs.writeFileSync(resultsPath, JSON.stringify({ finished: false, fatal: String(err && err.message ? err.message : err) }, null, 2), 'utf8');
  } catch (_) {}
  process.exitCode = 1;
});
