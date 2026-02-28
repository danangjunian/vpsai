# WA Bot Clean v2

Arsitektur murni AI Agent:
- AI adalah controller utama (OpenAI tool-calling).
- VPS hanya menerima pesan, eksekusi tool, dan mengirim balasan.
- Spreadsheet adalah sumber data tunggal melalui Apps Script.
- Tidak ada routing intent manual berbasis `switch(intent)` atau keyword parser.
