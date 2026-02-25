# WA Bot VPS (Bridge ke Apps Script)

VPS ini hanya berfungsi sebagai:
- penerima pesan WA (Baileys / Webhook),
- forward pesan ke Apps Script,
- pengirim balasan WA.

Semua parsing, validasi, session, dan logic bisnis ada di `appscript`.

## Arsitektur
- `wa-bot-vps/src/messageProcessor.js`:
  forward text mentah ke Apps Script via `dataService.executeText(...)`.
  Jika reply `perintah tidak dikenali/format salah`, bisa fallback ke AI text normalizer (opsional).
- `wa-bot-vps/src/appScriptService.js`:
  client HTTP ke endpoint Web App (`/exec`), termasuk fallback GET bila POST tidak diterima.
- `wa-bot-vps/src/baileysMode.js`:
  koneksi WhatsApp, filter admin/self, dan scheduler reminder pengeluaran harian.
- `wa-bot-vps/src/webhookMode.js`:
  mode opsional jika memakai webhook provider.

## Setup
```bash
cd wa-bot-vps
npm install
cp .env.example .env
```

Isi `.env`:
```env
BOT_MODE=BAILEYS
APPS_SCRIPT_WEBHOOK_URL=https://script.google.com/macros/s/xxxx/exec
APPS_SCRIPT_TIMEOUT_MS=15000
ADMIN_NUMBERS=628123456789,628777777777
BOT_NUMBER=201507007785
WA_SESSION_DIR=./auth_info_baileys
ALLOW_GROUP_MESSAGES=false
ALLOW_SELF_CHAT_MESSAGES=true
DEBUG_WA_FILTER=false
DAILY_EXPENSE_REMINDER_ENABLED=true
DAILY_EXPENSE_REMINDER_TIME=22:00
DAILY_EXPENSE_REMINDER_TZ=Asia/Jakarta
HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_HOST=127.0.0.1
HEALTH_SERVER_PORT=3100
APPSCRIPT_MONITOR_ENABLED=true
APPSCRIPT_MONITOR_INTERVAL_SEC=180
APPSCRIPT_MONITOR_FAILURE_THRESHOLD=3
APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC=900
APPSCRIPT_MONITOR_EXIT_ON_FAILURE=false
AI_TEXT_ENABLED=false
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_MS=15000
AI_TEXT_MIN_CONFIDENCE=0.55
AI_TEXT_DEBUG=false
```

Jalankan:
```bash
npm start
```

## Kebutuhan Apps Script
- Web App harus sudah deploy (`/exec`) dan bisa diakses.
- `doPost/doGet` menerima payload berikut:
```json
{
  "sender": "62812xxxx@s.whatsapp.net",
  "chat_jid": "62812xxxx@s.whatsapp.net",
  "bot_jid": "201507007785@s.whatsapp.net",
  "from_me": "0",
  "message": "menu"
}
```
- Response utama yang dipakai VPS:
  - `reply`: teks balasan ke WA.
  - `ok`, `row`, `error`, `saveResult` bila ada operasi simpan/update.

## Catatan Operasional
- Command format user dikelola penuh di `appscript`.
- Jika menambah/mengubah command, update di Apps Script saja (umumnya tanpa ubah VPS).
- Untuk arsitektur bridge ini, Apps Script sebaiknya `ENABLE_WA_REPLY=false` agar tidak double-reply.

## AI Text Fallback (Opsional)
- Mode ini dipakai jika user kirim kalimat bebas dan Apps Script membalas `perintah tidak dikenali` atau `format salah`.
- VPS akan minta OpenAI untuk menormalkan kalimat menjadi command whitelist, lalu kirim ulang ke Apps Script.
- Jika AI nonaktif atau confidence rendah, bot tetap pakai reply asli dari Apps Script.

## PM2 (disarankan)
```bash
pm2 start src/index.js --name wa-bot
pm2 save
pm2 startup
```

Atau pakai ecosystem config (lebih stabil untuk production):
```bash
pm2 startOrRestart ecosystem.config.js --only wa-bot
pm2 save
pm2 startup
```

Detail policy PM2 ada di `wa-bot-vps/ecosystem.config.js`:
- autorestart aktif
- restart delay dan backoff
- max memory restart `300M`
- timestamp log aktif

Monitoring:
```bash
pm2 status
pm2 logs wa-bot --lines 100
```

Smoke test Apps Script:
```bash
npm run smoke:appscript
```

UAT Step 9 (regression non-destruktif):
```bash
npm run uat:step9
```

## Apps Script Monitor (Alert Admin)
- Monitor kirim probe `menu` berkala ke Apps Script.
- Jika gagal beruntun sesuai threshold, bot kirim alert ke semua `ADMIN_NUMBERS`.
- Opsi `APPSCRIPT_MONITOR_EXIT_ON_FAILURE=true` akan `process.exit(1)` agar PM2 auto-restart.

Konfigurasi monitor:
```env
APPSCRIPT_MONITOR_ENABLED=true
APPSCRIPT_MONITOR_INTERVAL_SEC=180
APPSCRIPT_MONITOR_FAILURE_THRESHOLD=3
APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC=900
APPSCRIPT_MONITOR_EXIT_ON_FAILURE=false
```

## Health Check
Endpoint health server terpisah dari mode bot utama:
- `GET /health` status proses dan status WA terakhir.
- `GET /health/appscript` probe koneksi ke Apps Script (`menu`).

Contoh:
```bash
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/health/appscript
```
