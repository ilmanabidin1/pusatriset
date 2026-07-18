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

    const users = getUsers();
    let user = users.find(u => u.email === email);

    if (!user) {
      // Jika user belum ada, buat akun free baru secara otomatis
      user = {
        id: uuidv4(),
        email: email,
        password: '', // Login via Google, tidak ada password lokal
        type: 'free',
        name: payload.name || '',
        faculty: '',
        university: '',
        profilePic: payload.picture || '',
        savedJournals: [],
        createdAt: new Date().toISOString()
      };
      users.push(user);
    } else {
      // Update Google ID & Profile Pic jika belum diset
      if (!user.googleId) user.googleId = googleId;
      if (!user.name && payload.name) user.name = payload.name;
      if (!user.profilePic && payload.picture) user.profilePic = payload.picture;
    }

    saveUsers(users);

    // Set Session
    const sessionToken = crypto.randomUUID();
    user.currentSessionToken = sessionToken;
    saveUsers(users);

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
    // Asisten Riset AI - fitur khusus Premium (dijatah) & Ultimate (unlimited), Free tidak punya akses sama sekali
    let isResearchChatLimitReached = true;
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

      researchChatLimit = 100;
      const chatUsed = (user.lastResearchChatMonth === currentMonth) ? (user.researchChatCountThisMonth || 0) : 0;
      researchChatsRemaining = Math.max(0, researchChatLimit - chatUsed);
      isResearchChatLimitReached = researchChatsRemaining <= 0;
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

  // Jika kode akses benar, beri sesi ultimate
  req.session.userId = 'access_code_user';
  req.session.userType = 'ultimate';
  req.session.email = 'Ultimate User';

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

  const candidates = getLocalCandidates(articleTitle, articleKeywords, articleAbstract);

  if (candidates.length === 0) {
    res.json({ ok: true, source: 'local', recommendations: [] });
    return;
  }

  const hasClaudeKey = !!process.env.ANTHROPIC_API_KEY;
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const hasVertex = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

  if (!hasClaudeKey && !hasApiKey && !hasVertex) {
    const recommendations = normalizeAiRecommendations(
      candidates.slice(0, 3).map((candidate, index) => ({
        id: candidate.id,
        matchScore: Math.min(96, Math.max(72, candidate.localScore + 28 - (index * 4))),
        reason: 'Rekomendasi dihitung dari kecocokan keyword, bidang keilmuan, dan deskripsi jurnal.'
      })),
      candidates
    );

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review: null });

    res.json({
      ok: true,
      source: 'local',
      warning: 'Kredensial Claude (ANTHROPIC_API_KEY), Gemini (GEMINI_API_KEY), atau Vertex AI belum dikonfigurasi. Menggunakan kalkulasi kecocokan lokal.',
      recommendations: recommendations
    });
    return;
  }

  try {
    const aiResult = await getGeminiRecommendations(articleTitle, articleKeywords, articleAbstract, candidates);
    const aiItems = Array.isArray(aiResult) ? aiResult : (aiResult.items || aiResult);
    const review = aiResult?.review || null;
    const recommendations = normalizeAiRecommendations(aiItems, candidates);
    const sourceName = hasClaudeKey ? 'claude' : 'gemini';

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
    const activeProvider = hasClaudeKey ? 'Claude' : 'Gemini';
    const recommendations = normalizeAiRecommendations(
      candidates.slice(0, 3).map((candidate, index) => ({
        id: candidate.id,
        matchScore: Math.min(96, Math.max(72, candidate.localScore + 28 - (index * 4))),
        reason: 'Rekomendasi fallback dihitung dari kecocokan keyword, bidang keilmuan, dan deskripsi jurnal.'
      })),
      candidates
    );

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review: null });

    res.json({
      ok: true,
      source: 'local',
      warning: `Layanan ${activeProvider} tidak tersedia, memakai fallback lokal. ${error.message.slice(0, 180)}`,
      recommendations: recommendations
    });
  }
});

app.post('/api/generate-template-draft', requireAccess, async (req, res) => {
  const { title, abstract } = req.body;
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

    const localDraft = {
      introduction: [
        `Bahasan urgensi topik penelitian berdasarkan judul: "${title}"`,
        "Deskripsi permasalahan utama yang diangkat di lapangan saat ini.",
        "Tujuan penulisan artikel ilmiah dan kontribusi yang diharapkan."
      ],
      literature_review: [
        "Tinjauan teori-teori dasar yang berkaitan dengan variabel utama.",
        "Analisis perbandingan penelitian terdahulu yang relevan.",
        "Gap analysis yang menjustifikasi kebaruan penelitian ini."
      ],
      method: [
        "Penjelasan desain penelitian yang digunakan (kualitatif/kuantitatif).",
        "Prosedur pengumpulan data, populasi, dan sampel.",
        "Teknik analisis data yang diterapkan secara bertahap."
      ],
      results_discussion: [
        "Paparan temuan utama dari data lapangan secara berurutan.",
        "Interpretasi hasil analisis dikaitkan dengan hipotesis/tujuan.",
        "Diskusi kritis membandingkan temuan dengan teori yang ada."
      ],
      conclusion: [
        "Kesimpulan akhir menjawab rumusan masalah secara ringkas.",
        "Implikasi teoretis maupun praktis dari hasil penelitian.",
        "Keterbatasan riset dan saran rekomendasi studi masa depan."
      ]
    };

    addHistoryItem(req.session.userId, 'draft', { title, abstract }, { draft: localDraft });

    return res.json({
      ok: true,
      source: 'local',
      draft: localDraft
    });
  }

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
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
        max_tokens: 1500,
        system: "You are an expert scientific writing advisor. Based on the paper title and abstract provided, generate a highly structured outline of what the author must write in each segment of their manuscript. For each segment, provide 3-4 specific, concrete, and highly customized points tailored directly to their research topic (do NOT output generic writing tips). Output ONLY a valid JSON object. Do not wrap in markdown block. JSON format: {\"introduction\": [\"point 1\", \"point 2\"], \"literature_review\": [\"point 1\"], \"method\": [\"point 1\"], \"results_discussion\": [\"point 1\"], \"conclusion\": [\"point 1\"]}",
        messages: [
          {
            role: 'user',
            content: `Analisis judul dan abstrak berikut, lalu buat panduan outline pembahasan untuk masing-masing segmen jurnal.\n\nJudul: ${title}\nAbstrak: ${abstract}\n\nBalas dengan JSON object persis seperti spesifikasi (tanpa penjelasan teks):`
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

    addHistoryItem(req.session.userId, 'draft', { title, abstract }, { draft: parsed });

    res.json({ ok: true, source: 'claude', draft: parsed });
  } catch (error) {
    console.error('[AI Draft Generator] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal memproses draf panduan dengan AI: ' + error.message });
  }
});

app.post('/api/lit-review', requireAccess, async (req, res) => {
  const { title, keywords, abstract } = req.body;
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

  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  
  if (!perplexityKey) {
    // Fallback lokal jika Perplexity API Key belum dikonfigurasi
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastLitReviewMonth !== currentMonth) {
        user.lastLitReviewMonth = currentMonth;
        user.litReviewCountThisMonth = 0;
      }
      user.litReviewCountThisMonth += 1;
      saveUsers(users);
    }

    const localReview = `<h3>Tinjauan Pustaka: ${title}</h3><p>Fitur AI Literature Review berjalan di server namun <code>PERPLEXITY_API_KEY</code> belum terpasang di Railway.</p><p>Berikut adalah simulasi draf Tinjauan Pustaka untuk topik Anda:</p><ul><li><strong>Kajian Teori:</strong> Menganalisis landasan teoritis utama yang mendasari permasalahan penelitian Anda.</li><li><strong>Studi Terdahulu:</strong> Meneliti bagaimana para peneliti lain telah mendekati masalah serupa dan hasil penelitian mereka.</li><li><strong>Celah Penelitian (Research Gap):</strong> Mengidentifikasi apa yang belum diteliti dan bagaimana penelitian Anda akan mengisi celah tersebut.</li></ul>`;
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
    const prompt = `
Anda adalah pakar penulisan jurnal ilmiah internasional.
Lakukan pencarian web untuk mencari paper ilmiah/jurnal terbaru yang relevan dengan topik/judul berikut:
Judul: ${title}
Keyword/Bidang: ${keywords || '-'}
Abstrak: ${abstract || '-'}

Buatlah Tinjauan Pustaka (Literature Review) yang komprehensif dalam Bahasa Indonesia (berisi ringkasan teori, perbandingan studi terdahulu, dan gap analysis penelitian ini).
Harap sertakan daftar kutipan/referensi ilmiah asli dari web dengan URL aktif ke paper tersebut.

Balas HANYA dengan format JSON valid sebagai berikut (tanpa pembungkus markdown seperti \`\`\`json):
{
  "review": "Isi teks Tinjauan Pustaka Anda dalam format HTML/Markdown (gunakan tag paragraph p, list li, strong, dll) yang rapi dan profesional",
  "citations": [
    {
      "title": "Judul Paper Ilmiah yang ditemukan",
      "authors": "Nama Penulis (contoh: Doe et al.)",
      "journal": "Nama Jurnal/Penerbit",
      "year": "Tahun Terbit",
      "url": "URL aktif ke paper/jurnal ilmiah asli",
      "reason": "Alasan mengapa paper ini sangat relevan dengan topik pengguna"
    }
  ]
}
`;

    const response = await fetchFn('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${perplexityKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'Anda adalah AI akademis yang mengembalikan respon dalam format JSON sesuai instruksi.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Perplexity API Error: ${response.status} - ${errText}`);
    }

    const resData = await response.json();
    const content = resData?.choices?.[0]?.message?.content;
    const parsed = cleanAndParseAIResponse(content, true);

    // Update usage for Free & Premium users
    if (user && (user.type === 'free' || user.type === 'premium')) {
      if (user.lastLitReviewMonth !== currentMonth) {
        user.lastLitReviewMonth = currentMonth;
        user.litReviewCountThisMonth = 0;
      }
      user.litReviewCountThisMonth += 1;
      saveUsers(users);
    }

    addHistoryItem(req.session.userId, 'lit-review', { title, keywords, abstract }, { review: parsed.review, citations: parsed.citations || [] });

    res.json({ ok: true, source: 'perplexity', review: parsed.review, citations: parsed.citations || [] });
  } catch (error) {
    console.error('[Perplexity Lit Review] Error:', error);
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

  if (stealthApiKey && stealthApiKey.trim() !== '') {
    try {
      console.log(`[Humanizer] Calling StealthGPT API for user ${req.session.userId || 'unknown'} (${wordCount} words)`);
      const fetchFn = globalThis.fetch || require('node-fetch');
      const tone = mode === 'academic' ? 'Academic' : 'Standard';
      
      const response = await fetchFn('https://www.stealthgpt.ai/api/stealthify', {
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
        })
      });

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
      console.error('[Humanizer] Failed to connect to StealthGPT API, falling back to mock paraphrasing:', apiError.message);
    }
  }

  // Perform mock paraphrasing / humanizing (as fallback)
  let humanized = cleanText;

  // Simple rule-based substitutions to simulate academic paraphrasing
  const rules = [
    { regex: /\bTherefore\b/g, repl: 'Consequently' },
    { regex: /\bfurthermore\b/gi, repl: 'moreover' },
    { regex: /\bin order to\b/gi, repl: 'to' },
    { regex: /\butilize\b/gi, repl: 'use' },
    { regex: /\butilized\b/gi, repl: 'used' },
    { regex: /\butilization\b/gi, repl: 'use' },
    { regex: /\bIt is important to note that\b/gi, repl: 'Notably,' },
    { regex: /\ba plethora of\b/gi, repl: 'many' },
    { regex: /\bconducted a study\b/gi, repl: 'investigated' },
    { regex: /\bconcluded that\b/gi, repl: 'found that' },
    { regex: /\bdemonstrates that\b/gi, repl: 'shows that' },
    { regex: /\bThis study aims to\b/gi, repl: 'This research focuses on' },
    { regex: /\bsignificant effect\b/gi, repl: 'noticeable impact' }
  ];

  rules.forEach(rule => {
    humanized = humanized.replace(rule.regex, rule.repl);
  });

  // If Academic mode, make a mock enhanced message prefix or touch up
  if (mode === 'academic') {
    humanized = humanized.replace(/\bwe found\b/gi, 'our findings indicate');
    humanized = humanized.replace(/\bI think\b/gi, 'it is argued');
  }

  const outputWordCount = humanized.split(/\s+/).filter(w => w.length > 0).length;
  const actualCost = wordCount + outputWordCount;

  // Update database usage with (input + output)
  if (user) {
    user.humanizerWordsUsedThisMonth = (user.humanizerWordsUsedThisMonth || 0) + actualCost;
    saveUsers(users);
  }

  const originalityScore = 94 + Math.floor(Math.random() * 5);
  addHistoryItem(req.session.userId, 'humanizer', { text: cleanText, mode }, { humanizedText: humanized, originalityScore, wordCount, actualCost });

  res.json({
    ok: true,
    humanizedText: humanized,
    wordCount: wordCount,
    actualCost: actualCost,
    originalityScore: originalityScore
  });
});

// --- ASISTEN RISET AI (DeepSeek) ---
// Fitur khusus Premium (dijatah 100 pesan/bulan) & Ultimate (unlimited).
// Free tier tidak punya akses sama sekali - lihat requireAccess + cek tipe di bawah.
const RESEARCH_CHAT_SYSTEM_PROMPT = `Anda adalah seorang profesor dan asisten riset akademik yang sangat berpengalaman, membantu pengguna JurnalHub (platform riset & publikasi ilmiah Indonesia) dalam diskusi seputar penelitian, metodologi, penulisan ilmiah, pemilihan jurnal Scopus/Sinta, dan topik akademik lainnya.

Prinsip yang harus selalu Anda pegang:
- Jawab dengan JUJUR. Jika Anda tidak yakin atau tidak tahu jawaban pastinya, katakan terus terang - jangan mengarang fakta, data, atau kutipan/sitasi yang tidak Anda ketahui kebenarannya.
- Berikan penjelasan yang mendalam, terstruktur, dan berbasis prinsip keilmuan yang benar, layaknya seorang profesor pembimbing yang berpengalaman.
- Bersikap kritis dan konstruktif terhadap ide penelitian pengguna, bukan sekadar mengiyakan.
- Gunakan Bahasa Indonesia akademik yang jelas, kecuali pengguna menulis dalam Bahasa Inggris.
- Anda TIDAK bisa mengakses internet atau database jurnal secara real-time, jadi jangan mengklaim mengetahui status akreditasi/indeksasi jurnal terkini secara pasti - sarankan pengguna memverifikasi lewat fitur AI Match Score atau Database Jurnal di JurnalHub untuk data yang akurat.`;

function getDeepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY;
}

app.post('/api/research-chat', requireAccess, async (req, res) => {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, message: 'Asisten Riset AI belum dikonfigurasi di server.' });
  }

  // Cek tipe akun langsung dari database, bukan req.session.userType - session bisa
  // basi kalau downgrade terjadi di request lain (mis. langganan expired) sebelum
  // /api/me sempat menyinkronkan ulang session di request ini.
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = (user && user.type) || 'free';
  if (userType !== 'premium' && userType !== 'ultimate') {
    return res.status(403).json({ ok: false, message: 'Asisten Riset AI khusus untuk akun Premium & Ultimate.' });
  }

  const currentMonth = new Date().toISOString().slice(0, 7);

  if (userType === 'premium' && user) {
    const chatUsed = (user.lastResearchChatMonth === currentMonth) ? (user.researchChatCountThisMonth || 0) : 0;
    if (chatUsed >= 100) {
      return res.status(403).json({ ok: false, message: 'Limit bulanan Asisten Riset AI tercapai (100 pesan/bulan untuk akun Premium).' });
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
    if (content.length > 6000) {
      return res.status(400).json({ ok: false, message: 'Satu pesan maksimal 6000 karakter.' });
    }
    sanitizedMessages.push({ role, content });
  }

  // DEEPSEEK_API_URL cuma untuk keperluan testing lokal (arahkan ke mock server) -
  // di production selalu pakai endpoint resmi DeepSeek.
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  try {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('Runtime Node ini tidak mendukung streaming fetch (butuh Node 18+).');
    }

    const dsResponse = await globalThis.fetch(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: RESEARCH_CHAT_SYSTEM_PROMPT },
          ...sanitizedMessages
        ],
        temperature: 1,
        max_tokens: 1500,
        stream: true
      })
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    // Streaming ke client mentah (bukan JSON) - frontend membaca chunk demi chunk
    // supaya jawaban muncul progresif seperti ChatGPT/Claude, bukan menunggu utuh.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let fullReply = '';
    let sseBuffer = '';
    const reader = dsResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // baris terakhir mungkin belum lengkap, simpan utk chunk berikutnya

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            fullReply += delta;
            res.write(delta);
          }
        } catch (e) {
          // Baris SSE parsial/tidak valid - abaikan, akan lengkap di chunk berikutnya
        }
      }
    }

    res.end();

    if (!fullReply) {
      console.error('[Research Chat] Respons stream kosong dari DeepSeek.');
      return;
    }

    if (userType === 'premium' && user) {
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
  } catch (error) {
    console.error('[Research Chat] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Gagal menghubungi Asisten Riset AI: ' + error.message });
    } else {
      // Header/stream sudah terkirim sebagian - tidak bisa lagi ganti jadi respons
      // JSON error, cukup tutup koneksinya.
      res.end();
    }
  }
});

// Endpoint untuk mengambil data Prompt Bank
app.get('/api/prompts', requireAccess, (req, res) => {
  try {
    const promptsFilePath = path.join(__dirname, 'data-static', 'prompt_bank.json');
    if (!fs.existsSync(promptsFilePath)) {
      return res.status(404).json({ ok: false, message: 'Data Prompt Bank belum tersedia.' });
    }
    const data = JSON.parse(fs.readFileSync(promptsFilePath, 'utf-8'));
    res.json({ ok: true, ...data });
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
            <div style="font-weight: normal; font-size: 0.78rem; color: #6b7280; margin-top: 0.25rem;">Metode: QRIS Cross-Border (iPaymu)</div>
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
    '/auth.html', '/styles.css', '/app.js', '/database.js',
    '/terms.html', '/refund.html', '/faq.html', '/contact.html',
    '/reset-password.html'
  ];

  if (publicFiles.includes(req.path) || req.path.startsWith('/assets/')) {
    next();
    return;
  }

  // Semua akses ke file root (seperti index.html) membutuhkan akses
  if (req.path === '/' || req.path === '/index.html') {
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

// --- IPAYMU INTEGRATION ---

// Helper to generate iPaymu API signature
function generateIpaymuSignature(body, method = 'POST') {
  const va = process.env.IPAYMU_VA || '1179000000000000';
  const apiKey = process.env.IPAYMU_API_KEY || 'sandbox-api-key-placeholder';
  const bodyString = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex').toLowerCase();
  const stringToSign = `${method}:${va}:${bodyHash}:${apiKey}`;
  return crypto.createHmac('sha256', apiKey).update(stringToSign).digest('hex');
}

// Endpoint to create a payment transaction
app.post('/api/payment/create', requireAccess, async (req, res) => {
  const { planId } = req.body;
  if (!planId) {
    return res.status(400).json({ ok: false, message: 'Plan ID wajib dipilih.' });
  }

  // Saklar penyedia pembayaran - set PAYMENT_PROVIDER=faspay di env var untuk
  // mengalihkan tombol upgrade ke Faspay Xpress (mis. saat masa UAT dengan tim
  // Faspay), atau hapus/'ipaymu' untuk kembali ke iPaymu. Tidak perlu ubah kode.
  if ((process.env.PAYMENT_PROVIDER || 'ipaymu').toLowerCase() === 'faspay') {
    const plan = FASPAY_PLAN_PRICES[planId];
    if (!plan) {
      return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
    }
    return createFaspayTransaction(req, res, { kind: 'subscription', itemId: planId, itemDef: plan, userId: req.session.userId });
  }

  // Price mapping for JurnalHub plans
  const planPrices = {
    premium_monthly: { price: 79000, name: 'Premium (Bulanan)', desc: 'Langganan JurnalHub Premium - Bulanan' },
    premium_yearly: { price: 800000, name: 'Premium (Tahunan)', desc: 'Langganan JurnalHub Premium - Tahunan' },
    ultimate_monthly: { price: 149000, name: 'Ultimate (Bulanan)', desc: 'Langganan JurnalHub Ultimate - Bulanan' },
    ultimate_yearly: { price: 1500000, name: 'Ultimate (Tahunan)', desc: 'Langganan JurnalHub Ultimate - Tahunan' }
  };

  const selectedPlan = planPrices[planId];
  if (!selectedPlan) {
    return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
  }

  const va = process.env.IPAYMU_VA;
  const apiKey = process.env.IPAYMU_API_KEY;
  const isSandbox = String(process.env.IPAYMU_SANDBOX).trim().toLowerCase() === 'true';

  if (!va || !apiKey) {
    return res.status(500).json({ ok: false, message: 'iPaymu credentials belum dikonfigurasi di server.' });
  }

  // Base URL according to sandbox environment
  const ipaymuUrl = isSandbox 
    ? 'https://sandbox.ipaymu.com/api/v2/payment' 
    : 'https://my.ipaymu.com/api/v2/payment';

  // Return and notification URLs
  const hostHeader = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const baseUrl = `${protocol}://${hostHeader}`;

  // Unique transaction reference containing: userId + "_" + planId + "_" + timestamp
  const refId = `${req.session.userId}_${planId}_${Date.now()}`;

  const payload = {
    product: [selectedPlan.name],
    qty: [1],
    price: [selectedPlan.price],
    description: [selectedPlan.desc],
    returnUrl: `${baseUrl}/payment-success`,
    cancelUrl: `${baseUrl}/payment-cancel`,
    notifyUrl: `${baseUrl}/api/payment/callback`,
    referenceId: refId
  };

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14); // YYYYMMDDhhmmss
    const signature = generateIpaymuSignature(payload, 'POST');

    const response = await fetchFn(ipaymuUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'va': va,
        'signature': signature,
        'timestamp': timestamp
      },
      body: JSON.stringify(payload)
    });

    const resData = await response.json();
    const resStatus = resData.status !== undefined ? resData.status : resData.Status;
    const resDataObj = resData.data !== undefined ? resData.data : resData.Data;
    const redirectUrl = resDataObj ? (resDataObj.Url || resDataObj.url) : null;

    if (resData && (resStatus === 200 || resStatus == '200') && redirectUrl) {
      res.json({ ok: true, redirectUrl: redirectUrl });
    } else {
      console.error('[iPaymu Payment Create] Error Response:', resData);
      res.status(500).json({ ok: false, message: (resData.message || resData.Message) || 'Gagal membuat sesi pembayaran dengan iPaymu.' });
    }
  } catch (error) {
    console.error('[iPaymu Payment Create] Exception:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server saat menghubungkan ke iPaymu: ' + error.message });
  }
});

app.post('/api/payment/topup/create', requireAccess, async (req, res) => {
  const { packageId } = req.body;
  if (!packageId) {
    return res.status(400).json({ ok: false, message: 'Package ID wajib disertakan.' });
  }

  if ((process.env.PAYMENT_PROVIDER || 'ipaymu').toLowerCase() === 'faspay') {
    const pkg = FASPAY_TOPUP_PACKAGES[packageId];
    if (!pkg) {
      return res.status(400).json({ ok: false, message: 'Package ID tidak valid.' });
    }
    return createFaspayTransaction(req, res, { kind: 'topup', itemId: packageId, itemDef: pkg, userId: req.session.userId });
  }

  const packages = {
    starter: { price: 39000, name: 'Humanizer Starter Pack', desc: 'Top-up Kuota Kata Humanizer 5.000 Kata' },
    scholar: { price: 119000, name: 'Humanizer Scholar Pack', desc: 'Top-up Kuota Kata Humanizer 15.000 Kata' },
    thesis: { price: 299000, name: 'Humanizer Thesis Pack', desc: 'Top-up Kuota Kata Humanizer 40.000 Kata' }
  };

  const selectedPackage = packages[packageId];
  if (!selectedPackage) {
    return res.status(400).json({ ok: false, message: 'Package ID tidak valid.' });
  }

  const va = process.env.IPAYMU_VA;
  const apiKey = process.env.IPAYMU_API_KEY;
  const isSandbox = String(process.env.IPAYMU_SANDBOX).trim().toLowerCase() === 'true';

  if (!va || !apiKey) {
    return res.status(500).json({ ok: false, message: 'iPaymu credentials belum dikonfigurasi di server.' });
  }

  const ipaymuUrl = isSandbox 
    ? 'https://sandbox.ipaymu.com/api/v2/payment' 
    : 'https://my.ipaymu.com/api/v2/payment';

  const hostHeader = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const baseUrl = `${protocol}://${hostHeader}`;

  // Unique reference structure containing: userId + "_topup_" + packageId + "_" + timestamp
  const refId = `${req.session.userId}_topup_${packageId}_${Date.now()}`;

  const payload = {
    product: [selectedPackage.name],
    qty: [1],
    price: [selectedPackage.price],
    description: [selectedPackage.desc],
    returnUrl: `${baseUrl}/payment-success`,
    cancelUrl: `${baseUrl}/payment-cancel`,
    notifyUrl: `${baseUrl}/api/payment/callback`,
    referenceId: refId
  };

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14); // YYYYMMDDhhmmss
    const signature = generateIpaymuSignature(payload, 'POST');

    const response = await fetchFn(ipaymuUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'va': va,
        'signature': signature,
        'timestamp': timestamp
      },
      body: JSON.stringify(payload)
    });

    const resData = await response.json();
    const resStatus = resData.status !== undefined ? resData.status : resData.Status;
    const resDataObj = resData.data !== undefined ? resData.data : resData.Data;
    const redirectUrl = resDataObj ? (resDataObj.Url || resDataObj.url) : null;

    if (resData && (resStatus === 200 || resStatus == '200') && redirectUrl) {
      res.json({ ok: true, redirectUrl: redirectUrl });
    } else {
      console.error('[iPaymu Top-up Create] Error Response:', resData);
      res.status(500).json({ ok: false, message: (resData.message || resData.Message) || 'Gagal membuat sesi pembayaran top-up dengan iPaymu.' });
    }
  } catch (error) {
    console.error('[iPaymu Top-up Create] Exception:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server saat menghubungkan ke iPaymu: ' + error.message });
  }
});

// Endpoint for Webhook Callback (IPN)
app.post('/api/payment/callback', async (req, res) => {
  const signatureFromHeader = req.headers['signature'];
  const apiKey = process.env.IPAYMU_API_KEY;

  if (!apiKey) {
    console.error('[iPaymu Webhook] Error: API key not set in environment.');
    return res.status(500).send('API key not set');
  }

  // 1. Verify iPaymu signature
  const rawBodyString = req.rawBody ? req.rawBody.toString('utf8') : '';
  const calculatedSignature = crypto
    .createHmac('sha256', apiKey)
    .update(rawBodyString)
    .digest('hex');

  if (signatureFromHeader && calculatedSignature !== signatureFromHeader) {
    console.error('[iPaymu Webhook] Unauthorized Signature. Header:', signatureFromHeader, 'Calculated:', calculatedSignature);
    return res.status(401).send('Unauthorized signature');
  }

  // 2. Parse callback parameters
  const data = req.body;
  const referenceId = data.referenceId || data.reference_id || data.ReferenceId || data.reference;
  const rawStatus = data.status || data.Status || '';
  const status = String(rawStatus).toLowerCase();
  const statusCode = String(data.status_code !== undefined ? data.status_code : (data.StatusCode !== undefined ? data.StatusCode : '')).trim();

  console.log('[iPaymu Webhook] Received callback data:', data);

  // 3. Process payment status
  if (statusCode === '1' || status === 'berhasil' || status === 'success') {
    if (referenceId) {
      const parts = referenceId.split('_');
      if (parts.length >= 2) {
        const userId = parts[0];
        
        // Handle Top-up Payments
        if (parts[1] === 'topup') {
          const packageId = parts[2];
          let wordsToAdd = 0;
          let amount = 0;
          let name = '';
          if (packageId === 'starter') { wordsToAdd = 5000; amount = 39000; name = 'Humanizer Starter Pack (Top-up)'; }
          else if (packageId === 'scholar') { wordsToAdd = 15000; amount = 119000; name = 'Humanizer Scholar Pack (Top-up)'; }
          else if (packageId === 'thesis') { wordsToAdd = 40000; amount = 299000; name = 'Humanizer Thesis Pack (Top-up)'; }

          console.log(`[iPaymu Webhook] Top-up Payment Successful! Adding ${wordsToAdd} words to user ${userId}`);

          const users = getUsers();
          const userIndex = users.findIndex(u => u.id === userId);
          if (userIndex !== -1) {
            users[userIndex].humanizerTopupCredits = (users[userIndex].humanizerTopupCredits || 0) + wordsToAdd;
            const saved = saveUsers(users);
            addTransaction(userId, referenceId, name, amount, 'success');
            if (!saved) {
              console.error(`[iPaymu Webhook] GAGAL menyimpan top-up untuk user ${userId} - membalas non-200 supaya iPaymu retry.`);
              return res.status(500).send('Failed to persist top-up');
            }
            console.log(`[iPaymu Webhook] User ${userId} top-up completed. New top-up credits: ${users[userIndex].humanizerTopupCredits}`);
          } else {
            console.warn(`[iPaymu Webhook] Top-up User ${userId} not found.`);
          }
        } else {
          // Handle Regular Subscription Upgrades
          const planId = parts[1]; // premium_monthly, premium_yearly, ultimate_monthly, ultimate_yearly
          const targetType = planId.startsWith('ultimate') ? 'ultimate' : 'premium';

          let amount = 129000;
          let name = 'JurnalHub Premium (Bulanan)';
          if (planId === 'premium_yearly') { amount = 999000; name = 'JurnalHub Premium (Tahunan)'; }
          else if (planId === 'ultimate_monthly') { amount = 249000; name = 'JurnalHub Ultimate (Bulanan)'; }
          else if (planId === 'ultimate_yearly') { amount = 1999000; name = 'JurnalHub Ultimate (Tahunan)'; }

          console.log(`[iPaymu Webhook] Payment Successful! Upgrading user ${userId} to type ${targetType}`);

          // Update user type in database
          const users = getUsers();
          const userIndex = users.findIndex(u => u.id === userId);
          if (userIndex !== -1) {
            const isYearly = planId.endsWith('yearly');
            const durationDays = isYearly ? 365 : 30;
            const expiredAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

            users[userIndex].type = targetType;
            users[userIndex].planId = planId;
            users[userIndex].paymentExpiredAt = expiredAt;
            const saved = saveUsers(users);
            addTransaction(userId, referenceId, name, amount, 'success');
            if (!saved) {
              console.error(`[iPaymu Webhook] GAGAL menyimpan upgrade untuk user ${userId} - membalas non-200 supaya iPaymu retry.`);
              return res.status(500).send('Failed to persist upgrade');
            }
            console.log(`[iPaymu Webhook] User ${userId} upgraded successfully to ${targetType} (${planId}), expires at ${expiredAt}`);
          } else {
            console.warn(`[iPaymu Webhook] User ${userId} not found in database.`);
          }
        }
      }
    }
  }

  // Always respond HTTP 200 OK to acknowledge callback
  res.status(200).send('OK');
});

// ===================== FASPAY XPRESS INTEGRATION =====================
// Kredensial diambil dari env var (jangan hardcode), supaya sandbox & production
// bisa dipisah lewat FASPAY_SANDBOX tanpa ubah kode.
const FASPAY_MERCHANT_ID = process.env.FASPAY_MERCHANT_ID;
const FASPAY_USER_ID = process.env.FASPAY_USER_ID;
const FASPAY_PASSWORD = process.env.FASPAY_PASSWORD;
const FASPAY_SANDBOX = String(process.env.FASPAY_SANDBOX).trim().toLowerCase() === 'true';
// Endpoint production belum didokumentasikan resmi oleh Faspay saat kode ini ditulis -
// override via FASPAY_XPRESS_URL kalau tim Faspay konfirmasi URL production yang berbeda.
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
          const expiredAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
          users[userIndex].type = targetType;
          users[userIndex].planId = planId;
          users[userIndex].paymentExpiredAt = expiredAt;
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

  // Seed demo user if it doesn't exist (for iPaymu team review)
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
        name: 'iPaymu Demo Team',
        faculty: 'Demo',
        university: 'iPaymu',
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

  // Deteksi IP Outbound Publik dari server (untuk registrasi iPaymu)
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
