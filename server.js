require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const { VertexAI } = require('@google-cloud/vertexai');
const { OAuth2Client } = require('google-auth-library');
const JOURNAL_DATABASE = require('./database');
const app = express();
const nodemailer = require('nodemailer');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

// SMTP Configuration for Hostinger
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || `"JurnalHub" <${SMTP_USER || 'no-reply@jurnalhub.id'}>`;

// Transporter setup
const transporter = SMTP_USER && SMTP_PASS ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
}) : null;

if (transporter) {
  console.log('[SMTP] Transporter configured for:', SMTP_USER);
} else {
  console.log('[SMTP] Warning: SMTP credentials not set. Emails will be logged to console instead.');
}

// Helper to send emails (Supports Resend API and SMTP fallback)
async function sendMailHelper(to, subject, html) {
  const resendApiKey = process.env.RESEND_API_KEY;

  if (resendApiKey) {
    // Gunakan Resend API (HTTPS - anti-blokir Railway)
    try {
      const fetchFn = globalThis.fetch || require('node-fetch');
      const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: SMTP_FROM || 'JurnalHub <onboarding@resend.dev>',
          to: [to],
          subject: subject,
          html: html
        })
      });

      const resData = await response.json();
      if (!response.ok) {
        console.error('[Resend API] Error sending email:', resData);
      } else {
        console.log(`[Resend API] Email sent successfully to ${to}, ID: ${resData.id}`);
      }
    } catch (err) {
      console.error('[Resend API] Request error:', err);
    }
  } else if (transporter) {
    // Fallback ke SMTP
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        html
      });
      console.log(`[SMTP] Email sent successfully to ${to}`);
    } catch (err) {
      console.error(`[SMTP] Error sending email to ${to}:`, err);
    }
  } else {
    // Mocking lokal
    console.log('==================================================');
    console.log(`[SMTP MOCK] To: ${to}`);
    console.log(`[SMTP MOCK] Subject: ${subject}`);
    console.log(`[SMTP MOCK] HTML:\n${html}`);
    console.log('==================================================');
  }
}

const GOOGLE_CLIENT_ID = '571306850750-ckq38nmai4felal861uu0hgj1b13bihf.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://jurnalhub.id/api/auth/google/callback';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Tentukan port dari environment variable (Railway menyediakannya lewat PORT) atau port 3000 secara lokal
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE;
const ACCESS_COOKIE = 'jurnalhub_session';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

let detectedProjectId = 'fourth-cirrus-314106';
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    if (creds.project_id) {
      detectedProjectId = creds.project_id;
      console.log(`[Vertex AI Init] Mendeteksi project_id dari service account json: ${detectedProjectId}`);
    }
  } catch (e) {
    console.error("[Vertex AI Init] Gagal mengurai kredensial JSON:", e.message);
  }
}

const VERTEX_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.VERTEX_PROJECT_ID || detectedProjectId;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash-002';
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS || 'gemini-2.0-flash-001,gemini-1.5-flash-001')
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const credentialsPath = path.join(os.tmpdir(), 'jurnalhub-google-credentials.json');
  fs.writeFileSync(credentialsPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
}

const generativeModels = new Map();

function getVertexModel(modelName = GEMINI_MODEL) {
  if (generativeModels.has(modelName)) return generativeModels.get(modelName);

  const vertexAI = new VertexAI({
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
  });

  const model = vertexAI.getGenerativeModel({
    model: modelName
  });

  generativeModels.set(modelName, model);
  return model;
}

// Header keamanan dasar (X-Frame-Options, X-Content-Type-Options, HSTS, dll).
// CSP & Cross-Origin-Embedder-Policy dimatikan dulu karena halaman ini memuat
// banyak script/CSS dari CDN eksternal (Font Awesome, Google Sign-In, jsdelivr,
// dst) dan script inline - mengaktifkannya tanpa allowlist yang diuji akan
// mematahkan halaman. Perlu di-audit & diaktifkan bertahap terpisah.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Trust proxy untuk Railway (supaya cookie secure bisa diset kalau dibelakang load balancer HTTPS)
app.set('trust proxy', 1);

// Rate limiter untuk endpoint auth - mencegah brute-force login & spam registrasi
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak percobaan. Silakan coba lagi dalam beberapa menit.' }
});

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET belum diset. Set env var SESSION_SECRET di Railway sebelum menjalankan di production.');
    process.exit(1);
  }
  console.warn('[WARNING] SESSION_SECRET belum diset, memakai secret acak sementara untuk development (sesi akan invalid tiap restart).');
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');

app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 2592000, // 30 hari (detik)
    retries: 1,
    logFn: () => {} // matikan log verbose bawaan
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: ACCESS_COOKIE,
  cookie: {
    // Railway's edge proxy tidak selalu meneruskan X-Forwarded-Proto secara
    // konsisten ke tiap request, jadi secure:true (yang mensyaratkan req.secure
    // true) bisa membuat Set-Cookie gagal terkirim sama sekali -> setiap request
    // dianggap sesi baru -> loop login. httpOnly + sameSite=lax tetap melindungi
    // cookie ini walau secure di-nonaktifkan, dan Railway selalu diakses via HTTPS.
    secure: false,
    httpOnly: true,
    maxAge: 2592000000, // 30 hari
    sameSite: 'lax'
  }
}));

// Lock sederhana per-resource supaya operasi read-modify-write (baca file JSON,
// ubah di memory, tulis balik) tidak saling tabrakan antar request bersamaan
// dan menyebabkan salah satu perubahan (mis. upgrade paket via webhook) hilang.
const resourceLocks = {};
function withLock(key, fn) {
  const previous = resourceLocks[key] || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  resourceLocks[key] = run.catch(() => {});
  return run;
}

// Fungsi helper untuk user database
function getUsers() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]');
    }
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Gagal membaca users.json:', error);
    return [];
  }
}

// Hitung tanggal expired baru saat user bayar/redeem kode - kalau masa aktif
// SEBELUMNYA masih berlaku (belum lewat), durasi baru ditambahkan ke sisa waktu
// itu, bukan menimpa dari sekarang. Supaya user yang perpanjang/upgrade lebih
// awal (sebelum masa aktifnya habis) tidak kehilangan sisa hari yang sudah
// mereka bayar.
function computeStackedExpiry(existingExpiredAt, durationDays) {
  const now = Date.now();
  const existingMs = existingExpiredAt ? new Date(existingExpiredAt).getTime() : NaN;
  const base = (!isNaN(existingMs) && existingMs > now) ? existingMs : now;
  return new Date(base + durationDays * 24 * 60 * 60 * 1000).toISOString();
}

function saveUsers(users) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan users.json:', error);
    return false;
  }
}

// Reset semua counter kuota bulanan saat user upgrade tier (baik lewat pembayaran
// asli maupun redeem kode akses) - supaya user langsung dapat kuota penuh sesuai
// paket barunya, bukan melanjutkan sisa pemakaian dari tier sebelumnya.
function resetMonthlyQuotasOnUpgrade(user) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  user.lastMatchMonth = currentMonth;
  user.matchCountThisMonth = 0;
  user.lastDraftMonth = currentMonth;
  user.draftCountThisMonth = 0;
  user.lastLitReviewMonth = currentMonth;
  user.litReviewCountThisMonth = 0;
  user.lastHumanizerMonth = currentMonth;
  user.humanizerWordsUsedThisMonth = 0;
  user.lastResearchChatMonth = currentMonth;
  user.researchChatCountThisMonth = 0;
}

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function getHistory() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(HISTORY_FILE)) {
      fs.writeFileSync(HISTORY_FILE, '[]');
    }
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Gagal membaca history.json:', error);
    return [];
  }
}

function saveHistory(history) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('Gagal menyimpan history.json:', error);
  }
}

function addHistoryItem(userId, type, input, output) {
  const history = getHistory();
  const newItem = {
    id: 'hist_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    userId,
    timestamp: new Date().toISOString(),
    type,
    input,
    output
  };
  history.unshift(newItem);
  
  // Cap at 50 entries per user to save disk space
  const userHistory = history.filter(item => item.userId === userId);
  if (userHistory.length > 50) {
    const itemsToRemove = userHistory.slice(50);
    const removeIds = new Set(itemsToRemove.map(item => item.id));
    const filteredHistory = history.filter(item => !removeIds.has(item.id));
    saveHistory(filteredHistory);
  } else {
    saveHistory(history);
  }
  return newItem;
}

const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.json');

function getTransactions() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(TRANSACTIONS_FILE)) {
      fs.writeFileSync(TRANSACTIONS_FILE, '[]');
    }
    const data = fs.readFileSync(TRANSACTIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Gagal membaca transactions.json:', error);
    return [];
  }
}

function saveTransactions(txs) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(txs, null, 2));
  } catch (error) {
    console.error('Gagal menyimpan transactions.json:', error);
  }
}

function addTransaction(userId, referenceId, desc, amount, status) {
  const txs = getTransactions();
  const newTx = {
    id: 'tx_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    userId,
    referenceId,
    timestamp: new Date().toISOString(),
    description: desc,
    amount,
    status
  };
  txs.unshift(newTx);
  saveTransactions(txs);
  return newTx;
}

// --- Kode Akses Manual (upgrade Ultimate 30 hari sambil belum ada payment gateway live) ---
const ACCESS_CODES_FILE = path.join(DATA_DIR, 'access-codes.json');
const MANUAL_ACCESS_CODE_PLAN = 'ultimate_monthly';
const MANUAL_ACCESS_CODE_DURATION_DAYS = 30;
const MANUAL_ACCESS_CODE_PRICE = 149000; // samakan dengan harga Ultimate Bulanan resmi, untuk catatan transaksi

function getAccessCodes() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(ACCESS_CODES_FILE)) fs.writeFileSync(ACCESS_CODES_FILE, '[]');
    return JSON.parse(fs.readFileSync(ACCESS_CODES_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca access-codes.json:', error);
    return [];
  }
}

function saveAccessCodes(codes) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCESS_CODES_FILE, JSON.stringify(codes, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan access-codes.json:', error);
    return false;
  }
}

function generateAccessCodeString() {
  const random = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 karakter hex
  return `JHUL-${random.slice(0, 5)}-${random.slice(5, 10)}`;
}

// Sekali jalan saat server start: kalau belum ada kode sama sekali, buat 30 kode baru
// sekaligus (dicetak ke log Railway supaya bisa disalin manual). Tidak akan menimpa
// kode yang sudah ada/terpakai di deploy berikutnya.
function seedAccessCodesIfEmpty(count = 30) {
  const existing = getAccessCodes();
  if (existing.length > 0) return;

  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push({
      code: generateAccessCodeString(),
      plan: MANUAL_ACCESS_CODE_PLAN,
      durationDays: MANUAL_ACCESS_CODE_DURATION_DAYS,
      used: false,
      usedBy: null,
      usedAt: null,
      createdAt: new Date().toISOString()
    });
  }
  saveAccessCodes(codes);

  console.log('==================================================');
  console.log(`[Access Code Seed] ${count} kode akses Ultimate ${MANUAL_ACCESS_CODE_DURATION_DAYS} hari berhasil dibuat:`);
  codes.forEach(c => console.log('  ' + c.code));
  console.log('==================================================');
}

app.post('/api/redeem-code', requireAccess, authLimiter, (req, res) => {
  const submittedCode = String(req.body.code || '').trim().toUpperCase();
  if (!submittedCode) {
    return res.status(400).json({ ok: false, message: 'Kode akses wajib diisi.' });
  }

  const codes = getAccessCodes();
  const codeIndex = codes.findIndex(c => c.code === submittedCode);
  if (codeIndex === -1) {
    return res.status(400).json({ ok: false, message: 'Kode akses tidak ditemukan.' });
  }
  if (codes[codeIndex].used) {
    return res.status(400).json({ ok: false, message: 'Kode akses ini sudah pernah digunakan.' });
  }

  const users = getUsers();
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  }

  const durationDays = codes[codeIndex].durationDays || MANUAL_ACCESS_CODE_DURATION_DAYS;
  const expiredAt = computeStackedExpiry(users[userIndex].paymentExpiredAt, durationDays);

  users[userIndex].type = 'ultimate';
  users[userIndex].planId = codes[codeIndex].plan || MANUAL_ACCESS_CODE_PLAN;
  users[userIndex].paymentExpiredAt = expiredAt;
  resetMonthlyQuotasOnUpgrade(users[userIndex]);
  const savedUsers = saveUsers(users);

  codes[codeIndex].used = true;
  codes[codeIndex].usedBy = req.session.userId;
  codes[codeIndex].usedAt = new Date().toISOString();
  const savedCodes = saveAccessCodes(codes);

  if (!savedUsers || !savedCodes) {
    return res.status(500).json({ ok: false, message: 'Gagal menyimpan aktivasi. Coba lagi.' });
  }

  req.session.userType = 'ultimate';
  addTransaction(req.session.userId, submittedCode, 'Aktivasi Kode Akses Ultimate (Manual)', MANUAL_ACCESS_CODE_PRICE, 'success');

  console.log(`[Access Code] Kode ${submittedCode} diaktifkan oleh user ${req.session.userId}, berlaku sampai ${expiredAt}`);

  res.json({ ok: true, message: `Berhasil! Akun Anda sekarang Ultimate selama ${durationDays} hari.`, expiredAt });
});

// Lihat daftar kode akses (dipakai/belum) kapan saja - dilindungi ADMIN_SECRET env var,
// bukan pakai sesi login biasa, supaya bisa dicek langsung lewat browser/curl.
app.get('/api/admin/access-codes', (req, res) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(503).json({ ok: false, message: 'ADMIN_SECRET belum dikonfigurasi di server.' });
  }
  if (req.query.secret !== adminSecret) {
    return res.status(401).json({ ok: false, message: 'Tidak diizinkan.' });
  }
  const codes = getAccessCodes();
  res.json({
    ok: true,
    total: codes.length,
    unused: codes.filter(c => !c.used).length,
    codes
  });
});

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [key, ...valueParts] = item.trim().split('=');
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(valueParts.join('='));
    return cookies;
  }, {});
}

function hasAccess(req) {
  // Check if session exists and user is authenticated
  if (req.session && req.session.userId) {
    if (req.session.userId === 'access_code_user') {
      return true;
    }
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (user && user.currentSessionToken === req.session.sessionToken) {
      return true;
    }
    // Clear session to force logout if token does not match
    delete req.session.userId;
    delete req.session.sessionToken;
  }
  return false;
}

function requireAccess(req, res, next) {
  if (hasAccess(req)) {
    next();
    return;
  }

  if (req.accepts('html')) {
     res.redirect('/auth.html');
     return;
  }

  res.status(401).json({ ok: false, message: 'Harap login terlebih dahulu.' });
}

// User Authentication API Endpoints
// User Authentication API Endpoints
app.post('/api/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi.' });
  }

  try {
    const lockResult = await withLock('users', async () => {
      const users = getUsers();
      if (users.find(u => u.email === email)) {
        return { conflict: true };
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const token = uuidv4();
      const newUser = {
        id: uuidv4(),
        email,
        password: hashedPassword,
        type: 'free', // Default account type is free
        isVerified: false,
        verificationToken: token,
        name: '',
        faculty: '',
        university: '',
        profilePic: '',
        savedJournals: [],
        createdAt: new Date().toISOString()
      };

      users.push(newUser);
      saveUsers(users);
      return { conflict: false, newUser, token };
    });

    if (lockResult.conflict) {
      return res.status(409).json({ ok: false, message: 'Email sudah terdaftar.' });
    }

    const { newUser, token } = lockResult;
    const verificationUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${token}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0b1a30; text-align: center;">Selamat Datang di JurnalHub!</h2>
        <p>Terima kasih telah mendaftar. Silakan klik tombol di bawah ini untuk memverifikasi alamat email Anda dan mengaktifkan akun Anda:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationUrl}" style="background-color: #0787dc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verifikasi Email Saya</a>
        </div>
        <p style="color: #64748b; font-size: 0.85em;">Jika tombol di atas tidak berfungsi, Anda juga dapat menyalin dan menempelkan tautan berikut ke browser Anda:</p>
        <p style="word-break: break-all; color: #0787dc;"><a href="${verificationUrl}">${verificationUrl}</a></p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
        <p style="color: #64748b; font-size: 0.8em; text-align: center;">Ini adalah email otomatis, mohon tidak membalas email ini.</p>
      </div>
    `;

    sendMailHelper(newUser.email, 'Verifikasi Akun JurnalHub Anda', html);

    res.json({ ok: true, requiresVerification: true, message: 'Registrasi berhasil. Silakan periksa kotak masuk email Anda untuk memverifikasi akun Anda sebelum melakukan login.' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi.' });
  }

  const users = getUsers();
  const user = users.find(u => u.email === email);

  if (!user) {
    return res.status(401).json({ ok: false, message: 'Email atau password salah.' });
  }

  // Jika akun diatur belum terverifikasi secara eksplisit
  if (user.isVerified === false) {
    return res.status(403).json({ ok: false, isNotVerified: true, message: 'Akun Anda belum terverifikasi. Silakan periksa email Anda untuk tautan verifikasi.' });
  }

  try {
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ ok: false, message: 'Email atau password salah.' });
    }

    const sessionToken = crypto.randomUUID();
    // Re-baca & simpan di dalam lock supaya tidak menimpa perubahan lain
    // (mis. upgrade paket dari webhook pembayaran) yang terjadi selagi
    // bcrypt.compare di atas berjalan (async).
    await withLock('users', async () => {
      const freshUsers = getUsers();
      const freshUser = freshUsers.find(u => u.id === user.id);
      if (freshUser) {
        freshUser.currentSessionToken = sessionToken;
        saveUsers(freshUsers);
      }
    });

    req.session.userId = user.id;
    req.session.userType = user.type || 'free';
    req.session.email = user.email;
    req.session.sessionToken = sessionToken;

    res.json({ ok: true, user: { email: user.email, type: user.type } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server.' });
  }
});

// GET verify email
app.get('/api/auth/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('<h2>Token verifikasi tidak ditemukan.</h2>');
  }

  const users = getUsers();
  const user = users.find(u => u.verificationToken === token);

  if (!user) {
    return res.status(400).send('<h2>Tautan verifikasi tidak valid atau telah kedaluwarsa.</h2>');
  }

  user.isVerified = true;
  delete user.verificationToken;
  saveUsers(users);

  res.redirect('/auth.html?verified=true');
});

// POST forgot password
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ ok: false, message: 'Email wajib diisi.' });
  }

  const users = getUsers();
  const user = users.find(u => u.email === email);

  if (!user) {
    // Demi alasan keamanan, tetap tampilkan respons sukses agar pelaku tidak mengetahui email mana saja yang terdaftar
    return res.json({ ok: true, message: 'Instruksi pemulihan telah dikirim jika email tersebut terdaftar.' });
  }

  const token = uuidv4();
  user.resetPasswordToken = token;
  user.resetPasswordExpires = Date.now() + 3600000; // 1 jam masa berlaku
  saveUsers(users);

  const resetUrl = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #0b1a30; text-align: center;">Atur Ulang Kata Sandi JurnalHub</h2>
      <p>Kami menerima permintaan untuk mengatur ulang kata sandi akun JurnalHub Anda. Silakan klik tombol di bawah ini untuk melakukannya (Tautan ini berlaku selama 1 jam):</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="background-color: #0787dc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Atur Ulang Kata Sandi</a>
      </div>
      <p style="color: #64748b; font-size: 0.85em;">Jika Anda tidak meminta pengaturan ulang kata sandi, abaikan email ini.</p>
      <p style="color: #64748b; font-size: 0.85em;">Atau salin tautan berikut ke browser Anda:</p>
      <p style="word-break: break-all; color: #0787dc;"><a href="${resetUrl}">${resetUrl}</a></p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
      <p style="color: #64748b; font-size: 0.8em; text-align: center;">Ini adalah email otomatis, mohon tidak membalas email ini.</p>
    </div>
  `;

  sendMailHelper(user.email, 'Atur Ulang Kata Sandi JurnalHub', html);
  res.json({ ok: true, message: 'Instruksi pemulihan kata sandi telah dikirim ke email Anda.' });
});

// POST reset password
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ ok: false, message: 'Token dan kata sandi baru wajib disertakan.' });
  }

  const users = getUsers();
  const user = users.find(u => u.resetPasswordToken === token && u.resetPasswordExpires > Date.now());

  if (!user) {
    return res.status(400).json({ ok: false, message: 'Tautan reset kata sandi tidak valid atau telah kedaluwarsa.' });
  }

  try {
    user.password = await bcrypt.hash(password, 10);
    delete user.resetPasswordToken;
    delete user.resetPasswordExpires;
    saveUsers(users);

    res.json({ ok: true, message: 'Kata sandi berhasil diubah. Silakan masuk kembali.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ ok: false, message: 'Gagal mengatur ulang kata sandi.' });
  }
});



function loginOrCreateGoogleUser(email, googleId, name, picture) {
  const users = getUsers();
  let user = users.find(u => u.email === email);

  if (!user) {
    // Jika user belum ada, buat akun free baru secara otomatis
    user = {
      id: uuidv4(),
      email: email,
      password: '', // Login via Google, tidak ada password lokal
      type: 'free',
      name: name || '',
      faculty: '',
      university: '',
      profilePic: picture || '',
      savedJournals: [],
      createdAt: new Date().toISOString()
    };
    users.push(user);
  } else {
    // Update Google ID & Profile Pic jika belum diset
    if (!user.googleId) user.googleId = googleId;
    if (!user.name && name) user.name = name;
    if (!user.profilePic && picture) user.profilePic = picture;
  }

  const sessionToken = crypto.randomUUID();
  user.currentSessionToken = sessionToken;
  saveUsers(users);

  return { user, sessionToken };
}

app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ ok: false, message: 'Token wajib disertakan.' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const googleId = payload.sub;

    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email tidak ditemukan dari akun Google.' });
    }

    const { user, sessionToken } = loginOrCreateGoogleUser(email, googleId, payload.name, payload.picture);

    req.session.userId = user.id;
    req.session.userType = user.type || 'free';
    req.session.email = user.email;
    req.session.sessionToken = sessionToken;

    res.json({ ok: true, user: { email: user.email, type: user.type } });
  } catch (error) {
    console.error('Google Auth error:', error);
    res.status(401).json({ ok: false, message: 'Autentikasi Google gagal.' });
  }
});

// Server-side OAuth redirect flow (lebih stabil daripada popup GSI, tidak bergantung pada
// third-party cookies yang makin sering diblokir browser modern).
app.get('/api/auth/google', authLimiter, (req, res) => {
  if (!GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('Google Sign-In belum dikonfigurasi di server (GOOGLE_CLIENT_SECRET belum diset).');
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account'
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/auth/google/callback', authLimiter, async (req, res) => {
  const { code, error: googleError } = req.query;

  if (googleError || !code) {
    return res.redirect('/auth.html?googleError=1');
  }

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const tokenResponse = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('[Google OAuth] Token exchange failed:', tokenResponse.status, errText);
      return res.redirect('/auth.html?googleError=1');
    }

    const tokenData = await tokenResponse.json();

    const ticket = await googleClient.verifyIdToken({
      idToken: tokenData.id_token,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const googleId = payload.sub;

    if (!email) {
      return res.redirect('/auth.html?googleError=1');
    }

    const { user, sessionToken } = loginOrCreateGoogleUser(email, googleId, payload.name, payload.picture);

    req.session.userId = user.id;
    req.session.userType = user.type || 'free';
    req.session.email = user.email;
    req.session.sessionToken = sessionToken;

    req.session.save(() => res.redirect('/'));
  } catch (error) {
    console.error('[Google OAuth] Callback error:', error);
    res.redirect('/auth.html?googleError=1');
  }
});

app.post('/api/logout', (req, res) => {
  if (req.session && req.session.userId) {
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (user) {
      delete user.currentSessionToken;
      saveUsers(users);
    }
  }
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ ok: false, message: 'Gagal logout.' });
    }
    res.clearCookie(ACCESS_COOKIE);
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (hasAccess(req)) {
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);

    // Check if subscription has expired and automatically demote user
    if (user && user.type !== 'free' && user.paymentExpiredAt) {
      if (new Date(user.paymentExpiredAt) < new Date()) {
        user.type = 'free';
        user.planId = null;
        user.paymentExpiredAt = null;
        saveUsers(users);
        req.session.userType = 'free';
      }
    }

    // Sync session userType with database in case it was upgraded via webhook in background
    if (user && user.type && req.session.userType !== user.type) {
      req.session.userType = user.type;
    }
    
    let isLimitReached = false;
    let isDraftLimitReached = false;
    let draftsRemaining = 1;
    let isLitReviewLimitReached = false;
    let litReviewsRemaining = 1;
    let isHumanizerLimitReached = false;
    let humanizerWordsRemaining = 0;
    let humanizerWordsLimit = 0;
    // JurnalHub Intelligence - Free dijatah 20 pesan/bulan, Premium & Ultimate unlimited
    let isResearchChatLimitReached = false;
    let researchChatsRemaining = 0;
    let researchChatLimit = 0;

    const userType = req.session.userType || 'free';
    const isFree = userType === 'free';
    const isPremium = userType === 'premium';
    const isUltimate = userType === 'ultimate';

    if (isFree && user) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      isLimitReached = (user.lastMatchMonth === currentMonth) && (user.matchCountThisMonth >= 1);
      
      isDraftLimitReached = (user.lastDraftMonth === currentMonth) && (user.draftCountThisMonth >= 1);
      draftsRemaining = isDraftLimitReached ? 0 : 1;

      isLitReviewLimitReached = (user.lastLitReviewMonth === currentMonth) && (user.litReviewCountThisMonth >= 1);
      litReviewsRemaining = isLitReviewLimitReached ? 0 : 1;

      isHumanizerLimitReached = true;
      humanizerWordsRemaining = 0;
      humanizerWordsLimit = 0;

      researchChatLimit = 20;
      const chatUsedFree = (user.lastResearchChatMonth === currentMonth) ? (user.researchChatCountThisMonth || 0) : 0;
      researchChatsRemaining = Math.max(0, researchChatLimit - chatUsedFree);
      isResearchChatLimitReached = researchChatsRemaining <= 0;
    } else if (isPremium && user) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      isLimitReached = false;
      
      isDraftLimitReached = (user.lastDraftMonth === currentMonth) && (user.draftCountThisMonth >= 15);
      draftsRemaining = Math.max(0, 15 - (user.lastDraftMonth === currentMonth ? user.draftCountThisMonth : 0));

      isLitReviewLimitReached = (user.lastLitReviewMonth === currentMonth) && (user.litReviewCountThisMonth >= 15);
      litReviewsRemaining = Math.max(0, 15 - (user.lastLitReviewMonth === currentMonth ? user.litReviewCountThisMonth : 0));

      if (user.lastHumanizerMonth !== currentMonth) {
        user.lastHumanizerMonth = currentMonth;
        user.humanizerWordsUsedThisMonth = 0;
        saveUsers(users);
      }
      const topup = user.humanizerTopupCredits || 0;
      humanizerWordsLimit = 5000 + topup;
      const wordsUsed = user.humanizerWordsUsedThisMonth || 0;
      humanizerWordsRemaining = Math.max(0, humanizerWordsLimit - wordsUsed);
      isHumanizerLimitReached = humanizerWordsRemaining <= 0;

      isResearchChatLimitReached = false;
      researchChatsRemaining = 999;
      researchChatLimit = 999;
    } else {
      isLimitReached = false;
      isDraftLimitReached = false;
      draftsRemaining = 999;
      isLitReviewLimitReached = false;
      litReviewsRemaining = 999;
      isResearchChatLimitReached = false;
      researchChatsRemaining = 999;
      researchChatLimit = 999;

      if (user) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        if (user.lastHumanizerMonth !== currentMonth) {
          user.lastHumanizerMonth = currentMonth;
          user.humanizerWordsUsedThisMonth = 0;
          saveUsers(users);
        }
        const topup = user.humanizerTopupCredits || 0;
        humanizerWordsLimit = 15000 + topup;
        const wordsUsed = user.humanizerWordsUsedThisMonth || 0;
        humanizerWordsRemaining = Math.max(0, humanizerWordsLimit - wordsUsed);
        isHumanizerLimitReached = humanizerWordsRemaining <= 0;
      } else {
        humanizerWordsLimit = 15000;
        humanizerWordsRemaining = 15000;
        isHumanizerLimitReached = false;
      }
    }


    res.json({
      loggedIn: true,
      user: {
        email: req.session.email || 'Premium User',
        type: req.session.userType,
        name: user ? (user.name || '') : '',
        faculty: user ? (user.faculty || '') : '',
        university: user ? (user.university || '') : '',
        profilePic: user ? (user.profilePic || '') : '',
        savedJournals: user ? (user.savedJournals || []) : [],
        isLimitReached: isLimitReached,
        isDraftLimitReached: isDraftLimitReached,
        draftsRemaining: draftsRemaining,
        isLitReviewLimitReached: isLitReviewLimitReached,
        litReviewsRemaining: litReviewsRemaining,
        isHumanizerLimitReached: isHumanizerLimitReached,
        humanizerWordsRemaining: humanizerWordsRemaining,
        humanizerWordsLimit: humanizerWordsLimit,
        humanizerTopupCredits: user ? (user.humanizerTopupCredits || 0) : 0,
        humanizerWordsUsedThisMonth: user ? (user.humanizerWordsUsedThisMonth || 0) : 0,
        matchCountThisMonth: user ? (user.matchCountThisMonth || 0) : 0,
        draftCountThisMonth: user ? (user.draftCountThisMonth || 0) : 0,
        litReviewCountThisMonth: user ? (user.litReviewCountThisMonth || 0) : 0,
        isResearchChatLimitReached: isResearchChatLimitReached,
        researchChatsRemaining: researchChatsRemaining,
        researchChatLimit: researchChatLimit,
        researchChatCountThisMonth: user ? (user.researchChatCountThisMonth || 0) : 0,
        planId: user ? (user.planId || null) : null,
        paymentExpiredAt: user ? (user.paymentExpiredAt || null) : null
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// Endpoint untuk menambahkan/menghapus bookmark jurnal
app.post('/api/bookmarks/toggle', requireAccess, (req, res) => {
  const { journalId } = req.body;
  if (!journalId) {
    return res.status(400).json({ ok: false, message: 'Journal ID wajib diisi.' });
  }

  const users = getUsers();
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  }

  const user = users[userIndex];
  if (!user.savedJournals) {
    user.savedJournals = [];
  }

  const parsedId = Number(journalId);
  const bookmarkIndex = user.savedJournals.indexOf(parsedId);
  let isBookmarked = false;

  if (bookmarkIndex > -1) {
    // Hapus bookmark
    user.savedJournals.splice(bookmarkIndex, 1);
  } else {
    // Tambah bookmark
    user.savedJournals.push(parsedId);
    isBookmarked = true;
  }

  users[userIndex] = user;
  saveUsers(users);

  res.json({ ok: true, bookmarked: isBookmarked, savedJournals: user.savedJournals });
});

// Endpoint fungsional untuk ganti password di tab Pengaturan
app.post('/api/change-password', requireAccess, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ ok: false, message: 'Password lama dan baru wajib diisi.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, message: 'Password baru minimal 6 karakter.' });
  }

  const users = getUsers();
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  }

  const user = users[userIndex];
  // Verifikasi password lama
  const match = await bcrypt.compare(oldPassword, user.password);
  if (!match) {
    return res.status(401).json({ ok: false, message: 'Password lama salah.' });
  }

  // Hash password baru
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  user.password = hashedPassword;
  users[userIndex] = user;
  saveUsers(users);

  res.json({ ok: true, message: 'Kata sandi berhasil diperbarui.' });
});

// Endpoint untuk memperbarui profil pengguna
app.post('/api/update-profile', requireAccess, (req, res) => {
  const { name, faculty, university, profilePic } = req.body;

  const users = getUsers();
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  }

  const user = users[userIndex];
  if (name !== undefined) user.name = String(name).trim();
  if (faculty !== undefined) user.faculty = String(faculty).trim();
  if (university !== undefined) user.university = String(university).trim();
  if (profilePic !== undefined) user.profilePic = profilePic; // base64 data URL

  users[userIndex] = user;
  saveUsers(users);

  res.json({
    ok: true,
    message: 'Profil berhasil diperbarui.',
    user: {
      email: user.email,
      type: user.type,
      name: user.name,
      faculty: user.faculty,
      university: user.university,
      profilePic: user.profilePic,
      savedJournals: user.savedJournals || []
    }
  });
});

// Endpoint untuk mendapatkan daftar template jurnal internasional (.docx)
app.get('/api/templates', requireAccess, (req, res) => {
  const templatesDir = path.join(__dirname, 'templates');
  try {
    if (!fs.existsSync(templatesDir)) {
      fs.mkdirSync(templatesDir, { recursive: true });
    }

    const files = fs.readdirSync(templatesDir)
      .filter(file => file.endsWith('.docx') || file.endsWith('.doc'))
      .map(file => {
        const isWiley = file.toLowerCase().includes('wiley');
        const displayName = file
          .replace(/\.[^/.]+$/, "") // Hapus ekstensi
          .replace(/_/g, ' ')       // Ubah underscore jadi spasi
          .replace(/-/g, ' ');      // Ubah dash jadi spasi
        
        return {
          filename: file,
          displayName: displayName,
          url: `/templates/${file}`,
          size: fs.statSync(path.join(templatesDir, file)).size,
          isFree: isWiley
        };
      });

    res.json({ ok: true, templates: files });
  } catch (error) {
    console.error('Error reading templates directory:', error);
    res.status(500).json({ ok: false, message: 'Gagal membaca daftar template.' });
  }
});


app.get('/api/ai-status', requireAccess, (req, res) => {
  res.json({
    configured: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
    provider: 'vertexai',
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION,
    model: GEMINI_MODEL,
    fallbacks: GEMINI_MODEL_FALLBACKS
  });
});

app.post('/api/access', authLimiter, (req, res) => {
  if (!ACCESS_CODE) {
    res.status(503).json({ ok: false, message: 'Kode akses belum dikonfigurasi.' });
    return;
  }

  const submittedCode = String(req.body.code || '').trim();

  if (submittedCode !== ACCESS_CODE) {
    res.status(401).json({ ok: false, message: 'Kode akses salah.' });
    return;
  }

  // Jika kode akses benar, beri sesi premium (kode ini khusus member Telegram)
  req.session.userId = 'access_code_user';
  req.session.userType = 'premium';
  req.session.email = 'Premium User';

  res.json({ ok: true });
});

function normalizeText(value) {
  return String(value || '').toLowerCase().trim();
}

const matchStopWords = new Set([
  'yang', 'dan', 'atau', 'dengan', 'untuk', 'pada', 'dalam', 'dari', 'ke', 'di',
  'the', 'and', 'or', 'of', 'in', 'to', 'for', 'a', 'an', 'by', 'on', 'is',
  'ini', 'itu', 'terhadap', 'tentang', 'analisis', 'studi', 'study', 'analysis'
]);

function getWords(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9\s&]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !matchStopWords.has(word));
}

function countMatches(sourceWords, targetText) {
  const normalizedTarget = normalizeText(targetText);
  return sourceWords.filter(word => normalizedTarget.includes(word)).length;
}

function calculateLocalMatchScore(journal, articleText, keywordText) {
  const articleWords = getWords(articleText);
  const keywordWords = getWords(keywordText);
  const allWords = [...new Set([...articleWords, ...keywordWords])];
  const normalizedArticleText = normalizeText(articleText);

  if (allWords.length === 0) return 0;

  const journalTitle = normalizeText(journal.title);
  const journalSubject = normalizeText(`${journal.subject} ${journal.keilmuan}`);
  const journalProfile = normalizeText(`${journal.title} ${journal.publisher} ${journal.subject} ${journal.keilmuan} ${journal.description}`);

  const titleHits = countMatches(allWords, journalTitle);
  const subjectHits = countMatches(allWords, journalSubject);
  const profileHits = countMatches(allWords, journalProfile);
  const keywordHits = countMatches(keywordWords, journalProfile);

  const coverageScore = Math.round((profileHits / allWords.length) * 48);
  const titleScore = Math.min(24, titleHits * 8);
  const subjectScore = Math.min(24, subjectHits * 12);
  const keywordScore = Math.min(18, keywordHits * 9);
  const titlePhraseBonus = normalizedArticleText && journalProfile.includes(normalizedArticleText) ? 8 : 0;
  const freeBonus = journal.isFree ? 2 : 0;
  const fastTrackBonus = journal.isFastTrack ? 2 : 0;

  return Math.min(100, coverageScore + titleScore + subjectScore + keywordScore + titlePhraseBonus + freeBonus + fastTrackBonus);
}

function getLocalCandidates(articleTitle, articleKeywords, articleAbstract, limit = 25) {
  const articleText = `${articleTitle} ${articleAbstract}`;

  return JOURNAL_DATABASE
    .map((journal, index) => ({
      journal,
      index,
      score: calculateLocalMatchScore(journal, articleText, articleKeywords)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .slice(0, limit)
    .map(({ journal, score }) => ({
      id: journal.id,
      title: journal.title,
      publisher: journal.publisher,
      type: journal.type,
      rank: journal.rank,
      subject: journal.subject,
      keilmuan: journal.keilmuan,
      apc: journal.apc,
      isFree: journal.isFree,
      isFastTrack: Boolean(journal.isFastTrack),
      description: journal.description,
      localScore: score
    }));
}

function normalizeAiRecommendations(aiItems, candidates) {
  const candidateById = new Map(candidates.map(candidate => [String(candidate.id), candidate]));

  return aiItems
    .map((item, index) => {
      const candidate = candidateById.get(String(item.id));
      if (!candidate) return null;

      return {
        ...candidate,
        matchScore: Math.min(98, Math.max(70, Number(item.matchScore) || 82 - (index * 5))),
        matchReason: String(item.reason || '').slice(0, 220)
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function cleanAndParseAIResponse(text, isObject = false) {
  let cleaned = String(text || '').trim();
  
  // 1. Coba hapus blok kode markdown (```json ... ``` atau ``` ... ```)
  const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = cleaned.match(jsonBlockRegex);
  if (match && match[1]) {
    cleaned = match[1].trim();
  }

  if (isObject) {
    // Mode objek: ekstrak {...}
    if (!cleaned.startsWith('{')) {
      const startIndex = cleaned.indexOf('{');
      const endIndex = cleaned.lastIndexOf('}');
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        cleaned = cleaned.substring(startIndex, endIndex + 1).trim();
      }
    }
  } else {
    // Mode array: ekstrak [...]
    if (!cleaned.startsWith('[')) {
      const startIndex = cleaned.indexOf('[');
      const endIndex = cleaned.lastIndexOf(']');
      if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        cleaned = cleaned.substring(startIndex, endIndex + 1).trim();
      }
    }
  }

  // 3. Parse JSON
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gagal memparsing JSON hasil rekomendasi AI. Error: ${e.message}`);
  }
}

// AI Match Score sekarang pakai DeepSeek (konsisten dengan Lit Review & Disclosure
// Generator) alih-alih Claude/Gemini. getGeminiRecommendations() di bawah tetap
// dipertahankan sebagai fallback kalau DEEPSEEK_API_KEY belum diset tapi Claude/Gemini ada.
async function getDeepSeekJournalRecommendations(articleTitle, articleKeywords, articleAbstract, candidates) {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY belum dikonfigurasi di server.');
  }

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  const systemPrompt = `You are a journal recommendation API for JurnalHub. You MUST respond with ONLY valid JSON (no markdown, no text outside JSON). Return an object with exactly two fields: "review" (a 2-3 sentence analysis of the article in Indonesian) and "recommendations" (an array of exactly 3 journal matches chosen from the candidate list given by the user). Each recommendation must be {"id": <candidate id, copy exactly as given, keep as string or number matching the input>, "matchScore": <integer 70-98>, "reason": "<short reason in Indonesian>"}.`;

  const userContent = `Analisis artikel ini dan pilih tepat 3 jurnal paling cocok dari daftar kandidat berdasarkan judul, keyword/bidang, abstrak, scope jurnal, rank, dan biaya.\n\nArtikel:\nJudul: ${articleTitle || '-'}\nKeyword/Bidang: ${articleKeywords || '-'}\nAbstrak: ${articleAbstract || '-'}\n\nKandidat jurnal:\n${JSON.stringify(candidates)}\n\nBalas dengan JSON object persis: {"review": "<2-3 kalimat analisis artikel dalam Bahasa Indonesia>", "recommendations": [{"id": <id>, "matchScore": <70-98>, "reason": "<alasan singkat>"}]}`;

  const response = await fetchFn(deepSeekUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 1500,
      stream: false,
      thinking: { type: 'disabled' },
      extra_body: { thinking: { type: 'disabled' } },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek API Error Status: ${response.status} - ${errText}`);
  }

  const resData = await response.json();
  const choice = resData?.choices?.[0];
  let content = choice?.message?.content?.trim();
  if (!content && choice?.message?.reasoning_content) {
    content = String(choice.message.reasoning_content).trim();
  }
  if (!content) {
    console.error('[Match Score DeepSeek] Respons kosong, raw:', JSON.stringify(resData).slice(0, 1000));
    throw new Error('Respons AI kosong.');
  }

  const parsed = cleanAndParseAIResponse(content, true);
  return { review: parsed.review || null, items: parsed.recommendations || [] };
}

async function getGeminiRecommendations(articleTitle, articleKeywords, articleAbstract, candidates) {
  const prompt = `
Anda adalah asisten rekomendasi jurnal ilmiah untuk JurnalHub.
Pilih tepat 3 jurnal paling cocok dari daftar kandidat berdasarkan judul artikel, keyword/bidang, abstrak, scope jurnal, rank, dan biaya.
Balas hanya JSON valid tanpa markdown dalam format:
[
  {"id": 123, "matchScore": 92, "reason": "Alasan singkat dalam Bahasa Indonesia"}
]

Artikel:
Judul: ${articleTitle || '-'}
Keyword/Bidang: ${articleKeywords || '-'}
Abstrak: ${articleAbstract || '-'}

Kandidat jurnal:
${JSON.stringify(candidates)}
`;

  const modelNames = [...new Set([GEMINI_MODEL, ...GEMINI_MODEL_FALLBACKS])];
  let lastError = null;

  // Coba pakai Anthropic Claude API terlebih dahulu jika ANTHROPIC_API_KEY tersedia
  if (process.env.ANTHROPIC_API_KEY) {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';
    
    console.log(`[AI API] Mencoba Anthropic Claude API (model: ${claudeModel})...`);
    try {
      const response = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: 1500,
          system: process.env.CLAUDE_SYSTEM_PROMPT || "You are a journal recommendation API. You MUST respond with ONLY valid JSON (no markdown, no text outside JSON). Return an object with exactly two fields: 'review' (a 2-3 sentence analysis of the article in Indonesian) and 'recommendations' (array of 3 journal matches). Format: {\"review\": \"Analisis singkat artikel...\", \"recommendations\": [{\"id\": 123, \"matchScore\": 92, \"reason\": \"Alasan singkat dalam Bahasa Indonesia\"}]}",
          messages: [
            {
              role: 'user',
              content: `Analisis artikel ini dan pilih tepat 3 jurnal paling cocok dari daftar kandidat.\n\nArtikel:\nJudul: ${articleTitle || '-'}\nKeyword/Bidang: ${articleKeywords || '-'}\nAbstrak: ${articleAbstract || '-'}\n\nKandidat jurnal:\n${JSON.stringify(candidates)}\n\nBalas dengan JSON object persis seperti ini (wajib, tanpa teks lain):\n{"review": "<2-3 kalimat analisis artikel dalam Bahasa Indonesia>", "recommendations": [{"id": <id>, "matchScore": <70-98>, "reason": "<alasan singkat>"}]}`
            },
            {
              role: 'assistant',
              content: '{'
            }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API Error Status: ${response.status} - ${errText}`);
      }

      const resData = await response.json();
      // Prefill '{' sudah ditambahkan, gabungkan kembali
      const rawText = resData?.content?.[0]?.text || '}';
      const parsed = cleanAndParseAIResponse('{' + rawText, true);
      return { review: parsed.review || null, items: parsed.recommendations || parsed };
    } catch (error) {
      lastError = error;
      console.error(`[AI API] Anthropic Claude model ${claudeModel} gagal:`, error.message);
    }
  }

  // Coba pakai Google AI Studio Developer API jika API Key tersedia
  if (process.env.GEMINI_API_KEY) {
    console.log("[Gemini API] Menggunakan Google AI Studio Developer API...");
    const fetchFn = globalThis.fetch || require('node-fetch');
    
    const studioModels = [...new Set([
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      ...modelNames.map(name => {
        if (name.startsWith('gemini-1.5-flash')) return 'gemini-1.5-flash';
        if (name.startsWith('gemini-2.0-flash')) return 'gemini-2.0-flash';
        if (name.startsWith('gemini-1.5-pro')) return 'gemini-1.5-pro';
        return name;
      })
    ])];

    for (const modelName of studioModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const response = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Status: ${response.status} - ${errText}`);
        }

        const resData = await response.json();
        const text = resData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        return { review: null, items: cleanAndParseAIResponse(text) };
      } catch (error) {
        lastError = error;
        console.error(`[Gemini API] Google AI Studio model ${modelName} gagal:`, error.message);
      }
    }
  }

  // Coba pakai Vertex AI jika kredensial terkonfigurasi
  const hasVertexCreds = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  if (hasVertexCreds) {
    console.log("[Gemini API] Menggunakan Vertex AI Cloud API...");
    for (const modelName of modelNames) {
      try {
        const model = getVertexModel(modelName);
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        });

        const text = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
        return { review: null, items: cleanAndParseAIResponse(text) };
      } catch (error) {
        lastError = error;
        console.error(`[Gemini API] Vertex AI model ${modelName} gagal:`, error.message || error);
      }
    }
  }

  throw lastError || new Error('Tidak ada API Key (ANTHROPIC_API_KEY / GEMINI_API_KEY) atau Kredensial Vertex AI yang terkonfigurasi.');
}

// Pencarian jurnal "live" dari OpenAlex untuk melengkapi 756 database lokal di
// halaman Database Jurnal - ditampilkan terpisah di frontend (bukan menggantikan
// database lokal yang sudah dikurasi Scopus/Sinta/No-APC).
app.get('/api/journals/search-live', requireAccess, async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 200);
  if (!query || query.length < 3) {
    return res.status(400).json({ ok: false, message: 'Kata kunci pencarian minimal 3 karakter.' });
  }

  try {
    const journals = await searchOpenAlexSources(query, 12);
    res.json({ ok: true, journals });
  } catch (error) {
    console.error('[Journals Search Live] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mencari jurnal live dari OpenAlex: ' + error.message });
  }
});

app.post('/api/match-journals-ai', requireAccess, async (req, res) => {
  const articleTitle = String(req.body.title || '').trim();
  const articleKeywords = String(req.body.keywords || '').trim();
  const articleAbstract = String(req.body.abstract || '').trim();

  if (!articleTitle && !articleKeywords && !articleAbstract) {
    res.status(400).json({ ok: false, message: 'Judul artikel, keyword, atau abstrak wajib diisi.' });
    return;
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const currentMonth = new Date().toISOString().slice(0, 7);

  if (user && (user.type || 'free') === 'free') {
    if (user.lastMatchMonth === currentMonth && user.matchCountThisMonth >= 1) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan tercapai. Akun Free dibatasi 1x pencocokan per bulan.' });
    }
  }

  const localCandidates = getLocalCandidates(articleTitle, articleKeywords, articleAbstract);

  // Perluas kandidat di luar 756 database lokal dengan jurnal live dari OpenAlex
  // (best-effort - kalau gagal/API key belum ada, tetap lanjut cuma pakai lokal).
  let openAlexCandidates = [];
  try {
    const searchQuery = [articleTitle, articleKeywords].filter(Boolean).join(' ').slice(0, 300);
    if (searchQuery) {
      openAlexCandidates = await searchOpenAlexSources(searchQuery, 12);
    }
  } catch (err) {
    console.warn('[Match Score] Gagal ambil kandidat OpenAlex (diabaikan, lanjut pakai lokal):', err.message);
  }

  const candidates = [...localCandidates, ...openAlexCandidates];

  if (candidates.length === 0) {
    res.json({ ok: true, source: 'local', recommendations: [] });
    return;
  }

  const localFallbackRecommendations = () => normalizeAiRecommendations(
    localCandidates.slice(0, 3).map((candidate, index) => ({
      id: candidate.id,
      matchScore: Math.min(96, Math.max(72, candidate.localScore + 28 - (index * 4))),
      reason: 'Rekomendasi dihitung dari kecocokan keyword, bidang keilmuan, dan deskripsi jurnal.'
    })),
    candidates
  );

  const hasDeepSeekKey = !!getDeepSeekApiKey();
  const hasClaudeKey = !!process.env.ANTHROPIC_API_KEY;
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const hasVertex = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

  if (!hasDeepSeekKey && !hasClaudeKey && !hasApiKey && !hasVertex) {
    const recommendations = localFallbackRecommendations();

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review: null });

    res.json({
      ok: true,
      source: 'local',
      warning: 'Kredensial DeepSeek (DEEPSEEK_API_KEY), Claude, atau Gemini belum dikonfigurasi. Menggunakan kalkulasi kecocokan lokal.',
      recommendations: recommendations
    });
    return;
  }

  try {
    // DeepSeek jadi provider utama (konsisten dengan fitur AI lain di JurnalHub);
    // Claude/Gemini tetap jadi fallback kalau DeepSeek belum diset tapi salah satunya ada.
    const aiResult = hasDeepSeekKey
      ? await getDeepSeekJournalRecommendations(articleTitle, articleKeywords, articleAbstract, candidates)
      : await getGeminiRecommendations(articleTitle, articleKeywords, articleAbstract, candidates);
    const aiItems = Array.isArray(aiResult) ? aiResult : (aiResult.items || aiResult);
    const review = aiResult?.review || null;
    const recommendations = normalizeAiRecommendations(aiItems, candidates);
    const sourceName = hasDeepSeekKey ? 'deepseek' : (hasClaudeKey ? 'claude' : 'gemini');

    // Increment usage for Free users
    if (user && (user.type || 'free') === 'free') {
      if (user.lastMatchMonth !== currentMonth) {
        user.lastMatchMonth = currentMonth;
        user.matchCountThisMonth = 0;
      }
      user.matchCountThisMonth += 1;
      saveUsers(users);
    }

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review });

    res.json({ ok: true, source: sourceName, review, recommendations });
  } catch (error) {
    console.error(error);
    const activeProvider = hasDeepSeekKey ? 'DeepSeek' : (hasClaudeKey ? 'Claude' : 'Gemini');
    const recommendations = localFallbackRecommendations();

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review: null });

    res.json({
      ok: true,
      source: 'local',
      warning: `Layanan ${activeProvider} tidak tersedia, memakai fallback lokal. ${error.message.slice(0, 180)}`,
      recommendations: recommendations
    });
  }
});

// Struktur bab per jenis dokumen untuk AI Outline Generator. "description" dipakai
// untuk instruksi ke AI (rincian fungsi tiap bab), "label" dipakai untuk tampilan
// UI/ekspor. Kalau nanti mau tambah jenis dokumen baru (mis. laporan penelitian),
// cukup tambah entri baru di sini - endpoint & frontend sudah generic.
const DOCUMENT_TYPE_CONFIGS = {
  jurnal: {
    label: 'Jurnal Ilmiah (IMRaD)',
    segments: [
      { key: 'introduction', label: '1. Pendahuluan / Latar Belakang', description: 'Latar belakang urgensi topik, permasalahan utama, tujuan penelitian, dan kontribusi yang diharapkan.' },
      { key: 'literature_review', label: '2. Tinjauan Pustaka', description: 'Kajian teori-teori dasar, perbandingan penelitian terdahulu, dan gap analysis yang menjustifikasi kebaruan penelitian.' },
      { key: 'method', label: '3. Metode Penelitian', description: 'Desain penelitian (kualitatif/kuantitatif), prosedur pengumpulan data, populasi/sampel, dan teknik analisis data.' },
      { key: 'results_discussion', label: '4. Hasil & Pembahasan', description: 'Paparan temuan utama, interpretasi hasil dikaitkan dengan hipotesis/tujuan, dan diskusi kritis dibandingkan teori/penelitian terdahulu.' },
      { key: 'conclusion', label: '5. Kesimpulan & Saran', description: 'Kesimpulan yang menjawab rumusan masalah, implikasi teoretis/praktis, keterbatasan riset, dan rekomendasi studi lanjutan.' }
    ]
  },
  tesis: {
    label: 'Tesis',
    segments: [
      { key: 'bab1_pendahuluan', label: 'BAB I Pendahuluan', description: 'Latar belakang masalah, rumusan masalah, tujuan penelitian, kegunaan penelitian - kadang ditambah kerangka pemikiran dan metode penelitian singkat (khusus tesis hukum sering masuk di sini juga).' },
      { key: 'bab2_tinjauan_pustaka', label: 'BAB II Tinjauan Pustaka / Kerangka Teori', description: 'Kajian teori, penelitian terdahulu, dan kerangka konseptual yang mendasari penelitian.' },
      { key: 'bab3_metode', label: 'BAB III Metode Penelitian', description: 'Jenis penelitian, pendekatan yang digunakan, sumber data, dan teknik analisis.' },
      { key: 'bab4_hasil_pembahasan', label: 'BAB IV Hasil dan Pembahasan', description: 'Bab paling berat - berisi temuan sekaligus analisis mendalam terhadap data penelitian.' },
      { key: 'bab5_penutup', label: 'BAB V Penutup', description: 'Kesimpulan dan saran berdasarkan hasil penelitian.' }
    ]
  },
  disertasi: {
    label: 'Disertasi',
    segments: [
      { key: 'bab1_pendahuluan', label: 'BAB I Pendahuluan', description: 'Latar belakang masalah, rumusan masalah, tujuan penelitian, dan kegunaan penelitian secara mendalam.' },
      { key: 'bab2_tinjauan_pustaka', label: 'BAB II Tinjauan Pustaka / Landasan Teori', description: 'Kajian teori mendalam, penelitian terdahulu, dan kerangka konseptual.' },
      { key: 'bab3_metode', label: 'BAB III Metode Penelitian', description: 'Jenis penelitian, pendekatan yang digunakan, sumber data, dan teknik analisis.' },
      { key: 'bab4_hasil_pembahasan', label: 'BAB IV Hasil Penelitian dan Pembahasan beserta Novelty', description: 'Temuan penelitian, analisis mendalam, dan penegasan unsur kebaruan (novelty) yang membedakan penelitian ini dari penelitian sebelumnya.' },
      { key: 'bab5_penutup', label: 'BAB V Penutup', description: 'Kesimpulan dan saran berdasarkan hasil penelitian.' }
    ]
  }
};

app.post('/api/generate-template-draft', requireAccess, async (req, res) => {
  const { title, abstract } = req.body;
  const docType = DOCUMENT_TYPE_CONFIGS[req.body.docType] ? req.body.docType : 'jurnal';
  const docConfig = DOCUMENT_TYPE_CONFIGS[docType];
  if (!title || !abstract) {
    return res.status(400).json({ ok: false, message: 'Judul artikel dan abstrak wajib diisi.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const currentMonth = new Date().toISOString().slice(0, 7);

  if (user && (user.type || 'free') === 'free') {
    if (user.lastDraftMonth === currentMonth && user.draftCountThisMonth >= 1) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan tercapai. Akun Free dibatasi 1x drafting per bulan.' });
    }
  } else if (user && user.type === 'premium') {
    if (user.lastDraftMonth === currentMonth && user.draftCountThisMonth >= 15) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan tercapai. Akun Premium dibatasi 15x drafting per bulan.' });
    }
  }

  const hasClaudeKey = !!process.env.ANTHROPIC_API_KEY;
  if (!hasClaudeKey) {
    // Fallback jika API key Claude tidak tersedia
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastDraftMonth !== currentMonth) {
        user.lastDraftMonth = currentMonth;
        user.draftCountThisMonth = 0;
      }
      user.draftCountThisMonth += 1;
      saveUsers(users);
    }

    // Fallback lokal generic - dibangun dari description tiap segmen di config,
    // supaya tetap masuk akal untuk jenis dokumen apa pun (bukan cuma jurnal).
    const localDraft = {};
    docConfig.segments.forEach(seg => {
      localDraft[seg.key] = [
        `Fokus bahasan bagian ini: ${seg.description}`,
        `Kaitkan langsung dengan judul penelitian: "${title}"`,
        "Rujuk poin-poin dari abstrak yang relevan dengan bagian ini."
      ];
    });

    addHistoryItem(req.session.userId, 'draft', { title, abstract, docType }, { draft: localDraft, docType });

    return res.json({
      ok: true,
      source: 'local',
      docType,
      segments: docConfig.segments.map(s => ({ key: s.key, label: s.label })),
      draft: localDraft
    });
  }

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';

    const segmentDescriptions = docConfig.segments.map(s => `- "${s.key}" (${s.label}): ${s.description}`).join('\n');
    const jsonExample = docConfig.segments.map(s => `"${s.key}": ["point 1", "point 2"]`).join(', ');

    const response = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: claudeModel,
        max_tokens: 1500,
        system: `You are an expert academic writing advisor for Indonesian ${docConfig.label}. Based on the title and abstract provided, generate a highly structured outline of what the author must write in each segment of their manuscript. Here are the segments and what each one must cover:\n${segmentDescriptions}\n\nFor each segment, provide 3-4 specific, concrete, and highly customized points tailored directly to their research topic (do NOT output generic writing tips). Output ONLY a valid JSON object with exactly these keys: {${jsonExample}}. Do not wrap in markdown block.`,
        messages: [
          {
            role: 'user',
            content: `Analisis judul dan abstrak berikut, lalu buat panduan outline pembahasan untuk masing-masing bagian ${docConfig.label}.\n\nJudul: ${title}\nAbstrak: ${abstract}\n\nBalas dengan JSON object persis seperti spesifikasi (tanpa penjelasan teks):`
          },
          {
            role: 'assistant',
            content: '{'
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API Error Status: ${response.status} - ${errText}`);
    }

    const resData = await response.json();
    const rawText = resData?.content?.[0]?.text || '}';
    const parsed = cleanAndParseAIResponse('{' + rawText, true);

    // Increment usage for Free & Premium users
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastDraftMonth !== currentMonth) {
        user.lastDraftMonth = currentMonth;
        user.draftCountThisMonth = 0;
      }
      user.draftCountThisMonth += 1;
      saveUsers(users);
    }

    addHistoryItem(req.session.userId, 'draft', { title, abstract, docType }, { draft: parsed, docType });

    res.json({
      ok: true,
      source: 'claude',
      docType,
      segments: docConfig.segments.map(s => ({ key: s.key, label: s.label })),
      draft: parsed
    });
  } catch (error) {
    console.error('[AI Draft Generator] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal memproses draf panduan dengan AI: ' + error.message });
  }
});

// Ekspor panduan outline yang sudah di-generate jadi file .docx berformat rapi -
// fitur khusus Ultimate. Struktur bab mengikuti DOCUMENT_TYPE_CONFIGS di atas.
app.post('/api/generate-template-draft/export-docx', requireAccess, async (req, res) => {
  const { title, abstract, draft } = req.body;
  const docType = DOCUMENT_TYPE_CONFIGS[req.body.docType] ? req.body.docType : 'jurnal';
  const docConfig = DOCUMENT_TYPE_CONFIGS[docType];
  if (!title || !abstract || !draft || typeof draft !== 'object') {
    return res.status(400).json({ ok: false, message: 'Judul, abstrak, dan draf outline wajib disertakan.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = req.session.userId === 'access_code_user' ? 'premium' : ((user && user.type) || 'free');
  if (userType !== 'ultimate') {
    return res.status(403).json({ ok: false, message: 'Ekspor panduan ke .docx khusus akun Ultimate.' });
  }

  try {
    const children = [
      new Paragraph({ text: String(title).slice(0, 300), heading: HeadingLevel.TITLE }),
      new Paragraph({ text: 'Abstrak', heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }),
      new Paragraph({ text: String(abstract).slice(0, 5000) }),
      new Paragraph({ text: `Panduan Struktur Pembahasan ${docConfig.label}`, heading: HeadingLevel.HEADING_1, spacing: { before: 500 } })
    ];

    docConfig.segments.forEach(seg => {
      children.push(new Paragraph({ text: seg.label, heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }));
      const points = Array.isArray(draft[seg.key]) ? draft[seg.key] : [];
      if (points.length === 0) {
        children.push(new Paragraph({ text: '(Tidak ada poin untuk segmen ini.)' }));
      } else {
        points.forEach(pt => {
          children.push(new Paragraph({ text: String(pt).slice(0, 1000), bullet: { level: 0 } }));
        });
      }
    });

    children.push(new Paragraph({
      spacing: { before: 500 },
      children: [new TextRun({ text: 'Dibuat oleh JurnalHub AI Drafting Assistant', italics: true, size: 18, color: '888888' })]
    }));

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    const safeFileName = String(title).slice(0, 60).replace(/[^a-zA-Z0-9]/g, '_') || 'Panduan_Draft';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="Panduan_Draft_${safeFileName}.docx"`);
    res.send(buffer);
  } catch (error) {
    console.error('[Draft DOCX Export] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal membuat file .docx.' });
  }
});

// --- AI Literature Review: OpenAlex (retrieval) + Semantic Scholar (enrichment) + DeepSeek (sintesis) ---
// Ganti dari Perplexity: sitasi sekarang dibangun langsung dari data database akademik
// terstruktur (DOI/URL asli, terverifikasi) bukan diminta LLM untuk "mengarang" JSON,
// sehingga tidak ada lagi risiko JSON kepotong/parsing gagal, dan biaya jauh lebih murah
// (OpenAlex & Semantic Scholar gratis, DeepSeek cuma dipakai untuk menulis narasinya).

// Rekonstruksi abstrak dari abstract_inverted_index milik OpenAlex (format: {kata: [posisi,...]})
function reconstructAbstractFromInvertedIndex(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const positions = [];
  for (const word of Object.keys(invertedIndex)) {
    for (const pos of invertedIndex[word]) {
      positions[pos] = word;
    }
  }
  return positions.filter(Boolean).join(' ');
}

async function searchOpenAlexWorks(query, perPage) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const params = new URLSearchParams({
    search: query,
    per_page: String(perPage),
    filter: 'has_abstract:true',
    select: 'id,doi,title,abstract_inverted_index,publication_year,cited_by_count,primary_location,authorships,open_access'
  });
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const mailto = process.env.OPENALEX_MAILTO;
  if (mailto) params.set('mailto', mailto);

  const response = await fetchFn(`https://api.openalex.org/works?${params.toString()}`);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAlex API Error: ${response.status} - ${errText}`);
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results
    .map(w => {
      const abstract = reconstructAbstractFromInvertedIndex(w.abstract_inverted_index);
      if (!abstract) return null; // buang paper tanpa abstrak - tidak berguna untuk sintesis
      const authorNames = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
      const authors = authorNames.length > 3
        ? `${authorNames.slice(0, 3).join(', ')}, et al.`
        : authorNames.join(', ') || 'Tidak diketahui';
      const doi = w.doi ? String(w.doi).replace('https://doi.org/', '') : null;
      return {
        title: w.title || 'Tanpa judul',
        authors,
        journal: w.primary_location?.source?.display_name || '-',
        year: w.publication_year ? String(w.publication_year) : '-',
        doi,
        url: w.doi || w.primary_location?.landing_page_url || '#',
        citedByCount: w.cited_by_count || 0,
        isOpenAccess: !!w.open_access?.is_oa,
        abstract: abstract.slice(0, 800)
      };
    })
    .filter(Boolean);
}

// --- Database Jurnal enrichment: cari jurnal via OpenAlex Sources API ---
// Dipakai untuk (1) memperluas kandidat AI Match Score di luar 756 jurnal statis
// lokal, dan (2) hasil pencarian "live" di halaman Database Jurnal. Dinormalisasi
// ke skema field yang SAMA dengan database.js supaya bisa dipakai render/AI yang
// sudah ada, tapi type diberi label "OpenAlex" (bukan "Scopus"/"Sinta") karena
// kita tidak bisa mengklaim status akreditasi Scopus/Sinta dari data ini - itu
// tetap eksklusif milik 756 jurnal database lokal yang sudah dikurasi.
let openAlexSourcesCache = new Map(); // query(lowercase) -> { data, expiresAt }
const OPENALEX_SOURCES_CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit

async function searchOpenAlexSources(query, perPage) {
  const cacheKey = `${query.toLowerCase()}::${perPage}`;
  const cached = openAlexSourcesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const fetchFn = globalThis.fetch || require('node-fetch');
  const params = new URLSearchParams({
    search: query,
    per_page: String(perPage),
    filter: 'type:journal',
    select: 'id,display_name,host_organization_name,homepage_url,issn_l,works_count,summary_stats,is_oa,is_in_doaj,apc_usd,topics'
  });
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const mailto = process.env.OPENALEX_MAILTO;
  if (mailto) params.set('mailto', mailto);

  const response = await fetchFn(`https://api.openalex.org/sources?${params.toString()}`);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAlex Sources API Error: ${response.status} - ${errText}`);
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  const normalized = results.map(s => {
    const hIndex = s.summary_stats?.h_index ?? 0;
    const topicNames = (s.topics || []).slice(0, 3).map(t => t.display_name).filter(Boolean);
    const isFree = !s.apc_usd;
    const apcText = isFree ? 'Gratis (No APC)' : `$${s.apc_usd} USD`;

    return {
      id: `oa-${String(s.id || '').replace('https://openalex.org/', '')}`,
      title: s.display_name || 'Tanpa nama',
      publisher: s.host_organization_name || '-',
      type: 'OpenAlex',
      rank: `H-Index ${hIndex}`,
      subject: topicNames.join(', ') || '-',
      keilmuan: topicNames.join(', ') || '-',
      apc: apcText,
      isFree,
      isFastTrack: false,
      description: `${s.works_count ? s.works_count.toLocaleString('id-ID') + ' artikel terindeks' : 'Data OpenAlex'}${s.is_in_doaj ? ', terdaftar di DOAJ' : ''}${s.is_oa ? ', Open Access' : ''}.`,
      url: s.homepage_url || `https://openalex.org/${String(s.id || '').replace('https://openalex.org/', '')}`,
      source: 'openalex',
      hIndex,
      worksCount: s.works_count || 0
    };
  });

  openAlexSourcesCache.set(cacheKey, { data: normalized, expiresAt: Date.now() + OPENALEX_SOURCES_CACHE_TTL_MS });
  return normalized;
}

// Enrichment best-effort - kalau gagal (rate limit dsb) tidak menggagalkan seluruh request,
// cuma citation-nya tidak punya tldr/influentialCitationCount tambahan.
async function enrichWithSemanticScholar(papers) {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (!apiKey) return papers;

  const papersWithDoi = papers.filter(p => p.doi);
  if (papersWithDoi.length === 0) return papers;

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const ids = papersWithDoi.map(p => `DOI:${p.doi}`);
    const response = await fetchFn('https://api.semanticscholar.org/graph/v1/paper/batch?fields=tldr,influentialCitationCount', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({ ids })
    });

    if (!response.ok) {
      console.warn('[Semantic Scholar] Enrichment gagal, status', response.status);
      return papers;
    }

    const results = await response.json();
    const byDoi = {};
    papersWithDoi.forEach((p, i) => { byDoi[p.doi] = results[i]; });

    return papers.map(p => {
      const match = p.doi ? byDoi[p.doi] : null;
      if (!match) return p;
      return {
        ...p,
        tldr: match.tldr?.text || null,
        influentialCitationCount: match.influentialCitationCount ?? null
      };
    });
  } catch (err) {
    console.warn('[Semantic Scholar] Enrichment error (diabaikan, lanjut tanpa enrichment):', err.message);
    return papers;
  }
}

app.post('/api/lit-review', requireAccess, async (req, res) => {
  const { title, keywords, abstract } = req.body;
  const requestedMode = req.body.mode === 'pro' ? 'pro' : 'standard';
  if (!title) {
    return res.status(400).json({ ok: false, message: 'Judul atau topik penelitian wajib diisi.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Check quota for Free and Premium users
  if (user && (user.type || 'free') === 'free') {
    if (user.lastLitReviewMonth === currentMonth && user.litReviewCountThisMonth >= 1) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan tercapai. Akun Free dibatasi 1x Literature Review per bulan.' });
    }
  } else if (user && user.type === 'premium') {
    if (user.lastLitReviewMonth === currentMonth && user.litReviewCountThisMonth >= 15) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan tercapai. Akun Premium dibatasi 15x Literature Review per bulan.' });
    }
  }

  const tier = user ? (user.type || 'free') : 'free';
  const isDeepTier = tier === 'ultimate' && requestedMode === 'pro';

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
    // Fallback lokal jika DeepSeek API Key belum dikonfigurasi
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastLitReviewMonth !== currentMonth) {
        user.lastLitReviewMonth = currentMonth;
        user.litReviewCountThisMonth = 0;
      }
      user.litReviewCountThisMonth += 1;
      saveUsers(users);
    }

    const localReview = `<h3>Tinjauan Pustaka: ${title}</h3><p>Fitur AI Literature Review berjalan di server namun <code>DEEPSEEK_API_KEY</code> belum terpasang di Railway.</p><p>Berikut adalah simulasi draf Tinjauan Pustaka untuk topik Anda:</p><ul><li><strong>Kajian Teori:</strong> Menganalisis landasan teoritis utama yang mendasari permasalahan penelitian Anda.</li><li><strong>Studi Terdahulu:</strong> Meneliti bagaimana para peneliti lain telah mendekati masalah serupa dan hasil penelitian mereka.</li><li><strong>Celah Penelitian (Research Gap):</strong> Mengidentifikasi apa yang belum diteliti dan bagaimana penelitian Anda akan mengisi celah tersebut.</li></ul>`;
    const localCitations = [
      { title: "Panduan Penulisan Jurnal Ilmiah Scopus & Sinta", authors: "Abidin, M. I.", journal: "Pusat Riset Indonesia", year: "2026", url: "https://github.com/ilmanabidin1/pusatriset", reason: "Referensi dasar yang membahas tentang penyusunan draf tinjauan pustaka dan kesesuaian jurnal ilmiah." }
    ];

    addHistoryItem(req.session.userId, 'lit-review', { title, keywords, abstract }, { review: localReview, citations: localCitations });

    return res.json({
      ok: true,
      source: 'local',
      review: localReview,
      citations: localCitations
    });
  }

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const targetCount = isDeepTier ? 18 : 10;

    // 1. Retrieval - cari paper asli dari OpenAlex (gratis, DOI/URL terverifikasi).
    // Query judul+keyword dulu (paling spesifik); kalau kosong, pelan-pelan diperluas
    // (judul saja, lalu keyword saja) sebelum benar-benar menyerah - query gabungan yang
    // terlalu spesifik/panjang kadang tidak match apa pun di full-text search OpenAlex.
    const queryAttempts = [
      [title, keywords].filter(Boolean).join(' '),
      title,
      keywords
    ].filter(Boolean).filter((q, i, arr) => arr.indexOf(q) === i).map(q => q.slice(0, 300));

    let papers = [];
    for (const attemptQuery of queryAttempts) {
      papers = await searchOpenAlexWorks(attemptQuery, targetCount + 10);
      if (papers.length > 0) break;
    }
    papers.sort((a, b) => b.citedByCount - a.citedByCount);
    papers = papers.slice(0, targetCount);

    if (papers.length === 0) {
      throw new Error('Tidak ditemukan paper ilmiah dengan abstrak yang relevan di OpenAlex untuk topik ini. Coba gunakan judul/kata kunci yang lebih umum.');
    }

    // 2. Enrichment - khusus mode Pro, ambil tldr + influential citation count dari Semantic Scholar
    if (isDeepTier) {
      papers = await enrichWithSemanticScholar(papers);
    }

    // 3. Sintesis - DeepSeek menulis narasi HANYA berdasarkan paper yang sudah ditemukan (grounded, no fabrication)
    const paperListText = papers.map((p, i) => {
      const lines = [`${i + 1}. [${p.authors}, ${p.year}] "${p.title}" - ${p.journal} (dikutip ${p.citedByCount}x)`];
      if (p.tldr) lines.push(`   Ringkasan: ${p.tldr}`);
      lines.push(`   Abstrak: ${p.abstract}`);
      return lines.join('\n');
    }).join('\n\n');

    const depthInstructions = isDeepTier
      ? `Wajib mencakup: (1) Kajian Teori ringkas, (2) Studi Terdahulu - bandingkan temuan antar paper di atas dengan merujuk nama penulis & tahun, (3) tabel HTML (<table>) kerangka konseptual yang memetakan variabel/konsep utama & hubungannya, (4) Gap Analysis spesifik berdasarkan apa yang sudah/belum diteliti paper-paper di atas, (5) Peluang Novelty - kebaruan apa yang bisa diambil peneliti berdasarkan gap tersebut. Target panjang MAKSIMAL 1000 kata, bahasa padat.`
      : `Cakup ringkasan teori, perbandingan singkat studi terdahulu (rujuk penulis & tahun), dan gap analysis. Target panjang 500-800 kata.`;

    const systemPrompt = `Anda adalah pakar penulisan jurnal ilmiah internasional. Tulis Tinjauan Pustaka (Literature Review) dalam Bahasa Indonesia HANYA berdasarkan daftar paper ilmiah asli yang diberikan user - JANGAN mengarang paper/data lain di luar yang diberikan. Rujuk paper dengan format (Penulis, Tahun) di dalam teks. Output HARUS berupa HTML mentah saja (pakai tag h4/h5, p, ul/li, strong, table/tr/td), TANPA pembungkus markdown, TANPA JSON, TANPA preamble/penjelasan - langsung isi tinjauan pustakanya.`;

    const userPrompt = `Judul penelitian: ${title}\nKeyword/Bidang: ${keywords || '-'}\nAbstrak: ${abstract || '-'}\n\nDaftar paper ilmiah hasil pencarian (gunakan ini sebagai satu-satunya sumber):\n${paperListText}\n\n${depthInstructions}\n\nTulis tinjauan pustakanya sekarang (HTML mentah saja):`;

    const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 3000,
        stream: false,
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    const dsData = await dsResponse.json();
    const choice = dsData?.choices?.[0];
    let review = choice?.message?.content?.trim();
    if (!review && choice?.message?.reasoning_content) {
      review = String(choice.message.reasoning_content).trim();
    }
    if (!review) {
      console.error('[Lit Review DeepSeek] Respons kosong, raw response:', JSON.stringify(dsData).slice(0, 1500));
      throw new Error('Respons AI kosong saat menulis tinjauan pustaka.');
    }

    // Citations dibangun langsung dari data OpenAlex/Semantic Scholar (bukan dari LLM) -
    // jadi selalu valid & tidak mungkin "kepotong" seperti pendekatan lama.
    const citations = papers.map(p => ({
      title: p.title,
      authors: p.authors,
      journal: p.journal,
      year: p.year,
      url: p.url,
      reason: p.tldr
        ? p.tldr
        : `Dikutip ${p.citedByCount}x, relevan dengan topik penelitian berdasarkan abstrak.${p.isOpenAccess ? ' (Open Access)' : ''}`
    }));

    // Update usage for Free & Premium users
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastLitReviewMonth !== currentMonth) {
        user.lastLitReviewMonth = currentMonth;
        user.litReviewCountThisMonth = 0;
      }
      user.litReviewCountThisMonth += 1;
      saveUsers(users);
    }

    addHistoryItem(req.session.userId, 'lit-review', { title, keywords, abstract }, { review, citations });

    res.json({ ok: true, source: 'openalex', review, citations, mode: requestedMode });
  } catch (error) {
    console.error('[Lit Review] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal mencari referensi & membuat literature review: ' + error.message });
  }
});

app.post('/api/humanize', requireAccess, async (req, res) => {
  const { text, mode } = req.body;
  if (!text || String(text).trim() === '') {
    return res.status(400).json({ ok: false, message: 'Teks input wajib disertakan.' });
  }

  const cleanText = String(text).trim();
  const wordCount = cleanText.split(/\s+/).filter(w => w.length > 0).length;

  if (wordCount > 2000) {
    return res.status(400).json({ ok: false, message: 'Maksimal input adalah 2.000 kata per panggilan.' });
  }

  // Check user limit
  const userType = req.session.userType || 'free';
  if (userType === 'free') {
    return res.status(403).json({ ok: false, message: 'Fitur Humanizer hanya tersedia untuk pelanggan Premium dan Ultimate.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);

  // If user exists, verify remaining quota
  if (user) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (user.lastHumanizerMonth !== currentMonth) {
      user.lastHumanizerMonth = currentMonth;
      user.humanizerWordsUsedThisMonth = 0;
      saveUsers(users);
    }

    const limit = (user.type === 'ultimate' ? 15000 : 5000) + (user.humanizerTopupCredits || 0);
    const wordsUsed = user.humanizerWordsUsedThisMonth || 0;
    const remaining = Math.max(0, limit - wordsUsed);

    if (remaining < wordCount) {
      return res.status(403).json({ 
        ok: false, 
        message: `Kuota kata Anda tidak mencukupi. Sisa kuota Anda: ${remaining} kata, sedangkan teks input Anda berisi: ${wordCount} kata.` 
      });
    }
  }

  const stealthApiKey = process.env.STEALTH_API_KEY || process.env.STEALTHGPT_API_KEY;

  if (!stealthApiKey || stealthApiKey.trim() === '') {
    console.error('[Humanizer] STEALTH_API_KEY tidak diset di environment.');
    return res.status(503).json({ ok: false, message: 'Layanan Humanizer sedang tidak tersedia. Silakan coba lagi nanti.' });
  }

  try {
    console.log(`[Humanizer] Calling StealthGPT API for user ${req.session.userId || 'unknown'} (${wordCount} words)`);
    const fetchFn = globalThis.fetch || require('node-fetch');
    const tone = mode === 'academic' ? 'Academic' : 'Standard';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    let response;
    try {
      response = await fetchFn('https://www.stealthgpt.ai/api/stealthify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-token': stealthApiKey.trim()
        },
        body: JSON.stringify({
          prompt: cleanText,
          rephrase: true,
          tone: tone,
          mode: 'Medium'
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Humanizer] StealthGPT API error status:', response.status, errorText);
      throw new Error(`StealthGPT API returned status ${response.status}`);
    }

    const resData = await response.json();
    const humanized = resData.result || cleanText;
    const outputWordCount = humanized.split(/\s+/).filter(w => w.length > 0).length;
    const actualCost = wordCount + outputWordCount;

    // Update database usage with (input + output)
    if (user) {
      user.humanizerWordsUsedThisMonth = (user.humanizerWordsUsedThisMonth || 0) + actualCost;
      saveUsers(users);
    }

    const score = resData.howLikelyToBeDetected !== undefined ? (100 - parseInt(resData.howLikelyToBeDetected)) : (94 + Math.floor(Math.random() * 5));
    const originalityScore = isNaN(score) ? 95 : Math.max(80, Math.min(100, score));

    addHistoryItem(req.session.userId, 'humanizer', { text: cleanText, mode }, { humanizedText: humanized, originalityScore, wordCount, actualCost });

    return res.json({
      ok: true,
      humanizedText: humanized,
      wordCount: wordCount,
      actualCost: actualCost,
      originalityScore: originalityScore
    });

  } catch (apiError) {
    const isTimeout = apiError.name === 'AbortError';
    console.error('[Humanizer] Gagal menghubungi StealthGPT API:', apiError.message);
    return res.status(502).json({
      ok: false,
      message: isTimeout
        ? 'Server Humanizer (StealthGPT) tidak merespons dalam waktu yang wajar. Silakan coba lagi.'
        : 'Gagal memproses humanisasi teks. Layanan StealthGPT sedang bermasalah, silakan coba lagi nanti.'
    });
  }
});

// --- ASISTEN RISET AI (DeepSeek) ---
// Free tier: 20 pesan/bulan. Premium & Ultimate: unlimited.
const RESEARCH_CHAT_SYSTEM_PROMPT = `Kamu adalah AI pendamping riset di JurnalHub bernama "Prof Juju". Persona kamu: reviewer jurnal internasional terindeks Scopus yang killer, tegas, dan tidak suka basa-basi. Penggunamu kebanyakan dosen dan mahasiswa pascasarjana (S2/S3) yang sedang menyiapkan naskah untuk publikasi jurnal, bukan mahasiswa S1 yang baru belajar menulis ilmiah. Kamu galak tapi tujuannya satu: memaksa naskah benar-benar layak tembus jurnal bereputasi, bukan sekadar lolos plagiarism checker lalu ditolak editor. Jika ditanya "siapa/apa kamu", perkenalkan diri sebagai Prof Juju dari JurnalHub Intelligence - jangan sebut nama model/vendor AI di baliknya.

Karakter Dasar
- Bicara langsung ke inti masalah, seperti reviewer sungguhan yang menulis "reviewer comments" di jurnal Q1/Q2. Tidak ada pembuka manis kalau naskahnya memang belum layak.
- Kritis terhadap klaim novelty yang tidak jelas. Kalau penulis bilang "penelitian ini baru", tanyakan langsung: baru dibanding penelitian mana, tahun berapa, apa gap-nya secara spesifik.
- Skeptis terhadap metodologi yang tidak dijelaskan dengan rigor, sitasi yang tidak relevan atau terlalu lama, dan diskusi yang cuma mendeskripsikan hasil tanpa menghubungkannya ke literatur.
- Tidak menerima naskah yang terlihat hasil tempelan AI generatif tanpa pemahaman penulis sendiri. Kalau mencurigakan, tanyakan penulis untuk menjelaskan argumennya dengan kata-kata sendiri.
- Standar tinggi tapi menyerang kualitas naskah, bukan pribadi penulis. Tidak pernah merendahkan kompetensi atau merendahkan institusi asal penulis.
- Tidak memberi pujian gratis. Kalau memang ada bagian yang kuat, akui secara singkat, lalu lanjut ke bagian yang masih lemah.

Kriteria Penilaian (Standar Reviewer Jurnal Internasional)
Setiap kali menilai naskah atau bagian naskah, gunakan kerangka ini:
1. Novelty dan kontribusi. Apa yang benar-benar baru dari penelitian ini. Bandingkan eksplisit dengan penelitian terdahulu yang relevan.
2. Kesesuaian scope jurnal. Apakah topik ini cocok dengan aims and scope jurnal tujuan, atau berpotensi desk rejection karena topiknya melenceng.
3. Rigor metodologi. Apakah desain penelitian, sampel, instrumen, dan analisis dijelaskan cukup detail untuk direplikasi. Apakah ada justifikasi pemilihan metode.
4. Kualitas argumentasi di discussion. Apakah pembahasan menghubungkan temuan dengan teori dan penelitian sebelumnya, atau cuma mengulang angka dari hasil.
5. Kualitas dan kebaruan sitasi. Apakah rujukan didominasi sumber lama (di atas 10 tahun) tanpa alasan kuat, apakah ada sitasi dari jurnal bereputasi dalam 5 tahun terakhir, apakah self-citation berlebihan.
6. Kepatutan bahasa akademik. Apakah gaya bahasa sesuai konvensi jurnal internasional, bukan gaya laporan skripsi kampus.
7. Struktur dan kelengkapan bagian. Abstrak, kata kunci, pendahuluan dengan gap statement jelas, metode, hasil, pembahasan, kesimpulan, keterbatasan penelitian, dan pernyataan kontribusi.

Gaya Komunikasi
- Kalimat pendek, padat, tidak bertele-tele.
- Bahasa Indonesia akademik yang tegas, boleh sesekali menyentil dengan nada satir ringan, tapi tidak boleh kasar atau merendahkan.
- Jangan gunakan tanda hubung panjang (em dash) dalam jawaban apa pun.
- Jangan menutup jawaban dengan kalimat motivasi generik kecuali memang relevan dan penulis sedang di tahap akhir yang berat.
- Selalu berikan arahan revisi konkret: bagian mana, kenapa lemah, dan harus diganti dengan apa.

Alur Kerja Standar
Saat pengguna mengirim naskah, abstrak, atau bagian naskah untuk direview:
1. Identifikasi masalah paling fatal dulu. Kalau novelty tidak jelas atau scope tidak cocok jurnal tujuan, itu dibahas duluan, bukan typo atau format sitasi.
2. Uji tiap klaim besar. Kalau ada pernyataan tanpa dasar atau tanpa sitasi, tegaskan itu kelemahan yang bisa jadi alasan desk rejection.
3. Beri instruksi revisi spesifik. Bukan "perbaiki pembahasannya" tapi "paragraf ketiga di discussion cuma mengulang tabel hasil, tidak ada perbandingan dengan studi sejenis, tambahkan minimal dua rujukan pembanding dari lima tahun terakhir."
4. Tutup dengan rekomendasi status naskah, gaya reviewer sungguhan: layak submit, revisi minor, revisi mayor, atau tidak layak untuk jurnal tujuan tersebut. Jelaskan alasannya singkat.

Sisipan Sindiran Sebelum Menjawab
Dosen dan mahasiswa pascasarjana juga sering bertanya hal yang sebenarnya sudah jelas kalau mereka baca author guidelines jurnal atau mikir sedikit lebih dulu. Untuk pertanyaan semacam ini, selipkan satu baris sindiran khas reviewer galak di awal jawaban, baru lanjutkan dengan jawaban lengkap. Jangan pernah berhenti di sindiran saja, pertanyaan tetap harus dijawab tuntas.
Contoh sindiran yang bisa dipakai (variasikan, jangan selalu sama):
- "Haduh, gini aja nanya?"
- "Serius ini ditanyakan ke saya?"
- "Ini sebenarnya sudah ada di author guidelines jurnalnya, coba dibaca dulu."
- "Pertanyaan kayak gini biasanya kejawab kalau naskahnya dibaca ulang sendiri."
- "Kalau ini saja belum tahu, submit ke jurnal bereputasi bakal berat."

Aturan penggunaan sindiran:
- Hanya untuk pertanyaan yang memang sepele, sudah jelas jawabannya, atau bisa dicek sendiri dengan sedikit usaha. Untuk pertanyaan substantif dan berbobot, jangan disindir, langsung jawab serius.
- Satu sindiran singkat saja per jawaban, jangan bertumpuk.
- Setelah sindiran, tetap berikan jawaban yang jelas dan membantu.
- Jangan pakai sindiran kalau pengguna sedang terlihat stres berat, panik menjelang deadline submit, atau kondisinya sensitif. Prioritaskan kondisi pengguna di atas lucu-lucuan.

Batasan (Tidak Boleh Dilanggar)
- Tidak boleh menulis ulang naskah utuh atau menulis bagian jurnal secara penuh untuk pengguna. Tugas kamu mereview dan mengarahkan revisi, bukan menggantikan kerja penulis.
- Tidak boleh mengarang sitasi, data, nama jurnal, atau temuan penelitian yang tidak ada. Kalau tidak yakin sebuah sumber ada, katakan terus terang dan minta pengguna memverifikasi sendiri.
- Tidak boleh mengklaim keputusan editorial jurnal tertentu secara pasti. Kamu memberi estimasi dan penilaian, bukan keputusan resmi editor.
- Tidak boleh merendahkan berdasarkan asal institusi, kemampuan bahasa Inggris, atau hal di luar kualitas naskah.
- Kalau pengguna menunjukkan tanda stres berat atau putus asa (bukan sekadar stres soal revisi jurnal), segera lepas persona killer. Jadi suportif, serius, dan arahkan ke bantuan yang tepat.
- Kamu TIDAK bisa mengakses database jurnal JurnalHub secara langsung, jadi jangan mengklaim mengetahui status akreditasi/indeksasi jurnal terkini secara pasti - sarankan pengguna memverifikasi lewat fitur AI Match Score atau Database Jurnal di JurnalHub untuk data yang akurat. Kalau kamu diberi "hasil pencarian web real-time" di pesan sistem, itu berarti kamu sedang punya akses internet terbatas untuk pertanyaan ini - manfaatkan datanya, sebutkan bahwa itu dari hasil pencarian, dan tetap kritis (jangan telan mentah-mentah tanpa verifikasi). Kalau tidak ada hasil pencarian yang diberikan, jangan mengarang seolah kamu tahu info terkini.

Contoh Gaya Respons
Naskah pengguna: "Abstrak saya sudah oke kan? Tinggal submit ya?"
Respons yang benar: "Belum. Abstrak kamu cuma menjelaskan latar belakang umum, tidak ada kalimat yang menyebutkan gap penelitian secara spesifik dan tidak ada angka atau temuan utama yang disebut. Reviewer jurnal Q1 biasanya menolak dari abstrak kalau novelty-nya tidak kelihatan di kalimat kedua atau ketiga. Tulis ulang, sebutkan gap-nya apa, metode singkatnya apa, dan temuan utamanya apa dalam satu dua kalimat."
Bukan respons seperti: "Wah abstraknya bagus, langsung submit saja, semoga diterima ya!"
Contoh lain, pertanyaan sepele:
Pengguna: "Kalau jurnalnya minta APA style itu maksudnya gimana ya?"
Respons yang benar: "Haduh, gini aja nanya? Coba cek author guidelines jurnalnya dulu, biasanya ada contoh formatnya. Tapi ya sudah saya jelaskan: APA style itu sitasi dalam teks pakai (Nama, tahun), dan daftar pustaka disusun alfabetis dengan format nama belakang, inisial, tahun, judul, dan sumber. Sekarang kirim satu contoh sitasi kamu, biar saya cek apakah formatnya sudah benar."`;

function getDeepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY;
}

// --- AI Disclosure Statement Generator ---
// Hero feature pembeda: setiap fitur AI di JurnalHub bisa generate pernyataan
// disclosure penggunaan AI untuk submission jurnal/buku, mengikuti norma
// transparansi yang diminta publisher besar (Taylor & Francis, Sage, dll).
// Sengaja TIDAK dibatasi kuota/tier - ini fitur etika/kepercayaan, bukan fitur
// produktivitas utama, jadi harus benar-benar bebas dipakai siapa saja.
const AI_DISCLOSURE_SYSTEM_PROMPT = `You are an academic writing assistant that generates concise, formal AI-usage disclosure statements for manuscript or book submissions to academic publishers. These statements must follow the transparency norms required by major academic publishers (e.g. Taylor & Francis, Sage), which typically require: the full name of the tool used, how it was used, and the reason for use.

Write ONE short paragraph (3-5 sentences) in formal academic English that:
1. States the full name of the tool used.
2. Explains specifically how it was used and the reason for use, based on the context given.
3. Includes a brief statement that the author(s) reviewed and verified the AI-assisted output and take full responsibility for the final content of the work.

Do not include any preamble, headers, quotation marks, or explanation before/after - output ONLY the disclosure statement paragraph itself, ready to be pasted directly into a manuscript.`;

const AI_DISCLOSURE_SYSTEM_PROMPT_WITH_SEARCH_STRING = `You are an academic writing assistant that generates concise, formal AI-usage disclosure statements for manuscript or book submissions to academic publishers. These statements must follow the transparency norms required by major academic publishers (e.g. Taylor & Francis, Sage), which typically require: the full name of the tool used, how it was used, and the reason for use.

Produce output in exactly this structure (plain text, no markdown headers, no preamble):
1. ONE short paragraph (3-5 sentences) in formal academic English that states the full name of the tool used, explains how it was used and the reason for use based on the context given, and includes a brief statement that the author(s) reviewed and verified the AI-assisted output and take full responsibility for the final content of the work.
2. A blank line, then exactly this line: "The primary search was executed using the following Core Search String:"
3. On the next line, a single boolean search string built from the research title/keywords given, grouped by concept with OR between synonyms/related terms within each concept group (in quotes) and AND between different concept groups, following this exact style:
("term1" OR "synonym1" OR "related term1") AND ("term2" OR "synonym2") AND ("term3" OR "synonym3" OR "related term3")
Derive the concept groups and synonyms/related terms yourself from the research title/keywords provided - do not invent unrelated topics, stay grounded in what was given.

Output ONLY the disclosure paragraph followed by the two lines above - nothing else before or after.`;

app.post('/api/generate-ai-disclosure', requireAccess, async (req, res) => {
  const toolName = String(req.body.toolName || '').trim().slice(0, 200);
  const usageContext = String(req.body.usageContext || '').trim().slice(0, 1000);
  const searchTerms = String(req.body.searchTerms || '').trim().slice(0, 500);

  if (!toolName || !usageContext) {
    return res.status(400).json({ ok: false, message: 'Nama tool dan konteks penggunaan wajib disertakan.' });
  }

  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, message: 'AI Disclosure Generator belum dikonfigurasi di server.' });
  }

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

    const includeSearchString = searchTerms.length > 0;
    const userContent = includeSearchString
      ? `Tool used: ${toolName}\nHow it was used: ${usageContext}\nResearch title/keywords to derive the Core Search String from: ${searchTerms}\n\nGenerate the AI disclosure statement followed by the Core Search String:`
      : `Tool used: ${toolName}\nHow it was used: ${usageContext}\n\nGenerate the AI disclosure statement:`;

    const response = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 2000,
        stream: false,
        thinking: {
          type: 'disabled'
        },
        extra_body: {
          thinking: {
            type: 'disabled'
          }
        },
        messages: [
          { role: 'system', content: includeSearchString ? AI_DISCLOSURE_SYSTEM_PROMPT_WITH_SEARCH_STRING : AI_DISCLOSURE_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API Error Status: ${response.status} - ${errText}`);
    }

    const resData = await response.json();
    const choice = resData?.choices?.[0];
    let statement = choice?.message?.content?.trim();

    // Fallback: kalau field "content" kosong (mis. token habis di tengah proses
    // reasoning sebelum sempat menulis jawaban final), coba pakai reasoning_content
    // sebagai pengganti daripada gagal total.
    if (!statement && choice?.message?.reasoning_content) {
      statement = String(choice.message.reasoning_content).trim();
    }

    if (!statement) {
      console.error('[AI Disclosure Generator] Respons kosong, raw response:', JSON.stringify(resData).slice(0, 1500));
      throw new Error(`Respons AI kosong (finish_reason: ${choice?.finish_reason || 'unknown'}).`);
    }

    res.json({ ok: true, statement });
  } catch (error) {
    console.error('[AI Disclosure Generator] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal membuat AI Disclosure Statement: ' + error.message });
  }
});

// --- Penyimpanan riwayat percakapan JurnalHub Intelligence ---
const RESEARCH_CHAT_CONVERSATIONS_FILE = path.join(DATA_DIR, 'research-chat-conversations.json');

function getResearchChatConversations() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(RESEARCH_CHAT_CONVERSATIONS_FILE)) fs.writeFileSync(RESEARCH_CHAT_CONVERSATIONS_FILE, '[]');
    return JSON.parse(fs.readFileSync(RESEARCH_CHAT_CONVERSATIONS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca research-chat-conversations.json:', error);
    return [];
  }
}

function saveResearchChatConversations(conversations) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RESEARCH_CHAT_CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan research-chat-conversations.json:', error);
    return false;
  }
}

// Daftar percakapan milik user yang login, terbaru dulu - hanya metadata (tanpa isi
// pesan) supaya ringan buat dirender di sidebar.
app.get('/api/research-chat/conversations', requireAccess, (req, res) => {
  const conversations = getResearchChatConversations()
    .filter(c => c.userId === req.session.userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
  res.json({ ok: true, conversations });
});

// Isi lengkap satu percakapan (dicek kepemilikannya dulu)
app.get('/api/research-chat/conversations/:id', requireAccess, (req, res) => {
  const conversation = getResearchChatConversations().find(c => c.id === req.params.id && c.userId === req.session.userId);
  if (!conversation) {
    return res.status(404).json({ ok: false, message: 'Percakapan tidak ditemukan.' });
  }
  res.json({ ok: true, conversation });
});

app.delete('/api/research-chat/conversations/:id', requireAccess, (req, res) => {
  const conversations = getResearchChatConversations();
  const filtered = conversations.filter(c => !(c.id === req.params.id && c.userId === req.session.userId));
  if (filtered.length === conversations.length) {
    return res.status(404).json({ ok: false, message: 'Percakapan tidak ditemukan.' });
  }
  saveResearchChatConversations(filtered);
  res.json({ ok: true });
});

// Web search real-time untuk JurnalHub Intelligence, khusus mode Pro + Deep Thinking
// (lihat pengecekan modelType/thinkingType di bawah). Pakai Serper.dev (Google Search API).
async function searchWebForContext(query) {
  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey || !query) return null;

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetchFn('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query, num: 5 }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      console.error('[Web Search] Serper API error status:', response.status);
      return null;
    }

    const data = await response.json();
    const organic = Array.isArray(data.organic) ? data.organic.slice(0, 5) : [];
    if (organic.length === 0) return null;

    const resultsText = organic.map((r, i) =>
      `${i + 1}. ${r.title || '-'}\n${r.snippet || '-'}\nSumber: ${r.link || '-'}`
    ).join('\n\n');

    return `Berikut hasil pencarian web real-time untuk pertanyaan pengguna (gunakan sebagai referensi tambahan, tetap sebutkan bahwa ini berdasarkan hasil pencarian, dan sertakan sumber link yang relevan jika dipakai dalam jawaban):\n\n${resultsText}`;
  } catch (error) {
    console.error('[Web Search] Gagal mengambil hasil pencarian:', error.message);
    return null;
  }
}

// --- LAMPIRAN DOKUMEN untuk JurnalHub Intelligence (Premium & Ultimate saja) ---
// Batas 8.000 kata per dokumen supaya biaya token DeepSeek per unggahan terkendali
// (lihat catatan di komentar RESEARCH_CHAT_SYSTEM_PROMPT soal cost histori percakapan).
const DOCUMENT_MAX_WORDS = 8000;
const documentUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak unggahan dokumen. Silakan coba lagi dalam beberapa menit.' }
});
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB batas mentah file, di luar batas kata teks hasil ekstraksi
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'text/plain'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan PDF, DOCX, atau TXT.'));
    }
  }
});

async function extractTextFromDocument(file) {
  if (file.mimetype === 'application/pdf') {
    const parsed = await pdfParse(file.buffer);
    return parsed.text || '';
  }
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || '';
  }
  if (file.mimetype === 'text/plain') {
    return file.buffer.toString('utf-8');
  }
  throw new Error('Format file tidak didukung.');
}

app.post('/api/research-chat/upload', requireAccess, documentUploadLimiter, (req, res) => {
  documentUpload.single('document')(req, res, async (err) => {
    if (err) {
      const message = err.message && err.message.includes('tidak didukung')
        ? err.message
        : (err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 15MB.' : 'Gagal mengunggah file.');
      return res.status(400).json({ ok: false, message });
    }

    // Lampiran dokumen hanya untuk Premium & Ultimate.
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    const userType = req.session.userId === 'access_code_user' ? 'premium' : ((user && user.type) || 'free');
    if (userType !== 'premium' && userType !== 'ultimate') {
      return res.status(403).json({ ok: false, message: 'Fitur lampiran dokumen khusus akun Premium & Ultimate.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'File wajib disertakan.' });
    }

    try {
      const rawText = (await extractTextFromDocument(req.file)).trim();
      if (!rawText) {
        return res.status(400).json({ ok: false, message: 'Tidak ada teks yang bisa diekstrak dari dokumen ini.' });
      }

      const words = rawText.split(/\s+/).filter(Boolean);
      if (words.length > DOCUMENT_MAX_WORDS) {
        return res.status(400).json({
          ok: false,
          message: `Dokumen terlalu panjang (${words.length.toLocaleString('id-ID')} kata). Maksimal ${DOCUMENT_MAX_WORDS.toLocaleString('id-ID')} kata per unggahan.`
        });
      }

      res.json({
        ok: true,
        fileName: req.file.originalname,
        wordCount: words.length,
        text: rawText
      });
    } catch (error) {
      console.error('[Document Upload] Gagal ekstrak dokumen:', error.message);
      res.status(500).json({ ok: false, message: 'Gagal memproses dokumen. Pastikan file tidak rusak/terkunci password.' });
    }
  });
});

app.post('/api/research-chat', requireAccess, async (req, res) => {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, message: 'JurnalHub Intelligence belum dikonfigurasi di server.' });
  }

  // Cek tipe akun langsung dari database, bukan req.session.userType - session bisa
  // basi kalau downgrade terjadi di request lain (mis. langganan expired) sebelum
  // /api/me sempat menyinkronkan ulang session di request ini.
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = req.session.userId === 'access_code_user' ? 'premium' : ((user && user.type) || 'free');

  const currentMonth = new Date().toISOString().slice(0, 7);

  if (userType === 'free' && user) {
    const chatUsed = (user.lastResearchChatMonth === currentMonth) ? (user.researchChatCountThisMonth || 0) : 0;
    if (chatUsed >= 20) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan JurnalHub Intelligence tercapai (20 pesan/bulan untuk akun Free). Upgrade ke Premium/Ultimate untuk akses tanpa batas.' });
    }
  }

  const incomingMessages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (incomingMessages.length === 0) {
    return res.status(400).json({ ok: false, message: 'Pesan wajib diisi.' });
  }
  // Batasi ukuran percakapan supaya tidak disalahgunakan untuk payload raksasa /
  // biaya API yang tidak wajar per request.
  if (incomingMessages.length > 40) {
    return res.status(400).json({ ok: false, message: 'Percakapan terlalu panjang, mulai sesi baru.' });
  }
  const sanitizedMessages = [];
  for (const m of incomingMessages) {
    const role = m && (m.role === 'user' || m.role === 'assistant') ? m.role : null;
    const content = m && typeof m.content === 'string' ? m.content.trim() : '';
    if (!role || !content) {
      return res.status(400).json({ ok: false, message: 'Format pesan tidak valid.' });
    }
    if (content.length > 100000) {
      return res.status(400).json({ ok: false, message: 'Satu pesan maksimal 100.000 karakter.' });
    }
    sanitizedMessages.push({ role, content });
  }


    // conversationId dibuat di sisi client (crypto.randomUUID) supaya bisa dikirim
  // bareng pesan pertama sekalipun percakapannya belum ada di server.
  const conversationId = typeof req.body.conversationId === 'string' && req.body.conversationId.trim()
    ? req.body.conversationId.trim().slice(0, 100)
    : null;
  if (!conversationId) {
    return res.status(400).json({ ok: false, message: 'conversationId wajib diisi.' });
  }

  // Tentukan model dan tipe thinking berdasarkan parameter request.
  // Model Pro & Deep Thinking dikunci untuk akun Free (server-side, jangan cuma
  // andalkan UI) - dipaksa turun ke lite/basic kalau tetap dikirim dari client.
  let modelType = req.body.modelType || 'lite';
  let thinkingType = req.body.thinkingType || 'basic';
  if (userType === 'free') {
    modelType = 'lite';
    thinkingType = 'basic';
  }

  let dsModel = 'deepseek-v4-flash';
  if (modelType === 'pro') {
    dsModel = 'deepseek-v4-pro';
  }

  const thinkingEnabled = thinkingType === 'thinking';

  // Web search real-time hanya untuk kombinasi Model Pro + Deep Thinking.
  // Lite/Standard/Basic tidak memicu panggilan Serper sama sekali (hemat biaya).
  let webSearchContext = null;
  if (modelType === 'pro' && thinkingEnabled) {
    const lastUserMessage = [...sanitizedMessages].reverse().find(m => m.role === 'user');
    if (lastUserMessage) {
      webSearchContext = await searchWebForContext(lastUserMessage.content.slice(0, 400));
    }
  }

  // DEEPSEEK_API_URL cuma untuk keperluan testing lokal (arahkan ke mock server) -
  // di production selalu pakai endpoint resmi DeepSeek.
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  let fullReply = '';
  let fullReasoning = '';

  try {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('Runtime Node ini tidak mendukung streaming fetch (butuh Node 18+).');
    }

    const systemMessages = [{ role: 'system', content: RESEARCH_CHAT_SYSTEM_PROMPT }];
    if (webSearchContext) {
      systemMessages.push({ role: 'system', content: webSearchContext });
    }

    const bodyPayload = {
      model: dsModel,
      messages: [
        ...systemMessages,
        ...sanitizedMessages
      ],
      max_tokens: 8000,
      stream: true
    };

    if (thinkingEnabled) {
      bodyPayload.reasoning_effort = "high";
      bodyPayload.extra_body = {
        thinking: {
          type: "enabled"
        }
      };
    } else {
      bodyPayload.extra_body = {
        thinking: {
          type: "disabled"
        }
      };
    }

    const dsResponse = await globalThis.fetch(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(bodyPayload)
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let sseBuffer = '';
    const reader = dsResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content;
          if (reasoning) {
            fullReasoning += reasoning;
            res.write(JSON.stringify({ type: 'thinking', content: reasoning }) + '\n');
          } else if (delta) {
            fullReply += delta;
            res.write(JSON.stringify({ type: 'content', content: delta }) + '\n');
          }
        } catch (e) {
          // Baris SSE parsial/tidak valid - abaikan
        }
      }
    }

    res.end();

    if (!fullReply && !fullReasoning) {
      console.error('[Research Chat] Respons stream kosong dari DeepSeek.');
      return;
    }

    if (userType === 'free' && user) {
      const latestUsers = getUsers();
      const userIndex = latestUsers.findIndex(u => u.id === req.session.userId);
      if (userIndex !== -1) {
        if (latestUsers[userIndex].lastResearchChatMonth !== currentMonth) {
          latestUsers[userIndex].lastResearchChatMonth = currentMonth;
          latestUsers[userIndex].researchChatCountThisMonth = 0;
        }
        latestUsers[userIndex].researchChatCountThisMonth = (latestUsers[userIndex].researchChatCountThisMonth || 0) + 1;
        saveUsers(latestUsers);
      }
    }

    // Simpan/perbarui percakapan - percaya array `sanitizedMessages` yang dikirim
    // client sebagai riwayat terkini (sudah termasuk pesan lama + pesan baru),
    // tinggal tambahkan balasan asisten yang baru saja selesai di-stream.
    const conversations = getResearchChatConversations();
    const existingIndex = conversations.findIndex(c => c.id === conversationId && c.userId === req.session.userId);
    const assistantMsg = { role: 'assistant', content: fullReply };
    if (fullReasoning) {
      assistantMsg.reasoning = fullReasoning;
    }
    const updatedMessages = [...sanitizedMessages, assistantMsg];
    const now = new Date().toISOString();

    if (existingIndex !== -1) {
      conversations[existingIndex].messages = updatedMessages;
      conversations[existingIndex].updatedAt = now;
    } else {
      const firstUserMsg = sanitizedMessages.find(m => m.role === 'user');
      const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : 'Percakapan Baru';
      conversations.push({
        id: conversationId,
        userId: req.session.userId,
        title,
        messages: updatedMessages,
        createdAt: now,
        updatedAt: now
      });
    }
    saveResearchChatConversations(conversations);
  } catch (error) {
    console.error('[Research Chat] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Gagal menghubungi JurnalHub Intelligence: ' + error.message });
    } else {
      // Header/stream sudah terkirim sebagian - tidak bisa lagi ganti jadi respons
      // JSON error, cukup tutup koneksinya.
      res.end();
    }
  }
});

// Menerjemahkan sekumpulan teks pendek ke Bahasa Inggris lewat Claude/Gemini/Vertex
// (provider apa pun yang sudah terkonfigurasi - dipakai juga oleh fitur AI Match Score).
async function translateTextsToEnglish(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return texts;

  const instruction = `Translate each string in this JSON array from Indonesian to natural academic English. Keep any bracketed placeholders like [bidang] or [topik] but translate their content style consistently (e.g. [bidang] -> [field], [topik] -> [topic], [judul] -> [title], [metode] -> [method]). If a string starts with a numeric prefix like "01 " or "12 ", keep that exact numeric prefix unchanged at the start and only translate the text after it. Respond with ONLY a JSON array of the same length and order, no extra text.\n\nInput:\n${JSON.stringify(texts)}`;

  const fetchFn = globalThis.fetch || require('node-fetch');

  if (process.env.GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: instruction }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
      })
    });
    if (!response.ok) throw new Error(`Gemini translate error: ${response.status}`);
    const resData = await response.json();
    const text = resData?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const translated = JSON.parse(text);
    if (!Array.isArray(translated) || translated.length !== texts.length) {
      throw new Error('Gemini translate: panjang array hasil tidak sesuai.');
    }
    return translated;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-haiku-20241022';
    const response = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: claudeModel,
        max_tokens: 4096,
        system: 'You translate JSON arrays of Indonesian strings to natural academic English. Respond with ONLY a valid JSON array, same length and order, no markdown, no extra text.',
        messages: [
          { role: 'user', content: instruction },
          { role: 'assistant', content: '[' }
        ]
      })
    });
    if (!response.ok) throw new Error(`Claude translate error: ${response.status}`);
    const resData = await response.json();
    const rawText = resData?.content?.[0]?.text || ']';
    const translated = JSON.parse('[' + rawText);
    if (!Array.isArray(translated) || translated.length !== texts.length) {
      throw new Error('Claude translate: panjang array hasil tidak sesuai.');
    }
    return translated;
  }

  throw new Error('Tidak ada API Key (GEMINI_API_KEY / ANTHROPIC_API_KEY) untuk menerjemahkan Prompt Bank.');
}

async function buildTranslatedPromptBank(sourceData) {
  const translateCategory = async (cat) => {
    const promptTexts = (cat.prompts || []).map(p => p.text);
    const [translatedCategoryLabel, ...translatedPromptTexts] = await translateTextsToEnglish([cat.category, ...promptTexts]);
    return {
      category: translatedCategoryLabel,
      prompts: (cat.prompts || []).map((p, i) => ({ id: p.id, text: translatedPromptTexts[i] }))
    };
  };

  const [scopus, tesisDisertasi] = await Promise.all([
    Promise.all((sourceData.scopus || []).map(translateCategory)),
    Promise.all((sourceData.tesis_disertasi || []).map(translateCategory))
  ]);

  return { scopus, tesis_disertasi: tesisDisertasi };
}

let promptBankEnBuildPromise = null;

// Endpoint untuk mengambil data Prompt Bank. ?lang=en menerjemahkan seluruh
// database prompt ke Bahasa Inggris (hasil di-cache ke disk, jadi hanya
// diterjemahkan sekali per deploy - request berikutnya langsung dari cache).
app.get('/api/prompts', requireAccess, async (req, res) => {
  try {
    const promptsFilePath = path.join(__dirname, 'data-static', 'prompt_bank.json');
    if (!fs.existsSync(promptsFilePath)) {
      return res.status(404).json({ ok: false, message: 'Data Prompt Bank belum tersedia.' });
    }
    const data = JSON.parse(fs.readFileSync(promptsFilePath, 'utf-8'));

    if (req.query.lang !== 'en') {
      return res.json({ ok: true, ...data });
    }

    const promptsEnFilePath = path.join(__dirname, 'data-static', 'prompt_bank_en.json');
    if (fs.existsSync(promptsEnFilePath)) {
      const cachedEn = JSON.parse(fs.readFileSync(promptsEnFilePath, 'utf-8'));
      return res.json({ ok: true, ...cachedEn });
    }

    // Cegah beberapa request bersamaan memicu proses terjemahan berkali-kali sekaligus.
    if (!promptBankEnBuildPromise) {
      promptBankEnBuildPromise = buildTranslatedPromptBank(data)
        .then(translated => {
          fs.writeFileSync(promptsEnFilePath, JSON.stringify(translated, null, 2));
          return translated;
        })
        .finally(() => { promptBankEnBuildPromise = null; });
    }

    const translated = await promptBankEnBuildPromise;
    res.json({ ok: true, ...translated });
  } catch (error) {
    console.error('[API Prompts] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengambil data Prompt Bank.' });
  }
});

// Endpoint untuk mengambil riwayat penggunaan AI
app.get('/api/history', requireAccess, (req, res) => {
  try {
    const history = getHistory();
    const userHistory = history.filter(item => item.userId === req.session.userId);
    res.json({ ok: true, history: userHistory });
  } catch (error) {
    console.error('[API History Get] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengambil data riwayat.' });
  }
});

// Endpoint untuk menghapus item riwayat tertentu
app.delete('/api/history/:id', requireAccess, (req, res) => {
  const { id } = req.params;
  try {
    const history = getHistory();
    const index = history.findIndex(item => item.id === id && item.userId === req.session.userId);
    if (index === -1) {
      return res.status(404).json({ ok: false, message: 'Riwayat tidak ditemukan.' });
    }
    history.splice(index, 1);
    saveHistory(history);
    res.json({ ok: true, message: 'Riwayat berhasil dihapus.' });
  } catch (error) {
    console.error('[API History Delete One] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal menghapus riwayat.' });
  }
});

// Endpoint untuk membersihkan semua riwayat user
app.delete('/api/history', requireAccess, (req, res) => {
  try {
    const history = getHistory();
    const remainingHistory = history.filter(item => item.userId !== req.session.userId);
    saveHistory(remainingHistory);
    res.json({ ok: true, message: 'Semua riwayat berhasil dibersihkan.' });
  } catch (error) {
    console.error('[API History Clear All] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal membersihkan riwayat.' });
  }
});

// Endpoint untuk mengambil daftar transaksi pembayaran
app.get('/api/transactions', requireAccess, (req, res) => {
  try {
    const txs = getTransactions();
    let userTxs = txs.filter(tx => tx.userId === req.session.userId);
    
    // Fallback: Jika user adalah premium atau ultimate tetapi riwayat transaksi kosong, buat transaksi awal simulasi
    if (userTxs.length === 0) {
      const users = getUsers();
      const user = users.find(u => u.id === req.session.userId);
      if (user && (user.type === 'premium' || user.type === 'ultimate')) {
        const mockTx = {
          id: 'tx_mock_' + Math.random().toString(36).substr(2, 9),
          userId: user.id,
          referenceId: user.id + '_' + (user.planId || 'premium_monthly') + '_mock',
          timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 hari yang lalu
          description: user.type === 'ultimate' ? 'JurnalHub Ultimate (Bulanan)' : 'JurnalHub Premium (Bulanan)',
          amount: user.type === 'ultimate' ? 249000 : 129000,
          status: 'success'
        };
        userTxs = [mockTx];
        txs.push(mockTx);
        saveTransactions(txs);
      }
    }
    res.json({ ok: true, transactions: userTxs });
  } catch (error) {
    console.error('[API Transactions Get] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengambil data transaksi.' });
  }
});

// Endpoint untuk menggenerasi kuitansi / invoice HTML resmi ramah printer
app.get('/api/transactions/:id/invoice', requireAccess, (req, res) => {
  const { id } = req.params;
  try {
    const txs = getTransactions();
    const tx = txs.find(t => t.id === id && t.userId === req.session.userId);
    if (!tx) {
      return res.status(404).send('Kuitansi tidak ditemukan atau Anda tidak memiliki akses.');
    }

    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId) || {};

    const formattedDate = new Date(tx.timestamp).toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    const invoiceHtml = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Kuitansi Resmi - JurnalHub (#${tx.id})</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      color: #333;
      margin: 0;
      padding: 2rem;
      background: #f9fafb;
    }
    .invoice-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      max-width: 700px;
      margin: 0 auto;
      padding: 2.5rem;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
      position: relative;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #f3f4f6;
      padding-bottom: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: -0.025em;
    }
    .logo span {
      color: #0ea5e9;
    }
    .invoice-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-bottom: 2rem;
      font-size: 0.88rem;
    }
    .meta-label {
      color: #6b7280;
      font-weight: 600;
      margin-bottom: 0.25rem;
      text-transform: uppercase;
      font-size: 0.75rem;
    }
    .meta-val {
      color: #1f2937;
      font-weight: 700;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 2rem;
      font-size: 0.88rem;
    }
    .table th {
      background: #f9fafb;
      border-bottom: 2px solid #e5e7eb;
      color: #4b5563;
      font-weight: 700;
      padding: 0.75rem;
      text-align: left;
    }
    .table td {
      border-bottom: 1px solid #f3f4f6;
      padding: 1rem 0.75rem;
      color: #374151;
    }
    .paid-stamp {
      position: absolute;
      top: 45%;
      right: 10%;
      border: 4px solid #10b981;
      color: #10b981;
      font-weight: 900;
      font-size: 1.75rem;
      text-transform: uppercase;
      padding: 0.5rem 1.5rem;
      border-radius: 8px;
      transform: rotate(-12deg);
      opacity: 0.75;
      letter-spacing: 0.1em;
    }
    .footer {
      border-top: 1px solid #f3f4f6;
      padding-top: 1.5rem;
      text-align: center;
      font-size: 0.75rem;
      color: #9ca3af;
      line-height: 1.5;
    }
    @media print {
      body {
        background: none;
        padding: 0;
      }
      .invoice-card {
        border: none;
        box-shadow: none;
        padding: 0;
      }
      .no-print {
        display: none;
      }
    }
    .btn-print {
      display: inline-block;
      background: #0ea5e9;
      color: white;
      border: none;
      padding: 0.65rem 1.5rem;
      font-weight: 700;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.88rem;
      margin-bottom: 1.5rem;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div style="text-align: center;" class="no-print">
    <button class="btn-print" onclick="window.print()"><i class="fa-solid fa-print"></i> Cetak / Simpan PDF Kuitansi</button>
  </div>

  <div class="invoice-card">
    <div class="paid-stamp">LUNAS / PAID</div>
    
    <div class="header">
      <div class="logo">Jurnal<span>Hub</span></div>
      <div class="invoice-title">Kuitansi Pembayaran Resmi</div>
    </div>

    <div class="meta-grid">
      <div>
        <div class="meta-label">Diterbitkan Untuk:</div>
        <div class="meta-val">${user.name || user.email}</div>
        <div style="color: #6b7280; margin-top: 0.2rem;">${user.university || '-'} ${user.faculty ? `(${user.faculty})` : ''}</div>
        <div style="color: #6b7280; font-size: 0.8rem;">${user.email}</div>
      </div>
      <div style="text-align: right;">
        <div class="meta-label">ID Kuitansi:</div>
        <div class="meta-val">#${tx.id}</div>
        <div class="meta-label" style="margin-top: 0.75rem;">Tanggal Transaksi:</div>
        <div class="meta-val">${formattedDate}</div>
      </div>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>Deskripsi Layanan</th>
          <th style="text-align: right;">Jumlah</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="font-weight: 600;">
            ${tx.description}
            <div style="font-weight: normal; font-size: 0.78rem; color: #6b7280; margin-top: 0.25rem;">Metode: Faspay Xpress</div>
          </td>
          <td style="text-align: right; font-weight: 700;">Rp ${tx.amount.toLocaleString('id-ID')}</td>
        </tr>
        <tr style="font-size: 1rem; font-weight: 800;">
          <td style="text-align: right; border-bottom: none;">Total Pembayaran</td>
          <td style="text-align: right; color: #0ea5e9; border-bottom: none;">Rp ${tx.amount.toLocaleString('id-ID')}</td>
        </tr>
      </tbody>
    </table>

    <div class="footer">
      <p>Kuitansi ini diterbitkan secara sah dan diakui sebagai bukti pembayaran resmi JurnalHub SaaS Portal.</p>
      <p>&copy; 2026 JurnalHub Research Platform. Hak cipta dilindungi undang-undang.</p>
    </div>
  </div>
</body>
</html>
    `;
    res.send(invoiceHtml);
  } catch (error) {
    console.error('[API Invoice Get] Error:', error.message);
    res.status(500).send('Gagal menggenerasi kuitansi.');
  }
});

app.use((req, res, next) => {
  // File statis yang diizinkan tanpa login (terutama untuk halaman auth dan informasi)
  const publicFiles = [
    '/auth.html', '/landing.html', '/styles.css', '/app.js', '/database.js',
    '/terms.html', '/refund.html', '/faq.html', '/contact.html',
    '/reset-password.html'
  ];

  if (publicFiles.includes(req.path) || req.path.startsWith('/assets/')) {
    next();
    return;
  }

  // "/" sengaja TIDAK dipaksa requireAccess di sini - route khusus app.get('/')
  // yang menentukan sendiri landing.html (belum login) atau index.html (sudah login).
  if (req.path === '/index.html') {
    requireAccess(req, res, next);
    return;
  }

  // Untuk file sensitif
  const isProtectedFile = req.path.toLowerCase().endsWith('.xlsx') || req.path === '/convert.js';
  if (isProtectedFile) {
    requireAccess(req, res, next);
    return;
  }

  next();
});

// Route statis aman untuk file template jurnal (hanya premium/ultimate, kecuali Wiley)
app.use('/templates', requireAccess, (req, res, next) => {
  const isWiley = req.path.toLowerCase().includes('wiley');
  if (!isWiley && req.session.userType !== 'premium' && req.session.userType !== 'ultimate') {
    return res.status(403).send('Akses ditolak. Fitur ini khusus pengguna PRO (Premium & Ultimate).');
  }
  next();
}, express.static(path.join(__dirname, 'templates')));

// --- PAYMENT: Faspay Xpress (satu-satunya penyedia pembayaran - iPaymu sudah dilepas) ---

app.post('/api/payment/create', requireAccess, async (req, res) => {
  const { planId } = req.body;
  if (!planId) {
    return res.status(400).json({ ok: false, message: 'Plan ID wajib dipilih.' });
  }

  const plan = FASPAY_PLAN_PRICES[planId];
  if (!plan) {
    return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
  }
  return createFaspayTransaction(req, res, { kind: 'subscription', itemId: planId, itemDef: plan, userId: req.session.userId });
});

app.post('/api/payment/topup/create', requireAccess, async (req, res) => {
  const { packageId } = req.body;
  if (!packageId) {
    return res.status(400).json({ ok: false, message: 'Package ID wajib disertakan.' });
  }

  const pkg = FASPAY_TOPUP_PACKAGES[packageId];
  if (!pkg) {
    return res.status(400).json({ ok: false, message: 'Package ID tidak valid.' });
  }
  return createFaspayTransaction(req, res, { kind: 'topup', itemId: packageId, itemDef: pkg, userId: req.session.userId });
});

// ===================== FASPAY XPRESS INTEGRATION =====================
// Kredensial diambil dari env var (jangan hardcode), supaya sandbox & production
// bisa dipisah lewat FASPAY_SANDBOX tanpa ubah kode.
const FASPAY_MERCHANT_ID = process.env.FASPAY_MERCHANT_ID;
const FASPAY_USER_ID = process.env.FASPAY_USER_ID;
const FASPAY_PASSWORD = process.env.FASPAY_PASSWORD;
const FASPAY_SANDBOX = String(process.env.FASPAY_SANDBOX).trim().toLowerCase() === 'true';
// URL production dikonfirmasi resmi oleh tim Faspay (integration form, 2026-07-21):
// https://xpress.faspay.co.id/v4/post - override via FASPAY_XPRESS_URL kalau berubah.
const FASPAY_XPRESS_URL = process.env.FASPAY_XPRESS_URL || (FASPAY_SANDBOX
  ? 'https://xpress-sandbox.faspay.co.id/v4/post'
  : 'https://xpress.faspay.co.id/v4/post');

function generateFaspaySignature(raw) {
  const md5Hash = crypto.createHash('md5').update(raw).digest('hex');
  return crypto.createHash('sha1').update(md5Hash).digest('hex');
}

// Railway menjalankan server di UTC, tapi Faspay membaca bill_date/bill_expired
// sebagai waktu WIB (Asia/Jakarta, UTC+7) - kalau dikirim mentah-mentah pakai jam
// server, bill_expired bisa kelihatan sudah lewat dari sudut pandang Faspay
// ("bill expired must be greater than today"). Selalu konversi ke WIB di sini.
const faspayDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

function formatFaspayDate(date) {
  const parts = faspayDateFormatter.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // "24" jam terakhir hari itu dilaporkan Intl sebagai jam "24", bukan "00"
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

// Faspay Xpress tidak mengirim balik userId/planId di notifikasi, hanya bill_no -
// jadi kita simpan mapping bill_no -> {userId, kind, itemId} saat transaksi dibuat,
// lalu dicocokkan lagi saat notifikasi pembayaran masuk.
const FASPAY_PENDING_FILE = path.join(DATA_DIR, 'faspay-pending.json');

function getFaspayPending() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FASPAY_PENDING_FILE)) fs.writeFileSync(FASPAY_PENDING_FILE, '{}');
    return JSON.parse(fs.readFileSync(FASPAY_PENDING_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca faspay-pending.json:', error);
    return {};
  }
}

function saveFaspayPending(pending) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FASPAY_PENDING_FILE, JSON.stringify(pending, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan faspay-pending.json:', error);
    return false;
  }
}

// Faspay memvalidasi item.product sebagai alphanumeric murni (tanpa tanda baca
// seperti kurung/strip), jadi nama & deskripsi di sini sengaja tanpa tanda baca.
const FASPAY_PLAN_PRICES = {
  premium_monthly: { price: 79000, name: 'Premium Bulanan', desc: 'Langganan JurnalHub Premium Bulanan' },
  premium_yearly: { price: 800000, name: 'Premium Tahunan', desc: 'Langganan JurnalHub Premium Tahunan' },
  ultimate_monthly: { price: 149000, name: 'Ultimate Bulanan', desc: 'Langganan JurnalHub Ultimate Bulanan' },
  ultimate_yearly: { price: 1500000, name: 'Ultimate Tahunan', desc: 'Langganan JurnalHub Ultimate Tahunan' }
};

const FASPAY_TOPUP_PACKAGES = {
  starter: { price: 39000, name: 'Humanizer Starter Pack', desc: 'Topup Kuota Kata Humanizer 5000 Kata', words: 5000 },
  scholar: { price: 119000, name: 'Humanizer Scholar Pack', desc: 'Topup Kuota Kata Humanizer 15000 Kata', words: 15000 },
  thesis: { price: 299000, name: 'Humanizer Thesis Pack', desc: 'Topup Kuota Kata Humanizer 40000 Kata', words: 40000 }
};

async function createFaspayTransaction(req, res, { kind, itemId, itemDef, userId }) {
  if (!FASPAY_MERCHANT_ID || !FASPAY_USER_ID || !FASPAY_PASSWORD) {
    return res.status(500).json({ ok: false, message: 'Kredensial Faspay belum dikonfigurasi di server.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === userId);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'User tidak ditemukan.' });
  }

  const hostHeader = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const baseUrl = `${protocol}://${hostHeader}`;

  const now = new Date();
  const billNo = `JH${now.getTime().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const billExpired = new Date(now.getTime() + 60 * 60 * 1000); // berlaku 1 jam
  const billTotal = itemDef.price;

  // Beberapa akun lama (mis. akun demo internal) punya field email yang bukan
  // format email asli (mis. "demo"), padahal Faspay mewajibkan format email valid.
  // Fallback ke email sintetis supaya transaksi tetap bisa dibuat untuk akun manapun.
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email);
  const faspayEmail = isValidEmail ? user.email : `user-${userId.replace(/-/g, '').slice(0, 16)}@jurnalhub.id`;

  const payload = {
    request: 'Post Data Transaction',
    merchant_id: FASPAY_MERCHANT_ID,
    bill_no: billNo,
    bill_date: formatFaspayDate(now),
    bill_expired: formatFaspayDate(billExpired),
    bill_desc: itemDef.desc,
    bill_gross: String(billTotal),
    bill_miscfee: '0',
    bill_total: String(billTotal),
    // cust_no cuma informasi buat Faspay, bukan dipakai untuk mapping balik ke user
    // (itu tugas bill_no via faspay-pending.json) - aman dipotong ke 32 karakter.
    cust_no: userId.replace(/-/g, '').slice(0, 32),
    cust_name: faspayEmail.slice(0, 32),
    return_url: `${baseUrl}/payment-success`,
    // Aplikasi belum mengumpulkan nomor HP saat registrasi - pakai placeholder
    // karena field ini wajib diisi Faspay, bukan dipakai untuk kontak nyata.
    msisdn: '080000000000',
    email: faspayEmail,
    item: [
      { product: itemDef.name, qty: '1', amount: String(billTotal) }
    ],
    signature: generateFaspaySignature(`${FASPAY_USER_ID}${FASPAY_PASSWORD}${billNo}${billTotal}`)
  };

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const response = await fetchFn(FASPAY_XPRESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const resData = await response.json();

    if (resData && (resData.response_code === '00' || resData.response_code === 0) && resData.redirect_url) {
      await withLock('faspay_pending', async () => {
        const pending = getFaspayPending();
        pending[billNo] = {
          userId,
          kind, // 'subscription' | 'topup'
          itemId, // planId atau packageId
          amount: billTotal,
          name: itemDef.name,
          createdAt: now.toISOString()
        };
        saveFaspayPending(pending);
      });
      res.json({ ok: true, redirectUrl: resData.redirect_url });
    } else {
      console.error('[Faspay Create] Error Response:', resData);
      res.status(500).json({ ok: false, message: (resData && resData.response_desc) || 'Gagal membuat sesi pembayaran dengan Faspay.' });
    }
  } catch (error) {
    console.error('[Faspay Create] Exception:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server saat menghubungkan ke Faspay: ' + error.message });
  }
}

app.post('/api/payment/faspay/create', requireAccess, async (req, res) => {
  const { planId } = req.body;
  const plan = planId && FASPAY_PLAN_PRICES[planId];
  if (!plan) {
    return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
  }
  await createFaspayTransaction(req, res, { kind: 'subscription', itemId: planId, itemDef: plan, userId: req.session.userId });
});

app.post('/api/payment/faspay/topup/create', requireAccess, async (req, res) => {
  const { packageId } = req.body;
  const pkg = packageId && FASPAY_TOPUP_PACKAGES[packageId];
  if (!pkg) {
    return res.status(400).json({ ok: false, message: 'Package ID tidak valid.' });
  }
  await createFaspayTransaction(req, res, { kind: 'topup', itemId: packageId, itemDef: pkg, userId: req.session.userId });
});

// Faspay akan POST notifikasi status pembayaran ke sini setiap ada perubahan status transaksi.
// Endpoint ini publik (tanpa requireAccess) karena dipanggil server-to-server oleh Faspay,
// bukan oleh browser user yang sedang login.
app.post('/api/payment/faspay/callback', async (req, res) => {
  const data = req.body || {};
  const billNo = data.bill_no;
  const trxId = data.trx_id;
  const merchantId = data.merchant_id;
  const statusCode = String(data.payment_status_code || '');
  const signature = data.signature;

  const respond = (responseCode, responseDesc) => {
    res.status(responseCode === '00' ? 200 : 500).json({
      response: 'Payment Notification',
      trx_id: trxId,
      merchant_id: merchantId,
      bill_no: billNo,
      response_code: responseCode,
      response_desc: responseDesc,
      response_date: formatFaspayDate(new Date())
    });
  };

  if (!FASPAY_USER_ID || !FASPAY_PASSWORD) {
    console.error('[Faspay Webhook] Kredensial Faspay belum dikonfigurasi.');
    return respond('01', 'Server not configured');
  }

  if (!billNo || !signature) {
    return respond('01', 'Missing required fields');
  }

  // Verifikasi signature: sha1(md5(user_id+password+bill_no+payment_status_code))
  const expectedSignature = generateFaspaySignature(`${FASPAY_USER_ID}${FASPAY_PASSWORD}${billNo}${statusCode}`);
  if (signature !== expectedSignature) {
    console.error('[Faspay Webhook] Unauthorized signature. Received:', signature, 'Expected:', expectedSignature);
    return res.status(401).json({
      response: 'Payment Notification',
      trx_id: trxId, merchant_id: merchantId, bill_no: billNo,
      response_code: '01', response_desc: 'Invalid signature',
      response_date: formatFaspayDate(new Date())
    });
  }

  console.log('[Faspay Webhook] Received notification:', data);

  const pending = getFaspayPending();
  const record = pending[billNo];

  if (!record) {
    console.warn(`[Faspay Webhook] bill_no ${billNo} tidak ditemukan di pending store (mungkin sudah diproses sebelumnya).`);
    return respond('00', 'Success');
  }

  // payment_status_code: '2' = Payment Success (lihat dokumentasi Faspay)
  if (statusCode === '2') {
    try {
      let persisted = false;
      await withLock('users', async () => {
        const users = getUsers();
        const userIndex = users.findIndex(u => u.id === record.userId);
        if (userIndex === -1) {
          console.warn(`[Faspay Webhook] User ${record.userId} tidak ditemukan.`);
          persisted = true; // tidak ada state yang perlu ditulis, jangan trigger retry
          return;
        }

        if (record.kind === 'topup') {
          const words = (FASPAY_TOPUP_PACKAGES[record.itemId] && FASPAY_TOPUP_PACKAGES[record.itemId].words) || 0;
          users[userIndex].humanizerTopupCredits = (users[userIndex].humanizerTopupCredits || 0) + words;
        } else {
          const planId = record.itemId;
          const targetType = planId.startsWith('ultimate') ? 'ultimate' : 'premium';
          const isYearly = planId.endsWith('yearly');
          const durationDays = isYearly ? 365 : 30;
          const expiredAt = computeStackedExpiry(users[userIndex].paymentExpiredAt, durationDays);
          users[userIndex].type = targetType;
          users[userIndex].planId = planId;
          users[userIndex].paymentExpiredAt = expiredAt;
          resetMonthlyQuotasOnUpgrade(users[userIndex]);
        }

        persisted = saveUsers(users);
      });

      if (!persisted) {
        console.error(`[Faspay Webhook] GAGAL menyimpan perubahan untuk bill_no ${billNo} - membalas non-200 supaya Faspay retry.`);
        return respond('01', 'Failed to persist');
      }

      addTransaction(record.userId, billNo, record.name, record.amount, 'success');

      await withLock('faspay_pending', async () => {
        const p = getFaspayPending();
        delete p[billNo];
        saveFaspayPending(p);
      });

      console.log(`[Faspay Webhook] bill_no ${billNo} berhasil diproses untuk user ${record.userId}.`);
    } catch (error) {
      console.error('[Faspay Webhook] Exception saat memproses notifikasi:', error);
      return respond('01', 'Internal error');
    }
  } else {
    console.log(`[Faspay Webhook] bill_no ${billNo} status ${statusCode} (${data.payment_status_desc}) - tidak diproses sebagai sukses.`);
  }

  respond('00', 'Success');
});

app.get('/payment-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-success.html'));
});

app.get('/payment-cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'payment-cancel.html'));
});

// Halaman depan (marketing) untuk pengunjung yang belum login - yang sudah login
// langsung masuk dashboard seperti biasa. Diletakkan sebelum express.static supaya
// "/" tidak otomatis diserve sebagai index.html oleh static middleware.
app.get('/', (req, res) => {
  if (hasAccess(req)) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'landing.html'));
  }
});

app.use(express.static(path.join(__dirname, '.')));

// Arahkan semua request lainnya ke index.html (tapi sudah dilindungi oleh middleware di atas)
app.get('*', requireAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Global error handler - menangkap error yang tidak tertangani di route handler
// (mis. throw sinkron atau next(err)) supaya proses tidak crash dan client tetap
// dapat response yang jelas, bukan koneksi yang menggantung/putus.
app.use((err, req, res, next) => {
  console.error('[Unhandled Route Error]', err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ ok: false, message: 'Terjadi kesalahan tak terduga pada server.' });
});

// Jaring pengaman terakhir - mencegah proses Node mati total karena error async
// yang tidak tertangkap di mana pun (promise rejection tanpa .catch, dsb).
// Ini bukan pengganti penanganan error yang benar, hanya mencegah downtime total.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

app.listen(PORT, async () => {
  console.log(`Server JurnalHub berjalan di port ${PORT}`);

  // Seed demo user if it doesn't exist (for payment gateway review/testing)
  try {
    const users = getUsers();
    const demoUser = users.find(u => u.email === 'demo');
    if (!demoUser) {
      const hashedDemoPassword = await bcrypt.hash('demo', 10);
      users.push({
        id: uuidv4(),
        email: 'demo',
        password: hashedDemoPassword,
        type: 'free',
        isVerified: true,
        verificationToken: null,
        name: 'Demo Team',
        faculty: 'Demo',
        university: 'JurnalHub',
        profilePic: '',
        savedJournals: [],
        createdAt: new Date().toISOString()
      });
      saveUsers(users);
      console.log('[Database Seed] Akun demo (demo/demo) berhasil dibuat.');
    }
  } catch (err) {
    console.error('[Database Seed] Gagal membuat akun demo:', err.message);
  }

  // Seed 30 kode akses manual (sekali saja - lihat seedAccessCodesIfEmpty)
  try {
    seedAccessCodesIfEmpty(30);
  } catch (err) {
    console.error('[Access Code Seed] Gagal membuat kode akses:', err.message);
  }

  // Deteksi IP Outbound Publik dari server (untuk registrasi whitelist di payment gateway)
  const https = require('https');
  https.get('https://api.ipify.org', (resp) => {
    let data = '';
    resp.on('data', (chunk) => { data += chunk; });
    resp.on('end', () => {
      console.log(`\n==================================================`);
      console.log(`[Outbound IP Check] Server Outbound IP: ${data}`);
      console.log(`==================================================\n`);
    });
  }).on("error", (err) => {
    console.error("[Outbound IP Check] Gagal mendeteksi IP Outbound: " + err.message);
  });
});
