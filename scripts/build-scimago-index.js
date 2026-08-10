/**
 * Konversi dataset SCImago Journal Rank (CSV, unduh dari
 * https://www.scimagojr.com/journalrank.php) menjadi index ISSN -> kuartil
 * yang dipakai server.js untuk memperkaya hasil pencarian OpenAlex dengan
 * peringkat jurnal (Q1-Q4). Jalankan ulang setiap kali dataset SCImago
 * diperbarui (biasanya tahunan):
 *
 *   node scripts/build-scimago-index.js path/to/scimagojr_2025.csv
 */
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Penggunaan: node scripts/build-scimago-index.js <path-ke-csv-scimago>');
  process.exit(1);
}

// Parser CSV manual (bukan cuma split by ";") karena field seperti "Categories"
// berisi titik koma DI DALAM tanda kutip (mis. "Hematology (Q1); Oncology (Q1)"),
// jadi split naif akan memecah baris jadi kolom yang salah.
function parseCsv(content, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeIssn(raw) {
  return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

const content = fs.readFileSync(csvPath, 'utf-8');
const rows = parseCsv(content, ';');
const header = rows[0].map(h => h.trim());
const idx = {
  title: header.indexOf('Title'),
  issn: header.indexOf('Issn'),
  sjr: header.indexOf('SJR'),
  quartile: header.indexOf('SJR Best Quartile'),
  hIndex: header.indexOf('H index'),
  publisher: header.indexOf('Publisher'),
  categories: header.indexOf('Categories')
};

const index = {};
let matched = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  if (!r || r.length < 2) continue;
  const quartile = (r[idx.quartile] || '').trim();
  if (!/^Q[1-4]$/.test(quartile)) continue; // "-" = tidak punya SJR quartile
  const issnField = r[idx.issn] || '';
  const issns = issnField.split(',').map(normalizeIssn).filter(Boolean);
  if (!issns.length) continue;

  const record = {
    quartile,
    sjr: parseFloat((r[idx.sjr] || '').replace(',', '.')) || null,
    hIndex: parseInt(r[idx.hIndex], 10) || null,
    title: (r[idx.title] || '').trim()
  };

  issns.forEach(issn => { index[issn] = record; });
  matched++;
}

const outPath = path.join(__dirname, '..', 'data-static', 'scimago-quartiles.json');
fs.writeFileSync(outPath, JSON.stringify(index));
console.log(`Berhasil memproses ${matched} jurnal (dari ${rows.length - 1} baris CSV) -> ${Object.keys(index).length} entri ISSN.`);
console.log(`Tersimpan ke: ${outPath}`);
