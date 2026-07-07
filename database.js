/**
 * Database Jurnal Pusat Riset
 * Data ini berisi daftar jurnal Scopus dan Sinta (Mock Data).
 * Anda dapat mengedit, menambah, atau mengganti seluruh isi array ini 
 * dengan data jurnal milik Anda sendiri.
 */
const JOURNAL_DATABASE = [
  // --- SCOPUS JOURNALS ---
  {
    id: 1,
    title: "International Journal of Mathematics and Computer Science",
    publisher: "Basioum",
    type: "Scopus",
    rank: "Q1",
    subject: "Sains & Teknologi",
    keilmuan: "Ilmu Komputer & Matematika",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "http://ijmcs.future-in-tech.net/",
    description: "Jurnal internasional yang fokus pada irisan ilmu matematika murni/terapan dan ilmu komputer tingkat lanjut."
  },
  {
    id: 2,
    title: "Turkish Journal of Computer and Mathematics Education",
    publisher: "Karadeniz Technical University",
    type: "Scopus",
    rank: "Q4",
    subject: "Sosial & Humaniora",
    keilmuan: "Pendidikan & Matematika",
    apc: "Berbayar ($150)",
    isFree: false,
    url: "https://turcomat.org/",
    description: "Fokus pada metode pengajaran matematika berbasis teknologi dan komputasi di sekolah menengah dan perguruan tinggi."
  },
  {
    id: 3,
    title: "Journal of Medical Internet Research",
    publisher: "JMIR Publications",
    type: "Scopus",
    rank: "Q1",
    subject: "Kesehatan",
    keilmuan: "Kedokteran & Teknologi Informasi",
    apc: "Gratis (No APC / Sponsor Institusi)",
    isFree: true,
    url: "https://www.jmir.org/",
    description: "Jurnal terkemuka untuk kesehatan digital, kedokteran preventif, dan aplikasi teknologi dalam bidang medis."
  },
  {
    id: 4,
    title: "Journal of Business Research",
    publisher: "Elsevier",
    type: "Scopus",
    rank: "Q1",
    subject: "Ekonomi & Bisnis",
    keilmuan: "Manajemen & Bisnis",
    apc: "Berbayar (Pilihan Open Access)",
    isFree: false,
    url: "https://www.sciencedirect.com/journal/journal-of-business-research",
    description: "Mempublikasikan penelitian teori dan aplikasi bisnis untuk praktisi dan akademisi di seluruh dunia."
  },
  {
    id: 5,
    title: "Asian Journal of Civil Engineering",
    publisher: "Springer",
    type: "Scopus",
    rank: "Q2",
    subject: "Sains & Teknologi",
    keilmuan: "Teknik Sipil",
    apc: "Gratis (Pilihan Green Open Access)",
    isFree: true,
    url: "https://www.springer.com/journal/42107",
    description: "Fokus pada rekayasa struktur, geoteknik, manajemen konstruksi, dan mitigasi bencana di wilayah Asia."
  },
  {
    id: 6,
    title: "Eurasian Journal of Applied Linguistics",
    publisher: "EJAL",
    type: "Scopus",
    rank: "Q3",
    subject: "Sosial & Humaniora",
    keilmuan: "Linguistik & Bahasa",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "http://www.ejal.info/",
    description: "Menerbitkan penelitian mengenai pengajaran bahasa kedua, sosiolinguistik, dan analisis wacana."
  },

  // --- SINTA JOURNALS ---
  {
    id: 7,
    title: "Jurnal Teknologi dan Sistem Komputer (JTSISK)",
    publisher: "Universitas Diponegoro",
    type: "Sinta",
    rank: "S1",
    subject: "Sains & Teknologi",
    keilmuan: "Teknik Komputer & Informatika",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "https://jtsisk.undip.ac.id/",
    description: "Jurnal terakreditasi Sinta 1 yang berfokus pada sistem embedded, jaringan komputer, dan rekayasa perangkat lunak."
  },
  {
    id: 8,
    title: "Jurnal Manajemen dan Kewirausahaan",
    publisher: "Universitas Kristen Petra",
    type: "Sinta",
    rank: "S2",
    subject: "Ekonomi & Bisnis",
    keilmuan: "Manajemen & Bisnis",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "https://jurnalmanajemen.petra.ac.id/",
    description: "Jurnal ilmiah yang menerbitkan artikel penelitian tentang manajemen umum, SDM, pemasaran, dan kewirausahaan."
  },
  {
    id: 9,
    title: "Jurnal Pendidikan Indonesia (JPI)",
    publisher: "Universitas Pendidikan Ganesha",
    type: "Sinta",
    rank: "S2",
    subject: "Sosial & Humaniora",
    keilmuan: "Pendidikan & Sosial",
    apc: "Berbayar (Rp 500.000)",
    isFree: false,
    url: "https://ejournal.undiksha.ac.id/index.php/JPI",
    description: "Menyediakan wadah bagi pendidik dan akademisi untuk mempublikasikan inovasi pembelajaran dan kebijakan pendidikan."
  },
  {
    id: 10,
    title: "Journal of the Indonesian Medical Association",
    publisher: "Ikatan Dokter Indonesia (IDI)",
    type: "Sinta",
    rank: "S2",
    subject: "Kesehatan",
    keilmuan: "Kedokteran & Kesehatan Masyarakat",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "http://minds.or.id/",
    description: "Jurnal resmi Ikatan Dokter Indonesia yang memuat artikel penelitian orisinal di bidang kedokteran klinis."
  },
  {
    id: 11,
    title: "Jurnal Sistem Informasi (JSI)",
    publisher: "Universitas Indonesia",
    type: "Sinta",
    rank: "S1",
    subject: "Sains & Teknologi",
    keilmuan: "Sistem Informasi",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "https://jsi.cs.ui.ac.id/",
    description: "Fokus pada tata kelola teknologi informasi, e-government, e-commerce, dan analisis sistem data besar."
  },
  {
    id: 12,
    title: "Masyarakat, Kebudayaan dan Politik",
    publisher: "Universitas Airlangga",
    type: "Sinta",
    rank: "S2",
    subject: "Sosial & Humaniora",
    keilmuan: "Sosiologi, Politik & Kebudayaan",
    apc: "Gratis (No APC)",
    isFree: true,
    url: "https://e-journal.unair.ac.id/MKP",
    description: "Menyajikan hasil kajian sosiologi politik, kebijakan publik, antropologi budaya, dan hubungan internasional."
  }
];

// Supaya bisa di-load via ES Module atau global script tag
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JOURNAL_DATABASE;
}
