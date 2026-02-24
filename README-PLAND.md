AGENDA PROYEK BOT WHATSAPP ARJUN MOTOR (REVISI)

KONDISI AWAL:
	•	Spreadsheet + Google Apps Script sudah jalan (input stok & update terjual sudah bisa).
	•	VPS Ubuntu sudah ada.
	•	Bot WA engine sudah/akan dipakai.
	•	Fokus: tambah fitur bertahap, satu per satu, setiap step wajib dites dulu.

==================================================
ATURAN KEAMANAN BARU (WAJIB)
	•	Data HANYA boleh diproses jika:
	1.	Pesan dikirim oleh NOMOR ADMIN yang terdaftar, ATAU
	2.	Pesan dikirim oleh BOT ke NOMOR BOT itu sendiri (self-message untuk automasi internal)
	•	Data TIDAK BOLEH diproses jika:
	•	Bot mengirim pesan ke nomor lain (meskipun formatnya valid)
	•	Orang lain / nomor non-admin kirim pesan dengan format valid
	•	Implementasi:
	•	Buat whitelist:
	•	adminNumbers = [nomor_admin_1, nomor_admin_2, …]
	•	botNumber = nomor_bot
	•	Saat pesan masuk:
	•	Jika sender ada di adminNumbers → boleh proses
	•	Jika sender == botNumber DAN tujuan == botNumber → boleh proses (self)
	•	Selain itu → RETURN (abaikan, tidak simpan, tidak balas)
	•	Test wajib:
	•	Admin kirim format valid → DIPROSES
	•	Bot kirim ke nomor lain format valid → TIDAK DIPROSES
	•	Non-admin kirim format valid → TIDAK DIPROSES

==================================================
STEP 1 — PASANG FILTER NOMOR ADMIN + SELF-MESSAGE

TUJUAN:
	•	Mengunci sistem supaya hanya admin & self-message yang bisa input / update data.

TUGAS:
	•	Tambah whitelist nomor admin di handler pesan.
	•	Tambah aturan:
	•	Boleh proses jika sender admin
	•	Boleh proses jika sender == botNumber DAN tujuan == botNumber
	•	Selain itu → return

PERINTAH UJI (TEST):
	•	Kirim dari admin → bot respon & bisa simpan/update
	•	Kirim dari non-admin → bot diam, tidak simpan
	•	Bot kirim ke nomor lain format valid → tidak ada perubahan di sheet

KONDISI LANJUT:
	•	Kalau sudah benar → lanjut Step 2.

==================================================
STEP 2 — PERINTAH CEK DATA MOTOR

TUJUAN:
	•	Bisa minta data motor dari spreadsheet lewat WA.

FORMAT PERINTAH:
	•	data motor vixion
	•	data motor beat
	•	data motor cb

PERILAKU:
	•	Script cari semua baris dengan nama motor tersebut di sheet STOK MOTOR.
	•	Bot kirim balik semua data yang cocok, format:
No:
NAMA MOTOR:
TAHUN:
PLAT:
SURAT-SURAT:
TAHUN PLAT:
PAJAK:
HARGA JUAL:
HARGA BELI:

PERINTAH UJI (TEST):
	•	Kirim: data motor vixion (dari admin)
	•	Bot balas semua data vixion.
	•	Kirim dari non-admin → bot tidak merespon.

KONDISI LANJUT:
	•	Kalau sudah benar → lanjut Step 3.

==================================================
STEP 3 — TEMPLATE MOTOR MASUK (TANYA DULU, BARU SIMPAN)

TUJUAN:
	•	Input stok lewat 2 tahap (minta template → isi → konfirmasi → simpan).

ALUR:
	1.	Admin kirim: motor masuk
	2.	Bot balas template:
NAMA MOTOR:
TAHUN:
PLAT:
SURAT-SURAT:
TAHUN PLAT:
PAJAK:
HARGA JUAL:
HARGA BELI:
	3.	Admin isi & kirim
	4.	Bot tampilkan ringkasan + minta konfirmasi:
“Ketik OK untuk simpan / BATAL untuk batal”
	5.	Jika OK → simpan ke STOK MOTOR
	6.	Jika BATAL → tidak simpan

PERINTAH UJI (TEST):
	•	motor masuk → keluar template
	•	Isi → bot minta OK/BATAL
	•	OK → data masuk
	•	BATAL → data tidak masuk
	•	Non-admin coba → tidak diproses

KONDISI LANJUT:
	•	Kalau sudah stabil → lanjut Step 4.

==================================================
STEP 4 — MOTOR TERJUAL (PILIH DARI DAFTAR)

TUJUAN:
	•	Memilih motor yang benar jika ada nama sama.

ALUR:
	1.	Admin kirim: motor vixion laku
	2.	Bot kirim daftar:
	1.	NO: 3 - Vixion 2019 - Plat …
	2.	NO: 7 - Vixion 2021 - Plat …
	3.	Admin balas: no 2 laku 7000000
	4.	Bot minta konfirmasi:
“NO 7 akan ditandai terjual harga 7000000. OK / BATAL”
	5.	OK:
	•	Isi HARGA LAKU
	•	Isi TGL TERJUAL (hari ini jika kosong)
	•	Centang STATUS
	6.	BATAL → tidak ada perubahan

PERINTAH UJI (TEST):
	•	motor vixion laku → daftar muncul
	•	Pilih + OK → sheet terupdate
	•	BATAL → tidak berubah
	•	Non-admin → tidak diproses

KONDISI LANJUT:
	•	Kalau sudah benar → lanjut Step 5.

==================================================
STEP 5 — CEK MOTOR TERJUAL

FORMAT PERINTAH:
	•	motor terjual
	•	motor vixion terjual

PERILAKU:
	•	Ambil dari STOK MOTOR yang status = terjual
	•	Bot kirim daftar ke WA (hanya ke admin)

TEST:
	•	motor terjual → daftar muncul
	•	Non-admin → tidak diproses

==================================================
STEP 6 — LAPORAN PENGELUARAN

FORMAT:
	•	pengeluaran hari ini
	•	pengeluaran bulan ini

SUMBER:
	•	Sheet PENGELUARAN HARIAN

TEST:
	•	Cocokkan hasil dengan sheet
	•	Non-admin → tidak diproses

==================================================
STEP 7 — LAPORAN LABA / RUGI

FORMAT:
	•	laba hari ini
	•	laba bulan ini

SUMBER:
	•	STOK MOTOR (kolom laba/rugi)

TEST:
	•	Cocokkan hasil dengan sheet

==================================================
STEP 8 — LAPORAN ASET & MODAL

FORMAT:
	•	total aset
	•	total modal
	•	total motor terjual

SUMBER:
	•	Sheet TOTAL ASET / TOTAL MODAL

TEST:
	•	Cocokkan dengan angka di sheet

==================================================
STEP 9 — NOTIFIKASI PENGELUARAN HARIAN

ALUR:
	•	Trigger jam tertentu (misal 22:00)
	•	Bot kirim ke ADMIN: “Pengeluaran hari ini berapa?”
	•	Admin balas
	•	Script simpan ke PENGELUARAN HARIAN

TEST:
	•	Jalankan trigger manual
	•	Balas → cek data masuk

==================================================
STEP 10 — STABILKAN BOT (PM2)

TUJUAN:
	•	Bot jalan 24 jam
	•	Auto restart jika crash
	•	Auto start saat VPS reboot

TEST:
	•	Restart bot
	•	Restart VPS

==================================================
STEP 11 — AI (OPSIONAL, TERAKHIR)

TUJUAN:
	•	Bahasa bebas → perintah terstruktur
	•	Voice → teks → diproses script yang sama
	•	AI hanya penerjemah, logika utama tetap script

==================================================

ATURAN KERJA:
	•	Kerjakan dari STEP 1
	•	Test sampai benar
	•	Baru lanjut ke STEP berikutnya
	•	Jangan lompat-lompat
	•	Kalau satu step belum stabil, jangan lanjut

==================================================