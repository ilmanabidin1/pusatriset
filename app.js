/**
 * Logika Aplikasi JurnalHub
 * Mengatur pencarian, filter, tampilan grid/list, lazy-loading, dan perhitungan statistik.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Escape teks yang berasal dari input user (atau konten yang meniru input user,
  // mis. judul/keyword/abstrak yang tersimpan di riwayat) sebelum ditulis ke
  // innerHTML, supaya tag seperti <script>/<img onerror> tidak ikut dieksekusi.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Render subset Markdown (heading, bold, italic, kode inline, list, hr) jadi HTML
  // dengan aman: escape dulu SEMUA teks, baru transformasi pola markdown di atas
  // teks yang sudah di-escape - jadi HTML mentah dari input tetap tidak bisa lolos.
  function renderMarkdownSafe(text) {
    const escaped = escapeHtml(text);
    const lines = escaped.split('\n');
    const htmlParts = [];
    let listBuffer = [];
    let listType = null;

    function flushList() {
      if (listBuffer.length > 0 && listType) {
        htmlParts.push(`<${listType} class="chat-md-list">` + listBuffer.map(li => `<li>${li}</li>`).join('') + `</${listType}>`);
      }
      listBuffer = [];
      listType = null;
    }

    function inline(str) {
      return str
        // Model kadang menyisipkan tag <br> literal di dalam sel tabel/list untuk
        // memaksa baris baru (markdown tabel tidak punya cara lain). Karena teks
        // sudah di-escape, ini ubah balik pola &lt;br&gt; yang sudah aman itu jadi
        // elemen <br> sungguhan - bukan mengizinkan tag HTML sembarangan lolos.
        .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code class="chat-md-code">$1</code>');
    }

    // Baris tabel GFM: "| sel | sel |" - pisah per kolom, buang sel kosong di
    // ujung akibat pipe pembuka/penutup.
    function isTableRow(line) {
      return /^\|.*\|$/.test(line);
    }
    function isTableSeparator(line) {
      return /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');
    }
    function parseTableRow(line) {
      return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    }

    let i = 0;
    while (i < lines.length) {
      // Model kadang menaruh <br> literal di AWAL baris (sebelum "- item" berikutnya)
      // alih-alih newline biasa - buang dulu supaya baris tetap terdeteksi sebagai
      // list/heading/dst, bukan jadi paragraf terpisah yang mulai dengan "-" mentah.
      const trimmed = lines[i].trim().replace(/^(&lt;br\s*\/?&gt;\s*)+/i, '');

      if (trimmed === '') {
        flushList();
        i++;
        continue;
      }

      // Tabel: baris header diikuti baris separator (|---|---|)
      if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
        flushList();
        const headerCells = parseTableRow(trimmed);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && isTableRow(lines[i].trim())) {
          bodyRows.push(parseTableRow(lines[i].trim()));
          i++;
        }
        const theadHtml = '<tr>' + headerCells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr>';
        const tbodyHtml = bodyRows.map(row => '<tr>' + row.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('');
        htmlParts.push(`<div class="chat-md-table-wrapper"><table class="chat-md-table"><thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table></div>`);
        continue;
      }

      if (/^-{3,}$/.test(trimmed)) {
        flushList();
        htmlParts.push('<hr class="chat-md-hr">');
        i++;
        continue;
      }
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushList();
        const level = headingMatch[1].length;
        htmlParts.push(`<h${level} class="chat-md-heading">${inline(headingMatch[2])}</h${level}>`);
        i++;
        continue;
      }
      const ulMatch = trimmed.match(/^[-*]\s+(.*)$/);
      if (ulMatch) {
        if (listType !== 'ul') { flushList(); listType = 'ul'; }
        listBuffer.push(inline(ulMatch[1]));
        i++;
        continue;
      }
      const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
      if (olMatch) {
        if (listType !== 'ol') { flushList(); listType = 'ol'; }
        listBuffer.push(inline(olMatch[1]));
        i++;
        continue;
      }
      flushList();
      htmlParts.push(`<p class="chat-md-p">${inline(trimmed)}</p>`);
      i++;
    }
    flushList();
    return htmlParts.join('') || '<p class="chat-md-p"></p>';
  }

  // --- BILINGUAL (LOCALIZATION) SYSTEM ---
  const TRANSLATIONS = {
    id: {
      beranda: "Beranda",
      "database-jurnal": "Database Jurnal",
      "ai-research": "Asisten AI",
      "research-chat": "JurnalHub Intelligence",
      templates: "Template Jurnal",
      "prompt-bank": "Prompt Bank",
      tersimpan: "Tersimpan",
      riwayat: "Riwayat AI",
      pengaturan: "Pengaturan",
      upgrade_pro: "Upgrade ke PRO",
      upgrade_desc: "Buka AI Match Score & filter tanpa batas",
      upgrade_btn: "Upgrade Sekarang",
      hello: "Halo, ",
      hello_subtitle: "Mau nulis apa sekarang?",
      logout: "Keluar",
      // Matcher
      matcher_title: "AI Journal Match Score",
      matcher_desc: "Masukkan metadata artikel Anda untuk menemukan kecocokan jurnal Scopus & Sinta terbaik.",
      matcher_input_title: "JUDUL ARTIKEL",
      matcher_input_keywords: "KATA KUNCI (SEPARASI DENGAN KOMA)",
      matcher_input_abstract: "ABSTRAK ARTIKEL",
      matcher_btn_run: "Mulai Analisis Jurnal",
      matcher_btn_running: "Menganalisis Jurnal...",
      // Drafting
      drafting_title: "AI Outline Generator",
      drafting_desc: "Buat kerangka naskah jurnal ilmiah terstruktur secara otomatis berdasarkan judul dan abstrak riset Anda.",
      drafting_btn_run: "Susun Outline Draf",
      drafting_btn_running: "Menyusun Outline Draf...",
      // Lit Review
      lit_title: "AI Literature Review & Citation Finder",
      lit_desc: "Temukan publikasi Scopus & Sinta yang relevan, cari referensi terpercaya, dan buat naskah tinjauan pustaka.",
      lit_input_title: "TOPIK / JUDUL PENELITIAN",
      lit_btn_run: "Cari Referensi & Review",
      lit_btn_running: "Mencari & Meninjau Pustaka...",
      // Humanizer
      humanizer_title: "AI Humanizer & Paraphraser",
      humanizer_desc: "Paragrafkan ulang tulisan AI Anda agar memiliki gaya bahasa akademis yang natural dan lolos dari Turnitin AI detector.",
      humanizer_btn_run: "Mulai Humanisasi Teks",
      humanizer_btn_running: "Memproses Humanisasi...",
      humanizer_lbl_quota: "Sisa Kuota Kata",
      humanizer_lbl_quota_desc: "Kuota dihitung dari total kata: Input + Output",
      humanizer_input_lbl: "TEKS MASUKAN (AI)",
      humanizer_output_lbl: "HASIL HUMANISASI",
      // History
      history_title: "Riwayat Penggunaan AI",
      history_clear_btn: "Bersihkan Semua Riwayat",
      history_empty: "Tidak Ada Riwayat",
      history_empty_desc: "Anda belum pernah menggunakan alat AI dengan kategori ini.",
      // Quota
      quota_title: "Status & Kuota Asisten AI",
      quota_note_match: "Limit bulanan Claude",
       quota_note_lit: "Limit bulanan Lit Review",
       quota_note_humanizer: "Sisa kuota kata Humanizer",
       // Billing
       billing_title: "Transaksi & Kuitansi",
       billing_desc: "Berikut adalah riwayat pembayaran langganan atau pembelian kuota kata Anda. Gunakan tombol kuitansi untuk mengunduh bukti bayar resmi guna reimbursement kampus/hibah.",
       // Beranda Banner Slider
       banner: [
         { badge: "AI Match Score", title: "Temukan jurnal paling cocok untuk artikel Anda", desc: "Tempel judul & abstrak, biarkan AI mencocokkan ke ribuan jurnal Scopus & Sinta.", btn: "Mulai AI Match" },
         { badge: "AI Lit Review", title: "Buat tinjauan pustaka ilmiah dalam hitungan detik", desc: "Masukkan topik riset Anda, dapatkan analisis komprehensif, sitasi, dan ekspor draft instan.", btn: "Coba Lit Review" },
         { badge: "AI Outline Generator", title: "Buat kerangka naskah jurnal dalam hitungan menit", desc: "Susun outline Bab 1 s.d. Bab 5 secara sistematis dan terstruktur untuk memandu penulisan ilmiah Anda.", btn: "Mulai Outline" },
         { badge: "Prompt Bank", title: "Koleksi prompt pintar untuk publikasi ilmiah", desc: "Gunakan ribuan formula instruksi siap pakai untuk paraphrase akademis dan respon reviewer.", btn: "Buka Prompt Bank" }
       ],
       // AI For Research tab
       ai_research_header: "AI For Research",
       ai_research_desc: "Pilih salah satu asisten kecerdasan buatan (AI) di bawah ini untuk mempercepat riset dan penulisan ilmiah Anda.",
       ai_research_open_btn: "Buka Fitur",
       ai_research_cards: [
         { title: "JurnalHub Humanizer Engine", desc: "Lolos deteksi Turnitin dan GPTZero hingga 98 persen, tanpa mengubah makna tulisanmu.", btn: "Humanisasi Teks" },
         { title: "Cek Peluang Diterima Jurnal", desc: "Masukkan judul dan abstrak, dapatkan daftar jurnal Scopus & Sinta yang paling cocok lengkap dengan skor kecocokan, dalam hitungan detik.", btn: "Cek Skor Sekarang" },
         { title: "AI Outline Generator", desc: "Buat kerangka naskah (outline) jurnal terstruktur dari Bab 1 s.d Bab 5 secara sistematis untuk memandu penulisan karya ilmiah Anda.", btn: "Buat Outline" },
         { title: "AI Literature Review", desc: "Susun tinjauan pustaka lengkap dengan sitasi otomatis dari jurnal terpercaya, biasanya butuh berhari-hari, sekarang dalam hitungan menit.", btn: "Cari Sitasi" }
       ],
      // Beranda widgets baru
      beranda_db_title: "Jelajahi Database Jurnal",
      beranda_db_desc_suffix: "jurnal Scopus & Sinta siap dijelajahi",
      beranda_db_btn: "Buka Database Jurnal",
      beranda_recent_title: "Aktivitas Terakhir",
      beranda_recent_empty: "Belum ada aktivitas AI. Yuk mulai dari salah satu fitur di atas!",
      // Label tipe riwayat & teks fallback (dipakai di widget Beranda & tab Riwayat)
      hist_type_match: "Journal Matcher",
      hist_type_draft: "Drafting Companion",
      hist_type_litreview: "Literature Review",
      hist_type_humanizer: "Humanizer Engine",
      hist_type_generic: "AI Tool",
      hist_fallback_match: "Pencarian Kesesuaian Jurnal",
      hist_fallback_draft: "Pembuatan Draf Jurnal",
      hist_fallback_litreview: "AI Literature Review",
      hist_fallback_humanizer: "Teks Terhumanisasi",
      hist_fallback_generic: "Penggunaan Alat AI",
      hist_desc_keywords: "Keywords",
      hist_desc_recommendations: "Rekomendasi",
      hist_desc_journals: "jurnal",
      hist_desc_abstract: "Abstrak",
      hist_desc_references: "Referensi",
      hist_desc_papers: "paper ilmiah",
      hist_desc_mode: "Mode",
      hist_desc_mode_academic: "Akademik",
      hist_desc_mode_standard: "Standar",
      hist_desc_originality: "Nilai Keaslian",
      hist_desc_cost: "Biaya",
      hist_desc_words: "kata",
      hist_btn_detail: "Lihat Detail",
      hist_btn_delete_title: "Hapus riwayat ini",
      banner_slide0_free_btn: "Coba AI Match (Gratis 1x/Bulan)",
      // Pengaturan (Settings)
      settings_profile_title: "Profil & Keanggotaan",
      settings_membership_label: "Tipe Keanggotaan",
      lbl_profile_name: "Nama Lengkap",
      lbl_profile_faculty: "Fakultas",
      lbl_profile_university: "Universitas / Instansi",
      btn_save_profile: "Simpan Perubahan Profil",
      settings_prefs_title: "Preferensi Riset Default",
      settings_prefs_desc: "Setel rumpun keilmuan bawaan agar aplikasi langsung menyaring daftar jurnal sesuai bidang Anda saat dibuka.",
      lbl_prefs_subject: "RUMPUN UTAMA",
      lbl_prefs_type: "KATEGORI JURNAL",
      btn_save_prefs: "Simpan Preferensi",
      settings_security_title: "Keamanan & Kata Sandi",
      lbl_old_password: "Kata Sandi Lama",
      lbl_new_password: "Kata Sandi Baru",
      lbl_confirm_password: "Konfirmasi Kata Sandi Baru",
      btn_update_password: "Perbarui Kata Sandi",
      // Template Jurnal
      templates_badge: "Template Jurnal Internasional",
      templates_title: "Unduh Template Jurnal (.docx)",
      templates_desc: "Gunakan template resmi ini untuk memformat manuskrip Anda sesuai standar penerbit internasional.",
      // Prompt Bank
      prompt_bank_badge: "Database Prompt Akademisi",
      prompt_bank_desc: "Koleksi 2100+ prompt super siap pakai untuk mempercepat riset Scopus dan penulisan Tesis/Disertasi Anda.",
      prompt_bank_tab_scopus: "Jurnal Scopus",
      prompt_bank_tab_tesis: "Tesis & Disertasi",
      prompt_bank_search_placeholder: "Cari kata di dalam prompt...",
      prompt_bank_stages_heading: "Kategori Tahapan",
      // Riwayat loading/error
      hist_loading: "Memuat riwayat penggunaan...",
      hist_load_error_title: "Gagal Memuat Riwayat",
      hist_load_error_generic: "Terjadi kesalahan pada server.",
      hist_conn_error_title: "Kesalahan Koneksi",
      hist_conn_error_desc: "Gagal menghubungkan ke server JurnalHub.",
      // JurnalHub Intelligence
      research_chat_badge: "JurnalHub Intelligence",
      research_chat_title: "Diskusi dengan JurnalHub Intelligence",
      research_chat_desc: "<strong>Bukan LLM biasa.</strong> JurnalHub Intelligence dikurasi khusus untuk selalu menjawab jujur, kritis, dan tidak asal mengiyakan (no yes-man) - layaknya profesor pembimbing sungguhan.",
      research_chat_empty: "Mulai diskusi dengan mengetik pertanyaan riset Anda di bawah ini.",
      research_chat_input_placeholder: "Tulis pertanyaan riset Anda...",
      research_chat_clear: "Mulai percakapan baru",
      research_chat_disclaimer: "Asisten AI bisa saja keliru - selalu verifikasi informasi penting secara mandiri.",
      research_chat_lock_title: "Fitur PRO Khusus Pelanggan",
      research_chat_lock_desc: "JurnalHub Intelligence hanya tersedia untuk akun Premium & Ultimate. Upgrade untuk mulai berdiskusi seputar riset Anda.",
      research_chat_upgrade_btn: "Upgrade PRO"
    },
    en: {
      beranda: "Home",
      "database-jurnal": "Journal Database",
      "ai-research": "AI Assistant",
      "research-chat": "JurnalHub Intelligence",
      templates: "Journal Templates",
      "prompt-bank": "Prompt Bank",
      tersimpan: "Bookmarks",
      riwayat: "AI History",
      pengaturan: "Settings",
      upgrade_pro: "Upgrade to PRO",
      upgrade_desc: "Unlock Match Score & unlimited filters",
      upgrade_btn: "Upgrade Now",
      hello: "Hello, ",
      hello_subtitle: "What would you like to write today?",
      logout: "Log Out",
      // Matcher
      matcher_title: "AI Journal Match Score",
      matcher_desc: "Enter your article metadata to find the best matching Scopus & Sinta journals.",
      matcher_input_title: "ARTICLE TITLE",
      matcher_input_keywords: "KEYWORDS (SEPARATED BY COMMA)",
      matcher_input_abstract: "ARTICLE ABSTRACT",
      matcher_btn_run: "Start Journal Matching",
      matcher_btn_running: "Matching Journals...",
      // Drafting
      drafting_title: "AI Outline Generator",
      drafting_desc: "Create a structured scientific journal outline automatically based on your research title and abstract.",
      drafting_btn_run: "Generate Draft Outline",
      drafting_btn_running: "Generating Draft Outline...",
      // Lit Review
      lit_title: "AI Literature Review & Citation Finder",
      lit_desc: "Find relevant Scopus & Sinta publications, search trusted references, and generate literature review texts.",
      lit_input_title: "RESEARCH TOPIC / TITLE",
      lit_btn_run: "Search References & Review",
      lit_btn_running: "Searching & Generating Review...",
      // Humanizer
      humanizer_title: "AI Humanizer & Paraphraser",
      humanizer_desc: "Paraphrase your AI text to have a natural academic writing style that passes Turnitin AI detectors.",
      humanizer_btn_run: "Start Paraphrasing Text",
      humanizer_btn_running: "Paraphrasing Text...",
      humanizer_lbl_quota: "Remaining Words Quota",
      humanizer_lbl_quota_desc: "Quota calculated from total words: Input + Output",
      humanizer_input_lbl: "INPUT TEXT (AI)",
      humanizer_output_lbl: "HUMANIZED RESULT",
      // History
      history_title: "AI Usage History",
      history_clear_btn: "Clear All History",
      history_empty: "No History Found",
      history_empty_desc: "You haven't used any AI tools in this category. Start an analysis or paraphrasing to create history.",
      // Quota
      quota_title: "AI Assistant Quota Status",
      quota_note_match: "Claude monthly limit",
      quota_note_lit: "Lit Review monthly limit",
      quota_note_humanizer: "Remaining Humanizer words",
      // Billing
      billing_title: "Transactions & Receipts",
      billing_desc: "Here is your payment subscription or word quota purchase history. Use the receipt button to download official payment proof for university/grant reimbursement.",
      // Beranda Banner Slider
      banner: [
        { badge: "AI Match Score", title: "Find the best matching journal for your article", desc: "Paste your title & abstract, let AI match it to thousands of Scopus & Sinta journals.", btn: "Start AI Match" },
        { badge: "AI Lit Review", title: "Build a scholarly literature review in seconds", desc: "Enter your research topic, get a comprehensive analysis, citations, and instant draft export.", btn: "Try Lit Review" },
        { badge: "AI Outline Generator", title: "Build a scholarly journal outline in minutes", desc: "Construct a structured outline from Chapter 1 to Chapter 5 systematically to guide your scientific writing.", btn: "Start Outline" },
        { badge: "Prompt Bank", title: "A smart prompt collection for scholarly publishing", desc: "Use thousands of ready-made instruction formulas for academic paraphrasing and reviewer responses.", btn: "Open Prompt Bank" }
      ],
      // AI For Research tab
      ai_research_header: "AI For Research",
      ai_research_desc: "Pick one of the AI assistants below to speed up your research and academic writing.",
      ai_research_open_btn: "Open Feature",
      ai_research_cards: [
        { title: "JurnalHub Humanizer Engine", desc: "Rewrite AI-generated text so it passes AI detectors (like Turnitin & GPTZero) with very natural academic language.", btn: "Humanize Text" },
        { title: "Check Journal Acceptance Probability", desc: "Enter title and abstract, get the most suitable Scopus & Sinta journals complete with matching scores, in seconds.", btn: "Check Score Now" },
        { title: "AI Outline Generator", desc: "Create a structured manuscript outline from Chapter 1 to Chapter 5 systematically to guide your scientific writing process.", btn: "Generate Outline" },
        { title: "AI Literature Review", desc: "Build a comprehensive literature review complete with automatic citations from trusted journals, usually takes days, now in minutes.", btn: "Search Citations" }
      ],

      // Beranda new widgets
      beranda_db_title: "Explore the Journal Database",
      beranda_db_desc_suffix: "Scopus & Sinta journals ready to explore",
      beranda_db_btn: "Open Journal Database",
      beranda_recent_title: "Recent Activity",
      beranda_recent_empty: "No AI activity yet. Start with one of the features above!",
      // History type labels & fallback text (used in Beranda widget & Riwayat tab)
      hist_type_match: "Journal Matcher",
      hist_type_draft: "Drafting Companion",
      hist_type_litreview: "Literature Review",
      hist_type_humanizer: "Humanizer Engine",
      hist_type_generic: "AI Tool",
      hist_fallback_match: "Journal Match Search",
      hist_fallback_draft: "Journal Draft Creation",
      hist_fallback_litreview: "AI Literature Review",
      hist_fallback_humanizer: "Humanized Text",
      hist_fallback_generic: "AI Tool Usage",
      hist_desc_keywords: "Keywords",
      hist_desc_recommendations: "Recommendations",
      hist_desc_journals: "journals",
      hist_desc_abstract: "Abstract",
      hist_desc_references: "References",
      hist_desc_papers: "papers",
      hist_desc_mode: "Mode",
      hist_desc_mode_academic: "Academic",
      hist_desc_mode_standard: "Standard",
      hist_desc_originality: "Originality Score",
      hist_desc_cost: "Cost",
      hist_desc_words: "words",
      hist_btn_detail: "View Detail",
      hist_btn_delete_title: "Delete this entry",
      banner_slide0_free_btn: "Try AI Match (Free 1x/Month)",
      // Pengaturan (Settings)
      settings_profile_title: "Profile & Membership",
      settings_membership_label: "Membership Type",
      lbl_profile_name: "Full Name",
      lbl_profile_faculty: "Faculty",
      lbl_profile_university: "University / Institution",
      btn_save_profile: "Save Profile Changes",
      settings_prefs_title: "Default Research Preferences",
      settings_prefs_desc: "Set a default subject area so the app filters the journal list to your field as soon as it opens.",
      lbl_prefs_subject: "MAIN SUBJECT AREA",
      lbl_prefs_type: "JOURNAL CATEGORY",
      btn_save_prefs: "Save Preferences",
      settings_security_title: "Security & Password",
      lbl_old_password: "Current Password",
      lbl_new_password: "New Password",
      lbl_confirm_password: "Confirm New Password",
      btn_update_password: "Update Password",
      // Template Jurnal
      templates_badge: "International Journal Templates",
      templates_title: "Download Journal Template (.docx)",
      templates_desc: "Use this official template to format your manuscript to international publisher standards.",
      // Prompt Bank
      prompt_bank_badge: "Academic Prompt Database",
      prompt_bank_desc: "A collection of 2100+ ready-to-use prompts to speed up your Scopus research and Thesis/Dissertation writing.",
      prompt_bank_tab_scopus: "Scopus Journal",
      prompt_bank_tab_tesis: "Thesis & Dissertation",
      prompt_bank_search_placeholder: "Search words within prompts...",
      prompt_bank_stages_heading: "Stage Categories",
      // Riwayat loading/error
      hist_loading: "Loading usage history...",
      hist_load_error_title: "Failed to Load History",
      hist_load_error_generic: "A server error occurred.",
      hist_conn_error_title: "Connection Error",
      hist_conn_error_desc: "Failed to connect to the JurnalHub server.",
      // JurnalHub Intelligence
      research_chat_badge: "JurnalHub Intelligence",
      research_chat_title: "Discuss with JurnalHub Intelligence",
      research_chat_desc: "<strong>Not just another LLM.</strong> JurnalHub Intelligence is specifically curated to always answer honestly, critically, and without being a yes-man - like a real supervising professor.",
      research_chat_empty: "Start a discussion by typing your research question below.",
      research_chat_input_placeholder: "Type your research question...",
      research_chat_clear: "Start a new conversation",
      research_chat_disclaimer: "The AI assistant can make mistakes - always verify important information independently.",
      research_chat_lock_title: "PRO Feature For Subscribers Only",
      research_chat_lock_desc: "JurnalHub Intelligence is only available for Premium & Ultimate accounts. Upgrade to start discussing your research.",
      research_chat_upgrade_btn: "Upgrade PRO"
    }
  };

  // DOM Elements
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearch');
  const filterType = document.getElementById('filterType');
  const filterSubject = document.getElementById('filterSubject');
  const filterRank = document.getElementById('filterRank');
  const checkFreeOnly = document.getElementById('checkFreeOnly');
  const checkFastTrackOnly = document.getElementById('checkFastTrackOnly');
  const resetFiltersBtn = document.getElementById('resetFilters');
  const resultsCount = document.getElementById('resultsCount');
  const resultsContainer = document.getElementById('resultsContainer');
  const loadMoreContainer = document.getElementById('loadMoreContainer');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const articleTitle = document.getElementById('articleTitle');
  const articleKeywords = document.getElementById('articleKeywords');
  const articleAbstract = document.getElementById('articleAbstract');
  const runMatchBtn = document.getElementById('runMatch');
  const clearMatchBtn = document.getElementById('clearMatch');
  const matchSummary = document.getElementById('matchSummary');
  const matchResultsContainer = document.getElementById('matchResultsContainer');
  
  const viewGridBtn = document.getElementById('viewGrid');
  const viewListBtn = document.getElementById('viewList');
  
  const statScopusVal = document.getElementById('statScopusVal');
  const statSintaVal = document.getElementById('statSintaVal');
  const statFreeVal = document.getElementById('statFreeVal');
  
  const mobileToggle = document.getElementById('mobileToggle');
  const navLinks = document.querySelector('.nav-links');

  // State Management
  let currentLayout = 'grid'; // 'grid' atau 'list'
  let visibleCount = 30;     // Jumlah kartu awal yang dirender (lazy-loading)
  let activeJournals = [];   // Menyimpan hasil filter saat ini
  let currentUser = { loggedIn: false, type: 'free' };
  let currentCitations = [];
  let justGeneratedDraft = false;
  let justGeneratedLitReview = false;
  let justGeneratedHumanizer = false;

  window.resetJustGeneratedFlags = () => {
    justGeneratedDraft = false;
    justGeneratedLitReview = false;
    justGeneratedHumanizer = false;
    checkAuthState();
  };

  // --- DARK MODE TOGGLE ---
  (function initDarkMode() {
    const html = document.documentElement;
    const toggleBtn = document.getElementById('darkModeToggleBtn');
    const icon = document.getElementById('darkModeIcon');
    const savedTheme = localStorage.getItem('jurnalhub_theme') || 'light';

    function applyTheme(theme) {
      if (theme === 'dark') {
        html.setAttribute('data-theme', 'dark');
        if (icon) { icon.className = 'fa-solid fa-sun'; }
        if (toggleBtn) toggleBtn.title = 'Beralih ke Mode Terang';
      } else {
        html.removeAttribute('data-theme');
        if (icon) { icon.className = 'fa-solid fa-moon'; }
        if (toggleBtn) toggleBtn.title = 'Beralih ke Mode Gelap';
      }
      localStorage.setItem('jurnalhub_theme', theme);
    }

    applyTheme(savedTheme);

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        applyTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
  })();

  // --- 0. AUTHENTICATION & USER STATE ---
  async function checkAuthState() {
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        const data = await response.json();
        currentUser = data;
        window.currentUser = currentUser;

        if (!currentUser.loggedIn) {
          window.location.href = '/auth.html';
          return;
        }

        // Update UI based on user type (sidebar profile & locks)
        const profileEmail = document.getElementById('profileEmail');
        const profileType = document.getElementById('profileType');
        const profileAvatar = document.getElementById('profileAvatar');
        const sidebarUpgradeCard = document.getElementById('sidebarUpgradeCard');
        const headerUpgradeBtn = document.getElementById('headerUpgradeBtn');
        const bannerUpgradeBtn = document.getElementById('bannerUpgradeBtn') || document.querySelector('.banner-slide[data-slide-index="0"] .banner-action-btn');
        const matchPremiumLock = document.getElementById('matchPremiumLock');

        if (currentUser.user) {
          const emailPrefix = currentUser.user.email.split('@')[0];
          const displayName = currentUser.user.name ? currentUser.user.name : emailPrefix;
          if (profileEmail) profileEmail.textContent = displayName;
          
          if (profileAvatar) {
            if (currentUser.user.profilePic) {
              profileAvatar.innerHTML = `<img src="${currentUser.user.profilePic}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
            } else {
              profileAvatar.innerHTML = emailPrefix.substring(0, 2).toUpperCase();
            }
          }

          // Update settings fields
          const settingsEmail = document.getElementById('settingsEmail');
          const settingsAccountType = document.getElementById('settingsAccountType');
          if (settingsEmail) settingsEmail.textContent = currentUser.user.email;
          if (settingsAccountType) {
            let typeLabel = 'Akun Free';
            if (currentUser.user.type === 'ultimate') typeLabel = 'Akun Ultimate';
            else if (currentUser.user.type === 'premium') typeLabel = 'Akun Premium';
            
            let expiryText = '';
            if (currentUser.user.paymentExpiredAt) {
              const diffTime = new Date(currentUser.user.paymentExpiredAt) - new Date();
              const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
              expiryText = ` (Aktif ${daysLeft > 0 ? daysLeft : 0} Hari Lagi)`;
            }
            settingsAccountType.textContent = typeLabel + expiryText;
            settingsAccountType.style.color = (currentUser.user.type === 'premium' || currentUser.user.type === 'ultimate') ? '#fbbf24' : 'var(--text-main)';
          }

          // Set settings avatar fields
          const settingsAvatarImg = document.getElementById('settingsAvatarImg');
          const settingsAvatarInitials = document.getElementById('settingsAvatarInitials');
          if (currentUser.user.profilePic) {
            if (settingsAvatarImg) {
              settingsAvatarImg.src = currentUser.user.profilePic;
              settingsAvatarImg.style.display = 'block';
            }
            if (settingsAvatarInitials) {
              settingsAvatarInitials.style.display = 'none';
            }
          } else {
            if (settingsAvatarImg) settingsAvatarImg.style.display = 'none';
            if (settingsAvatarInitials) {
              settingsAvatarInitials.style.display = 'block';
              settingsAvatarInitials.textContent = emailPrefix.substring(0, 2).toUpperCase();
            }
          }

          // Populate inputs in profile form
          const profileNameInput = document.getElementById('profileName');
          const profileFacultyInput = document.getElementById('profileFaculty');
          const profileUniversityInput = document.getElementById('profileUniversity');
          if (profileNameInput) profileNameInput.value = currentUser.user.name || '';
          if (profileFacultyInput) profileFacultyInput.value = currentUser.user.faculty || '';
          if (profileUniversityInput) profileUniversityInput.value = currentUser.user.university || '';

          if (currentUser.user.type === 'premium' || currentUser.user.type === 'ultimate') {
            const isUltimate = currentUser.user.type === 'ultimate';
            
            let daysLeftHtml = '';
            if (currentUser.user.paymentExpiredAt) {
              const diffTime = new Date(currentUser.user.paymentExpiredAt) - new Date();
              const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
              daysLeftHtml = `<br><span style="font-size: 0.7rem; color: #a3e635; font-weight: 600;">Sisa Aktif: ${daysLeft > 0 ? daysLeft : 0} Hari</span>`;
            }
            
            if (profileType) {
              profileType.innerHTML = (isUltimate ? 'Akun Ultimate' : 'Akun Premium') + daysLeftHtml;
              profileType.style.color = '#fbbf24';
            }
            
            if (isUltimate) {
              if (sidebarUpgradeCard) sidebarUpgradeCard.style.display = 'none';
              if (headerUpgradeBtn) headerUpgradeBtn.style.display = 'none';
            } else {
              if (sidebarUpgradeCard) {
                sidebarUpgradeCard.style.display = 'block';
                sidebarUpgradeCard.innerHTML = `
                  <i class="fa-solid fa-crown upgrade-crown-icon" style="color: #fbbf24;"></i>
                  <h4>Upgrade ke Ultimate</h4>
                  <p>Buka AI Drafting & Lit Review tanpa batas</p>
                  <button class="upgrade-btn btn-upgrade-trigger">Upgrade Sekarang</button>
                `;
              }
              if (headerUpgradeBtn) {
                headerUpgradeBtn.style.display = 'flex';
                headerUpgradeBtn.innerHTML = '<i class="fa-solid fa-crown" style="color: #fbbf24;"></i> Upgrade Ultimate';
              }
            }
            if (bannerUpgradeBtn) {
              bannerUpgradeBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[window.currentLanguage || 'id'].banner[0].btn}`;
              bannerUpgradeBtn.style.background = 'var(--brand-blue)';
              bannerUpgradeBtn.style.boxShadow = '0 4px 15px rgba(7, 135, 220, 0.3)';
              // Change click to go to match tab
              bannerUpgradeBtn.className = 'banner-upgrade-btn'; 
              bannerUpgradeBtn.onclick = (e) => {
                e.preventDefault();
                if (window.switchTab) window.switchTab('match-score');
              };
            }
            if (matchPremiumLock) matchPremiumLock.style.display = 'none';

            // Reset drafting companion locks & disclaimer for premium/ultimate
            const matchQuotaDisclaimer = document.getElementById('matchQuotaDisclaimer');
            if (matchQuotaDisclaimer) {
              matchQuotaDisclaimer.innerHTML = `<i class="fa-solid fa-crown" style="color: #fbbf24;"></i> ${isUltimate ? 'Ultimate' : 'Premium'} (Akses Unlimited)`;
            }
            const draftPremiumLock = document.getElementById('draftPremiumLock');
            if (draftPremiumLock) draftPremiumLock.style.display = 'none';
            const draftQuotaDisclaimer = document.getElementById('draftQuotaDisclaimer');
            if (draftQuotaDisclaimer) {
              draftQuotaDisclaimer.innerHTML = `<i class="fa-solid fa-crown" style="color: #fbbf24;"></i> ${isUltimate ? 'Ultimate (Akses Unlimited)' : 'Premium (Jatah 15x/Bulan)'}`;
            }
            const litReviewPremiumLock = document.getElementById('litReviewPremiumLock');
            if (litReviewPremiumLock) litReviewPremiumLock.style.display = 'none';
            const litReviewQuotaDisclaimer = document.getElementById('litReviewQuotaDisclaimer');
            if (litReviewQuotaDisclaimer) {
              litReviewQuotaDisclaimer.innerHTML = `<i class="fa-solid fa-crown" style="color: #fbbf24;"></i> ${isUltimate ? 'Ultimate (Akses Unlimited)' : 'Premium (Jatah 15x/Bulan)'}`;
            }

            // Reset humanizer locks & disclaimer for premium/ultimate
            const humanizerPremiumLock = document.getElementById('humanizerPremiumLock');
            if (humanizerPremiumLock) humanizerPremiumLock.style.display = 'none';
            const humanizerWordsRemainingLabel = document.getElementById('humanizerWordsRemainingLabel');
            if (humanizerWordsRemainingLabel && currentUser.user) {
              const remaining = currentUser.user.humanizerWordsRemaining ?? 0;
              const limit = currentUser.user.humanizerWordsLimit ?? 0;
              humanizerWordsRemainingLabel.textContent = `${remaining.toLocaleString('id-ID')} / ${limit.toLocaleString('id-ID')} Kata`;
            }
          } else {
            if (profileType) profileType.textContent = 'Akun Free';
            if (sidebarUpgradeCard) sidebarUpgradeCard.style.display = 'block';
            if (headerUpgradeBtn) headerUpgradeBtn.style.display = 'flex';
            
            // Akses tab Match Score dibuka untuk Free User agar bisa mencoba 1x sebulan
            if (matchPremiumLock) matchPremiumLock.style.display = 'none';

            // Ubah banner upgrade di beranda agar mengarahkan ke tab Match Score jika diklik
            if (bannerUpgradeBtn) {
              bannerUpgradeBtn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[window.currentLanguage || 'id'].banner_slide0_free_btn}`;
              bannerUpgradeBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
              bannerUpgradeBtn.style.boxShadow = '0 4px 15px rgba(16, 185, 129, 0.3)';
              bannerUpgradeBtn.className = 'banner-upgrade-btn'; 
              bannerUpgradeBtn.onclick = (e) => {
                e.preventDefault();
                if (window.switchTab) window.switchTab('match-score');
              };
            }

            // Lock tombol Hitung Match Score jika limit tercapai
            const runMatchBtn = document.getElementById('runMatch');
            const matchQuotaDisclaimer = document.getElementById('matchQuotaDisclaimer');
            
            if (matchQuotaDisclaimer) {
              matchQuotaDisclaimer.innerHTML = `<i class="fa-regular fa-clock" style="color: var(--brand-blue);"></i> <span>Kuota Gratis: ${currentUser.user.isLimitReached ? 0 : 1}/1 Bulan Ini</span>`;
            }

            if (currentUser.user.isLimitReached) {
              if (runMatchBtn) {
                runMatchBtn.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Limit Bulanan Tercapai (Upgrade)';
                runMatchBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                runMatchBtn.classList.add('btn-upgrade-trigger');
              }
            } else {
              if (runMatchBtn) {
                runMatchBtn.innerHTML = '<i class="fa-solid fa-chart-line"></i> Hitung Match Score';
                runMatchBtn.style.background = 'var(--brand-blue)';
                runMatchBtn.classList.remove('btn-upgrade-trigger');
              }
            }

            // Atur status kuota dan lock untuk AI Drafting Companion
            const draftPremiumLock = document.getElementById('draftPremiumLock');
            const draftQuotaDisclaimer = document.getElementById('draftQuotaDisclaimer');
            const runDraftGenerator = document.getElementById('runDraftGenerator');
            
            if (draftQuotaDisclaimer) {
              draftQuotaDisclaimer.innerHTML = `<i class="fa-regular fa-clock" style="color: var(--brand-blue);"></i> <span>Kuota Gratis: ${currentUser.user.draftsRemaining !== undefined ? currentUser.user.draftsRemaining : 1}/1 Bulan Ini</span>`;
            }

            if (currentUser.user.isDraftLimitReached) {
              if (draftPremiumLock) {
                draftPremiumLock.style.display = justGeneratedDraft ? 'none' : 'flex';
              }
              if (runDraftGenerator) {
                runDraftGenerator.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Limit Bulanan AI Drafting Tercapai';
                runDraftGenerator.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                runDraftGenerator.classList.add('btn-upgrade-trigger');
              }
            } else {
              if (draftPremiumLock) draftPremiumLock.style.display = 'none';
              if (runDraftGenerator) {
                runDraftGenerator.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Outline Pembahasan AI';
                runDraftGenerator.style.background = 'var(--brand-blue)';
                runDraftGenerator.classList.remove('btn-upgrade-trigger');
              }
            }

            // Atur status kuota dan lock untuk AI Lit Review
            const litReviewPremiumLock = document.getElementById('litReviewPremiumLock');
            const litReviewQuotaDisclaimer = document.getElementById('litReviewQuotaDisclaimer');
            const runLitReviewBtn = document.getElementById('runLitReviewBtn');
            
            if (litReviewQuotaDisclaimer) {
              litReviewQuotaDisclaimer.innerHTML = `<i class="fa-regular fa-clock" style="color: var(--brand-blue);"></i> <span>Kuota Gratis: ${currentUser.user.litReviewsRemaining !== undefined ? currentUser.user.litReviewsRemaining : 1}/1 Bulan Ini</span>`;
            }

            if (currentUser.user.isLitReviewLimitReached) {
              if (litReviewPremiumLock) {
                litReviewPremiumLock.style.display = justGeneratedLitReview ? 'none' : 'flex';
              }
              if (runLitReviewBtn) {
                runLitReviewBtn.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Limit Bulanan AI Lit Review Tercapai';
                runLitReviewBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                runLitReviewBtn.classList.add('btn-upgrade-trigger');
              }
            } else {
              if (litReviewPremiumLock) litReviewPremiumLock.style.display = 'none';
              if (runLitReviewBtn) {
                runLitReviewBtn.innerHTML = '<i class="fa-solid fa-search"></i> Cari Referensi & Susun Kajian';
                runLitReviewBtn.style.background = 'var(--brand-blue)';
                runLitReviewBtn.classList.remove('btn-upgrade-trigger');
              }
            }

            // Atur status kuota dan lock untuk Humanizer
            const humanizerPremiumLock = document.getElementById('humanizerPremiumLock');
            const runHumanizerBtn = document.getElementById('runHumanizerBtn');
            const humanizerWordsRemainingLabel = document.getElementById('humanizerWordsRemainingLabel');

            if (humanizerWordsRemainingLabel) {
              humanizerWordsRemainingLabel.textContent = `0 / 0 Kata`;
            }

            if (currentUser.user.isHumanizerLimitReached) {
              if (humanizerPremiumLock) {
                humanizerPremiumLock.style.display = justGeneratedHumanizer ? 'none' : 'flex';
              }
              if (runHumanizerBtn) {
                runHumanizerBtn.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Fitur Eksklusif PRO';
                runHumanizerBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
                runHumanizerBtn.classList.add('btn-upgrade-trigger');
              }
            } else {
              if (humanizerPremiumLock) humanizerPremiumLock.style.display = 'none';
              if (runHumanizerBtn) {
                runHumanizerBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Mulai Humanisasi Teks';
                runHumanizerBtn.style.background = '#f59e0b';
                runHumanizerBtn.classList.remove('btn-upgrade-trigger');
              }
            }
          }
        }

        if (currentUser.loggedIn && currentUser.user) {
          updateVisualQuotaTracker(currentUser.user);
          updateGreeting(currentUser.user);
          renderBillingHistory();
          renderBerandaRecentActivity();
          updateResearchChatAccess(currentUser.user);
        }

        // Logout handler
        const sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn');
        if (sidebarLogoutBtn) {
          sidebarLogoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = '/auth.html';
          });
        }

        // Global event delegation untuk semua tombol upgrade premium (mendukung elemen dinamis)
        if (!window.upgradeTriggersBound) {
          window.upgradeTriggersBound = true;
          document.addEventListener('click', (e) => {
            const trigger = e.target.closest('.btn-upgrade-trigger');
            if (trigger) {
              e.preventDefault();
              const upgradeModal = document.getElementById('upgradeModal');
              if (upgradeModal) {
                upgradeModal.classList.add('active');
                if (window.updateModalButtonStates) {
                  window.updateModalButtonStates();
                }
              }
            }
          });
        }
      } else {
        // Response HTTP gagal (mis. 500) - ini bukan bukti user belum login,
        // jadi jangan paksa redirect (mencegah loop redirect ping-pong dengan auth.html).
        console.error('Auth check failed: HTTP', response.status);
      }
    } catch (error) {
      // Kegagalan jaringan (mis. fetch gagal sesaat) juga bukan bukti user
      // belum login - biarkan halaman tetap tampil, jangan paksa redirect.
      console.error('Auth check failed', error);
    }
  }
  window.checkAuthState = checkAuthState;

  // --- SAPAAN PERSONAL DI BERANDA ---
  function updateGreeting(user) {
    const lang = window.currentLanguage || 'id';
    const hello = lang === 'en' ? 'Hello, ' : 'Halo, ';
    const subtitle = lang === 'en' ? 'What would you like to write today?' : 'Mau nulis apa sekarang?';

    const displayName = (user && user.name && user.name.trim())
      || (user && user.email && user.email.includes('@') && user.email.split('@')[0])
      || 'Peneliti';

    const welcomeSpan = document.getElementById('welcomeText');
    if (welcomeSpan) welcomeSpan.textContent = hello + displayName;

    const welcomeSubtitle = document.getElementById('welcomeSubtitle');
    if (welcomeSubtitle) welcomeSubtitle.textContent = subtitle;
  }

  // --- AKTIVITAS TERAKHIR DI BERANDA ---
  function berandaHistoryTypeMeta(lang) {
    const t = TRANSLATIONS[lang] || TRANSLATIONS.id;
    return {
      match: { label: t.hist_type_match, icon: 'fa-solid fa-magnifying-glass-chart', bg: 'rgba(7, 135, 220, 0.08)', color: 'var(--brand-blue)' },
      draft: { label: t.hist_type_draft, icon: 'fa-regular fa-file-lines', bg: 'rgba(16, 185, 129, 0.08)', color: '#10b981' },
      'lit-review': { label: t.hist_type_litreview, icon: 'fa-solid fa-book-open-reader', bg: 'rgba(139, 92, 246, 0.08)', color: '#8b5cf6' },
      humanizer: { label: t.hist_type_humanizer, icon: 'fa-solid fa-wand-magic-sparkles', bg: 'rgba(245, 158, 11, 0.08)', color: '#f59e0b' }
    };
  }

  function berandaHistoryItemTitle(item, lang) {
    const t = TRANSLATIONS[lang] || TRANSLATIONS.id;
    if (item.type === 'match') return item.input.title || t.hist_fallback_match;
    if (item.type === 'draft') return item.input.title || t.hist_fallback_draft;
    if (item.type === 'lit-review') return item.input.title || t.hist_fallback_litreview;
    if (item.type === 'humanizer') return item.input.text ? item.input.text.slice(0, 60) + '...' : t.hist_fallback_humanizer;
    return t.hist_fallback_generic;
  }

  async function renderBerandaRecentActivity() {
    const container = document.getElementById('berandaRecentActivityList');
    const emptyState = document.getElementById('berandaRecentActivityEmpty');
    if (!container) return;

    try {
      const response = await fetch('/api/history');
      const data = await response.json();
      const items = (data.ok ? (data.history || []) : []).slice(0, 3);

      if (items.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';
        return;
      }

      container.style.display = 'flex';
      if (emptyState) emptyState.style.display = 'none';

      const lang = window.currentLanguage || 'id';
      const typeMeta = berandaHistoryTypeMeta(lang);

      container.innerHTML = items.map(item => {
        const meta = typeMeta[item.type] || { label: TRANSLATIONS[lang].hist_type_generic, icon: 'fa-solid fa-robot', bg: 'rgba(7, 135, 220, 0.08)', color: 'var(--brand-blue)' };
        const dateStr = new Date(item.timestamp).toLocaleString(lang === 'en' ? 'en-US' : 'id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const title = escapeHtml(berandaHistoryItemTitle(item, lang));
        return `
          <button type="button" class="beranda-recent-activity-item" data-history-id="${item.id}" style="display: flex; align-items: center; gap: 1rem; width: 100%; text-align: left; padding: 0.85rem 1rem; background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 10px; cursor: pointer; font-family: inherit;">
            <div style="width: 38px; height: 38px; border-radius: 10px; background: ${meta.bg}; color: ${meta.color}; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0;">
              <i class="${meta.icon}"></i>
            </div>
            <div style="overflow: hidden; flex: 1;">
              <h5 style="margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${title}</h5>
              <span style="font-size: 0.72rem; color: var(--text-muted);">${meta.label} · ${dateStr}</span>
            </div>
            <i class="fa-solid fa-chevron-right" style="color: var(--text-muted); font-size: 0.8rem; flex-shrink: 0;"></i>
          </button>
        `;
      }).join('');

      container.querySelectorAll('.beranda-recent-activity-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-history-id');
          if (window.switchTab) window.switchTab('riwayat');
          setTimeout(() => {
            if (window.renderHistoryTab) {
              window.renderHistoryTab().then(() => {
                if (window.showHistoryDetailsById) window.showHistoryDetailsById(id);
              });
            }
          }, 50);
        });
      });
    } catch (err) {
      console.error('Gagal memuat aktivitas terakhir:', err);
      container.innerHTML = '';
      container.style.display = 'none';
      if (emptyState) emptyState.style.display = 'block';
    }
  }

  // --- ASISTEN RISET AI: akses & kuota ---
  function updateResearchChatAccess(user) {
    const lock = document.getElementById('researchChatPremiumLock');
    const quotaText = document.getElementById('researchChatQuotaText');
    if (!lock) return;

    const isPro = user.type === 'premium' || user.type === 'ultimate';
    lock.style.display = isPro ? 'none' : 'flex';

    if (quotaText) {
      if (user.type === 'ultimate') {
        quotaText.textContent = window.currentLanguage === 'en' ? 'Unlimited' : 'Tanpa Batas';
      } else if (user.type === 'premium') {
        const used = user.researchChatCountThisMonth || 0;
        const limit = user.researchChatLimit || 100;
        quotaText.textContent = window.currentLanguage === 'en'
          ? `Quota: ${used}/${limit} This Month`
          : `Kuota: ${used}/${limit} Bulan Ini`;
      } else {
        quotaText.textContent = window.currentLanguage === 'en' ? 'Premium/Ultimate only' : 'Khusus Premium/Ultimate';
      }
    }
  }

  // --- VISUAL QUOTA TRACKER ---
  function updateVisualQuotaTracker(user) {
    const homeQuotaTrackerCard = document.getElementById('homeQuotaTrackerCard');
    if (!homeQuotaTrackerCard) return;

    homeQuotaTrackerCard.style.display = 'block';

    const isEn = (window.currentLanguage === 'en');

    // Account Type label
    const typeLabel = user.type === 'ultimate' ? (isEn ? 'Ultimate Account' : 'Akun Ultimate') : (user.type === 'premium' ? (isEn ? 'Premium Account' : 'Akun Premium') : (isEn ? 'Free Account' : 'Akun Free'));
    document.getElementById('lblQuotaAccountType').textContent = (isEn ? 'Account Type: ' : 'Tipe Akun: ') + typeLabel;

    // 1. Match & Draft (Claude limits) - Match dan Draft punya kuota terpisah,
    // bukan kuota gabungan, jadi jangan dijumlahkan jadi satu angka.
    const txtQuotaMatchDraft = document.getElementById('txtQuotaMatchDraft');
    const barQuotaMatchDraft = document.getElementById('barQuotaMatchDraft');
    const lblMatchDraftLimitNote = document.getElementById('lblMatchDraftLimitNote');

    const matchUsed = user.matchCountThisMonth || 0;
    const draftUsed = user.draftCountThisMonth || 0;

    if (user.type === 'ultimate') {
      txtQuotaMatchDraft.textContent = isEn ? 'Unlimited' : 'Tanpa Batas';
      barQuotaMatchDraft.style.width = '100%';
      barQuotaMatchDraft.style.background = '#10b981'; // Green for unlimited/success
      if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = isEn ? 'Match & Draft unlimited' : 'Match & Draft tanpa batas';
    } else if (user.type === 'premium') {
      // Match tanpa batas untuk Premium, hanya Draft yang dijatah 15x/bulan
      const draftLimit = 15;
      txtQuotaMatchDraft.textContent = `${draftUsed} / ${draftLimit}`;
      const pct = Math.min(100, (draftUsed / draftLimit) * 100);
      barQuotaMatchDraft.style.width = `${pct}%`;
      barQuotaMatchDraft.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : 'var(--brand-blue)');
      if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = isEn ? 'Match unlimited · Outline 15x/month' : 'Match tanpa batas · Outline 15x/bulan';
    } else {
      const draftLimit = 1;
      txtQuotaMatchDraft.textContent = `${draftUsed} / ${draftLimit}`;
      const pct = Math.min(100, (draftUsed / draftLimit) * 100);
      barQuotaMatchDraft.style.width = `${pct}%`;
      barQuotaMatchDraft.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : 'var(--brand-blue)');
      if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = isEn ? 'Match 1x/month · Outline 1x/month' : 'Match 1x/bulan · Outline 1x/bulan';
    }

    // 2. Lit Review (Perplexity limits)
    const txtQuotaLitReview = document.getElementById('txtQuotaLitReview');
    const barQuotaLitReview = document.getElementById('barQuotaLitReview');
    const litUsed = user.litReviewCountThisMonth || 0;

    if (user.type === 'ultimate') {
      txtQuotaLitReview.textContent = isEn ? 'Unlimited' : 'Tanpa Batas';
      barQuotaLitReview.style.width = '100%';
      barQuotaLitReview.style.background = '#10b981';
    } else {
      const limit = user.type === 'premium' ? 15 : 1;
      txtQuotaLitReview.textContent = `${litUsed} / ${limit}`;
      const pct = Math.min(100, (litUsed / limit) * 100);
      barQuotaLitReview.style.width = `${pct}%`;
      barQuotaLitReview.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : '#8b5cf6');
    }

    // 3. Humanizer Words
    const txtQuotaHumanizer = document.getElementById('txtQuotaHumanizer');
    const barQuotaHumanizer = document.getElementById('barQuotaHumanizer');
    const wordsUsed = user.humanizerWordsUsedThisMonth || 0;

    let wordsLimit = 0;
    const topup = user.humanizerTopupCredits || 0;
    if (user.type === 'free') wordsLimit = topup;
    else if (user.type === 'premium') wordsLimit = 5000 + topup;
    else if (user.type === 'ultimate') wordsLimit = 15000 + topup;

    txtQuotaHumanizer.textContent = `${wordsUsed.toLocaleString('id-ID')} / ${wordsLimit.toLocaleString('id-ID')}`;

    if (wordsLimit === 0) {
      barQuotaHumanizer.style.width = '0%';
      barQuotaHumanizer.style.background = '#e2e8f0';
    } else {
      const pct = Math.min(100, (wordsUsed / wordsLimit) * 100);
      barQuotaHumanizer.style.width = `${pct}%`;
      barQuotaHumanizer.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : '#f59e0b');
    }
  }

  // --- BILLING HISTORY TABLE ---
  async function renderBillingHistory() {
    const tableBody = document.getElementById('billingHistoryTableBody');
    if (!tableBody) return;

    const isEn = (window.currentLanguage === 'en');

    tableBody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">
          <i class="fa-solid fa-spinner fa-spin" style="margin-right: 0.5rem; color: var(--brand-blue);"></i> ${isEn ? 'Loading transactions...' : 'Memuat data transaksi...'}
        </td>
      </tr>
    `;

    try {
      const response = await fetch('/api/transactions');
      const data = await response.json();

      if (data.ok && data.transactions && data.transactions.length > 0) {
        tableBody.innerHTML = '';
        data.transactions.forEach(tx => {
          const dateStr = new Date(tx.timestamp).toLocaleDateString(isEn ? 'en-US' : 'id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
          });
          const amountStr = 'Rp ' + tx.amount.toLocaleString('id-ID');
          const statusBadge = `<span style="background: rgba(16, 185, 129, 0.1); color: #10b981; font-weight: 700; font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px; display: inline-block;"><i class="fa-solid fa-circle-check"></i> ${isEn ? 'Paid' : 'Lunas'}</span>`;

          const row = document.createElement('tr');
          row.style.borderBottom = '1px solid var(--border-light-hover)';
          row.innerHTML = `
            <td style="padding: 1rem 0.5rem; color: var(--text-main); font-weight: 500;">${dateStr}</td>
            <td style="padding: 1rem 0.5rem; color: var(--text-main); font-weight: 700;">${tx.description}</td>
            <td style="padding: 1rem 0.5rem; color: var(--text-main); font-weight: 700;">${amountStr}</td>
            <td style="padding: 1rem 0.5rem;">${statusBadge}</td>
            <td style="padding: 1rem 0.5rem; text-align: right;">
              <a href="/api/transactions/${tx.id}/invoice" target="_blank" class="upgrade-btn" style="width: auto; display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.35rem 0.75rem; font-size: 0.78rem; background: var(--brand-blue); color: white; text-decoration: none; border-radius: 6px;">
                <i class="fa-solid fa-receipt"></i> ${isEn ? 'Receipt' : 'Kuitansi'}
              </a>
            </td>
          `;
          tableBody.appendChild(row);
        });
      } else {
        tableBody.innerHTML = `
          <tr>
            <td colspan="5" style="text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
              <div style="font-size: 1.5rem; margin-bottom: 0.5rem;"><i class="fa-regular fa-folder-open"></i></div>
              <div>${isEn ? 'No payment transactions recorded.' : 'Belum ada transaksi pembayaran tercatat.'}</div>
            </td>
          </tr>
        `;
      }
    } catch (err) {
      console.error('Fetch billing history error:', err);
      tableBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 2rem; color: #ef4444; font-weight: 600;">
            <i class="fa-solid fa-triangle-exclamation"></i> ${isEn ? 'Failed to load transaction data.' : 'Gagal memuat data transaksi.'}
          </td>
        </tr>
      `;
    }
  }

  // --- 1. TAMPILAN MENYELURUH (RENDERING) ---

  // Fungsi merender kartu ke HTML (dilengkapi lazy-loading)
  function renderCards() {
    resultsContainer.innerHTML = '';
    
    // Update label jumlah hasil pencarian keseluruhan
    const isEn = (window.currentLanguage === 'en');
    resultsCount.textContent = isEn 
      ? `Showing ${activeJournals.length} journals` 
      : `Menampilkan ${activeJournals.length} jurnal`;

    if (activeJournals.length === 0) {
      const emptyTitle = isEn ? 'No Journals Found' : 'Jurnal Tidak Ditemukan';
      const emptyDesc = isEn 
        ? 'Try using other keywords, clearing filters, or checking your spelling.' 
        : 'Coba gunakan kata kunci lain, bersihkan filter, atau periksa ejaan Anda.';

      resultsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
          <h3>${emptyTitle}</h3>
          <p>${emptyDesc}</p>
        </div>
      `;
      loadMoreContainer.style.display = 'none';
      return;
    }

    // Ambil data sebagian sesuai visibleCount
    let chunk = activeJournals.slice(0, visibleCount);

    // LIMITATION FOR FREE USERS
    let isLimited = false;
    if (currentUser.user && currentUser.user.type === 'free') {
       chunk = activeJournals.slice(0, 1);
       isLimited = activeJournals.length > 1;
    }

    chunk.forEach((journal, index) => {
      const card = document.createElement('div');
      card.className = `journal-card ${journal.type.toLowerCase()}-card`;
      // Efek stagger animasi masuk
      card.style.animationDelay = `${(index % 30) * 0.03}s`;

      const typeBadgeClass = journal.type === 'Scopus' ? 'type-scopus' : 'type-sinta';
      const rankBadgeClass = `rank-${journal.rank.toLowerCase()}`;
      const apcClass = journal.isFree ? 'free' : 'paid';
      const matchBadge = journal.matchScore ? getMatchScoreBadge(journal.matchScore) : '';
      const isBookmarked = (currentUser.user && currentUser.user.savedJournals && currentUser.user.savedJournals.includes(journal.id));

      card.innerHTML = `
        <div>
          <div class="card-header">
            <div class="card-badge-group">
              <span class="card-type-tag ${typeBadgeClass}">
                <i class="${journal.type === 'Scopus' ? 'fa-solid fa-globe' : 'fa-solid fa-medal'}"></i>
                ${journal.type}
              </span>
              ${matchBadge}
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="rank-badge ${rankBadgeClass}">${journal.rank}</span>
              <button class="bookmark-btn ${isBookmarked ? 'active' : ''}" data-id="${journal.id}" title="${isBookmarked ? 'Hapus dari Tersimpan' : 'Simpan Jurnal'}">
                <i class="${isBookmarked ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>
              </button>
            </div>
          </div>
          
          <div class="card-body">
            <h3 class="journal-title" title="${journal.title}">${journal.title}</h3>
            <span class="journal-publisher">
              <i class="fa-regular fa-building"></i> ${journal.publisher}
            </span>
            <p class="journal-desc">${journal.description}</p>
          </div>
        </div>

        <div class="card-footer-wrapper">
          <div class="card-meta-details">
            <div class="meta-detail-row">
              <span class="meta-label">${isEn ? 'Field:' : 'Keilmuan:'}</span>
              <span class="meta-value">${journal.keilmuan}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">${isEn ? 'Subject:' : 'Rumpun:'}</span>
              <span class="meta-value">${journal.subject}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">${isEn ? 'APC Fee:' : 'Biaya APC:'}</span>
              <span class="meta-value meta-apc ${apcClass}">${isEn && journal.apc.toLowerCase().includes('gratis') ? 'Free (No APC)' : journal.apc}</span>
            </div>
            ${journal.isFastTrack ? `
            <div class="meta-detail-row" style="color: #fbbf24; font-weight: 600;">
              <span class="meta-label">Fast Track:</span>
              <span class="meta-value"><i class="fa-solid fa-bolt"></i> ${isEn && (journal.responseTime || 'Ya') === 'Ya' ? 'Yes' : (journal.responseTime || 'Ya')}</span>
            </div>
            ` : ''}
          </div>
          
          <div class="card-footer" style="margin-top: 1.25rem;">
            <a href="${journal.url}" target="_blank" class="journal-link">
              ${isEn ? 'Visit Journal' : 'Kunjungi Jurnal'} <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </div>
        </div>
      `;

      resultsContainer.appendChild(card);
    });

    // Bind click events to bookmark buttons
    resultsContainer.querySelectorAll('.bookmark-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const journalId = Number(btn.dataset.id);
        try {
          const response = await fetch('/api/bookmarks/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ journalId })
          });
          if (response.ok) {
            const resData = await response.json();
            currentUser.user.savedJournals = resData.savedJournals;
            
            // Toggle local style
            const icon = btn.querySelector('i');
            if (resData.bookmarked) {
              btn.classList.add('active');
              icon.className = 'fa-solid fa-bookmark';
              btn.title = 'Hapus dari Tersimpan';
            } else {
              btn.classList.remove('active');
              icon.className = 'fa-regular fa-bookmark';
              btn.title = 'Simpan Jurnal';
            }
          }
        } catch (error) {
          console.error('Failed to toggle bookmark:', error);
        }
      });
    });

    // Tampilkan pesan batasan untuk Free User
    if (isLimited) {
       const promoCard = document.createElement('div');
       promoCard.className = `journal-card`;
       promoCard.style.cssText = `
         background: linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(7,9,14,0.9));
         border: 1px solid rgba(251, 191, 36, 0.3);
         display: flex;
         flex-direction: column;
         align-items: center;
         justify-content: center;
         text-align: center;
         padding: 3rem 2rem;
         min-height: 100%;
       `;
       promoCard.innerHTML = `
         <i class="fa-solid fa-lock" style="font-size: 2.5rem; color: #fbbf24; margin-bottom: 1rem;"></i>
         <h3 style="margin-bottom: 0.5rem;">${isEn ? `${activeJournals.length - 1} More Journals Hidden` : `${activeJournals.length - 1} Jurnal Lainnya Disembunyikan`}</h3>
         <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">${isEn ? 'Free account can only view the top 1 recommendation. Upgrade to PRO to view all results.' : 'Akun Free hanya dapat melihat 1 rekomendasi teratas. Tingkatkan ke PRO untuk melihat semua hasil.'}</p>
         <button class="btn btn-primary btn-upgrade-trigger" style="background: linear-gradient(135deg, #f59e0b, #d97706); border-color: #d97706;">
           ${isEn ? 'Upgrade to PRO' : 'Upgrade PRO'}
         </button>
       `;
       resultsContainer.appendChild(promoCard);
    }

    // Atur visibilitas tombol "Muat Lebih Banyak"
    if (visibleCount < activeJournals.length && (!currentUser.user || currentUser.user.type !== 'free')) {
      loadMoreContainer.style.display = 'block';
    } else {
      loadMoreContainer.style.display = 'none';
    }
  }

  // --- 2. LOGIKA PENYARINGAN (FILTERING) ---

  function normalizeText(value) {
    return String(value || '').toLowerCase().trim();
  }

  function getTitleMatchScore(title, query) {
    const normalizedTitle = normalizeText(title);
    if (!query) return 0;
    if (normalizedTitle === query) return 100;
    if (normalizedTitle.startsWith(query)) return 80;
    if (normalizedTitle.includes(query)) return 60;

    const queryWords = query.split(/\s+/).filter(Boolean);
    const matchedWords = queryWords.filter(word => normalizedTitle.includes(word)).length;
    return matchedWords > 0 ? Math.round((matchedWords / queryWords.length) * 40) : 0;
  }

  function getMatchScoreBadge(score) {
    return `
      <span class="match-score-badge">
        <span class="match-score-number">${score}%</span>
        <span class="match-score-label">cocok</span>
      </span>
    `;
  }

  function renderMatchCards(journals) {
    matchResultsContainer.innerHTML = '';

    if (journals.length === 0) {
      matchResultsContainer.innerHTML = `
        <div class="empty-state match-empty-state">
          <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
          <h3>Belum Ada Rekomendasi Cocok</h3>
          <p>Coba tambahkan keyword, bidang, atau abstrak yang lebih spesifik.</p>
        </div>
      `;
      matchResultsContainer.style.display = 'grid';
      return;
    }

    journals.forEach((journal, index) => {
      const card = document.createElement('div');
      card.className = `journal-card match-result-card ${journal.type.toLowerCase()}-card`;
      card.style.animationDelay = `${index * 0.04}s`;

      const typeBadgeClass = journal.type === 'Scopus' ? 'type-scopus' : 'type-sinta';
      const rankBadgeClass = `rank-${journal.rank.toLowerCase()}`;
      const apcClass = journal.isFree ? 'free' : 'paid';
      const matchReason = journal.matchReason ? `<p class="match-reason">${journal.matchReason}</p>` : '';
      const isBookmarked = (currentUser.user && currentUser.user.savedJournals && currentUser.user.savedJournals.includes(journal.id));

      card.innerHTML = `
        <div>
          <div class="card-header">
            <div class="card-badge-group">
              ${getMatchScoreBadge(journal.matchScore)}
              <span class="card-type-tag ${typeBadgeClass}">
                <i class="${journal.type === 'Scopus' ? 'fa-solid fa-globe' : 'fa-solid fa-medal'}"></i>
                ${journal.type}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="rank-badge ${rankBadgeClass}">${journal.rank}</span>
              <button class="bookmark-btn ${isBookmarked ? 'active' : ''}" data-id="${journal.id}" title="${isBookmarked ? 'Hapus dari Tersimpan' : 'Simpan Jurnal'}">
                <i class="${isBookmarked ? 'fa-solid' : 'fa-regular'} fa-bookmark"></i>
              </button>
            </div>
          </div>
          <div class="card-body">
            <h3 class="journal-title" title="${journal.title}">${journal.title}</h3>
            <span class="journal-publisher">
              <i class="fa-regular fa-building"></i> ${journal.publisher}
            </span>
            <p class="journal-desc">${journal.description}</p>
            ${matchReason}
          </div>
        </div>
        <div class="card-footer-wrapper">
          <div class="card-meta-details">
            <div class="meta-detail-row">
              <span class="meta-label">Keilmuan:</span>
              <span class="meta-value">${journal.keilmuan}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">Rumpun:</span>
              <span class="meta-value">${journal.subject}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">Biaya APC:</span>
              <span class="meta-value meta-apc ${apcClass}">${journal.apc}</span>
            </div>
          </div>
          <div class="card-footer" style="margin-top: 1.25rem;">
            <a href="${journal.url}" target="_blank" class="journal-link">
              Kunjungi Jurnal <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </div>
        </div>
      `;

      matchResultsContainer.appendChild(card);
    });

    // Bind click events to bookmark buttons inside match results
    matchResultsContainer.querySelectorAll('.bookmark-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const journalId = Number(btn.dataset.id);
        try {
          const response = await fetch('/api/bookmarks/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ journalId })
          });
          if (response.ok) {
            const resData = await response.json();
            currentUser.user.savedJournals = resData.savedJournals;
            
            // Toggle local style
            const icon = btn.querySelector('i');
            if (resData.bookmarked) {
              btn.classList.add('active');
              icon.className = 'fa-solid fa-bookmark';
              btn.title = 'Hapus dari Tersimpan';
            } else {
              btn.classList.remove('active');
              icon.className = 'fa-regular fa-bookmark';
              btn.title = 'Simpan Jurnal';
            }
            
            // Re-render main list bookmarks
            renderCards();
          }
        } catch (error) {
          console.error('Failed to toggle bookmark:', error);
        }
      });
    });

    matchResultsContainer.style.display = 'grid';
  }

  const stopWords = new Set([
    'yang', 'dan', 'atau', 'dengan', 'untuk', 'pada', 'dalam', 'dari', 'ke', 'di',
    'the', 'and', 'or', 'of', 'in', 'to', 'for', 'a', 'an', 'by', 'on', 'is',
    'ini', 'itu', 'terhadap', 'tentang', 'analisis', 'studi', 'study', 'analysis'
  ]);

  function getWords(value) {
    return normalizeText(value)
      .replace(/[^a-z0-9\s&]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
  }

  function countMatches(sourceWords, targetText) {
    if (sourceWords.length === 0) return 0;
    const normalizedTarget = normalizeText(targetText);
    return sourceWords.filter(word => normalizedTarget.includes(word)).length;
  }

  function calculateJournalMatchScore(journal, articleText, keywordText) {
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

  function runJournalMatch() {
    const titleValue = articleTitle.value.trim();
    const keywordValue = articleKeywords.value.trim();
    const abstractValue = articleAbstract.value.trim();
    const articleText = `${titleValue} ${abstractValue}`;

    if (!titleValue && !keywordValue && !abstractValue) {
      matchSummary.textContent = 'Isi minimal judul artikel atau keyword untuk menghitung rekomendasi jurnal.';
      articleTitle.focus();
      return;
    }

    const ranked = getLocalMatchRecommendations(titleValue, keywordValue, abstractValue);

    clearMatchBtn.style.display = 'inline-flex';
    matchSummary.textContent = ranked.length > 0
      ? 'Berikut 3 rekomendasi jurnal paling cocok berdasarkan database JurnalHub.'
      : 'Belum ada jurnal yang cocok. Coba tambahkan keyword atau abstrak yang lebih spesifik.';
    renderMatchCards(ranked);
    matchResultsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function getLocalMatchRecommendations(titleValue, keywordValue, abstractValue) {
    const articleText = `${titleValue} ${abstractValue}`;
    const ranked = JOURNAL_DATABASE
      .map((journal, index) => ({
        ...journal,
        matchScore: calculateJournalMatchScore(journal, articleText, keywordValue),
        originalIndex: index
      }))
      .filter(journal => journal.matchScore > 0)
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return a.originalIndex - b.originalIndex;
      })
      .slice(0, 3);

    const topScore = ranked[0]?.matchScore || 0;
    const displayRanked = ranked.map((journal, index) => ({
      ...journal,
      matchScore: Math.min(98, Math.max(72 - (index * 6), Math.round(74 + ((journal.matchScore / Math.max(topScore, 1)) * 22) - (index * 3))))
    }));

    return displayRanked;
  }

  async function runJournalMatchWithAi() {
    // Kunci tombol jika limit bulanan tercapai untuk akun free
    if (currentUser.user && currentUser.user.type === 'free' && currentUser.user.isLimitReached) {
      const upgradeModal = document.getElementById('upgradeModal');
      if (upgradeModal) {
        upgradeModal.classList.add('active');
      }
      return;
    }

    const titleValue = articleTitle.value.trim();
    const keywordValue = articleKeywords.value.trim();
    const abstractValue = articleAbstract.value.trim();

    if (!titleValue && !keywordValue && !abstractValue) {
      matchSummary.textContent = 'Isi minimal judul artikel atau keyword untuk menghitung rekomendasi jurnal.';
      articleTitle.focus();
      return;
    }

    clearMatchBtn.style.display = 'inline-flex';
    runMatchBtn.disabled = true;
    runMatchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menganalisis...';
    matchSummary.textContent = 'AI sedang membaca artikel dan mencocokkan jurnal terbaik...';

    // Sembunyikan panel review lama jika ada
    const existingReview = document.getElementById('aiReviewPanel');
    if (existingReview) existingReview.remove();

    try {
      const response = await fetch('/api/match-journals-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleValue,
          keywords: keywordValue,
          abstract: abstractValue
        })
      });

      if (!response.ok) {
        throw new Error('AI match request failed');
      }

      const data = await response.json();
      const recommendations = (data.recommendations || []).map(item => ({
        ...item,
        url: JOURNAL_DATABASE.find(journal => String(journal.id) === String(item.id))?.url || '#'
      }));

      if (recommendations.length === 0) {
        matchSummary.textContent = 'Belum ada jurnal yang cocok. Coba tambahkan keyword atau abstrak yang lebih spesifik.';
      } else {
        if (data.source === 'claude') {
          matchSummary.textContent = 'Berikut 3 rekomendasi terbaik dari Claude AI berdasarkan database JurnalHub.';
        } else {
          matchSummary.textContent = data.warning || 'Berikut 3 rekomendasi terbaik dari sistem lokal JurnalHub.';
        }
      }

      // Kunci tombol jika akun free setelah sukses pencocokan
      if (currentUser.user && currentUser.user.type === 'free') {
        currentUser.user.isLimitReached = true;
        if (runMatchBtn) {
          runMatchBtn.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Limit Bulanan Tercapai (Upgrade)';
          runMatchBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
          runMatchBtn.classList.add('btn-upgrade-trigger');
        }
        const matchQuotaDisclaimer = document.getElementById('matchQuotaDisclaimer');
        if (matchQuotaDisclaimer) {
          matchQuotaDisclaimer.innerHTML = '<i class="fa-regular fa-clock" style="color: var(--brand-blue);"></i> <span>Kuota Gratis: 0/1 Bulan Ini</span>';
        }
      }

      await checkAuthState();

      // Tampilkan panel review AI jika tersedia
      if (data.review && matchResultsContainer) {
        const providerIcon = '<i class="fa-solid fa-wand-magic-sparkles" style="color:#a78bfa;"></i>';
        const providerLabel = 'Analisis Claude AI';

        const reviewPanel = document.createElement('div');
        reviewPanel.id = 'aiReviewPanel';
        reviewPanel.style.cssText = `
          background: linear-gradient(135deg, rgba(139,92,246,0.08), rgba(59,130,246,0.08));
          border: 1px solid rgba(139,92,246,0.25);
          border-radius: 14px;
          padding: 1.1rem 1.4rem;
          margin-bottom: 1.25rem;
          display: flex;
          gap: 0.9rem;
          align-items: flex-start;
          animation: fadeInUp 0.4s ease;
        `;
        reviewPanel.innerHTML = `
          <div style="flex-shrink:0; width:36px; height:36px; border-radius:50%; background:rgba(139,92,246,0.15); display:flex; align-items:center; justify-content:center; font-size:1rem;">
            ${providerIcon}
          </div>
          <div style="flex:1;">
            <div style="font-size:0.72rem; font-weight:700; letter-spacing:0.08em; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">${providerLabel}</div>
            <p style="font-size:0.9rem; line-height:1.65; color:var(--text-main); margin:0;">${data.review}</p>
          </div>
        `;
        matchResultsContainer.parentNode.insertBefore(reviewPanel, matchResultsContainer);
      }

      renderMatchCards(recommendations);
      const scrollTarget = document.getElementById('aiReviewPanel') || matchResultsContainer;
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      const fallback = getLocalMatchRecommendations(titleValue, keywordValue, abstractValue);
      matchSummary.textContent = 'AI belum tersedia, hasil ini memakai sistem lokal JurnalHub.';
      renderMatchCards(fallback);
      matchResultsContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      runMatchBtn.disabled = false;
      runMatchBtn.innerHTML = '<i class="fa-solid fa-chart-line"></i> Hitung Match Score';
    }
  }

  function clearJournalMatch() {
    articleTitle.value = '';
    articleKeywords.value = '';
    articleAbstract.value = '';
    clearMatchBtn.style.display = 'none';
    matchResultsContainer.innerHTML = '';
    matchResultsContainer.style.display = 'none';
    matchSummary.textContent = 'Isi minimal judul artikel atau keyword untuk melihat rekomendasi jurnal terbaik.';
    const reviewPanel = document.getElementById('aiReviewPanel');
    if (reviewPanel) reviewPanel.remove();
  }
  
  function filterJournals() {
    const query = normalizeText(searchInput.value);
    const typeValue = filterType.value;
    const subjectValue = filterSubject.value;
    const rankValue = filterRank.value;
    const freeOnly = checkFreeOnly.checked;

    // Lakukan penyaringan pada JOURNAL_DATABASE (dari database.js)
    const filtered = JOURNAL_DATABASE
      .map((journal, index) => {
        const titleScore = getTitleMatchScore(journal.title, query);
        const matchesKeyword =
          query === '' ||
          titleScore > 0 ||
          normalizeText(journal.publisher).includes(query) ||
          normalizeText(journal.keilmuan).includes(query) ||
          normalizeText(journal.subject).includes(query) ||
          normalizeText(journal.description).includes(query);

        return { journal, index, titleScore, matchesKeyword };
      })
      .filter(({ journal, matchesKeyword }) => {
        // 1. Filter Judul/Kata Kunci
        const matchesQuery = matchesKeyword;

      // 2. Filter Kategori (Scopus / Sinta)
      const matchesType = typeValue === 'all' || journal.type === typeValue;

      // 3. Filter Rumpun Keilmuan
      const matchesSubject = subjectValue === 'all' || journal.subject === subjectValue;

      // 4. Filter Ranking/Kuartil
      const matchesRank = rankValue === 'all' || journal.rank === rankValue;

      // 5. Filter Gratis (No APC)
      const matchesFree = !freeOnly || journal.isFree;

      // 6. Filter Fast Track (Berbayar)
      const matchesFastTrack = !checkFastTrackOnly.checked || journal.isFastTrack;

      return matchesQuery && matchesType && matchesSubject && matchesRank && matchesFree && matchesFastTrack;
    })
      .sort((a, b) => {
        if (query && b.titleScore !== a.titleScore) {
          return b.titleScore - a.titleScore;
        }
        return a.index - b.index;
      })
      .map(({ journal }) => journal);

    // Reset hitungan lazy-loading saat filter berubah
    activeJournals = filtered;
    visibleCount = 30;
    renderCards();
  }

  // --- 3. LOGIKA STATISTIK ---
  
  function calculateStats() {
    let scopusCount = 0;
    let sintaCount = 0;
    let freeCount = 0;

    JOURNAL_DATABASE.forEach(journal => {
      if (journal.type === 'Scopus') scopusCount++;
      if (journal.type === 'Sinta') sintaCount++;
      if (journal.isFree) freeCount++;
    });

    // Menghidupkan angka statistik
    animateValue(statScopusVal, 0, scopusCount, 1000);
    animateValue(statSintaVal, 0, sintaCount, 1000);
    animateValue(statFreeVal, 0, freeCount, 1000);
  }

  // Efek animasi angka bertambah (counter up) dengan format pemisah ribuan titik
  function animateValue(element, start, end, duration) {
    if (start === end) {
      element.textContent = end.toLocaleString('id-ID');
      return;
    }
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      const val = Math.floor(progress * (end - start) + start);
      element.textContent = val.toLocaleString('id-ID');
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        element.textContent = end.toLocaleString('id-ID');
      }
    };
    window.requestAnimationFrame(step);
  }

  // --- 4. EVEN LISTENERS ---

  // Tombol Load More
  loadMoreBtn.addEventListener('click', () => {
    visibleCount += 30;
    renderCards();
  });

  runMatchBtn.addEventListener('click', runJournalMatchWithAi);
  clearMatchBtn.addEventListener('click', clearJournalMatch);

  [articleTitle, articleKeywords, articleAbstract].forEach(field => {
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.ctrlKey) {
        runJournalMatchWithAi();
      }
    });
  });

  // Deteksi Input Pencarian
  searchInput.addEventListener('input', () => {
    if (searchInput.value.length > 0) {
      clearSearchBtn.style.display = 'block';
    } else {
      clearSearchBtn.style.display = 'none';
    }
    filterJournals();
  });

  // Bersihkan kolom pencarian
  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    searchInput.focus();
    filterJournals();
  });

  // Deteksi Perubahan Filter Dropdown & Checkbox
  filterType.addEventListener('change', () => {
    adjustRankOptions(filterType.value);
    filterJournals();
  });
  
  filterSubject.addEventListener('change', filterJournals);
  filterRank.addEventListener('change', filterJournals);
  checkFreeOnly.addEventListener('change', filterJournals);
  checkFastTrackOnly.addEventListener('change', filterJournals);

  // Sesuaikan pilihan tingkatan berdasarkan Kategori yang dipilih
  function adjustRankOptions(selectedType) {
    const options = filterRank.querySelectorAll('option');
    options.forEach(opt => {
      if (opt.value === 'all') return;
      
      const isScopusOpt = opt.value.startsWith('Q');
      const isSintaOpt = opt.value.startsWith('S');

      if (selectedType === 'Scopus') {
        opt.style.display = isScopusOpt ? 'block' : 'none';
      } else if (selectedType === 'Sinta') {
        opt.style.display = isSintaOpt ? 'block' : 'none';
      } else {
        opt.style.display = 'block';
      }
    });

    // Reset pilihan jika tidak valid di kategori baru
    const currentSelected = filterRank.value;
    if (selectedType === 'Scopus' && currentSelected.startsWith('S')) {
      filterRank.value = 'all';
    } else if (selectedType === 'Sinta' && currentSelected.startsWith('Q')) {
      filterRank.value = 'all';
    }
  }

  // Tombol Reset Semua Filter
  resetFiltersBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    filterType.value = 'all';
    filterSubject.value = 'all';
    filterRank.value = 'all';
    checkFreeOnly.checked = false;
    checkFastTrackOnly.checked = false;
    
    adjustRankOptions('all');
    filterJournals();
  });

  // Mengubah Tata Letak Tampilan (Grid/List Toggle)
  viewGridBtn.addEventListener('click', () => {
    if (currentLayout === 'grid') return;
    currentLayout = 'grid';
    viewGridBtn.classList.add('active');
    viewListBtn.classList.remove('active');
    resultsContainer.classList.remove('list-view');
    renderCards();
  });

  viewListBtn.addEventListener('click', () => {
    if (currentLayout === 'list') return;
    currentLayout = 'list';
    viewListBtn.classList.add('active');
    viewGridBtn.classList.remove('active');
    resultsContainer.classList.add('list-view');
    renderCards();
  });

  // Mobile Hamburger Toggle
  if (mobileToggle && navLinks) {
    mobileToggle.addEventListener('click', () => {
      navLinks.classList.toggle('show');
      const isShowing = navLinks.classList.contains('show');
      mobileToggle.innerHTML = isShowing ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
    });
  }

  // Tutup menu mobile ketika link di-klik
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      if (navLinks) navLinks.classList.remove('show');
      if (mobileToggle) mobileToggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
    });
  });

  // Efek Glass Navbar saat digeser (Scroll)
  window.addEventListener('scroll', () => {
    const navbar = document.getElementById('navbar');
    if (navbar) {
      if (window.scrollY > 50) {
        navbar.style.padding = '0.75rem 2rem';
        navbar.style.backgroundColor = 'rgba(7, 9, 14, 0.9)';
      } else {
        navbar.style.padding = '1.25rem 2rem';
        navbar.style.backgroundColor = 'rgba(7, 9, 14, 0.75)';
      }
    }
  });

  // Fungsi untuk menampilkan tab Tersimpan
  function renderBookmarksTab() {
    const container = document.getElementById('tabContentTersimpan');
    if (!container) return;
    
    const savedIds = (currentUser.user && currentUser.user.savedJournals) ? currentUser.user.savedJournals : [];
    const savedJournals = JOURNAL_DATABASE.filter(j => savedIds.includes(j.id));
    
    if (savedJournals.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 5rem 2rem; text-align: center; background: #ffffff; border-radius: var(--card-radius); border: 1px dashed rgba(8,34,64,0.1);">
          <div class="empty-icon" style="font-size: 3rem; color: var(--text-muted); opacity: 0.5; margin-bottom: 1rem;"><i class="fa-solid fa-bookmark"></i></div>
          <h3 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.35rem; color: var(--text-main); margin-bottom: 0.5rem;">Belum Ada Jurnal Tersimpan</h3>
          <p style="color: var(--text-muted); max-width: 400px; margin: 0 auto;">Simpan jurnal dengan menekan ikon bookmark pada kartu jurnal untuk melihatnya di sini.</p>
        </div>
      `;
      return;
    }
    
    container.innerHTML = `
      <h3 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.35rem; color: var(--text-main); margin-bottom: 1.25rem;">Jurnal Tersimpan (${savedJournals.length})</h3>
      <div class="results-grid list-view" id="savedResultsContainer"></div>
    `;
    
    const grid = document.getElementById('savedResultsContainer');
    savedJournals.forEach((journal) => {
      const card = document.createElement('div');
      card.className = `journal-card ${journal.type.toLowerCase()}-card`;
      
      const typeBadgeClass = journal.type === 'Scopus' ? 'type-scopus' : 'type-sinta';
      const rankBadgeClass = `rank-${journal.rank.toLowerCase()}`;
      const apcClass = journal.isFree ? 'free' : 'paid';
      
      card.innerHTML = `
        <div>
          <div class="card-header">
            <div class="card-badge-group">
              <span class="card-type-tag ${typeBadgeClass}">
                <i class="${journal.type === 'Scopus' ? 'fa-solid fa-globe' : 'fa-solid fa-medal'}"></i>
                ${journal.type}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="rank-badge ${rankBadgeClass}">${journal.rank}</span>
              <button class="bookmark-btn active" data-id="${journal.id}" title="Hapus dari Tersimpan">
                <i class="fa-solid fa-bookmark"></i>
              </button>
            </div>
          </div>
          
          <div class="card-body">
            <h3 class="journal-title" title="${journal.title}">${journal.title}</h3>
            <span class="journal-publisher">
              <i class="fa-regular fa-building"></i> ${journal.publisher}
            </span>
            <p class="journal-desc">${journal.description}</p>
          </div>
        </div>

        <div class="card-footer-wrapper">
          <div class="card-meta-details">
            <div class="meta-detail-row">
              <span class="meta-label">Keilmuan:</span>
              <span class="meta-value">${journal.keilmuan}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">Rumpun:</span>
              <span class="meta-value">${journal.subject}</span>
            </div>
            <div class="meta-detail-row">
              <span class="meta-label">Biaya APC:</span>
              <span class="meta-value meta-apc ${apcClass}">${journal.apc}</span>
            </div>
          </div>
          
          <div class="card-footer" style="margin-top: 1.25rem;">
            <a href="${journal.url}" target="_blank" class="journal-link">
              Kunjungi Jurnal <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
    
    // Bind click events to bookmark buttons inside saved list
    grid.querySelectorAll('.bookmark-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const journalId = Number(btn.dataset.id);
        try {
          const response = await fetch('/api/bookmarks/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ journalId })
          });
          if (response.ok) {
            const resData = await response.json();
            currentUser.user.savedJournals = resData.savedJournals;
            // Re-render both lists
            renderCards();
            renderBookmarksTab();
          }
        } catch (error) {
          console.error('Failed to toggle bookmark:', error);
        }
      });
    });
  }

  async function renderTemplatesTab() {
    const grid = document.getElementById('templatesGridContainer');
    if (!grid) return;
    
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i><p>Memuat daftar template...</p></div>';
    
    try {
      const response = await fetch('/api/templates');
      const resData = await response.json();
      if (response.ok && resData.templates) {
        if (resData.templates.length === 0) {
          grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 4rem 2rem; border: 1px dashed rgba(8,34,64,0.1); border-radius: var(--card-radius); width: 100%;">
              <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; color: var(--text-muted); opacity: 0.5; margin-bottom: 1rem;"></i>
              <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.25rem;">Belum Ada Berkas Template</h4>
              <p style="color: var(--text-muted); font-size: 0.88rem; max-width: 320px; margin: 0 auto;">Letakkan file template (.docx) di dalam folder <code>templates/</code> di server untuk menampilkannya di sini.</p>
            </div>
          `;
          return;
        }
        
        grid.innerHTML = '';
        resData.templates.forEach(tpl => {
          const card = document.createElement('div');
          card.className = 'filter-box-card';
          card.style.padding = '1.25rem';
          card.style.display = 'flex';
          card.style.flexDirection = 'column';
          card.style.height = '100%';
          card.style.border = '1px solid rgba(8,34,64,0.08)';
          card.style.borderRadius = '12px';
          card.style.cursor = 'pointer';
          card.style.transition = 'all 0.3s ease';
          
          card.addEventListener('mouseenter', () => {
            card.style.transform = 'translateY(-4px)';
            card.style.boxShadow = '0 8px 24px rgba(8,34,64,0.06)';
            card.style.borderColor = 'var(--brand-blue)';
          });
          card.addEventListener('mouseleave', () => {
            card.style.transform = 'none';
            card.style.boxShadow = 'none';
            card.style.borderColor = 'rgba(8,34,64,0.08)';
          });

          const sizeKb = Math.round(tpl.size / 1024);
          const isPremiumUser = currentUser.user && (currentUser.user.type === 'premium' || currentUser.user.type === 'ultimate');
          const canDownload = tpl.isFree || isPremiumUser;
          
          const dummyLinesHtml = `
            <div style="width: 100%;">
              <div style="height: 4px; background: #e2e8f0; border-radius: 2px; margin-bottom: 6px; width: 40%;"></div>
              <div style="height: 8px; background: #cbd5e1; border-radius: 4px; margin-bottom: 12px; width: 85%;"></div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                <div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                </div>
                <div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                  <div style="height: 3px; background: #f1f5f9; border-radius: 2px; margin-bottom: 4px;"></div>
                </div>
              </div>
            </div>
          `;

          let thumbnailHtml = '';
          if (!canDownload) {
            thumbnailHtml = `
              <div style="aspect-ratio: 1 / 1.25; background: #f8fafc; border-radius: 8px; border: 1px dashed rgba(8,34,64,0.1); margin-bottom: 1rem; padding: 1rem; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; width: 100%;">
                ${dummyLinesHtml}
                <div style="position: absolute; inset: 0; background: rgba(255,255,255,0.75); backdrop-filter: blur(1.5px); display: flex; flex-direction: column; align-items: center; justify-content: center;">
                  <i class="fa-solid fa-lock" style="font-size: 1.5rem; color: #d97706; margin-bottom: 0.5rem;"></i>
                  <span style="font-size: 0.65rem; background: linear-gradient(135deg, #f59e0b, #d97706); color: #ffffff; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 0.2rem;"><i class="fa-solid fa-crown" style="font-size: 0.65rem;"></i> PRO</span>
                </div>
              </div>
            `;
          } else {
            thumbnailHtml = `
              <div style="aspect-ratio: 1 / 1.25; background: #f8fafc; border-radius: 8px; border: 1px solid rgba(8,34,64,0.05); margin-bottom: 1rem; padding: 1rem; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; width: 100%;">
                ${dummyLinesHtml}
                <div style="position: absolute; inset: 0; background: rgba(7, 135, 220, 0.02); display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;" class="hover-overlay-docx">
                  <i class="fa-regular fa-eye" style="font-size: 1.75rem; color: var(--brand-blue);"></i>
                  <span style="font-size: 0.72rem; font-weight: 700; color: var(--brand-blue); margin-top: 0.4rem;">Pratinjau Dokumen</span>
                </div>
                <div style="display: flex; width: 100%; justify-content: space-between; align-items: center; margin-top: auto; z-index: 2;">
                  <i class="fa-regular fa-file-word" style="font-size: 2.2rem; color: #2b579a;"></i>
                  <span style="font-size: 0.65rem; background: #e2e8f0; color: #475569; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700;">Word</span>
                </div>
              </div>
            `;
          }

          const badgeHtml = tpl.isFree ? 
            `<span style="font-size: 0.65rem; background: #e0f2fe; color: #0284c7; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700;">GRATIS</span>` :
            `<span style="font-size: 0.65rem; background: #fef3c7; color: #d97706; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 0.2rem;"><i class="fa-solid fa-crown" style="font-size: 0.6rem;"></i> PRO</span>`;

          card.innerHTML = `
            ${thumbnailHtml}
            <div style="flex-grow: 1; display: flex; flex-direction: column; justify-content: space-between;">
              <div style="margin-bottom: 1rem;">
                <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.25rem;">
                  <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.02rem; color: ${canDownload ? 'var(--text-main)' : '#94a3b8'}; margin: 0; line-height: 1.3;" title="${tpl.displayName}">${tpl.displayName}</h4>
                  ${badgeHtml}
                </div>
                <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500;">Word (.docx) · ${sizeKb} KB</span>
              </div>
              
              ${canDownload ? 
                `<button class="btn btn-primary btn-preview-docx" style="width: 100%; text-align: center; justify-content: center; font-size: 0.85rem; padding: 0.6rem; display: flex; align-items: center; gap: 0.5rem; border-radius: 8px;">
                   <i class="fa-regular fa-eye"></i> Lihat & Unduh
                 </button>` :
                `<button class="btn btn-upgrade-trigger" style="width: 100%; text-align: center; justify-content: center; font-size: 0.85rem; padding: 0.6rem; display: flex; align-items: center; gap: 0.5rem; background: linear-gradient(135deg, #f59e0b, #d97706); border: none; color: white; border-radius: 8px;">
                   <i class="fa-solid fa-crown"></i> Buka PRO
                 </button>`
              }
            </div>
          `;

          const overlay = card.querySelector('.hover-overlay-docx');
          if (overlay) {
            card.addEventListener('mouseenter', () => overlay.style.opacity = '1');
            card.addEventListener('mouseleave', () => overlay.style.opacity = '0');
          }

          card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-upgrade-trigger') || !canDownload) {
              e.preventDefault();
              e.stopPropagation();
              const upgradeModal = document.getElementById('upgradeModal');
              if (upgradeModal) upgradeModal.classList.add('active');
            } else {
              e.preventDefault();
              openDocxViewer(tpl.displayName, tpl.url, tpl.url);
            }
          });

          grid.appendChild(card);
        });
      } else {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #ef4444;"><i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i><p>Gagal memuat: ${resData.message || 'Kesalahan server'}</p></div>`;
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
      grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: #ef4444;"><i class="fa-solid fa-triangle-exclamation" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i><p>Gagal memuat berkas template.</p></div>';
    }
  }

  // --- LOGIKA DOCX VIEWER MODAL ---
  async function openDocxViewer(title, url, downloadUrl) {
    const modal = document.getElementById('docxViewerModal');
    const docxViewerTitle = document.getElementById('docxViewerTitle');
    const docxViewerDownloadBtn = document.getElementById('docxViewerDownloadBtn');
    const container = document.getElementById('docxRenderContainer');
    
    if (!modal || !container) return;
    
    modal.style.display = 'flex';
    docxViewerTitle.textContent = title;
    docxViewerDownloadBtn.href = downloadUrl;
    
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 300px; color: var(--text-muted);">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 2.5rem; color: var(--brand-blue); margin-bottom: 1rem;"></i>
        <p style="font-family: var(--font-outfit); font-weight: 700; color: var(--text-main);">Mengunduh & Merender Dokumen...</p>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Proses ini dilakukan 100% aman di browser Anda</p>
      </div>
    `;
    
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Gagal mengunduh file template dari server.');
      const blob = await response.blob();
      
      container.innerHTML = '';
      await docx.renderAsync(blob, container);
    } catch (error) {
      console.error('docx-preview error:', error);
      container.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 300px; color: #ef4444; text-align: center; padding: 2rem;">
          <i class="fa-solid fa-circle-exclamation" style="font-size: 3rem; margin-bottom: 1rem;"></i>
          <h4 style="font-family: var(--font-outfit); font-weight: 800; margin-bottom: 0.5rem; color: var(--text-main);">Gagal Memuat Pratinjau</h4>
          <p style="font-size: 0.88rem; color: var(--text-muted); max-width: 400px; margin: 0 auto; line-height: 1.5;">
            ${error.message || 'File docx rusak atau terjadi kesalahan rendering. Anda masih dapat mengunduh berkas langsung via tombol "Unduh" di pojok kanan atas.'}
          </p>
        </div>
      `;
    }
  }

  // Bind close event viewer
  const closeDocxViewerBtn = document.getElementById('closeDocxViewerBtn');
  const docxViewerModal = document.getElementById('docxViewerModal');
  if (closeDocxViewerBtn && docxViewerModal) {
    const closeFn = () => {
      docxViewerModal.style.display = 'none';
      const container = document.getElementById('docxRenderContainer');
      if (container) container.innerHTML = '';
    };
    closeDocxViewerBtn.addEventListener('click', closeFn);
    docxViewerModal.addEventListener('click', (e) => {
      if (e.target === docxViewerModal) closeFn();
    });
  }

  // --- LOGIKA AI DRAFTING ASSISTANT ---
  const runDraftGenerator = document.getElementById('runDraftGenerator');
  const draftTitle = document.getElementById('draftTitle');
  const draftAbstract = document.getElementById('draftAbstract');
  const draftSummary = document.getElementById('draftSummary');
  const draftResultsPanel = document.getElementById('draftResultsPanel');
  const draftSegmentsContainer = document.getElementById('draftSegmentsContainer');
  let currentGeneratedDraft = null;

  if (runDraftGenerator) {
    runDraftGenerator.addEventListener('click', async () => {
      // Kunci tombol jika limit bulanan tercapai untuk akun free
      if (currentUser.user && currentUser.user.type === 'free' && currentUser.user.isDraftLimitReached) {
        const upgradeModal = document.getElementById('upgradeModal');
        if (upgradeModal) {
          upgradeModal.classList.add('active');
        }
        return;
      }

      const title = draftTitle.value.trim();
      const abstract = draftAbstract.value.trim();

      if (!title || !abstract) {
        draftSummary.textContent = 'Harap isi judul manuskrip dan abstrak terlebih dahulu.';
        draftSummary.style.color = '#ef4444';
        return;
      }

      runDraftGenerator.disabled = true;
      runDraftGenerator.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Merumuskan...';
      draftSummary.textContent = 'Claude AI sedang merinci pembahasan per bab untuk manuskrip Anda...';
      draftSummary.style.color = 'var(--text-muted)';
      draftResultsPanel.style.display = 'none';

      try {
        const response = await fetch('/api/generate-template-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, abstract })
        });

        if (!response.ok) throw new Error('Gagal memproses draf panduan.');
        const resData = await response.json();

        if (resData.ok && resData.draft) {
          currentGeneratedDraft = resData.draft;
          renderDraftGuide(resData.draft);
          draftSummary.textContent = 'Draf outline panduan pembahasan berhasil dibuat!';
          draftSummary.style.color = '#10b981';
          draftResultsPanel.style.display = 'block';
          draftResultsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

          // Update kuota sisa di frontend jika akun free
          if (currentUser.user && currentUser.user.type === 'free') {
            currentUser.user.isDraftLimitReached = true;
            currentUser.user.draftsRemaining = 0;
            justGeneratedDraft = true; // Set flag
            
            const draftQuotaDisclaimer = document.getElementById('draftQuotaDisclaimer');
            if (draftQuotaDisclaimer) {
              draftQuotaDisclaimer.innerHTML = '<i class="fa-regular fa-clock" style="color: var(--brand-blue);"></i> <span>Kuota Gratis: 0/1 Bulan Ini</span>';
            }
            
            const draftPremiumLock = document.getElementById('draftPremiumLock');
            if (draftPremiumLock) draftPremiumLock.style.display = 'none';
            
            runDraftGenerator.innerHTML = '<i class="fa-solid fa-lock" style="color: #fbbf24;"></i> Limit Bulanan AI Drafting Tercapai';
            runDraftGenerator.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
            runDraftGenerator.classList.add('btn-upgrade-trigger');
          }

          await checkAuthState();
        }
      } catch (error) {
        console.error(error);
        draftSummary.textContent = 'Terjadi kesalahan saat memproses draf panduan: ' + error.message;
        draftSummary.style.color = '#ef4444';
      } finally {
        runDraftGenerator.disabled = false;
        if (!currentUser.user || currentUser.user.type === 'premium' || currentUser.user.type === 'ultimate' || !currentUser.user.isDraftLimitReached) {
          runDraftGenerator.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate Outline Pembahasan AI';
        }
      }
    });
  }

  function renderDraftGuide(draft) {
    if (!draftSegmentsContainer) return;
    draftSegmentsContainer.innerHTML = '';

    const segments = [
      { key: 'introduction', label: '1. Pendahuluan / Latar Belakang (Introduction / Background)', icon: 'fa-book-open', color: '#60a5fa' },
      { key: 'literature_review', label: '2. Tinjauan Pustaka / Landasan Teori (Literature Review)', icon: 'fa-book', color: '#34d399' },
      { key: 'method', label: '3. Metode Penelitian (Methodology)', icon: 'fa-flask', color: '#fbbf24' },
      { key: 'results_discussion', label: '4. Hasil & Pembahasan (Results & Discussion)', icon: 'fa-chart-pie', color: '#a78bfa' },
      { key: 'conclusion', label: '5. Kesimpulan & Saran (Conclusion & Future Work)', icon: 'fa-circle-check', color: '#f87171' }
    ];

    segments.forEach(seg => {
      const points = draft[seg.key] || [];
      const item = document.createElement('div');
      item.style.cssText = `
        background: #f8fafc;
        border: 1px solid rgba(8,34,64,0.06);
        border-radius: 12px;
        padding: 1.25rem;
        transition: all 0.25s ease;
        text-align: left;
        margin-bottom: 1rem;
      `;
      
      const pointsList = points.map(pt => `
        <li style="margin-bottom: 0.75rem; display: flex; align-items: flex-start; gap: 0.6rem; line-height: 1.5; color: var(--text-main); font-size: 0.9rem; text-align: left;">
          <i class="fa-solid fa-arrow-right" style="color: ${seg.color}; font-size: 0.8rem; margin-top: 5px; flex-shrink: 0;"></i>
          <span style="text-align: left;">${escapeHtml(pt)}</span>
        </li>
      `).join('');

      item.innerHTML = `
        <h5 style="margin: 0 0 1rem 0; font-family: var(--font-outfit); font-weight: 800; font-size: 1.05rem; display: flex; align-items: center; gap: 0.6rem; color: var(--text-main); text-align: left;">
          <span style="width: 28px; height: 28px; border-radius: 6px; background: rgba(8,34,64,0.05); display: flex; align-items: center; justify-content: center; font-size: 0.85rem; color: ${seg.color}; flex-shrink: 0;">
            <i class="fa-solid ${seg.icon}"></i>
          </span>
          ${seg.label}
        </h5>
        <ul style="list-style: none; padding: 0; margin: 0; text-align: left;">
          ${pointsList || '<li>Tidak ada poin untuk segmen ini.</li>'}
        </ul>
      `;

      draftSegmentsContainer.appendChild(item);
    });
  }

  // Handle Download File Panduan TXT
  const downloadDraftGuideBtn = document.getElementById('downloadDraftGuideBtn');
  if (downloadDraftGuideBtn) {
    downloadDraftGuideBtn.addEventListener('click', () => {
      if (!currentGeneratedDraft) return;
      
      const title = draftTitle.value.trim();
      const abstract = draftAbstract.value.trim();

      let textContent = `==================================================\nPANDUAN DRAFT PENULISAN MANUSKRIP JURNALHUB AI\n==================================================\n\n`;
      textContent += `Judul Manuskrip: ${title}\n\n`;
      textContent += `Abstrak:\n${abstract}\n\n`;
      textContent += `--------------------------------------------------\nOUTLINE STRUKTUR PEMBAHASAN PER BAB\n--------------------------------------------------\n\n`;

      const segments = [
        { key: 'introduction', label: '1. PENDAHULUAN / LATAR BELAKANG' },
        { key: 'literature_review', label: '2. TINJAUAN PUSTAKA / LANDASAN TEORI' },
        { key: 'method', label: '3. METODE PENELITIAN' },
        { key: 'results_discussion', label: '4. HASIL & PEMBAHASAN' },
        { key: 'conclusion', label: '5. KESIMPULAN & SARAN' }
      ];

      segments.forEach(seg => {
        textContent += `${seg.label}:\n`;
        const points = currentGeneratedDraft[seg.key] || [];
        points.forEach((pt, idx) => {
          textContent += `   [${idx + 1}] ${pt}\n`;
        });
        textContent += `\n`;
      });

      textContent += `==================================================\nGenerated by JurnalHub AI Drafting Assistant\n==================================================`;

      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Panduan_Draft_${title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_')}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }

  // Expose function to window
  window.renderBookmarksTab = renderBookmarksTab;
  window.renderTemplatesTab = renderTemplatesTab;

  // --- 5. INITIALIZATION ---
  async function init() {
    await checkAuthState();

    // Load default preferences from localStorage if exists
    const defaultSubject = localStorage.getItem('defaultSubject') || 'all';
    const defaultType = localStorage.getItem('defaultType') || 'all';
    
    if (filterSubject) filterSubject.value = defaultSubject;
    if (filterType) {
      filterType.value = defaultType;
      adjustRankOptions(defaultType);
    }
    
    // Set settings default values
    const settingsDefaultSubject = document.getElementById('settingsDefaultSubject');
    const settingsDefaultType = document.getElementById('settingsDefaultType');
    if (settingsDefaultSubject) settingsDefaultSubject.value = defaultSubject;
    if (settingsDefaultType) settingsDefaultType.value = defaultType;

    // Preferences Save Button Handler
    const savePreferencesBtn = document.getElementById('savePreferencesBtn');
    if (savePreferencesBtn) {
      savePreferencesBtn.addEventListener('click', () => {
        const defaultSubjectVal = settingsDefaultSubject ? settingsDefaultSubject.value : 'all';
        const defaultTypeVal = settingsDefaultType ? settingsDefaultType.value : 'all';
        
        localStorage.setItem('defaultSubject', defaultSubjectVal);
        localStorage.setItem('defaultType', defaultTypeVal);
        
        // Sync immediately to search filters
        if (filterSubject) filterSubject.value = defaultSubjectVal;
        if (filterType) {
          filterType.value = defaultTypeVal;
          adjustRankOptions(defaultTypeVal);
        }
        
        filterJournals();
        alert('Preferensi riset default berhasil disimpan!');
      });
    }

    // Change Password Form Handler
    const changePasswordForm = document.getElementById('changePasswordForm');
    const changePasswordMessage = document.getElementById('changePasswordMessage');
    if (changePasswordForm) {
      changePasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const oldPassword = document.getElementById('oldPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmNewPassword = document.getElementById('confirmNewPassword').value;
        
        if (newPassword !== confirmNewPassword) {
          changePasswordMessage.style.color = '#ef4444';
          changePasswordMessage.textContent = 'Konfirmasi password baru tidak cocok.';
          changePasswordMessage.style.display = 'block';
          return;
        }
        
        try {
          const response = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
          });
          const resData = await response.json();
          if (response.ok) {
            changePasswordMessage.style.color = '#10b981';
            changePasswordMessage.textContent = resData.message;
            changePasswordForm.reset();
          } else {
            changePasswordMessage.style.color = '#ef4444';
            changePasswordMessage.textContent = resData.message;
          }
          changePasswordMessage.style.display = 'block';
        } catch (error) {
          console.error('Password change error:', error);
          changePasswordMessage.style.color = '#ef4444';
          changePasswordMessage.textContent = 'Gagal memperbarui kata sandi.';
          changePasswordMessage.style.display = 'block';
        }
      });
    }

    // --- LOGIKA UPDATE PROFIL & UPLOAD FOTO ---
    const avatarUploadTrigger = document.getElementById('avatarUploadTrigger');
    const profilePicInput = document.getElementById('profilePicInput');
    const profileForm = document.getElementById('profileForm');
    const profileMessage = document.getElementById('profileMessage');
    let selectedBase64Pic = '';

    if (avatarUploadTrigger && profilePicInput) {
      avatarUploadTrigger.addEventListener('click', () => {
        profilePicInput.click();
      });
    }

    if (profilePicInput) {
      profilePicInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          if (file.size > 1024 * 1024) {
            alert('Ukuran foto terlalu besar. Maksimal 1MB.');
            return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
            selectedBase64Pic = reader.result;
            const settingsAvatarImg = document.getElementById('settingsAvatarImg');
            const settingsAvatarInitials = document.getElementById('settingsAvatarInitials');
            if (settingsAvatarImg) {
              settingsAvatarImg.src = selectedBase64Pic;
              settingsAvatarImg.style.display = 'block';
            }
            if (settingsAvatarInitials) {
              settingsAvatarInitials.style.display = 'none';
            }
          };
          reader.readAsDataURL(file);
        }
      });
    }

    if (profileForm) {
      profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('profileName').value;
        const faculty = document.getElementById('profileFaculty').value;
        const university = document.getElementById('profileUniversity').value;
        
        const payload = {
          name,
          faculty,
          university
        };
        
        if (selectedBase64Pic) {
          payload.profilePic = selectedBase64Pic;
        }
        
        try {
          const response = await fetch('/api/update-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const resData = await response.json();
          if (response.ok) {
            profileMessage.style.color = '#10b981';
            profileMessage.textContent = resData.message;
            profileMessage.style.display = 'block';
            
            // Perbarui state currentUser lokal
            currentUser.user = resData.user;
            selectedBase64Pic = '';
            
            // Sinkronisasi avatar & nama di sidebar secara real-time
            const emailPrefix = currentUser.user.email.split('@')[0];
            const displayName = currentUser.user.name ? currentUser.user.name : emailPrefix;
            const profileEmail = document.getElementById('profileEmail');
            const profileAvatar = document.getElementById('profileAvatar');
            
            if (profileEmail) profileEmail.textContent = displayName;
            if (profileAvatar) {
              if (currentUser.user.profilePic) {
                profileAvatar.innerHTML = `<img src="${currentUser.user.profilePic}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
              } else {
                profileAvatar.innerHTML = emailPrefix.substring(0, 2).toUpperCase();
              }
            }
          } else {
            profileMessage.style.color = '#ef4444';
            profileMessage.textContent = resData.message;
            profileMessage.style.display = 'block';
          }
        } catch (error) {
          console.error('Update profile error:', error);
          profileMessage.style.color = '#ef4444';
          profileMessage.textContent = 'Gagal memperbarui profil.';
          profileMessage.style.display = 'block';
        }
      });
    }

    // --- LOGIKA PROMPT BANK ---
    let promptBankData = null;
    let activePromptTab = 'scopus'; // 'scopus' atau 'tesis_disertasi'
    let activePromptStage = '';

    window.initPromptBankTab = async function() {
      if (!promptBankData) {
        try {
          const res = await fetch('/api/prompts');
          if (!res.ok) throw new Error('Gagal memuat database prompt');
          const data = await res.json();
          if (data.ok) {
            promptBankData = {
              scopus: data.scopus || [],
              tesis_disertasi: data.tesis_disertasi || []
            };
          }
        } catch (err) {
          console.error(err);
          const promptsListContainer = document.getElementById('promptsListContainer');
          if (promptsListContainer) {
            promptsListContainer.innerHTML = `<div style="text-align:center; padding: 2rem; color: #ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> Gagal memuat database prompt. Silakan coba beberapa saat lagi.</div>`;
          }
          return;
        }
      }

      renderPromptStages();
    };

    // Handler Tab Switcher
    const promptTabScopus = document.getElementById('promptTabScopus');
    const promptTabTesis = document.getElementById('promptTabTesis');
    const promptSearchInput = document.getElementById('promptSearchInput');

    if (promptTabScopus && promptTabTesis) {
      promptTabScopus.addEventListener('click', () => {
        promptTabScopus.classList.add('active');
        promptTabTesis.classList.remove('active');
        activePromptTab = 'scopus';
        activePromptStage = '';
        if (promptSearchInput) promptSearchInput.value = '';
        renderPromptStages();
      });

      promptTabTesis.addEventListener('click', () => {
        promptTabTesis.classList.add('active');
        promptTabScopus.classList.remove('active');
        activePromptTab = 'tesis_disertasi';
        activePromptStage = '';
        if (promptSearchInput) promptSearchInput.value = '';
        renderPromptStages();
      });
    }

    if (promptSearchInput) {
      promptSearchInput.addEventListener('input', () => {
        renderPromptsList();
      });
    }

    function renderPromptStages() {
      const promptStagesList = document.getElementById('promptStagesList');
      if (!promptStagesList || !promptBankData) return;

      promptStagesList.innerHTML = '';
      const categories = promptBankData[activePromptTab] || [];

      if (categories.length === 0) {
        promptStagesList.innerHTML = '<p style="color: var(--text-muted); font-size: 0.88rem;">Tidak ada kategori.</p>';
        return;
      }

      // Set default active stage if none selected
      if (!activePromptStage && categories.length > 0) {
        activePromptStage = categories[0].category;
      }

      categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = `
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 0.75rem 1rem;
          border: 1px solid transparent;
          border-radius: 8px;
          background: none;
          color: var(--text-main);
          font-family: inherit;
          font-size: 0.88rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
        `;

        if (cat.category === activePromptStage) {
          btn.style.background = 'rgba(7, 135, 220, 0.08)';
          btn.style.color = 'var(--brand-blue)';
          btn.style.fontWeight = '700';
          btn.style.borderColor = 'rgba(7, 135, 220, 0.15)';
        } else {
          btn.addEventListener('mouseenter', () => {
            btn.style.background = '#f8fafc';
          });
          btn.addEventListener('mouseleave', () => {
            if (cat.category !== activePromptStage) {
              btn.style.background = 'none';
            }
          });
        }

        btn.innerHTML = `
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;">
            ${cat.category.replace(/^\d+\s+/, '')}
          </span>
          <span style="font-size: 0.75rem; background: ${cat.category === activePromptStage ? 'var(--brand-blue)' : '#f1f5f9'}; color: ${cat.category === activePromptStage ? '#ffffff' : 'var(--text-muted)'}; padding: 0.1rem 0.5rem; border-radius: 10px; font-weight: 700;">
            ${cat.prompts.length}
          </span>
        `;

        btn.addEventListener('click', () => {
          activePromptStage = cat.category;
          renderPromptStages();
        });

        promptStagesList.appendChild(btn);
      });

      renderPromptsList();
    }

    function renderPromptsList() {
      const activeStageTitle = document.getElementById('activeStageTitle');
      const activePromptCount = document.getElementById('activePromptCount');
      const promptsListContainer = document.getElementById('promptsListContainer');
      const searchQuery = promptSearchInput ? promptSearchInput.value.trim().toLowerCase() : '';

      if (!promptsListContainer || !promptBankData) return;
      promptsListContainer.innerHTML = '';
      promptsListContainer.style.position = 'relative';

      const categories = promptBankData[activePromptTab] || [];
      const isFreeUser = currentUser.user && currentUser.user.type === 'free';
      const isFreeStage = activePromptStage.startsWith('01 ');
      
      if (searchQuery) {
        // Global search across all categories in the active tab
        activeStageTitle.textContent = `Hasil Pencarian: "${searchQuery}"`;
        let totalMatches = 0;
        
        categories.forEach(cat => {
          // Bagi Free User, hanya boleh mencari dari kategori 01 (Topik/Judul)
          if (isFreeUser && !cat.category.startsWith('01 ')) {
            return;
          }

          const matched = cat.prompts.filter(p => p.text.toLowerCase().includes(searchQuery));
          if (matched.length > 0) {
            totalMatches += matched.length;
            
            // Header kategori pencarian
            const catHeader = document.createElement('div');
            catHeader.style.cssText = `
              font-family: var(--font-outfit);
              font-weight: 800;
              font-size: 0.9rem;
              color: var(--brand-blue);
              text-transform: uppercase;
              letter-spacing: 0.05em;
              margin-top: 1rem;
              margin-bottom: 0.5rem;
              background: #f8fafc;
              padding: 0.4rem 0.75rem;
              border-radius: 6px;
              border-left: 3px solid var(--brand-blue);
            `;
            catHeader.textContent = cat.category.replace(/^\d+\s+/, '');
            promptsListContainer.appendChild(catHeader);
            
            matched.forEach(p => {
              promptsListContainer.appendChild(createPromptCard(p, cat.category));
            });
          }
        });
        
        activePromptCount.textContent = `${totalMatches} Cocok`;

        // Tampilkan info penafian pencarian terbatas untuk Free User
        if (isFreeUser) {
          const searchDisclaimer = document.createElement('div');
          searchDisclaimer.style.cssText = `
            margin-top: 1.5rem;
            padding: 1rem;
            background: rgba(245, 158, 11, 0.06);
            border: 1px solid rgba(245, 158, 11, 0.2);
            border-radius: 8px;
            text-align: center;
            font-size: 0.85rem;
            color: #d97706;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
          `;
          searchDisclaimer.innerHTML = `<i class="fa-solid fa-circle-info"></i> Hasil tidak semua ditampilkan, silakan upgrade untuk menampilkan.`;
          promptsListContainer.appendChild(searchDisclaimer);
        }

        if (totalMatches === 0) {
          promptsListContainer.innerHTML = `
            <div style="text-align: center; padding: 4rem 2rem; color: var(--text-muted);">
              <i class="fa-regular fa-folder-open" style="font-size: 2.5rem; opacity: 0.5; margin-bottom: 1rem; display: block;"></i>
              <p style="font-weight: 600;">Tidak menemukan prompt yang cocok.</p>
              <p style="font-size: 0.85rem; margin-top: 0.25rem;">Cobalah kata kunci pencarian yang lebih umum.</p>
            </div>
          `;
        }
      } else {
        // Standard view: filter by active stage
        const currentCat = categories.find(c => c.category === activePromptStage);
        if (currentCat) {
          activeStageTitle.textContent = currentCat.category.replace(/^\d+\s+/, '');
          activePromptCount.textContent = `${currentCat.prompts.length} Prompt`;
          
          if (isFreeUser && !isFreeStage) {
            // Render 3 dummy blurred prompt cards
            for (let i = 0; i < 3; i++) {
              promptsListContainer.appendChild(createBlurredPromptCard(i));
            }
            // Tambahkan overlay gembok & CTA upgrade
            promptsListContainer.appendChild(createLockOverlay());
          } else {
            currentCat.prompts.forEach(p => {
              promptsListContainer.appendChild(createPromptCard(p, currentCat.category));
            });
          }
        } else {
          activeStageTitle.textContent = 'Pilih Tahapan';
          activePromptCount.textContent = '0 Prompt';
          promptsListContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 0.88rem; text-align: center; padding: 2rem;">Silakan pilih kategori tahapan di sebelah kiri.</p>';
        }
      }
    }

    function createBlurredPromptCard(index) {
      const dummyTexts = [
        "Bantu saya menganalisis kelemahan metodologi penelitian [nama_metode] dengan menyusun perbandingan yang tajam dari aspek pengumpulan data lapangan.",
        "Tulis paragraf tinjauan pustaka kritis yang mengaitkan teori [nama_teori] dengan variabel [nama_variabel] dalam penelitian hukum siber.",
        "Reformulasikan paragraf temuan penelitian ini agar lebih akademis dan logis bagi reviewer jurnal Scopus bereputasi tinggi: [paste_teks]."
      ];
      const card = document.createElement('div');
      card.style.cssText = `
        background: #ffffff;
        border: 1px solid rgba(8,34,64,0.06);
        border-radius: 12px;
        padding: 1.25rem;
        filter: blur(4.5px);
        pointer-events: none;
        user-select: none;
        text-align: left;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        opacity: 0.45;
      `;
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); background: #f8fafc; padding: 0.25rem 0.5rem; border-radius: 6px;">
            Prompt #???
          </span>
        </div>
        <p style="color: var(--text-main); font-size: 0.92rem; line-height: 1.6; margin: 0;">
          ${dummyTexts[index % 3]}
        </p>
      `;
      return card;
    }

    function createLockOverlay() {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(255, 255, 255, 0.4);
        backdrop-filter: blur(1.5px);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 2rem;
        z-index: 5;
        min-height: 380px;
      `;
      overlay.innerHTML = `
        <div style="background: #ffffff; border: 1px solid rgba(8,34,64,0.08); padding: 2.5rem 2rem; border-radius: 20px; box-shadow: 0 10px 40px rgba(8,34,64,0.12); max-width: 460px; display: flex; flex-direction: column; align-items: center; gap: 1rem; animation: fadeInUp 0.3s ease;">
          <div style="width: 54px; height: 54px; border-radius: 50%; background: rgba(245, 158, 11, 0.1); display: flex; align-items: center; justify-content: center; font-size: 1.6rem; color: #f59e0b; margin-bottom: 0.25rem;">
            <i class="fa-solid fa-lock"></i>
          </div>
          <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.25rem; color: var(--text-main); margin: 0;">Fitur PRO: Prompt Bank</h4>
          <p style="color: var(--text-muted); font-size: 0.88rem; line-height: 1.5; margin: 0;">
            Kategori tahapan ini hanya tersedia untuk pengguna PRO. Upgrade akun Anda sekarang untuk membuka akses penuh ke 2.100+ prompt riset siap pakai.
          </p>
          <button class="upgrade-btn btn-upgrade-trigger" style="width: 100%; padding: 0.85rem; background: linear-gradient(135deg, #f59e0b, #d97706); color: #051329; font-weight: 800; border-radius: 10px; border: none; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 0.5rem;" type="button">
            <i class="fa-solid fa-crown"></i> Buka Akses PRO
          </button>
        </div>
      `;
      
      overlay.querySelector('.btn-upgrade-trigger').addEventListener('click', () => {
        const upgradeModal = document.getElementById('upgradeModal');
        if (upgradeModal) upgradeModal.classList.add('active');
      });
      
      return overlay;
    }

    function createPromptCard(prompt, categoryName) {
      const card = document.createElement('div');
      card.style.cssText = `
        background: #ffffff;
        border: 1px solid rgba(8,34,64,0.06);
        border-radius: 12px;
        padding: 1.25rem;
        transition: all 0.2s ease;
        text-align: left;
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      `;

      // Highlight placeholders like [bidang], [topik], [jenjang], etc.
      let highlightedText = prompt.text.replace(/\[([^\]]+)\]/g, (match, p1) => {
        return `<span style="background: rgba(7, 135, 220, 0.08); border: 1px dashed rgba(7, 135, 220, 0.3); color: var(--brand-blue); padding: 0.1rem 0.4rem; border-radius: 4px; font-weight: 700; font-size: 0.88rem; font-family: monospace;">[${p1}]</span>`;
      });

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
          <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); background: #f8fafc; border: 1px solid rgba(8,34,64,0.04); padding: 0.2rem 0.5rem; border-radius: 6px; flex-shrink: 0;">
            Prompt #${prompt.id}
          </span>
          <button class="copy-prompt-btn" type="button" style="background: none; border: none; color: var(--brand-blue); cursor: pointer; display: flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; font-weight: 700; padding: 0.25rem 0.5rem; border-radius: 6px; transition: all 0.2s;" data-text="${prompt.text.replace(/"/g, '&quot;')}">
            <i class="fa-regular fa-copy"></i> Salin Prompt
          </button>
        </div>
        <p style="color: var(--text-main); font-size: 0.92rem; line-height: 1.6; margin: 0; text-align: left;">
          ${highlightedText}
        </p>
      `;

      // Copy to Clipboard logic
      const copyBtn = card.querySelector('.copy-prompt-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const rawText = copyBtn.getAttribute('data-text');
          navigator.clipboard.writeText(rawText).then(() => {
            copyBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10b981;"></i> Tersalin!';
            copyBtn.style.color = '#10b981';
            setTimeout(() => {
              copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Salin Prompt';
              copyBtn.style.color = 'var(--brand-blue)';
            }, 2000);
          }).catch(err => {
            console.error('Copy failed:', err);
          });
        });

        // Hover styling for copy button
        copyBtn.addEventListener('mouseenter', () => {
          copyBtn.style.background = 'rgba(7, 135, 220, 0.05)';
        });
        copyBtn.addEventListener('mouseleave', () => {
          copyBtn.style.background = 'none';
        });
      }

      return card;
    }

    // --- LOGIKA AI LITERATURE REVIEW & CITATION FINDER ---
    const runLitReviewBtn = document.getElementById('runLitReviewBtn');
    if (runLitReviewBtn) {
      runLitReviewBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        // Jika user dibatasi kuota bulanan, panggil modal upgrade saat di-klik
        if (runLitReviewBtn.classList.contains('btn-upgrade-trigger')) {
          const upgradeModal = document.getElementById('upgradeModal');
          if (upgradeModal) upgradeModal.classList.add('active');
          return;
        }

        const titleInput = document.getElementById('litReviewTitle');
        const keywordsInput = document.getElementById('litReviewKeywords');
        const abstractInput = document.getElementById('litReviewAbstract');

        const title = titleInput ? titleInput.value.trim() : '';
        const keywords = keywordsInput ? keywordsInput.value.trim() : '';
        const abstract = abstractInput ? abstractInput.value.trim() : '';

        if (!title) {
          alert('Mohon masukkan judul atau topik penelitian terlebih dahulu.');
          return;
        }

        const originalBtnHtml = runLitReviewBtn.innerHTML;
        runLitReviewBtn.disabled = true;
        runLitReviewBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses Kajian AI...';

        const resultsPanel = document.getElementById('litReviewResultsPanel');
        const textContainer = document.getElementById('litReviewTextContainer');
        const citationsContainer = document.getElementById('litReviewCitationsContainer');

        if (resultsPanel) resultsPanel.style.display = 'none';

        try {
          const response = await fetch('/api/lit-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, keywords, abstract })
          });

          const data = await response.json();

          if (!response.ok) {
            alert(data.message || 'Terjadi kesalahan saat memproses data.');
            return;
          }

          // Update UI
          currentCitations = data.citations || [];
          if (textContainer) {
            textContainer.innerHTML = data.review || '<p>Tidak ada draf yang dihasilkan.</p>';
          }

          if (citationsContainer) {
            citationsContainer.innerHTML = '';
            if (data.citations && data.citations.length > 0) {
              data.citations.forEach(cit => {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid rgba(8,34,64,0.04)';
                tr.innerHTML = `
                  <td style="padding: 1rem; vertical-align: top; max-width: 280px; font-weight: 600; color: var(--text-main);">${cit.title}<br><span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted);">Penulis: ${cit.authors || '-'}</span></td>
                  <td style="padding: 1rem; vertical-align: top; color: var(--text-muted); font-size: 0.82rem;">${cit.journal || '-'}<br><span style="font-size: 0.78rem; background: #e2e8f0; color: #475569; padding: 0.1rem 0.4rem; border-radius: 4px;">${cit.year || '-'}</span></td>
                  <td style="padding: 1rem; vertical-align: top; color: var(--text-muted); font-size: 0.82rem; line-height: 1.4;">${cit.reason || '-'}</td>
                  <td style="padding: 1rem; vertical-align: top; text-align: center;">
                    <a href="${cit.url}" target="_blank" class="reset-filter-btn" style="display: inline-flex; text-decoration: none; padding: 0.4rem 0.8rem; background: var(--brand-blue); color: white; border: none; font-size: 0.78rem;">
                      <i class="fa-solid fa-arrow-up-right-from-square"></i> Buka Link
                    </a>
                  </td>
                `;
                citationsContainer.appendChild(tr);
              });
            } else {
              citationsContainer.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 2rem; color: var(--text-muted);">Tidak ada referensi online eksternal yang terindeks langsung.</td></tr>`;
            }
          }

          if (resultsPanel) {
            resultsPanel.style.display = 'block';
            resultsPanel.scrollIntoView({ behavior: 'smooth' });
          }

          // Sinkronisasi status limit terbaru
          justGeneratedLitReview = true;
          await checkAuthState();

        } catch (error) {
          console.error('[Lit Review UI] Error:', error);
          alert('Gagal menghubungi server untuk memproses literature review.');
        } finally {
          runLitReviewBtn.disabled = false;
          runLitReviewBtn.innerHTML = originalBtnHtml;
        }
      });
    }

    // PDF Export
    const downloadLitPdfBtn = document.getElementById('downloadLitPdfBtn');
    if (downloadLitPdfBtn) {
      downloadLitPdfBtn.addEventListener('click', () => {
        const element = document.getElementById('litReviewTextContainer');
        if (!element || !element.innerText.trim()) {
          alert('Belum ada data tinjauan pustaka untuk diunduh.');
          return;
        }

        const titleInput = document.getElementById('litReviewTitle');
        const titleText = titleInput ? titleInput.value.trim() : 'Tinjauan_Pustaka';
        const cleanTitle = titleText.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_');

        const opt = {
          margin:       1,
          filename:     `Tinjauan_Pustaka_${cleanTitle}.pdf`,
          image:        { type: 'jpeg', quality: 0.98 },
          html2canvas:  { scale: 2 },
          jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
        };

        html2pdf().set(opt).from(element).save();
      });
    }

    // Word (.docx) Export
    const downloadLitDocxBtn = document.getElementById('downloadLitDocxBtn');
    if (downloadLitDocxBtn) {
      downloadLitDocxBtn.addEventListener('click', () => {
        const textContainer = document.getElementById('litReviewTextContainer');
        if (!textContainer || !textContainer.innerText.trim()) {
          alert('Belum ada data tinjauan pustaka untuk diunduh.');
          return;
        }

        const titleInput = document.getElementById('litReviewTitle');
        const titleText = titleInput ? titleInput.value.trim() : 'Tinjauan Pustaka';
        const cleanTitleFile = titleText.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_');

        const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
                       "xmlns:w='urn:schemas-microsoft-com:office:word' " +
                       "xmlns='http://www.w3.org/TR/REC-html40'>" +
                       "<head><title>Tinjauan Pustaka</title><style>body { font-family: Arial, sans-serif; line-height: 1.6; } h1, h2, h3 { color: #0b1a30; }</style></head><body>" +
                       "<h2>Tinjauan Pustaka: " + titleText + "</h2>";
        const footer = "</body></html>";
        const htmlContent = header + textContainer.innerHTML + footer;

        const blob = new Blob(['\ufeff' + htmlContent], {
          type: 'application/msword;charset=utf-8'
        });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `Tinjauan_Pustaka_${cleanTitleFile}.doc`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }

    // RIS Export
    const exportCitationsRisBtn = document.getElementById('exportCitationsRisBtn');
    if (exportCitationsRisBtn) {
      exportCitationsRisBtn.addEventListener('click', () => {
        if (!currentCitations || currentCitations.length === 0) {
          alert('Belum ada referensi ilmiah untuk diekspor.');
          return;
        }

        let risContent = '';
        currentCitations.forEach(cit => {
          risContent += 'TY  - JOUR\r\n';
          risContent += `TI  - ${cit.title || 'Untitled'}\r\n`;
          if (cit.authors) {
            const authorsList = cit.authors.split(/,|&|dan/i);
            authorsList.forEach(auth => {
              risContent += `AU  - ${auth.trim()}\r\n`;
            });
          }
          if (cit.journal) risContent += `JO  - ${cit.journal}\r\n`;
          if (cit.year) risContent += `PY  - ${cit.year}\r\n`;
          if (cit.url) risContent += `UR  - ${cit.url}\r\n`;
          if (cit.reason) risContent += `N1  - Relevansi: ${cit.reason}\r\n`;
          risContent += 'ER  - \r\n\r\n';
        });

        const blob = new Blob([risContent], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'Referensi_Kutipan.ris';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }

    // BibTeX Export
    const exportCitationsBibBtn = document.getElementById('exportCitationsBibBtn');
    if (exportCitationsBibBtn) {
      exportCitationsBibBtn.addEventListener('click', () => {
        if (!currentCitations || currentCitations.length === 0) {
          alert('Belum ada referensi ilmiah untuk diekspor.');
          return;
        }

        let bibContent = '';
        currentCitations.forEach((cit, idx) => {
          const firstAuthor = cit.authors ? cit.authors.split(/,| /)[0].toLowerCase().replace(/[^a-z]/g, '') : 'author';
          const year = cit.year || '2026';
          const titleWord = cit.title ? cit.title.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') : 'article';
          const citeKey = `${firstAuthor}${year}${titleWord}${idx+1}`;

          bibContent += `@article{${citeKey},\r\n`;
          bibContent += `  title = {${cit.title || 'Untitled'}},\r\n`;
          if (cit.authors) bibContent += `  author = {${cit.authors}},\r\n`;
          if (cit.journal) bibContent += `  journal = {${cit.journal}},\r\n`;
          if (cit.year) bibContent += `  year = {${cit.year}},\r\n`;
          if (cit.url) bibContent += `  url = {${cit.url}},\r\n`;
          if (cit.reason) bibContent += `  note = {Relevansi: ${cit.reason}},\r\n`;
          bibContent += '}\r\n\r\n';
        });

        const blob = new Blob([bibContent], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'Referensi_Kutipan.bib';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });
    }

    // --- JURNALHUB HUMANIZER ENGINE ---
    const humanizerInputText = document.getElementById('humanizerInputText');
    const humanizerWordCounter = document.getElementById('humanizerWordCounter');
    const runHumanizerBtn = document.getElementById('runHumanizerBtn');
    const humanizerResultsPanel = document.getElementById('humanizerResultsPanel');
    const humanizerOutputText = document.getElementById('humanizerOutputText');
    const humanizerScoreLabel = document.getElementById('humanizerScoreLabel');
    const humanizerScoreBar = document.getElementById('humanizerScoreBar');
    const copyHumanizerOutputBtn = document.getElementById('copyHumanizerOutputBtn');
    const resetHumanizerBtn = document.getElementById('resetHumanizerBtn');

    // Dynamic word counter listener
    if (humanizerInputText && humanizerWordCounter) {
      const updateWordCount = () => {
        const text = humanizerInputText.value.trim();
        const wordCount = text === '' ? 0 : text.split(/\s+/).filter(w => w.length > 0).length;
        humanizerWordCounter.textContent = `${wordCount.toLocaleString('id-ID')} / 2.000 Kata`;
        
        if (wordCount > 2000) {
          humanizerWordCounter.style.color = '#ef4444';
        } else {
          humanizerWordCounter.style.color = 'var(--text-muted)';
        }
      };
      humanizerInputText.addEventListener('input', updateWordCount);
      humanizerInputText.addEventListener('keyup', updateWordCount);
      humanizerInputText.addEventListener('paste', () => setTimeout(updateWordCount, 50));
    }

    if (runHumanizerBtn) {
      runHumanizerBtn.addEventListener('click', async (e) => {
        e.preventDefault();

        // Check if upgrade is needed
        if (runHumanizerBtn.classList.contains('btn-upgrade-trigger')) {
          const upgradeTrigger = document.querySelector('.btn-upgrade-trigger');
          if (upgradeTrigger) {
            const overlay = document.getElementById('upgradeOverlay');
            if (overlay) overlay.style.display = 'flex';
          }
          return;
        }

        const text = humanizerInputText.value.trim();
        if (!text) {
          alert('Silakan masukkan teks AI yang ingin di-humanize.');
          return;
        }

        const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount > 2000) {
          alert('Teks melebihi batas maksimal 2.000 kata per panggilan.');
          return;
        }

        const modeSelector = document.querySelector('input[name="humanizerMode"]:checked');
        const mode = modeSelector ? modeSelector.value : 'standard';

        const originalBtnHtml = runHumanizerBtn.innerHTML;
        runHumanizerBtn.disabled = true;
        runHumanizerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menghilangkan Gaya AI...';

        try {
          const response = await fetch('/api/humanize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, mode })
          });

          const data = await response.json();

          if (!response.ok) {
            alert(data.message || 'Gagal memproses humanisasi teks.');
            return;
          }

          if (humanizerOutputText) {
            humanizerOutputText.value = data.humanizedText;
          }

          if (humanizerScoreLabel) {
            humanizerScoreLabel.textContent = `${data.originalityScore}%`;
          }

          if (humanizerScoreBar) {
            humanizerScoreBar.style.width = `${data.originalityScore}%`;
          }

          if (humanizerResultsPanel) {
            humanizerResultsPanel.style.display = 'block';
            humanizerResultsPanel.scrollIntoView({ behavior: 'smooth' });
          }

          // Sinkronisasi status limit terbaru
          justGeneratedHumanizer = true;
          await checkAuthState();

        } catch (error) {
          console.error('[Humanizer UI] Error:', error);
          alert('Gagal menghubungi server untuk memproses humanisasi.');
        } finally {
          runHumanizerBtn.disabled = false;
          runHumanizerBtn.innerHTML = originalBtnHtml;
        }
      });
    }

    if (copyHumanizerOutputBtn && humanizerOutputText) {
      copyHumanizerOutputBtn.addEventListener('click', () => {
        const text = humanizerOutputText.value;
        if (!text) {
          alert('Tidak ada teks untuk disalin.');
          return;
        }

        navigator.clipboard.writeText(text).then(() => {
          const originalText = copyHumanizerOutputBtn.innerHTML;
          copyHumanizerOutputBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
          setTimeout(() => {
            copyHumanizerOutputBtn.innerHTML = originalText;
          }, 2000);
        }).catch(err => {
          console.error('Copy failed:', err);
          alert('Gagal menyalin teks secara otomatis.');
        });
      });
    }

    if (resetHumanizerBtn) {
      resetHumanizerBtn.addEventListener('click', () => {
        if (humanizerInputText) {
          humanizerInputText.value = '';
          const wordCounter = document.getElementById('humanizerWordCounter');
          if (wordCounter) wordCounter.textContent = '0 / 2.000 Kata';
        }
        if (humanizerOutputText) {
          humanizerOutputText.value = '';
        }
        if (humanizerResultsPanel) {
          humanizerResultsPanel.style.display = 'none';
        }
      });
    }

    // --- ASISTEN RISET AI (DeepSeek Chat) ---
    let researchChatMessages = [];
    let currentResearchChatId = null;
    let selectedResearchModel = 'lite';
    let selectedResearchMode = 'basic';
    const researchChatMessagesEl = document.getElementById('researchChatMessages');
    const researchChatEmptyState = document.getElementById('researchChatEmptyState');
    const researchChatInput = document.getElementById('researchChatInput');
    const researchChatSendBtn = document.getElementById('researchChatSendBtn');
    const researchChatClearBtn = document.getElementById('researchChatClearBtn');
    const researchChatHistoryListEl = document.getElementById('researchChatHistoryList');
    const researchChatHistoryEmptyEl = document.getElementById('researchChatHistoryEmpty');

    function formatResearchChatRelativeTime(isoDate) {
      const diffMs = Date.now() - new Date(isoDate).getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'Baru saja';
      if (diffMin < 60) return `${diffMin} menit lalu`;
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) return `${diffHour} jam lalu`;
      const diffDay = Math.floor(diffHour / 24);
      if (diffDay < 7) return `${diffDay} hari lalu`;
      return new Date(isoDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    async function renderResearchChatHistoryList() {
      if (!researchChatHistoryListEl) return;
      try {
        const response = await fetch('/api/research-chat/conversations');
        const data = await response.json();
        if (!data.ok) return;

        const conversations = data.conversations || [];
        if (conversations.length === 0) {
          researchChatHistoryListEl.innerHTML = '';
          if (researchChatHistoryEmptyEl) researchChatHistoryListEl.appendChild(researchChatHistoryEmptyEl);
          return;
        }

        researchChatHistoryListEl.innerHTML = conversations.map(c => `
          <button type="button" class="research-chat-history-item ${c.id === currentResearchChatId ? 'active' : ''}" data-conv-id="${c.id}">
            <span class="research-chat-history-item-title">${escapeHtml(c.title)}</span>
            <span class="research-chat-history-item-delete" data-delete-conv-id="${c.id}" title="Hapus percakapan"><i class="fa-regular fa-trash-can"></i></span>
          </button>
        `).join('');
      } catch (err) {
        console.error('Gagal memuat riwayat percakapan:', err);
      }
    }

    async function loadResearchChatConversation(id) {
      try {
        const response = await fetch(`/api/research-chat/conversations/${encodeURIComponent(id)}`);
        const data = await response.json();
        if (!data.ok) {
          alert(data.message || 'Gagal memuat percakapan.');
          return;
        }
        currentResearchChatId = id;
        researchChatMessages = data.conversation.messages || [];
        renderResearchChatMessages();
        renderResearchChatHistoryList();
      } catch (err) {
        console.error('Gagal memuat percakapan:', err);
        alert('Terjadi kesalahan koneksi saat memuat percakapan.');
      }
    }

    if (researchChatHistoryListEl) {
      researchChatHistoryListEl.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.research-chat-history-item-delete');
        if (deleteBtn) {
          e.stopPropagation();
          const id = deleteBtn.getAttribute('data-delete-conv-id');
          if (!confirm('Hapus percakapan ini?')) return;
          fetch(`/api/research-chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
            .then(r => r.json())
            .then(data => {
              if (!data.ok) return;
              if (id === currentResearchChatId) {
                currentResearchChatId = null;
                researchChatMessages = [];
                renderResearchChatMessages();
              }
              renderResearchChatHistoryList();
            })
            .catch(() => alert('Gagal menghapus percakapan.'));
          return;
        }

        const item = e.target.closest('.research-chat-history-item');
        if (item) {
          const id = item.getAttribute('data-conv-id');
          if (id !== currentResearchChatId) loadResearchChatConversation(id);
        }
      });
    }

    function renderResearchChatMessages() {
      if (!researchChatMessagesEl) return;
      if (researchChatMessages.length === 0) {
        researchChatMessagesEl.innerHTML = '';
        if (researchChatEmptyState) researchChatMessagesEl.appendChild(researchChatEmptyState);
        return;
      }
      researchChatMessagesEl.innerHTML = researchChatMessages.map((m, idx) => {
        if (m.role === 'user') {
          return `<div class="research-chat-bubble user">${escapeHtml(m.content)}</div>`;
        }
        let bodyHtml = '';
        if (m.reasoning) {
          bodyHtml += `
            <details class="chat-thinking-block">
              <summary class="chat-thinking-summary">
                <i class="fa-solid fa-brain"></i> Pemikiran JurnalHub Intelligence (Selesai)
              </summary>
              <div class="chat-thinking-content">${escapeHtml(m.reasoning)}</div>
            </details>
          `;
        }
        bodyHtml += `<div class="chat-main-content">${renderMarkdownSafe(m.content)}</div>`;
        return `
          <div class="research-chat-assistant-block">
            <div class="research-chat-bubble assistant">${bodyHtml}</div>
            <div class="research-chat-msg-actions">
              <button class="research-chat-copy-btn" type="button" data-msg-index="${idx}" title="Salin jawaban">
                <i class="fa-regular fa-copy"></i> <span>Salin</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
      researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;
    }

    if (researchChatMessagesEl) {
      researchChatMessagesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.research-chat-copy-btn');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-msg-index'), 10);
        const message = researchChatMessages[idx];
        if (!message) return;
        navigator.clipboard.writeText(message.content).then(() => {
          const label = btn.querySelector('span');
          const icon = btn.querySelector('i');
          const originalLabel = label.textContent;
          const originalIconClass = icon.className;
          icon.className = 'fa-solid fa-check';
          label.textContent = 'Tersalin!';
          setTimeout(() => {
            icon.className = originalIconClass;
            label.textContent = originalLabel;
          }, 1500);
        }).catch(() => {
          alert('Gagal menyalin teks.');
        });
      });
    }

    async function sendResearchChatMessage() {
      if (!researchChatInput) return;
      const text = researchChatInput.value.trim();
      if (!text || researchChatSendBtn.disabled) return;

      researchChatMessages.push({ role: 'user', content: text });
      researchChatInput.value = '';
      researchChatInput.style.height = 'auto';
      renderResearchChatMessages();

      // Bubble loading sementara menunggu token pertama dari stream
      const loadingBubble = document.createElement('div');
      loadingBubble.className = 'research-chat-bubble loading';
      loadingBubble.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      researchChatMessagesEl.appendChild(loadingBubble);
      researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;

      researchChatSendBtn.disabled = true;
      const originalBtnHtml = researchChatSendBtn.innerHTML;
      researchChatSendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

      // conversationId dibuat sekali di sini kalau ini pesan pertama percakapan baru,
      // supaya server bisa membuat entri riwayat baru begitu balasan pertama selesai.
      if (!currentResearchChatId) {
        currentResearchChatId = (crypto.randomUUID ? crypto.randomUUID() : `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      }

      try {
        const response = await fetch('/api/research-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            messages: researchChatMessages, 
            conversationId: currentResearchChatId,
            modelType: selectedResearchModel,
            thinkingType: selectedResearchMode
          })
        });

        // Server menolak sebelum sempat streaming (kuota habis, belum dikonfigurasi,
        // dsb) - responsnya JSON biasa, bukan stream teks.
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          loadingBubble.remove();
          researchChatMessages.pop();
          renderResearchChatMessages();
          alert(data.message || 'Gagal menghubungi JurnalHub Intelligence.');
          researchChatInput.value = text;
          return;
        }

        if (!response.body || typeof response.body.getReader !== 'function') {
          throw new Error('Browser tidak mendukung streaming respons.');
        }

        loadingBubble.remove();
        const assistantBubbleEl = document.createElement('div');
        assistantBubbleEl.className = 'research-chat-bubble assistant';
        researchChatMessagesEl.appendChild(assistantBubbleEl);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let thinkingText = '';
        let contentText = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const data = JSON.parse(trimmed);
              if (data.type === 'thinking') {
                thinkingText += data.content;
              } else if (data.type === 'content') {
                contentText += data.content;
              }
            } catch (e) {
              // Abaikan line parsial yang corrupt
            }
          }

          let html = '';
          if (thinkingText) {
            html += `
              <details class="chat-thinking-block">
                <summary class="chat-thinking-summary">
                  <i class="fa-solid fa-brain fa-spin-pulse"></i> Pemikiran JurnalHub Intelligence...
                </summary>
                <div class="chat-thinking-content">${escapeHtml(thinkingText)}</div>
              </details>
            `;
          }
          if (contentText) {
            html += `<div class="chat-main-content">${renderMarkdownSafe(contentText)}</div>`;
          }

          assistantBubbleEl.innerHTML = html || '...';
          researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;
        }

        if (!contentText && !thinkingText) {
          assistantBubbleEl.remove();
          researchChatMessages.pop();
          renderResearchChatMessages();
          alert('JurnalHub Intelligence tidak memberikan jawaban. Coba lagi.');
          researchChatInput.value = text;
          return;
        }

        const newMsg = { role: 'assistant', content: contentText };
        if (thinkingText) {
          newMsg.reasoning = thinkingText;
        }
        researchChatMessages.push(newMsg);
        // Re-render penuh supaya bubble sementara diganti struktur final (dengan tombol salin)
        renderResearchChatMessages();
        // Percakapan baru saja disimpan/diperbarui di server - refresh daftar riwayat
        renderResearchChatHistoryList();

        // Refresh kuota tampilan setelah 1 pesan terpakai (khusus Premium)
        fetch('/api/me').then(r => r.json()).then(meData => {
          if (meData.loggedIn && meData.user) {
            currentUser = meData;
            updateResearchChatAccess(meData.user);
          }
        }).catch(() => {});
      } catch (error) {
        loadingBubble.remove();
        researchChatMessages.pop();
        renderResearchChatMessages();
        console.error('[Research Chat] Error:', error);
        alert('Terjadi kesalahan koneksi saat menghubungi JurnalHub Intelligence.');
        researchChatInput.value = text;
      } finally {
        researchChatSendBtn.disabled = false;
        researchChatSendBtn.innerHTML = originalBtnHtml;
      }
    }

    if (researchChatSendBtn) {
      researchChatSendBtn.addEventListener('click', sendResearchChatMessage);
    }
    if (researchChatInput) {
      researchChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendResearchChatMessage();
        }
      });
      researchChatInput.addEventListener('input', () => {
        researchChatInput.style.height = 'auto';
        researchChatInput.style.height = Math.min(researchChatInput.scrollHeight, 150) + 'px';
      });
    }
    if (researchChatClearBtn) {
      researchChatClearBtn.addEventListener('click', () => {
        researchChatMessages = [];
        currentResearchChatId = null;
        renderResearchChatMessages();
        renderResearchChatHistoryList();
      });
    }

    // Setup model and mode selection event listeners
    const pillModelLite = document.getElementById('pillModelLite');
    const pillModelPro = document.getElementById('pillModelPro');
    const pillModeBasic = document.getElementById('pillModeBasic');
    const pillModeThinking = document.getElementById('pillModeThinking');

    if (pillModelLite && pillModelPro) {
      pillModelLite.addEventListener('click', () => {
        selectedResearchModel = 'lite';
        pillModelLite.classList.add('active');
        pillModelPro.classList.remove('active');
      });
      pillModelPro.addEventListener('click', () => {
        selectedResearchModel = 'pro';
        pillModelPro.classList.add('active');
        pillModelLite.classList.remove('active');
      });
    }

    if (pillModeBasic && pillModeThinking) {
      pillModeBasic.addEventListener('click', () => {
        selectedResearchMode = 'basic';
        pillModeBasic.classList.add('active');
        pillModeThinking.classList.remove('active');
      });
      pillModeThinking.addEventListener('click', () => {
        selectedResearchMode = 'thinking';
        pillModeThinking.classList.add('active');
        pillModeBasic.classList.remove('active');
      });
    }

    // Muat daftar riwayat percakapan begitu tab ini siap (kalau user Premium/Ultimate)
    if (currentUser.loggedIn && currentUser.user && (currentUser.user.type === 'premium' || currentUser.user.type === 'ultimate')) {
      renderResearchChatHistoryList();
    }

    // Top-up Modal Event Handlers
    const openTopupModalBtn = document.getElementById('openTopupModalBtn');
    const closeTopupModalBtn = document.getElementById('closeTopupModalBtn');
    const topupModal = document.getElementById('topupModal');

    if (openTopupModalBtn && topupModal) {
      openTopupModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        topupModal.classList.add('active');
      });
    }

    if (closeTopupModalBtn && topupModal) {
      closeTopupModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        topupModal.classList.remove('active');
      });
    }

    if (topupModal) {
      topupModal.addEventListener('click', (e) => {
        if (e.target === topupModal) {
          topupModal.classList.remove('active');
        }
      });
    }

    // Top-up Purchase Action Trigger
    document.addEventListener('click', async (e) => {
      const selectBtn = e.target.closest('.topup-btn-select');
      if (selectBtn) {
        e.preventDefault();
        const packageId = selectBtn.getAttribute('data-package');
        if (!packageId) return;

        const originalBtnHtml = selectBtn.innerHTML;
        selectBtn.disabled = true;
        selectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memproses...';

        try {
          const response = await fetch('/api/payment/topup/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageId })
          });

          const data = await response.json();

          if (!response.ok) {
            alert(data.message || 'Gagal membuat transaksi top-up.');
            return;
          }

          if (data.redirectUrl) {
            window.location.href = data.redirectUrl;
          } else {
            alert('Gagal mendapatkan tautan pembayaran.');
          }
        } catch (error) {
          console.error('[Top-up Purchase] Error:', error);
          alert('Terjadi kesalahan koneksi saat memproses pembelian.');
        } finally {
          selectBtn.disabled = false;
          selectBtn.innerHTML = originalBtnHtml;
        }
      }
    });

    // --- RIWAYAT AI (HISTORY) TAB ---
    let allHistory = [];
    let activeHistoryFilter = 'all';

    const historyListContainer = document.getElementById('historyListContainer');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const historyFilterButtons = document.querySelectorAll('#historyFilterButtons .filter-badge');

    const historyDetailModal = document.getElementById('historyDetailModal');
    const closeHistoryDetailModalBtn = document.getElementById('closeHistoryDetailModalBtn');
    const historyDetailTitle = document.getElementById('historyDetailTitle');
    const historyDetailMeta = document.getElementById('historyDetailMeta');
    const historyDetailBody = document.getElementById('historyDetailBody');
    const historyDetailIconWrapper = document.getElementById('historyDetailIconWrapper');

    // Handle closing detail modal
    if (closeHistoryDetailModalBtn && historyDetailModal) {
      closeHistoryDetailModalBtn.addEventListener('click', () => {
        historyDetailModal.classList.remove('active');
      });
    }

    if (historyDetailModal) {
      historyDetailModal.addEventListener('click', (e) => {
        if (e.target === historyDetailModal) {
          historyDetailModal.classList.remove('active');
        }
      });
    }

    // Function to render the history tab
    async function renderHistoryTab() {
      if (!historyListContainer) return;

      const t = TRANSLATIONS[currentLanguage] || TRANSLATIONS.id;

      historyListContainer.innerHTML = `
        <div style="text-align: center; padding: 4rem 2rem; background: rgba(255,255,255,0.6); border: 1px dashed var(--border-light-hover); border-radius: 16px;">
          <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--brand-blue); margin-bottom: 1rem;"></i>
          <p style="color: var(--text-muted); font-size: 0.9rem;">${t.hist_loading}</p>
        </div>
      `;

      try {
        const response = await fetch('/api/history');
        const data = await response.json();

        if (data.ok) {
          allHistory = data.history || [];
          displayHistoryList();
        } else {
          historyListContainer.innerHTML = `
            <div style="text-align: center; padding: 4rem 2rem; background: #fff; border: 1px solid rgba(239, 68, 68, 0.1); border-radius: 16px;">
              <i class="fa-solid fa-circle-xmark" style="font-size: 2.5rem; color: #ef4444; margin-bottom: 1rem;"></i>
              <p style="color: #ef4444; font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;">${t.hist_load_error_title}</p>
              <p style="color: var(--text-muted); font-size: 0.85rem;">${data.message || t.hist_load_error_generic}</p>
            </div>
          `;
        }
      } catch (err) {
        console.error('Fetch history error:', err);
        historyListContainer.innerHTML = `
          <div style="text-align: center; padding: 4rem 2rem; background: #fff; border: 1px solid rgba(239, 68, 68, 0.1); border-radius: 16px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 2.5rem; color: #ef4444; margin-bottom: 1rem;"></i>
            <p style="color: #ef4444; font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;">${t.hist_conn_error_title}</p>
            <p style="color: var(--text-muted); font-size: 0.85rem;">${t.hist_conn_error_desc}</p>
          </div>
        `;
      }
    }
    window.renderHistoryTab = renderHistoryTab;
    window.showHistoryDetailsById = showHistoryDetails;

    // Display history items
    function displayHistoryList() {
      if (!historyListContainer) return;

      const filtered = activeHistoryFilter === 'all' 
        ? allHistory 
        : allHistory.filter(item => item.type === activeHistoryFilter);

      const t = TRANSLATIONS[currentLanguage] || TRANSLATIONS.id;

      if (filtered.length === 0) {
        historyListContainer.innerHTML = `
          <div style="text-align: center; padding: 5rem 2rem; background: #ffffff; border: 1px solid var(--border-light-hover); border-radius: 16px; box-shadow: 0 4px 20px rgba(8,34,64,0.02);">
            <div style="width: 64px; height: 64px; border-radius: 50%; background: #f8fafc; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem auto; color: var(--text-muted); font-size: 1.75rem;">
              <i class="fa-regular fa-clock"></i>
            </div>
            <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.5rem;">${t.history_empty}</h4>
            <p style="color: var(--text-muted); font-size: 0.88rem; max-width: 400px; margin: 0 auto;">${t.history_empty_desc}</p>
          </div>
        `;
        return;
      }

      historyListContainer.innerHTML = '';
      filtered.forEach(item => {
        const dateStr = new Date(item.timestamp).toLocaleString(currentLanguage === 'en' ? 'en-US' : 'id-ID', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        let typeLabel = t.hist_type_generic;
        let typeIcon = 'fa-solid fa-robot';
        let iconBg = 'rgba(7, 135, 220, 0.08)';
        let iconColor = 'var(--brand-blue)';
        let titleText = t.hist_fallback_generic;
        let descText = '';

        if (item.type === 'match') {
          typeLabel = t.hist_type_match;
          typeIcon = 'fa-solid fa-magnifying-glass-chart';
          iconBg = 'rgba(7, 135, 220, 0.08)';
          iconColor = 'var(--brand-blue)';
          titleText = item.input.title || t.hist_fallback_match;
          descText = `${t.hist_desc_keywords}: ${item.input.keywords || '-'} | ${t.hist_desc_recommendations}: ${item.output.recommendations ? item.output.recommendations.length : 0} ${t.hist_desc_journals}`;
        } else if (item.type === 'draft') {
          typeLabel = t.hist_type_draft;
          typeIcon = 'fa-regular fa-file-lines';
          iconBg = 'rgba(16, 185, 129, 0.08)';
          iconColor = '#10b981';
          titleText = item.input.title || t.hist_fallback_draft;
          descText = `${t.hist_desc_abstract}: ${item.input.abstract ? item.input.abstract.slice(0, 100) + '...' : '-'}`;
        } else if (item.type === 'lit-review') {
          typeLabel = t.hist_type_litreview;
          typeIcon = 'fa-solid fa-book-open-reader';
          iconBg = 'rgba(139, 92, 246, 0.08)';
          iconColor = '#8b5cf6';
          titleText = item.input.title || t.hist_fallback_litreview;
          descText = `${t.hist_desc_references}: ${item.output.citations ? item.output.citations.length : 0} ${t.hist_desc_papers}`;
        } else if (item.type === 'humanizer') {
          typeLabel = t.hist_type_humanizer;
          typeIcon = 'fa-solid fa-wand-magic-sparkles';
          iconBg = 'rgba(245, 158, 11, 0.08)';
          iconColor = '#f59e0b';
          titleText = item.input.text ? item.input.text.slice(0, 80) + '...' : t.hist_fallback_humanizer;
          descText = `${t.hist_desc_mode}: ${item.input.mode === 'academic' ? t.hist_desc_mode_academic : t.hist_desc_mode_standard} | ${t.hist_desc_originality}: ${item.output.originalityScore}% | ${t.hist_desc_cost}: ${item.output.actualCost} ${t.hist_desc_words}`;
        }

        const card = document.createElement('div');
        card.className = 'filter-box-card';
        card.style.padding = '1.25rem 1.5rem';
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.justifyContent = 'space-between';
        card.style.gap = '1.5rem';
        card.style.flexWrap = 'wrap';

        card.innerHTML = `
          <div style="display: flex; align-items: center; gap: 1.25rem; flex: 1; min-width: 280px; text-align: left;">
            <div style="width: 48px; height: 48px; border-radius: 12px; background: ${iconBg}; color: ${iconColor}; display: flex; align-items: center; justify-content: center; font-size: 1.25rem; flex-shrink: 0;">
              <i class="${typeIcon}"></i>
            </div>
            <div style="overflow: hidden; flex: 1;">
              <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem; flex-wrap: wrap;">
                <span style="font-size: 0.72rem; font-weight: 700; color: ${iconColor}; text-transform: uppercase; background: ${iconBg}; padding: 0.15rem 0.5rem; border-radius: 4px; display: inline-block;">${typeLabel}</span>
                <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 500;"><i class="fa-regular fa-clock" style="margin-right: 0.15rem;"></i> ${dateStr}</span>
              </div>
              <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1rem; color: var(--text-main); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(titleText)}">${escapeHtml(titleText)}</h4>
              <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0.15rem 0 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(descText)}</p>
            </div>
          </div>
          
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0;">
            <button class="upgrade-btn show-history-detail-btn" data-id="${item.id}" style="width: auto; padding: 0.5rem 1.25rem; font-size: 0.8rem; background: var(--brand-blue); color: #ffffff;" type="button">
              <i class="fa-regular fa-eye"></i> ${t.hist_btn_detail}
            </button>
            <button class="upgrade-btn delete-history-item-btn" data-id="${item.id}" style="width: auto; padding: 0.5rem; font-size: 0.8rem; background: transparent; border: 1px solid rgba(239, 68, 68, 0.2); color: #ef4444;" type="button" title="${t.hist_btn_delete_title}">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        `;

        historyListContainer.appendChild(card);
      });

      // Bind button events dynamically
      const detailBtns = historyListContainer.querySelectorAll('.show-history-detail-btn');
      detailBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const histId = btn.getAttribute('data-id');
          showHistoryDetails(histId);
        });
      });

      const deleteBtns = historyListContainer.querySelectorAll('.delete-history-item-btn');
      deleteBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
          const histId = btn.getAttribute('data-id');
          if (confirm('Apakah Anda yakin ingin menghapus item riwayat ini?')) {
            try {
              const res = await fetch(`/api/history/${histId}`, { method: 'DELETE' });
              const result = await res.json();
              if (result.ok) {
                renderHistoryTab();
              } else {
                alert(result.message);
              }
            } catch (err) {
              alert('Gagal menghapus item riwayat.');
            }
          }
        });
      });
    }

    // Filter Buttons click handler
    historyFilterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        historyFilterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeHistoryFilter = btn.getAttribute('data-type');
        displayHistoryList();
      });
    });

    // Clear All History click handler
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', async () => {
        if (confirm('Apakah Anda yakin ingin menghapus SELURUH riwayat penggunaan AI Anda? Tindakan ini tidak dapat dibatalkan.')) {
          try {
            const res = await fetch('/api/history', { method: 'DELETE' });
            const result = await res.json();
            if (result.ok) {
              renderHistoryTab();
            } else {
              alert(result.message);
            }
          } catch (err) {
            alert('Gagal membersihkan seluruh riwayat.');
          }
        }
      });
    }

    // Detail Populator
    function showHistoryDetails(id) {
      const item = allHistory.find(h => h.id === id);
      if (!item || !historyDetailModal) return;

      let typeIcon = 'fa-solid fa-robot';
      let iconColor = 'var(--brand-blue)';
      let typeLabel = 'AI Tool';
      let iconBg = 'rgba(7, 135, 220, 0.1)';

      if (item.type === 'match') {
        typeIcon = 'fa-solid fa-magnifying-glass-chart';
        iconColor = 'var(--brand-blue)';
        iconBg = 'rgba(7, 135, 220, 0.1)';
        typeLabel = 'AI Journal Matcher';
      } else if (item.type === 'draft') {
        typeIcon = 'fa-regular fa-file-lines';
        iconColor = '#10b981';
        iconBg = 'rgba(16, 185, 129, 0.1)';
        typeLabel = 'AI Outline Generator';
      } else if (item.type === 'lit-review') {
        typeIcon = 'fa-solid fa-book-open-reader';
        iconColor = '#8b5cf6';
        iconBg = 'rgba(139, 92, 246, 0.1)';
        typeLabel = 'AI Literature Review';
      } else if (item.type === 'humanizer') {
        typeIcon = 'fa-solid fa-wand-magic-sparkles';
        iconColor = '#f59e0b';
        iconBg = 'rgba(245, 158, 11, 0.1)';
        typeLabel = 'JurnalHub Humanizer Engine';
      }

      historyDetailIconWrapper.className = '';
      historyDetailIconWrapper.innerHTML = `<i class="${typeIcon}"></i>`;
      historyDetailIconWrapper.style.background = iconBg;
      historyDetailIconWrapper.style.color = iconColor;

      historyDetailTitle.textContent = typeLabel;
      historyDetailMeta.innerHTML = `<i class="fa-regular fa-clock"></i> ${new Date(item.timestamp).toLocaleString('id-ID')}`;

      // Populate body based on type
      historyDetailBody.innerHTML = '';

      if (item.type === 'match') {
        historyDetailBody.innerHTML = `
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">INPUT METADATA</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem;">
              <div><strong>Judul:</strong> ${escapeHtml(item.input.title) || '-'}</div>
              <div><strong>Kata Kunci:</strong> ${escapeHtml(item.input.keywords) || '-'}</div>
              <div><strong>Abstrak:</strong> ${escapeHtml(item.input.abstract) || '-'}</div>
            </div>
          </div>
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.75rem;">REKOMENDASI SCOPUS / SINTA</h5>
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
              ${item.output.recommendations.map(rec => {
                const matched = JOURNAL_DATABASE.find(j => j.id === rec.id) || { title: `Jurnal ID: ${rec.id}`, sinta: '', scopus: '' };
                const dbBadge = matched.scopus ? `<span class="journal-tag sinta-tag scopus-tag">Scopus ${matched.scopus}</span>` : `<span class="journal-tag sinta-tag">Sinta ${matched.sinta}</span>`;
                return `
                  <div style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 0.85rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: #ffffff;">
                    <div style="text-align: left;">
                      <h6 style="font-weight: 700; font-size: 0.88rem; color: var(--text-main); margin: 0 0 0.25rem 0;">${matched.title}</h6>
                      <div style="display: flex; align-items: center; gap: 0.5rem;">
                        ${dbBadge}
                        <span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600;">Match Score: <strong style="color: var(--brand-blue);">${rec.matchScore}%</strong></span>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      } else if (item.type === 'draft') {
        const sections = item.output.draft || {};
        historyDetailBody.innerHTML = `
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">INPUT METADATA</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem;">
              <div><strong>Judul:</strong> ${escapeHtml(item.input.title) || '-'}</div>
              <div><strong>Abstrak:</strong> ${escapeHtml(item.input.abstract) || '-'}</div>
            </div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">PANDUAN OUTLINE DRAFT</h5>
              <button id="copyHistoryDraftBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #10b981; color: white;" type="button">
                <i class="fa-regular fa-copy"></i> Salin Semua Draf
              </button>
            </div>
            <div id="historyDraftTextWrapper" style="display: flex; flex-direction: column; gap: 1rem; max-height: 400px; overflow-y: auto; padding-right: 0.5rem;">
              ${Object.keys(sections).map(key => {
                const label = key.replace('_', ' ').toUpperCase();
                const points = sections[key] || [];
                return `
                  <div style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 0.85rem 1rem; background: #ffffff;">
                    <strong style="color: #10b981; font-size: 0.78rem; font-weight: 800; display: block; margin-bottom: 0.5rem;">${label}</strong>
                    <ul style="margin: 0; padding-left: 1.2rem; font-size: 0.82rem; color: var(--text-muted); display: flex; flex-direction: column; gap: 0.35rem; text-align: left;">
                      ${points.map(pt => `<li>${escapeHtml(pt)}</li>`).join('')}
                    </ul>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;

        setTimeout(() => {
          const copyBtn = document.getElementById('copyHistoryDraftBtn');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => {
              let copyText = `OUTLINE DRAF PANDUAN PENULISAN\n\n`;
              Object.keys(sections).forEach(key => {
                copyText += `${key.toUpperCase().replace('_', ' ')}:\n`;
                (sections[key] || []).forEach((pt, i) => {
                  copyText += `${i + 1}. ${pt}\n`;
                });
                copyText += `\n`;
              });
              navigator.clipboard.writeText(copyText).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
                setTimeout(() => copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Salin Semua Draf', 2000);
              });
            });
          }
        }, 100);

      } else if (item.type === 'lit-review') {
        historyDetailBody.innerHTML = `
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">INPUT METADATA</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem;">
              <div><strong>Topik/Judul Penelitian:</strong> ${escapeHtml(item.input.title) || '-'}</div>
            </div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">HASIL LITERATURE REVIEW</h5>
              <button id="copyHistoryLitReviewBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #8b5cf6; color: white;" type="button">
                <i class="fa-regular fa-copy"></i> Salin Review
              </button>
            </div>
            <div id="historyLitReviewTextWrapper" style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1.25rem; font-size: 0.85rem; background: #ffffff; line-height: 1.6; max-height: 300px; overflow-y: auto; color: var(--text-main);">
              ${item.output.review}
            </div>
          </div>
        `;

        setTimeout(() => {
          const copyBtn = document.getElementById('copyHistoryLitReviewBtn');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => {
              const reviewText = document.getElementById('historyLitReviewTextWrapper').innerText;
              navigator.clipboard.writeText(reviewText).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
                setTimeout(() => copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Salin Review', 2000);
              });
            });
          }
        }, 100);

      } else if (item.type === 'humanizer') {
        historyDetailBody.innerHTML = `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; font-size: 0.82rem; margin-bottom: 0.5rem;">
            <div style="background: rgba(245, 158, 11, 0.04); border: 1px solid rgba(245, 158, 11, 0.15); border-radius: 8px; padding: 0.75rem 1rem;">
              <strong>Mode Humanisasi:</strong> ${item.input.mode === 'academic' ? 'Akademik' : 'Standar'}
            </div>
            <div style="background: rgba(16, 185, 129, 0.04); border: 1px solid rgba(16, 185, 129, 0.15); border-radius: 8px; padding: 0.75rem 1rem;">
              <strong>Nilai Keaslian:</strong> <strong style="color: #10b981; font-size: 0.95rem;">${item.output.originalityScore}% Original</strong>
            </div>
          </div>
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">TEKS ASLI (INPUT)</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; max-height: 150px; overflow-y: auto; color: var(--text-muted); line-height: 1.5; white-space: pre-wrap;">${escapeHtml(item.input.text)}</div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">TEKS HUMANISASI (OUTPUT)</h5>
              <button id="copyHistoryHumanizerBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #f59e0b; color: white;" type="button">
                <i class="fa-regular fa-copy"></i> Salin Hasil
              </button>
            </div>
            <div id="historyHumanizerTextWrapper" style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1.25rem; font-size: 0.85rem; background: #ffffff; line-height: 1.6; max-height: 250px; overflow-y: auto; color: var(--text-main); white-space: pre-wrap;">${escapeHtml(item.output.humanizedText)}</div>
          </div>
        `;

        setTimeout(() => {
          const copyBtn = document.getElementById('copyHistoryHumanizerBtn');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => {
              const outputText = document.getElementById('historyHumanizerTextWrapper').innerText;
              navigator.clipboard.writeText(outputText).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
                setTimeout(() => copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Salin Hasil', 2000);
              });
            });
          }
        }, 100);
      }

      historyDetailModal.classList.add('active');
    }

    let currentLanguage = localStorage.getItem('jurnalhub_lang') || 'id';

    function applyLanguage(lang) {
      currentLanguage = lang;
      window.currentLanguage = lang;
      localStorage.setItem('jurnalhub_lang', lang);

      // 1. Language switcher buttons styling
      const btnId = document.getElementById('langBtnId');
      const btnEn = document.getElementById('langBtnEn');
      if (btnId && btnEn) {
        if (lang === 'id') {
          btnId.style.background = 'var(--brand-navy)';
          btnId.style.color = '#ffffff';
          btnId.classList.add('active');
          btnEn.style.background = 'transparent';
          btnEn.style.color = 'var(--text-muted)';
          btnEn.classList.remove('active');
        } else {
          btnEn.style.background = 'var(--brand-navy)';
          btnEn.style.color = '#ffffff';
          btnEn.classList.add('active');
          btnId.style.background = 'transparent';
          btnId.style.color = 'var(--text-muted)';
          btnId.classList.remove('active');
        }
      }

      // Translate Home Banner Statistics Row Card labels
      const statLabels = document.querySelectorAll('.stat-card .stat-label');
      if (statLabels.length >= 3) {
        statLabels[0].textContent = lang === 'id' ? 'Jurnal Scopus' : 'Scopus Journals';
        statLabels[1].textContent = lang === 'id' ? 'Jurnal Sinta' : 'Sinta Journals';
        statLabels[2].textContent = lang === 'id' ? 'Tanpa Biaya (No APC)' : 'Free of Charge (No APC)';
      }

      // Translate Search Bar Placeholder
      const searchInputEl = document.getElementById('searchInput');
      if (searchInputEl) {
        searchInputEl.placeholder = lang === 'id' ? 'Cari jurnal, penerbit, keyword...' : 'Search journal, publisher, keyword...';
      }

      // Translate Dropdown Filter Headers
      const filterLabelItems = document.querySelectorAll('.filter-dropdown-item label');
      if (filterLabelItems.length >= 3) {
        filterLabelItems[0].textContent = lang === 'id' ? 'KATEGORI' : 'CATEGORY';
        filterLabelItems[1].textContent = lang === 'id' ? 'RUMPUN KEILMUAN' : 'SUBJECT AREA';
        filterLabelItems[2].textContent = lang === 'id' ? 'TINGKATAN / RANK' : 'RANKING';
      }

      // Translate Category Selector Dropdown Options
      const typeOptions = document.querySelectorAll('#filterType option');
      if (typeOptions.length >= 3) {
        typeOptions[0].textContent = lang === 'id' ? 'Semua Jurnal' : 'All Journals';
        typeOptions[1].textContent = lang === 'id' ? 'Scopus Only' : 'Scopus Only';
        typeOptions[2].textContent = lang === 'id' ? 'Sinta Only' : 'Sinta Only';
      }

      // Translate Subject Dropdown Options
      const subjectOptions = document.querySelectorAll('#filterSubject option');
      if (subjectOptions.length >= 5) {
        subjectOptions[0].textContent = lang === 'id' ? 'Semua Rumpun' : 'All Subjects';
        subjectOptions[1].textContent = lang === 'id' ? 'Sains & Teknologi' : 'Science & Technology';
        subjectOptions[2].textContent = lang === 'id' ? 'Sosial & Humaniora' : 'Social Sciences & Humanities';
        subjectOptions[3].textContent = lang === 'id' ? 'Kesehatan' : 'Health & Medical';
        subjectOptions[4].textContent = lang === 'id' ? 'Ekonomi & Bisnis' : 'Economics & Business';
      }

      // Translate Rank Dropdown Option (first only)
      const rankOptions = document.querySelectorAll('#filterRank option');
      if (rankOptions.length > 0) {
        rankOptions[0].textContent = lang === 'id' ? 'Semua Tingkat' : 'All Ranks';
      }

      // Translate Filter Checkbox spans
      const checkFreeOnlySpan = document.querySelector('#checkFreeOnly')?.nextElementSibling?.nextElementSibling;
      const checkFastTrackSpan = document.querySelector('#checkFastTrackOnly')?.nextElementSibling?.nextElementSibling;
      if (checkFreeOnlySpan) {
        checkFreeOnlySpan.textContent = lang === 'id' ? 'Hanya Gratis (No APC)' : 'Free Only (No APC)';
      }
      if (checkFastTrackSpan) {
        checkFastTrackSpan.textContent = lang === 'id' ? 'Fast Track (Berbayar)' : 'Fast Track (Paid)';
      }

      // Translate Reset Filter button
      const resetFiltersEl = document.getElementById('resetFilters');
      if (resetFiltersEl) {
        resetFiltersEl.innerHTML = lang === 'id' ? '<i class="fa-solid fa-rotate-left"></i> Reset Filter' : '<i class="fa-solid fa-rotate-left"></i> Reset Filters';
      }

      // 2. Translate Sidebar Links
      const sidebarLinks = document.querySelectorAll('.sidebar-link');
      sidebarLinks.forEach(link => {
        const tab = link.getAttribute('data-tab');
        const span = link.querySelector('span');
        if (span && TRANSLATIONS[lang][tab]) {
          span.textContent = TRANSLATIONS[lang][tab];
        }
      });

      // 3. Translate Sidebar Upgrade Card
      const upgradeCardTitle = document.querySelector('#sidebarUpgradeCard h4');
      const upgradeCardDesc = document.querySelector('#sidebarUpgradeCard p');
      const upgradeCardBtn = document.querySelector('#sidebarUpgradeCard button');
      if (upgradeCardTitle) upgradeCardTitle.textContent = TRANSLATIONS[lang].upgrade_pro;
      if (upgradeCardDesc) upgradeCardDesc.textContent = TRANSLATIONS[lang].upgrade_desc;
      if (upgradeCardBtn) upgradeCardBtn.textContent = TRANSLATIONS[lang].upgrade_btn;

      // 4. Translate greeting
      if (currentUser?.user) {
        updateGreeting(currentUser.user);
      }

      // 5. Translate Matcher Tab
      // Catatan: scoped ke .match-header (bukan sekadar tab-wide "h3"/"p") karena
      // overlay lock PRO di tiap tab ini juga punya h3/p sendiri yang muncul lebih
      // dulu di urutan DOM - selector generik akan salah menimpa teks lock itu.
      const matcherHeader = document.querySelector('#tabContentMatchScore .match-header h3');
      const matcherDesc = document.querySelector('#tabContentMatchScore .match-header p');
      const runMatchBtn = document.getElementById('runMatchBtn');
      if (matcherHeader) matcherHeader.textContent = TRANSLATIONS[lang].matcher_title;
      if (matcherDesc) matcherDesc.textContent = TRANSLATIONS[lang].matcher_desc;
      if (runMatchBtn) {
        runMatchBtn.innerHTML = runMatchBtn.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].matcher_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].matcher_btn_run}`;
      }

      // 6. Translate Drafting Tab
      const draftingHeader = document.querySelector('#tabContentDraftingCompanion .match-header h3');
      const draftingDesc = document.querySelector('#tabContentDraftingCompanion .match-header p');
      const runDraftGenerator = document.getElementById('runDraftGenerator');
      if (draftingHeader) draftingHeader.textContent = TRANSLATIONS[lang].drafting_title;
      if (draftingDesc) draftingDesc.textContent = TRANSLATIONS[lang].drafting_desc;
      if (runDraftGenerator) {
        runDraftGenerator.innerHTML = runDraftGenerator.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].drafting_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].drafting_btn_run}`;
      }

      // 7. Translate Lit Review Tab
      const litHeader = document.querySelector('#tabContentLitReview .match-header h3');
      const litDesc = document.querySelector('#tabContentLitReview .match-header p');
      const runLitReviewBtn = document.getElementById('runLitReviewBtn');
      if (litHeader) litHeader.textContent = TRANSLATIONS[lang].lit_title;
      if (litDesc) litDesc.textContent = TRANSLATIONS[lang].lit_desc;
      if (runLitReviewBtn) {
        runLitReviewBtn.innerHTML = runLitReviewBtn.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].lit_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].lit_btn_run}`;
      }

      // 8. Translate Humanizer Tab
      const humanizerHeader = document.querySelector('#tabContentHumanizer .match-header h3');
      const humanizerDesc = document.querySelector('#tabContentHumanizer .match-header p');
      const runHumanizerBtn = document.getElementById('runHumanizerBtn');
      const humanizerQuotaBadge = document.getElementById('humanizerQuotaBadge');
      if (humanizerHeader) humanizerHeader.textContent = TRANSLATIONS[lang].humanizer_title;
      if (humanizerDesc) humanizerDesc.textContent = TRANSLATIONS[lang].humanizer_desc;
      if (runHumanizerBtn) {
        runHumanizerBtn.innerHTML = runHumanizerBtn.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].humanizer_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].humanizer_btn_run}`;
      }
      if (humanizerQuotaBadge && humanizerQuotaBadge.nextElementSibling) {
        humanizerQuotaBadge.nextElementSibling.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${TRANSLATIONS[lang].humanizer_lbl_quota_desc}`;
      }

      // 9. Translate Input Labels (Title / Keywords / Abstracts)
      const labels = document.querySelectorAll('label');
      labels.forEach(lbl => {
        const text = lbl.textContent.toUpperCase();
        if (text.includes('JUDUL ARTIKEL') || text.includes('ARTICLE TITLE')) {
          lbl.textContent = TRANSLATIONS[lang].matcher_input_title;
        } else if (text.includes('KATA KUNCI') || text.includes('KEYWORDS')) {
          lbl.textContent = TRANSLATIONS[lang].matcher_input_keywords;
        } else if (text.includes('ABSTRAK ARTIKEL') || text.includes('ARTICLE ABSTRACT')) {
          lbl.textContent = TRANSLATIONS[lang].matcher_input_abstract;
        } else if (text.includes('TOPIK / JUDUL PENELITIAN') || text.includes('RESEARCH TOPIC')) {
          lbl.textContent = TRANSLATIONS[lang].lit_input_title;
        } else if (text.includes('TEKS MASUKAN') || text.includes('INPUT TEXT')) {
          lbl.textContent = TRANSLATIONS[lang].humanizer_input_lbl;
        } else if (text.includes('HASIL HUMANISASI') || text.includes('HUMANIZED RESULT')) {
          lbl.textContent = TRANSLATIONS[lang].humanizer_output_lbl;
        }
      });

      // 9b. Translate Beranda Banner Slider
      const bannerSlideEls = document.querySelectorAll('.banner-slide');
      const bannerData = TRANSLATIONS[lang].banner;
      bannerSlideEls.forEach((slideEl, index) => {
        const d = bannerData[index];
        if (!d) return;
        const badgeEl = slideEl.querySelector('.banner-badge');
        const titleEl = slideEl.querySelector('h3');
        const descEl = slideEl.querySelector('p');
        // Tombol slide pertama diganti class-nya jadi .banner-upgrade-btn oleh
        // checkAuthState() tergantung tier user (Free vs Premium/Ultimate), jadi
        // harus dicari via kedua kemungkinan class, bukan cuma .banner-action-btn.
        const btnEl = slideEl.querySelector('.banner-action-btn, .banner-upgrade-btn');
        if (badgeEl) {
          const icon = badgeEl.querySelector('i');
          badgeEl.innerHTML = `${icon ? icon.outerHTML : ''} ${d.badge}`;
        }
        if (titleEl) titleEl.textContent = d.title;
        if (descEl) descEl.textContent = d.desc;
        if (btnEl) {
          const icon = btnEl.querySelector('i');
          const isFreeTierSlide0 = index === 0 && btnEl.classList.contains('banner-upgrade-btn') && (!currentUser?.user || (currentUser.user.type !== 'premium' && currentUser.user.type !== 'ultimate'));
          const btnText = isFreeTierSlide0 ? TRANSLATIONS[lang].banner_slide0_free_btn : d.btn;
          btnEl.innerHTML = `${icon ? icon.outerHTML : ''} ${btnText}`;
        }
      });

      // 9c. Translate AI For Research tab (header + 4 cards)
      const aiResearchHeaderEl = document.querySelector('.ai-research-header h3');
      const aiResearchDescEl = document.querySelector('.ai-research-header p');
      if (aiResearchHeaderEl) aiResearchHeaderEl.textContent = TRANSLATIONS[lang].ai_research_header;
      if (aiResearchDescEl) aiResearchDescEl.textContent = TRANSLATIONS[lang].ai_research_desc;

      const aiResearchCardEls = document.querySelectorAll('.ai-research-card');
      const aiResearchCardData = TRANSLATIONS[lang].ai_research_cards;
      aiResearchCardEls.forEach((cardEl, index) => {
        const d = aiResearchCardData[index];
        if (!d) return;
        const titleEl = cardEl.querySelector('h4');
        const descEl = cardEl.querySelector('p');
        const btnEl = cardEl.querySelector('.ai-research-btn');
        if (titleEl) titleEl.textContent = d.title;
        if (descEl) descEl.textContent = d.desc;
        if (btnEl) {
          const icon = btnEl.querySelector('i');
          const btnText = d.btn || TRANSLATIONS[lang].ai_research_open_btn;
          btnEl.innerHTML = `${btnText} ${icon ? icon.outerHTML : ''}`;
        }
      });

      // 9d. Translate Beranda widgets (Database Jurnal quick link + Aktivitas Terakhir)
      const berandaDbTitleEl = document.getElementById('berandaDbJurnalTitle');
      if (berandaDbTitleEl) berandaDbTitleEl.textContent = TRANSLATIONS[lang].beranda_db_title;
      const berandaDbDescSuffixEl = document.getElementById('berandaDbJurnalDescSuffix');
      if (berandaDbDescSuffixEl) berandaDbDescSuffixEl.textContent = TRANSLATIONS[lang].beranda_db_desc_suffix;
      const berandaDbBtnEl = document.getElementById('berandaDbJurnalBtn');
      if (berandaDbBtnEl) {
        const span = berandaDbBtnEl.querySelector('span');
        if (span) span.textContent = TRANSLATIONS[lang].beranda_db_btn;
      }
      const berandaRecentTitleEl = document.getElementById('berandaRecentActivityTitle');
      if (berandaRecentTitleEl) {
        const span = berandaRecentTitleEl.querySelector('span');
        if (span) span.textContent = TRANSLATIONS[lang].beranda_recent_title;
      }
      const berandaRecentEmptyEl = document.getElementById('berandaRecentActivityEmpty');
      if (berandaRecentEmptyEl) {
        const p = berandaRecentEmptyEl.querySelector('p');
        if (p) p.textContent = TRANSLATIONS[lang].beranda_recent_empty;
      }
      if (typeof renderBerandaRecentActivity === 'function' && currentUser?.user) {
        renderBerandaRecentActivity();
      }

      // 9e. Translate Pengaturan (Settings) tab
      const settingsProfileTitleEl = document.getElementById('settingsProfileTitle');
      if (settingsProfileTitleEl) settingsProfileTitleEl.textContent = TRANSLATIONS[lang].settings_profile_title;
      const settingsMembershipLabelEl = document.getElementById('settingsMembershipLabel');
      if (settingsMembershipLabelEl) settingsMembershipLabelEl.textContent = TRANSLATIONS[lang].settings_membership_label;
      const lblProfileNameEl = document.getElementById('lblProfileName');
      if (lblProfileNameEl) lblProfileNameEl.textContent = TRANSLATIONS[lang].lbl_profile_name;
      const lblProfileFacultyEl = document.getElementById('lblProfileFaculty');
      if (lblProfileFacultyEl) lblProfileFacultyEl.textContent = TRANSLATIONS[lang].lbl_profile_faculty;
      const lblProfileUniversityEl = document.getElementById('lblProfileUniversity');
      if (lblProfileUniversityEl) lblProfileUniversityEl.textContent = TRANSLATIONS[lang].lbl_profile_university;
      const btnSaveProfileEl = document.getElementById('btnSaveProfile');
      if (btnSaveProfileEl) btnSaveProfileEl.textContent = TRANSLATIONS[lang].btn_save_profile;

      const settingsPrefsTitleEl = document.getElementById('settingsPrefsTitle');
      if (settingsPrefsTitleEl) settingsPrefsTitleEl.textContent = TRANSLATIONS[lang].settings_prefs_title;
      const settingsPrefsDescEl = document.getElementById('settingsPrefsDesc');
      if (settingsPrefsDescEl) settingsPrefsDescEl.textContent = TRANSLATIONS[lang].settings_prefs_desc;
      const lblPrefsSubjectEl = document.getElementById('lblPrefsSubject');
      if (lblPrefsSubjectEl) lblPrefsSubjectEl.textContent = TRANSLATIONS[lang].lbl_prefs_subject;
      const lblPrefsTypeEl = document.getElementById('lblPrefsType');
      if (lblPrefsTypeEl) lblPrefsTypeEl.textContent = TRANSLATIONS[lang].lbl_prefs_type;
      const savePreferencesBtnEl = document.getElementById('savePreferencesBtn');
      if (savePreferencesBtnEl) savePreferencesBtnEl.textContent = TRANSLATIONS[lang].btn_save_prefs;

      // Opsi dropdown preferensi sama persis dengan filter Database Jurnal, jadi index-nya konsisten
      const settingsSubjectOptions = document.querySelectorAll('#settingsDefaultSubject option');
      if (settingsSubjectOptions.length >= 5) {
        settingsSubjectOptions[0].textContent = lang === 'id' ? 'Semua Rumpun' : 'All Subjects';
        settingsSubjectOptions[1].textContent = lang === 'id' ? 'Sains & Teknologi' : 'Science & Technology';
        settingsSubjectOptions[2].textContent = lang === 'id' ? 'Sosial & Humaniora' : 'Social Sciences & Humanities';
        settingsSubjectOptions[3].textContent = lang === 'id' ? 'Kesehatan' : 'Health & Medical';
        settingsSubjectOptions[4].textContent = lang === 'id' ? 'Ekonomi & Bisnis' : 'Economics & Business';
      }
      const settingsTypeOptions = document.querySelectorAll('#settingsDefaultType option');
      if (settingsTypeOptions.length >= 3) {
        settingsTypeOptions[0].textContent = lang === 'id' ? 'Semua Jurnal' : 'All Journals';
      }

      const settingsSecurityTitleEl = document.getElementById('settingsSecurityTitle');
      if (settingsSecurityTitleEl) settingsSecurityTitleEl.textContent = TRANSLATIONS[lang].settings_security_title;
      const lblOldPasswordEl = document.getElementById('lblOldPassword');
      if (lblOldPasswordEl) lblOldPasswordEl.textContent = TRANSLATIONS[lang].lbl_old_password;
      const lblNewPasswordEl = document.getElementById('lblNewPassword');
      if (lblNewPasswordEl) lblNewPasswordEl.textContent = TRANSLATIONS[lang].lbl_new_password;
      const lblConfirmPasswordEl = document.getElementById('lblConfirmPassword');
      if (lblConfirmPasswordEl) lblConfirmPasswordEl.textContent = TRANSLATIONS[lang].lbl_confirm_password;
      const btnUpdatePasswordEl = document.getElementById('btnUpdatePassword');
      if (btnUpdatePasswordEl) btnUpdatePasswordEl.textContent = TRANSLATIONS[lang].btn_update_password;

      // 9f. Translate Template Jurnal tab
      const templatesBadgeEl = document.getElementById('templatesBadge');
      if (templatesBadgeEl) templatesBadgeEl.textContent = TRANSLATIONS[lang].templates_badge;
      const templatesTitleEl = document.getElementById('templatesTitle');
      if (templatesTitleEl) templatesTitleEl.textContent = TRANSLATIONS[lang].templates_title;
      const templatesDescEl = document.getElementById('templatesDesc');
      if (templatesDescEl) templatesDescEl.textContent = TRANSLATIONS[lang].templates_desc;

      // 9g. Translate Prompt Bank tab
      const promptBankBadgeEl = document.getElementById('promptBankBadge');
      if (promptBankBadgeEl) promptBankBadgeEl.textContent = TRANSLATIONS[lang].prompt_bank_badge;
      const promptBankDescEl = document.getElementById('promptBankDesc');
      if (promptBankDescEl) promptBankDescEl.textContent = TRANSLATIONS[lang].prompt_bank_desc;
      const promptTabScopusEl = document.getElementById('promptTabScopus');
      if (promptTabScopusEl) {
        const span = promptTabScopusEl.querySelector('span');
        if (span) span.textContent = TRANSLATIONS[lang].prompt_bank_tab_scopus;
      }
      const promptTabTesisEl = document.getElementById('promptTabTesis');
      if (promptTabTesisEl) {
        const span = promptTabTesisEl.querySelector('span');
        if (span) span.textContent = TRANSLATIONS[lang].prompt_bank_tab_tesis;
      }
      const promptSearchInputEl = document.getElementById('promptSearchInput');
      if (promptSearchInputEl) promptSearchInputEl.placeholder = TRANSLATIONS[lang].prompt_bank_search_placeholder;
      const promptStagesHeadingEl = document.getElementById('promptStagesHeading');
      if (promptStagesHeadingEl) promptStagesHeadingEl.textContent = TRANSLATIONS[lang].prompt_bank_stages_heading;

      // 9h. Translate JurnalHub Intelligence tab
      const researchChatDescEl = document.getElementById('researchChatDesc');
      if (researchChatDescEl) researchChatDescEl.innerHTML = TRANSLATIONS[lang].research_chat_desc;
      const researchChatEmptyTextEl = document.getElementById('researchChatEmptyText');
      if (researchChatEmptyTextEl) researchChatEmptyTextEl.textContent = TRANSLATIONS[lang].research_chat_empty;
      const researchChatInputEl = document.getElementById('researchChatInput');
      if (researchChatInputEl) researchChatInputEl.placeholder = TRANSLATIONS[lang].research_chat_input_placeholder;
      const researchChatClearTextEl = document.getElementById('researchChatClearText');
      if (researchChatClearTextEl) researchChatClearTextEl.textContent = TRANSLATIONS[lang].research_chat_clear;
      const researchChatDisclaimerEl = document.getElementById('researchChatDisclaimer');
      if (researchChatDisclaimerEl) researchChatDisclaimerEl.textContent = TRANSLATIONS[lang].research_chat_disclaimer;
      const researchChatLockTitleEl = document.getElementById('researchChatLockTitle');
      if (researchChatLockTitleEl) researchChatLockTitleEl.textContent = TRANSLATIONS[lang].research_chat_lock_title;
      const researchChatLockDescEl = document.getElementById('researchChatLockDesc');
      if (researchChatLockDescEl) researchChatLockDescEl.textContent = TRANSLATIONS[lang].research_chat_lock_desc;
      const researchChatUpgradeBtnTextEl = document.getElementById('researchChatUpgradeBtnText');
      if (researchChatUpgradeBtnTextEl) researchChatUpgradeBtnTextEl.textContent = TRANSLATIONS[lang].research_chat_upgrade_btn;
      if (currentUser?.user) {
        updateResearchChatAccess(currentUser.user);
      }

      // 10. Translate History Tab static elements
      const historyTitleEl = document.querySelector('#tabContentRiwayat h3');
      const clearHistoryBtnEl = document.getElementById('clearHistoryBtn');
      if (historyTitleEl) historyTitleEl.textContent = TRANSLATIONS[lang].history_title;
      if (clearHistoryBtnEl) {
        clearHistoryBtnEl.innerHTML = `<i class="fa-regular fa-trash-can"></i> ${TRANSLATIONS[lang].history_clear_btn}`;
      }

      // Translate history filter badges
      const histBadges = document.querySelectorAll('#historyFilterButtons .filter-badge');
      histBadges.forEach(badge => {
        const type = badge.getAttribute('data-type');
        if (type === 'all') badge.textContent = lang === 'id' ? 'Semua' : 'All';
        else if (type === 'match') badge.textContent = lang === 'id' ? 'Journal Matcher' : 'Journal Matcher';
        else if (type === 'draft') badge.textContent = lang === 'id' ? 'Outline Generator' : 'Outline Generator';
        else if (type === 'lit-review') badge.textContent = lang === 'id' ? 'Literature Review' : 'Literature Review';
        else if (type === 'humanizer') badge.textContent = lang === 'id' ? 'Humanizer Engine' : 'Humanizer Engine';
      });

      // Translate Quota Tracker Card static items
      const lblQuotaTitle = document.getElementById('lblQuotaTitle');
      const lblMatchDraftLimitNote = document.getElementById('lblMatchDraftLimitNote');
      const lblLitReviewLimitNote = document.getElementById('lblLitReviewLimitNote');
      const lblHumanizerLimitNote = document.getElementById('lblHumanizerLimitNote');
      if (lblQuotaTitle) lblQuotaTitle.textContent = TRANSLATIONS[lang].quota_title;
      if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = TRANSLATIONS[lang].quota_note_match;
      if (lblLitReviewLimitNote) lblLitReviewLimitNote.textContent = TRANSLATIONS[lang].quota_note_lit;
      if (lblHumanizerLimitNote) lblHumanizerLimitNote.textContent = TRANSLATIONS[lang].quota_note_humanizer;

      // Translate Billing Section static items
      const billingTitleEl = document.querySelector('#tabContentPengaturan h3 i.fa-receipt')?.parentElement;
      const billingDescEl = document.getElementById('billingSectionDesc');
      const thBillDate = document.getElementById('thBillDate');
      const thBillDesc = document.getElementById('thBillDesc');
      const thBillAmount = document.getElementById('thBillAmount');
      const thBillStatus = document.getElementById('thBillStatus');
      const thBillAction = document.getElementById('thBillAction');

      if (billingTitleEl) billingTitleEl.innerHTML = `<i class="fa-solid fa-receipt" style="color: var(--brand-blue);"></i> ${TRANSLATIONS[lang].billing_title}`;
      if (billingDescEl) billingDescEl.textContent = TRANSLATIONS[lang].billing_desc;
      if (thBillDate) thBillDate.textContent = TRANSLATIONS[lang].th_date;
      if (thBillDesc) thBillDesc.textContent = TRANSLATIONS[lang].th_desc;
      if (thBillAmount) thBillAmount.textContent = TRANSLATIONS[lang].th_amount;
      if (thBillStatus) thBillStatus.textContent = TRANSLATIONS[lang].th_status;
      if (thBillAction) thBillAction.textContent = TRANSLATIONS[lang].th_action;

      // Re-trigger visual quota tracker updates and billing history table updates
      if (currentUser && currentUser.user) {
        updateVisualQuotaTracker(currentUser.user);
        renderBillingHistory();
      }

      // Update dark mode toggle tooltip for current language
      const darkModeBtn = document.getElementById('darkModeToggleBtn');
      if (darkModeBtn) {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (lang === 'en') {
          darkModeBtn.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
        } else {
          darkModeBtn.title = isDark ? 'Beralih ke Mode Terang' : 'Beralih ke Mode Gelap';
        }
      }

      // Re-trigger history list rendering if currently on history tab to update cards
      const activeTabLink = document.querySelector('.sidebar-link.active');
      if (activeTabLink && activeTabLink.getAttribute('data-tab') === 'riwayat') {
        displayHistoryList();
      }

      // Update current title element text
      const activeTab = document.querySelector('.sidebar-link.active')?.getAttribute('data-tab') || 'beranda';
      const pageTitleEl = document.getElementById('pageTitle');
      if (pageTitleEl && TRANSLATIONS[lang][activeTab]) {
        pageTitleEl.textContent = TRANSLATIONS[lang][activeTab];
      }

      // Re-trigger cards rendering to update labels (Field, Subject, APC, Visit, Hidden Jurnals)
      if (typeof renderCards === 'function') {
        renderCards();
      }
    }

    // Bind lang buttons click
    const btnId = document.getElementById('langBtnId');
    const btnEn = document.getElementById('langBtnEn');
    if (btnId) btnId.addEventListener('click', () => applyLanguage('id'));
    if (btnEn) btnEn.addEventListener('click', () => applyLanguage('en'));

    // Apply language on load
    setTimeout(() => {
      applyLanguage(currentLanguage);
    }, 200);

    activeJournals = JOURNAL_DATABASE;
    filterJournals(); // Apply preferences automatically
    calculateStats();

    const berandaDbJurnalCount = document.getElementById('berandaDbJurnalCount');
    if (berandaDbJurnalCount) {
      berandaDbJurnalCount.textContent = JOURNAL_DATABASE.length.toLocaleString('id-ID');
    }
  }

  init();
});

