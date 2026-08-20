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
const compression = require('compression');
const { v4: uuidv4 } = require('uuid');
const { VertexAI } = require('@google-cloud/vertexai');
const { OAuth2Client } = require('google-auth-library');
const JOURNAL_DATABASE = require('./database');
const app = express();
const nodemailer = require('nodemailer');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = require('docx');

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

// Helper to send emails (Supports Resend API and SMTP fallback).
// Mengembalikan boolean sukses/gagal (TIDAK PERNAH reject/throw - dipakai
// sejak awal sebagai fire-and-forget di verifikasi email/reset password TANPA
// await/try-catch di sisi pemanggil, jadi kalau ini dibuat throw, itu jadi
// unhandled rejection di situ). Nilai return ini dipakai Email Blast (lihat
// POST /api/admin/email-blast) buat menghitung sent/failed per penerima -
// call site lain yang tidak peduli hasilnya boleh tetap mengabaikan return-nya.
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
        return false;
      }
      console.log(`[Resend API] Email sent successfully to ${to}, ID: ${resData.id}`);
      return true;
    } catch (err) {
      console.error('[Resend API] Request error:', err);
      return false;
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
      return true;
    } catch (err) {
      console.error(`[SMTP] Error sending email to ${to}:`, err);
      return false;
    }
  } else {
    // Mocking lokal
    console.log('==================================================');
    console.log(`[SMTP MOCK] To: ${to}`);
    console.log(`[SMTP MOCK] Subject: ${subject}`);
    console.log(`[SMTP MOCK] HTML:\n${html}`);
    console.log('==================================================');
    return true;
  }
}

const GOOGLE_CLIENT_ID = '571306850750-ckq38nmai4felal861uu0hgj1b13bihf.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://jurnalhub.id/api/auth/google/callback';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Tentukan port dari environment variable (Railway menyediakannya lewat PORT) atau port 3000 secara lokal
const PORT = process.env.PORT || 3000;
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
// Kompresi gzip/brotli untuk semua response - app.js (~395KB) dan database.js
// (~640KB) sebelumnya dikirim mentah tanpa kompresi ke setiap pengunjung.
// Threshold kecil (1KB) supaya asset teks (JS/CSS/HTML/JSON) ikut terkompresi,
// sedangkan file yang sudah terkompresi (video mp4, gambar) otomatis dilewati
// middleware ini berdasarkan Content-Type.
// PENGECUALIAN: route di STREAMING_ROUTES di-stream chunk-per-chunk (lihat
// res.write / streamDeepSeekCompletion di masing-masing route) - middleware
// compression menahan/buffer output di internal zlib-nya sampai buffer penuh
// atau response selesai, jadi kalau tidak dikecualikan di sini, efeknya SAMA
// SEPERTI TIDAK STREAMING SAMA SEKALI (client baru terima semua teks
// sekaligus di akhir, bukan per token/kata).
const STREAMING_ROUTES = new Set([
  '/api/research-chat',
  '/api/lit-review',
  '/api/peer-review',
  '/api/generate-ai-disclosure'
]);
app.use(compression({
  filter: (req, res) => {
    if (STREAMING_ROUTES.has(req.path)) return false;
    return compression.filter(req, res);
  }
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Limit default express.json() cuma 100kb - kekecilan untuk chat JurnalHub
// Intelligence yang mengirim ulang seluruh riwayat percakapan + teks dokumen
// terlampir (bisa sampai 15.000 kata / ~100kb+ sendiri) di setiap request.
// Dulu request sebesar ini gagal dengan PayloadTooLargeError yang ketutup
// jadi pesan generik "Terjadi kesalahan tak terduga pada server" oleh error
// handler global di bawah - bikin bingung karena tidak menyebut ukuran file.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({
  extended: false,
  limit: '10mb',
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

// Rate limit terpisah untuk Peta Sitasi - independen dari kuota bulanan (yang
// membatasi TOTAL pemakaian per bulan), ini membatasi KECEPATAN BURST per menit
// supaya 1 akun (termasuk Ultimate yang jatahnya besar) tidak bisa menghabiskan
// jatah harian OpenAlex yang dipakai bersama SEMUA fitur (Match Score, Lit
// Review, dll) dalam hitungan detik lewat script/automasi. Di-key per akun
// (bukan per IP) supaya tidak salah membatasi user lain yang kebetulan satu
// jaringan/kantor/kampus.
const citationGraphLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak permintaan peta sitasi dalam waktu singkat. Tunggu sebentar lalu coba lagi.' }
});

// Rate limit burst untuk menyimpan referensi ke Referensi Saya - tiap simpan memicu
// 1 panggilan DeepSeek (TL;DR), jadi dibatasi kecepatannya per menit (bukan kuota
// bulanan) supaya tidak disalahgunakan lewat script/automasi.
const savedReferenceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak referensi disimpan dalam waktu singkat. Tunggu sebentar lalu coba lagi.' }
});

// Rate limit burst untuk chatbot per folder Koleksi Saya - tiap pesan memicu 1
// panggilan DeepSeek, dibatasi kecepatannya per menit sama seperti savedReferenceLimiter.
const folderChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak pesan dalam waktu singkat. Tunggu sebentar lalu coba lagi.' }
});

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET belum diset. Set env var SESSION_SECRET di Railway sebelum menjalankan di production.');
    process.exit(1);
  }
  console.warn('[WARNING] SESSION_SECRET belum diset, memakai secret acak sementara untuk development (sesi akan invalid tiap restart).');
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'jurnalhub_secure_session_secret_998877';

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

// Fungsi helper untuk user database.
// getUsers() dipanggil di hasAccess() yang menjaga hampir semua endpoint API -
// tanpa cache ini, SETIAP request (search, chat, peer review, dll) melakukan
// fs.readFileSync + JSON.parse SINKRON atas seluruh users.json, yang memblokir
// event loop Node dan makin lambat seiring jumlah user bertambah. Cache di
// memori ini hanya dibaca ulang dari disk kalau mtime file berubah (mis. baru
// ditulis oleh saveUsers, atau diedit manual) - selain itu langsung pakai
// salinan di memori tanpa I/O sama sekali.
let usersCache = null;
let usersCacheMtimeMs = 0;

function getUsers() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]');
    }
    const mtimeMs = fs.statSync(USERS_FILE).mtimeMs;
    if (usersCache && mtimeMs === usersCacheMtimeMs) {
      return usersCache;
    }
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    usersCache = JSON.parse(data);
    usersCacheMtimeMs = mtimeMs;
    return usersCache;
  } catch (error) {
    console.error('Gagal membaca users.json:', error);
    return usersCache || [];
  }
}

// Akun admin: akses tanpa batas ke SEMUA fitur (lihat tiap blok kuota di
// bawah, semuanya di-skip kalau req.session.isAdmin true) + akses dashboard
// /api/admin/* (daftar user, status langganan). Bukan field "type" (yang
// tetap merepresentasikan tier LANGGANAN sungguhan buat keperluan billing/
// analytics, tidak boleh tercampur), tapi flag terpisah "isAdmin" - jadi
// admin bisa tetap punya type 'free'/'premium' apa adanya tanpa konflik
// dengan logic upgrade/downgrade webhook Faspay.
//
// Cara jadi admin: set env var ADMIN_EMAILS (dipisah koma) di Railway, lalu
// restart server - email yang match otomatis di-set isAdmin:true saat startup
// (lihat pemanggilannya di app.listen). Tidak ada UI buat self-promote,
// sengaja (keamanan) - satu-satunya jalan masuk ya lewat env var ini.
function syncAdminFlagsFromEnv() {
  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) return;
  const users = getUsers();
  let changed = false;
  users.forEach(u => {
    const shouldBeAdmin = adminEmails.includes(String(u.email || '').toLowerCase());
    if (shouldBeAdmin !== !!u.isAdmin) {
      u.isAdmin = shouldBeAdmin;
      changed = true;
      console.log(`[Admin Sync] ${u.email}: isAdmin -> ${shouldBeAdmin}`);
    }
  });
  if (changed) saveUsers(users);
}

// Hitung tanggal expired baru saat user bayar - kalau masa aktif
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
    // Perbarui cache in-memory langsung supaya getUsers() berikutnya (bahkan di
    // request yang sama) tidak perlu baca ulang dari disk.
    usersCache = users;
    usersCacheMtimeMs = fs.statSync(USERS_FILE).mtimeMs;
    return true;
  } catch (error) {
    console.error('Gagal menyimpan users.json:', error);
    return false;
  }
}

// Reset counter kuota bulanan saat user upgrade tier lewat pembayaran - supaya
// user langsung dapat kuota penuh sesuai paket barunya, bukan melanjutkan
// sisa pemakaian dari tier sebelumnya. Match/Draft/Lit Review/Research Chat
// sudah pindah total ke DEEPSEEK POOL (kredit/minggu, otomatis penuh lagi
// tiap upgrade karena dihitung dari tier saat ini, bukan counter tersimpan)
// jadi tidak perlu di-reset manual disini lagi - cuma Humanizer yang masih
// pakai kuota kata bulanan asli (bukan LLM/token-based, lihat komentar di
// /api/me).
function resetMonthlyQuotasOnUpgrade(user) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  user.lastHumanizerMonth = currentMonth;
  user.humanizerWordsUsedThisMonth = 0;
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

// --- PROGRAM AFILIASI KAMPUS (@*.ac.id, komisi recurring) ---
// User mana pun (apapun tier-nya sekarang) bisa daftar jadi affiliate GRATIS
// dengan verifikasi 1 email institusi (@*.ac.id) via OTP 6-digit (lihat
// sendMailHelper - Resend/SMTP). Begitu terverifikasi, dapat 1 referral_code
// unik yang bisa dipakai SIAPA SAJA di kolom kode promo checkout yang SUDAH
// ADA (field yang sama dengan PROMO_CODES manual, lihat applyPromoToItemDef
// di bagian Faspay) - potongan tetap 10% harga bulanan untuk pembeli.
// Affiliate dapat komisi recurring (10% Premium / 20% Ultimate) dari SETIAP
// pembayaran sukses user yang mereka referensikan, SELAMANYA selama user itu
// tetap berlangganan - bukan cuma transaksi pertama. Karena Faspay TIDAK
// mendukung kartu kredit/auto-charge (setiap perpanjangan = transaksi baru
// yang user bayar manual, lihat computeStackedExpiry), "recurring" di sini
// diwujudkan lewat referredByAffiliateId yang ditulis PERMANEN ke akun
// pembeli begitu 1 kode referral pertama kali berhasil dipakai (lihat webhook
// Faspay) - renewal berikutnya TIDAK perlu masukkan kode lagi supaya
// affiliate tetap dapat komisi (tapi diskon 10% ke pembeli sendiri HANYA
// berlaku di transaksi yang benar-benar memakai kode, konsisten dengan UX
// kode promo yang sudah ada - bukan diam-diam otomatis tiap renewal).
const AFFILIATES_FILE = path.join(DATA_DIR, 'affiliates.json');
const AFFILIATE_OTPS_FILE = path.join(DATA_DIR, 'affiliate-otps.json');
const AFFILIATE_EARNINGS_FILE = path.join(DATA_DIR, 'affiliate-earnings.json');
const AFFILIATE_PAYOUTS_FILE = path.join(DATA_DIR, 'affiliate-payouts.json');
const AFFILIATE_MIN_PAYOUT = 100000; // Rp100.000, sesuai PRD
const AFFILIATE_COMMISSION_RATE = { premium: 10, ultimate: 20 };
const AFFILIATE_DISCOUNT_PERCENT = 10;

function getAffiliates() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AFFILIATES_FILE)) fs.writeFileSync(AFFILIATES_FILE, '[]');
    return JSON.parse(fs.readFileSync(AFFILIATES_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca affiliates.json:', error);
    return [];
  }
}
function saveAffiliates(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AFFILIATES_FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan affiliates.json:', error);
    return false;
  }
}

function getAffiliateOtps() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AFFILIATE_OTPS_FILE)) fs.writeFileSync(AFFILIATE_OTPS_FILE, '{}');
    return JSON.parse(fs.readFileSync(AFFILIATE_OTPS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca affiliate-otps.json:', error);
    return {};
  }
}
function saveAffiliateOtps(map) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AFFILIATE_OTPS_FILE, JSON.stringify(map, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan affiliate-otps.json:', error);
    return false;
  }
}

function getAffiliateEarnings() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AFFILIATE_EARNINGS_FILE)) fs.writeFileSync(AFFILIATE_EARNINGS_FILE, '[]');
    return JSON.parse(fs.readFileSync(AFFILIATE_EARNINGS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca affiliate-earnings.json:', error);
    return [];
  }
}
function saveAffiliateEarnings(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AFFILIATE_EARNINGS_FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan affiliate-earnings.json:', error);
    return false;
  }
}

function getAffiliatePayouts() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(AFFILIATE_PAYOUTS_FILE)) fs.writeFileSync(AFFILIATE_PAYOUTS_FILE, '[]');
    return JSON.parse(fs.readFileSync(AFFILIATE_PAYOUTS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca affiliate-payouts.json:', error);
    return [];
  }
}
function saveAffiliatePayouts(list) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(AFFILIATE_PAYOUTS_FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan affiliate-payouts.json:', error);
    return false;
  }
}

// Kode referral: PREFIX-XXXX, PREFIX dari nama domain kampus (mis.
// unpad.ac.id -> UNPAD), XXXX 4 karakter acak - diulang kalau bentrok
// (harus UNIQUE lintas semua affiliate, dicek di kolom kode promo checkout
// yang sama dengan PROMO_CODES manual).
function generateReferralCode(campusEmail, existingAffiliates) {
  const domain = campusEmail.split('@')[1] || 'kampus';
  const prefix = domain.split('.')[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'KAMPUS';
  const existingCodes = new Set(existingAffiliates.map(a => a.referralCode));
  let code;
  let attempts = 0;
  do {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    code = `${prefix}-${suffix}`;
    attempts++;
  } while (existingCodes.has(code) && attempts < 20);
  return code;
}

function findAffiliateByReferralCode(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  const affiliates = getAffiliates();
  return affiliates.find(a => a.referralCode === normalized && a.status === 'active') || null;
}

// Dipanggil dari webhook Faspay SETELAH pembayaran sukses & user.type/paymentExpiredAt
// sudah diupdate - mencatat 1 baris earning + menambah balance/totalEarned affiliate.
// netAmount = tagihan bersih yang BENAR-BENAR dibayar user (record.amount di
// faspay-pending, sudah termasuk diskon kalau ada) - komisi dihitung dari angka ini,
// bukan harga normal, konsisten dengan definisi PRD ("dihitung dari tagihan bersih").
function recordAffiliateCommission(affiliateId, buyerUser, planId, netAmount, billNo) {
  const affiliates = getAffiliates();
  const affiliate = affiliates.find(a => a.id === affiliateId);
  if (!affiliate || affiliate.status !== 'active') return;

  const tier = planId.startsWith('ultimate') ? 'ultimate' : 'premium';
  const rate = AFFILIATE_COMMISSION_RATE[tier] || 0;
  const commissionAmount = Math.round(netAmount * (rate / 100));
  if (commissionAmount <= 0) return;

  const earnings = getAffiliateEarnings();
  earnings.unshift({
    id: uuidv4(),
    affiliateId,
    referredUserId: buyerUser.id,
    referredUserEmail: buyerUser.email,
    billNo,
    subscriptionTier: tier,
    planId,
    netAmount,
    commissionRate: rate,
    commissionAmount,
    status: 'confirmed',
    createdAt: new Date().toISOString()
  });
  saveAffiliateEarnings(earnings);

  affiliate.balance = (affiliate.balance || 0) + commissionAmount;
  affiliate.totalEarned = (affiliate.totalEarned || 0) + commissionAmount;
  saveAffiliates(affiliates);
}

// Rate limit OTP afiliasi - per akun (bukan per IP), cegah spam kirim ulang OTP.
const affiliateOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak permintaan kode OTP. Tunggu beberapa menit lalu coba lagi.' }
});

app.post('/api/affiliate/send-otp', requireAccess, affiliateOtpLimiter, async (req, res) => {
  const campusEmail = String((req.body && req.body.campusEmail) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.ac\.id$/i.test(campusEmail)) {
    return res.status(400).json({ ok: false, message: 'Masukkan email institusi yang valid, berakhiran .ac.id.' });
  }

  const affiliates = getAffiliates();
  if (affiliates.find(a => a.userId === req.session.userId)) {
    return res.status(400).json({ ok: false, message: 'Akun Anda sudah terdaftar sebagai affiliate.' });
  }
  if (affiliates.find(a => a.campusEmail.toLowerCase() === campusEmail)) {
    return res.status(400).json({ ok: false, message: 'Email institusi ini sudah dipakai akun affiliate lain.' });
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otps = getAffiliateOtps();
  otps[req.session.userId] = {
    campusEmail,
    otp,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    attempts: 0
  };
  saveAffiliateOtps(otps);

  const html = `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a202c;">
    <div style="padding: 1.5rem 0; border-bottom: 2px solid #0787dc;"><span style="font-weight: 800; font-size: 1.1rem; color: #0787dc;">JurnalHub</span></div>
    <div style="padding: 1.5rem 0;">
      <h2 style="margin: 0 0 1rem;">Kode Verifikasi Program Afiliasi Kampus</h2>
      <p style="line-height: 1.6;">Gunakan kode berikut untuk memverifikasi email institusi Anda (berlaku 10 menit):</p>
      <p style="font-size: 2rem; font-weight: 800; letter-spacing: 0.3rem; text-align: center; color: #0787dc; margin: 1.5rem 0;">${otp}</p>
      <p style="font-size: 0.85rem; color: #718096;">Kalau Anda tidak meminta kode ini, abaikan email ini.</p>
    </div>
  </div>`;
  const sent = await sendMailHelper(campusEmail, '[JurnalHub] Kode Verifikasi Afiliasi Kampus', html);
  if (!sent) {
    return res.status(500).json({ ok: false, message: 'Gagal mengirim email OTP. Coba lagi nanti.' });
  }
  res.json({ ok: true, message: 'Kode OTP telah dikirim ke email institusi Anda.' });
});

app.post('/api/affiliate/verify-otp', requireAccess, affiliateOtpLimiter, async (req, res) => {
  const otpInput = String((req.body && req.body.otp) || '').trim();
  if (!otpInput) {
    return res.status(400).json({ ok: false, message: 'Kode OTP wajib diisi.' });
  }

  const otps = getAffiliateOtps();
  const record = otps[req.session.userId];
  if (!record) {
    return res.status(400).json({ ok: false, message: 'Tidak ada permintaan OTP aktif. Kirim ulang kode.' });
  }
  if (new Date(record.expiresAt) < new Date()) {
    delete otps[req.session.userId];
    saveAffiliateOtps(otps);
    return res.status(400).json({ ok: false, message: 'Kode OTP sudah kedaluwarsa. Kirim ulang kode.' });
  }
  if (record.attempts >= 5) {
    delete otps[req.session.userId];
    saveAffiliateOtps(otps);
    return res.status(400).json({ ok: false, message: 'Terlalu banyak percobaan salah. Kirim ulang kode.' });
  }
  if (record.otp !== otpInput) {
    record.attempts += 1;
    saveAffiliateOtps(otps);
    return res.status(400).json({ ok: false, message: 'Kode OTP salah.' });
  }

  delete otps[req.session.userId];
  saveAffiliateOtps(otps);

  const affiliates = getAffiliates();
  // Jaga-jaga race condition (2 request verify hampir bersamaan).
  if (affiliates.find(a => a.userId === req.session.userId)) {
    return res.status(400).json({ ok: false, message: 'Akun Anda sudah terdaftar sebagai affiliate.' });
  }
  const referralCode = generateReferralCode(record.campusEmail, affiliates);
  const newAffiliate = {
    id: uuidv4(),
    userId: req.session.userId,
    campusEmail: record.campusEmail,
    referralCode,
    balance: 0,
    totalEarned: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };
  affiliates.push(newAffiliate);
  saveAffiliates(affiliates);

  res.json({ ok: true, affiliate: newAffiliate });
});

app.get('/api/affiliate/me', requireAccess, (req, res) => {
  const affiliates = getAffiliates();
  const affiliate = affiliates.find(a => a.userId === req.session.userId);
  if (!affiliate) {
    return res.json({ ok: true, affiliate: null });
  }

  const earnings = getAffiliateEarnings().filter(e => e.affiliateId === affiliate.id);
  const totalReferrals = new Set(earnings.map(e => e.referredUserId)).size;
  const payouts = getAffiliatePayouts().filter(p => p.affiliateId === affiliate.id)
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  res.json({
    ok: true,
    affiliate: {
      referralCode: affiliate.referralCode,
      campusEmail: affiliate.campusEmail,
      balance: affiliate.balance || 0,
      totalEarned: affiliate.totalEarned || 0,
      totalReferrals,
      status: affiliate.status,
      minPayout: AFFILIATE_MIN_PAYOUT
    },
    earnings: earnings.slice(0, 50).map(e => ({
      referredUserEmail: e.referredUserEmail,
      subscriptionTier: e.subscriptionTier,
      commissionAmount: e.commissionAmount,
      createdAt: e.createdAt
    })),
    payouts: payouts.map(p => ({
      id: p.id,
      amount: p.amount,
      paymentMethod: p.paymentMethod,
      accountDetail: p.accountDetail,
      status: p.status,
      requestedAt: p.requestedAt,
      processedAt: p.processedAt,
      adminNote: p.adminNote
    }))
  });
});

app.post('/api/affiliate/payout', requireAccess, async (req, res) => {
  const paymentMethod = String((req.body && req.body.paymentMethod) || '').trim().slice(0, 50);
  const accountDetail = String((req.body && req.body.accountDetail) || '').trim().slice(0, 200);
  if (!paymentMethod || !accountDetail) {
    return res.status(400).json({ ok: false, message: 'Metode pembayaran dan detail rekening/e-wallet wajib diisi.' });
  }

  let result = null;
  await withLock('affiliates', async () => {
    const affiliates = getAffiliates();
    const affiliate = affiliates.find(a => a.userId === req.session.userId);
    if (!affiliate) {
      result = { status: 404, body: { ok: false, message: 'Anda belum terdaftar sebagai affiliate.' } };
      return;
    }
    if ((affiliate.balance || 0) < AFFILIATE_MIN_PAYOUT) {
      result = { status: 400, body: { ok: false, message: `Saldo minimal untuk penarikan adalah Rp${AFFILIATE_MIN_PAYOUT.toLocaleString('id-ID')}.` } };
      return;
    }

    // Saldo langsung "direservasi" (dinolkan) saat pengajuan - bukan nunggu admin
    // approve - supaya tidak bisa ajukan payout dobel dari saldo yang sama sebelum
    // diproses. Kalau admin reject, saldo dikembalikan (lihat
    // POST /api/admin/affiliates/payouts/:id/reject).
    const amount = affiliate.balance;
    affiliate.balance = 0;
    saveAffiliates(affiliates);

    const payouts = getAffiliatePayouts();
    const newPayout = {
      id: uuidv4(),
      affiliateId: affiliate.id,
      amount,
      paymentMethod,
      accountDetail,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      processedAt: null,
      adminNote: null
    };
    payouts.push(newPayout);
    saveAffiliatePayouts(payouts);

    result = { status: 200, body: { ok: true, payout: newPayout } };
  });

  res.status(result.status).json(result.body);
});

// Ganti kode referral bawaan (auto-generated, mis. UNISBA-8C36) dengan yang
// dipilih sendiri affiliate - supaya lebih gampang diingat/dibagikan. Link
// (bukan cuma kode) otomatis ikut berubah karena link dibentuk dari kode ini
// (lihat window.location.origin + '/?ref=' + referralCode di app.js) - link
// LAMA yang sudah disebar jadi mati begitu kode diganti, karena bukan alias,
// murni rename di tempat (lihat findAffiliateByReferralCode: exact match ke
// referralCode saat ini, tidak menyimpan riwayat kode lama).
app.post('/api/affiliate/update-referral-code', requireAccess, async (req, res) => {
  const rawCode = String((req.body && req.body.referralCode) || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$/.test(rawCode)) {
    return res.status(400).json({ ok: false, message: 'Kode harus 4-20 karakter, hanya huruf/angka/tanda hubung (tidak boleh diawali/diakhiri tanda hubung).' });
  }

  let result = null;
  await withLock('affiliates', async () => {
    const affiliates = getAffiliates();
    const affiliate = affiliates.find(a => a.userId === req.session.userId);
    if (!affiliate) {
      result = { status: 404, body: { ok: false, message: 'Anda belum terdaftar sebagai affiliate.' } };
      return;
    }
    const takenByOther = affiliates.some(a => a.id !== affiliate.id && a.referralCode === rawCode);
    const clashesWithPromo = Object.prototype.hasOwnProperty.call(PROMO_CODES, rawCode);
    if (takenByOther || clashesWithPromo) {
      result = { status: 409, body: { ok: false, message: 'Kode referral ini sudah dipakai. Coba kode lain.' } };
      return;
    }

    affiliate.referralCode = rawCode;
    saveAffiliates(affiliates);
    result = { status: 200, body: { ok: true, referralCode: rawCode } };
  });

  res.status(result.status).json(result.body);
});

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [key, ...valueParts] = item.trim().split('=');
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(valueParts.join('='));
    return cookies;
  }, {});
}

const MAX_CONCURRENT_SESSIONS = 2;

function hasAccess(req) {
  // Check if session exists and user is authenticated
  if (req.session && req.session.userId) {
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (user) {
      // Jika sessionToken di session kosong (race-condition write file store),
      // anggap valid agar tidak ter-logout secara paksa (bisa jadi salah satu
      // dari beberapa device yg sedang aktif, tidak bisa ditebak slot mana).
      if (!req.session.sessionToken) {
        return true;
      }
      if (Array.isArray(user.activeSessionTokens) && user.activeSessionTokens.includes(req.session.sessionToken)) {
        return true;
      }
      // Kompatibilitas mundur: user lama yg belum migrasi ke array.
      if (!Array.isArray(user.activeSessionTokens) && user.currentSessionToken === req.session.sessionToken) {
        return true;
      }
    }
    // Clear session to force logout if token does not match
    delete req.session.userId;
    delete req.session.sessionToken;
  }
  return false;
}

// Dipakai di tiap titik penolakan kuota (return 403 "Limit bulanan tercapai"
// dkk) di seluruh file - satu helper kecil ini, bukan fungsi gate terpusat,
// karena tiap fitur punya cara cek kuotanya sendiri-sendiri (hitungan bulanan,
// kata, dsb) yang sudah tersebar dari awal - lihat req.session.isAdmin
// (di-set saat login/di /api/me, lihat syncAdminFlagsFromEnv).
function isAdminReq(req) {
  return !!(req.session && req.session.isAdmin);
}

// --- DEEPSEEK SHARED CREDIT POOL (kuota token mingguan lintas fitur) ---
// Menggantikan kuota kaku per-fitur (3x/bulan, 5x/bulan, dst) untuk SEMUA
// fitur berbasis DeepSeek (Match, Lit Review, SLR, Peer Review, Research
// Chat, Notebook Continue Writing/AI Draft Action, Citation Graph TL;DR,
// Folder Chat, AI Disclosure Generator) DAN Co-Work Agent (OpenRouter
// GLM 5.2) - TIDAK termasuk Humanizer (StealthGPT), yang tetap dijatah
// terpisah (unit kata, bukan token, API-nya beda konsep sama sekali).
// 1 kredit = 1000 token DeepSeek, dihitung dari usage.total_tokens ASLI di
// respons (bukan estimasi/bobot manual per fitur) - reset tiap Senin 00:00
// UTC. Token Co-Work (GLM 5.2, vendor & harga beda) dikonversi ke "token
// setara DeepSeek" pakai COWORK_POOL_COST_MULTIPLIER sebelum masuk pool yang
// sama - lihat konstanta itu. Pola gate-lalu-catat: cek akses SEBELUM
// memanggil AI (biner, tidak tahu biaya pasti di muka), lalu tambahkan token
// yang benar-benar terpakai SETELAH respons selesai - artinya 1 panggilan
// terakhir seorang user bisa sedikit melebihi limit sebelum panggilan
// berikutnya ditolak, ini perilaku normal untuk rate limiting berbasis token.
const DEEPSEEK_POOL_WEEKLY_CREDITS = { free: 10, premium: 600, ultimate: 1500 };
const DEEPSEEK_CREDIT_TOKEN_SIZE = 1000;
const DEEPSEEK_POOL_HISTORY_DAYS = 30;
// Harga OpenRouter GLM 5.2 (waktu itu provider Baidu) vs DeepSeek v4 per 1
// juta token ada di rasio 6.1:1 (GLM 5.2 6.1x lebih mahal) - jadi 1 token
// Co-Work "dihargai" 6.1 token DeepSeek saat ditambahkan ke pool bersama,
// supaya kredit yang terpakai betul-betul proporsional dengan biaya API
// asli, bukan dihitung token mentah apa adanya. CATATAN: sejak
// callOpenRouterGLM dipindah ke provider.sort:"price" (2026-08-18),
// provider GLM 5.2 yang benar-benar dipakai bisa BERUBAH-UBAH otomatis
// (selalu yang termurah saat itu) - rasio 6.1:1 ini jadi perkiraan/rata-rata
// kasar, bukan angka pasti dari 1 provider tetap lagi. Cukup akurat untuk
// tujuan pemerataan kuota, tidak perlu presisi sampai desimal.
// Update angka ini kalau harga OpenRouter/DeepSeek berubah signifikan.
const COWORK_POOL_COST_MULTIPLIER = 6.1;

function getCurrentWeekStartISO() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Minggu, 1=Senin, ..., 6=Sabtu
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday));
  return monday.toISOString().slice(0, 10);
}

function ensureDeepSeekPoolFresh(user) {
  const weekStart = getCurrentWeekStartISO();
  if (user.deepseekPoolWeekStart !== weekStart) {
    user.deepseekPoolWeekStart = weekStart;
    user.deepseekPoolTokensUsedThisWeek = 0;
  }
  if (!user.deepseekPoolTokensUsedThisWeek) user.deepseekPoolTokensUsedThisWeek = 0;
}

function getDeepSeekPoolLimitTokens(user) {
  const tier = (user && user.type) || 'free';
  const credits = DEEPSEEK_POOL_WEEKLY_CREDITS[tier] ?? DEEPSEEK_POOL_WEEKLY_CREDITS.free;
  return credits * DEEPSEEK_CREDIT_TOKEN_SIZE;
}

function hasDeepSeekPoolAccess(user) {
  if (!user) return false;
  ensureDeepSeekPoolFresh(user);
  return user.deepseekPoolTokensUsedThisWeek < getDeepSeekPoolLimitTokens(user);
}

// Tiap entri deepseekPoolDailyUsage[date] disimpan sebagai { direct, cowork }
// (token setara-DeepSeek) - dipisah biar grafik Usage bisa nunjukin ke user
// mana yang bikin kuotanya kepakai (JurnalHub Intelligence dkk vs Co-Work
// Agent), meski keduanya berbagi 1 total pool yang sama untuk pengecekan
// limit. normalizeDailyEntry jaga-jaga kalau ada data lama format angka
// polos (sebelum pemisahan source ini ada).
function normalizeDailyEntry(entry) {
  if (entry && typeof entry === 'object') {
    return { direct: entry.direct || 0, cowork: entry.cowork || 0 };
  }
  return { direct: Number(entry) || 0, cowork: 0 };
}

function getDeepSeekPoolStatus(user) {
  if (!user) {
    return {
      usedTokens: 0,
      limitTokens: DEEPSEEK_POOL_WEEKLY_CREDITS.free * DEEPSEEK_CREDIT_TOKEN_SIZE,
      weekStart: getCurrentWeekStartISO(),
      dailyUsage: {}
    };
  }
  ensureDeepSeekPoolFresh(user);
  const rawDaily = (user.deepseekPoolDailyUsage && typeof user.deepseekPoolDailyUsage === 'object') ? user.deepseekPoolDailyUsage : {};
  const dailyUsage = {};
  Object.keys(rawDaily).forEach(date => { dailyUsage[date] = normalizeDailyEntry(rawDaily[date]); });
  return {
    usedTokens: user.deepseekPoolTokensUsedThisWeek || 0,
    limitTokens: getDeepSeekPoolLimitTokens(user),
    weekStart: user.deepseekPoolWeekStart,
    dailyUsage
  };
}

// Dipanggil SETELAH panggilan AI sukses & jumlah token asli diketahui. Baca
// ulang users.json sendiri (bukan pakai array `users` yang mungkin sudah
// dimuat route pemanggil) supaya tidak ketimpa oleh saveUsers() lain dari
// route yang sama yang jalan lebih dulu/belakangan - pola yang sama dengan
// re-read di increment /api/research-chat. `source` = 'cowork' untuk token
// dari Co-Work Agent (sudah dikonversi pakai COWORK_POOL_COST_MULTIPLIER
// oleh caller), default 'direct' untuk fitur DeepSeek biasa.
function recordDeepSeekPoolUsage(userId, tokens, source) {
  const tokenCount = Number(tokens) || 0;
  if (!userId || tokenCount <= 0) return;
  const users = getUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return;
  ensureDeepSeekPoolFresh(user);
  user.deepseekPoolTokensUsedThisWeek += tokenCount;

  const today = new Date().toISOString().slice(0, 10);
  if (!user.deepseekPoolDailyUsage || typeof user.deepseekPoolDailyUsage !== 'object') {
    user.deepseekPoolDailyUsage = {};
  }
  const entry = normalizeDailyEntry(user.deepseekPoolDailyUsage[today]);
  const key = source === 'cowork' ? 'cowork' : 'direct';
  entry[key] += tokenCount;
  user.deepseekPoolDailyUsage[today] = entry;

  const cutoff = new Date(Date.now() - DEEPSEEK_POOL_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(user.deepseekPoolDailyUsage).forEach(date => {
    if (date < cutoff) delete user.deepseekPoolDailyUsage[date];
  });

  saveUsers(users);
}

// Gate biner dipanggil sebelum tiap panggilan DeepSeek di rute yang masuk
// pool bersama. Admin selalu lolos (konsisten dengan isAdminReq di rute
// lain). Mengirim balasan 403 sendiri kalau habis - panggil SEBELUM mulai
// respons streaming (sebelum header terkirim).
function requireDeepSeekPoolAccess(req, res, user) {
  if (isAdminReq(req)) return true;
  if (!hasDeepSeekPoolAccess(user)) {
    res.status(403).json({
      error: 'Kuota mingguan JurnalHub Intelligence Anda sudah habis. Kuota akan direset otomatis setiap hari Senin (lihat detail di Pengaturan > Usage).',
      poolLimitReached: true
    });
    return false;
  }
  return true;
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

// Dipasang SETELAH requireAccess (jadi req.session.userId sudah pasti valid) -
// menolak siapapun yang bukan admin, termasuk user login biasa yang coba akses
// endpoint /api/admin/* langsung lewat panggilan API manual.
function requireAdmin(req, res, next) {
  if (!isAdminReq(req)) {
    return res.status(403).json({ ok: false, message: 'Akses ditolak. Halaman ini khusus admin.' });
  }
  next();
}

// Dashboard admin (versi minimal): daftar SEMUA user + ringkasan jumlah per
// tipe akun. Whitelist field secara eksplisit (bukan buang field sensitif
// dari objek user apa adanya) - supaya password hash/token verifikasi/session
// token TIDAK PERNAH bisa ke-expose walau skema user berubah di kemudian hari.
// user.type di-set saat pembayaran berhasil (webhook Faspay) dan cuma
// di-downgrade balik ke 'free' secara LAZY - lihat pengecekan paymentExpiredAt
// di /api/me - yang berarti hanya jalan begitu USER ITU SENDIRI buka app lagi
// setelah expired. Jadi field type mentah di database bisa "basi" (masih
// tercatat premium/ultimate padahal sudah lewat masa aktifnya, kalau user itu
// belum login lagi sejak expired) - dipakai di /api/admin/users (ringkasan
// jumlah per tier) dan segmentasi Email Blast supaya keduanya mencerminkan
// status BENERAN saat ini, bukan field yang mungkin belum ke-sync.
function computeEffectiveUserType(user) {
  const rawType = user.type || 'free';
  if (rawType !== 'free' && user.paymentExpiredAt && new Date(user.paymentExpiredAt) < new Date()) {
    return 'free';
  }
  return rawType;
}

app.get('/api/admin/users', requireAccess, requireAdmin, (req, res) => {
  const users = getUsers();
  const list = users
    .map(u => ({
      id: u.id,
      email: u.email,
      name: u.name || '',
      type: computeEffectiveUserType(u),
      isAdmin: !!u.isAdmin,
      isVerified: !!u.isVerified,
      emailOptOut: !!u.emailOptOut,
      planId: u.planId || null,
      paymentExpiredAt: u.paymentExpiredAt || null,
      createdAt: u.createdAt || null
    }))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const summary = {
    total: list.length,
    free: list.filter(u => u.type === 'free').length,
    premium: list.filter(u => u.type === 'premium').length,
    ultimate: list.filter(u => u.type === 'ultimate').length,
    admins: list.filter(u => u.isAdmin).length
  };

  res.json({ ok: true, users: list, summary });
});

// --- ADMIN: Program Afiliasi Kampus - panel "Affiliate Management" (lihat
// komentar besar Program Afiliasi Kampus di dekat definisi getAffiliates). ---
app.get('/api/admin/affiliates', requireAccess, requireAdmin, (req, res) => {
  const affiliates = getAffiliates();
  const earnings = getAffiliateEarnings();
  const users = getUsers();
  const userById = new Map(users.map(u => [u.id, u]));

  const list = affiliates.map(a => {
    const ownEarnings = earnings.filter(e => e.affiliateId === a.id);
    const totalReferrals = new Set(ownEarnings.map(e => e.referredUserId)).size;
    const owner = userById.get(a.userId);
    return {
      id: a.id,
      ownerEmail: owner ? owner.email : '(user dihapus)',
      campusEmail: a.campusEmail,
      referralCode: a.referralCode,
      balance: a.balance || 0,
      totalEarned: a.totalEarned || 0,
      totalReferrals,
      status: a.status,
      createdAt: a.createdAt
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    ok: true,
    affiliates: list,
    summary: {
      total: list.length,
      totalCommissionPaid: earnings.reduce((sum, e) => sum + e.commissionAmount, 0),
      totalBalanceOwed: list.reduce((sum, a) => sum + a.balance, 0)
    }
  });
});

// Ban/unban - affiliate yang di-ban kode referralnya berhenti berfungsi
// (findAffiliateByReferralCode cuma cocokkan status 'active') & recordAffiliateCommission
// berhenti mencatat komisi baru untuknya, TAPI histori earning/balance yang SUDAH ada
// tidak dihapus/di-nolkan - cuma menutup pintu penyalahgunaan lebih lanjut.
app.post('/api/admin/affiliates/:id/toggle-status', requireAccess, requireAdmin, (req, res) => {
  const affiliates = getAffiliates();
  const affiliate = affiliates.find(a => a.id === req.params.id);
  if (!affiliate) {
    return res.status(404).json({ ok: false, message: 'Affiliate tidak ditemukan.' });
  }
  affiliate.status = affiliate.status === 'active' ? 'banned' : 'active';
  saveAffiliates(affiliates);
  res.json({ ok: true, status: affiliate.status });
});

app.get('/api/admin/affiliates/payouts', requireAccess, requireAdmin, (req, res) => {
  const payouts = getAffiliatePayouts();
  const affiliates = getAffiliates();
  const affiliateById = new Map(affiliates.map(a => [a.id, a]));
  const users = getUsers();
  const userById = new Map(users.map(u => [u.id, u]));

  const list = payouts.map(p => {
    const affiliate = affiliateById.get(p.affiliateId);
    const owner = affiliate ? userById.get(affiliate.userId) : null;
    return {
      id: p.id,
      ownerEmail: owner ? owner.email : '(user dihapus)',
      referralCode: affiliate ? affiliate.referralCode : '-',
      amount: p.amount,
      paymentMethod: p.paymentMethod,
      accountDetail: p.accountDetail,
      status: p.status,
      requestedAt: p.requestedAt,
      processedAt: p.processedAt,
      adminNote: p.adminNote
    };
  }).sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

  res.json({ ok: true, payouts: list });
});

app.post('/api/admin/affiliates/payouts/:id/approve', requireAccess, requireAdmin, (req, res) => {
  const payouts = getAffiliatePayouts();
  const payout = payouts.find(p => p.id === req.params.id);
  if (!payout) {
    return res.status(404).json({ ok: false, message: 'Pengajuan payout tidak ditemukan.' });
  }
  if (payout.status !== 'pending') {
    return res.status(400).json({ ok: false, message: 'Pengajuan ini sudah diproses sebelumnya.' });
  }
  payout.status = 'approved';
  payout.processedAt = new Date().toISOString();
  saveAffiliatePayouts(payouts);
  res.json({ ok: true });
});

app.post('/api/admin/affiliates/payouts/:id/reject', requireAccess, requireAdmin, (req, res) => {
  const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
  const payouts = getAffiliatePayouts();
  const payout = payouts.find(p => p.id === req.params.id);
  if (!payout) {
    return res.status(404).json({ ok: false, message: 'Pengajuan payout tidak ditemukan.' });
  }
  if (payout.status !== 'pending') {
    return res.status(400).json({ ok: false, message: 'Pengajuan ini sudah diproses sebelumnya.' });
  }
  payout.status = 'rejected';
  payout.processedAt = new Date().toISOString();
  payout.adminNote = note || null;
  saveAffiliatePayouts(payouts);

  // Kembalikan saldo yang sempat "direservasi" saat pengajuan (lihat POST /api/affiliate/payout).
  const affiliates = getAffiliates();
  const affiliate = affiliates.find(a => a.id === payout.affiliateId);
  if (affiliate) {
    affiliate.balance = (affiliate.balance || 0) + payout.amount;
    saveAffiliates(affiliates);
  }

  res.json({ ok: true });
});

// --- EMAIL BLAST (konversi Free -> berbayar, dsb) ---
// Token unsubscribe: HMAC(userId, SESSION_SECRET) dipotong 16 karakter -
// cukup supaya orang tidak bisa unsubscribe-kan user LAIN cuma dengan
// menebak userId-nya (butuh tahu secret server), tanpa perlu tabel token
// terpisah/kadaluarsa (unsubscribe memang seharusnya berlaku selamanya
// sampai user itu subscribe lagi, tidak perlu re-generate).
function computeUnsubscribeToken(userId) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(userId)).digest('hex').slice(0, 16);
}

// Link ini SENGAJA publik (tanpa requireAccess) - orang yang klik dari email
// belum tentu sedang login sesi browser yang sama, dan tujuannya justru supaya
// unsubscribe semudah mungkin (1 klik, tanpa harus login dulu) sesuai praktik
// standar email marketing.
app.get('/api/unsubscribe', (req, res) => {
  const { uid, token } = req.query;
  if (!uid || !token || computeUnsubscribeToken(uid) !== token) {
    return res.status(400).send('Tautan unsubscribe tidak valid.');
  }
  const users = getUsers();
  const user = users.find(u => u.id === uid);
  if (user) {
    user.emailOptOut = true;
    saveUsers(users);
  }
  res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Berhenti Berlangganan</title></head><body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem; color: #1a202c;"><h2>Anda telah berhenti berlangganan email promosi JurnalHub.</h2><p style="color: #718096;">Anda tetap akan menerima email transaksional penting (verifikasi, reset password, dsb).</p></body></html>');
});

// Status blast berjalan - in-memory (bukan file JSON) karena sifatnya cuma
// progress sementara SATU proses pengiriman, tidak perlu bertahan lintas
// restart server; kalau server restart di tengah blast, blast itu berhenti
// (dianggap gagal) - lihat catatan panjang soal keterbatasan ini di endpoint
// POST di bawah.
let emailBlastStatus = { inProgress: false, total: 0, sent: 0, failed: 0, startedAt: null, finishedAt: null, subject: null };

app.get('/api/admin/email-blast/status', requireAccess, requireAdmin, (req, res) => {
  res.json({ ok: true, status: emailBlastStatus });
});

// Direktori gambar blast - di dalam DATA_DIR (bukan assets/ yang ikut source
// code) supaya persisten di Railway Volume yang sudah di-mount di /app/data,
// bertahan lintas redeploy (yang di proyek ini sering terjadi tiap push ke
// main) - gambar perlu tetap bisa dimuat kalau penerima baru buka emailnya
// beberapa hari setelah blast dikirim.
const BLAST_UPLOADS_DIR = path.join(DATA_DIR, 'uploads', 'blast-images');
const BLAST_IMAGE_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};
const blastImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB - cukup longgar utk gambar email tanpa bikin ukuran email membengkak berlebihan
  fileFilter: (req, file, cb) => {
    if (BLAST_IMAGE_EXT_BY_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Format gambar tidak didukung. Gunakan JPG, PNG, GIF, atau WEBP.'));
    }
  }
});

app.post('/api/admin/email-blast/upload-image', requireAccess, requireAdmin, (req, res) => {
  blastImageUpload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, message: err.message || 'Gagal mengunggah gambar.' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Tidak ada file gambar yang diunggah.' });
    }
    try {
      fs.mkdirSync(BLAST_UPLOADS_DIR, { recursive: true });
      // Nama file acak (BUKAN nama asli file upload) - selain menghindari
      // tabrakan nama, juga mencegah nama file jadi vektor path traversal
      // sama sekali (lihat validasi regex ketat di GET /blast-uploads/:filename).
      const filename = uuidv4() + BLAST_IMAGE_EXT_BY_MIME[req.file.mimetype];
      fs.writeFileSync(path.join(BLAST_UPLOADS_DIR, filename), req.file.buffer);
      // URL absolut (bukan path relatif) - ini dipakai sbg <img src> di email
      // yang dibuka di INBOX penerima, bukan di dalam app ini, jadi tidak ada
      // "origin saat ini" yang bisa diandalkan buat resolve path relatif -
      // hardcode domain produksi, konsisten dengan pola yang sama dipakai
      // unsubUrl (lihat di bawah, POST /api/admin/email-blast).
      res.json({ ok: true, url: `https://jurnalhub.id/blast-uploads/${filename}` });
    } catch (writeErr) {
      console.error('[Email Blast] Gagal menyimpan gambar upload:', writeErr.message);
      res.status(500).json({ ok: false, message: 'Gagal menyimpan gambar di server.' });
    }
  });
});

// PUBLIK (tanpa requireAccess) - gambar ini akan dimuat oleh email client
// PENERIMA blast, yang jelas tidak sedang login sesi browser JurnalHub.
// Filename divalidasi ketat (harus PERSIS format yang dihasilkan uuidv4() +
// salah satu ekstensi di atas) sebelum dipakai membentuk path - mencegah path
// traversal (../../dst) walau nama filenya sendiri sepenuhnya server-generated.
app.get('/blast-uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9-]{36}\.(jpg|png|gif|webp)$/.test(filename)) {
    return res.status(404).send('Not Found');
  }
  const filePath = path.join(BLAST_UPLOADS_DIR, filename);
  res.sendFile(filePath, { maxAge: '30d' }, (err) => {
    if (err && !res.headersSent) res.status(404).send('Not Found');
  });
});

const EMAIL_BLAST_SEGMENTS = new Set(['free', 'premium', 'ultimate', 'all']);

// Kirim blast email promosi ke segmen user tertentu. TIDAK di-await sampai
// selesai - langsung balas 200 begitu daftar penerima final ditentukan, lalu
// proses pengiriman sungguhan jalan async di background (throttle 400ms per
// email supaya tidak membanjiri Resend API sekaligus/kena rate limit),
// progress-nya dipoll lewat GET .../status di atas. Kalau server redeploy di
// tengah proses, sisa penerima yang belum kebagian TIDAK otomatis lanjut
// setelah restart (keterbatasan yang sama seperti didiskusikan soal Co-Work
// Agent - tidak ada job queue persisten di app ini) - makanya jumlah
// penerima yang sudah terkirim vs total selalu ditampilkan di UI supaya admin
// tahu kalau harus mengirim ulang sisanya secara manual.
app.post('/api/admin/email-blast', requireAccess, requireAdmin, async (req, res) => {
  if (emailBlastStatus.inProgress) {
    return res.status(409).json({ ok: false, message: 'Masih ada blast email lain yang sedang berjalan. Tunggu sampai selesai.' });
  }

  const segment = String((req.body && req.body.segment) || '').trim();
  // Filter tambahan: cuma email domain akademik (.ac.id) - dipakai buat
  // kampanye penawaran khusus akademisi, independen dari segmen tier
  // (mis. "Semua" + academicOnly = semua user ber-email .ac.id apapun tier-nya).
  const academicOnly = !!(req.body && req.body.academicOnly);
  const subject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
  const bodyText = String((req.body && req.body.bodyText) || '').trim().slice(0, 20000);
  // imageUrl/ctaText/ctaUrl semua opsional - user paste link gambar yang
  // sudah di-hosting di tempat lain (imgur/CDN sendiri/dsb), BUKAN upload
  // file baru lewat form ini (di luar scope versi ini, lihat catatan di
  // index.html) - dan link tombol CTA opsional buat ajakan aksi (mis. link
  // ke halaman upgrade).
  const imageUrl = String((req.body && req.body.imageUrl) || '').trim().slice(0, 1000);
  const ctaText = String((req.body && req.body.ctaText) || '').trim().slice(0, 60);
  const ctaUrl = String((req.body && req.body.ctaUrl) || '').trim().slice(0, 1000);

  if (!EMAIL_BLAST_SEGMENTS.has(segment)) {
    return res.status(400).json({ ok: false, message: 'Segmen tidak valid.' });
  }
  if (!subject || !bodyText) {
    return res.status(400).json({ ok: false, message: 'Subjek dan isi email wajib diisi.' });
  }
  // Wajib http(s) - mencegah skema aneh (javascript:, data:, dsb) ke-embed
  // sebagai href/src di email yang bakal dikirim ke ratusan orang.
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    return res.status(400).json({ ok: false, message: 'URL gambar harus diawali http:// atau https://.' });
  }
  if (ctaUrl && !/^https?:\/\//i.test(ctaUrl)) {
    return res.status(400).json({ ok: false, message: 'Link tombol harus diawali http:// atau https://.' });
  }
  if ((ctaText && !ctaUrl) || (!ctaText && ctaUrl)) {
    return res.status(400).json({ ok: false, message: 'Teks tombol dan link tombol harus diisi berdua, atau dikosongkan berdua.' });
  }

  // Dikirim ke SEMUA user di segmen ini terlepas status verifikasi email -
  // atas permintaan eksplisit (sebelumnya user belum verifikasi dikecualikan
  // demi proteksi reputasi domain, tapi diputuskan tetap disertakan). Yang
  // TETAP dikecualikan cuma emailOptOut - itu permintaan berhenti berlangganan
  // eksplisit dari user sendiri, tidak boleh di-override oleh siapapun.
  const users = getUsers();
  const recipients = users.filter(u => {
    if (!u.email || u.emailOptOut) return false;
    if (academicOnly && !u.email.toLowerCase().endsWith('.ac.id')) return false;
    if (segment === 'all') return true;
    return computeEffectiveUserType(u) === segment;
  });

  if (recipients.length === 0) {
    return res.status(400).json({ ok: false, message: 'Tidak ada penerima yang cocok dengan filter ini (sudah dikurangi yang sudah unsubscribe).' });
  }

  emailBlastStatus = { inProgress: true, total: recipients.length, sent: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null, subject };
  res.json({ ok: true, queued: recipients.length });

  // Paragraf dipisah baris kosong di textarea -> jadi <p> terpisah, biar admin
  // tidak perlu menulis HTML manual buat email sesederhana ini.
  const bodyHtml = bodyText.split(/\n\s*\n/).map(p => `<p style="margin: 0 0 1rem; line-height: 1.6;">${escapeHtmlServer(p).replace(/\n/g, '<br>')}</p>`).join('');
  const imageHtml = imageUrl ? `<img src="${escapeHtmlServer(imageUrl)}" alt="" style="max-width: 100%; border-radius: 8px; display: block; margin-bottom: 1.5rem;">` : '';
  const ctaHtml = (ctaText && ctaUrl) ? `<div style="text-align: center; margin: 1.5rem 0;"><a href="${escapeHtmlServer(ctaUrl)}" style="display: inline-block; background: #0787dc; color: #ffffff; padding: 0.75rem 2rem; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.9rem;">${escapeHtmlServer(ctaText)}</a></div>` : '';

  (async () => {
    for (const user of recipients) {
      const unsubToken = computeUnsubscribeToken(user.id);
      const unsubUrl = `https://jurnalhub.id/api/unsubscribe?uid=${encodeURIComponent(user.id)}&token=${unsubToken}`;
      const fullHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a202c;">
          <div style="padding: 1.5rem 0; border-bottom: 2px solid #0787dc;">
            <span style="font-weight: 800; font-size: 1.1rem; color: #0787dc;">JurnalHub</span>
          </div>
          <div style="padding: 1.5rem 0;">${imageHtml}${bodyHtml}${ctaHtml}</div>
          <div style="padding-top: 1.5rem; border-top: 1px solid #e2e8f0; font-size: 0.75rem; color: #a0aec0;">
            Anda menerima email ini karena terdaftar sebagai pengguna JurnalHub.
            <a href="${unsubUrl}" style="color: #a0aec0;">Berhenti berlangganan email promosi</a>.
          </div>
        </div>`;
      const success = await sendMailHelper(user.email, subject, fullHtml);
      if (success) {
        emailBlastStatus.sent += 1;
      } else {
        emailBlastStatus.failed += 1;
      }
      // Jeda antar pengiriman - lindungi rate limit Resend/SMTP, bukan angka
      // sakral, cuma jarak aman yang wajar utk pengiriman berurutan begini.
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    emailBlastStatus.inProgress = false;
    emailBlastStatus.finishedAt = new Date().toISOString();
  })();
});

// --- CO-WORK AGENT (asisten riset otonom background, via OpenRouter GLM 5.2) ---
// Fitur bundel di paket Premium & Ultimate (tanpa biaya tambahan) - free TIDAK
// bisa akses sama sekali (gate tier, lihat submit di bawah). Kuotanya SUDAH
// DIGABUNG ke DEEPSEEK POOL bersama (lihat komentar besar di atas) - token
// GLM 5.2 dikonversi ke token setara-DeepSeek pakai COWORK_POOL_COST_MULTIPLIER
// sebelum ditambahkan ke pool yang sama, jadi tidak ada kuota bulanan
// terpisah lagi untuk Co-Work. SENGAJA tidak ditampilkan sebagai fitur
// terpisah di UI (permintaan eksplisit) - tapi pemakaiannya tetap kelihatan
// di grafik Usage (Pengaturan) sebagai porsi "Co-Work Agent" yang terpisah
// dari porsi fitur DeepSeek langsung, supaya user tahu penyebab kuotanya
// kepakai.
// TIDAK ada job queue sungguhan (Redis/BullMQ dsb) di app ini - pola yang
// dipakai sama seperti Email Blast di atas: request submit langsung dibalas
// begitu task tercatat di cowork-tasks.json, lalu eksekusi sungguhan (panggil
// GLM 5.2 -> convert markdown ke .docx -> kirim email) jalan async TANPA
// di-await, di-poll progressnya lewat GET /api/cowork/status/:id. Kalau server
// redeploy di tengah proses (Railway auto-deploy tiap push ke main), task yang
// sedang 'processing' TIDAK otomatis lanjut - akan tersangkut di status itu
// selamanya (keterbatasan yang sama, tidak ada resume mechanism).
const COWORK_TASKS_FILE = path.join(DATA_DIR, 'cowork-tasks.json');
const COWORK_OUTPUTS_DIR = path.join(DATA_DIR, 'uploads', 'cowork-outputs');
const OPENROUTER_MODEL = 'z-ai/glm-5.2';
const COWORK_SYSTEM_PROMPT = `Anda adalah "JurnalHub Co-Work Agent", Asisten Peneliti Senior Otonom berbasis AI untuk akademisi Indonesia.

TUGAS UTAMA: Jalankan instruksi akademis pengguna secara mandiri, mendalam, kualitatif, ilmiah, dan terstruktur tanpa memotong kalimat.

ATURAN FORMAT:
1. Gunakan Bahasa Indonesia akademis standar (Ragam Bahasa Baku / PUEBI / EYD) kecuali jika pengguna meminta Bahasa Inggris.
2. Gunakan format Markdown yang sangat jelas (Heading 1 (#), Heading 2 (##), Heading 3 (###), Bullet Points, dan Tabel Markdown jika diperlukan).
3. Jangan menyingkat pembahasan. Jika diminta menyusun bab atau jurnal, tuliskan secara lengkap, komprehensif, dan lugas.
4. Semua rujukan/sitasi harus ditulis dengan format akademik konsisten (misal: APA 7th Style).
5. Jika dilampirkan teks dokumen pendukung, lakukan analisis kritis, perbandingan, dan sintesis terhadap dokumen tersebut.`;

// Instruksi kustom user (mirip "Instructions for Claude") - dipakai BERSAMA
// oleh JurnalHub Intelligence (POST /api/research-chat) & Co-Work Agent
// (callOpenRouterGLM), SENGAJA cuma 2 fitur itu (bukan semua fitur AI di
// app) - keduanya percakapan/agentic bebas mirip Claude, sementara fitur
// lain (Draft, Peer Review, dll) outputnya terstruktur/format baku yang
// bisa bentrok kalau instruksi bebas user ikut disuntikkan ke sana. Dikirim
// sbg system message TERPISAH (bukan digabung ke system prompt utama)
// supaya jelas asalnya dari preferensi user, bukan bagian dari
// kepribadian/aturan dasar asisten itu sendiri.
function buildCustomInstructionsMessage(user) {
  const text = user && typeof user.customInstructions === 'string' ? user.customInstructions.trim() : '';
  if (!text) return null;
  return {
    role: 'system',
    content: `INSTRUKSI TAMBAHAN DARI PENGGUNA (ikuti selama tidak bertentangan dengan aturan format/keselamatan di atas):\n${text}`
  };
}

function getCoworkTasks() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(COWORK_TASKS_FILE)) fs.writeFileSync(COWORK_TASKS_FILE, '[]');
    return JSON.parse(fs.readFileSync(COWORK_TASKS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca cowork-tasks.json:', error);
    return [];
  }
}
function saveCoworkTasks(tasks) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COWORK_TASKS_FILE, JSON.stringify(tasks, null, 2));
  } catch (error) {
    console.error('Gagal menyimpan cowork-tasks.json:', error);
  }
}

async function callOpenRouterGLM(userPrompt, attachedContext, customInstructionsMessage) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY belum dikonfigurasi di server.');
  }
  const fetchFn = globalThis.fetch || require('node-fetch');
  const userContent = attachedContext
    ? `${userPrompt}\n\n--- DOKUMEN PENDUKUNG YANG DILAMPIRKAN ---\n${attachedContext}`
    : userPrompt;
  const messages = [{ role: 'system', content: COWORK_SYSTEM_PROMPT }];
  if (customInstructionsMessage) messages.push(customInstructionsMessage);
  messages.push({ role: 'user', content: userContent });

  const controller = new AbortController();
  // 10 menit, sesuai spesifikasi - task Co-Work bisa menghasilkan draf sangat
  // panjang (sampai 12.000 kata) yang makan waktu lama di sisi model.
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  try {
    const openRouterUrl = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
    const response = await fetchFn(openRouterUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://jurnalhub.id',
        'X-Title': 'JurnalHub Co-Work Agent'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        temperature: 0.3,
        max_tokens: 16000,
        // sort:"price" - OpenRouter otomatis rute ke provider TERMURAH yang
        // sedang tersedia untuk model ini SAAT REQUEST (dicek ulang tiap
        // panggilan, bukan dipin ke 1 nama provider tetap). Ini GANTI cara
        // lama (pin manual ke provider.order + allow_fallbacks:false, sempat
        // dipin ke Baidu lalu AkashML) yang selalu jebol ulang tiap kali promo
        // provider itu habis - dengan sort:"price" tidak perlu dipantau/
        // diganti manual lagi kalau promo pindah provider lain, OpenRouter
        // yang urus otomatis (masih tetap ada fallback ke provider termurah
        // berikutnya kalau yang paling murah lagi down, bukan hard-fail).
        // Sumber: https://openrouter.ai/docs/features/provider-routing
        // ("Floor Price Shortcut" / provider.sort:"price").
        provider: {
          sort: 'price'
        },
        messages
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`OpenRouter API error ${response.status}: ${(data && data.error && data.error.message) || 'Tidak ada detail error.'}`);
    }
    const text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const tokensUsed = (data && data.usage && data.usage.total_tokens) || 0;
    if (!text.trim()) {
      throw new Error('GLM 5.2 mengembalikan respons kosong.');
    }
    return { text, tokensUsed };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Waktu tunggu respons GLM 5.2 habis (lebih dari 10 menit). Coba lagi dengan instruksi yang lebih sederhana.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Konversi Markdown (keluaran GLM 5.2) -> elemen docx native ---
// Sengaja parser sederhana (bukan library markdown umum) - cukup untuk subset
// Markdown yang diminta dihasilkan lewat COWORK_SYSTEM_PROMPT di atas
// (heading #/##/###, bullet, list bernomor, **bold**/*italic*, tabel
// pipe-delimited). Regex ini SENGAJA coba pola **bold** dulu baru *italic*
// sebagai alternatif di posisi yang sama - sebelumnya cuma **bold** yang
// ditangani, jadi *italic* tunggal (mis. nama jurnal di sitasi APA, keterangan
// tabel) lolos apa adanya dgn tanda bintang literal ke docx hasil akhir
// (terlihat jelek, bukan benar-benar miring).
function parseInlineRuns(text) {
  const runs = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    if (match[1] !== undefined) {
      runs.push(new TextRun({ text: match[1], bold: true }));
    } else {
      runs.push(new TextRun({ text: match[2], italics: true }));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }
  return runs.length ? runs : [new TextRun({ text: '' })];
}

function markdownTableToDocxTable(tableLines) {
  const rows = tableLines
    .map(l => l.trim())
    .filter(l => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l))
    .map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((cells, rowIdx) => new TableRow({
      children: cells.map(cellText => new TableCell({
        width: { size: Math.floor(100 / Math.max(cells.length, 1)), type: WidthType.PERCENTAGE },
        shading: rowIdx === 0 ? { fill: 'E8F1FB' } : undefined,
        children: [new Paragraph({ children: parseInlineRuns(cellText) })]
      }))
    }))
  });
}

// Judul dokumen buat nama file unduhan & preview - diambil dari heading H1
// pertama hasil GLM (baris "# ..." pertama yang tidak kosong), BUKAN dari
// prompt user apa adanya (yang seringkali berupa instruksi panjang, bukan
// judul yang pantas jadi nama file). Fallback ke baris pertama non-heading
// kalau modelnya entah kenapa tidak mulai dgn heading, dan ke string kosong
// (dipakai pemanggil sbg sinyal utk fallback lagi ke prompt) kalau teksnya
// benar-benar kosong.
function extractTitleFromMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
  }
  return '';
}

function markdownToDocxChildren(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const children = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) { i++; continue; }

    if (trimmed.startsWith('|')) {
      let j = i;
      const tableLines = [];
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      if (tableLines.length >= 2) {
        children.push(markdownTableToDocxTable(tableLines));
        children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
        i = j;
        continue;
      }
      // Bukan tabel valid (cuma 1 baris) - biarkan lolos ke penanganan paragraf biasa di bawah.
    }

    const h3 = trimmed.match(/^###\s+(.*)$/);
    const h2 = !h3 && trimmed.match(/^##\s+(.*)$/);
    const h1 = !h3 && !h2 && trimmed.match(/^#\s+(.*)$/);
    if (h1) {
      children.push(new Paragraph({ children: parseInlineRuns(h1[1]), heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }));
      i++; continue;
    }
    if (h2) {
      children.push(new Paragraph({ children: parseInlineRuns(h2[1]), heading: HeadingLevel.HEADING_2, spacing: { before: 350, after: 150 } }));
      i++; continue;
    }
    if (h3) {
      children.push(new Paragraph({ children: parseInlineRuns(h3[1]), heading: HeadingLevel.HEADING_3, spacing: { before: 300, after: 100 } }));
      i++; continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      children.push(new Paragraph({ children: parseInlineRuns(bulletMatch[1]), bullet: { level: 0 }, spacing: { after: 80 } }));
      i++; continue;
    }

    const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (numberedMatch) {
      children.push(new Paragraph({ children: parseInlineRuns(`${numberedMatch[1]}. ${numberedMatch[2]}`), spacing: { after: 80 }, indent: { left: 360 } }));
      i++; continue;
    }

    children.push(new Paragraph({ children: parseInlineRuns(trimmed), spacing: { after: 200 }, alignment: AlignmentType.JUSTIFIED }));
    i++;
  }

  if (children.length === 0) {
    children.push(new Paragraph({ text: '(Tidak ada konten dihasilkan.)' }));
  }
  return children;
}

const coworkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 }, // 8MB/file, maks 5 file (total wajar di bawah batas 20MB di spesifikasi)
  fileFilter: (req, file, cb) => {
    const originalName = (file.originalname || '').toLowerCase();
    const isAllowedExt = originalName.endsWith('.pdf') || originalName.endsWith('.docx') || originalName.endsWith('.txt') || originalName.endsWith('.csv');
    const allowedMime = [
      'application/pdf', 'application/x-pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'text/csv', 'application/vnd.ms-excel', 'application/octet-stream'
    ];
    if (allowedMime.includes(file.mimetype) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan PDF, DOCX, TXT, atau CSV.'));
    }
  }
});

app.post('/api/cowork/submit', requireAccess, (req, res) => {
  coworkUpload.array('files', 5)(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 8MB per file.' : (err.message || 'Gagal mengunggah file.');
      return res.status(400).json({ ok: false, message });
    }

    const prompt = String((req.body && req.body.prompt) || '').trim();
    if (!prompt) {
      return res.status(400).json({ ok: false, message: 'Instruksi/prompt wajib diisi.' });
    }
    if (prompt.length > 8000) {
      return res.status(400).json({ ok: false, message: 'Instruksi maksimal 8000 karakter.' });
    }

    const files = req.files || [];
    const totalSize = files.reduce((sum, f) => sum + f.buffer.length, 0);
    if (totalSize > 20 * 1024 * 1024) {
      return res.status(400).json({ ok: false, message: 'Total ukuran seluruh file yang diunggah maksimal 20MB.' });
    }

    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (!user) {
      return res.status(401).json({ ok: false, message: 'Sesi tidak valid.' });
    }

    const userType = computeEffectiveUserType(user);
    if (!isAdminReq(req) && userType !== 'premium' && userType !== 'ultimate') {
      return res.status(403).json({ ok: false, message: 'Fitur Co-Work Agent khusus akun Premium & Ultimate.' });
    }

    // Kuota Co-Work sekarang bagian dari DEEPSEEK POOL bersama (gate biner
    // sebelum panggil, token GLM 5.2 dicatat SETELAH task selesai lewat
    // recordDeepSeekPoolUsage(..., 'cowork') di bawah - lihat komentar besar
    // di atas). Tidak ada lagi kuota bulanan terpisah untuk Co-Work, jadi
    // tidak ada juga yang perlu "dikembalikan" kalau task gagal - beda dari
    // pola lama yang pre-consume 1 hitungan lalu refund di catch block.
    if (!requireDeepSeekPoolAccess(req, res, user)) return;

    // Ekstrak teks tiap file lampiran SEBELUM merespons - kalau ada file yang
    // gagal dibaca, user tahu langsung lewat respons ini (bukan lewat email
    // gagal tanpa konteks nanti).
    const MAX_CONTEXT_CHARS = 60000;
    let attachedContext = '';
    try {
      for (const file of files) {
        if (attachedContext.length >= MAX_CONTEXT_CHARS) break;
        const filename = (file.originalname || '').toLowerCase();
        let text;
        if (filename.endsWith('.csv')) {
          text = file.buffer.toString('utf-8').trim();
          if (!text) throw new Error(`File ${file.originalname} kosong.`);
        } else {
          text = await extractTextFromDocument(file);
        }
        attachedContext += `\n\n=== Dokumen: ${file.originalname} ===\n${text.slice(0, 20000)}`;
      }
      if (attachedContext.length > MAX_CONTEXT_CHARS) {
        attachedContext = attachedContext.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...dipotong karena terlalu panjang...]';
      }
    } catch (extractErr) {
      return res.status(400).json({ ok: false, message: extractErr.message || 'Gagal memproses file lampiran.' });
    }

    const task = {
      id: uuidv4(),
      userId: user.id,
      prompt,
      title: null,
      inputFiles: files.map(f => f.originalname),
      status: 'pending',
      statusLog: 'Menunggu diproses...',
      resultText: null,
      outputFileUrl: null,
      tokensUsed: 0,
      errorMessage: null,
      startedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const tasks = getCoworkTasks();
    tasks.push(task);
    saveCoworkTasks(tasks);

    res.json({ ok: true, taskId: task.id });

    // Eksekusi sungguhan jalan async TANPA await di sini - respons HTTP sudah
    // dikirim di atas supaya browser user tidak menggantung menunggu GLM 5.2
    // yang bisa makan waktu beberapa menit. Progress dipoll lewat
    // GET /api/cowork/status/:id (lihat catatan besar di awal blok ini soal
    // keterbatasan kalau server redeploy di tengah proses).
    (async () => {
      const updateTask = (patch) => {
        const currentTasks = getCoworkTasks();
        const idx = currentTasks.findIndex(t => t.id === task.id);
        if (idx === -1) return;
        Object.assign(currentTasks[idx], patch, { updatedAt: new Date().toISOString() });
        saveCoworkTasks(currentTasks);
      };

      try {
        // startedAt dicatat terpisah dari createdAt - dipakai frontend utk
        // timer elapsed selama proses (lihat renderCoworkHistory di app.js),
        // supaya waktu tunggu di antrean (biasanya nyaris nol di app ini,
        // tapi tetap) tidak ikut ke-hitung sebagai "sedang diproses".
        // statusLog SENGAJA tidak menyebut nama model/vendor AI di baliknya -
        // ditampilkan ke user sebagai brand JurnalHub Co-Work saja.
        updateTask({ status: 'processing', statusLog: 'JurnalHub Co-Work sedang memproses tugas Anda...', startedAt: new Date().toISOString() });
        const { text, tokensUsed } = await callOpenRouterGLM(prompt, attachedContext, buildCustomInstructionsMessage(user));

        // Token GLM 5.2 dikonversi ke token setara-DeepSeek (COWORK_POOL_COST_MULTIPLIER)
        // sebelum masuk DEEPSEEK POOL bersama, ditandai source 'cowork' supaya
        // grafik Usage bisa memisahkannya dari pemakaian fitur DeepSeek langsung.
        recordDeepSeekPoolUsage(user.id, tokensUsed * COWORK_POOL_COST_MULTIPLIER, 'cowork');

        updateTask({ statusLog: 'Menyusun dokumen Word (.docx)...' });
        const children = markdownToDocxChildren(text);
        const doc = new Document({ sections: [{ children }] });
        const buffer = await Packer.toBuffer(doc);
        const title = extractTitleFromMarkdown(text) || prompt;

        fs.mkdirSync(COWORK_OUTPUTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(COWORK_OUTPUTS_DIR, `${task.id}.docx`), buffer);

        updateTask({
          status: 'completed',
          statusLog: 'Selesai.',
          title,
          resultText: text,
          outputFileUrl: `/api/cowork/download/${task.id}`,
          tokensUsed
        });

        const openUrl = `https://jurnalhub.id/?opencowork=${task.id}`;
        const promptSummary = prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a202c;">
            <div style="padding: 1.5rem 0; border-bottom: 2px solid #0787dc;">
              <span style="font-weight: 800; font-size: 1.1rem; color: #0787dc;">JurnalHub</span>
            </div>
            <div style="padding: 1.5rem 0;">
              <h2 style="margin: 0 0 1rem;">Tugas Co-Work Anda telah selesai ditulis!</h2>
              <p style="line-height: 1.6;">Halo${user.name ? ' ' + escapeHtmlServer(user.name) : ''}, agen Co-Work JurnalHub sudah menyelesaikan tugas berikut:</p>
              <p style="background: #f7fafc; border-radius: 8px; padding: 1rem; font-style: italic; color: #4a5568;">"${escapeHtmlServer(promptSummary)}"</p>
              <p style="line-height: 1.6;">Status: <strong>Berhasil</strong> &middot; Format file: <strong>.DOCX</strong></p>
              <div style="text-align: center; margin: 1.5rem 0;">
                <a href="${openUrl}" style="display: inline-block; background: #0787dc; color: #ffffff; padding: 0.75rem 2rem; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 0.9rem;">Buka & Unduh File Word (.docx)</a>
              </div>
              <p style="font-size: 0.85rem; color: #718096;">Catatan: File disimpan aman di dashboard JurnalHub Anda, tab Co-Work.</p>
            </div>
          </div>`;
        await sendMailHelper(user.email, '[JurnalHub] Tugas Co-Work Anda Telah Selesai Ditulis! 📄', emailHtml);
      } catch (taskErr) {
        console.error('[Co-Work Agent] Task gagal:', task.id, taskErr.message);
        updateTask({ status: 'failed', statusLog: 'Gagal.', errorMessage: taskErr.message || 'Terjadi kesalahan saat memproses tugas.' });

        // Tidak ada lagi kuota yang perlu "dikembalikan" - recordDeepSeekPoolUsage
        // hanya dipanggil SETELAH callOpenRouterGLM sukses (di atas), jadi kalau
        // taskErr terjadi SEBELUM itu (mis. GLM gagal total), tidak ada kredit
        // yang sempat terpakai sama sekali.

        try {
          await sendMailHelper(user.email, '[JurnalHub] Tugas Co-Work Anda Gagal Diproses', `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1a202c;"><p>Maaf, tugas Co-Work Anda gagal diproses: ${escapeHtmlServer(taskErr.message || 'Kesalahan tidak diketahui.')}</p><p>Silakan coba lagi lewat dashboard.</p></div>`);
        } catch (mailErr) {
          console.error('[Co-Work Agent] Gagal kirim email notifikasi kegagalan:', mailErr.message);
        }
      }
    })();
  });
});

app.get('/api/cowork/history', requireAccess, (req, res) => {
  const tasks = getCoworkTasks()
    .filter(t => t.userId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => ({
      id: t.id, prompt: t.prompt, title: t.title, inputFiles: t.inputFiles, status: t.status, statusLog: t.statusLog,
      outputFileUrl: t.outputFileUrl, errorMessage: t.errorMessage, startedAt: t.startedAt,
      createdAt: t.createdAt, updatedAt: t.updatedAt
    }));
  res.json({ ok: true, tasks });
});

app.get('/api/cowork/status/:id', requireAccess, (req, res) => {
  const task = getCoworkTasks().find(t => t.id === req.params.id);
  if (!task || (task.userId !== req.session.userId && !isAdminReq(req))) {
    return res.status(404).json({ ok: false, message: 'Task tidak ditemukan.' });
  }
  res.json({ ok: true, task: {
    id: task.id, status: task.status, title: task.title, statusLog: task.statusLog, outputFileUrl: task.outputFileUrl,
    errorMessage: task.errorMessage, startedAt: task.startedAt, createdAt: task.createdAt, updatedAt: task.updatedAt
  }});
});

// Ownership dicek lewat task.userId (bukan cuma requireAccess) - file hasil
// kerja Co-Work adalah dokumen PRIBADI user (beda dari gambar blast yang
// sengaja publik), jadi HARUS login sebagai pemilik task (atau admin) untuk
// bisa mengunduhnya.
app.get('/api/cowork/download/:id', requireAccess, (req, res) => {
  const task = getCoworkTasks().find(t => t.id === req.params.id);
  if (!task || (task.userId !== req.session.userId && !isAdminReq(req))) {
    return res.status(404).json({ ok: false, message: 'Task tidak ditemukan.' });
  }
  if (task.status !== 'completed') {
    return res.status(400).json({ ok: false, message: 'File belum siap diunduh.' });
  }
  const filePath = path.join(COWORK_OUTPUTS_DIR, `${task.id}.docx`);
  // Nama file dari JUDUL hasil (heading H1 pertama dari teks yang dihasilkan
  // GLM, lihat extractTitleFromMarkdown), bukan dari prompt user apa adanya -
  // prompt biasanya berupa instruksi panjang, bukan judul yang pantas jadi
  // nama file. Fallback ke prompt cuma kalau title entah kenapa belum tersimpan
  // (task lama dari sebelum field ini ada).
  const safeFileName = 'CoWork_' + (task.title || task.prompt).slice(0, 60).replace(/[^a-zA-Z0-9]/g, '_') + '.docx';
  res.download(filePath, safeFileName, (err) => {
    if (err && !res.headersSent) res.status(404).json({ ok: false, message: 'File tidak ditemukan di server.' });
  });
});

// Export hasil Co-Work langsung jadi dokumen Notebook baru - reuse jalur
// konversi yang SAMA PERSIS dengan fitur impor .docx manual yang sudah ada
// (POST /api/documents/import-docx, lihat mammoth.convertToHtml di sana),
// cuma sumber buffernya dari file Co-Work yang sudah ada di server (bukan
// upload baru dari user) supaya user tidak perlu unduh lalu unggah ulang
// secara manual - user tinggal lanjut menulis/edit di Notebook begitu saja.
app.post('/api/cowork/task/:id/export-to-notebook', requireAccess, async (req, res) => {
  const task = getCoworkTasks().find(t => t.id === req.params.id);
  if (!task || (task.userId !== req.session.userId && !isAdminReq(req))) {
    return res.status(404).json({ ok: false, message: 'Task tidak ditemukan.' });
  }
  if (task.status !== 'completed') {
    return res.status(400).json({ ok: false, message: 'Tugas belum selesai, belum bisa diekspor.' });
  }
  try {
    const buffer = fs.readFileSync(path.join(COWORK_OUTPUTS_DIR, `${task.id}.docx`));
    const result = await mammoth.convertToHtml({ buffer });
    const html = ((result && result.value) || '').trim();
    if (!html) {
      return res.status(400).json({ ok: false, message: 'Hasil Co-Work tidak berisi konten yang dapat diekspor.' });
    }

    const docTitle = (task.title || task.prompt || 'Untitled').slice(0, 200);
    // Hilangkan heading H1 pertama dari body kalau isinya SAMA PERSIS dgn
    // docTitle (yang memang diekstrak dari heading itu, lihat
    // extractTitleFromMarkdown di worker submit) - dokumen Notebook sudah
    // punya field judul TERPISAH (titleInput), jadi tanpa ini judulnya
    // muncul dobel: sekali di field judul, sekali lagi sebagai baris
    // pertama isi dokumen.
    const h1Match = html.match(/^<h1[^>]*>(.*?)<\/h1>/i);
    const bodyHtml = (h1Match && h1Match[1].replace(/<[^>]+>/g, '').trim() === docTitle.trim())
      ? html.slice(h1Match[0].length).trim()
      : html;

    const docs = getDocuments();
    const now = new Date().toISOString();
    const newDoc = {
      id: uuidv4(),
      userId: req.session.userId,
      title: docTitle,
      contentHtml: bodyHtml.slice(0, 500000),
      createdAt: now,
      updatedAt: now
    };
    docs.push(newDoc);
    saveDocuments(docs);
    res.json({ ok: true, document: newDoc });
  } catch (error) {
    console.error('[Co-Work Export to Notebook] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengekspor hasil ke Notebook.' });
  }
});

// Hapus 1 riwayat task Co-Work milik user sendiri (atau admin). Aman dipanggil
// utk task apapun statusnya (termasuk 'processing') - kalau worker async-nya
// masih jalan di background, updateTask() di dalamnya sudah punya guard
// `if (idx === -1) return;` sendiri, jadi begitu task ini dihapus dari
// cowork-tasks.json, update status berikutnya dari worker itu otomatis
// jadi no-op, tidak error.
app.delete('/api/cowork/task/:id', requireAccess, (req, res) => {
  const tasks = getCoworkTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task || (task.userId !== req.session.userId && !isAdminReq(req))) {
    return res.status(404).json({ ok: false, message: 'Task tidak ditemukan.' });
  }
  const remaining = tasks.filter(t => t.id !== req.params.id);
  saveCoworkTasks(remaining);
  try {
    fs.unlinkSync(path.join(COWORK_OUTPUTS_DIR, `${task.id}.docx`));
  } catch (err) {
    // File mungkin belum pernah dibuat (task belum selesai/gagal) - aman diabaikan.
  }
  res.json({ ok: true });
});

// User Authentication API Endpoints
app.post('/api/register', authLimiter, async (req, res) => {
  const { email, password, redirect } = req.body;

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email dan password wajib diisi.' });
  }

  // Target redirect pasca-verifikasi (mis. dari deep-link jurnalhub.id/campusambassador)
  // divalidasi ketat disini juga - harus path relatif 1 slash, bukan URL absolut/
  // protocol-relative, supaya tidak jadi celah open-redirect lewat body request.
  const safeRedirect = typeof redirect === 'string' && /^\/(?!\/)/.test(redirect) ? redirect : null;

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
    const verificationUrl = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${token}${safeRedirect ? `&redirect=${encodeURIComponent(safeRedirect)}` : ''}`;
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
        if (!Array.isArray(freshUser.activeSessionTokens)) freshUser.activeSessionTokens = [];
        freshUser.activeSessionTokens.push(sessionToken);
        while (freshUser.activeSessionTokens.length > MAX_CONCURRENT_SESSIONS) freshUser.activeSessionTokens.shift();
        delete freshUser.currentSessionToken;
        saveUsers(freshUsers);
      }
    });

    req.session.userId = user.id;
    req.session.userType = user.type || 'free';
    req.session.isAdmin = !!user.isAdmin;
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

  const { redirect } = req.query;
  const safeRedirect = typeof redirect === 'string' && /^\/(?!\/)/.test(redirect) ? redirect : null;
  res.redirect(`/auth.html?verified=true${safeRedirect ? `&redirect=${encodeURIComponent(safeRedirect)}` : ''}`);
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
  if (!Array.isArray(user.activeSessionTokens)) user.activeSessionTokens = [];
  user.activeSessionTokens.push(sessionToken);
  while (user.activeSessionTokens.length > MAX_CONCURRENT_SESSIONS) user.activeSessionTokens.shift();
  delete user.currentSessionToken;
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
    req.session.isAdmin = !!user.isAdmin;
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
    req.session.isAdmin = !!user.isAdmin;
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
      user.activeSessionTokens = (Array.isArray(user.activeSessionTokens) ? user.activeSessionTokens : []).filter(t => t !== req.session.sessionToken);
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

// --- Popup pengumuman fitur baru (tampil sekali per user, permanen setelah
// ditutup) - desain generik lewat ID string, bukan cuma dikhususkan utk
// Co-Work: ganti nilai ini kalau nanti ada pengumuman fitur baru lagi, user
// lama yang sudah dismiss pengumuman LAMA otomatis akan lihat yang BARU
// (ID beda -> belum ada di dismissedAnnouncements mereka), tapi tidak akan
// lihat pengumuman yang SAMA dua kali walau reload berkali-kali.
const CURRENT_ANNOUNCEMENT_ID = 'campus-ambassador-2026-08';

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
    if (user && req.session.isAdmin !== !!user.isAdmin) {
      req.session.isAdmin = !!user.isAdmin;
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
    let isSlrLimitReached = false;
    let slrRemaining = 1;
    let isPatentSearchLimitReached = false;
    let patentSearchRemaining = 1;
    let isPeerReviewLimitReached = false;
    let peerReviewRemaining = 2;
    // Cari Referensi - Free dijatah 5x/bulan, Premium & Ultimate unlimited
    let isCariReferensiLimitReached = false;
    let cariReferensiRemaining = 5;
    let isCitationGraphLimitReached = false;
    let citationGraphRemaining = 5;
    // Notebook AI Continue Writing - Free 10x/bulan, Premium 50x/bulan, Ultimate unlimited
    let isNotebookContinueLimitReached = false;
    let notebookContinueRemaining = 10;

    const userType = req.session.userType || 'free';
    const isFree = userType === 'free';
    const isPremium = userType === 'premium';
    const isUltimate = userType === 'ultimate';

    // Patent Search, Cari Referensi, Citation Graph, dan Humanizer BUKAN
    // panggilan DeepSeek/LLM (API eksternal terpisah dengan biaya/rate-limit
    // sendiri) jadi TETAP pakai kuota bulanan asli per-tier disini - beda
    // dari Draft/Lit Review/SLR/Peer Review/Research Chat/Notebook Continue/
    // Match yang sudah pindah total ke DEEPSEEK POOL (lihat blok di bawah).
    if (isFree && user) {
      const currentMonth = new Date().toISOString().slice(0, 7);
      isHumanizerLimitReached = true;
      humanizerWordsRemaining = 0;
      humanizerWordsLimit = 0;

      isPatentSearchLimitReached = (user.lastPatentSearchMonth === currentMonth) && (user.patentSearchCountThisMonth >= 1);
      patentSearchRemaining = Math.max(0, 1 - (user.lastPatentSearchMonth === currentMonth ? user.patentSearchCountThisMonth : 0));

      isCitationGraphLimitReached = (user.lastCitationGraphMonth === currentMonth) && (user.citationGraphCountThisMonth >= 5);
      citationGraphRemaining = Math.max(0, 5 - (user.lastCitationGraphMonth === currentMonth ? user.citationGraphCountThisMonth : 0));

      isCariReferensiLimitReached = (user.lastCariReferensiMonth === currentMonth) && (user.cariReferensiCountThisMonth >= 5);
      cariReferensiRemaining = Math.max(0, 5 - (user.lastCariReferensiMonth === currentMonth ? user.cariReferensiCountThisMonth : 0));
    } else if (isPremium && user) {
      const currentMonth = new Date().toISOString().slice(0, 7);
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

      isPatentSearchLimitReached = (user.lastPatentSearchMonth === currentMonth) && (user.patentSearchCountThisMonth >= 5);
      patentSearchRemaining = Math.max(0, 5 - (user.lastPatentSearchMonth === currentMonth ? user.patentSearchCountThisMonth : 0));

      isCitationGraphLimitReached = (user.lastCitationGraphMonth === currentMonth) && (user.citationGraphCountThisMonth >= 20);
      citationGraphRemaining = Math.max(0, 20 - (user.lastCitationGraphMonth === currentMonth ? user.citationGraphCountThisMonth : 0));

      isCariReferensiLimitReached = false;
      cariReferensiRemaining = 999;
    } else {
      isPatentSearchLimitReached = false;
      patentSearchRemaining = 20;
      isCariReferensiLimitReached = false;
      cariReferensiRemaining = 999;
      isCitationGraphLimitReached = false;
      citationGraphRemaining = 100;

      if (user) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        isPatentSearchLimitReached = (user.lastPatentSearchMonth === currentMonth) && (user.patentSearchCountThisMonth >= 20);
        patentSearchRemaining = Math.max(0, 20 - (user.lastPatentSearchMonth === currentMonth ? user.patentSearchCountThisMonth : 0));
        isCitationGraphLimitReached = (user.lastCitationGraphMonth === currentMonth) && (user.citationGraphCountThisMonth >= 100);
        citationGraphRemaining = Math.max(0, 100 - (user.lastCitationGraphMonth === currentMonth ? user.citationGraphCountThisMonth : 0));
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

    // Draft/Outline Generator, Lit Review, SLR, Peer Review, JurnalHub
    // Intelligence (Research Chat), Notebook Continue Writing, dan AI Match -
    // semuanya panggilan DeepSeek, jadi dijatah lewat DEEPSEEK POOL bersama
    // (kredit/minggu), BUKAN kuota bulanan per-fitur lagi. Nama field lama
    // TETAP dipertahankan (dipakai banyak tempat di frontend untuk badge/
    // lock icon) supaya UI existing tidak perlu diubah, cuma sumber datanya
    // yang sekarang jadi pool bersama.
    const deepseekPoolStatus = getDeepSeekPoolStatus(user);
    if (user) {
      const poolOk = hasDeepSeekPoolAccess(user);
      isLimitReached = !poolOk;
      isDraftLimitReached = !poolOk;
      draftsRemaining = poolOk ? (isFree ? 3 : (isPremium ? 15 : 999)) : 0;
      isLitReviewLimitReached = !poolOk;
      litReviewsRemaining = poolOk ? (isFree ? 3 : (isPremium ? 15 : 999)) : 0;
      isSlrLimitReached = !poolOk;
      slrRemaining = poolOk ? (isFree ? 1 : (isPremium ? 5 : 999)) : 0;
      isPeerReviewLimitReached = !poolOk;
      peerReviewRemaining = poolOk ? (isFree ? 2 : (isPremium ? 15 : 999)) : 0;
      isResearchChatLimitReached = !poolOk;
      researchChatsRemaining = poolOk ? (isFree ? 20 : 999) : 0;
      researchChatLimit = isFree ? 20 : 999;
      isNotebookContinueLimitReached = !poolOk;
      notebookContinueRemaining = poolOk ? (isFree ? 10 : (isPremium ? 50 : 999)) : 0;
    }

    // Admin: timpa SEMUA flag "limit reached" jadi false & tampilkan angka
    // "sisa" yang jelas-jelas besar (bukan cuma bypass di titik generate-nya
    // saja) - supaya badge kuota di UI juga tidak nunjukin "hampir habis" ke
    // admin. Pengecekan kuota SESUNGGUHNYA (yang menolak request) ada di
    // masing-masing endpoint AI, lihat req.session.isAdmin di situ.
    if (req.session.isAdmin) {
      isLimitReached = false;
      isDraftLimitReached = false; draftsRemaining = 999999;
      isLitReviewLimitReached = false; litReviewsRemaining = 999999;
      isHumanizerLimitReached = false; humanizerWordsRemaining = 999999; humanizerWordsLimit = 999999;
      isResearchChatLimitReached = false; researchChatsRemaining = 999999; researchChatLimit = 999999;
      isSlrLimitReached = false; slrRemaining = 999999;
      isPatentSearchLimitReached = false; patentSearchRemaining = 999999;
      isPeerReviewLimitReached = false; peerReviewRemaining = 999999;
      isCariReferensiLimitReached = false; cariReferensiRemaining = 999999;
      isCitationGraphLimitReached = false; citationGraphRemaining = 999999;
      isNotebookContinueLimitReached = false; notebookContinueRemaining = 999999;
    }

    res.json({
      loggedIn: true,
      user: {
        email: req.session.email || 'Premium User',
        type: req.session.userType,
        isAdmin: !!req.session.isAdmin,
        name: user ? (user.name || '') : '',
        faculty: user ? (user.faculty || '') : '',
        university: user ? (user.university || '') : '',
        profilePic: user ? (user.profilePic || '') : '',
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
        isSlrLimitReached: isSlrLimitReached,
        slrRemaining: slrRemaining,
        patentSearchCountThisMonth: user ? (user.patentSearchCountThisMonth || 0) : 0,
        isPatentSearchLimitReached: isPatentSearchLimitReached,
        patentSearchRemaining: patentSearchRemaining,
        isPeerReviewLimitReached: isPeerReviewLimitReached,
        peerReviewRemaining: peerReviewRemaining,
        citationGraphCountThisMonth: user ? (user.citationGraphCountThisMonth || 0) : 0,
        isCitationGraphLimitReached: isCitationGraphLimitReached,
        citationGraphRemaining: citationGraphRemaining,
        cariReferensiCountThisMonth: user ? (user.cariReferensiCountThisMonth || 0) : 0,
        isCariReferensiLimitReached: isCariReferensiLimitReached,
        cariReferensiRemaining: cariReferensiRemaining,
        isNotebookContinueLimitReached: isNotebookContinueLimitReached,
        notebookContinueRemaining: notebookContinueRemaining,
        isResearchChatLimitReached: isResearchChatLimitReached,
        researchChatsRemaining: researchChatsRemaining,
        researchChatLimit: researchChatLimit,
        planId: user ? (user.planId || null) : null,
        paymentExpiredAt: user ? (user.paymentExpiredAt || null) : null,
        hasPassword: user ? !!user.password : false,
        shouldShowAnnouncement: (user && !(Array.isArray(user.dismissedAnnouncements) && user.dismissedAnnouncements.includes(CURRENT_ANNOUNCEMENT_ID)))
          ? CURRENT_ANNOUNCEMENT_ID
          : null,
        customInstructions: user ? (user.customInstructions || '') : '',
        deepseekPool: {
          usedCredits: Math.round(deepseekPoolStatus.usedTokens / DEEPSEEK_CREDIT_TOKEN_SIZE),
          limitCredits: Math.round(deepseekPoolStatus.limitTokens / DEEPSEEK_CREDIT_TOKEN_SIZE),
          weekStart: deepseekPoolStatus.weekStart
        }
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// Detail pemakaian DEEPSEEK POOL bersama (kredit/minggu) buat grafik "Usage"
// di Pengaturan, mirip halaman usage Claude - dipisah dari /api/me (yang cuma
// kirim ringkasan usedCredits/limitCredits) supaya breakdown harian tidak
// perlu selalu ikut terkirim di tiap panggilan /api/me.
app.get('/api/usage', requireAccess, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const status = getDeepSeekPoolStatus(user);

  const weekStartDate = new Date(status.weekStart + 'T00:00:00Z');
  const resetsAt = new Date(weekStartDate.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // 30 hari terakhir TERMASUK hari tanpa pemakaian (0 kredit) supaya bar
  // chart-nya berurutan rapi, bukan cuma tanggal yang kebetulan ada datanya.
  // directCredits = JurnalHub Intelligence dkk, coworkCredits = Co-Work Agent
  // (sudah dikonversi ke token setara-DeepSeek) - dipisah biar user tahu
  // penyebab kuotanya kepakai, walau limitnya 1 pool bersama.
  const days = [];
  for (let i = DEEPSEEK_POOL_HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const entry = status.dailyUsage[dateStr] || { direct: 0, cowork: 0 };
    const directCredits = Math.round((entry.direct / DEEPSEEK_CREDIT_TOKEN_SIZE) * 10) / 10;
    const coworkCredits = Math.round((entry.cowork / DEEPSEEK_CREDIT_TOKEN_SIZE) * 10) / 10;
    days.push({ date: dateStr, directCredits, coworkCredits, credits: Math.round((directCredits + coworkCredits) * 10) / 10 });
  }

  res.json({
    ok: true,
    tier: (user && user.type) || 'free',
    weekStart: status.weekStart,
    resetsAt,
    usedCredits: Math.round((status.usedTokens / DEEPSEEK_CREDIT_TOKEN_SIZE) * 10) / 10,
    limitCredits: Math.round(status.limitTokens / DEEPSEEK_CREDIT_TOKEN_SIZE),
    dailyUsage: days
  });
});

// Tandai 1 pengumuman sudah ditutup user - permanen (tidak akan muncul lagi
// utk user ini walau login ulang), tersimpan per-user di users.json, bukan
// sekadar localStorage di browser (supaya konsisten lintas device/browser).
app.post('/api/announcements/dismiss', requireAccess, (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  if (!id) {
    return res.status(400).json({ ok: false, message: 'ID pengumuman wajib diisi.' });
  }
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) {
    return res.status(401).json({ ok: false, message: 'Sesi tidak valid.' });
  }
  if (!Array.isArray(user.dismissedAnnouncements)) {
    user.dismissedAnnouncements = [];
  }
  if (!user.dismissedAnnouncements.includes(id)) {
    user.dismissedAnnouncements.push(id);
    saveUsers(users);
  }
  res.json({ ok: true });
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

// Hapus akun secara permanen (hak "right to erasure" UU PDP/GDPR) - dipanggil dari
// menu Pengaturan > Zona Berbahaya. Sebelum menghapus, identitas user diverifikasi
// dulu: pakai password kalau dia akun email/password biasa, atau ketik ulang email
// kalau dia akun Google (tidak ada password lokal untuk diverifikasi). Menghapus
// data user dari users.json serta seluruh riwayat transaksi & percakapan AI yang
// tertaut ke akun tsb, lalu menghancurkan sesi supaya langsung logout.
app.post('/api/account/delete', requireAccess, async (req, res) => {
  const { password, confirmEmail } = req.body;

  const users = getUsers();
  const userIndex = users.findIndex(u => u.id === req.session.userId);
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, message: 'User tidak ditemukan.' });
  }
  const user = users[userIndex];

  if (user.password) {
    if (!password) {
      return res.status(400).json({ ok: false, message: 'Masukkan kata sandi Anda untuk konfirmasi.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'Kata sandi salah.' });
    }
  } else {
    // Akun Google - tidak ada password lokal, verifikasi lewat ketik ulang email terdaftar.
    if (!confirmEmail || String(confirmEmail).trim().toLowerCase() !== String(user.email).trim().toLowerCase()) {
      return res.status(400).json({ ok: false, message: 'Email konfirmasi tidak cocok dengan email akun Anda.' });
    }
  }

  users.splice(userIndex, 1);
  saveUsers(users);

  try {
    const transactions = getTransactions().filter(t => t.userId !== user.id);
    saveTransactions(transactions);
  } catch (err) {
    console.error('[Account Delete] Gagal membersihkan transactions.json (diabaikan):', err.message);
  }

  try {
    const conversations = getResearchChatConversations().filter(c => c.userId !== user.id);
    saveResearchChatConversations(conversations);
  } catch (err) {
    console.error('[Account Delete] Gagal membersihkan research-chat-conversations.json (diabaikan):', err.message);
  }

  try {
    const researches = getSavedResearches().filter(r => r.userId !== user.id);
    saveSavedResearches(researches);
    const references = getSavedReferences().filter(ref => ref.userId !== user.id);
    saveSavedReferences(references);
    const folderChats = getFolderChats().filter(c => c.userId !== user.id);
    saveFolderChats(folderChats);
    const documents = getDocuments().filter(d => d.userId !== user.id);
    saveDocuments(documents);
  } catch (err) {
    console.error('[Account Delete] Gagal membersihkan saved-references.json (diabaikan):', err.message);
  }

  req.session.destroy(() => {
    res.clearCookie(ACCESS_COOKIE);
    res.json({ ok: true, message: 'Akun Anda telah dihapus secara permanen.' });
  });
});

// Endpoint untuk memperbarui profil pengguna
app.post('/api/update-profile', requireAccess, (req, res) => {
  const { name, faculty, university, profilePic, customInstructions } = req.body;

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
  // Instruksi kustom user - disuntikkan sbg system message tambahan di
  // JurnalHub Intelligence & Co-Work Agent (lihat buildCustomInstructionsMessage),
  // mirip fitur "Instructions for Claude" - dibatasi 3000 karakter, wajar utk
  // preferensi gaya/aturan penulisan, bukan dokumen panjang (itu fungsinya
  // lampiran dokumen, bukan field ini).
  if (customInstructions !== undefined) user.customInstructions = String(customInstructions).trim().slice(0, 3000);

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
      customInstructions: user.customInstructions || ''
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

  const systemPrompt = `You are a journal recommendation API for JurnalHub. You MUST respond with ONLY valid JSON (no markdown, no text outside JSON). Return an object with exactly two fields: "review" (max 2 short sentences analyzing the article, in Indonesian) and "recommendations" (an array of exactly 3 journal matches chosen from the candidate list given by the user). Each recommendation must be {"id": <candidate id, copy exactly as given, keep as string or number matching the input>, "matchScore": <integer 70-98>, "reason": "<short reason in Indonesian, max 15 words>"}. Keep every string value SHORT and NEVER use double-quote characters inside string values (use plain text or single quotes instead) - this is critical because embedded double quotes break JSON parsing.`;

  const userContent = `Analisis artikel ini dan pilih tepat 3 jurnal paling cocok dari daftar kandidat berdasarkan judul, keyword/bidang, abstrak, scope jurnal, rank, dan biaya.\n\nArtikel:\nJudul: ${articleTitle || '-'}\nKeyword/Bidang: ${articleKeywords || '-'}\nAbstrak: ${articleAbstract || '-'}\n\nKandidat jurnal:\n${JSON.stringify(candidates)}\n\nBalas dengan JSON object persis: {"review": "<2-3 kalimat analisis artikel dalam Bahasa Indonesia>", "recommendations": [{"id": <id>, "matchScore": <70-98>, "reason": "<alasan singkat>"}]}`;

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

  let parsed;
  try {
    parsed = cleanAndParseAIResponse(content, true);
  } catch (parseError) {
    console.error('[Match Score DeepSeek] Gagal parse JSON, raw content:', content.slice(0, 1500));
    throw parseError;
  }
  return { review: parsed.review || null, items: parsed.recommendations || [], usage: resData.usage || null };
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

  // Match pakai DeepSeek POOL bersama - kalau kuota mingguan habis, DEGRADE ke
  // fallback Claude/Gemini/lokal (bukan diblokir keras) karena Match sudah
  // punya jalur fallback bawaan dan biayanya relatif kecil dibanding fitur lain.
  const hasDeepSeekKey = !!getDeepSeekApiKey() && (isAdminReq(req) || !user || hasDeepSeekPoolAccess(user));
  const hasClaudeKey = !!process.env.ANTHROPIC_API_KEY;
  const hasApiKey = !!process.env.GEMINI_API_KEY;
  const hasVertex = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

  if (!hasDeepSeekKey && !hasClaudeKey && !hasApiKey && !hasVertex) {
    const recommendations = localFallbackRecommendations();
    const poolExhausted = !!getDeepSeekApiKey() && user && !isAdminReq(req) && !hasDeepSeekPoolAccess(user);

    addHistoryItem(req.session.userId, 'match', { title: articleTitle, keywords: articleKeywords, abstract: articleAbstract }, { recommendations, review: null });

    res.json({
      ok: true,
      source: 'local',
      warning: poolExhausted
        ? 'Kuota mingguan JurnalHub Intelligence Anda sudah habis. Menggunakan kalkulasi kecocokan lokal.'
        : 'Kredensial DeepSeek (DEEPSEEK_API_KEY), Claude, atau Gemini belum dikonfigurasi. Menggunakan kalkulasi kecocokan lokal.',
      recommendations: recommendations
    });
    return;
  }

  try {
    // DeepSeek jadi provider utama (konsisten dengan fitur AI lain di JurnalHub);
    // Claude/Gemini tetap jadi fallback kalau DeepSeek belum diset/kuota pool habis.
    const aiResult = hasDeepSeekKey
      ? await getDeepSeekJournalRecommendations(articleTitle, articleKeywords, articleAbstract, candidates)
      : await getGeminiRecommendations(articleTitle, articleKeywords, articleAbstract, candidates);
    const aiItems = Array.isArray(aiResult) ? aiResult : (aiResult.items || aiResult);
    const review = aiResult?.review || null;
    const recommendations = normalizeAiRecommendations(aiItems, candidates);
    const sourceName = hasDeepSeekKey ? 'deepseek' : (hasClaudeKey ? 'claude' : 'gemini');

    if (hasDeepSeekKey && user) recordDeepSeekPoolUsage(user.id, aiResult?.usage?.total_tokens);

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

  // Draft/Outline Generator dipindah dari Claude ke DeepSeek supaya biayanya
  // ikut masuk DEEPSEEK POOL bersama (kredit/minggu) alih-alih kuota bulanan
  // kaku 3x/15x per fitur - lihat requireDeepSeekPoolAccess.
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
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
    const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

    const segmentDescriptions = docConfig.segments.map(s => `- "${s.key}" (${s.label}): ${s.description}`).join('\n');
    const jsonExample = docConfig.segments.map(s => `"${s.key}": ["point 1", "point 2"]`).join(', ');

    const response = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 4000,
        stream: false,
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages: [
          {
            role: 'system',
            content: `You are an expert academic writing advisor for Indonesian ${docConfig.label}. Based on the title and abstract provided, generate a highly structured outline of what the author must write in each segment of their manuscript. Here are the segments and what each one must cover:\n${segmentDescriptions}\n\nFor each segment, provide 3-4 specific, concrete, and highly customized points tailored directly to their research topic (do NOT output generic writing tips). Keep each point to ONE short sentence (max ~20 words) - conciseness matters more than exhaustiveness. Respond with ONLY a valid JSON object with exactly these keys: {${jsonExample}}. No markdown, no explanation, no text outside the JSON object.`
          },
          {
            role: 'user',
            content: `Analisis judul dan abstrak berikut, lalu buat panduan outline pembahasan untuk masing-masing bagian ${docConfig.label}.\n\nJudul: ${title}\nAbstrak: ${abstract}\n\nBalas dengan JSON object persis seperti spesifikasi (tanpa penjelasan teks):`
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`DeepSeek API Error Status: ${response.status} - ${errText}`);
    }

    const resData = await response.json();
    const choice = resData?.choices?.[0];
    let rawText = choice?.message?.content?.trim();
    if (!rawText && choice?.message?.reasoning_content) {
      rawText = String(choice.message.reasoning_content).trim();
    }
    if (!rawText) {
      throw new Error('Respons AI kosong.');
    }
    let parsed;
    try {
      parsed = cleanAndParseAIResponse(rawText, true);
    } catch (parseError) {
      console.error('[AI Draft Generator] Gagal parse JSON, raw text:', rawText.slice(0, 2000));
      throw parseError;
    }

    if (user) recordDeepSeekPoolUsage(user.id, resData?.usage?.total_tokens);

    addHistoryItem(req.session.userId, 'draft', { title, abstract, docType }, { draft: parsed, docType });

    res.json({
      ok: true,
      source: 'deepseek',
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
  const userType = (user && user.type) || 'free';
  if (!isAdminReq(req) && userType !== 'ultimate') {
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

// Index peringkat jurnal SCImago (SJR quartile Q1-Q4), dibangun dari CSV resmi
// scimagojr.com lewat scripts/build-scimago-index.js. OpenAlex sendiri tidak
// punya field quartile, jadi di-lookup dari ISSN yang OpenAlex kembalikan.
let scimagoIndexCache = null;
function getScimagoIndex() {
  if (!scimagoIndexCache) {
    try {
      scimagoIndexCache = require(path.join(__dirname, 'data-static', 'scimago-quartiles.json'));
    } catch (e) {
      scimagoIndexCache = {};
    }
  }
  return scimagoIndexCache;
}

function lookupJournalQuartile(source) {
  if (!source) return null;
  const index = getScimagoIndex();
  const candidates = [source.issn_l, ...(Array.isArray(source.issn) ? source.issn : [])];
  for (const raw of candidates) {
    const key = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (key && index[key]) return index[key];
  }
  return null;
}

// Ambil kode negara (ISO 3166-1 alpha-2) afiliasi penulis pertama yang punya
// data institusi - dipakai untuk badge "negara afiliasi penulis" di kartu hasil.
function extractAuthorCountryCode(authorships) {
  if (!Array.isArray(authorships)) return null;
  for (const a of authorships) {
    const inst = Array.isArray(a.institutions) ? a.institutions.find(i => i.country_code) : null;
    if (inst) return inst.country_code;
  }
  return null;
}

async function searchOpenAlexWorks(query, perPage, extraFilter, sort, timeoutMs) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  // "?" dan "*" dianggap wildcard oleh OpenAlex full-text search dan bikin request
  // 400 kalau dipakai di luar mode search.exact - buang dulu supaya pertanyaan user
  // yang natural (mis. berakhiran "?") tidak bikin pencarian gagal total. Query di
  // sini SUDAH mendukung sintaks boolean (AND/OR/NOT, tanda kutip untuk frasa persis)
  // secara native lewat parameter "search" OpenAlex - tidak perlu parser tambahan.
  const cleanQuery = String(query || '').replace(/[?*]/g, ' ').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({
    per_page: String(perPage),
    filter: `has_abstract:true${extraFilter || ''}`,
    select: 'id,doi,title,abstract_inverted_index,publication_year,cited_by_count,primary_location,authorships,open_access,biblio'
  });
  // Query kosong (mis. mode pencarian author, yang query utamanya sudah
  // dipindah ke filter raw_author_name.search) - jangan kirim param "search"
  // sama sekali, biar tidak match-all/salah relevance di OpenAlex.
  if (cleanQuery) params.set('search', cleanQuery);
  // Tanpa sort, OpenAlex urutkan berdasarkan relevance_score (default saat ada
  // parameter "search") - itu sudah pas untuk opsi "Relevansi", jadi cukup
  // set param sort kalau user pilih opsi lain (Terbaru/Sitasi/Abjad).
  if (sort) params.set('sort', sort);
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const mailto = process.env.OPENALEX_MAILTO;
  if (mailto) params.set('mailto', mailto);

  const openAlexBase = process.env.OPENALEX_API_BASE || 'https://api.openalex.org';
  // Timeout wajib - tanpa ini, OpenAlex yang lambat/hang bisa membuat pemanggil
  // yang butuh respons cepat (mis. konteks sitasi JurnalHub Intelligence) ikut
  // nge-freeze tanpa batas waktu.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs || 15000);
  let response;
  try {
    response = await fetchFn(`${openAlexBase}/works?${params.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAlex API Error: ${response.status} - ${errText}`);
  }
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  return results
    .map(w => formatOpenAlexWork(w, { requireAbstract: true }))
    .filter(Boolean);
}

// Ubah 1 object "work" mentah dari OpenAlex jadi shape paper yang dipakai di
// seluruh app - dipisah dari searchOpenAlexWorks supaya bisa dipakai juga
// utk lookup SATU paper by DOI (lihat fetchOpenAlexWorkByDoi), bukan cuma
// hasil pencarian. requireAbstract:true (dipakai utk hasil pencarian, biar AI
// selalu punya bahan sintesis) vs false (dipakai utk lookup kartu sitasi
// on-demand - paper tanpa abstrak tetap valid ditampilkan, cuma bagian
// abstraknya kosong).
function formatOpenAlexWork(w, opts) {
  const abstract = reconstructAbstractFromInvertedIndex(w.abstract_inverted_index) || '';
  if (opts && opts.requireAbstract && !abstract) return null;
  const authorNames = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
  const authors = authorNames.length > 3
    ? `${authorNames.slice(0, 3).join(', ')}, et al.`
    : authorNames.join(', ') || 'Tidak diketahui';
  const doi = w.doi ? String(w.doi).replace('https://doi.org/', '') : null;
  const scimago = lookupJournalQuartile(w.primary_location?.source);
  return {
    title: w.title || 'Tanpa judul',
    authors,
    // Daftar nama penulis MENTAH (belum dipotong/digabung jadi string tampilan
    // seperti "authors" di atas) - dibutuhkan buat menyusun sitasi APA 7 yang
    // benar (format "Nama Belakang, I." per penulis, bukan "Nama Depan Nama Belakang").
    authorNames,
    journal: w.primary_location?.source?.display_name || '-',
    year: w.publication_year ? String(w.publication_year) : '-',
    // Detail bibliografi (volume/issue/halaman) - dari field "biblio" OpenAlex,
    // dipakai buat menyusun entri Daftar Pustaka APA 7 yang lebih lengkap.
    volume: w.biblio?.volume || null,
    issue: w.biblio?.issue || null,
    firstPage: w.biblio?.first_page || null,
    lastPage: w.biblio?.last_page || null,
    doi,
    url: w.doi || w.primary_location?.landing_page_url || '#',
    citedByCount: w.cited_by_count || 0,
    isOpenAccess: !!w.open_access?.is_oa,
    journalQuartile: scimago ? scimago.quartile : null,
    authorCountry: extractAuthorCountryCode(w.authorships),
    pdfUrl: w.open_access?.oa_url || null,
    abstract: abstract.slice(0, 800)
  };
}

// Ambil metadata SATU paper by DOI - dipakai kartu preview sitasi Notebook yang
// di-load "malas" (lazy) saat marker sitasi diklik, BUKAN disimpan permanen di
// dalam dokumen - supaya dokumen tetap ringan (cuma nyimpan link <a href>) dan
// datanya selalu diambil langsung dari OpenAlex saat dibutuhkan.
async function fetchOpenAlexWorkByDoi(doi) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const openAlexBase = process.env.OPENALEX_API_BASE || 'https://api.openalex.org';
  const params = new URLSearchParams({
    select: 'id,doi,title,abstract_inverted_index,publication_year,cited_by_count,primary_location,authorships,open_access,biblio'
  });
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const mailto = process.env.OPENALEX_MAILTO;
  if (mailto) params.set('mailto', mailto);

  // OpenAlex mendukung lookup by ID lewat path literal "works/https://doi.org/..."
  // (DOI-nya TIDAK di-URL-encode - itu memang formatnya, lihat dokumentasi
  // OpenAlex soal ID-based lookup).
  const response = await fetchFn(`${openAlexBase}/works/https://doi.org/${doi}?${params.toString()}`);
  if (!response.ok) return null;
  const w = await response.json();
  return formatOpenAlexWork(w, { requireAbstract: false });
}

// --- Formatter APA 7th Edition (dipakai fitur AI Notebook, lihat searchApaAcademicContext) ---
// OpenAlex hanya menyediakan "display_name" gabungan per penulis (mis. "John A.
// Smith"), bukan field given/family terpisah - heuristiknya: kata TERAKHIR
// dianggap nama keluarga, sisanya jadi inisial. Tidak sempurna untuk nama
// majemuk budaya tertentu, tapi ini pendekatan yang sama dipakai kebanyakan
// tool sitasi (Zotero/EndNote dsb) saat parsing nama dari metadata semacam ini.
function formatApaAuthorName(displayName) {
  const parts = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const family = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => p.charAt(0).toUpperCase() + '.').join(' ');
  return `${family}, ${initials}`;
}

// Daftar penulis lengkap ala APA 7 buat entri Daftar Pustaka: "&" sebelum nama
// terakhir untuk <=20 penulis; >20 penulis pakai 19 nama pertama + "..." + nama
// terakhir (aturan APA 7 utk penulis sangat banyak).
function formatApaAuthorList(authorNames) {
  const formatted = (authorNames || []).map(formatApaAuthorName).filter(Boolean);
  if (formatted.length === 0) return 'Tidak diketahui';
  if (formatted.length === 1) return formatted[0];
  if (formatted.length <= 20) {
    return formatted.slice(0, -1).join(', ') + ', & ' + formatted[formatted.length - 1];
  }
  return formatted.slice(0, 19).join(', ') + ', ... ' + formatted[formatted.length - 1];
}

// Sitasi dalam-teks ala APA 7: 1 penulis "Smith", 2 penulis "Smith & Jones",
// 3+ penulis "Smith et al." (aturan APA 7 menyederhanakan ambang "et al." jadi
// 3+ untuk SEMUA kemunculan, beda dari APA 6 yang beda aturan kemunculan pertama/berikutnya).
function formatApaInTextAuthors(authorNames) {
  const families = (authorNames || []).map(n => {
    const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }).filter(Boolean);
  if (families.length === 0) return 'Tidak diketahui';
  if (families.length === 1) return families[0];
  if (families.length === 2) return `${families[0]} & ${families[1]}`;
  return `${families[0]} et al.`;
}

// Susun 1 entri lengkap Daftar Pustaka APA 7 dari metadata paper OpenAlex asli
// (bukan hasil karangan AI) - format: Penulis (Tahun). Judul. Jurnal, Vol(Isu),
// halaman. https://doi.org/xxx - bagian yang datanya tidak tersedia dilewati.
function formatApaReference(paper) {
  const authorsPart = formatApaAuthorList(paper.authorNames);
  const yearPart = paper.year && paper.year !== '-' ? `(${paper.year})` : '(n.d.)';
  const titlePart = paper.title || 'Tanpa judul';
  let journalPart = '';
  if (paper.journal && paper.journal !== '-') {
    journalPart = paper.journal;
    if (paper.volume) {
      journalPart += `, ${paper.volume}`;
      if (paper.issue) journalPart += `(${paper.issue})`;
    }
    if (paper.firstPage) {
      journalPart += paper.lastPage ? `, ${paper.firstPage}-${paper.lastPage}` : `, ${paper.firstPage}`;
    }
    journalPart += '.';
  }
  const doiPart = paper.doi ? `https://doi.org/${paper.doi}` : (paper.url && paper.url !== '#' ? paper.url : '');
  return [`${authorsPart} ${yearPart}. ${titlePart}.`, journalPart, doiPart].filter(Boolean).join(' ').trim();
}

// Cari paper ASLI di OpenAlex yang relevan dengan topik naskah Notebook, lalu
// siapkan (1) instruksi sitasi utk system prompt DeepSeek yang mewajibkan
// sitasi dalam-teks APA 7 HANYA dari paper ini (larang mengarang), dan (2)
// daftar string referensi APA 7 lengkap yang sudah diformat siap tampil -
// bukan diminta AI yang menyusun formatnya sendiri, supaya formatnya selalu
// benar & datanya selalu bisa diverifikasi (tidak rawan halusinasi APA-nya).
async function searchApaAcademicContext(query, perPage) {
  if (!query) return null;
  try {
    const papers = await searchOpenAlexWorks(query, perPage || 6);
    if (!papers || papers.length === 0) return null;
    const top = [...papers].sort((a, b) => b.citedByCount - a.citedByCount).slice(0, 5);

    const entries = top.map(p => ({
      inText: `(${formatApaInTextAuthors(p.authorNames)}, ${p.year})`,
      reference: formatApaReference(p),
      // Metadata lengkap (bukan cuma string referensi) - dipakai frontend utk
      // kartu preview sitasi yang bisa diklik, format sama persis dengan
      // citations Lit Review/JurnalHub Intelligence supaya bisa pakai komponen
      // popover yang sama.
      citation: {
        title: p.title,
        authors: p.authors,
        journal: p.journal,
        year: p.year,
        url: p.url,
        doi: p.doi || null,
        citedByCount: p.citedByCount,
        isOpenAccess: p.isOpenAccess,
        pdfUrl: p.pdfUrl || null,
        abstract: p.abstract ? p.abstract.slice(0, 280) : ''
      }
    }));

    const listText = entries.map((e, i) => `${i + 1}. Sitasi dalam teks: ${e.inText}\n   Entri Daftar Pustaka: ${e.reference}`).join('\n');
    const contextText = `Berikut paper ilmiah ASLI dari OpenAlex yang relevan dengan topik naskah ini. Kalau ada klaim di tulisanmu yang benar-benar didukung salah satu paper ini, WAJIB sisipkan sitasi dalam-teks APA 7th edition PERSIS seperti tertulis di depan tiap paper di bawah (contoh: (Smith & Jones, 2021)), taruh tepat setelah klausa/kalimat yang didukung. JANGAN mengarang paper, penulis, atau sitasi lain di luar daftar ini. JANGAN menuliskan Daftar Pustaka/References sendiri di akhir teks - itu akan ditambahkan otomatis oleh sistem secara terpisah. Kalau tidak ada paper di daftar ini yang benar-benar relevan untuk mendukung suatu klaim, JANGAN paksa mengutip - tulis bagian itu tanpa sitasi seperti biasa:\n\n${listText}`;

    return { contextText, entries };
  } catch (error) {
    console.warn('[Notebook APA Search] Gagal ambil konteks OpenAlex (diabaikan):', error.message);
    return null;
  }
}

// Susun entri sitasi APA (in-text + Daftar Pustaka + href kartu preview) dari
// SATU saved-reference (Koleksi Saya) - dipakai baik oleh buildApaContextFromCollection
// (grounding AI) maupun endpoint GET /api/my-references (panel referensi di
// editor Notebook - klik "Sisipkan" langsung pakai field ini, tanpa AI sama
// sekali). Satu-satunya tempat "authors" (string gabungan display_name, mis.
// "Nama Satu, Nama Dua, et al.") diparse balik jadi array nama penulis -
// literal "et al." dibuang supaya tidak ikut dianggap nama penulis oleh
// formatApaInTextAuthors/formatApaAuthorList (fungsi itu sendiri yang
// menentukan kapan menambahkan "et al." berdasarkan panjang array).
function buildApaEntryFromSavedReference(r) {
  const authorNames = String(r.authors || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s && s.toLowerCase() !== 'et al.');
  return {
    inText: `(${formatApaInTextAuthors(authorNames)}, ${r.year || 'n.d.'})`,
    reference: formatApaReference({
      authorNames,
      year: r.year,
      title: r.title,
      journal: r.journal,
      doi: r.doi,
      url: r.url
    }),
    // href buat <a> yang disisip ke dokumen - DOI diutamakan (biar kartu
    // preview sitasi bisa di-load lewat /api/citation-lookup begitu diklik,
    // sama seperti sitasi hasil AI), fallback ke url biasa kalau papernya
    // tidak punya DOI (linknya tetap valid, cuma tidak memicu kartu preview -
    // itu perilaku yang sudah ada & wajar utk link non-DOI, lihat click
    // handler quill.root di app.js).
    href: r.doi ? `https://doi.org/${r.doi}` : (r.url || '#')
  };
}

// Bangun konteks sitasi APA dari paper yang SUDAH DISIMPAN user di sebuah folder
// Koleksi Saya (getSavedReferences, lihat definisinya di bawah - aman dipanggil
// dari sini karena function declaration di-hoist), bukan dari live search
// OpenAlex - dipakai saat dokumen Notebook di-attach ke folder Riset tertentu,
// supaya AI ground ke paper yang memang sudah dikurasi user sendiri untuk
// proyek riset itu, bukan hasil pencarian acak tiap kali generate.
function buildApaContextFromCollection(userId, researchId) {
  const references = getSavedReferences().filter(r => r.userId === userId && r.researchId === researchId);
  if (references.length === 0) return null;
  // Batasi jumlah yang dikirim ke prompt (paling baru disimpan dulu - kemungkinan
  // paling relevan dgn fokus riset yang sedang berjalan) supaya prompt tidak membengkak.
  const top = references.slice().sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)).slice(0, 12);

  const entries = top.map(r => {
    const apa = buildApaEntryFromSavedReference(r);
    return {
      inText: apa.inText,
      reference: apa.reference,
      citation: {
        title: r.title,
        authors: r.authors,
        journal: r.journal,
        year: r.year,
        url: r.url,
        doi: r.doi || null,
        citedByCount: null,
        isOpenAccess: !!r.pdfUrl,
        pdfUrl: r.pdfUrl || null,
        abstract: r.abstract ? r.abstract.slice(0, 280) : ''
      }
    };
  });

  const listText = entries.map((e, i) => `${i + 1}. Sitasi dalam teks: ${e.inText}\n   Entri Daftar Pustaka: ${e.reference}`).join('\n');
  const contextText = `Berikut paper yang SUDAH DISIMPAN user sendiri di folder Koleksi Saya untuk riset ini - ini SATU-SATUNYA sumber sitasi yang boleh dipakai untuk naskah ini. Kalau ada klaim di tulisanmu yang benar-benar didukung salah satu paper ini, WAJIB sisipkan sitasi dalam-teks APA 7th edition PERSIS seperti tertulis di depan tiap paper di bawah (contoh: (Smith & Jones, 2021)), taruh tepat setelah klausa/kalimat yang didukung. JANGAN mengarang paper, penulis, atau sitasi lain di luar daftar ini, dan JANGAN memakai paper lain di luar daftar ini walau menurutmu relevan. JANGAN menuliskan Daftar Pustaka/References sendiri di akhir teks - itu akan ditambahkan otomatis oleh sistem secara terpisah. Kalau tidak ada paper di daftar ini yang benar-benar relevan untuk mendukung suatu klaim, JANGAN paksa mengutip - tulis bagian itu tanpa sitasi seperti biasa:\n\n${listText}`;

  return { contextText, entries };
}

// Konteks sitasi APA final utk 1 kali generate AI Notebook: kalau dokumen
// di-attach ke folder Koleksi Saya yang valid & folder itu punya isi, PAKAI
// HANYA itu (hormati kurasi eksplisit user - jangan campur dgn live search).
// Kalau tidak di-attach, folder kosong, atau folder invalid/bukan milik user,
// fallback ke live search OpenAlex seperti sebelumnya.
async function resolveApaContext(userId, collectionId, query, perPage) {
  if (collectionId) {
    const owns = getSavedResearches().some(r => r.id === collectionId && r.userId === userId);
    if (owns) {
      const collectionContext = buildApaContextFromCollection(userId, collectionId);
      if (collectionContext) return collectionContext;
    }
  }
  return searchApaAcademicContext(query, perPage);
}

function escapeHtmlServer(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Bungkus tiap kemunculan sitasi dalam-teks yang BENAR-BENAR dipakai model
// (dicocokkan PERSIS, mis. "(Rahman, 2021)") dengan tag <a href="..."> ke URL
// sumber aslinya - kartu preview sitasi di-load LANGSUNG dari URL/DOI ini saat
// diklik (lihat /api/citation-lookup), bukan disimpan di dokumen,
// jadi dokumen tetap ringan & cuma menyimpan link biasa. Sekaligus jadi
// "Daftar Pustaka HANYA entri yang beneran dikutip" filter (paper yang cuma
// "ditawarkan" ke model tapi tidak dipakai TIDAK ikut masuk ke references yang
// dikembalikan) - menjaga bibliografi yang dihasilkan tetap akurat.
//
// variant 'html': teks INPUT sudah berupa HTML (hasil generate outline/
// pendahuluan/dst yang sudah dibungkus <p>/<h2>/dst oleh model) - cari&ganti
// langsung tanpa escape ulang.
// variant 'text': teks INPUT masih plain text (continue-writing) - di-escape
// dulu jadi HTML aman, BUKAN dibungkus tag block (<p> dst) supaya kalau
// di-paste inline di tengah paragraf yang sedang ditulis user, tidak memutus
// paragraf itu jadi blok baru.
function linkifyUsedApaCitations(text, apaContext, variant) {
  const baseHtml = variant === 'html' ? text : escapeHtmlServer(text);
  if (!text || !apaContext || !apaContext.entries || apaContext.entries.length === 0) {
    return { html: baseHtml, references: [] };
  }
  const matchIn = variant === 'html' ? baseHtml : text; // untuk variant text, cek match di teks ASLI (belum di-escape) - inText tidak mengandung karakter yang berubah signifikan lewat escape
  const usedEntries = apaContext.entries.filter(e => matchIn.includes(e.inText));
  if (usedEntries.length === 0) {
    return { html: baseHtml, references: [] };
  }
  let html = baseHtml;
  usedEntries.forEach(e => {
    const marker = variant === 'html' ? e.inText : escapeHtmlServer(e.inText);
    const linked = `<a href="${escapeHtmlServer(e.citation.url || '#')}">${marker}</a>`;
    html = html.split(marker).join(linked);
  });
  return { html, references: usedEntries.map(e => e.reference) };
}

const REALTIME_WORK_TYPES = ['article', 'review', 'book-chapter', 'dissertation', 'preprint', 'report'];
const CARI_REFERENSI_FREE_MONTHLY_LIMIT = 5; // Premium & Ultimate unlimited, tidak dijatah

// "Realtime Database" - miniatur pencarian live OpenAlex di tab Database Jurnal
// (search bar + filter tipe dokumen). Query sudah bisa pakai sintaks boolean
// (AND/OR/NOT, kutip untuk frasa persis) karena parameter "search" OpenAlex
// mendukungnya secara native - tidak perlu parser tambahan di sini. Dibatasi
// maksimal 50 hasil sesuai permintaan (bukan replika penuh openalex.org).
app.get('/api/works/search-live', requireAccess, async (req, res) => {
  // Mode "author" pakai kolom pencarian yang SAMA dengan mode "keyword" (satu
  // input, bukan 2 field terpisah) - bedanya cuma diperlakukan sebagai filter
  // raw_author_name.search, bukan search judul/abstrak/fulltext biasa.
  const searchMode = req.query.mode === 'author' ? 'author' : 'keyword';
  const query = String(req.query.q || '').trim().slice(0, 300);
  if (!query || query.length < 3) {
    return res.status(400).json({ ok: false, message: searchMode === 'author' ? 'Nama penulis minimal 3 karakter.' : 'Kata kunci pencarian minimal 3 karakter.' });
  }
  const workType = String(req.query.type || '').trim();
  let extraFilter = REALTIME_WORK_TYPES.includes(workType) ? `,type:${workType}` : '';

  const quartiles = String(req.query.quartile || '')
    .split(',')
    .map(q => q.trim().toUpperCase())
    .filter(q => ['Q1', 'Q2', 'Q3', 'Q4'].includes(q));

  // Filter tahun terbit, minimal sitasi, exclude preprint, open access, dan
  // negara afiliasi penulis - semuanya native didukung OpenAlex filter param
  // (beda dengan kuartil SJR yang harus di-postfilter dari data SCImago).
  const currentYear = new Date().getFullYear();
  const yearMin = parseInt(req.query.yearMin, 10);
  if (Number.isInteger(yearMin) && yearMin >= 1900 && yearMin <= currentYear) {
    extraFilter += `,from_publication_date:${yearMin}-01-01`;
  }
  const yearMax = parseInt(req.query.yearMax, 10);
  if (Number.isInteger(yearMax) && yearMax >= 1900 && yearMax <= currentYear + 1) {
    extraFilter += `,to_publication_date:${yearMax}-12-31`;
  }

  const minCitations = parseInt(req.query.minCitations, 10);
  if (Number.isInteger(minCitations) && minCitations > 0) {
    extraFilter += `,cited_by_count:>${minCitations - 1}`;
  }

  if (req.query.excludePreprints === '1' && !workType) {
    extraFilter += ',type:!preprint';
  }

  if (req.query.openAccessOnly === '1') {
    extraFilter += ',open_access.is_oa:true';
  }

  const countryCodes = String(req.query.country || '')
    .split(',')
    .map(c => c.trim().toUpperCase())
    .filter(c => /^[A-Z]{2}$/.test(c))
    .slice(0, 20);
  if (countryCodes.length) {
    extraFilter += `,institutions.country_code:${countryCodes.join('|')}`;
  }

  // Mode "author": pindahkan query utama dari parameter "search" (judul/
  // abstrak/fulltext) ke filter raw_author_name.search - cocok berdasarkan
  // nama penulis tanpa perlu resolve ke Author ID dulu. Koma/pipe dibuang
  // karena keduanya pemisah filter di sintaks OpenAlex, bisa bikin salah parse.
  let mainQuery = query;
  if (searchMode === 'author') {
    const authorQuery = query.replace(/[,|]/g, '');
    extraFilter += `,raw_author_name.search:${authorQuery}`;
    mainQuery = '';
  }

  const ALLOWED_SORTS = ['publication_date:desc', 'cited_by_count:desc', 'display_name:asc'];
  const sort = ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : null;

  // Cari Referensi - Free dijatah 5x/bulan, Premium & Ultimate unlimited.
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const planType = user ? (user.type || 'free') : 'free';
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (!isAdminReq(req) && planType === 'free' && user) {
    const usedThisMonth = user.lastCariReferensiMonth === currentMonth ? (user.cariReferensiCountThisMonth || 0) : 0;
    if (usedThisMonth >= CARI_REFERENSI_FREE_MONTHLY_LIMIT) {
      return res.status(403).json({ ok: false, message: `Limit bulanan tercapai. Akun Free dibatasi ${CARI_REFERENSI_FREE_MONTHLY_LIMIT}x pencarian Cari Referensi per bulan. Upgrade ke Premium/Ultimate untuk pencarian tanpa batas.` });
    }
  }

  try {
    // Kuartil SJR (dari SCImago) bukan field OpenAlex, jadi difilter setelah
    // fetch - saat filter kuartil aktif ambil lebih banyak kandidat (maks
    // per_page OpenAlex) supaya tetap kebagian ~50 hasil usai difilter.
    const fetchCount = quartiles.length ? 200 : 50;
    let works = await searchOpenAlexWorks(mainQuery, fetchCount, extraFilter, sort);
    if (quartiles.length) {
      works = works.filter(w => w.journalQuartile && quartiles.includes(w.journalQuartile));
    }
    works = works.slice(0, 50);

    if (planType === 'free' && user) {
      if (user.lastCariReferensiMonth !== currentMonth) {
        user.lastCariReferensiMonth = currentMonth;
        user.cariReferensiCountThisMonth = 0;
      }
      user.cariReferensiCountThisMonth += 1;
      saveUsers(users);
    }

    res.json({ ok: true, works });
  } catch (error) {
    console.error('[Works Search Live] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mencari data real-time dari OpenAlex: ' + error.message });
  }
});

// --- Pencarian Paten (Patsnap semantic search) ---
// Free-tier key hanya punya akses ke endpoint semantic search (bukan
// bibliographic/legal-status detail penuh), tapi endpoint lookup nomor paten
// (patent-search-pn) ternyata tersedia dan mengembalikan judul + assignee +
// tanggal - dipakai untuk memperkaya tiap hasil semantic search. Di-cache di
// memori (per proses) karena nomor paten & judulnya statis, tidak berubah.
const patsnapBiblioCache = new Map();

async function fetchPatsnapPatentBiblio(pn, apiKey) {
  if (patsnapBiblioCache.has(pn)) {
    return patsnapBiblioCache.get(pn);
  }
  try {
    const response = await fetch('https://connect.patsnap.com/search/patent/patent-search-pn', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pn })
    });
    const data = await response.json();
    const item = data.status && data.data && data.data.results && data.data.results[0];
    const biblio = item ? {
      title: item.title || null,
      assignee: item.current_assignee || item.original_assignee || null,
      inventor: item.inventor || null,
      applicationDate: item.apdt || null,
      publicationDate: item.pbdt || null
    } : null;
    patsnapBiblioCache.set(pn, biblio);
    return biblio;
  } catch (error) {
    console.error('[Patsnap Biblio] Gagal ambil detail untuk', pn, error.message);
    return null;
  }
}

function formatPatsnapDate(yyyymmdd) {
  if (!yyyymmdd) return null;
  const str = String(yyyymmdd);
  if (str.length !== 8) return null;
  return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
}

async function searchPatsnapPatents(text) {
  const apiKey = process.env.PATSNAP_API_KEY;
  if (!apiKey) {
    throw new Error('PATSNAP_API_KEY belum diset di server.');
  }
  const response = await fetch('https://connect.patsnap.com/search/patent/semantic-search-patent', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  });
  const data = await response.json();
  if (!data.status) {
    throw new Error(data.error_msg || 'Patsnap API mengembalikan error.');
  }
  const results = (data.data && data.data.results) || [];

  const biblios = await Promise.all(results.map((r) => fetchPatsnapPatentBiblio(r.pn, apiKey)));

  return {
    totalCount: (data.data && data.data.total_search_result_count) || results.length,
    patents: results.map((r, i) => {
      const biblio = biblios[i];
      return {
        patentNumber: r.pn,
        patentId: r.patent_id,
        relevancy: r.relevancy,
        title: biblio ? biblio.title : null,
        assignee: biblio ? biblio.assignee : null,
        applicationDate: formatPatsnapDate(biblio ? biblio.applicationDate : null),
        publicationDate: formatPatsnapDate(biblio ? biblio.publicationDate : null),
        googlePatentsUrl: `https://patents.google.com/patent/${encodeURIComponent(r.pn)}`
      };
    })
  };
}

const PATENT_SEARCH_MONTHLY_LIMIT = { free: 1, premium: 5, ultimate: 20 };

app.post('/api/patents/search-live', requireAccess, async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 3000);
  if (!text || text.length < 20) {
    return res.status(400).json({ ok: false, message: 'Masukkan judul, abstrak, atau klaim minimal 20 karakter agar pencarian semantik akurat.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const planType = user ? (user.type || 'free') : 'free';
  const limit = PATENT_SEARCH_MONTHLY_LIMIT[planType] ?? PATENT_SEARCH_MONTHLY_LIMIT.free;

  if (!isAdminReq(req) && user) {
    const usedThisMonth = user.lastPatentSearchMonth === currentMonth ? (user.patentSearchCountThisMonth || 0) : 0;
    if (usedThisMonth >= limit) {
      return res.status(403).json({ ok: false, message: `Limit bulanan tercapai. Akun ${planType} dibatasi ${limit}x pencarian paten per bulan.` });
    }
  }

  try {
    const result = await searchPatsnapPatents(text);

    if (user) {
      if (user.lastPatentSearchMonth !== currentMonth) {
        user.lastPatentSearchMonth = currentMonth;
        user.patentSearchCountThisMonth = 0;
      }
      user.patentSearchCountThisMonth += 1;
      saveUsers(users);
    }

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Patent Search Live] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mencari paten: ' + error.message });
  }
});

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

// --- Citation Graph (ala ResearchRabbit/Connected Papers) - ditenagai OpenAlex ---
// v1: OpenAlex saja (referenced_works = sitasi keluar, filter "cites:" = sitasi masuk,
// related_works = rekomendasi mirip bawaan OpenAlex). Semantic Scholar sengaja belum
// dipakai di versi awal ini - bisa ditambah belakangan untuk highlight sitasi paling
// berpengaruh (isInfluential), tapi bukan syarat wajib graf ini bisa jalan.
const CITATION_GRAPH_MONTHLY_LIMIT = { free: 5, premium: 20, ultimate: 100 };
const CITATION_GRAPH_WORK_SELECT = 'id,doi,title,display_name,publication_year,cited_by_count,primary_location,authorships,open_access,referenced_works,related_works,abstract_inverted_index';

function openAlexShortId(fullId) {
  return String(fullId || '').replace('https://openalex.org/', '').trim();
}

function openAlexParams(extra) {
  const params = new URLSearchParams(extra);
  const apiKey = process.env.OPENALEX_API_KEY;
  if (apiKey) params.set('api_key', apiKey);
  const mailto = process.env.OPENALEX_MAILTO;
  if (mailto) params.set('mailto', mailto);
  return params;
}

function normalizeOpenAlexWorkNode(w) {
  const authorNames = (w.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean);
  const authors = authorNames.length > 3
    ? `${authorNames.slice(0, 3).join(', ')}, et al.`
    : (authorNames.join(', ') || 'Tidak diketahui');
  const doi = w.doi ? String(w.doi).replace('https://doi.org/', '') : null;
  const abstract = reconstructAbstractFromInvertedIndex(w.abstract_inverted_index);
  return {
    id: openAlexShortId(w.id),
    title: w.title || w.display_name || 'Tanpa judul',
    authors,
    year: w.publication_year ? String(w.publication_year) : '-',
    journal: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || '-',
    citedByCount: w.cited_by_count || 0,
    doi,
    url: w.doi || (w.primary_location && w.primary_location.landing_page_url) || w.id || '#',
    isOpenAccess: !!(w.open_access && w.open_access.is_oa),
    referencedWorksCount: Array.isArray(w.referenced_works) ? w.referenced_works.length : 0,
    abstract: abstract ? abstract.slice(0, 1500) : null
  };
}

// Ambil 1 work lengkap (termasuk daftar ID referenced_works & related_works-nya).
async function fetchOpenAlexWorkById(id) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const params = openAlexParams({ select: CITATION_GRAPH_WORK_SELECT });
  const response = await fetchFn(`https://api.openalex.org/works/${encodeURIComponent(openAlexShortId(id))}?${params.toString()}`);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAlex Work API Error: ${response.status} - ${errText}`);
  }
  return response.json();
}

// Ambil metadata banyak work sekaligus dari daftar ID (referenced_works/related_works
// cuma berisi ID mentah, bukan judul/penulis) - di-batch 50 ID per request lewat
// filter OR (ids.openalex:ID1|ID2|...) supaya tidak perlu 1 request per paper.
async function fetchOpenAlexWorksByIds(ids) {
  const cleanIds = (ids || []).filter(Boolean);
  if (!cleanIds.length) return [];
  const fetchFn = globalThis.fetch || require('node-fetch');
  const chunks = [];
  for (let i = 0; i < cleanIds.length; i += 50) chunks.push(cleanIds.slice(i, i + 50));

  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    const shortIds = chunk.map(openAlexShortId);
    const params = openAlexParams({
      filter: `ids.openalex:${shortIds.join('|')}`,
      per_page: String(shortIds.length),
      select: CITATION_GRAPH_WORK_SELECT
    });
    try {
      const response = await fetchFn(`https://api.openalex.org/works?${params.toString()}`);
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.results) ? data.results : [];
    } catch (err) {
      console.warn('[Citation Graph] Gagal batch-fetch works (diabaikan):', err.message);
      return [];
    }
  }));

  return chunkResults.flat();
}

// Sitasi masuk (works yang mengutip work ini) - diurutkan dari yang paling sering disitasi.
async function fetchOpenAlexCitingWorks(id, perPage) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const params = openAlexParams({
    filter: `cites:${openAlexShortId(id)}`,
    sort: 'cited_by_count:desc',
    per_page: String(perPage),
    select: CITATION_GRAPH_WORK_SELECT
  });
  const response = await fetchFn(`https://api.openalex.org/works?${params.toString()}`);
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAlex Citing-Works API Error: ${response.status} - ${errText}`);
  }
  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
}

// Cari kandidat paper "seed" (titik awal) untuk mulai eksplorasi peta sitasi.
app.get('/api/citation-graph/search', requireAccess, citationGraphLimiter, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 3) {
    return res.status(400).json({ ok: false, message: 'Masukkan judul atau kata kunci minimal 3 karakter.' });
  }
  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const cleanQuery = query.replace(/[?*]/g, ' ').replace(/\s+/g, ' ').trim();
    const params = openAlexParams({
      search: cleanQuery,
      per_page: '10',
      filter: 'has_abstract:true',
      select: CITATION_GRAPH_WORK_SELECT
    });
    const response = await fetchFn(`https://api.openalex.org/works?${params.toString()}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAlex Search API Error: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    res.json({ ok: true, results: results.map(normalizeOpenAlexWorkNode) });
  } catch (error) {
    console.error('[Citation Graph Search] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mencari paper: ' + error.message });
  }
});

// Cari kandidat PENULIS (bukan paper) berdasarkan nama - dipakai saat user
// mencari lewat nama author. Nama sering ambigu (banyak orang dengan nama
// sama), jadi hasilnya dulu ditampilkan sebagai daftar penulis untuk dipilih
// (dengan afiliasi & jumlah paper sebagai pembeda), baru setelah dipilih baru
// diambil daftar papernya lewat /author-works.
app.get('/api/citation-graph/search-author', requireAccess, citationGraphLimiter, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 3) {
    return res.status(400).json({ ok: false, message: 'Masukkan nama penulis minimal 3 karakter.' });
  }
  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const params = openAlexParams({
      search: query,
      per_page: '8',
      select: 'id,display_name,works_count,cited_by_count,last_known_institutions'
    });
    const response = await fetchFn(`https://api.openalex.org/authors?${params.toString()}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAlex Authors API Error: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    const normalized = results.map((a) => {
      const institutions = (a.last_known_institutions || []).map((i) => i.display_name).filter(Boolean);
      return {
        id: openAlexShortId(a.id),
        name: a.display_name || 'Tidak diketahui',
        institution: institutions.slice(0, 2).join(', ') || null,
        worksCount: a.works_count || 0,
        citedByCount: a.cited_by_count || 0
      };
    });
    res.json({ ok: true, results: normalized });
  } catch (error) {
    console.error('[Citation Graph Search Author] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mencari penulis: ' + error.message });
  }
});

// Daftar paper milik 1 penulis terpilih (diurutkan dari yang paling banyak disitasi).
app.get('/api/citation-graph/author-works', requireAccess, citationGraphLimiter, async (req, res) => {
  const authorId = String(req.query.authorId || '').trim();
  if (!authorId) {
    return res.status(400).json({ ok: false, message: 'authorId wajib diisi.' });
  }
  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const params = openAlexParams({
      filter: `author.id:${openAlexShortId(authorId)},has_abstract:true`,
      sort: 'cited_by_count:desc',
      per_page: '15',
      select: CITATION_GRAPH_WORK_SELECT
    });
    const response = await fetchFn(`https://api.openalex.org/works?${params.toString()}`);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAlex Author-Works API Error: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    const results = Array.isArray(data.results) ? data.results : [];
    res.json({ ok: true, results: results.map(normalizeOpenAlexWorkNode) });
  } catch (error) {
    console.error('[Citation Graph Author Works] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengambil daftar paper penulis: ' + error.message });
  }
});

// Ekspansi 1 node di peta sitasi: kembalikan paper itu sendiri + siapa yang dia
// rujuk (referensi/keluar), siapa yang merujuk dia (sitasi/masuk), dan paper mirip
// (related). Frontend memanggil ini tiap kali user klik sebuah node untuk diperluas.
app.post('/api/citation-graph/expand', requireAccess, citationGraphLimiter, async (req, res) => {
  const workId = String((req.body && req.body.workId) || '').trim();
  if (!workId) {
    return res.status(400).json({ ok: false, message: 'workId wajib diisi.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const planType = user ? (user.type || 'free') : 'free';
  const limit = CITATION_GRAPH_MONTHLY_LIMIT[planType] ?? CITATION_GRAPH_MONTHLY_LIMIT.free;

  if (!isAdminReq(req) && user) {
    const usedThisMonth = user.lastCitationGraphMonth === currentMonth ? (user.citationGraphCountThisMonth || 0) : 0;
    if (usedThisMonth >= limit) {
      return res.status(403).json({ ok: false, message: `Limit bulanan tercapai. Akun ${planType} dibatasi ${limit}x eksplorasi peta sitasi per bulan.` });
    }
  }

  try {
    const work = await fetchOpenAlexWorkById(workId);
    // Dibatasi cukup kecil per klik (maks ~26 node baru) - awalnya 20+20+10 (maks
    // 50 node sekaligus) bikin graf langsung penuh-sesak dan labelnya saling tindih
    // sejak klik pertama. User tetap bisa memperluas lebih jauh dengan klik node lain.
    const referencedIds = (work.referenced_works || []).slice(0, 10);
    const relatedIds = (work.related_works || []).slice(0, 6);

    const [referencedWorks, relatedWorks, citingWorks] = await Promise.all([
      fetchOpenAlexWorksByIds(referencedIds),
      fetchOpenAlexWorksByIds(relatedIds),
      fetchOpenAlexCitingWorks(workId, 10).catch((err) => {
        console.warn('[Citation Graph Expand] Gagal ambil citing works (diabaikan):', err.message);
        return [];
      })
    ]);

    if (user) {
      if (user.lastCitationGraphMonth !== currentMonth) {
        user.lastCitationGraphMonth = currentMonth;
        user.citationGraphCountThisMonth = 0;
      }
      user.citationGraphCountThisMonth += 1;
      saveUsers(users);
    }

    res.json({
      ok: true,
      node: normalizeOpenAlexWorkNode(work),
      references: referencedWorks.map(normalizeOpenAlexWorkNode),
      citedBy: citingWorks.map(normalizeOpenAlexWorkNode),
      related: relatedWorks.map(normalizeOpenAlexWorkNode)
    });
  } catch (error) {
    console.error('[Citation Graph Expand] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal memuat data sitasi: ' + error.message });
  }
});

// TL;DR dwibahasa (EN + ID) generik dari judul+abstrak asli - dipakai bareng oleh
// Peta Sitasi dan Referensi Saya, supaya logika pemanggilan DeepSeek-nya tidak
// dobel. Selalu dari abstrak asli (bukan cuma judul) supaya tidak mengarang isi.
class TldrError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function generateBilingualTldr(rawTitle, rawAbstract, poolUserId, poolIsAdmin) {
  const title = String(rawTitle || '').trim().slice(0, 500);
  const abstract = String(rawAbstract || '').trim().slice(0, 1500);
  if (!title) {
    throw new TldrError('title wajib diisi.', 400);
  }
  if (!abstract) {
    throw new TldrError('Paper ini tidak memiliki abstrak, TL;DR tidak dapat dibuat tanpa mengarang isi.', 422);
  }

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
    throw new TldrError('DeepSeek API Key belum dikonfigurasi di server.', 500);
  }

  // Dijatah lewat DEEPSEEK POOL bersama (kredit/minggu) - dipanggil dari 2 rute
  // (Citation Graph TL;DR & simpan Koleksi Saya), poolUserId opsional supaya
  // helper ini tetap bisa dites/dipakai tanpa konteks user kalau perlu.
  if (poolUserId && !poolIsAdmin) {
    const poolUsers = getUsers();
    const poolUser = poolUsers.find(u => u.id === poolUserId);
    if (poolUser && !hasDeepSeekPoolAccess(poolUser)) {
      throw new TldrError('Kuota mingguan JurnalHub Intelligence Anda sudah habis. Kuota akan direset otomatis setiap hari Senin (lihat detail di Pengaturan > Usage).', 403);
    }
  }

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
  const systemPrompt = 'You are an academic assistant that writes an extremely concise TL;DR (1-2 sentences) of what a research paper is about, strictly based ONLY on the title and abstract given - never add claims, numbers, or findings that are not stated in the text. Respond with ONLY valid JSON, no markdown, in this exact shape: {"en": "TL;DR in English", "id": "TL;DR dalam Bahasa Indonesia"}.';
  const userPrompt = `Title: ${title}\n\nAbstract: ${abstract}`;

  const dsResponse = await fetchFn(deepSeekUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${deepSeekKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 400,
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
    throw new TldrError(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`, 500);
  }

  const dsData = await dsResponse.json();
  const choice = dsData?.choices?.[0];
  let content = choice?.message?.content?.trim();
  if (!content && choice?.message?.reasoning_content) {
    content = String(choice.message.reasoning_content).trim();
  }
  if (!content) throw new TldrError('Respons AI kosong.', 500);

  const parsed = cleanAndParseAIResponse(content, true);
  if (!parsed || !parsed.en || !parsed.id) {
    throw new TldrError('Format TL;DR dari AI tidak sesuai.', 500);
  }
  if (poolUserId) recordDeepSeekPoolUsage(poolUserId, dsData?.usage?.total_tokens);
  return { en: parsed.en, id: parsed.id };
}

// TL;DR dwibahasa (EN + ID) untuk paper yang sedang dipilih di peta sitasi - dibuat
// on-demand dari abstrak asli OpenAlex (bukan dari judul saja) supaya tidak
// mengarang isi. Sengaja TIDAK dibatasi kuota bulanan seperti /expand - ini cuma
// 1 pemanggilan DeepSeek super ringan (mirip AI Disclosure Generator), bukan
// beban utama fitur ini (yang berat & dibatasi kuota adalah panggilan OpenAlex
// di /expand).
app.post('/api/citation-graph/tldr', requireAccess, citationGraphLimiter, async (req, res) => {
  try {
    const result = await generateBilingualTldr(req.body && req.body.title, req.body && req.body.abstract, req.session.userId, isAdminReq(req));
    res.json({ ok: true, en: result.en, id: result.id });
  } catch (error) {
    console.error('[Citation Graph TLDR] Error:', error.message);
    const status = error instanceof TldrError ? error.status : 500;
    const message = error instanceof TldrError ? error.message : ('Gagal membuat TL;DR: ' + error.message);
    res.status(status).json({ ok: false, message });
  }
});

// --- KOLEKSI SAYA: paper individual yang di-save user dari Cari Referensi,
// popover sitasi Lit Review/JurnalHub Intelligence/SLR/Riwayat, dikelompokkan ke
// dalam folder "Riset" (per proyek penelitian). ---
const SAVED_RESEARCHES_FILE = path.join(DATA_DIR, 'saved-researches.json');
const SAVED_REFERENCES_FILE = path.join(DATA_DIR, 'saved-references.json');

function getSavedResearches() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SAVED_RESEARCHES_FILE)) fs.writeFileSync(SAVED_RESEARCHES_FILE, '[]');
    return JSON.parse(fs.readFileSync(SAVED_RESEARCHES_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca saved-researches.json:', error);
    return [];
  }
}

function saveSavedResearches(researches) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVED_RESEARCHES_FILE, JSON.stringify(researches, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan saved-researches.json:', error);
    return false;
  }
}

function getSavedReferences() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(SAVED_REFERENCES_FILE)) fs.writeFileSync(SAVED_REFERENCES_FILE, '[]');
    return JSON.parse(fs.readFileSync(SAVED_REFERENCES_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca saved-references.json:', error);
    return [];
  }
}

function saveSavedReferences(references) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVED_REFERENCES_FILE, JSON.stringify(references, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan saved-references.json:', error);
    return false;
  }
}

// Riwayat chatbot per folder Koleksi Saya - satu entri per folder (bukan per
// pesan), disimpan permanen supaya user bisa buka lagi obrolannya kapan saja.
const FOLDER_CHATS_FILE = path.join(DATA_DIR, 'folder-chats.json');

function getFolderChats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FOLDER_CHATS_FILE)) fs.writeFileSync(FOLDER_CHATS_FILE, '[]');
    return JSON.parse(fs.readFileSync(FOLDER_CHATS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca folder-chats.json:', error);
    return [];
  }
}

function saveFolderChats(chats) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FOLDER_CHATS_FILE, JSON.stringify(chats, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan folder-chats.json:', error);
    return false;
  }
}

// --- Notebook (AI Writer Phase 1: editor teks kaya + autosave + ekspor .docx,
// belum ada AI menyatu - lihat POST /api/documents/:id/export-docx untuk
// konversi HTML hasil Quill.js jadi dokumen .docx). ---
const DOCUMENTS_FILE = path.join(DATA_DIR, 'documents.json');

function getDocuments() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DOCUMENTS_FILE)) fs.writeFileSync(DOCUMENTS_FILE, '[]');
    return JSON.parse(fs.readFileSync(DOCUMENTS_FILE, 'utf8'));
  } catch (error) {
    console.error('Gagal membaca documents.json:', error);
    return [];
  }
}

function saveDocuments(docs) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOCUMENTS_FILE, JSON.stringify(docs, null, 2));
    return true;
  } catch (error) {
    console.error('Gagal menyimpan documents.json:', error);
    return false;
  }
}

// Rate limit burst untuk autosave Notebook - murni tulis ke JSON lokal (tanpa
// panggilan AI), tapi tetap dibatasi kecepatannya per menit untuk jaga-jaga
// dari penyalahgunaan lewat script/automasi, konsisten dengan limiter lain.
const documentSaveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak permintaan simpan dokumen dalam waktu singkat. Tunggu sebentar lalu coba lagi.' }
});

app.get('/api/documents', requireAccess, (req, res) => {
  const docs = getDocuments()
    .filter(d => d.userId === req.session.userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(d => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, createdAt: d.createdAt }));
  res.json({ ok: true, documents: docs });
});

const NOTEBOOK_AI_LANGUAGES = new Set(['auto', 'id', 'en']);

// Validasi researchId yang dikirim client BENAR-BENAR folder Koleksi Saya milik
// user ini (bukan cuma sekedar string kosong/valid uuid) - kalau tidak valid
// (kosong, folder sudah dihapus, atau milik user lain), kembalikan null supaya
// dokumen tidak ke-attach ke folder yang salah/tidak ada.
function resolveOwnedResearchId(userId, researchId) {
  const id = String(researchId || '').trim();
  if (!id) return null;
  const owns = getSavedResearches().some(r => r.id === id && r.userId === userId);
  return owns ? id : null;
}

app.post('/api/documents', requireAccess, (req, res) => {
  const docs = getDocuments();
  const now = new Date().toISOString();
  const newDoc = {
    id: uuidv4(),
    userId: req.session.userId,
    title: String((req.body && req.body.title) || 'Untitled').trim().slice(0, 200) || 'Untitled',
    contentHtml: '',
    // Bahasa hasil tulisan AI utk dokumen ini - "auto" (default) berarti ikuti
    // bahasa judul/isi naskah seperti sebelumnya; "id"/"en" memaksa AI SELALU
    // menulis dalam bahasa itu apapun bahasa judul/instruksi yang diberikan -
    // penting utk penulis yang naskahnya harus Bahasa Inggris (submission
    // SINTA 3 ke atas/Scopus) tapi instruksi/judul awal ditulis campur/Indonesia.
    language: NOTEBOOK_AI_LANGUAGES.has(req.body && req.body.language) ? req.body.language : 'auto',
    // Folder Koleksi Saya (getSavedResearches) yang di-attach ke dokumen ini,
    // kalau ada - saat diisi, AI Notebook (continue-writing/ai-draft-action)
    // ground sitasinya HANYA ke paper yang sudah disimpan user di folder itu,
    // bukan live search OpenAlex acak (lihat resolveApaContext). null = tidak
    // di-attach ke folder manapun (perilaku lama, live search seperti biasa).
    collectionId: resolveOwnedResearchId(req.session.userId, req.body && req.body.collectionId),
    createdAt: now,
    updatedAt: now
  };
  docs.push(newDoc);
  saveDocuments(docs);
  res.json({ ok: true, document: newDoc });
});

app.get('/api/documents/:id', requireAccess, (req, res) => {
  const doc = getDocuments().find(d => d.id === req.params.id && d.userId === req.session.userId);
  if (!doc) return res.status(404).json({ ok: false, message: 'Dokumen tidak ditemukan.' });
  res.json({ ok: true, document: doc });
});

app.put('/api/documents/:id', requireAccess, documentSaveLimiter, (req, res) => {
  const docs = getDocuments();
  const idx = docs.findIndex(d => d.id === req.params.id && d.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ ok: false, message: 'Dokumen tidak ditemukan.' });
  if (typeof req.body.title === 'string') {
    docs[idx].title = req.body.title.trim().slice(0, 200) || 'Untitled';
  }
  if (typeof req.body.contentHtml === 'string') {
    docs[idx].contentHtml = req.body.contentHtml.slice(0, 500000); // batas wajar ~500KB per dokumen
  }
  if (NOTEBOOK_AI_LANGUAGES.has(req.body.language)) {
    docs[idx].language = req.body.language;
  }
  if ('collectionId' in req.body) {
    docs[idx].collectionId = resolveOwnedResearchId(req.session.userId, req.body.collectionId);
  }
  docs[idx].updatedAt = new Date().toISOString();
  saveDocuments(docs);
  res.json({ ok: true, document: docs[idx] });
});

app.delete('/api/documents/:id', requireAccess, (req, res) => {
  const docs = getDocuments();
  const idx = docs.findIndex(d => d.id === req.params.id && d.userId === req.session.userId);
  if (idx === -1) return res.status(404).json({ ok: false, message: 'Dokumen tidak ditemukan.' });
  docs.splice(idx, 1);
  saveDocuments(docs);
  res.json({ ok: true });
});

// Notebook Phase 0: impor naskah .docx yang sudah dikerjakan user di Word,
// lanjut ditulis di Notebook. Pakai mammoth.convertToHtml (bukan extractRawText
// seperti di extractTextFromDocument) supaya heading/bold/list dsb ikut
// terbawa jadi HTML, bukan cuma teks polos - hasilnya langsung cocok jadi
// contentHtml Quill.
const notebookImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.session && req.session.userId) || rateLimit.ipKeyGenerator(req.ip),
  message: { ok: false, message: 'Terlalu banyak impor dokumen. Silakan coba lagi dalam beberapa menit.' }
});
const notebookImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB - naskah .docx wajar (bukan lampiran gambar berat)
  fileFilter: (req, file, cb) => {
    const originalName = (file.originalname || '').toLowerCase();
    const isDocx = originalName.endsWith('.docx') || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (isDocx) return cb(null, true);
    cb(new Error('Hanya file .docx yang didukung untuk impor ke Notebook.'));
  }
});

app.post('/api/documents/import-docx', requireAccess, notebookImportLimiter, (req, res) => {
  notebookImportUpload.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.message && err.message.includes('didukung')
        ? err.message
        : (err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 5MB. Silakan unggah dokumen yang lebih kecil.' : 'Gagal mengunggah file.');
      return res.status(400).json({ ok: false, message });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'File .docx wajib disertakan.' });
    }

    try {
      const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
      const html = ((result && result.value) || '').trim();
      if (!html) {
        return res.status(400).json({ ok: false, message: 'Dokumen Word tidak berisi konten yang dapat dibaca.' });
      }

      const docs = getDocuments();
      const now = new Date().toISOString();
      const title = (req.file.originalname || 'Untitled').replace(/\.docx$/i, '').trim().slice(0, 200) || 'Untitled';
      const newDoc = {
        id: uuidv4(),
        userId: req.session.userId,
        title,
        contentHtml: html.slice(0, 500000), // batas sama seperti PUT /api/documents/:id
        createdAt: now,
        updatedAt: now
      };
      docs.push(newDoc);
      saveDocuments(docs);
      res.json({ ok: true, document: newDoc });
    } catch (error) {
      console.error('[Notebook Import DOCX Error]', error);
      res.status(500).json({ ok: false, message: 'Gagal membaca file .docx. Pastikan file tidak terkunci kata sandi atau korup.' });
    }
  });
});

// Override eksplisit bahasa hasil tulisan AI Notebook - dipakai kalau dokumen
// diset ke "id"/"en" (bukan "auto"), supaya AI SELALU menulis dalam bahasa itu
// TERLEPAS dari bahasa judul/konteks/instruksi yang diberikan. Penting utk
// penulis yang naskahnya harus Bahasa Inggris (submission SINTA 3 ke
// atas/Scopus) tapi kebiasaan mengetik judul/perintah "/" tetap pakai Bahasa
// Indonesia - instruksi "samakan bahasa dgn konteks" di systemPrompt tiap aksi
// jadi kalah prioritas dibanding pesan system TERPISAH ini (dikirim belakangan,
// tepat sebelum pesan user, supaya lebih diprioritaskan model).
function buildLanguageOverrideMessage(language) {
  if (language === 'en') {
    return { role: 'system', content: 'INSTRUKSI BAHASA (WAJIB DIPATUHI, PRIORITAS DI ATAS SEMUA INSTRUKSI BAHASA LAIN DI ATAS): Tulis SELURUH konten dalam Bahasa Inggris (English) akademis yang baik, APAPUN bahasa judul/instruksi/konteks naskah yang diberikan. Ini preferensi eksplisit penulis (naskah ditujukan utk jurnal internasional/Scopus) - JANGAN ikut bahasa judul/konteks kalau berbeda.' };
  }
  if (language === 'id') {
    return { role: 'system', content: 'INSTRUKSI BAHASA (WAJIB DIPATUHI, PRIORITAS DI ATAS SEMUA INSTRUKSI BAHASA LAIN DI ATAS): Tulis SELURUH konten dalam Bahasa Indonesia akademis yang baik, APAPUN bahasa judul/instruksi/konteks naskah yang diberikan. Ini preferensi eksplisit penulis - JANGAN ikut bahasa judul/konteks kalau berbeda.' };
  }
  return null;
}

// Notebook Phase 2: AI Continue Writing - lanjutkan tulisan user dari titik
// kursor. Beda pola kuota dari tools sekali-generate (Outline/Peer Reviewer)
// karena wajar dipanggil berkali-kali dalam 1 sesi menulis, jadi limitnya
// dibuat lebih longgar (Free 10x/bulan, Premium 50x/bulan, Ultimate unlimited).
app.post('/api/documents/continue-writing', requireAccess, async (req, res) => {
  const context = String((req.body && req.body.context) || '').trim();
  if (!context) {
    return res.status(400).json({ ok: false, message: 'Tulis beberapa kalimat dulu sebelum minta AI melanjutkan.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = (user && user.type) || 'free';

  // Kuota AI Continue Writing sekarang berbasis DEEPSEEK POOL bersama (kredit/minggu)
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di server.' });
  }

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  const systemPrompt = `Anda adalah asisten penulisan akademis. Tugas Anda HANYA melanjutkan naskah yang diberikan pengguna secara natural, seolah-olah Anda adalah penulis yang sama.

ATURAN PENTING:
- Gunakan BAHASA YANG SAMA dengan naskah yang diberikan (Bahasa Indonesia jika naskah berbahasa Indonesia, Bahasa Inggris jika berbahasa Inggris).
- Samakan gaya bahasa, nada, dan tingkat formalitas dengan teks sebelumnya.
- Lanjutkan tepat dari titik terakhir naskah berhenti - JANGAN mengulang kalimat terakhir, JANGAN memberi salam/intro/penutup.
- Panjang wajar: sekitar 1-2 paragraf (maksimal ~150 kata), bukan menulis sisa keseluruhan dokumen.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung, mis. "(Smith, 2020)") KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah di bawah. Kalau tidak ada daftar paper yang diberikan, tulis TANPA sitasi sama sekali - JANGAN PERNAH mengarang nama penulis atau tahun publikasi sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA teks lanjutannya, tanpa tanda kutip, tanpa markdown, tanpa penjelasan tambahan.`;

  const userPrompt = `Berikut naskah yang sudah ditulis pengguna (dipotong ke ~2000 karakter terakhir jika naskah panjang):\n\n"""\n${context.slice(-2000)}\n"""\n\nLanjutkan naskah ini.`;

  try {
    // Landasan sitasi APA 7 kalau memang relevan: PRIORITAS ke folder Koleksi
    // Saya yang di-attach ke dokumen ini (kalau ada & terisi), fallback ke live
    // search OpenAlex berdasarkan fokus topik SAAT INI (bagian akhir naskah,
    // bukan keseluruhan dokumen yang bisa sudah membahas banyak hal) - lihat
    // resolveApaContext.
    const apaContext = await resolveApaContext(req.session.userId, req.body && req.body.collectionId, context.slice(-500), 6);
    const messages = [{ role: 'system', content: systemPrompt }];
    if (apaContext) messages.push({ role: 'system', content: apaContext.contextText });
    const languageOverride = buildLanguageOverrideMessage(req.body && req.body.language);
    if (languageOverride) messages.push(languageOverride);
    messages.push({ role: 'user', content: userPrompt });

    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 400,
        stream: false,
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages
      })
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    const dsData = await dsResponse.json();
    const choice = dsData?.choices?.[0];
    let continuation = choice?.message?.content?.trim();
    if (!continuation && choice?.message?.reasoning_content) {
      continuation = String(choice.message.reasoning_content).trim();
    }
    if (!continuation) {
      throw new Error('Respons AI kosong.');
    }

    if (user) recordDeepSeekPoolUsage(user.id, dsData?.usage?.total_tokens);

    // continuation dikembalikan sudah dalam bentuk HTML aman (di-escape + sitasi
    // yang dipakai dibungkus <a href>) - BUKAN plain text lagi seperti sebelumnya,
    // supaya frontend bisa langsung dangerouslyPasteHTML tanpa memutus paragraf
    // yang sedang ditulis user jadi blok baru (tidak ada tag block di dalamnya).
    const linked = linkifyUsedApaCitations(continuation, apaContext, 'text');
    res.json({ ok: true, continuation: linked.html, references: linked.references });
  } catch (error) {
    console.error('[Notebook Continue Writing] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal menghubungi AI untuk melanjutkan tulisan: ' + error.message });
  }
});

// Notebook Phase 2: menu "/" (slash command) ala SciSpace - Outline Builder,
// Write Introduction/Conclusion/Opposing Arguments (dikembalikan sbg HTML
// sederhana supaya bisa langsung di-paste ke Quill lewat dangerouslyPasteHTML),
// dan Critique Like a Reviewer (dikembalikan sbg teks polos, ditampilkan
// client-side dengan warna merah). Berbagi kredit DEEPSEEK POOL yang sama
// dengan Continue Writing (lihat requireDeepSeekPoolAccess) karena sama-sama
// single-call AI assist ringan dalam 1 sesi menulis.
const NOTEBOOK_DRAFT_ACTIONS = {
  outline: {
    systemPrompt: `Anda adalah asisten penulisan akademis. Berdasarkan judul naskah dan isi yang sudah ditulis (jika ada), buat KERANGKA/OUTLINE terstruktur untuk membantu penulis melanjutkan naskahnya.

ATURAN:
- Gunakan BAHASA YANG SAMA dengan judul/isi naskah yang diberikan.
- Format output WAJIB HTML sederhana memakai HANYA tag berikut: <h2>, <h3>, <p>, <ul>, <li>, <strong>.
- JANGAN gunakan markdown, JANGAN bungkus dengan \`\`\`html, JANGAN beri penjelasan tambahan di luar HTML.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung) KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah. Kalau tidak disediakan, tulis TANPA sitasi - JANGAN PERNAH mengarang nama penulis/tahun sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA HTML outline-nya.`,
    isHtml: true
  },
  introduction: {
    systemPrompt: `Anda adalah asisten penulisan akademis. Tulis draf PENDAHULUAN (introduction) akademis untuk naskah ini berdasarkan judul dan konteks yang tersedia.

ATURAN:
- Gunakan BAHASA YANG SAMA dengan judul/isi naskah yang diberikan.
- Format output WAJIB HTML sederhana memakai HANYA tag berikut: <p>, <strong>, <em>.
- Panjang wajar 2-3 paragraf.
- JANGAN gunakan markdown, JANGAN bungkus dengan \`\`\`html, JANGAN beri penjelasan tambahan di luar HTML.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung) KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah. Kalau tidak disediakan, tulis TANPA sitasi - JANGAN PERNAH mengarang nama penulis/tahun sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA HTML-nya.`,
    isHtml: true
  },
  conclusion: {
    systemPrompt: `Anda adalah asisten penulisan akademis. Tulis draf KESIMPULAN (conclusion) akademis berdasarkan isi naskah yang sudah ditulis sejauh ini.

ATURAN:
- Gunakan BAHASA YANG SAMA dengan isi naskah yang diberikan.
- Format output WAJIB HTML sederhana memakai HANYA tag berikut: <p>, <strong>, <em>.
- Panjang wajar 1-2 paragraf.
- JANGAN gunakan markdown, JANGAN bungkus dengan \`\`\`html, JANGAN beri penjelasan tambahan di luar HTML.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung) KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah. Kalau tidak disediakan, tulis TANPA sitasi - JANGAN PERNAH mengarang nama penulis/tahun sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA HTML-nya.`,
    isHtml: true
  },
  opposing: {
    systemPrompt: `Anda adalah asisten penulisan akademis. Tulis paragraf berisi ARGUMEN TANDINGAN / PERSPEKTIF KRITIS terhadap poin-poin yang sudah ditulis di naskah ini, seolah mewakili pandangan berbeda/skeptis, untuk memperkaya diskusi akademis (bukan untuk menyerang, tapi menunjukkan sisi lain yang perlu dipertimbangkan).

ATURAN:
- Gunakan BAHASA YANG SAMA dengan isi naskah yang diberikan.
- Format output WAJIB HTML sederhana memakai HANYA tag berikut: <p>, <strong>, <em>.
- Panjang wajar 1-2 paragraf.
- JANGAN gunakan markdown, JANGAN bungkus dengan \`\`\`html, JANGAN beri penjelasan tambahan di luar HTML.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung) KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah. Kalau tidak disediakan, tulis TANPA sitasi - JANGAN PERNAH mengarang nama penulis/tahun sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA HTML-nya.`,
    isHtml: true
  },
  critique: {
    systemPrompt: `Anda adalah reviewer jurnal akademis yang kritis, objektif, dan konstruktif. Berikan KRITIK singkat terhadap naskah yang diberikan - kelemahan argumen, celah metodologis, klaim yang kurang didukung, atau saran perbaikan - seperti komentar reviewer di pinggir naskah.

ATURAN:
- Gunakan BAHASA YANG SAMA dengan isi naskah yang diberikan.
- Format: 3-5 poin kritis, tiap poin diawali tanda hubung (-) di baris baru, 1 kalimat ringkas per poin.
- JANGAN gunakan HTML atau markdown selain tanda hubung di awal baris.
- JANGAN memuji secara berlebihan - fokus pada hal yang perlu diperbaiki.
- Kembalikan HANYA poin-poin kritiknya.`,
    isHtml: false
  }
};

// Aksi "custom" (ala kotak "Ask AI to write anything" SciSpace) - instruksi
// bebas dari penulis sendiri, bukan salah satu dari 5 command tetap di atas.
// systemPrompt-nya generik (cuma bilang "ikuti instruksi user"), instruksi
// sesungguhnya dikirim lewat userPrompt (lihat field `instruction` di bawah).
const CUSTOM_ACTION_SYSTEM_PROMPT = `Anda adalah asisten penulisan akademis yang menjalankan instruksi spesifik dari penulis untuk konten yang akan disisipkan ke naskahnya.

ATURAN:
- Ikuti instruksi pengguna dengan tepat dan tulis konten yang diminta.
- Gunakan BAHASA YANG SAMA dengan judul/isi naskah yang diberikan (atau bahasa instruksi kalau naskah masih kosong).
- Format output WAJIB HTML sederhana memakai HANYA tag berikut: <h2>, <h3>, <p>, <ul>, <li>, <strong>, <em>.
- JANGAN gunakan markdown, JANGAN bungkus dengan \`\`\`html, JANGAN beri penjelasan tambahan di luar HTML, JANGAN menyebut bahwa Anda adalah AI.
- JANGAN cantumkan sitasi/rujukan akademis apapun (nama penulis + tahun dalam kurung) KECUALI daftar paper ASLI disediakan secara eksplisit di pesan system terpisah. Kalau tidak disediakan, tulis TANPA sitasi - JANGAN PERNAH mengarang nama penulis/tahun sendiri, walau naskah sebelumnya sudah mengandung sitasi lain.
- Kembalikan HANYA HTML kontennya.`;

app.post('/api/documents/ai-draft-action', requireAccess, async (req, res) => {
  const action = String((req.body && req.body.action) || '');
  const title = String((req.body && req.body.title) || '').trim().slice(0, 300);
  const context = String((req.body && req.body.context) || '').trim().slice(0, 6000);
  const isCustom = action === 'custom';
  const instruction = isCustom ? String((req.body && req.body.instruction) || '').trim().slice(0, 500) : '';
  const actionConfig = isCustom ? { systemPrompt: CUSTOM_ACTION_SYSTEM_PROMPT, isHtml: true } : NOTEBOOK_DRAFT_ACTIONS[action];

  if (!actionConfig) {
    return res.status(400).json({ ok: false, message: 'Aksi AI tidak dikenali.' });
  }
  if (isCustom && !instruction) {
    return res.status(400).json({ ok: false, message: 'Tulis dulu permintaan untuk AI setelah "/".' });
  }
  if (!isCustom && !title && !context) {
    return res.status(400).json({ ok: false, message: 'Tulis judul atau beberapa kalimat dulu sebelum minta AI membantu.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = (user && user.type) || 'free';

  // Kuota bantuan AI Notebook sekarang berbasis DEEPSEEK POOL bersama (kredit/minggu)
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di server.' });
  }

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  const userPrompt = isCustom
    ? `Judul naskah: "${title || '(tidak ada judul)'}"\n\nIsi naskah yang sudah ditulis sejauh ini:\n"""\n${context || '(belum ada isi)'}\n"""\n\nInstruksi dari penulis: "${instruction}"`
    : `Judul naskah: "${title || '(tidak ada judul)'}"\n\nIsi naskah yang sudah ditulis sejauh ini:\n"""\n${context || '(belum ada isi)'}\n"""`;

  // Landasan sitasi APA 7 (folder Koleksi Saya diprioritaskan, fallback live
  // search OpenAlex - lihat resolveApaContext) - dilewati khusus untuk
  // "critique" (komentar reviewer terhadap naskah, bukan klaim akademis baru
  // yang butuh rujukan pustaka).
  const shouldSearchCitations = action !== 'critique';
  const citationQueryBasis = isCustom
    ? `${instruction} ${title}`.trim()
    : `${title} ${context.slice(-500)}`.trim();
  const apaContext = shouldSearchCitations
    ? await resolveApaContext(req.session.userId, req.body && req.body.collectionId, citationQueryBasis, 6)
    : null;

  const messages = [{ role: 'system', content: actionConfig.systemPrompt }];
  if (apaContext) messages.push({ role: 'system', content: apaContext.contextText });
  const languageOverride = buildLanguageOverrideMessage(req.body && req.body.language);
  if (languageOverride) messages.push(languageOverride);
  messages.push({ role: 'user', content: userPrompt });

  try {
    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 900,
        stream: false,
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages
      })
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    const dsData = await dsResponse.json();
    const choice = dsData?.choices?.[0];
    let result = choice?.message?.content?.trim();
    if (!result && choice?.message?.reasoning_content) {
      result = String(choice.message.reasoning_content).trim();
    }
    if (!result) {
      throw new Error('Respons AI kosong.');
    }
    // Jaga-jaga kalau model tetap membungkus dengan ```html ... ``` walau sudah dilarang di prompt
    if (actionConfig.isHtml) {
      result = result.replace(/^```html\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    }

    if (user) recordDeepSeekPoolUsage(user.id, dsData?.usage?.total_tokens);

    // "critique" (satu-satunya aksi non-HTML) TIDAK pernah punya apaContext
    // (dikecualikan dari pencarian sitasi di atas) - result-nya harus tetap
    // plain text apa adanya karena di-insert lewat editor.insertText di
    // frontend, bukan dangerouslyPasteHTML, jadi JANGAN di-escape/linkify.
    if (actionConfig.isHtml) {
      const linked = linkifyUsedApaCitations(result, apaContext, 'html');
      res.json({ ok: true, html: linked.html, references: linked.references });
    } else {
      res.json({ ok: true, result, references: [] });
    }
  } catch (error) {
    console.error(`[Notebook AI Draft Action: ${action}] Error:`, error);
    res.status(500).json({ ok: false, message: 'Gagal menghubungi AI: ' + error.message });
  }
});

// Kartu preview sitasi di Notebook di-load "malas" (lazy) lewat endpoint ini
// begitu marker sitasi diklik - BUKAN disimpan di dokumen saat digenerate,
// biar dokumen tetap ringan (cuma nyimpan link <a href> biasa) dan berlaku
// juga utk sitasi dari sesi sebelumnya (dokumen dibuka ulang), bukan cuma yang
// baru saja digenerate dalam sesi berjalan.
// Path top-level (BUKAN /api/documents/citation-lookup) - sengaja dihindari
// supaya tidak ketabrak duluan oleh route "/api/documents/:id" yang didaftar
// lebih awal (Express mencocokkan route berdasar urutan definisi, ":id" akan
// menganggap "citation-lookup" sebagai nilai id-nya kalau pathnya sama).
app.get('/api/citation-lookup', requireAccess, async (req, res) => {
  const doi = String(req.query.doi || '').trim();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) {
    return res.status(400).json({ ok: false, message: 'DOI tidak valid.' });
  }
  try {
    const paper = await fetchOpenAlexWorkByDoi(doi);
    if (!paper) {
      return res.status(404).json({ ok: false, message: 'Detail kutipan tidak ditemukan.' });
    }
    res.json({
      ok: true,
      citation: {
        title: paper.title,
        authors: paper.authors,
        journal: paper.journal,
        year: paper.year,
        url: paper.url,
        doi: paper.doi,
        citedByCount: paper.citedByCount,
        isOpenAccess: paper.isOpenAccess,
        pdfUrl: paper.pdfUrl,
        abstract: paper.abstract
      }
    });
  } catch (error) {
    console.error('[Notebook Citation Lookup] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal mengambil detail kutipan.' });
  }
});

// Decode entity HTML dasar yang dipakai Quill (bukan parser HTML umum - cukup
// untuk output Quill sendiri, bukan untuk sanitasi HTML sembarang).
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Pecah HTML inline (dari dalam 1 blok <p>/<li>/dst.) jadi rangkaian run teks
// dengan formatting (bold/italic/underline/strike) - tracking state pakai stack
// supaya tag bersarang (mis. <strong><em>) tetap ditangani benar.
function htmlInlineToRuns(html, forceItalic) {
  const runs = [];
  const stack = forceItalic ? ['i'] : [];
  const tagRegex = /<(\/?)([a-z0-9]+)[^>]*>/gi;
  let lastIndex = 0;
  let match;
  function flushText(text) {
    const decoded = decodeHtmlEntities(text);
    if (!decoded) return;
    runs.push({
      text: decoded,
      bold: stack.includes('b'),
      italics: stack.includes('i'),
      underline: stack.includes('u'),
      strike: stack.includes('s')
    });
  }
  while ((match = tagRegex.exec(html))) {
    const closing = match[1] === '/';
    const tagName = match[2].toLowerCase();
    flushText(html.slice(lastIndex, match.index));
    lastIndex = tagRegex.lastIndex;
    if (tagName === 'br') {
      runs.push({ text: '', isBreak: true });
      continue;
    }
    const code = tagName === 'strong' ? 'b' : tagName === 'em' ? 'i' : (tagName === 'strike' || tagName === 'del') ? 's' : tagName;
    if (!['b', 'i', 'u', 's'].includes(code)) continue; // tag lain (span/a/dst) - abaikan tag-nya saja
    if (closing) {
      const stackIdx = stack.lastIndexOf(code);
      if (stackIdx !== -1) stack.splice(stackIdx, 1);
    } else {
      stack.push(code);
    }
  }
  flushText(html.slice(lastIndex));
  return runs;
}

function runsToTextRuns(runs) {
  if (!runs.length) return [new TextRun({ text: '' })];
  return runs.map(r => r.isBreak
    ? new TextRun({ text: '', break: 1 })
    : new TextRun({ text: r.text, bold: r.bold, italics: r.italics, underline: r.underline ? {} : undefined, strike: r.strike }));
}

const QUILL_HEADING_MAP = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6
};

// Konversi HTML hasil Quill.js (bukan HTML sembarang - format outputnya sudah
// konsisten/terbatas) jadi array Paragraph docx untuk ekspor .docx Notebook.
function convertQuillHtmlToDocxChildren(html) {
  const children = [];
  const cleanHtml = String(html || '').trim();
  if (!cleanHtml) {
    children.push(new Paragraph({ text: '' }));
    return children;
  }

  const blockRegex = /<(h1|h2|h3|h4|h5|h6|p|blockquote|pre|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  let matchedAny = false;

  while ((match = blockRegex.exec(cleanHtml))) {
    matchedAny = true;
    const tag = match[1].toLowerCase();
    const inner = match[2];

    if (tag === 'ul' || tag === 'ol') {
      const liRegex = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
      let liMatch;
      let orderedIndex = 1;
      while ((liMatch = liRegex.exec(inner))) {
        const liAttrs = liMatch[1];
        const liInner = liMatch[2];
        const runs = runsToTextRuns(htmlInlineToRuns(liInner));
        const indentMatch = liAttrs.match(/ql-indent-(\d)/);
        const level = indentMatch ? parseInt(indentMatch[1], 10) : 0;
        if (/data-list="checked"/.test(liAttrs)) {
          children.push(new Paragraph({ children: [new TextRun({ text: '☑ ' }), ...runs], indent: { left: level * 360 } }));
        } else if (/data-list="unchecked"/.test(liAttrs)) {
          children.push(new Paragraph({ children: [new TextRun({ text: '☐ ' }), ...runs], indent: { left: level * 360 } }));
        } else if (tag === 'ol') {
          children.push(new Paragraph({ children: [new TextRun({ text: `${orderedIndex}. ` }), ...runs], indent: { left: level * 360 } }));
          orderedIndex++;
        } else {
          children.push(new Paragraph({ children: runs, bullet: { level } }));
        }
      }
    } else if (tag === 'pre') {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ''));
      children.push(new Paragraph({ children: [new TextRun({ text, font: 'Courier New' })], shading: { fill: 'F1F5F9' } }));
    } else if (tag === 'blockquote') {
      children.push(new Paragraph({ children: runsToTextRuns(htmlInlineToRuns(inner, true)), indent: { left: 360 } }));
    } else {
      const runs = runsToTextRuns(htmlInlineToRuns(inner));
      if (QUILL_HEADING_MAP[tag]) {
        children.push(new Paragraph({ children: runs, heading: QUILL_HEADING_MAP[tag], spacing: { before: 200 } }));
      } else {
        children.push(new Paragraph({ children: runs }));
      }
    }
  }

  if (!matchedAny) {
    const text = decodeHtmlEntities(cleanHtml.replace(/<[^>]+>/g, ' ')).trim();
    children.push(new Paragraph({ text }));
  }

  return children;
}

app.post('/api/documents/:id/export-docx', requireAccess, async (req, res) => {
  const doc = getDocuments().find(d => d.id === req.params.id && d.userId === req.session.userId);
  if (!doc) return res.status(404).json({ ok: false, message: 'Dokumen tidak ditemukan.' });

  try {
    const children = [
      new Paragraph({ text: doc.title || 'Untitled', heading: HeadingLevel.TITLE }),
      ...convertQuillHtmlToDocxChildren(doc.contentHtml)
    ];
    const wordDoc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(wordDoc);

    const safeFileName = String(doc.title || 'Untitled').slice(0, 60).replace(/[^a-zA-Z0-9]/g, '_') || 'Notebook';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}.docx"`);
    res.send(buffer);
  } catch (error) {
    console.error('[Notebook Export DOCX] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal membuat file .docx.' });
  }
});

// Ekstrak nomor DOI polos dari url manapun (doi.org link atau field doi terpisah) -
// sumber data kita macam-macam (OpenAlex, Semantic Scholar, popover sitasi) jadi
// formatnya tidak selalu seragam.
function extractDoiFromUrlOrDoi(doi, url) {
  if (doi) return String(doi).replace('https://doi.org/', '').trim();
  const match = String(url || '').match(/doi\.org\/(.+)$/i);
  return match ? match[1].trim() : null;
}

// Daftar folder "Riset" milik user yang login, terbaru dulu, masing-masing disertai
// jumlah referensi di dalamnya (buat ditampilkan sebagai kartu folder).
app.get('/api/my-references/researches', requireAccess, (req, res) => {
  const researches = getSavedResearches().filter(r => r.userId === req.session.userId);
  const references = getSavedReferences();
  const result = researches
    .map(r => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      referenceCount: references.filter(ref => ref.researchId === r.id).length
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, researches: result });
});

app.post('/api/my-references/researches', requireAccess, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
  if (!name) {
    return res.status(400).json({ ok: false, message: 'Nama riset wajib diisi.' });
  }
  const researches = getSavedResearches();
  const duplicate = researches.find(r => r.userId === req.session.userId && r.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    return res.status(409).json({ ok: false, message: 'Sudah ada riset dengan nama ini.' });
  }
  const newResearch = { id: uuidv4(), userId: req.session.userId, name, createdAt: new Date().toISOString() };
  researches.push(newResearch);
  saveSavedResearches(researches);
  res.json({ ok: true, research: { ...newResearch, referenceCount: 0 } });
});

app.patch('/api/my-references/researches/:id', requireAccess, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
  if (!name) {
    return res.status(400).json({ ok: false, message: 'Nama riset wajib diisi.' });
  }
  const researches = getSavedResearches();
  const research = researches.find(r => r.id === req.params.id && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Riset tidak ditemukan.' });
  }
  research.name = name;
  saveSavedResearches(researches);
  res.json({ ok: true });
});

app.delete('/api/my-references/researches/:id', requireAccess, (req, res) => {
  const researches = getSavedResearches();
  const research = researches.find(r => r.id === req.params.id && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Riset tidak ditemukan.' });
  }
  const remainingResearches = researches.filter(r => r.id !== req.params.id);
  saveSavedResearches(remainingResearches);
  const remainingReferences = getSavedReferences().filter(ref => ref.researchId !== req.params.id);
  saveSavedReferences(remainingReferences);
  const remainingChats = getFolderChats().filter(c => c.researchId !== req.params.id);
  saveFolderChats(remainingChats);
  res.json({ ok: true });
});

// Daftar referensi tersimpan milik user, opsional difilter per riset (?researchId=).
// Tiap referensi disertai field "apa" (in-text/reference/href APA 7 siap pakai,
// lihat buildApaEntryFromSavedReference) - dipakai panel referensi di editor
// Notebook ("Sisipkan Sitasi") supaya klik langsung sisip tanpa panggilan AI
// atau round-trip tambahan ke server.
app.get('/api/my-references', requireAccess, (req, res) => {
  const { researchId } = req.query;
  let references = getSavedReferences().filter(ref => ref.userId === req.session.userId);
  if (researchId) {
    references = references.filter(ref => ref.researchId === researchId);
  }
  references.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  // Per-referensi try/catch: satu record lama/tidak terduga bentuknya TIDAK
  // boleh bikin seluruh daftar gagal dimuat (404/apa:null lebih baik daripada
  // 500 utk seluruh folder) - lihat "Gagal memuat daftar referensi" bug report,
  // panel klien sudah menangani apa:null dgn menyembunyikan tombol Sisipkan.
  const withApa = references.map(ref => {
    try {
      return Object.assign({}, ref, { apa: buildApaEntryFromSavedReference(ref) });
    } catch (err) {
      console.error('[My References] Gagal menyusun format APA utk referensi', ref.id, ':', err.message);
      return Object.assign({}, ref, { apa: null });
    }
  });
  res.json({ ok: true, references: withApa });
});

// Simpan 1 paper ke folder riset tertentu + generate TL;DR dwibahasa sekaligus
// (kalau ada abstrak). Sumbernya bisa dari Cari Referensi, atau popover sitasi
// (Lit Review/JurnalHub Intelligence/SLR/Riwayat) - makanya field abstract/doi/dll
// semua opsional, bergantung data apa yang tersedia di sumbernya.
app.post('/api/my-references', requireAccess, savedReferenceLimiter, async (req, res) => {
  const body = req.body || {};
  const researchId = String(body.researchId || '').trim();
  const title = String(body.title || '').trim().slice(0, 500);
  if (!researchId) {
    return res.status(400).json({ ok: false, message: 'Pilih folder riset terlebih dahulu.' });
  }
  if (!title) {
    return res.status(400).json({ ok: false, message: 'Paper ini tidak punya judul, tidak bisa disimpan.' });
  }

  const researches = getSavedResearches();
  const research = researches.find(r => r.id === researchId && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Folder riset tidak ditemukan.' });
  }

  const doi = extractDoiFromUrlOrDoi(body.doi, body.url);
  const references = getSavedReferences();

  const duplicate = references.find(ref => ref.researchId === researchId && ref.userId === req.session.userId && (
    (doi && ref.doi === doi) || (!doi && ref.title.trim().toLowerCase() === title.toLowerCase())
  ));
  if (duplicate) {
    return res.status(409).json({ ok: false, message: 'Paper ini sudah ada di riset tersebut.' });
  }

  const abstract = String(body.abstract || '').trim().slice(0, 1500);
  let tldrEn = null;
  let tldrId = null;
  if (abstract) {
    try {
      const tldr = await generateBilingualTldr(title, abstract, req.session.userId, isAdminReq(req));
      tldrEn = tldr.en;
      tldrId = tldr.id;
    } catch (error) {
      // TL;DR gagal (mis. DeepSeek down) tidak menggagalkan penyimpanan paper-nya -
      // papernya tetap tersimpan, kolom TL;DR cukup kosong dan bisa dicoba lagi nanti.
      console.error('[My References] Gagal membuat TL;DR saat menyimpan:', error.message);
    }
  }

  const newReference = {
    id: uuidv4(),
    userId: req.session.userId,
    researchId,
    title,
    type: String(body.type || 'article').trim().slice(0, 50),
    authors: String(body.authors || '').trim().slice(0, 500),
    journal: String(body.journal || '').trim().slice(0, 300),
    year: String(body.year || '').trim().slice(0, 10),
    doi,
    url: String(body.url || '').trim().slice(0, 1000),
    pdfUrl: String(body.pdfUrl || '').trim().slice(0, 1000) || null,
    abstract,
    tldrEn,
    tldrId,
    savedAt: new Date().toISOString()
  };
  references.push(newReference);
  saveSavedReferences(references);
  res.json({ ok: true, reference: newReference });
});

app.delete('/api/my-references/:id', requireAccess, (req, res) => {
  const references = getSavedReferences();
  const reference = references.find(ref => ref.id === req.params.id && ref.userId === req.session.userId);
  if (!reference) {
    return res.status(404).json({ ok: false, message: 'Referensi tidak ditemukan.' });
  }
  const remaining = references.filter(ref => ref.id !== req.params.id);
  saveSavedReferences(remaining);
  res.json({ ok: true });
});

// JurnalHub Intelligence for Folder khusus akun Premium & Ultimate (unlimited) -
// Free tidak dapat akses sama sekali (dikunci di UI juga, tapi tetap dicek
// server-side supaya tidak bisa dilewati lewat panggilan API langsung).
function requireFolderChatAccess(req, res, next) {
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  const userType = (user && user.type) || 'free';
  if (!isAdminReq(req) && userType !== 'premium' && userType !== 'ultimate') {
    return res.status(403).json({ ok: false, message: 'JurnalHub Intelligence for Folder khusus akun Premium & Ultimate. Upgrade untuk akses tanpa batas.' });
  }
  next();
}

// Riwayat chatbot folder Koleksi Saya - dicek dulu kepemilikan foldernya sebelum
// mengembalikan pesan (permanen, disimpan di folder-chats.json).
app.get('/api/my-references/researches/:id/chat', requireAccess, requireFolderChatAccess, (req, res) => {
  const research = getSavedResearches().find(r => r.id === req.params.id && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Riset tidak ditemukan.' });
  }
  const chat = getFolderChats().find(c => c.researchId === req.params.id && c.userId === req.session.userId);
  res.json({ ok: true, messages: chat ? chat.messages : [] });
});

// Hapus seluruh riwayat obrolan folder ("Clear Chat") - foldernya sendiri &
// papernya tidak ikut terhapus, cuma riwayat chat-nya.
app.delete('/api/my-references/researches/:id/chat', requireAccess, requireFolderChatAccess, (req, res) => {
  const research = getSavedResearches().find(r => r.id === req.params.id && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Riset tidak ditemukan.' });
  }
  const chats = getFolderChats().filter(c => !(c.researchId === req.params.id && c.userId === req.session.userId));
  saveFolderChats(chats);
  res.json({ ok: true });
});

// Ambil teks lengkap paper dari PDF open-access (best-effort) supaya JurnalHub
// Intelligence for Folder bisa menjawab berdasarkan isi penuh paper, bukan cuma
// abstrak/TL;DR - hanya berhasil kalau papernya open-access dan linknya memang
// mengarah ke file PDF yang bisa diakses publik. Dipotong ke beberapa ribu kata
// pertama supaya biaya token DeepSeek tetap terkendali per paper.
const FULL_TEXT_MAX_WORDS = 4000;
async function fetchFullTextFromPdfUrl(pdfUrl) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchFn(pdfUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JurnalHubBot/1.0)' } });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > 20 * 1024 * 1024) return null; // batas 20MB, hindari file raksasa
    const rawText = (await parsePdfBuffer(buffer) || '').trim();
    if (!rawText) return null;
    const words = rawText.split(/\s+/).filter(Boolean);
    return words.slice(0, FULL_TEXT_MAX_WORDS).join(' ');
  } catch (error) {
    console.warn('[Full Text Fetch] Gagal ambil/parse PDF:', error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Chatbot per folder Koleksi Saya - jawabannya dibatasi HANYA ke paper yang
// tersimpan di folder ini (full-text PDF open-access kalau berhasil diambil,
// fallback ke abstrak/TL;DR), dan wajib mensitasi paper yang dirujuk pakai
// format [n] supaya bisa dipertanggungjawabkan lewat kartu popover sitasi yang
// sama seperti Lit Review/SLR di frontend.
app.post('/api/my-references/researches/:id/chat', requireAccess, requireFolderChatAccess, folderChatLimiter, async (req, res) => {
  const researchId = req.params.id;
  const research = getSavedResearches().find(r => r.id === researchId && r.userId === req.session.userId);
  if (!research) {
    return res.status(404).json({ ok: false, message: 'Riset tidak ditemukan.' });
  }

  const message = String((req.body && req.body.message) || '').trim().slice(0, 2000);
  if (!message) {
    return res.status(400).json({ ok: false, message: 'Pertanyaan tidak boleh kosong.' });
  }

  const papers = getSavedReferences().filter(ref => ref.researchId === researchId && ref.userId === req.session.userId);
  if (papers.length === 0) {
    return res.status(400).json({ ok: false, message: 'Folder ini belum punya paper tersimpan.' });
  }

  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, message: 'JurnalHub Intelligence belum dikonfigurasi di server.' });
  }

  // Kuota Folder Chat sekarang juga dijatah lewat DEEPSEEK POOL bersama (dulu
  // premium/ultimate unlimited tanpa batas sama sekali selain rate limiter menit)
  const poolUsers = getUsers();
  const poolUser = poolUsers.find(u => u.id === req.session.userId);
  if (poolUser && !requireDeepSeekPoolAccess(req, res, poolUser)) return;

  // Coba ambil full-text PDF untuk paper open-access yang belum pernah dicoba
  // sebelumnya - dibatasi jumlah percobaan per request biar tidak memperlambat
  // respons chat kalau foldernya besar. Hasilnya (berhasil/gagal) di-cache
  // permanen ke saved-references.json supaya tidak diulang tiap kali chat.
  const MAX_FULLTEXT_ATTEMPTS_PER_REQUEST = 3;
  let attemptsLeft = MAX_FULLTEXT_ATTEMPTS_PER_REQUEST;
  let papersUpdated = false;
  for (const p of papers) {
    if (p.fullTextStatus || !p.pdfUrl || attemptsLeft <= 0) continue;
    attemptsLeft--;
    const text = await fetchFullTextFromPdfUrl(p.pdfUrl);
    p.fullText = text || null;
    p.fullTextStatus = text ? 'ok' : 'failed';
    papersUpdated = true;
  }
  if (papersUpdated) {
    const allRefs = getSavedReferences();
    for (const p of papers) {
      const idx = allRefs.findIndex(r => r.id === p.id);
      if (idx !== -1) {
        allRefs[idx].fullText = p.fullText;
        allRefs[idx].fullTextStatus = p.fullTextStatus;
      }
    }
    saveSavedReferences(allRefs);
  }

  const paperListText = papers.map((p, idx) => {
    const content = (p.fullTextStatus === 'ok' && p.fullText)
      ? `Isi Lengkap Paper (dipotong ${FULL_TEXT_MAX_WORDS} kata pertama):\n${p.fullText}`
      : `Ringkasan: ${p.tldrId || p.tldrEn || p.abstract || '-'}`;
    return `[${idx + 1}] ${p.title}
Penulis: ${p.authors || '-'}
Jurnal: ${p.journal || '-'} (${p.year || '-'})
${content}`;
  }).join('\n\n');

  const systemPrompt = `Kamu adalah asisten riset di JurnalHub yang membantu pengguna memahami kumpulan paper yang mereka simpan di folder "${research.name}". Jawab HANYA berdasarkan daftar paper di bawah ini - jangan mengarang klaim, data, atau paper lain di luar daftar. Sebagian paper disertai isi lengkap (full-text), sebagian lain hanya ringkasan/abstrak - kalau isi lengkapnya tidak tersedia, jangan berpura-pura tahu detail yang tidak disebutkan di ringkasan. Kalau pertanyaan pengguna tidak bisa dijawab dari paper-paper ini, katakan terus terang.

Setiap kali menyebut/merujuk klaim dari salah satu paper, tulis sitasi dalam format angka bernomor dalam kurung siku, contoh [2], sesuai nomor urut paper pada daftar di bawah - taruh tepat setelah klausa/kalimat yang didukung paper tersebut. JANGAN pakai format (Penulis, Tahun). Jawab dalam bahasa yang sama dengan bahasa pertanyaan pengguna.

Daftar paper di folder ini:
${paperListText}`;

  const citations = papers.map(p => ({
    title: p.title,
    authors: p.authors,
    journal: p.journal,
    year: p.year,
    url: p.url || (p.doi ? `https://doi.org/${p.doi}` : null),
    doi: p.doi || null,
    abstract: p.abstract || ''
  }));

  try {
    const fetchFn = globalThis.fetch || require('node-fetch');
    const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 2000,
        stream: false,
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      })
    });

    if (!dsResponse.ok) {
      const errText = await dsResponse.text();
      throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
    }

    const dsData = await dsResponse.json();
    const reply = dsData?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error('Respons AI kosong.');
    }

    if (poolUser) recordDeepSeekPoolUsage(poolUser.id, dsData?.usage?.total_tokens);

    const chats = getFolderChats();
    let chat = chats.find(c => c.researchId === researchId && c.userId === req.session.userId);
    const now = new Date().toISOString();
    const userMsg = { role: 'user', content: message, timestamp: now };
    const assistantMsg = { role: 'assistant', content: reply, citations, timestamp: now };
    if (chat) {
      chat.messages.push(userMsg, assistantMsg);
      chat.updatedAt = now;
    } else {
      chat = { id: uuidv4(), researchId, userId: req.session.userId, messages: [userMsg, assistantMsg], updatedAt: now };
      chats.push(chat);
    }
    saveFolderChats(chats);

    res.json({ ok: true, reply, citations });
  } catch (error) {
    console.error('[Koleksi Saya Chat] Error:', error.message);
    res.status(500).json({ ok: false, message: 'Gagal menghubungi AI: ' + error.message });
  }
});

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
    const response = await fetchFn('https://api.semanticscholar.org/graph/v1/paper/batch?fields=tldr,influentialCitationCount,openAccessPdf', {
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
        influentialCitationCount: match.influentialCitationCount ?? null,
        pdfUrl: match.openAccessPdf?.url || null
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

  // Kuota sekarang berbasis DEEPSEEK POOL bersama (kredit/minggu) - bukan
  // hitungan kaku 3x/15x per bulan lagi, lihat requireDeepSeekPoolAccess.
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const tier = user ? (user.type || 'free') : 'free';
  const isDeepTier = tier === 'ultimate' && requestedMode === 'pro';

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {

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

    // 2. Enrichment - ambil tldr, influential citation count, dan link PDF Open Access
    // dari Semantic Scholar. Berlaku untuk semua mode (bukan cuma Pro/Deep) - satu kali
    // batch request per generate (bukan per-paper), best-effort & gagal diam-diam kalau
    // rate limit, jadi aman dipakai di mode standar juga.
    papers = await enrichWithSemanticScholar(papers);

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

    const systemPrompt = `Anda adalah pakar penulisan jurnal ilmiah internasional. Tulis Tinjauan Pustaka (Literature Review) dalam Bahasa Indonesia HANYA berdasarkan daftar paper ilmiah asli yang diberikan user - JANGAN mengarang paper/data lain di luar yang diberikan. Rujuk paper HANYA dengan format angka bernomor dalam kurung siku, contoh [3], sesuai nomor urut paper pada daftar yang diberikan - taruh tepat setelah klausa/kalimat yang didukung paper tersebut. JANGAN memakai format (Penulis, Tahun). Satu kalimat boleh merujuk lebih dari satu paper, contoh [2][5]. Output HARUS berupa HTML mentah saja (pakai tag h4/h5, p, ul/li, strong, table/tr/td), TANPA pembungkus markdown, TANPA JSON, TANPA preamble/penjelasan - langsung isi tinjauan pustakanya.`;

    const userPrompt = `Judul penelitian: ${title}\nKeyword/Bidang: ${keywords || '-'}\nAbstrak: ${abstract || '-'}\n\nDaftar paper ilmiah hasil pencarian (gunakan ini sebagai satu-satunya sumber):\n${paperListText}\n\n${depthInstructions}\n\nTulis tinjauan pustakanya sekarang (HTML mentah saja):`;

    const litReviewStreamResult = await streamDeepSeekCompletion(res, deepSeekKey, {
      model: 'deepseek-v4-flash',
      max_tokens: 3000,
      thinking: { type: 'disabled' },
      extra_body: { thinking: { type: 'disabled' } },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const review = litReviewStreamResult.fullContent.trim();
    if (user) recordDeepSeekPoolUsage(user.id, litReviewStreamResult.usage?.total_tokens);

    if (!review) {
      console.error('[Lit Review DeepSeek] Respons kosong dari DeepSeek.');
      res.end();
      return;
    }

    // Citations dibangun langsung dari data OpenAlex/Semantic Scholar (bukan dari LLM) -
    // jadi selalu valid & tidak mungkin "kepotong" seperti pendekatan lama. Dikirim
    // sebagai chunk terakhir setelah teks selesai di-stream (lihat pola yang sama
    // di /api/research-chat).
    const citations = papers.map(p => ({
      title: p.title,
      authors: p.authors,
      journal: p.journal,
      year: p.year,
      url: p.url,
      doi: p.doi || null,
      citedByCount: p.citedByCount,
      isOpenAccess: p.isOpenAccess,
      pdfUrl: p.pdfUrl || null,
      abstract: p.abstract ? p.abstract.slice(0, 280) : '',
      reason: p.tldr
        ? p.tldr
        : `Dikutip ${p.citedByCount}x, relevan dengan topik penelitian berdasarkan abstrak.${p.isOpenAccess ? ' (Open Access)' : ''}`
    }));
    res.write(JSON.stringify({ type: 'citations', citations }) + '\n');
    res.end();

    addHistoryItem(req.session.userId, 'lit-review', { title, keywords, abstract }, { review, citations });
  } catch (error) {
    console.error('[Lit Review] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Gagal mencari referensi & membuat literature review: ' + error.message });
    } else {
      res.end();
    }
  }
});

// --- SYSTEMATIC LITERATURE REVIEW (SLR) ---

// Helper searchOpenAlexWorksFull: mengambil data abstrak utuh (tidak dislice terlalu pendek)
async function searchOpenAlexWorksFull(query, perPage, extraFilter) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const cleanQuery = String(query || '').replace(/[?*]/g, ' ').replace(/\s+/g, ' ').trim();
  const params = new URLSearchParams({
    search: cleanQuery,
    per_page: String(perPage),
    filter: `has_abstract:true${extraFilter || ''}`,
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
      if (!abstract) return null;
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
        abstract: abstract.slice(0, 3000)
      };
    })
    .filter(Boolean);
}

// Helper searchSemanticScholarWorksFull: melakukan pencarian artikel via API Semantic Scholar
async function searchSemanticScholarWorksFull(query, limit) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const cleanQuery = String(query || '').replace(/[?*]/g, ' ').replace(/\s+/g, ' ').trim();
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(cleanQuery)}&limit=${limit}&fields=title,authors,year,venue,citationCount,isOpenAccess,openAccessPdf,abstract,externalIds`;
    const response = await fetchFn(url, { headers });
    if (!response.ok) return [];

    const data = await response.json();
    const results = Array.isArray(data.data) ? data.data : [];

    return results.map(p => {
      if (!p.abstract || !p.title) return null;
      const authorNames = (p.authors || []).map(a => a.name).filter(Boolean);
      const authors = authorNames.length > 3
        ? `${authorNames.slice(0, 3).join(', ')}, et al.`
        : authorNames.join(', ') || 'Tidak diketahui';
      const doi = p.externalIds?.DOI || null;
      return {
        source: 'Semantic Scholar',
        title: p.title,
        authors,
        journal: p.venue || 'Semantic Scholar',
        year: p.year ? String(p.year) : '-',
        doi,
        url: doi ? `https://doi.org/${doi}` : (p.openAccessPdf?.url || '#'),
        citedByCount: p.citationCount || 0,
        isOpenAccess: !!p.isOpenAccess,
        abstract: p.abstract.slice(0, 3000)
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('[Semantic Scholar Search] Error:', err.message);
    return [];
  }
}

// Endpoint pencarian paper SLR (Multi-database: OpenAlex + Semantic Scholar)
app.post('/api/slr/search', requireAccess, async (req, res) => {
  const { query, startYear, endYear, oaOnly, limit } = req.body;
  if (!query || String(query).trim().length < 3) {
    return res.status(400).json({ ok: false, message: 'Kata kunci pencarian minimal 3 karakter.' });
  }

  try {
    let extraFilter = '';
    const sy = parseInt(startYear);
    const ey = parseInt(endYear);
    if (!isNaN(sy) && !isNaN(ey)) {
      extraFilter += `,publication_year:${sy}-${ey}`;
    }
    if (oaOnly === true) {
      extraFilter += ',is_oa:true';
    }

    const maxResults = Math.min(100, Math.max(5, parseInt(limit) || 20));

    const [openAlexRes, ssRes] = await Promise.allSettled([
      searchOpenAlexWorksFull(query, maxResults, extraFilter),
      searchSemanticScholarWorksFull(query, maxResults)
    ]);

    const openAlexPapers = openAlexRes.status === 'fulfilled' ? openAlexRes.value : [];
    const ssPapers = ssRes.status === 'fulfilled' ? ssRes.value : [];

    openAlexPapers.forEach(p => p.source = 'OpenAlex');

    // Deduplicate by title
    const seenTitles = new Set();
    const combinedPapers = [];

    const allCandidatePapers = [...openAlexPapers, ...ssPapers];
    allCandidatePapers.forEach(p => {
      const normTitle = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normTitle && !seenTitles.has(normTitle)) {
        seenTitles.add(normTitle);
        combinedPapers.push(p);
      }
    });

    const papers = combinedPapers.slice(0, maxResults);

    res.json({
      ok: true,
      papers,
      sources: {
        openAlex: openAlexPapers.length,
        semanticScholar: ssPapers.length,
        totalCombined: papers.length
      }
    });
  } catch (error) {
    console.error('[SLR Search] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal mencari paper: ' + error.message });
  }
});

// Endpoint Sintesis SLR dengan DeepSeek (Berstandar PRISMA 2020 + Risk of Bias)
app.post('/api/slr/synthesize', requireAccess, async (req, res) => {
  const { papers, researchQuestions, inclusionCriteria, exclusionCriteria } = req.body;
  if (!Array.isArray(papers) || papers.length === 0) {
    return res.status(400).json({ ok: false, message: 'Daftar paper kosong atau tidak valid.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);

  // Kuota SLR Synthesize sekarang berbasis DEEPSEEK POOL bersama (kredit/minggu)
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di Railway.' });
  }

  const fetchFn = globalThis.fetch || require('node-fetch');

  try {
    // Bangun teks daftar paper
    const paperListText = papers.map((p, idx) => {
      return `[Paper ${idx + 1}]
Judul: ${p.title}
Penulis: ${p.authors}
Jurnal: ${p.journal}
Tahun: ${p.year}
Sitasi: ${p.citedByCount || 0}
Sumber: ${p.source || 'OpenAlex'}
Abstrak: ${p.abstract}`;
    }).join('\n\n');

    const systemPrompt = `Anda adalah pakar Systematic Literature Review (SLR) akademik berstandar PRISMA 2020. Tugas Anda adalah melakukan evaluasi metodologi, penilaian Risiko Bias (Risk of Bias Assessment), dan sintesis secara komprehensif terhadap daftar paper yang diberikan berdasarkan kriteria inklusi, eksklusi, dan pertanyaan penelitian.

Wajib mengembalikan output dalam format JSON MENTAH SAJA (TANPA pembungkus markdown seperti \`\`\`json ... \`\`\`, TANPA penjelasan tambahan). JSON harus memiliki struktur persis seperti berikut:
{
  "screenedPapers": [
    {
      "title": "Judul paper",
      "verdict": "Included" atau "Excluded",
      "reason": "Alasan penyaringan singkat yang mengacu pada kriteria inklusi/eksklusi"
    }
  ],
  "prisma": {
    "identified": total paper awal,
    "screened": total paper yang dinilai,
    "eligible": total paper yang lolos kriteria inklusi,
    "included": total paper yang disintesis
  },
  "matrix": [
    {
      "paperIndex": nomor urut paper ini sesuai label [Paper N] pada daftar yang diberikan (integer, misal 1 untuk [Paper 1]),
      "title": "Judul paper - salin PERSIS sama seperti judul aslinya pada daftar, jangan diringkas/diparafrase",
      "authorYear": "Nama Penulis & Tahun (misal: Smith et al., 2023)",
      "methodology": "Metode penelitian yang digunakan (misal: Kuantitatif Survei, Kualitatif Wawancara, Eksperimen)",
      "findings": "Temuan atau hasil utama penelitian",
      "gap": "Celah penelitian (gap) atau keterbatasan yang disebutkan",
      "riskOfBias": {
        "rating": "Low Risk", "Moderate Risk", atau "High Risk",
        "reason": "1 kalimat ringkas alasan penilaian risiko bias / evaluasi kualitas metodologi"
      }
    }
  ],
  "narrative": "Teks analisis naratif SLR lengkap berstandar PRISMA 2020 dalam Bahasa Indonesia (berisi subbab: 1. Karakteristik Umum Studi, 2. Analisis Metodologi & Penilaian Risiko Bias (Risk of Bias), 3. Sintesis Temuan Utama per Pertanyaan Penelitian, 4. Celah Penelitian (Research Gaps) & Implikasi Riset Masa Depan). Gunakan format HTML untuk penulisan teks ini (tag h4/h5, p, ul/li, strong) dan wajib menyertakan sitasi dalam teks format (Penulis, Tahun)."
}`;

    const userPrompt = `Daftar Paper:\n${paperListText}\n\nPertanyaan Penelitian (Research Questions):\n${researchQuestions || '-'}\n\nKriteria Inklusi:\n${inclusionCriteria || '-'}\n\nKriteria Eksklusi:\n${exclusionCriteria || '-'}\n\nLakukan analisis screening, hitung diagram PRISMA, bangun tabel matriks sintesis, dan tulis narasi SLR lengkap sekarang. Kembalikan HANYA dalam format JSON sesuai spesifikasi system prompt:`;

    const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 8192,
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
    let content = choice?.message?.content?.trim();
    if (!content && choice?.message?.reasoning_content) {
      content = String(choice.message.reasoning_content).trim();
    }

    if (!content) {
      throw new Error('Respons AI kosong saat melakukan sintesis SLR.');
    }

    // Bersihkan pembungkus markdown JSON jika ada
    let cleanText = content.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleanText);
    } catch (parseError) {
      console.warn('[SLR Synthesis] Direct JSON parse failed, attempting auto-repair...', parseError.message);
      try {
        let repaired = cleanText;
        const quoteMatches = (repaired.match(/"/g) || []).length;
        if (quoteMatches % 2 !== 0) repaired += '"';

        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        const openBrackets = (repaired.match(/\[/g) || []).length;
        const closeBrackets = (repaired.match(/\]/g) || []).length;

        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
        for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';

        parsedResult = JSON.parse(repaired);
      } catch (repairErr) {
        console.error('[SLR Synthesis] JSON Parse Error. Raw Text Snippet:', cleanText.slice(-300));
        throw new Error('Format respon AI terpotong/tidak valid JSON: ' + parseError.message);
      }
    }

    if (user) recordDeepSeekPoolUsage(user.id, dsData?.usage?.total_tokens);

    // Tambahkan item riwayat SLR
    addHistoryItem(req.session.userId, 'slr', {
      query: `SLR: ${papers.length} artikel`,
      questions: researchQuestions,
      criteria: { inclusion: inclusionCriteria, exclusion: exclusionCriteria }
    }, parsedResult);

    res.json({ ok: true, result: parsedResult });
  } catch (error) {
    console.error('[SLR Synthesize] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal melakukan sintesis SLR: ' + error.message });
  }
});

// Endpoint untuk generate kriteria & research questions otomatis dengan DeepSeek
app.post('/api/slr/generate-criteria', requireAccess, async (req, res) => {
  const { query, field } = req.body;
  if (!query || !field) {
    return res.status(400).json({ ok: false, message: 'Topik/Query dan kolom wajib diisi.' });
  }

  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di Railway.' });
  }

  // Sebelumnya sama sekali tidak dijatah (bukan hitungan bulanan, bukan rate
  // limiter) - sekarang ikut DEEPSEEK POOL bersama seperti fitur lain.
  const criteriaUsers = getUsers();
  const criteriaUser = criteriaUsers.find(u => u.id === req.session.userId);
  if (criteriaUser && !requireDeepSeekPoolAccess(req, res, criteriaUser)) return;

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  let systemPrompt = "Anda adalah pakar akademisi riset. Berikan saran kriteria atau pertanyaan penelitian untuk topik Systematic Literature Review (SLR) yang diberikan.\n\nPENTING SESUAIKAN BAHASA: Deteksi dan gunakan BAHASA YANG SAMA persis dengan bahasa topik/judul yang diberikan pengguna. Jika topik/judul dalam Bahasa Inggris, jawab seluruh poin dalam Bahasa Inggris akademis. Jika topik dalam Bahasa Indonesia, jawab dalam Bahasa Indonesia.\n\nFormat output: Jawab berupa poin-poin ringkas menggunakan tanda hubung (-). Kembalikan HANYA poin-poin tersebut tanpa intro, salam, atau teks pengantar apapun.";
  let userPrompt = "";
  if (field === 'questions') {
    userPrompt = `Tuliskan 3 Pertanyaan Penelitian (Research Questions) yang relevan dan kritis untuk studi SLR dengan topik/kata kunci: "${query}"`;
  } else if (field === 'inclusion') {
    userPrompt = `Tuliskan 3 kriteria inklusi (Inclusion Criteria) yang relevan untuk studi SLR dengan topik/kata kunci: "${query}"`;
  } else if (field === 'exclusion') {
    userPrompt = `Tuliskan 3 kriteria eksklusi (Exclusion Criteria) yang relevan untuk studi SLR dengan topik/kata kunci: "${query}"`;
  }

  try {
    const dsResponse = await fetchFn(deepSeekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepSeekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 1000,
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
    let content = choice?.message?.content?.trim();
    if (!content && choice?.message?.reasoning_content) {
      content = String(choice.message.reasoning_content).trim();
    }

    if (criteriaUser) recordDeepSeekPoolUsage(criteriaUser.id, dsData?.usage?.total_tokens);

    res.json({ ok: true, suggestions: content });
  } catch (error) {
    console.error('[SLR Generate Criteria] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal men-generate kriteria: ' + error.message });
  }
});

// Endpoint untuk melakukan penyaringan (screening) artikel secara otomatis dengan DeepSeek
app.post('/api/slr/auto-screen', requireAccess, async (req, res) => {
  const { query, questions, inclusion, exclusion, papers } = req.body;
  if (!Array.isArray(papers) || papers.length === 0) {
    return res.status(400).json({ ok: false, message: 'Daftar paper kosong atau tidak valid.' });
  }

  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di Railway.' });
  }

  // Sebelumnya sama sekali tidak dijatah - sekarang ikut DEEPSEEK POOL bersama.
  const screenUsers = getUsers();
  const screenUser = screenUsers.find(u => u.id === req.session.userId);
  if (screenUser && !requireDeepSeekPoolAccess(req, res, screenUser)) return;

  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  const systemPrompt = `Anda adalah asisten screening riset untuk Systematic Literature Review (SLR).
Evaluasi daftar paper yang diberikan berdasarkan Kriteria Inklusi, Kriteria Eksklusi, dan Pertanyaan Penelitian.
Kembalikan keputusan screening (include atau exclude) untuk SETIAP paper.

Wajib mengembalikan output dalam format JSON MENTAH SAJA (TANPA pembungkus markdown seperti \`\`\`json ... \`\`\`, TANPA penjelasan tambahan).
JSON harus berupa array obyek dengan format seperti berikut:
[
  {
    "id": "ID/Indeks paper yang dikirimkan",
    "decision": "include" atau "exclude",
    "reason": "Penjelasan singkat mengapa paper ini diterima/ditolak berdasarkan kriteria inklusi/eksklusi (dalam Bahasa Indonesia)."
  }
]`;

  const paperListText = papers.map((p) => {
    return `ID: ${p.id}
Judul: ${p.title}
Abstrak: ${p.abstract || '(Tanpa abstrak)'}`;
  }).join('\n\n');

  const userPrompt = `Topik SLR: "${query || '-'}"
Pertanyaan Penelitian:
${questions || '-'}

Kriteria Inklusi:
${inclusion || '-'}

Kriteria Eksklusi:
${exclusion || '-'}

Daftar Paper yang dinilai:
${paperListText}

Evaluasi masing-masing paper tersebut dan kembalikan array keputusan dalam JSON:`;

  try {
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
    let content = choice?.message?.content?.trim();
    if (!content && choice?.message?.reasoning_content) {
      content = String(choice.message.reasoning_content).trim();
    }

    if (!content) {
      throw new Error('Respons AI kosong saat melakukan auto-screening.');
    }

    if (screenUser) recordDeepSeekPoolUsage(screenUser.id, dsData?.usage?.total_tokens);

    let cleanText = content.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleanText);
    } catch (parseError) {
      console.error('[SLR Auto-Screen] JSON Parse Error. Raw Text:', cleanText);
      throw new Error('Format respon AI tidak valid JSON: ' + parseError.message);
    }

    res.json({ ok: true, results: parsedResult });
  } catch (error) {
    console.error('[SLR Auto-Screen] Error:', error);
    res.status(500).json({ ok: false, message: 'Gagal melakukan auto-screening: ' + error.message });
  }
});

// --- AI Peer Reviewer & Pre-Submission Evaluator (DeepSeek) ---
app.post('/api/peer-review', requireAccess, async (req, res) => {
  const { title, abstract, text, targetJournal } = req.body;
  const contentToReview = (text || abstract || title || '').trim();

  if (!contentToReview) {
    return res.status(400).json({ ok: false, message: 'Harap masukkan judul, abstrak, atau teks naskah penelitian Anda.' });
  }

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);

  // Kuota AI Peer Reviewer sekarang berbasis DEEPSEEK POOL bersama (kredit/minggu)
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const deepSeekKey = getDeepSeekApiKey();
  if (!deepSeekKey) {
    return res.status(500).json({ ok: false, message: 'DeepSeek API Key belum dikonfigurasi di server.' });
  }

  const systemPrompt = `Anda adalah Tim Reviewer Jurnal Senior (Reviewer 1 & Reviewer 2) dan Editor-in-Chief untuk jurnal ilmiah bereputasi (SINTA / Scopus).
Tugas Anda adalah memberikan evaluasi pre-submission yang sangat objektif, kritis, profesional, dan konstruktif terhadap draf naskah/abstrak ilmiah yang dikirimkan.

Panduan Struktur Laporan Evaluasi:
1. **Ringkasan Penilaian & Keputusan Reviewer**:
   - **Target Jurnal**: ${targetJournal || 'Umum / SINTA / Scopus'}
   - **Prediksi Acceptance Rate / Match Score**: (Tuliskan skor % persentase kelayakan diterima, contoh: 85%)
   - **Rekomendasi Keputusan**: (Pilih satu: Accept / Minor Revision / Major Revision / Reject / Desk Reject)
2. **Kelebihan Utama Naskah (Strengths)**: 2-3 poin unggul dari naskah.
3. **Evaluasi Kritis per Seksi**:
   - **Judul & Abstrak**: Kejelasan IMRaD, daya tarik, dan kekompakan narasi.
   - **Latar Belakang & Celah Riset (Research Gap)**: Kebijakan masalah, urgensi, dan kejelasan celah riset yang diisi.
   - **Metodologi & Desain Riset**: Kekuatan statistik/pendekatan, kecukupan data, serta potensi keteledoran metodologis.
   - **Kebaruan (Novelty) & Kontribusi Ilmiah**: Seberapa kuat klaim novelty dibanding riset terdahulu.
   - **Referensi & Gaya Bahasa Akademis**: Kesesuaian rujukan dan kerapian penulisan ilmiah.
4. **Peringatan Dini Penolakan (Desk Reject Warnings)**: Poin-poin fatal jika ada yang berpotensi langsung ditolak oleh editor jurnal sebelum dikirim ke reviewer.
5. **Langkah Perbaikan Prioritas (Actionable Fixes)**: Daftar tindakan perbaikan langkah-demi-langkah berurut dari prioritas tertinggi.

Formatlah laporan menggunakan Markdown yang sangat rapi. PENTING: Gunakan header standar tanpa cetak tebal di dalam tag header (contoh: "### Laporan Evaluasi", BUKAN "### **Laporan...**"). Berikan spasi yang jelas setelah ### dan ####, serta gunakan bullet points. Wajib gunakan bahasa yang sama dengan naskah (Bahasa Indonesia jika naskah Bahasa Indonesia, Bahasa Inggris jika naskah Bahasa Inggris).`;

  const userPrompt = `Target Jurnal / Tingkatan: ${targetJournal || 'Jurnal Bereputasi (SINTA / Scopus)'}
${title ? `Judul Naskah: "${title}"\n` : ''}
Isi Naskah / Abstrak Penelitian:
"""
${contentToReview.slice(0, 45000)}
"""`;

  try {
    const peerReviewStreamResult = await streamDeepSeekCompletion(res, deepSeekKey, {
      model: 'deepseek-v4-flash',
      max_tokens: 3500,
      thinking: { type: 'disabled' },
      extra_body: { thinking: { type: 'disabled' } },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const reviewContent = peerReviewStreamResult.fullContent.trim();
    if (user) recordDeepSeekPoolUsage(user.id, peerReviewStreamResult.usage?.total_tokens);

    res.end();

    if (!reviewContent) {
      console.error('[AI Peer Reviewer] Respons kosong dari DeepSeek.');
      return;
    }
  } catch (error) {
    console.error('[AI Peer Reviewer] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Gagal melakukan evaluasi peer reviewer: ' + error.message });
    } else {
      res.end();
    }
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
  if (!isAdminReq(req) && userType === 'free') {
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

    if (!isAdminReq(req) && remaining < wordCount) {
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
    console.log(`[Humanizer] Calling StealthGPT async API for user ${req.session.userId || 'unknown'} (${wordCount} words)`);
    const fetchFn = globalThis.fetch || require('node-fetch');

    // Endpoint async (submit run lalu poll status) dipakai untuk menggantikan
    // endpoint sinkron lama yang sering timeout di teks panjang (dulu dipotong
    // paksa 25 detik). Billing-nya sama (1 credit per kata input+output), cuma
    // arsitekturnya beda - tidak ada batas waktu tunggu kaku seperti sebelumnya.
    // Endpoint ini tidak punya parameter "tone" (Academic/Standard) seperti versi
    // lama - dipetakan ke qualityMode+model sebagai gantinya (Academic = kualitas
    // maksimal, Standard = lebih cepat) supaya pilihan mode di UI tetap berarti.
    const isAcademicMode = mode === 'academic';
    const createController = new AbortController();
    const createTimeoutId = setTimeout(() => createController.abort(), 15000);
    let createResponse;
    try {
      createResponse = await fetchFn('https://stealthgpt.ai/api/stealthify/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-token': stealthApiKey.trim()
        },
        body: JSON.stringify({
          text: cleanText,
          qualityMode: isAcademicMode ? 'quality' : 'fast',
          model: isAcademicMode ? 'heavy' : 'lite',
          outputFormat: 'text'
        }),
        signal: createController.signal
      });
    } finally {
      clearTimeout(createTimeoutId);
    }

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('[Humanizer] StealthGPT create-run error status:', createResponse.status, errorText);
      throw new Error(`StealthGPT API returned status ${createResponse.status}`);
    }

    const createData = await createResponse.json();
    const runId = createData.runId;
    if (!runId) {
      throw new Error('StealthGPT tidak mengembalikan runId.');
    }

    // Poll status run tiap 4 detik, maksimal ~110 detik total (cukup untuk teks
    // panjang di mode "quality") sebelum menyerah dengan pesan timeout yang jelas.
    const pollUrl = `https://stealthgpt.ai/api/stealthify/runs/${encodeURIComponent(runId)}`;
    const pollIntervalMs = 4000;
    const maxPolls = 27;
    let resData = null;
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const pollController = new AbortController();
      const pollTimeoutId = setTimeout(() => pollController.abort(), 10000);
      let pollResponse;
      try {
        pollResponse = await fetchFn(pollUrl, {
          headers: { 'api-token': stealthApiKey.trim() },
          signal: pollController.signal
        });
      } finally {
        clearTimeout(pollTimeoutId);
      }

      if (!pollResponse.ok) {
        const errorText = await pollResponse.text();
        console.error('[Humanizer] StealthGPT poll error status:', pollResponse.status, errorText);
        throw new Error(`StealthGPT API returned status ${pollResponse.status}`);
      }

      const pollData = await pollResponse.json();
      if (pollData.status === 'completed') {
        resData = pollData;
        break;
      }
      if (pollData.status === 'failed' || pollData.status === 'cancelled') {
        throw new Error(pollData.error?.message || `StealthGPT run ${pollData.status}`);
      }
      // status masih 'queued' / 'running' - lanjut poll
    }

    if (!resData) {
      throw new Error('StealthGPT run tidak selesai dalam waktu yang wajar (timeout polling).');
    }

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
    const isTimeout = apiError.name === 'AbortError' || apiError.message.includes('timeout polling');
    console.error('[Humanizer] Gagal menghubungi StealthGPT API:', apiError.message);
    return res.status(502).json({
      ok: false,
      message: isTimeout
        ? 'Server Humanizer (StealthGPT) tidak merespons dalam waktu yang wajar. Silakan coba lagi, atau coba dengan teks yang lebih pendek.'
        : 'Gagal memproses humanisasi teks. Layanan StealthGPT sedang bermasalah, silakan coba lagi nanti.'
    });
  }
});

// --- ASISTEN RISET AI (DeepSeek) ---
// Free tier: 20 pesan/bulan. Premium & Ultimate: unlimited.
const RESEARCH_CHAT_SYSTEM_PROMPT = `Kamu adalah JurnalHub Intelligence, asisten riset akademik di platform JurnalHub untuk dosen dan mahasiswa pascasarjana (S2/S3) di Indonesia. Perankan dirimu sebagai seorang profesor kolega yang ramah, hangat, dan selalu siap membantu diskusi riset apa pun, dari penyusunan proposal, tinjauan pustaka, metodologi, analisis data, hingga penulisan artikel ilmiah.

BAHASA
Selalu balas dalam bahasa yang dipakai pengguna pada pesan terakhirnya. Kalau pengguna menulis dalam Bahasa Indonesia, balas dalam Bahasa Indonesia akademik yang baik. Kalau pengguna menulis dalam Bahasa Inggris, balas dalam Bahasa Inggris. Kalau pengguna mencampur dua bahasa, ikuti bahasa yang dominan pada pesan tersebut. Jangan memaksakan satu bahasa tertentu tanpa melihat bahasa input pengguna.

GAYA KOMUNIKASI
Bicara seperti kolega senior yang mengajak diskusi, bukan seperti mesin pencari yang memberi jawaban singkat. Jangan pelit kata. Jika sebuah topik butuh penjelasan panjang dengan konteks, latar belakang, dan beberapa sudut pandang, tuliskan semuanya dengan lengkap. Pengguna JurnalHub adalah akademisi yang terbiasa membaca uraian padat, jadi jangan meringkas berlebihan hanya demi terlihat efisien.

Gunakan gaya akademik yang tetap hangat dan tidak kaku. Boleh sesekali menunjukkan antusiasme pada topik riset yang menarik. Sapa pengguna selayaknya kolega, bukan klien.

KESEDIAAN MENULISKAN SESUATU
Kamu senang membantu menuliskan draf, baik itu kerangka artikel, paragraf pembuka, rumusan masalah, kalimat transisi antarbagian, hingga draf pembahasan. Jangan menahan diri untuk menuliskan teks utuh jika diminta. Namun tetap ingatkan pengguna bahwa hasil tulisanmu adalah draf awal yang perlu ditinjau, disunting, dan diperkaya dengan suara akademik mereka sendiri sebelum disetorkan atau dipublikasikan.

ATURAN KETAT SOAL REFERENSI DAN SITASI
Ini adalah aturan paling penting yang tidak boleh dilanggar dalam kondisi apa pun:
1. Jangan pernah mengarang judul artikel, nama penulis, nama jurnal, tahun terbit, DOI, atau kutipan apa pun yang tidak benar-benar kamu ketahui keberadaannya.
2. Jika kamu tidak yakin sebuah referensi benar-benar ada, katakan secara eksplisit bahwa kamu tidak yakin, dan sarankan pengguna untuk mencarinya sendiri di Google Scholar, Scopus, atau database sejenis, atau gunakan fitur pencarian jurnal di JurnalHub.
3. Jangan pernah menyusun daftar pustaka lengkap dengan detail spesifik (nama, tahun, volume, halaman) kecuali kamu benar-benar memiliki sumber yang terverifikasi untuk itu.
4. Lebih baik memberi kerangka argumen tanpa sitasi spesifik dan meminta pengguna mengisi sendiri, daripada mengisi dengan referensi yang kelihatannya meyakinkan tapi sebenarnya tidak ada.
5. Jika pengguna memaksa meminta referensi instan, tetap tolak dengan sopan dan jelaskan risikonya bagi kredibilitas akademik mereka.

KEJUJURAN SOAL KETERBATASAN
Kamu tidak perlu berpura-pura menguasai semua bidang riset dengan tingkat kedalaman yang sama. Jika sebuah topik berada di luar area yang kamu kuasai dengan baik, atau termasuk bidang yang sangat spesialistik, teknis, atau berkembang cepat, katakan secara terus terang bahwa pemahamanmu di bidang tersebut terbatas. Jangan berpura-pura tahu demi terlihat membantu. Setelah mengakui keterbatasan, tetap coba beri arah awal atau saran ke mana pengguna sebaiknya mencari (pembimbing yang lebih relevan, jurnal spesialis, pakar di bidang tersebut).

BATASAN LAIN
Jangan menyusun data penelitian, hasil eksperimen, atau angka statistik yang seolah nyata. Jangan mengklaim telah membaca artikel tertentu jika kamu sebenarnya tidak memiliki akses ke isinya, cukup berikan analisis berdasarkan judul, abstrak, atau ringkasan yang diberikan pengguna. Selalu dorong integritas akademik dan hindari membantu tindakan yang mengarah ke plagiarisme atau fabrikasi data.

TUJUAN AKHIR
Bertindak seperti kolega yang membuat riset terasa lebih ringan untuk dijalani, jujur ketika ada batasan, dan selalu menjaga agar apa yang dihasilkan bisa dipertanggungjawabkan secara akademik.`;

function getDeepSeekApiKey() {
  return process.env.DEEPSEEK_API_KEY;
}

// Helper streaming DeepSeek yang dipakai bareng oleh beberapa fitur teks-bebas
// (Lit Review, Peer Reviewer, AI Disclosure, dst) - pola sama persis dengan
// /api/research-chat: relay tiap potongan SSE ke client via res.write() begitu
// diterima, BUKAN nunggu respons lengkap dulu baru dikirim sekaligus. Caller
// tetap yang set header res & panggil res.end() sendiri (supaya caller yang
// perlu kirim chunk tambahan setelah teks, mis. citations, masih bisa).
async function streamDeepSeekCompletion(res, apiKey, bodyPayload) {
  const fetchFn = globalThis.fetch || require('node-fetch');
  const deepSeekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';

  const dsResponse = await fetchFn(deepSeekUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    // stream_options.include_usage - minta DeepSeek kirim chunk terakhir
    // berisi usage.total_tokens (dipakai buat DEEPSEEK POOL, lihat di atas),
    // tanpa ini chunk SSE tidak pernah membawa data usage sama sekali.
    body: JSON.stringify(Object.assign({}, bodyPayload, { stream: true, stream_options: { include_usage: true } }))
  });

  if (!dsResponse.ok) {
    const errText = await dsResponse.text();
    throw new Error(`DeepSeek API Error Status: ${dsResponse.status} - ${errText}`);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  let sseBuffer = '';
  let fullContent = '';
  let usage = null;
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
        if (delta) {
          fullContent += delta;
          res.write(JSON.stringify({ type: 'content', content: delta }) + '\n');
        }
        if (parsed?.usage) usage = parsed.usage;
      } catch (e) {
        // Baris SSE parsial/tidak valid - abaikan
      }
    }
  }

  return { fullContent, usage };
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

  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  // Sengaja TIDAK dibatasi kuota/tier per-fitur (fitur etika/kepercayaan) -
  // tapi tetap dijatah lewat DEEPSEEK POOL bersama seperti fitur lain.
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

  const apiKey = getDeepSeekApiKey();
  if (!apiKey) {
    return res.status(500).json({ ok: false, message: 'AI Disclosure Generator belum dikonfigurasi di server.' });
  }

  try {
    const includeSearchString = searchTerms.length > 0;
    const userContent = includeSearchString
      ? `Tool used: ${toolName}\nHow it was used: ${usageContext}\nResearch title/keywords to derive the Core Search String from: ${searchTerms}\n\nGenerate the AI disclosure statement followed by the Core Search String:`
      : `Tool used: ${toolName}\nHow it was used: ${usageContext}\n\nGenerate the AI disclosure statement:`;

    const disclosureStreamResult = await streamDeepSeekCompletion(res, apiKey, {
      model: 'deepseek-v4-flash',
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      extra_body: { thinking: { type: 'disabled' } },
      messages: [
        { role: 'system', content: includeSearchString ? AI_DISCLOSURE_SYSTEM_PROMPT_WITH_SEARCH_STRING : AI_DISCLOSURE_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ]
    });
    const statement = disclosureStreamResult.fullContent.trim();
    if (user) recordDeepSeekPoolUsage(user.id, disclosureStreamResult.usage?.total_tokens);

    res.end();

    if (!statement) {
      console.error('[AI Disclosure Generator] Respons kosong dari DeepSeek.');
    }
  } catch (error) {
    console.error('[AI Disclosure Generator] Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Gagal membuat AI Disclosure Statement: ' + error.message });
    } else {
      res.end();
    }
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
    .map(c => ({ id: c.id, title: c.title, pinned: !!c.pinned, updatedAt: c.updatedAt }));
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

// Perbarui judul (rename) atau status sematan (pin/unpin) percakapan
app.patch('/api/research-chat/conversations/:id', requireAccess, (req, res) => {
  const conversations = getResearchChatConversations();
  const conv = conversations.find(c => c.id === req.params.id && c.userId === req.session.userId);
  if (!conv) {
    return res.status(404).json({ ok: false, message: 'Percakapan tidak ditemukan.' });
  }
  if (typeof req.body.title === 'string' && req.body.title.trim()) {
    conv.title = req.body.title.trim().slice(0, 100);
  }
  if (typeof req.body.pinned === 'boolean') {
    conv.pinned = req.body.pinned;
  }
  saveResearchChatConversations(conversations);
  res.json({ ok: true, conversation: { id: conv.id, title: conv.title, pinned: !!conv.pinned } });
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

// Backup/grounding jawaban Prof Juju dengan paper ilmiah asli dari OpenAlex (sama
// seperti Lit Review) - supaya klaim/sitasi yang disebut di chat bisa dipercaya
// dan diverifikasi, bukan sekadar "pengetahuan umum" model yang rawan halusinasi.
async function searchAcademicContext(query) {
  if (!query) return null;
  try {
    // Timeout ketat (bukan default 15s) - ini jalan sebelum JurnalHub
    // Intelligence mulai streaming jawaban untuk SEMUA pesan/tier, jadi kalau
    // OpenAlex lambat, lebih baik lanjut tanpa sitasi daripada bikin chat
    // terasa macet nunggu.
    const papers = await searchOpenAlexWorks(query, 6, null, null, 3500);
    if (!papers || papers.length === 0) return null;
    const top = [...papers].sort((a, b) => b.citedByCount - a.citedByCount).slice(0, 5);
    const text = top.map((p, i) =>
      `${i + 1}. "${p.title}" - ${p.authors} (${p.year}), dikutip ${p.citedByCount}x. Link: ${p.url}`
    ).join('\n');
    const contextText = `Berikut paper ilmiah ASLI dari OpenAlex yang relevan dengan pertanyaan pengguna. Gunakan untuk mem-backup/memperkuat jawabanmu. Rujuk paper HANYA dengan format angka bernomor dalam kurung siku, contoh [2], sesuai nomor urut paper pada daftar di bawah - taruh tepat setelah klausa/kalimat yang didukung paper tersebut. JANGAN pakai format (Penulis, Tahun). JANGAN mengarang paper atau sitasi lain di luar daftar ini - kalau tidak ada paper yang cocok/relevan dari daftar ini, jangan paksa mengutip, cukup jawab berdasarkan penalaranmu sendiri dan katakan terus terang tidak ada rujukan spesifik yang ditemukan:\n\n${text}`;
    // Bentuk sama seperti citations Lit Review - dipakai frontend untuk kartu
    // preview hover di marker [n] dalam jawaban chat.
    const citations = top.map(p => ({
      title: p.title,
      authors: p.authors,
      journal: p.journal,
      year: p.year,
      url: p.url,
      doi: p.doi || null,
      citedByCount: p.citedByCount,
      isOpenAccess: p.isOpenAccess,
      abstract: p.abstract ? p.abstract.slice(0, 280) : ''
    }));
    return { contextText, citations };
  } catch (error) {
    console.warn('[Academic Search] Gagal ambil konteks OpenAlex (diabaikan):', error.message);
    return null;
  }
}

// --- LAMPIRAN DOKUMEN untuk JurnalHub Intelligence (Premium & Ultimate saja) ---
// Batas 15.000 kata per dokumen supaya biaya token DeepSeek per unggahan terkendali
// (lihat catatan di komentar RESEARCH_CHAT_SYSTEM_PROMPT soal cost histori percakapan).
const DOCUMENT_MAX_WORDS = 15000;
const documentUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Terlalu banyak unggahan dokumen. Silakan coba lagi dalam beberapa menit.' }
});
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB batas mentah file
  fileFilter: (req, file, cb) => {
    const originalName = (file.originalname || '').toLowerCase();
    const isAllowedExt = originalName.endsWith('.pdf') || originalName.endsWith('.docx') || originalName.endsWith('.doc') || originalName.endsWith('.txt');
    const allowedMime = [
      'application/pdf',
      'application/x-pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/docx',
      'text/plain',
      'application/octet-stream'
    ];
    if (allowedMime.includes(file.mimetype) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan file PDF, DOCX, atau TXT.'));
    }
  }
});

async function parsePdfBuffer(buffer) {
  const pdfModule = require('pdf-parse');
  if (pdfModule && pdfModule.PDFParse) {
    const parser = new pdfModule.PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return result ? (result.text || '') : '';
  }
  if (typeof pdfModule === 'function') {
    const result = await pdfModule(buffer);
    return result ? (result.text || '') : '';
  }
  if (pdfModule && typeof pdfModule.default === 'function') {
    const result = await pdfModule.default(buffer);
    return result ? (result.text || '') : '';
  }
  throw new Error('Modul pemroses PDF tidak kompatibel.');
}

async function extractTextFromDocument(file) {
  const filename = (file.originalname || '').toLowerCase();
  const mimetype = (file.mimetype || '').toLowerCase();

  const isPdf = filename.endsWith('.pdf') || mimetype.includes('pdf');
  const isDocx = filename.endsWith('.docx') || mimetype.includes('wordprocessingml') || mimetype.includes('docx');
  const isDoc = filename.endsWith('.doc') || mimetype === 'application/msword';
  const isTxt = filename.endsWith('.txt') || mimetype.includes('text/plain');

  if (isDoc) {
    throw new Error('Format file .doc (Word lama) tidak didukung. Mohon simpan/konversi file Anda ke format .docx atau .pdf sebelum diunggah.');
  }

  if (isPdf) {
    try {
      const rawText = await parsePdfBuffer(file.buffer);
      const extractedText = (rawText || '').trim();
      if (!extractedText) {
        throw new Error('PDF tidak berisi teks yang dapat dibaca (seperti PDF hasil scan/gambar). Mohon gunakan file PDF berbasis teks atau file Word (.docx).');
      }
      return extractedText;
    } catch (err) {
      if (err.message && err.message.includes('PDF tidak berisi teks')) {
        throw err;
      }
      const errMsg = (err.message || '').toLowerCase();
      if (errMsg.includes('password') || errMsg.includes('encrypt') || errMsg.includes('decrypt') || errMsg.includes('code 1')) {
        throw new Error('File PDF ini dilindungi oleh kata sandi (password). Silakan hapus kunci proteksi PDF sebelum diunggah.');
      }
      console.error('[PDF Parse Error]', err);
      throw new Error('File PDF tidak dapat dibaca oleh sistem: ' + (err.message || 'File mungkin korup.'));
    }
  }

  if (isDocx) {
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      const extractedText = (result ? (result.value || '') : '').trim();
      if (!extractedText) {
        throw new Error('Dokumen Word (.docx) tidak berisi teks yang dapat dibaca.');
      }
      return extractedText;
    } catch (err) {
      if (err.message && err.message.includes('tidak berisi teks')) {
        throw err;
      }
      console.error('[Mammoth Error]', err);
      throw new Error('File Word (.docx) tidak dapat dibaca. Pastikan file tidak terkunci kata sandi atau korup: ' + (err.message || ''));
    }
  }

  if (isTxt) {
    const text = file.buffer.toString('utf-8').trim();
    if (!text) {
      throw new Error('File TXT kosong.');
    }
    return text;
  }

  throw new Error('Format file tidak didukung. Mohon unggah dokumen berformat PDF, DOCX, atau TXT.');
}

app.post('/api/research-chat/upload', requireAccess, documentUploadLimiter, (req, res) => {
  documentUpload.single('document')(req, res, async (err) => {
    if (err) {
      const message = err.message && err.message.includes('tidak didukung')
        ? err.message
        : (err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 1MB. Silakan unggah dokumen yang lebih kecil.' : 'Gagal mengunggah file.');
      return res.status(400).json({ ok: false, message });
    }

    // Lampiran dokumen hanya untuk Premium & Ultimate.
    const users = getUsers();
    const user = users.find(u => u.id === req.session.userId);
    const userType = (user && user.type) || 'free';
    if (!isAdminReq(req) && userType !== 'premium' && userType !== 'ultimate') {
      return res.status(403).json({ ok: false, message: 'Fitur lampiran dokumen khusus akun Premium & Ultimate.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'File wajib disertakan.' });
    }

    try {
      const rawText = (await extractTextFromDocument(req.file)).trim();

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
      res.status(400).json({ ok: false, message: error.message || 'Gagal memproses dokumen.' });
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
  const userType = (user && user.type) || 'free';

  // Kuota JurnalHub Intelligence sekarang berbasis DEEPSEEK POOL bersama
  // (kredit/minggu, berlaku semua tier) - bukan hitungan 20 pesan/bulan
  // khusus Free lagi.
  if (user && !requireDeepSeekPoolAccess(req, res, user)) return;

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

  // Web search (Serper, berbayar) & academic search (OpenAlex) sama-sama
  // dibatasi kombinasi Model Pro + Deep Thinking - di Lite/Standard,
  // JurnalHub Intelligence jawab langsung dari pengetahuan model tanpa
  // nunggu pencarian eksternal, supaya tetap terasa cepat.
  let webSearchContext = null;
  let academicResult = null;
  const lastUserMessage = [...sanitizedMessages].reverse().find(m => m.role === 'user');
  if (lastUserMessage && modelType === 'pro' && thinkingEnabled) {
    const query = lastUserMessage.content.slice(0, 400);
    const results = await Promise.all([searchAcademicContext(query), searchWebForContext(query)]);
    academicResult = results[0];
    webSearchContext = results[1];
  }
  const academicCitations = academicResult ? academicResult.citations : null;

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
    const customInstructionsMsg = buildCustomInstructionsMessage(user);
    if (customInstructionsMsg) systemMessages.push(customInstructionsMsg);
    if (webSearchContext) {
      systemMessages.push({ role: 'system', content: webSearchContext });
    }
    if (academicResult) {
      systemMessages.push({ role: 'system', content: academicResult.contextText });
    }

    const bodyPayload = {
      model: dsModel,
      messages: [
        ...systemMessages,
        ...sanitizedMessages
      ],
      max_tokens: 8000,
      stream: true,
      stream_options: { include_usage: true }
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
    let dsUsage = null;
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
          if (parsed?.usage) dsUsage = parsed.usage;
        } catch (e) {
          // Baris SSE parsial/tidak valid - abaikan
        }
      }
    }

    if (user) recordDeepSeekPoolUsage(user.id, dsUsage?.total_tokens);

    // Kirim daftar sitasi akademik (kalau ada) sebagai chunk terakhir - dipakai
    // frontend untuk kartu preview hover di marker [n] dalam jawaban.
    if (fullReply && academicCitations && academicCitations.length > 0) {
      res.write(JSON.stringify({ type: 'citations', citations: academicCitations }) + '\n');
    }
    res.end();

    if (!fullReply && !fullReasoning) {
      console.error('[Research Chat] Respons stream kosong dari DeepSeek.');
      return;
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
    if (academicCitations && academicCitations.length > 0) {
      assistantMsg.citations = academicCitations;
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
    '/terms.html', '/refund.html', '/faq.html', '/help-center.html', '/contact.html',
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
  if (!isAdminReq(req) && !isWiley && req.session.userType !== 'premium' && req.session.userType !== 'ultimate') {
    return res.status(403).send('Akses ditolak. Fitur ini khusus pengguna PRO (Premium & Ultimate).');
  }
  next();
}, express.static(path.join(__dirname, 'templates')));

// --- PAYMENT: Faspay Xpress (satu-satunya penyedia pembayaran - iPaymu sudah dilepas) ---

// Kode promo cuma boleh dipakai untuk paket bulanan - kalau valid, harga & deskripsi
// item yang dikirim ke Faspay (jadi yang benar-benar ditagih) sudah didiskon di sini,
// bukan cuma tampilan di frontend.
// promoCode di sini kolomnya SAMA dipakai untuk 2 hal: kode promo manual
// (PROMO_CODES) DAN kode referral Program Afiliasi Kampus (affiliates.json)
// - dicoba PROMO_CODES dulu, kalau tidak cocok baru dicoba sebagai kode
// referral. affiliateId dikembalikan kalau yang cocok kode referral, dipakai
// createFaspayTransaction buat mencatat siapa yang harus dapat komisi nanti
// (lihat webhook Faspay).
function applyPromoToItemDef(plan, planId, promoCode, buyerUserId) {
  if (!promoCode) return { itemDef: plan, error: null, affiliateId: null };

  const promo = getPromoDiscount(promoCode);
  if (promo) {
    if (!planId.endsWith('_monthly')) {
      return { itemDef: null, error: 'Kode promo hanya berlaku untuk paket bulanan.', affiliateId: null };
    }
    const discountedPrice = Math.round(plan.price * (1 - promo.discountPercent / 100));
    return {
      itemDef: {
        ...plan,
        price: discountedPrice,
        desc: `${plan.desc} Promo ${String(promoCode).trim().toUpperCase()} potongan ${promo.discountPercent} persen`
      },
      error: null,
      affiliateId: null
    };
  }

  const affiliate = findAffiliateByReferralCode(promoCode);
  if (affiliate) {
    if (affiliate.userId === buyerUserId) {
      return { itemDef: null, error: 'Anda tidak bisa memakai kode referral Anda sendiri.', affiliateId: null };
    }
    if (!planId.endsWith('_monthly')) {
      return { itemDef: null, error: 'Kode referral hanya berlaku untuk paket bulanan.', affiliateId: null };
    }
    const discountedPrice = Math.round(plan.price * (1 - AFFILIATE_DISCOUNT_PERCENT / 100));
    return {
      itemDef: {
        ...plan,
        price: discountedPrice,
        desc: `${plan.desc} Referral ${affiliate.referralCode} potongan ${AFFILIATE_DISCOUNT_PERCENT} persen`
      },
      error: null,
      affiliateId: affiliate.id
    };
  }

  return { itemDef: null, error: 'Kode promo tidak valid atau sudah tidak berlaku.', affiliateId: null };
}

app.post('/api/promo/validate', requireAccess, (req, res) => {
  const { code, planId } = req.body;
  const promo = getPromoDiscount(code);
  if (promo) {
    if (planId && !String(planId).endsWith('_monthly')) {
      return res.status(400).json({ ok: false, message: 'Kode promo hanya berlaku untuk paket bulanan.' });
    }
    return res.json({ ok: true, discountPercent: promo.discountPercent });
  }

  const affiliate = findAffiliateByReferralCode(code);
  if (affiliate) {
    if (affiliate.userId === req.session.userId) {
      return res.status(400).json({ ok: false, message: 'Anda tidak bisa memakai kode referral Anda sendiri.' });
    }
    if (planId && !String(planId).endsWith('_monthly')) {
      return res.status(400).json({ ok: false, message: 'Kode referral hanya berlaku untuk paket bulanan.' });
    }
    return res.json({ ok: true, discountPercent: AFFILIATE_DISCOUNT_PERCENT });
  }

  return res.status(400).json({ ok: false, message: 'Kode promo tidak valid atau sudah tidak berlaku.' });
});

app.post('/api/payment/create', requireAccess, async (req, res) => {
  const { planId, promoCode } = req.body;
  if (!planId) {
    return res.status(400).json({ ok: false, message: 'Plan ID wajib dipilih.' });
  }

  const plan = FASPAY_PLAN_PRICES[planId];
  if (!plan) {
    return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
  }

  const { itemDef, error, affiliateId } = applyPromoToItemDef(plan, planId, promoCode, req.session.userId);
  if (error) {
    return res.status(400).json({ ok: false, message: error });
  }

  return createFaspayTransaction(req, res, { kind: 'subscription', itemId: planId, itemDef, userId: req.session.userId, affiliateId });
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

// Kode promo diskon - berlaku HANYA untuk paket bulanan (_monthly), tidak untuk
// tahunan (yang sudah punya diskon "Hemat s.d 16%" sendiri) - dicek terpisah di
// applyPromoToItemDef/POST /api/promo/validate, bukan di sini. Key selalu
// dicocokkan uppercase supaya input user tidak case-sensitive. startsAt/endsAt
// OPSIONAL (offset +07:00/WIB eksplisit di string-nya sendiri, bukan
// diasumsikan/dikonversi manual) - kode tanpa keduanya berlaku terus-menerus
// sampai dihapus manual dari sini (kayak JHTHREADS/JHTIKTOK di bawah).
const PROMO_CODES = {
  JHTHREADS: { discountPercent: 20 },
  JHTIKTOK: { discountPercent: 20 },
  JH17AN: { discountPercent: 25, startsAt: '2026-08-16T00:00:00+07:00', endsAt: '2026-08-17T23:59:00+07:00' },
  JHKOLABRISET: { discountPercent: 15 }
};

function getPromoDiscount(code) {
  if (!code) return null;
  const promo = PROMO_CODES[String(code).trim().toUpperCase()];
  if (!promo) return null;
  const now = new Date();
  if (promo.startsAt && now < new Date(promo.startsAt)) return null;
  if (promo.endsAt && now > new Date(promo.endsAt)) return null;
  return promo;
}

const FASPAY_TOPUP_PACKAGES = {
  starter: { price: 39000, name: 'Humanizer Starter Pack', desc: 'Topup Kuota Kata Humanizer 5000 Kata', words: 5000 },
  scholar: { price: 119000, name: 'Humanizer Scholar Pack', desc: 'Topup Kuota Kata Humanizer 15000 Kata', words: 15000 },
  thesis: { price: 299000, name: 'Humanizer Thesis Pack', desc: 'Topup Kuota Kata Humanizer 40000 Kata', words: 40000 }
};

async function createFaspayTransaction(req, res, { kind, itemId, itemDef, userId, affiliateId }) {
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
          affiliateId: affiliateId || null, // Program Afiliasi Kampus, lihat webhook Faspay
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
  const { planId, promoCode } = req.body;
  const plan = planId && FASPAY_PLAN_PRICES[planId];
  if (!plan) {
    return res.status(400).json({ ok: false, message: 'Plan ID tidak valid.' });
  }
  const { itemDef, error } = applyPromoToItemDef(plan, planId, promoCode);
  if (error) {
    return res.status(400).json({ ok: false, message: error });
  }
  await createFaspayTransaction(req, res, { kind: 'subscription', itemId: planId, itemDef, userId: req.session.userId });
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

          // Program Afiliasi Kampus: kode referral yang berhasil dipakai PERTAMA
          // KALI "mengikat" user ini ke affiliate itu SELAMANYA
          // (referredByAffiliateId) - supaya SEMUA pembayaran berikutnya
          // (termasuk renewal tanpa masukkan kode lagi) tetap menghasilkan komisi
          // recurring buat affiliate itu. Lihat komentar besar di
          // recordAffiliateCommission.
          if (!users[userIndex].referredByAffiliateId && record.affiliateId) {
            users[userIndex].referredByAffiliateId = record.affiliateId;
          }
        }

        persisted = saveUsers(users);
      });

      if (!persisted) {
        console.error(`[Faspay Webhook] GAGAL menyimpan perubahan untuk bill_no ${billNo} - membalas non-200 supaya Faspay retry.`);
        return respond('01', 'Failed to persist');
      }

      addTransaction(record.userId, billNo, record.name, record.amount, 'success');

      // Catat komisi affiliate SETELAH users.json tersimpan (baca ulang dari
      // disk, bukan pakai array `users` di dalam withLock di atas yang mungkin
      // sudah basi) - referredByAffiliateId sudah pasti ke-set di titik ini
      // kalau memang ada kode referral yang berlaku di transaksi ini.
      if (record.kind !== 'topup') {
        const freshUsers = getUsers();
        const buyerUser = freshUsers.find(u => u.id === record.userId);
        if (buyerUser && buyerUser.referredByAffiliateId) {
          recordAffiliateCommission(buyerUser.referredByAffiliateId, buyerUser, record.itemId, record.amount, billNo);
        }
      }

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

// Link pendek yang gampang diketik/dibagikan lewat email/medsos (mis.
// jurnalhub.id/campusambassador) untuk promosi Program Afiliasi Kampus -
// diteruskan ke "/" dengan query ?opentab=afiliasi yang:
// - kalau sudah login: dibaca app.js (mirip pola deep-link ?opencowork=) buat
//   langsung buka tab JurnalHub Campus Ambassador.
// - kalau belum login: landing.html mendeteksi query ini dan lempar ke
//   /auth.html?redirect=... supaya user baru diarahkan daftar dulu, lalu
//   otomatis balik ke tab ini setelah berhasil login (lihat auth.html).
app.get('/campusambassador', (req, res) => {
  res.redirect('/?opentab=afiliasi');
});

// PENTING: express.static(__dirname) sebelumnya menyerve SELURUH isi root folder
// project apa adanya - termasuk server.js, package.json, package-lock.json, dan
// (paling parah) seluruh isi data/ (users.json berisi password hash + session
// token semua user, access-codes.json berisi kode aktivasi Ultimate gratis) bisa
// diunduh siapa saja tanpa login. Allowlist di bawah memastikan hanya aset publik
// yang memang dipakai frontend (halaman .html, app.js, styles.css, database.js,
// dan folder assets/) yang bisa diakses lewat static file serving.
const PUBLIC_STATIC_FILES = new Set([
  'index.html', 'auth.html', 'landing.html', 'contact.html', 'faq.html', 'help-center.html',
  'terms.html', 'refund.html', 'privacy.html', 'payment-success.html', 'payment-cancel.html',
  'reset-password.html', 'robots.txt', 'sitemap.xml',
  'app.js', 'styles.css', 'database.js'
]);
app.use((req, res, next) => {
  const urlPath = req.path;
  // .xlsx & /convert.js sudah lolos requireAccess di middleware lebih awal
  // (baris ~4383) sebelum sampai sini - request yang belum login sudah
  // di-redirect ke /auth.html duluan, jadi aman diteruskan di sini.
  const isLegacyProtectedFile = urlPath.toLowerCase().endsWith('.xlsx') || urlPath === '/convert.js';
  if (urlPath.startsWith('/assets/') || PUBLIC_STATIC_FILES.has(urlPath.replace(/^\//, '')) || isLegacyProtectedFile) {
    return next();
  }
  return res.status(404).send('Not Found');
});
app.use(express.static(path.join(__dirname, '.'), {
  // Cache-Control per jenis file:
  // - /assets/ (logo, video demo) jarang berubah -> cache lama (7 hari) di browser,
  //   memangkas ulang-unduh 42MB video demo setiap kunjungan berikutnya.
  // - app.js/database.js/styles.css sering ter-update tiap deploy (auto-deploy
  //   Railway dari `main`) dan namanya tidak versioned/hashed, jadi cache pendek
  //   (5 menit) supaya perbaikan bug tidak lama nyangkut di browser user tapi
  //   tetap dapat manfaat cache untuk request berulang dalam sesi yang sama.
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }
}));

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
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ ok: false, message: 'Ukuran data yang dikirim terlalu besar (percakapan atau dokumen terlampir terlalu panjang). Mulai percakapan baru atau lampirkan dokumen yang lebih pendek.' });
  }
  res.status(err.status || err.statusCode || 500).json({ ok: false, message: 'Terjadi kesalahan tak terduga pada server.' });
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

  try {
    syncAdminFlagsFromEnv();
  } catch (err) {
    console.error('[Admin Sync] Gagal sinkronisasi ADMIN_EMAILS:', err.message);
  }

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
        createdAt: new Date().toISOString()
      });
      saveUsers(users);
      console.log('[Database Seed] Akun demo (demo/demo) berhasil dibuat.');
    }
  } catch (err) {
    console.error('[Database Seed] Gagal membuat akun demo:', err.message);
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
