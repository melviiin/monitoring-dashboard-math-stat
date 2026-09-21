const express = require('express');
const router = express.Router();
const pool = require('../db');

/*
  Mapping nama prodi di DB (Mathematics/Statistics) <-> kode singkat
  yang dipakai dashboard.html (Math/Stat) di field `div`.
*/
const PRODI_TO_DIV = { Mathematics: 'Math', Statistics: 'Stat' };
const DIV_TO_PRODI = { Math: 'Mathematics', Stat: 'Statistics' };
const PERSPECTIVE_TO_P = {
  'Economic Growth': 'ECO',
  'Recognition': 'REC',
  'Capacity Building and Execution': 'CBE',
  'Enabler': 'ENB',
};
const P_TO_PERSPECTIVE = {
  ECO: 'Economic Growth',
  REC: 'Recognition',
  CBE: 'Capacity Building and Execution',
  ENB: 'Enabler',
};
const PERSPECTIVE_LABEL = {
  CBE: 'Capacity Building',
  ENB: 'Enabler',
  ECO: 'Economic Growth',
  REC: 'Recognition',
};

const TAHUN_DEFAULT = 2026;

/* ---------- helper: hitung skor dari nilai + band ---------- */
function scoreFromBands(nilai, bandList) {
  if (nilai === null || nilai === undefined) return null;
  const hit = bandList.find(
    b => b.batas_bawah !== null && b.batas_atas !== null &&
         Number(nilai) >= Number(b.batas_bawah) &&
         Number(nilai) <= Number(b.batas_atas)
  );
  return hit ? hit.skor : null;
}

/* ---------- helper: bentuk satu row PI (dipakai GET & response CRUD) ---------- */
function shapeRow(r, bandList) {
  const ranges = [1, 2, 3, 4, 5, 6].map(skor => {
    const b = bandList.find(x => x.skor === skor);
    if (!b || b.batas_bawah === null || b.batas_atas === null) return null;
    return [Number(b.batas_bawah), Number(b.batas_atas)];
  });
  const score = scoreFromBands(r.realisasi, bandList);
  return {
    id_kpi: r.id_kpi,
    no: r.no_urut,
    div: PRODI_TO_DIV[r.prodi] || r.prodi,
    p: PERSPECTIVE_TO_P[r.perspective] || r.perspective,
    goal: r.goals,
    code: r.kode_pi || '',
    name: r.indikator,
    unit: r.satuan || '',
    type: r.tipe && r.tipe.includes('Quantitative') ? 'Q' : 'L',
    fokus: r.pi_fokus && r.pi_fokus.startsWith('YES') ? 1 : 0,
    prereq: r.pi_fokus && r.pi_fokus.includes('Prerequisite') ? 1 : 0,
    bobot: r.bobot_persen !== null ? Number(r.bobot_persen) : null,
    tq: [
      r.target_q1 !== null ? Number(r.target_q1) : null,
      r.target_q2 !== null ? Number(r.target_q2) : null,
      r.target_q3 !== null ? Number(r.target_q3) : null,
      r.target_q4 !== null ? Number(r.target_q4) : null,
    ],
    target: r.target_all !== null ? Number(r.target_all) : null,
    real: r.realisasi !== null && r.realisasi !== undefined ? Number(r.realisasi) : null,
    score,
    ranges,
    prov: r.pic,
  };
}

/* =====================================================================
   GET /api/kpi/pi-rows?tahun=2026
   Data mentah per-indikator, setara PI_ROWS di dashboard.html.
   ===================================================================== */
router.get('/pi-rows', async (req, res) => {
  const tahun = Number(req.query.tahun) || TAHUN_DEFAULT;
  try {
    const [rows] = await pool.query(
      `SELECT
         ki.id_kpi, ki.prodi, ki.tahun, ki.no_urut, ki.perspective, ki.goals,
         ki.kode_pi, ki.indikator, ki.tipe, ki.pi_fokus, ki.iku,
         ki.bobot_persen, ki.pic,
         kk.id_komponen, kk.satuan,
         kk.target_q1, kk.target_q2, kk.target_q3, kk.target_q4, kk.target_all,
         kr.nilai AS realisasi
       FROM kpi_indikator ki
       LEFT JOIN kpi_komponen kk
         ON kk.id_kpi = ki.id_kpi AND kk.komponen_ke = 1
       LEFT JOIN kpi_realisasi kr
         ON kr.id_komponen = kk.id_komponen
       WHERE ki.tahun = ?
       ORDER BY ki.prodi, ki.no_urut`,
      [tahun]
    );

    if (rows.length === 0) return res.json([]);

    const komponenIds = [...new Set(rows.map(r => r.id_komponen).filter(Boolean))];
    let bandsByKomponen = {};
    if (komponenIds.length > 0) {
      const [bands] = await pool.query(
        `SELECT id_komponen, skor, batas_bawah, batas_atas
         FROM kpi_skor_band
         WHERE id_komponen IN (${komponenIds.map(() => '?').join(',')})
         ORDER BY id_komponen, skor`,
        komponenIds
      );
      for (const b of bands) {
        if (!bandsByKomponen[b.id_komponen]) bandsByKomponen[b.id_komponen] = [];
        bandsByKomponen[b.id_komponen].push(b);
      }
    }

    const result = rows.map(r => shapeRow(r, bandsByKomponen[r.id_komponen] || []));
    res.json(result);
  } catch (err) {
    console.error('GET /pi-rows error:', err);
    res.status(500).json({ error: 'Gagal mengambil data KPI dari database.' });
  }
});

/* =====================================================================
   GET /api/kpi/agg?tahun=2026
   Agregat per-prodi per-perspective + daftar lagging.
   ===================================================================== */
router.get('/agg', async (req, res) => {
  const tahun = Number(req.query.tahun) || TAHUN_DEFAULT;
  const ACHIEVED_THRESHOLD = 4;
  const LAGGING_THRESHOLD = 2;

  try {
    const [piRowsRes] = await pool.query(
      `SELECT
         ki.prodi, ki.perspective, ki.kode_pi, ki.indikator AS name,
         kk.id_komponen, kk.satuan, kk.target_all,
         kr.nilai AS realisasi
       FROM kpi_indikator ki
       LEFT JOIN kpi_komponen kk ON kk.id_kpi = ki.id_kpi AND kk.komponen_ke = 1
       LEFT JOIN kpi_realisasi kr ON kr.id_komponen = kk.id_komponen
       WHERE ki.tahun = ?`,
      [tahun]
    );

    const komponenIds = [...new Set(piRowsRes.map(r => r.id_komponen).filter(Boolean))];
    let bandsByKomponen = {};
    if (komponenIds.length > 0) {
      const [bands] = await pool.query(
        `SELECT id_komponen, skor, batas_bawah, batas_atas
         FROM kpi_skor_band WHERE id_komponen IN (${komponenIds.map(() => '?').join(',')})`,
        komponenIds
      );
      for (const b of bands) {
        if (!bandsByKomponen[b.id_komponen]) bandsByKomponen[b.id_komponen] = [];
        bandsByKomponen[b.id_komponen].push(b);
      }
    }

    const agg = {};
    for (const r of piRowsRes) {
      const div = PRODI_TO_DIV[r.prodi] || r.prodi;
      const pCode = PERSPECTIVE_TO_P[r.perspective] || r.perspective;
      if (!agg[div]) agg[div] = { cats: {}, lagging: [], total: 0, achieved: 0 };
      if (!agg[div].cats[pCode]) {
        agg[div].cats[pCode] = { label: PERSPECTIVE_LABEL[pCode] || pCode, achieved: 0, total: 0 };
      }
      const score = scoreFromBands(r.realisasi, bandsByKomponen[r.id_komponen] || []);
      agg[div].cats[pCode].total += 1;
      agg[div].total += 1;
      if (score !== null && score >= ACHIEVED_THRESHOLD) {
        agg[div].cats[pCode].achieved += 1;
        agg[div].achieved += 1;
      }
      if (score !== null && score <= LAGGING_THRESHOLD) {
        agg[div].lagging.push({
          code: r.kode_pi || '—',
          name: r.name,
          p: PERSPECTIVE_LABEL[pCode] || pCode,
          target: r.target_all !== null ? Number(r.target_all) : null,
          real: r.realisasi !== null && r.realisasi !== undefined ? Number(r.realisasi) : null,
          unit: r.satuan || '',
          score,
        });
      }
    }
    res.json(agg);
  } catch (err) {
    console.error('GET /agg error:', err);
    res.status(500).json({ error: 'Gagal mengambil agregat KPI dari database.' });
  }
});

/* ---------- helper: ambil satu row utuh (buat balikin setelah create/update) ---------- */
async function fetchOneShaped(conn, id_kpi) {
  const [rows] = await conn.query(
    `SELECT
       ki.id_kpi, ki.prodi, ki.tahun, ki.no_urut, ki.perspective, ki.goals,
       ki.kode_pi, ki.indikator, ki.tipe, ki.pi_fokus, ki.iku,
       ki.bobot_persen, ki.pic,
       kk.id_komponen, kk.satuan,
       kk.target_q1, kk.target_q2, kk.target_q3, kk.target_q4, kk.target_all,
       kr.nilai AS realisasi
     FROM kpi_indikator ki
     LEFT JOIN kpi_komponen kk ON kk.id_kpi = ki.id_kpi AND kk.komponen_ke = 1
     LEFT JOIN kpi_realisasi kr ON kr.id_komponen = kk.id_komponen
     WHERE ki.id_kpi = ? LIMIT 1`,
    [id_kpi]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  let bandList = [];
  if (r.id_komponen) {
    const [bands] = await conn.query(
      `SELECT id_komponen, skor, batas_bawah, batas_atas
       FROM kpi_skor_band WHERE id_komponen = ? ORDER BY skor`,
      [r.id_komponen]
    );
    bandList = bands;
  }
  return shapeRow(r, bandList);
}

/* ---------- helper: normalisasi payload dari frontend jadi kolom DB ---------- */
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toIndikatorCols(body, tahun) {
  const prodi = DIV_TO_PRODI[body.div] || body.div || 'Mathematics';
  const perspective = P_TO_PERSPECTIVE[body.p] || body.p || null;
  // pi_fokus disusun ulang dari flag fokus/prereq (dibaca balik di shapeRow)
  let pi_fokus = 'NO';
  if (body.fokus) pi_fokus = body.prereq ? 'YES, Prerequisite' : 'YES';
  const tipe = body.type === 'Q' ? 'Target Quantitative' : 'Target Qualitative';
  return {
    prodi,
    tahun: tahun,
    no_urut: parseInt(body.no) || 0,
    perspective,
    goals: body.goal || null,
    kode_pi: body.code || null,
    indikator: (body.name || '').trim(),
    tipe,
    pi_fokus,
    iku: null,
    bobot_persen: num(body.bobot),
    pic: body.prov || null,
  };
}
function toKomponenCols(body) {
  const tq = Array.isArray(body.tq) ? body.tq : [null, null, null, null];
  return {
    satuan: body.unit || null,
    target_q1: num(tq[0]),
    target_q2: num(tq[1]),
    target_q3: num(tq[2]),
    target_q4: num(tq[3]),
    target_all: num(body.target),
  };
}

/* =====================================================================
   POST /api/kpi  -> tambah 1 indikator KPI (indikator + komponen + realisasi)
   ===================================================================== */
router.post('/', async (req, res) => {
  const tahun = Number(req.query.tahun) || Number(req.body.tahun) || TAHUN_DEFAULT;
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Nama indikator wajib diisi.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const ind = toIndikatorCols(body, tahun);
    const [insInd] = await conn.query(
      `INSERT INTO kpi_indikator
        (prodi, tahun, no_urut, perspective, goals, kode_pi, indikator, tipe, pi_fokus, iku, bobot_persen, pic)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ind.prodi, ind.tahun, ind.no_urut, ind.perspective, ind.goals, ind.kode_pi,
       ind.indikator, ind.tipe, ind.pi_fokus, ind.iku, ind.bobot_persen, ind.pic]
    );
    const id_kpi = insInd.insertId;

    const komp = toKomponenCols(body);
    const [insKomp] = await conn.query(
      `INSERT INTO kpi_komponen
        (id_kpi, komponen_ke, satuan, target_q1, target_q2, target_q3, target_q4, target_all)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id_kpi, 1, komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all]
    );
    const id_komponen = insKomp.insertId;

    const realisasi = num(body.real);
    if (realisasi !== null) {
      await conn.query(
        `INSERT INTO kpi_realisasi (id_komponen, nilai) VALUES (?, ?)`,
        [id_komponen, realisasi]
      );
    }

    await conn.commit();
    const shaped = await fetchOneShaped(conn, id_kpi);
    res.status(201).json({ ok: true, row: shaped });
  } catch (err) {
    await conn.rollback();
    console.error('POST /kpi error:', err);
    res.status(500).json({ error: 'Gagal menambah KPI: ' + err.message });
  } finally {
    conn.release();
  }
});

/* =====================================================================
   PUT /api/kpi/:id  -> update indikator + komponen + realisasi
   ===================================================================== */
router.put('/:id', async (req, res) => {
  const id_kpi = Number(req.params.id);
  const tahun = Number(req.query.tahun) || Number(req.body.tahun) || TAHUN_DEFAULT;
  const body = req.body || {};
  if (!id_kpi) return res.status(400).json({ error: 'id_kpi tidak valid.' });
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Nama indikator wajib diisi.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [exist] = await conn.query('SELECT id_kpi FROM kpi_indikator WHERE id_kpi = ?', [id_kpi]);
    if (exist.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'KPI tidak ditemukan.' });
    }

    const ind = toIndikatorCols(body, tahun);
    await conn.query(
      `UPDATE kpi_indikator SET
        prodi=?, tahun=?, no_urut=?, perspective=?, goals=?, kode_pi=?,
        indikator=?, tipe=?, pi_fokus=?, bobot_persen=?, pic=?
       WHERE id_kpi=?`,
      [ind.prodi, ind.tahun, ind.no_urut, ind.perspective, ind.goals, ind.kode_pi,
       ind.indikator, ind.tipe, ind.pi_fokus, ind.bobot_persen, ind.pic, id_kpi]
    );

    // pastikan komponen_ke=1 ada
    const komp = toKomponenCols(body);
    const [kompRows] = await conn.query(
      'SELECT id_komponen FROM kpi_komponen WHERE id_kpi=? AND komponen_ke=1 LIMIT 1', [id_kpi]
    );
    let id_komponen;
    if (kompRows.length > 0) {
      id_komponen = kompRows[0].id_komponen;
      await conn.query(
        `UPDATE kpi_komponen SET satuan=?, target_q1=?, target_q2=?, target_q3=?, target_q4=?, target_all=?
         WHERE id_komponen=?`,
        [komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all, id_komponen]
      );
    } else {
      const [insKomp] = await conn.query(
        `INSERT INTO kpi_komponen (id_kpi, komponen_ke, satuan, target_q1, target_q2, target_q3, target_q4, target_all)
         VALUES (?,1,?,?,?,?,?,?)`,
        [id_kpi, komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all]
      );
      id_komponen = insKomp.insertId;
    }

    // realisasi: upsert (unik per id_komponen)
    const realisasi = num(body.real);
    const [realRows] = await conn.query(
      'SELECT id_realisasi FROM kpi_realisasi WHERE id_komponen=? LIMIT 1', [id_komponen]
    );
    if (realisasi === null) {
      if (realRows.length > 0) {
        await conn.query('UPDATE kpi_realisasi SET nilai=NULL WHERE id_komponen=?', [id_komponen]);
      }
    } else if (realRows.length > 0) {
      await conn.query('UPDATE kpi_realisasi SET nilai=? WHERE id_komponen=?', [realisasi, id_komponen]);
    } else {
      await conn.query('INSERT INTO kpi_realisasi (id_komponen, nilai) VALUES (?, ?)', [id_komponen, realisasi]);
    }

    await conn.commit();
    const shaped = await fetchOneShaped(conn, id_kpi);
    res.json({ ok: true, row: shaped });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /kpi/:id error:', err);
    res.status(500).json({ error: 'Gagal memperbarui KPI: ' + err.message });
  } finally {
    conn.release();
  }
});

/* =====================================================================
   DELETE /api/kpi/:id  -> hapus indikator (komponen/realisasi/band ikut
   via ON DELETE CASCADE)
   ===================================================================== */
router.delete('/:id', async (req, res) => {
  const id_kpi = Number(req.params.id);
  if (!id_kpi) return res.status(400).json({ error: 'id_kpi tidak valid.' });
  try {
    const [r] = await pool.query('DELETE FROM kpi_indikator WHERE id_kpi=?', [id_kpi]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'KPI tidak ditemukan.' });
    res.json({ ok: true, deleted: id_kpi });
  } catch (err) {
    console.error('DELETE /kpi/:id error:', err);
    res.status(500).json({ error: 'Gagal menghapus KPI: ' + err.message });
  }
});

/* =====================================================================
   POST /api/kpi/import  -> bulk upsert dari file upload (fitur Upload)
   Body: { rows: [ {div,p,goal,code,name,unit,type,fokus,prereq,bobot,
                    tq:[..],target,real,no}, ... ], tahun }
   Matching existing: by (prodi, tahun, kode_pi) kalau kode_pi ada,
   else (prodi, tahun, indikator). Yang match -> update, else insert.
   ===================================================================== */
router.post('/import', async (req, res) => {
  const tahun = Number(req.query.tahun) || Number(req.body.tahun) || TAHUN_DEFAULT;
  const rows = Array.isArray(req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Body harus berisi array "rows".' });
  if (rows.length === 0) return res.status(400).json({ error: 'Tidak ada baris untuk diimport.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Terlalu banyak baris (maks 5000).' });

  const conn = await pool.getConnection();
  let inserted = 0, updated = 0, failed = 0;
  const errors = [];
  try {
    await conn.beginTransaction();
    for (let i = 0; i < rows.length; i++) {
      const body = rows[i];
      if (!body || !body.name || !String(body.name).trim()) { failed++; errors.push(`Baris ${i + 1}: nama kosong`); continue; }
      const ind = toIndikatorCols(body, tahun);
      const komp = toKomponenCols(body);
      const realisasi = num(body.real);

      // cari existing
      let existId = null;
      if (ind.kode_pi) {
        const [m] = await conn.query(
          'SELECT id_kpi FROM kpi_indikator WHERE prodi=? AND tahun=? AND kode_pi=? LIMIT 1',
          [ind.prodi, tahun, ind.kode_pi]
        );
        if (m.length) existId = m[0].id_kpi;
      }
      if (!existId) {
        const [m2] = await conn.query(
          'SELECT id_kpi FROM kpi_indikator WHERE prodi=? AND tahun=? AND indikator=? LIMIT 1',
          [ind.prodi, tahun, ind.indikator]
        );
        if (m2.length) existId = m2[0].id_kpi;
      }

      if (existId) {
        await conn.query(
          `UPDATE kpi_indikator SET no_urut=?, perspective=?, goals=?, kode_pi=?, indikator=?, tipe=?, pi_fokus=?, bobot_persen=?, pic=? WHERE id_kpi=?`,
          [ind.no_urut, ind.perspective, ind.goals, ind.kode_pi, ind.indikator, ind.tipe, ind.pi_fokus, ind.bobot_persen, ind.pic, existId]
        );
        const [kr] = await conn.query('SELECT id_komponen FROM kpi_komponen WHERE id_kpi=? AND komponen_ke=1 LIMIT 1', [existId]);
        let idk;
        if (kr.length) {
          idk = kr[0].id_komponen;
          await conn.query(
            `UPDATE kpi_komponen SET satuan=?, target_q1=?, target_q2=?, target_q3=?, target_q4=?, target_all=? WHERE id_komponen=?`,
            [komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all, idk]
          );
        } else {
          const [ik] = await conn.query(
            `INSERT INTO kpi_komponen (id_kpi, komponen_ke, satuan, target_q1, target_q2, target_q3, target_q4, target_all) VALUES (?,1,?,?,?,?,?,?)`,
            [existId, komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all]
          );
          idk = ik.insertId;
        }
        const [rr] = await conn.query('SELECT id_realisasi FROM kpi_realisasi WHERE id_komponen=? LIMIT 1', [idk]);
        if (realisasi === null) {
          if (rr.length) await conn.query('UPDATE kpi_realisasi SET nilai=NULL WHERE id_komponen=?', [idk]);
        } else if (rr.length) {
          await conn.query('UPDATE kpi_realisasi SET nilai=? WHERE id_komponen=?', [realisasi, idk]);
        } else {
          await conn.query('INSERT INTO kpi_realisasi (id_komponen, nilai) VALUES (?,?)', [idk, realisasi]);
        }
        updated++;
      } else {
        const [insInd] = await conn.query(
          `INSERT INTO kpi_indikator (prodi, tahun, no_urut, perspective, goals, kode_pi, indikator, tipe, pi_fokus, iku, bobot_persen, pic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ind.prodi, tahun, ind.no_urut, ind.perspective, ind.goals, ind.kode_pi, ind.indikator, ind.tipe, ind.pi_fokus, ind.iku, ind.bobot_persen, ind.pic]
        );
        const idKpi = insInd.insertId;
        const [ik] = await conn.query(
          `INSERT INTO kpi_komponen (id_kpi, komponen_ke, satuan, target_q1, target_q2, target_q3, target_q4, target_all) VALUES (?,1,?,?,?,?,?,?)`,
          [idKpi, komp.satuan, komp.target_q1, komp.target_q2, komp.target_q3, komp.target_q4, komp.target_all]
        );
        if (realisasi !== null) {
          await conn.query('INSERT INTO kpi_realisasi (id_komponen, nilai) VALUES (?,?)', [ik.insertId, realisasi]);
        }
        inserted++;
      }
    }
    await conn.commit();
    res.json({ ok: true, inserted, updated, failed, errors: errors.slice(0, 20) });
  } catch (err) {
    await conn.rollback();
    console.error('POST /kpi/import error:', err);
    res.status(500).json({ error: 'Gagal import KPI: ' + err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
