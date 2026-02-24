# WA Bot VPS (Bot Sendiri -> Apps Script)

Project ini difokuskan ke arsitektur:
- Bot WA sendiri di VPS (Baileys)
- Data dikirim ke Apps Script
- Apps Script yang menulis ke Google Sheet

## 1. Setup
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
WA_SESSION_DIR=./auth_info_baileys
ALLOW_GROUP_MESSAGES=false
```

Jalankan:
```bash
npm start
```

Scan QR di terminal:
`WhatsApp > Linked devices > Link a device`.

## 2. Kebutuhan Apps Script
Apps Script web app harus:
1. Deploy Web App (`/exec`).
2. Menerima POST JSON:
```json
{ "sender": "", "message": "input#..." }
```
3. Menulis data ke sheet.
4. Balikkan response:
- `OK_SAVED_ROW_<n>` untuk sukses simpan/update
- `ERROR_<pesan>` untuk error

Catatan:
- Balasan WA dikirim oleh bot VPS.
- Di Apps Script tidak perlu kirim balasan WA lagi.

## 3. Format pesan WA

### Input stok (`input#`)
```text
input#nama motor;tahun;plat;surat-surat;tahun plat;pajak;harga jual;harga laku;harga beli;tgl terjual;status
```

### Input label
```text
NAMA MOTOR: Vario 125
TAHUN: 2022
PLAT: B1234XYZ
SURAT-SURAT: Lengkap hidup
TAHUN PLAT: 2027
PAJAK: Hidup
HARGA JUAL: 22500000
HARGA BELI: 19000000
```

### Update (`update#`)
```text
update#7;22500000;21000000;;terjual
```
Urutan: `update#no;harga jual;harga laku;tgl terjual;status`

### Update label
```text
NO: 7
HARGA LAKU: 21000000
STATUS: terjual
```

## 4. Logika
- Input stok boleh ada field kosong.
- Jika `HARGA LAKU` terisi, `STATUS` otomatis centang.
- Jika update `HARGA LAKU` tanpa `TGL TERJUAL`, tanggal otomatis hari ini.
