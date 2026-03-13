# WA Bot Clean v2

Arsitektur murni AI Agent:
- AI adalah controller utama (OpenAI tool-calling).
- VPS hanya menerima pesan, eksekusi tool, dan mengirim balasan.
- Spreadsheet adalah sumber data tunggal melalui Apps Script.
- Tidak ada routing manual berbasis `switch(...)` atau keyword parser.

## Backup deploy-ready dari VPS lama

Backup yang sudah dibuat dan di-download:
- `backup_legacy/vps-downloads/wa-bot-clean-v1-deploy-20260228-183711.tar.gz`
- `backup_legacy/vps-downloads/wa-bot-clean-v1-deploy-20260228-183711.tar.gz.sha256`

Checksum SHA256:
- `52c9ddde87dc8f423e90eacdae4e83c9d326681765731b05d43b8202b7b9caa8`

## Deploy ke VPS baru (restore dari backup)

### 1) Siapkan server
```bash
sudo apt update
sudo apt install -y curl tar
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2) Upload file backup ke VPS baru
Jalankan dari lokal:
```bash
scp backup_legacy/vps-downloads/wa-bot-clean-v1-deploy-20260228-183711.tar.gz root@IP_VPS_BARU:/opt/
scp backup_legacy/vps-downloads/wa-bot-clean-v1-deploy-20260228-183711.tar.gz.sha256 root@IP_VPS_BARU:/opt/
```

### 3) Verifikasi checksum di VPS baru
```bash
cd /opt
sha256sum -c wa-bot-clean-v1-deploy-20260228-183711.tar.gz.sha256
```
Output harus `OK`.

### 4) Restore project
```bash
cd /opt
tar -xzf wa-bot-clean-v1-deploy-20260228-183711.tar.gz
cd /opt/wa-bot-clean-v1
```

### 5) Install dependency + jalankan PM2
```bash
cd /opt/wa-bot-clean-v1
npm install --omit=dev
pm2 start src/index.js --name wa-bot-clean
pm2 save
pm2 startup
```

### 6) Verifikasi service
```bash
pm2 list
pm2 logs wa-bot-clean --lines 100
```

## Catatan penting
- Backup ini membawa konfigurasi runtime dari VPS lama (termasuk `.env`).
- Jika pindah nomor bot atau endpoint baru, edit `.env` lalu restart:
```bash
pm2 restart wa-bot-clean --update-env
```
- Jika ingin login WhatsApp ulang, hapus session lama:
```bash
rm -rf /opt/wa-bot-clean-v1/runtime/baileys-session
pm2 restart wa-bot-clean
```
