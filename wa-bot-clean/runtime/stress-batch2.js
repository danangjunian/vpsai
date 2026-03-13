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
const progressPath = path.join(runtimeDir, 'stress-batch2-progress.log');
const resultsPath = path.join(runtimeDir, 'stress-batch2-results.json');
const reminderStorePath = path.join(runtimeDir, 'stress-batch2-reminders.json');
const outLogPath = path.join(runtimeDir, 'stress-batch2-run.out.log');
const errLogPath = path.join(runtimeDir, 'stress-batch2-run.err.log');
const startIndex = Math.max(1, Number(process.env.STRESS_START || 1) || 1);
const endIndexInput = Math.max(startIndex, Number(process.env.STRESS_END || 150) || 150);
const appendMode = String(process.env.STRESS_APPEND || '').trim() === '1';

if (!appendMode || startIndex === 1) {
  fs.writeFileSync(progressPath, '', 'utf8');
  try { if (fs.existsSync(reminderStorePath)) fs.unlinkSync(reminderStorePath); } catch (_) {}
  try { if (fs.existsSync(outLogPath)) fs.unlinkSync(outLogPath); } catch (_) {}
  try { if (fs.existsSync(errLogPath)) fs.unlinkSync(errLogPath); } catch (_) {}
}

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
  fs.appendFileSync(outLogPath, text + '\n', 'utf8');
};
console.error = (...args) => {
  const text = args.map((x) => typeof x === 'string' ? x : safeStringify(x)).join(' ');
  if (text.startsWith('APPS_SCRIPT_ERROR:')) return;
  fs.appendFileSync(errLogPath, text + '\n', 'utf8');
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
  const cases = [];
  let id = 1;
  const push = (query, phone, category) => cases.push({ id: id++, query, phone, category });
  const uniquePhone = (n) => '628991' + String(100000 + n).slice(-6);

  const basic = [
    'berapa stok motor sekarang',
    'ada berapa motor yang ready',
    'jumlah unit motor tersedia',
    'berapa motor yang sudah laku',
    'motor apa saja yang ready',
    'tampilkan semua stok motor',
    'daftar semua motor',
    'motor yang tersedia sekarang',
    'total unit motor di gudang',
    'stok motor sekarang ada berapa',
    'lihat daftar motor',
    'tampilkan stok yang ada',
    'berapa unit motor tersedia',
    'apa saja motor yang belum laku',
    'jumlah stok motor',
    'stok motor ready',
    'motor apa saja yang belum terjual',
    'tampilkan semua motor yang ready',
    'daftar unit yang belum laku',
    'unit motor tersedia'
  ];
  basic.forEach((q, i) => push(q, uniquePhone(id + i), 'basic_query'));

  const attr = [
    'motor pajak 2030','motor yang pajaknya 2030','motor dengan pajak tahun 2030','motor tahun 2019','motor yang tahun 2019',
    'motor beat','lihat motor beat','motor vario','motor vario yang pajaknya 2030','motor beat tahun 2018',
    'motor plat S','motor yang platnya S','motor dengan surat lengkap hidup','motor yang suratnya lengkap hidup','motor dengan harga jual 7 juta',
    'motor harga jual 7 juta','motor harga beli 4 juta','motor yang harga belinya 4 juta','motor tahun plat 2030','motor yang tahun platnya 2030',
    'motor beat pajak 2030','motor vario pajak 2025','motor beat tahun 2019','motor vario tahun 2019','motor plat L'
  ];
  attr.forEach((q, i) => push(q, uniquePhone(id + i), 'attribute_filter'));

  const byNumber = [
    'motor nomor 7','motor no 7','motor nomor 7 pajaknya berapa','motor nomor 7 tahun berapa','motor nomor 7 harga belinya berapa',
    'motor nomor 7 harga jualnya berapa','motor nomor 12','motor nomor 12 pajak berapa','motor nomor 12 tahun berapa','motor nomor 12 suratnya apa',
    'motor nomor 15','motor nomor 15 pajaknya','motor nomor 15 harga jual','motor nomor 15 harga beli','motor nomor 15 tahun'
  ];
  byNumber.forEach((q, i) => push(q, uniquePhone(id + i), 'selector_by_number'));

  const followups = [
    ['motor vario','yang ini pajaknya berapa','yang tahun berapa','harga belinya berapa'],
    ['motor beat','yang pajaknya berapa','yang ini tahun berapa','yang ini harga jualnya'],
    ['motor vario','yang tahun 2019','yang pajaknya berapa'],
    ['motor beat','yang pajaknya 2030','yang ini harga jualnya berapa'],
    ['motor vario','yang tahun berapa','yang harga jualnya berapa'],
    ['motor beat','yang ini pajaknya','yang tahun platnya']
  ];
  followups.forEach((series, idx) => {
    const phone = '628992' + String(200000 + idx).slice(-6);
    series.forEach((q) => push(q, phone, 'followup_context'));
  });

  const mutationInput = [
    'input pengeluaran rokok 20k','beli bensin 30k','pengeluaran kopi 15k','input pengeluaran parkir 5k','beli oli 40k',
    'input pengeluaran makan 25k','beli bensin 50k','input pengeluaran servis 100k','beli air minum 10k','pengeluaran parkir 2000',
    'motor masuk beat 2019','motor masuk vario 2020','tambah motor beat 2018','tambah motor vario 2017','input motor beat',
    'motor masuk beat','motor masuk vario','tambah motor baru beat','tambah motor baru vario','input motor baru'
  ];
  mutationInput.forEach((q, i) => push(q, uniquePhone(id + i), 'mutation_input'));

  const mutationCorrection = [
    ['input pengeluaran rokok 20k','bukan 20k, 25k'],
    ['beli bensin 30k','bukan bensin, solar'],
    ['motor vario laku 7 juta','bukan 7 juta, 6 juta'],
    ['motor beat laku 5 juta','bukan beat, vario'],
    ['input pengeluaran kopi 15k','bukan kopi, teh'],
    ['beli bensin 40k','bukan 40k, 35k'],
    ['motor vario laku 8 juta','bukan 8 juta, 7 juta','bukan itu maksudku']
  ];
  mutationCorrection.forEach((series, idx) => {
    const phone = '628993' + String(300000 + idx).slice(-6);
    series.forEach((q) => push(q, phone, 'mutation_correction'));
  });

  const contextSwitch = [
    'motor vario','berapa stok motor sekarang','motor beat','keuntungan minggu ini','motor pajak 2030',
    'berapa motor yang sudah laku','motor nomor 7','total pengeluaran hari ini','motor beat','berapa stok sekarang',
    'motor vario','daftar reminder','motor nomor 10','pengeluaran 3 hari','stok motor sekarang'
  ];
  contextSwitch.forEach((q) => push(q, '628994000001', 'context_switch'));

  const reminder = [
    'ingatkan aku jam 9 makan','daftar reminder','ingatkan aku jam 10 minum obat','ingatkan aku besok beli bensin','ingatkan aku jam 7 olahraga',
    'reminder apa saja','lihat reminder','ingatkan aku jam 6 bangun','ingatkan aku jam 8 sarapan','tampilkan reminder'
  ];
  reminder.forEach((q) => push(q, '628995000001', 'reminder'));

  const temporal = [
    'keuntungan minggu ini','profit 7 hari','laba 7 hari terakhir','total pengeluaran hari ini','pengeluaran 3 hari',
    'pengeluaran minggu ini','berapa hasil penjualan minggu ini','total laba minggu ini','keuntungan bulan ini','pengeluaran bulan ini'
  ];
  temporal.forEach((q, i) => push(q, uniquePhone(id + i), 'temporal_metric'));

  return cases;
}

async function main() {
  appendProgress('START batch 2 range ' + startIndex + '-' + endIndexInput);

  const apps = new AppsScriptClient({
    webhookUrl: process.env.APPS_SCRIPT_WEBHOOK_URL,
    timeoutMs: Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000),
    internalApiKey: process.env.APPS_SCRIPT_INTERNAL_API_KEY
  });

  let fakeMotorNo = 10000;
  let fakeExpenseNo = 8000;
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
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 20000),
    timezone: 'Asia/Jakarta',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    resolver,
    maxHistoryMessages: 40
  });

  const allCases = buildCases();
  const endIndex = Math.min(endIndexInput, allCases.length);
  const cases = allCases.slice(startIndex - 1, endIndex);
  const prior = appendMode && fs.existsSync(resultsPath)
    ? JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
    : { results: [] };
  const results = Array.isArray(prior.results) ? prior.results.slice() : [];

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
    appendProgress('DONE ' + item.id + '/150 | ' + item.category + ' | ' + item.query + ' | ' + (record.error ? ('ERROR: ' + record.error.message) : ('REPLY: ' + String(record.reply || '').replace(/\s+/g, ' ').slice(0, 160))));
    fs.writeFileSync(resultsPath, JSON.stringify({ finished: false, completed: item.id, total: allCases.length, results }, null, 2), 'utf8');
    if (i < cases.length - 1) await sleep(2500);
  }

  fs.writeFileSync(resultsPath, JSON.stringify({ finished: endIndex >= allCases.length, completed: endIndex, total: allCases.length, results }, null, 2), 'utf8');
  appendProgress('FINISHED batch 2 range ' + startIndex + '-' + endIndex);
}

main().catch((err) => {
  appendProgress('FATAL ' + String(err && err.message ? err.message : err));
  try {
    fs.writeFileSync(resultsPath, JSON.stringify({ finished: false, fatal: String(err && err.message ? err.message : err) }, null, 2), 'utf8');
  } catch (_) {}
  process.exitCode = 1;
});
