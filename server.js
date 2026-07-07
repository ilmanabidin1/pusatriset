const express = require('express');
const path = require('path');
const app = express();

// Tentukan port dari environment variable (Railway menyediakannya lewat PORT) atau port 3000 secara lokal
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE;
const ACCESS_COOKIE = 'jurnalhub_access';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [key, ...valueParts] = item.trim().split('=');
    if (!key) return cookies;
    cookies[key] = decodeURIComponent(valueParts.join('='));
    return cookies;
  }, {});
}

function hasAccess(req) {
  if (!ACCESS_CODE) return false;
  const cookies = parseCookies(req.headers.cookie);
  return cookies[ACCESS_COOKIE] === ACCESS_CODE;
}

function requireAccess(req, res, next) {
  if (hasAccess(req)) {
    next();
    return;
  }

  res.status(403).send('Kode akses diperlukan.');
}

app.get('/api/access-status', (req, res) => {
  res.json({ hasAccess: hasAccess(req) });
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

  const secureCookie = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ACCESS_COOKIE}=${encodeURIComponent(ACCESS_CODE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureCookie}`
  );
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const protectedFiles = ['/app.js', '/database.js', '/convert.js'];
  const isProtectedFile = protectedFiles.includes(req.path) || req.path.toLowerCase().endsWith('.xlsx');

  if (!isProtectedFile) {
    next();
    return;
  }

  requireAccess(req, res, next);
});
app.use(express.static(path.join(__dirname, '.')));

// Arahkan semua request lainnya ke index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server JurnalHub berjalan di port ${PORT}`);
});
