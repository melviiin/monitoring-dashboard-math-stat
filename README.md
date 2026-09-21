# Setup Dashboard Monitoring Prodi Math & Stat — Koneksi ke MySQL Lokal

Paket ini sudah **teruji end-to-end** (login → dashboard → data real dari MySQL,
lewat backend API). Ikuti langkah di bawah persis, di komputer yang sudah ada
MySQL Server + MySQL Workbench + Node.js terinstall.

## Struktur folder

```
DB/          -> DB_Math_stat.sql (schema + data, sama seperti yang sudah ada)
Backend/     -> API Node.js/Express yang menjembatani dashboard <-> MySQL
Code/        -> dashboard.html & login.html (SUDAH dipatch, fetch ke Backend)
```

## Langkah 1 — Cek MySQL Server jalan

Buka MySQL Workbench, pastikan bisa connect ke server lokal (biasanya
`localhost:3306`). Kalau `DB_Math_stat.sql` belum pernah diimport, import
dulu lewat Workbench: **Server → Data Import**, pilih file di folder `DB/`.

Kalau sudah pernah diimport sebelumnya, skip langkah ini.

## Langkah 2 — Install dependency backend

Butuh **Node.js** (versi 18+) sudah terinstall di komputer. Cek dengan:
```bash
node --version
```

Buka terminal di folder `Backend/`, lalu:
```bash
cd Backend
npm install
```

## Langkah 3 — Isi kredensial database

Copy `.env.example` jadi `.env`:
```bash
cp .env.example .env
```

Buka `.env`, isi sesuai kredensial MySQL Workbench di komputer lo:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=isi_password_mysql_lo
DB_NAME=dashboard_stat_math
PORT=5000
```

**Catatan penting soal `DB_HOST`:** kalau nanti login/data tidak muncul dan di
terminal ada error `Access denied for user 'root'@'localhost'`, coba ganti
`DB_HOST=localhost` jadi `DB_HOST=127.0.0.1` — ini karena MySQL kadang
membedakan akses lewat "localhost" (unix socket) vs "127.0.0.1" (TCP), dan
Node.js selalu connect lewat TCP.

## Langkah 4 — Jalankan backend

Masih di folder `Backend/`:
```bash
npm start
```

Kalau berhasil, akan muncul:
```
Backend jalan di http://localhost:5000
Cek koneksi DB:  http://localhost:5000/api/health
```

Buka `http://localhost:5000/api/health` di browser — kalau muncul
`{"ok":true,"db":"connected"}`, berarti backend sudah tersambung ke MySQL.
**Biarkan terminal ini tetap terbuka** selama dashboard dipakai.

## Langkah 5 — Buka dashboard

Buka file `Code/login.html` langsung di browser (double-click, atau lewat
Live Server di VS Code).

Login pakai:
- `admin` / `admin123` (role admin)
- `viewer` / `viewer123` (role viewer)

*(User ini masih sementara/hardcoded di backend — lihat bagian "Soal akun
login" di bawah untuk menyambungkannya ke tabel akun sungguhan nanti.)*

Setelah login, dashboard akan otomatis fetch data KPI dari
`http://localhost:5000/api/kpi/...` — bukan lagi data contoh yang di-hardcode.

## Kalau dashboard tetap menampilkan data lama/contoh

1. Pastikan backend (`npm start`) masih jalan di terminal — kalau berhenti,
   dashboard otomatis balik ke data contoh (ini disengaja, supaya dashboard
   tetap bisa dibuka meski backend belum nyala, alih-alih blank/error).
2. Buka Developer Tools browser (F12) → tab Console, cek ada error apa.
   Error umum:
   - `Failed to fetch` → backend belum jalan / port beda
   - `CORS` error → tambahkan origin dashboard ke `CORS_ORIGIN` di `.env`
     backend (misal kalau pakai Live Server: `http://127.0.0.1:5500`)

## Soal akun login (PENTING — belum ada tabel `akun` di database)

Schema `DB_Math_stat.sql` yang ada sekarang **baru berisi 5 tabel KPI**
(`kpi_indikator`, `kpi_komponen`, `kpi_realisasi`, `kpi_realisasi_unit`,
`kpi_skor_band`) — belum ada tabel `akun`/user sesuai class diagram kalian
(username sebagai login key, NIDN sebagai FK opsional ke Dosen).

Backend ini sudah disiapkan untuk otomatis pakai tabel `akun` begitu tabel
itu dibuat (lihat `Backend/routes/auth.js` — ada penjelasan lebih detail di
situ). Sampai saat itu, backend pakai 2 akun sementara (admin/viewer) yang
sama seperti di prototipe awal.

**Rekomendasi:** minta lecturer/tim buat tabel `akun` sesuai class diagram,
lalu kasih tau Claude untuk menyesuaikan `auth.js` begitu strukturnya fix
(terutama soal password — sebaiknya di-hash pakai bcrypt, bukan plaintext).

## Cara kerja teknis (kalau perlu debug)

- `dashboard.html` dan `login.html` sudah dipatch supaya `fetch()` ke
  `http://localhost:5000` sebelum menampilkan data. Kalau perlu ganti port
  atau host backend, cari variabel `API_BASE` di masing-masing file (dekat
  bagian atas tag `<script>` terakhir) dan ubah di situ.
- Endpoint yang tersedia:
  - `POST /api/auth/login` — body `{ "username": "...", "password": "..." }`
  - `GET /api/kpi/pi-rows?tahun=2026` — data mentah per-indikator
  - `GET /api/kpi/agg?tahun=2026` — agregat per-prodi/perspective + daftar
    indikator yang skornya rendah ("lagging")
- Kalau field/struktur data di dashboard ternyata butuh sesuatu yang beda
  dari yang backend ini sediakan, cek `Backend/routes/kpi.js` — logic
  transformasi dari tabel SQL ke bentuk JSON ada di situ, cukup gampang
  disesuaikan.
