# Pusat Riset - Database Jurnal Scopus & Sinta Interaktif

Pusat Riset adalah platform berbasis web interaktif, responsif, dan premium yang dirancang untuk membantu akademisi, peneliti, dan mahasiswa di Indonesia dalam mencari rekomendasi jurnal ilmiah terindeks Scopus dan terakreditasi Sinta secara instan dan mudah.

## 🚀 Fitur Utama

- **Pencarian Real-Time**: Ketik kata kunci (keyword), nama jurnal, penerbit, atau rumpun keilmuan untuk melihat rekomendasi secara langsung.
- **Filter Fleksibel**:
  - Filter kategori berdasarkan **Scopus** atau **Sinta**.
  - Filter berdasarkan **Rumpun Keilmuan** (Sains & Teknologi, Sosial & Humaniora, Kesehatan, Ekonomi & Bisnis).
  - Filter berdasarkan **Tingkat/Kuartil** (Scopus Q1-Q4, Sinta S1-S6).
  - Opsi instan menampilkan hanya jurnal **Gratis (Tanpa Biaya APC)**.
- **Tampilan Fleksibel**: Toggle tata letak pencarian antara **Tampilan Grid (Grid View)** dan **Tampilan Daftar (List View)**.
- **Dasbor Statistik**: Tampilan interaktif jumlah jurnal Scopus, Sinta, dan jurnal gratis (No APC).
- **Desain Premium**: Tema gelap premium dengan sentuhan glassmorphism, aksen pendaran neon, serta ramah perangkat mobile (responsif).

## 🛠️ Struktur Proyek

```bash
pusat-riset/
│
├── index.html       # Struktur markup halaman utama
├── styles.css       # File style CSS sistem desain visual
├── app.js           # Logika interaktivitas pencarian, filter, dan layout
├── database.js      # Berisi data mentah (array JSON) jurnal Scopus & Sinta
└── README.md        # File dokumentasi proyek (ini)
```

## ⚙️ Cara Menjalankan Proyek secara Lokal

Karena website ini dibangun menggunakan **HTML, CSS, dan JavaScript murni**, Anda tidak perlu melakukan kompilasi atau instalasi dependency yang rumit. 

### Opsi 1: Buka Langsung (Tanpa Server)
1. Unduh atau clone repositori ini ke komputer Anda.
2. Klik ganda (double-click) file `index.html` untuk langsung membukanya di browser favorit Anda (Google Chrome, Firefox, Edge, Safari, dll).

### Opsi 2: Menggunakan Local Development Server (Sangat Direkomendasikan)
Untuk performa optimal dan menghindari isu pembatasan browser (CORS jika dikembangkan lebih lanjut):
- **VS Code**: Install ekstensi **Live Server**, lalu klik kanan pada `index.html` dan pilih **Open with Live Server**.
- **Python**: Jalankan perintah berikut di terminal pada direktori proyek Anda:
  ```bash
  python -m http.server 8000
  ```
  Kemudian buka browser dan akses `http://localhost:8000`.

## 🗃️ Cara Mengubah/Menambahkan Database Jurnal Anda Sendiri

Semua data jurnal disimpan dalam file [database.js](file:///C:/Users/user/.gemini/antigravity/scratch/pusat-riset/database.js). Anda dapat membuka file tersebut dengan editor teks (seperti VS Code atau Notepad) dan memodifikasi array `JOURNAL_DATABASE`.

### Struktur Objek Jurnal
Setiap jurnal diwakili oleh objek JavaScript dengan struktur sebagai berikut:

```javascript
{
  id: 1, // Angka unik pengenal jurnal
  title: "Nama Lengkap Jurnal Ilmiah",
  publisher: "Nama Penerbit / Institusi",
  type: "Scopus", // Pilihan nilai: "Scopus" atau "Sinta"
  rank: "Q1",     // Pilihan nilai: Scopus ("Q1", "Q2", "Q3", "Q4") atau Sinta ("S1" s.d. "S6")
  subject: "Sains & Teknologi", // Rumpun: "Sains & Teknologi", "Sosial & Humaniora", "Kesehatan", "Ekonomi & Bisnis"
  keilmuan: "Nama Spesifik Bidang", // Contoh: "Ilmu Komputer", "Sosiologi", "Kedokteran Gigi"
  apc: "Gratis (No APC)", // Informasi biaya publikasi
  isFree: true, // Beri nilai 'true' jika Gratis (tanpa biaya APC), atau 'false' jika berbayar
  url: "https://link-situs-jurnal.com", // Link aktif menuju website jurnal
  description: "Penjelasan ringkas mengenai fokus dan cakupan jurnal ilmiah ini."
}
```

Cukup tambahkan objek baru ke dalam array dengan mengikuti struktur di atas, simpan file `database.js`, lalu segarkan (refresh) halaman website Anda di browser untuk melihat perubahannya secara instan!

---
Dibuat dengan ❤️ untuk mendukung iklim riset terbuka di Indonesia.
