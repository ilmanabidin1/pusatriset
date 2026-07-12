const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const { VertexAI } = require('@google-cloud/vertexai');
const JOURNAL_DATABASE = require('./database');
const app = express();

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

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
    return true;
  }
  // Check old cookie for backward compatibility temporarily if needed, though session is preferred now.
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
    const newUser = {
      id: uuidv4(),
      email,
      password: hashedPassword,
      type: 'free', // Default account type is free
      name: '',
      faculty: '',
      university: '',
      profilePic: '',
      savedJournals: [],
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    // Auto login after register
    req.session.userId = newUser.id;
    req.session.userType = newUser.type;
    req.session.email = newUser.email;

    res.json({ ok: true, user: { email: newUser.email, type: newUser.type } });
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

  try {
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ ok: false, message: 'Email atau password salah.' });
    }

    req.session.userId = user.id;
    req.session.userType = user.type || 'free';
    req.session.email = user.email;

    res.json({ ok: true, user: { email: user.email, type: user.type } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ ok: false, message: 'Terjadi kesalahan pada server.' });
  }
});

app.post('/api/logout', (req, res) => {
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
    res.json({
      loggedIn: true,
      user: {
        email: req.session.email || 'Premium User',
        type: req.session.userType,
        name: user ? (user.name || '') : '',
        faculty: user ? (user.faculty || '') : '',
        university: user ? (user.university || '') : '',
        profilePic: user ? (user.profilePic || '') : '',
        savedJournals: user ? (user.savedJournals || []) : []
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

  // Jika kode akses benar, beri sesi premium
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
          max_tokens: 1024,
          system: process.env.CLAUDE_SYSTEM_PROMPT || "Anda adalah asisten rekomendasi jurnal ilmiah untuk JurnalHub. Anda wajib membalas HANYA dengan JSON valid dalam format array objek tanpa menyertakan penjelasan teks atau markdown (no ```json). Format JSON: [{\"id\": 123, \"matchScore\": 92, \"reason\": \"Alasan singkat dalam Bahasa Indonesia\"}]",
          messages: [
            {
              role: 'user',
              content: `Pilih tepat 3 jurnal paling cocok dari daftar kandidat berdasarkan judul artikel, keyword/bidang, abstrak, scope jurnal, rank, dan biaya.\n\nArtikel:\nJudul: ${articleTitle || '-'}\nKeyword/Bidang: ${articleKeywords || '-'}\nAbstrak: ${articleAbstract || '-'}\n\nKandidat jurnal:\n${JSON.stringify(candidates)}`
            }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API Error Status: ${response.status} - ${errText}`);
      }

      const resData = await response.json();
      const text = resData?.content?.[0]?.text || '[]';
      const cleanedJsonText = text.replace(/```json/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleanedJsonText);
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
        return JSON.parse(text);
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
        return JSON.parse(text);
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
    const aiItems = await getGeminiRecommendations(articleTitle, articleKeywords, articleAbstract, candidates);
    const recommendations = normalizeAiRecommendations(aiItems, candidates);
    const sourceName = hasClaudeKey ? 'claude' : 'gemini';
    res.json({ ok: true, source: sourceName, recommendations });
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

app.use((req, res, next) => {
  // File statis yang diizinkan tanpa login (terutama untuk halaman auth dan informasi)
  const publicFiles = [
    '/auth.html', '/styles.css', '/app.js', '/database.js',
    '/terms.html', '/refund.html', '/faq.html', '/contact.html'
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

// Route statis aman untuk file template jurnal (hanya premium, kecuali Wiley)
app.use('/templates', requireAccess, (req, res, next) => {
  const isWiley = req.path.toLowerCase().includes('wiley');
  if (!isWiley && req.session.userType !== 'premium') {
    return res.status(403).send('Akses ditolak. Fitur ini khusus pengguna Premium.');
  }
  next();
}, express.static(path.join(__dirname, 'templates')));

app.use(express.static(path.join(__dirname, '.')));

// Arahkan semua request lainnya ke index.html (tapi sudah dilindungi oleh middleware di atas)
app.get('*', requireAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server JurnalHub berjalan di port ${PORT}`);

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
