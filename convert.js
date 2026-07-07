const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// Fungsi pembantu untuk memetakan rumpun keilmuan secara luas dan detail keilmuan spesifik
function mapSubject(originalBidang) {
  if (!originalBidang) {
    return { subject: 'Sosial & Humaniora', keilmuan: 'Umum' };
  }
  
  const val = originalBidang.toString().trim();
  const lowerVal = val.toLowerCase();
  
  // 1. Kesehatan
  if (
    lowerVal.includes('kedokteran') || 
    lowerVal.includes('kesehatan') || 
    lowerVal.includes('keperawatan') || 
    lowerVal.includes('kebidanan') || 
    lowerVal.includes('farmasi') || 
    lowerVal.includes('gizi') || 
    lowerVal.includes('klinis') || 
    lowerVal.includes('medis') || 
    lowerVal.includes('medical') || 
    lowerVal.includes('health') || 
    lowerVal.includes('nursing') ||
    lowerVal.includes('psikologi')
  ) {
    return { subject: 'Kesehatan', keilmuan: val };
  }
  
  // 2. Ekonomi & Bisnis
  if (
    lowerVal.includes('ekonomi') || 
    lowerVal.includes('bisnis') || 
    lowerVal.includes('manajemen') || 
    lowerVal.includes('akuntansi') || 
    lowerVal.includes('keuangan') || 
    lowerVal.includes('pemasaran') || 
    lowerVal.includes('perpajakan') || 
    lowerVal.includes('perbankan') || 
    lowerVal.includes('kewirausahaan') || 
    lowerVal.includes('economics') || 
    lowerVal.includes('business') || 
    lowerVal.includes('management') || 
    lowerVal.includes('accounting') || 
    lowerVal.includes('finance')
  ) {
    return { subject: 'Ekonomi & Bisnis', keilmuan: val };
  }
  
  // 3. Sains & Teknologi
  if (
    lowerVal.includes('komputer') || 
    lowerVal.includes('informatika') || 
    lowerVal.includes('teknologi') || 
    lowerVal.includes('sains') || 
    lowerVal.includes('teknik') || 
    lowerVal.includes('matematika') || 
    lowerVal.includes('fisika') || 
    lowerVal.includes('kimia') || 
    lowerVal.includes('biologi') || 
    lowerVal.includes('pertanian') || 
    lowerVal.includes('sipil') || 
    lowerVal.includes('mesin') || 
    lowerVal.includes('industri') || 
    lowerVal.includes('arsitektur') || 
    lowerVal.includes('geografi') || 
    lowerVal.includes('science') || 
    lowerVal.includes('technology') || 
    lowerVal.includes('engineering') || 
    lowerVal.includes('math') || 
    lowerVal.includes('it')
  ) {
    return { subject: 'Sains & Teknologi', keilmuan: val };
  }
  
  // 4. Default: Sosial & Humaniora
  return { subject: 'Sosial & Humaniora', keilmuan: val };
}

// Fungsi pembantu untuk parsing Rank
function parseRank(originalRank, defaultType) {
  if (!originalRank) {
    return defaultType === 'Scopus' ? 'Q1' : 'S1';
  }
  
  const val = originalRank.toString().toUpperCase().trim();
  
  if (val.includes('Q1')) return 'Q1';
  if (val.includes('Q2')) return 'Q2';
  if (val.includes('Q3')) return 'Q3';
  if (val.includes('Q4')) return 'Q4';
  
  const sintaMatch = val.match(/SINTA\s*([1-6])/);
  if (sintaMatch) {
    return 'S' + sintaMatch[1];
  }
  
  const numMatch = val.match(/\b([1-6])\b/);
  if (numMatch) {
    return (defaultType === 'Scopus' ? 'Q' : 'S') + numMatch[1];
  }
  
  return defaultType === 'Scopus' ? 'Q1' : 'S1';
}

// Fungsi pembantu untuk parsing APC
function parseAPC(val) {
  if (val === undefined || val === null || val === '') {
    return { isFree: true, apc: 'Gratis (No APC)' };
  }
  
  if (typeof val === 'number') {
    if (val === 0) {
      return { isFree: true, apc: 'Gratis (No APC)' };
    } else {
      return { isFree: false, apc: `Rp ${val.toLocaleString('id-ID')}` };
    }
  }
  
  const cleanVal = val.toString().trim().toLowerCase();
  
  if (
    cleanVal === '0' || 
    cleanVal === '0.00' || 
    cleanVal === 'rp0.00' || 
    cleanVal === 'rp0' || 
    cleanVal === 'rp 0' || 
    cleanVal === '-' || 
    cleanVal.includes('free') || 
    cleanVal.includes('gratis') || 
    cleanVal.includes('no apc')
  ) {
    return { isFree: true, apc: 'Gratis (No APC)' };
  }
  
  // Coba ambil angka saja
  const digitsOnly = cleanVal.replace(/[^\d]/g, '');
  if (digitsOnly !== '') {
    const num = parseInt(digitsOnly, 10);
    if (num === 0) {
      return { isFree: true, apc: 'Gratis (No APC)' };
    }
    if (val.toString().includes('$')) {
      return { isFree: false, apc: `$${num}` };
    }
    return { isFree: false, apc: `Rp ${num.toLocaleString('id-ID')}` };
  }
  
  return { isFree: false, apc: val.toString() };
}

// Konfigurasi file Excel dan index kolomnya
const excelConfigs = [
  {
    file: "DAFTAR 200+ JURNAL ILMIAH SCOPUS Q1-Q4 GRATIS TAHUN 2026 - SEMUA BIDANG.xlsx",
    type: "Scopus",
    isFastTrack: false,
    map: (row) => ({
      title: row[1],
      originalSubject: row[2],
      desc: row[3] || 'Tidak ada deskripsi.',
      originalRank: row[4],
      apcVal: row[5],
      publisher: row[8] || 'Tidak Diketahui',
      url: row[9] || '#'
    })
  },
  {
    file: "DAFTAR JURNAL ILMIAH SINTA 1-2 GRATIS TAHUN 2026 - SEMUA BIDANG.xlsx",
    type: "Sinta",
    isFastTrack: false,
    map: (row) => ({
      title: row[1],
      originalSubject: row[2],
      desc: row[3] || 'Tidak ada deskripsi.',
      originalRank: row[4],
      apcVal: row[6], // Kolom 6 di Sinta 1-2 adalah biaya publikasi
      publisher: row[8] || 'Tidak Diketahui',
      url: row[9] || '#'
    })
  },
  {
    file: "DAFTAR JURNAL ILMIAH SINTA 3-4 GRATIS TAHUN 2026 - SEMUA BIDANG.xlsx",
    type: "Sinta",
    isFastTrack: false,
    map: (row) => ({
      title: row[1],
      originalSubject: row[3], // Kolom 3 adalah Subject Area
      desc: row[4] || 'Tidak ada deskripsi.', // Kolom 4 adalah Ruang Lingkup
      originalRank: row[5], // Kolom 5 adalah Akreditasi
      apcVal: row[10], // Kolom 10 adalah Biaya/APC
      publisher: row[2] || 'Tidak Diketahui', // Kolom 2 adalah Penerbit
      url: row[11] || '#' // Kolom 11 adalah Website/OJS
    })
  },
  {
    file: "DAFTAR JURNAL ILMIAH SINTA 5-6 GRATIS TAHUN 2026 - SEMUA BIDANG.xlsx",
    type: "Sinta",
    isFastTrack: false,
    map: (row) => ({
      title: row[1],
      originalSubject: row[2],
      desc: row[3] || 'Tidak ada deskripsi.',
      originalRank: row[4],
      apcVal: row[5],
      publisher: row[7] || 'Tidak Diketahui',
      url: row[8] || '#'
    })
  },
  {
    file: "DAFTAR JURNAL ILMIAH SINTA FAST TRACK - TAHUN 2026 - SEMUA BIDANG.xlsx",
    type: "Sinta",
    isFastTrack: true,
    map: (row) => ({
      title: row[1],
      originalSubject: row[2],
      desc: row[3] || 'Tidak ada deskripsi.',
      originalRank: row[4],
      apcVal: row[5],
      publisher: row[8] || 'Tidak Diketahui',
      url: row[9] || '#',
      responseTime: row[6] ? row[6].toString().trim() : 'Tidak Disebutkan'
    })
  },
  {
    file: "DAFTAR JURNAL ILMIAH SINTA GRATIS TAHUN 2026 - BIDANG PENGABDIAN MASARAKAT.xlsx",
    type: "Sinta",
    isFastTrack: false,
    map: (row) => ({
      title: row[1],
      originalSubject: row[2],
      desc: row[3] || 'Tidak ada deskripsi.',
      originalRank: row[4],
      apcVal: row[5],
      publisher: row[7] || 'Tidak Diketahui',
      url: row[8] || '#'
    })
  }
];

const compiledJournals = [];
const seenTitles = new Set();
let nextId = 1;

excelConfigs.forEach(config => {
  const filePath = path.join(__dirname, config.file);
  if (!fs.existsSync(filePath)) {
    console.log(`File tidak ditemukan: ${config.file}, dilewati.`);
    return;
  }

  console.log(`Memproses: ${config.file}...`);
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Cari baris header (yang ada teks "NO." atau "NO" atau "NAMA JURNAL")
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
      const row = rawRows[i];
      if (row && row.some(cell => typeof cell === 'string' && (cell.toUpperCase() === 'NO.' || cell.toUpperCase() === 'NO' || cell.toUpperCase() === 'NAMA JURNAL'))) {
        headerRowIdx = i;
        break;
      }
    }

    if (headerRowIdx === -1) {
      console.log(`[Peringatan] Header tidak ditemukan di file ${config.file}. Menggunakan default Row 8.`);
      headerRowIdx = 7; // Index 7 = Row 8
    }

    const dataRows = rawRows.slice(headerRowIdx + 1);
    let count = 0;

    dataRows.forEach(row => {
      // Pastikan baris memiliki data (kolom judul tidak kosong)
      if (!row || !row[1] || row[1].toString().trim() === '') return;

      const mapped = config.map(row);
      const titleCleaned = mapped.title.toString().trim();
      const titleLower = titleCleaned.toLowerCase();

      // Hindari duplikasi jurnal dengan judul yang persis sama
      if (seenTitles.has(titleLower)) return;
      seenTitles.add(titleLower);

      const subjMeta = mapSubject(mapped.originalSubject);
      const rank = parseRank(mapped.originalRank, config.type);
      const apcMeta = parseAPC(mapped.apcVal);
      const isFastTrack = config.isFastTrack || false;
      const responseTime = mapped.responseTime || null;

      // Pastikan URL valid
      let finalUrl = mapped.url.toString().trim();
      if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
        finalUrl = 'https://' + finalUrl;
      }

      compiledJournals.push({
        id: nextId++,
        title: titleCleaned,
        publisher: mapped.publisher.toString().trim(),
        type: config.type,
        rank: rank,
        subject: subjMeta.subject,
        keilmuan: subjMeta.keilmuan,
        apc: apcMeta.apc,
        isFree: apcMeta.isFree,
        isFastTrack: isFastTrack,
        responseTime: responseTime,
        url: finalUrl,
        description: mapped.desc.toString().trim().replace(/\r\n/g, ' ').replace(/\n/g, ' ')
      });

      count++;
    });

    console.log(`Berhasil mengekstrak ${count} jurnal dari ${config.file}.`);
  } catch (err) {
    console.error(`Gagal memproses file ${config.file}:`, err);
  }
});

console.log(`\nTotal Jurnal Terkumpul (Tanpa Duplikat): ${compiledJournals.length}`);

// Simpan data terkompilasi ke database.js
const outputContent = `/**
 * Database Jurnal Pusat Riset
 * Data ini digenerate secara otomatis dari file Excel.
 * Total Jurnal: ${compiledJournals.length}
 */
const JOURNAL_DATABASE = ${JSON.stringify(compiledJournals, null, 2)};

// Supaya bisa di-load via ES Module atau global script tag
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JOURNAL_DATABASE;
}
`;

fs.writeFileSync(path.join(__dirname, 'database.js'), outputContent, 'utf-8');
console.log(`File database.js berhasil diperbarui dengan ${compiledJournals.length} data jurnal.`);
