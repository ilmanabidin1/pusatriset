const express = require('express');
const path = require('path');
const app = express();

// Tentukan port dari environment variable (Railway menyediakannya lewat PORT) atau port 3000 secara lokal
const PORT = process.env.PORT || 3000;

// Sajikan file statis dari direktori saat ini
app.use(express.static(path.join(__dirname, '.')));

// Arahkan semua request lainnya ke index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server Pusat Riset berjalan di port ${PORT}`);
});
