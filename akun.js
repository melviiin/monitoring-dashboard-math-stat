const express = require('express');
const router = express.Router();
const pool = require('../db');

/*
  CRUD akun untuk modul "Kelola Akun" di dashboard.
  Tabel `akun` (sesuai class diagram): username (PK/login key), password,
  role ('admin'|'viewer'), nama, nidn (opsional, FK ke Dosen nanti).

  Password di-hash pakai bcryptjs kalau package-nya terpasang. Kalau belum
  (mis. `npm install bcryptjs` belum dijalankan), fallback ke plaintext
  supaya modul tetap bisa dites — TAPI ini tidak aman untuk production,
  jadi WAJIB install bcryptjs sebelum dipakai beneran.
*/
let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch (e) { bcrypt = null; }

const HAS_BCRYPT = !!bcrypt;
function hashPassword(plain) {
  if (HAS_BCRYPT) return bcrypt.hashSync(String(plain), 10);
  return String(plain); // fallback plaintext (tidak aman)
}

async function tableExists(conn) {
  try {
    await conn.query('SELECT 1 FROM akun LIMIT 1');
    return true;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return false;
    throw e;
  }
}

/* GET /api/akun -> daftar akun (tanpa password) */
router.get('/', async (req, res) => {
  try {
    const ok = await tableExists(pool);
    if (!ok) {
      return res.status(200).json({ ok: true, table: false, users: [], note: 'Tabel akun belum dibuat.' });
    }
    const [rows] = await pool.query(
      'SELECT username, role, nama AS name, nidn FROM akun ORDER BY role DESC, username'
    );
    res.json({ ok: true, table: true, users: rows });
  } catch (err) {
    console.error('GET /akun error:', err);
    res.status(500).json({ error: 'Gagal mengambil daftar akun: ' + err.message });
  }
});

/* POST /api/akun -> tambah akun */
router.post('/', async (req, res) => {
  const { username, name, role, nidn, password } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username wajib diisi.' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nama wajib diisi.' });
  if (!password || !String(password).trim()) return res.status(400).json({ error: 'Password wajib diisi.' });
  const roleClean = role === 'admin' ? 'admin' : 'viewer';
  try {
    const ok = await tableExists(pool);
    if (!ok) return res.status(400).json({ error: 'Tabel akun belum dibuat di database.' });

    const [dup] = await pool.query('SELECT username FROM akun WHERE username=? LIMIT 1', [String(username).trim()]);
    if (dup.length) return res.status(409).json({ error: 'Username sudah dipakai.' });

    await pool.query(
      'INSERT INTO akun (username, password, role, nama, nidn) VALUES (?,?,?,?,?)',
      [String(username).trim(), hashPassword(password), roleClean, String(name).trim(), nidn || null]
    );
    res.status(201).json({ ok: true, user: { username: String(username).trim(), name, role: roleClean, nidn: nidn || '' } });
  } catch (err) {
    console.error('POST /akun error:', err);
    res.status(500).json({ error: 'Gagal menambah akun: ' + err.message });
  }
});

/* PUT /api/akun/:username -> update (password opsional) */
router.put('/:username', async (req, res) => {
  const uname = String(req.params.username);
  const { name, role, nidn, password } = req.body || {};
  const roleClean = role === 'admin' ? 'admin' : 'viewer';
  try {
    const ok = await tableExists(pool);
    if (!ok) return res.status(400).json({ error: 'Tabel akun belum dibuat di database.' });

    const [exist] = await pool.query('SELECT username FROM akun WHERE username=? LIMIT 1', [uname]);
    if (!exist.length) return res.status(404).json({ error: 'Akun tidak ditemukan.' });

    if (password && String(password).trim()) {
      await pool.query(
        'UPDATE akun SET nama=?, role=?, nidn=?, password=? WHERE username=?',
        [name || null, roleClean, nidn || null, hashPassword(password), uname]
      );
    } else {
      await pool.query(
        'UPDATE akun SET nama=?, role=?, nidn=? WHERE username=?',
        [name || null, roleClean, nidn || null, uname]
      );
    }
    res.json({ ok: true, user: { username: uname, name, role: roleClean, nidn: nidn || '' } });
  } catch (err) {
    console.error('PUT /akun/:username error:', err);
    res.status(500).json({ error: 'Gagal memperbarui akun: ' + err.message });
  }
});

/* DELETE /api/akun/:username -> hapus (admin utama dilindungi) */
router.delete('/:username', async (req, res) => {
  const uname = String(req.params.username);
  if (uname === 'admin') return res.status(400).json({ error: 'Akun admin utama tidak dapat dihapus.' });
  try {
    const ok = await tableExists(pool);
    if (!ok) return res.status(400).json({ error: 'Tabel akun belum dibuat di database.' });
    const [r] = await pool.query('DELETE FROM akun WHERE username=?', [uname]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
    res.json({ ok: true, deleted: uname });
  } catch (err) {
    console.error('DELETE /akun/:username error:', err);
    res.status(500).json({ error: 'Gagal menghapus akun: ' + err.message });
  }
});

/* POST /api/akun/import -> bulk tambah/update akun dari file upload */
router.post('/import', async (req, res) => {
  const users = Array.isArray(req.body.users) ? req.body.users : null;
  if (!users) return res.status(400).json({ error: 'Body harus berisi array "users".' });
  if (users.length === 0) return res.status(400).json({ error: 'Tidak ada akun untuk diimport.' });
  if (users.length > 5000) return res.status(400).json({ error: 'Terlalu banyak baris (maks 5000).' });
  const defaultPass = String(req.body.defaultPassword || 'viewer123');
  const conn = await pool.getConnection();
  let inserted = 0, updated = 0, failed = 0;
  const errors = [];
  try {
    const ok = await tableExists(conn);
    if (!ok) { conn.release(); return res.status(400).json({ error: 'Tabel akun belum dibuat di database.' }); }
    await conn.beginTransaction();
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      const username = u && u.username ? String(u.username).trim() : '';
      if (!username) { failed++; errors.push(`Baris ${i + 1}: username kosong`); continue; }
      const name = u.name ? String(u.name).trim() : username;
      const role = u.role === 'admin' ? 'admin' : 'viewer';
      const nidn = u.nidn || null;
      const pass = u.password && String(u.password).trim() ? String(u.password) : defaultPass;
      const [dup] = await conn.query('SELECT username FROM akun WHERE username=? LIMIT 1', [username]);
      if (dup.length) {
        // update nama/role/nidn saja, password tidak ditimpa saat import
        await conn.query('UPDATE akun SET nama=?, role=?, nidn=? WHERE username=?', [name, role, nidn, username]);
        updated++;
      } else {
        await conn.query('INSERT INTO akun (username, password, role, nama, nidn) VALUES (?,?,?,?,?)',
          [username, hashPassword(pass), role, name, nidn]);
        inserted++;
      }
    }
    await conn.commit();
    res.json({ ok: true, inserted, updated, failed, errors: errors.slice(0, 20), bcrypt: HAS_BCRYPT });
  } catch (err) {
    await conn.rollback();
    console.error('POST /akun/import error:', err);
    res.status(500).json({ error: 'Gagal import akun: ' + err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
