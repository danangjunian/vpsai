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
ADMIN_NUMBERS=628123456789,628777777777
BOT_NUMBER=201507007785
WA_SESSION_DIR=./auth_info_baileys
ALLOW_GROUP_MESSAGES=false
ALLOW_SELF_CHAT_MESSAGES=true
DEBUG_WA_FILTER=false
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
{
  "sender": "62812xxxx@s.whatsapp.net",
  "chat_jid": "62812xxxx@s.whatsapp.net",
  "bot_jid": "201507007785@s.whatsapp.net",
  "from_me": "0",
  "message": "input#..."
}
```
3. Menulis data ke sheet.
4. Balikkan response:
- `OK_SAVED_ROW_<n>` untuk sukses simpan/update
- `ERROR_<pesan>` untuk error

Catatan:
- Balasan WA dikirim oleh bot VPS.
- Di Apps Script tidak perlu kirim balasan WA lagi.
- Jika ingin filter sumber WA di Apps Script, set `BOT_WA_NUMBER` di file `appscript`.

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

### Cek data motor (`data motor`)
```text
data motor vixion
cek data motor vixion
```
Bot akan mengembalikan daftar motor yang nama motornya mengandung keyword tersebut.

### Motor masuk 2 tahap (`motor masuk`)
```text
motor masuk
```
Alur:
1. Bot kirim template label.
2. Admin isi template dan kirim.
3. Bot kirim ringkasan + minta konfirmasi.
4. Admin kirim `OK` untuk simpan atau `BATAL` untuk membatalkan.

### Motor terjual pilih daftar (`motor <nama> laku`)
```text
motor vixion laku
```
Alur:
1. Bot kirim daftar kandidat motor sesuai nama.
2. Admin pilih item dengan format `no <pilihan> laku <harga>`.
3. Bot minta konfirmasi `OK / BATAL`.
4. Jika `OK`, bot kirim update ke Apps Script:
   `update#no;;harga laku;;terjual`
   (tanggal terjual otomatis diisi Apps Script jika kosong).

## 4. Logika
- Input stok boleh ada field kosong.
- Jika `HARGA LAKU` terisi, `STATUS` otomatis centang.
- Jika update `HARGA LAKU` tanpa `TGL TERJUAL`, tanggal otomatis hari ini.
- Hanya `ADMIN_NUMBERS` yang boleh memproses data.
- Self chat bot (`sender == BOT_NUMBER` dan tujuan `BOT_NUMBER`) boleh diproses jika `ALLOW_SELF_CHAT_MESSAGES=true`.
- Pesan bot ke nomor lain tidak diproses ke spreadsheet.
- Pesan non-admin tidak diproses.
- Untuk melihat alasan pesan di-skip/proses, set `DEBUG_WA_FILTER=true` lalu cek log bot.

## 5. Uji Keamanan Step 1
- Admin kirim `input#...` ke bot: harus diproses dan tersimpan.
- Non-admin kirim `input#...` ke bot: bot diam, data tidak tersimpan.
- Bot kirim `input#...` ke nomor lain: tidak diproses, data tidak tersimpan.
