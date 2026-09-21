const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');

/*
  Tabel `akun` sekarang SUDAH ADA (lihat DB/002_create_akun.sql — jalankan
  file itu dulu di MySQL Workbench kalau belum). Password di tabel ini
  disimpan sebagai hash bcrypt, bukan plaintext.

  Fallback ke 2 user hardcoded TETAP dipertahankan sebagai jaring pengaman
  kalau migrasi tabel `akun` belum dijalankan di komputer ini (mis. baru
  clone project), supaya dashboard tidak mendadak tidak bisa dibuka sama
  sekali. Begitu tabel `akun` ada, jalur ini otomatis tidak pernah kepakai
  lagi (karena query ke tabel akun akan berhasil duluan).
*/
const FALLBACK_USERS = {
  admin: { password: 'admin123', role: 'admin', name: 'Kaprodi / Staf TU', initials: 'SH' },
  viewer: { password: 'viewer123', role: 'viewer', name: 'Dr. Rina Wijayanti', initials: 'RW' },
};

/*
  ============================================================
  GUARD SEDERHANA — bukan otentikasi sungguhan, lihat catatan yang
  sama di routes/kpi.js. Header x-user-role dikirim apa adanya oleh
  frontend dan bisa dipalsukan siapa pun yang memanggil API langsung.
  Cukup untuk mencegah kesalahan pemakaian dari UI, TIDAK cukup untuk
  produksi sungguhan — ganti dengan token sesi/JWT yang diverifikasi
  server sebelum dipakai di luar lingkungan uji coba.
  ============================================================
*/
function requireAdmin(req, res, next) {
  if ((req.header('x-user-role') || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Hanya admin yang boleh mengelola akun.' });
  }
  next();
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username dan password wajib diisi' });
  }
  const u = String(username).trim().toLowerCase();
  const p = String(password).trim();

  try {
    const [rows] = await pool.query(
      'SELECT username, password, role, nama, nidn FROM akun WHERE LOWER(username) = ? LIMIT 1',
      [u]
    );

    if (rows.length > 0) {
      const acc = rows[0];
      const match = await bcrypt.compare(p, acc.password);
      if (match) {
        return res.json({
          ok: true,
          role: acc.role,
          name: acc.nama,
          nidn: acc.nidn || null,
          source: 'db',
        });
      }
      return res.status(401).json({ error: 'Username atau password salah.' });
    }
    // Tabel ada tapi username tidak ketemu -> tetap coba fallback di bawah
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      console.error('Auth DB error:', err);
      return res.status(500).json({ error: 'Terjadi kesalahan server saat login.' });
    }
    // ER_NO_SUCH_TABLE -> tabel akun belum dimigrasikan, lanjut ke fallback
  }

  const match = FALLBACK_USERS[u];
  if (match && match.password === p) {
    return res.json({
      ok: true,
      role: match.role,
      name: match.name,
      initials: match.initials,
      source: 'fallback',
    });
  }

  return res.status(401).json({ error: 'Username atau password salah.' });
});

/*
  ============================================================
  CRUD AKUN — dipakai modul "Kelola Akun" di dashboard.html
  ============================================================
*/

// GET /api/auth/users — daftar akun (tanpa password)
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT username, nama AS name, role, nidn FROM akun ORDER BY username'
    );
    res.json(rows);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(404).json({
        error: 'Tabel akun belum ada. Jalankan DB/002_create_akun.sql dulu di MySQL Workbench.',
      });
    }
    console.error('GET /api/auth/users error:', err);
    res.status(500).json({ error: 'Gagal mengambil daftar akun.' });
  }
});

// POST /api/auth/users — tambah akun baru
router.post('/users', requireAdmin, async (req, res) => {
  const { username, name, role, nidn, password } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username wajib diisi.' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nama wajib diisi.' });
  if (!password || !String(password).trim()) return res.status(400).json({ error: 'Password wajib diisi.' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role harus admin atau viewer.' });

  const u = String(username).trim().toLowerCase();
  try {
    const hash = await bcrypt.hash(String(password).trim(), 10);
    await pool.query('INSERT INTO akun (username, password, nama, role, nidn) VALUES (?,?,?,?,?)', [
      u,
      hash,
      String(name).trim(),
      role,
      nidn ? String(nidn).trim() : null,
    ]);
    res.status(201).json({ username: u, name: String(name).trim(), role, nidn: nidn || null });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `Username "${u}" sudah dipakai.` });
    }
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(404).json({ error: 'Tabel akun belum ada. Jalankan DB/002_create_akun.sql dulu.' });
    }
    console.error('POST /api/auth/users error:', err);
    res.status(500).json({ error: 'Gagal menambahkan akun.' });
  }
});

// PUT /api/auth/users/:username — edit akun (password opsional)
router.put('/users/:username', requireAdmin, async (req, res) => {
  const u = String(req.params.username).trim().toLowerCase();
  const { name, role, nidn, password } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nama wajib diisi.' });
  if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role harus admin atau viewer.' });

  try {
    const [existingRows] = await pool.query('SELECT username, role FROM akun WHERE LOWER(username) = ?', [u]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    // Jangan biarkan admin terakhir diturunkan jadi viewer — dashboard bisa
    // terkunci total (tidak ada lagi yang bisa mengelola akun/KPI).
    if (existingRows[0].role === 'admin' && role === 'viewer') {
      const [[{ jumlahAdmin }]] = await pool.query(
        "SELECT COUNT(*) AS jumlahAdmin FROM akun WHERE role = 'admin'"
      );
      if (jumlahAdmin <= 1) {
        return res.status(400).json({ error: 'Tidak bisa mengubah role — ini satu-satunya akun admin yang tersisa.' });
      }
    }

    if (password && String(password).trim()) {
      const hash = await bcrypt.hash(String(password).trim(), 10);
      await pool.query('UPDATE akun SET nama=?, role=?, nidn=?, password=? WHERE LOWER(username)=?', [
        String(name).trim(),
        role,
        nidn ? String(nidn).trim() : null,
        hash,
        u,
      ]);
    } else {
      await pool.query('UPDATE akun SET nama=?, role=?, nidn=? WHERE LOWER(username)=?', [
        String(name).trim(),
        role,
        nidn ? String(nidn).trim() : null,
        u,
      ]);
    }
    res.json({ username: u, name: String(name).trim(), role, nidn: nidn || null });
  } catch (err) {
    console.error('PUT /api/auth/users/:username error:', err);
    res.status(500).json({ error: 'Gagal menyimpan perubahan akun.' });
  }
});

// DELETE /api/auth/users/:username — hapus akun
router.delete('/users/:username', requireAdmin, async (req, res) => {
  const u = String(req.params.username).trim().toLowerCase();
  try {
    const [existingRows] = await pool.query('SELECT role FROM akun WHERE LOWER(username) = ?', [u]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    if (existingRows[0].role === 'admin') {
      const [[{ jumlahAdmin }]] = await pool.query(
        "SELECT COUNT(*) AS jumlahAdmin FROM akun WHERE role = 'admin'"
      );
      if (jumlahAdmin <= 1) {
        return res.status(400).json({ error: 'Tidak bisa menghapus — ini satu-satunya akun admin yang tersisa.' });
      }
    }

    await pool.query('DELETE FROM akun WHERE LOWER(username) = ?', [u]);
    res.json({ ok: true, username: u });
  } catch (err) {
    console.error('DELETE /api/auth/users/:username error:', err);
    res.status(500).json({ error: 'Gagal menghapus akun.' });
  }
});

module.exports = router;
