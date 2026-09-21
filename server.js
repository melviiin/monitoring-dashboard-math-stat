require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const authRoutes = require('./routes/auth');
const kpiRoutes = require('./routes/kpi');
const akunRoutes = require('./routes/akun');

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // izinkan request tanpa origin (mis. dibuka langsung via file://, curl, Postman)
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin tidak diizinkan oleh CORS: ' + origin));
  },
}));
app.use(express.json({ limit: '10mb' }));

// Health check + tes koneksi DB
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', message: err.message });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/kpi', kpiRoutes);
app.use('/api/akun', akunRoutes);

app.listen(PORT, () => {
  console.log(`\nBackend jalan di http://localhost:${PORT}`);
  console.log(`Cek koneksi DB:  http://localhost:${PORT}/api/health`);
  console.log(`Login:           POST http://localhost:${PORT}/api/auth/login`);
  console.log(`Data PI rows:    GET  http://localhost:${PORT}/api/kpi/pi-rows?tahun=2026`);
  console.log(`Data agregat:    GET  http://localhost:${PORT}/api/kpi/agg?tahun=2026`);
  console.log(`CRUD KPI:        POST/PUT/DELETE http://localhost:${PORT}/api/kpi[/:id]`);
  console.log(`Import KPI:      POST http://localhost:${PORT}/api/kpi/import`);
  console.log(`CRUD Akun:       http://localhost:${PORT}/api/akun[/:username]\n`);
});
