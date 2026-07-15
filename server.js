require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const session = require('express-session');
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

app.use(session({
  secret: process.env.SESSION_SECRET || 'jurnalhub_super_secret_key',
  resave: false,
  saveUninitialized: false,
  name: ACCESS_COOKIE,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 2592000000, // 30 hari
    sameSite: 'lax'
  }
}));

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
  } catch (error) {
    console.error('Gagal menyimpan users.json:', error);
  }
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
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi.' });
  }

  const users = getUsers();
  const existingUser = users.find(u => u.email === email);

  if (existingUser) {
    return res.status(409).json({ ok: false, message: 'Email sudah terdaftar.' });
  }

  try {
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

app.post('/api/login', async (req, res) => {
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

    const crypto = require('crypto');
    const sessionToken = crypto.randomUUID();
    user.currentSessionToken = sessionToken;
    saveUsers(users);

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
app.post('/api/auth/forgot-password', async (req, res) => {
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
app.post('/api/auth/reset-password', async (req, res) => {
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



app.post('/api/auth/google', async (req, res) => {
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
    const crypto = require('crypto');
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
    } else {
      isLimitReached = false;
      isDraftLimitReached = false;
      draftsRemaining = 999;
      isLitReviewLimitReached = false;
      litReviewsRemaining = 999;

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

app.post('/api/access', (req, res) => {
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
    res.json({
      ok: true,
      source: 'local',
      warning: 'Kredensial Claude (ANTHROPIC_API_KEY), Gemini (GEMINI_API_KEY), atau Vertex AI belum dikonfigurasi. Menggunakan kalkulasi kecocokan lokal.',
      recommendations: normalizeAiRecommendations(
        candidates.slice(0, 3).map((candidate, index) => ({
          id: candidate.id,
          matchScore: Math.min(96, Math.max(72, candidate.localScore + 28 - (index * 4))),
          reason: 'Rekomendasi dihitung dari kecocokan keyword, bidang keilmuan, dan deskripsi jurnal.'
        })),
        candidates
      )
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

    res.json({ ok: true, source: sourceName, review, recommendations });
  } catch (error) {
    console.error(error);
    const activeProvider = hasClaudeKey ? 'Claude' : 'Gemini';
    res.json({
      ok: true,
      source: 'local',
      warning: `Layanan ${activeProvider} tidak tersedia, memakai fallback lokal. ${error.message.slice(0, 180)}`,
      recommendations: normalizeAiRecommendations(
        candidates.slice(0, 3).map((candidate, index) => ({
          id: candidate.id,
          matchScore: Math.min(96, Math.max(72, candidate.localScore + 28 - (index * 4))),
          reason: 'Rekomendasi fallback dihitung dari kecocokan keyword, bidang keilmuan, dan deskripsi jurnal.'
        })),
        candidates
      )
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

    return res.json({
      ok: true,
      source: 'local',
      draft: {
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
      }
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

    return res.json({
      ok: true,
      source: 'local',
      review: `<h3>Tinjauan Pustaka: ${title}</h3><p>Fitur AI Literature Review berjalan di server namun <code>PERPLEXITY_API_KEY</code> belum terpasang di Railway.</p><p>Berikut adalah simulasi draf Tinjauan Pustaka untuk topik Anda:</p><ul><li><strong>Kajian Teori:</strong> Menganalisis landasan teoritis utama yang mendasari permasalahan penelitian Anda.</li><li><strong>Studi Terdahulu:</strong> Meneliti bagaimana para peneliti lain telah mendekati masalah serupa dan hasil penelitian mereka.</li><li><strong>Celah Penelitian (Research Gap):</strong> Mengidentifikasi apa yang belum diteliti dan bagaimana penelitian Anda akan mengisi celah tersebut.</li></ul>`,
      citations: [
        { title: "Panduan Penulisan Jurnal Ilmiah Scopus & Sinta", authors: "Abidin, M. I.", journal: "Pusat Riset Indonesia", year: "2026", url: "https://github.com/ilmanabidin1/pusatriset", reason: "Referensi dasar yang membahas tentang penyusunan draf tinjauan pustaka dan kesesuaian jurnal ilmiah." }
      ]
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

      return res.json({
        ok: true,
        humanizedText: humanized,
        wordCount: wordCount,
        actualCost: actualCost,
        originalityScore: isNaN(score) ? 95 : Math.max(80, Math.min(100, score))
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

  res.json({
    ok: true,
    humanizedText: humanized,
    wordCount: wordCount,
    actualCost: actualCost,
    originalityScore: 94 + Math.floor(Math.random() * 5) // Mock originality score (94%-98%)
  });
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
const crypto = require('crypto');

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

  const packages = {
    starter: { price: 39000, name: 'Humanizer Starter Pack', desc: 'Top-up Kuota Kata Humanizer 5.000 Kata' },
    scholar: { price: 89000, name: 'Humanizer Scholar Pack', desc: 'Top-up Kuota Kata Humanizer 15.000 Kata' },
    thesis: { price: 199000, name: 'Humanizer Thesis Pack', desc: 'Top-up Kuota Kata Humanizer 40.000 Kata' }
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
          if (packageId === 'starter') wordsToAdd = 5000;
          else if (packageId === 'scholar') wordsToAdd = 15000;
          else if (packageId === 'thesis') wordsToAdd = 40000;

          console.log(`[iPaymu Webhook] Top-up Payment Successful! Adding ${wordsToAdd} words to user ${userId}`);

          const users = getUsers();
          const userIndex = users.findIndex(u => u.id === userId);
          if (userIndex !== -1) {
            users[userIndex].humanizerTopupCredits = (users[userIndex].humanizerTopupCredits || 0) + wordsToAdd;
            saveUsers(users);
            console.log(`[iPaymu Webhook] User ${userId} top-up completed. New top-up credits: ${users[userIndex].humanizerTopupCredits}`);
          } else {
            console.warn(`[iPaymu Webhook] Top-up User ${userId} not found.`);
          }
        } else {
          // Handle Regular Subscription Upgrades
          const planId = parts[1]; // premium_monthly, premium_yearly, ultimate_monthly, ultimate_yearly
          const targetType = planId.startsWith('ultimate') ? 'ultimate' : 'premium';

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
            saveUsers(users);
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
