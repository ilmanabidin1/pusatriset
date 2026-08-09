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

  // Efek "reveal perkata" supaya hasil AI yang datang sekaligus (bukan streaming asli
  // dari API, karena outputnya JSON terstruktur / API pihak ketiga tanpa streaming)
  // tetap terasa cepat & hidup seperti balasan JurnalHub Intelligence. Durasi total
  // dibuat konsisten (~1.4 detik) berapa pun panjang teksnya, dengan mempercepat
  // jumlah kata per tick untuk teks yang lebih panjang.
  function computeUnitsPerTick(totalUnits, tickMs, targetDurationMs) {
    const ticks = Math.max(1, Math.round(targetDurationMs / tickMs));
    return Math.max(1, Math.ceil(totalUnits / ticks));
  }

  // Reveal HTML yang sudah dirender (mendukung tabel, list, dsb) dengan cara
  // membungkus tiap kata jadi <span opacity:0> lalu menampilkannya bertahap.
  // Layout final sudah terbentuk penuh sejak awal (tidak ada shifting), hanya
  // opacity kata yang beranimasi, jadi aman untuk struktur HTML apa pun.
  function revealWordsInElement(root, options) {
    if (!root) return;
    const tickMs = (options && options.tickMs) || 25;
    const targetDurationMs = (options && options.targetDurationMs) || 1400;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim().length > 0) textNodes.push(node);
    }

    const spans = [];
    textNodes.forEach(tn => {
      const parts = tn.nodeValue.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      parts.forEach(part => {
        if (part === '') return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.textContent = part;
          span.style.opacity = '0';
          span.style.transition = 'opacity 0.15s ease';
          frag.appendChild(span);
          spans.push(span);
        }
      });
      tn.parentNode.replaceChild(frag, tn);
    });

    if (spans.length === 0) return;
    const wordsPerTick = computeUnitsPerTick(spans.length, tickMs, targetDurationMs);
    let i = 0;
    const timer = setInterval(() => {
      for (let k = 0; k < wordsPerTick && i < spans.length; k++, i++) {
        spans[i].style.opacity = '1';
      }
      if (i >= spans.length) clearInterval(timer);
    }, tickMs);
  }

  // Varian untuk <textarea> (mis. Humanizer) - tidak bisa berisi HTML, jadi
  // kontennya dibangun bertahap kata demi kata langsung ke .value.
  function revealTextIntoTextarea(textareaEl, fullText, options) {
    if (!textareaEl) return;
    const tickMs = (options && options.tickMs) || 25;
    const targetDurationMs = (options && options.targetDurationMs) || 1400;

    const tokens = String(fullText ?? '').split(/(\s+)/).filter(t => t !== '');
    textareaEl.value = '';
    if (tokens.length === 0) return;

    const tokensPerTick = computeUnitsPerTick(tokens.length, tickMs, targetDurationMs);
    let i = 0;
    const timer = setInterval(() => {
      let chunk = '';
      for (let k = 0; k < tokensPerTick && i < tokens.length; k++, i++) {
        chunk += tokens[i];
      }
      textareaEl.value += chunk;
      if (i >= tokens.length) clearInterval(timer);
    }, tickMs);
  }

  // Indikator progres berjalan untuk proses AI yang makan waktu (mis. Lit Review
  // Pro) - supaya user tahu prosesnya masih berjalan (bukan macet), bukan cuma
  // spinner diam. Pesan berganti tiap beberapa detik + penghitung waktu berjalan.
  function startProcessingStatus(btn, messages, intervalMs) {
    const delay = intervalMs || 3000;
    const startTime = Date.now();
    let idx = 0;
    const update = () => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${messages[idx % messages.length]} (${elapsed}s)`;
      idx++;
    };
    update();
    const timer = setInterval(update, delay);
    return () => clearInterval(timer);
  }

  // Setup generik tombol "Generate AI Disclosure Statement" - dipakai di semua
  // fitur AI (Match Score, Outline, Lit Review, Humanizer). Sengaja tidak
  // dibatasi kuota/tier di backend, jadi tidak ada pengecekan lock di sini juga.
  function setupAiDisclosureButton({ btnId, resultWrapperId, textareaId, copyBtnId, toolName, getUsageContext, getSearchTerms }) {
    const btn = document.getElementById(btnId);
    const resultWrapper = document.getElementById(resultWrapperId);
    const textarea = document.getElementById(textareaId);
    const copyBtn = document.getElementById(copyBtnId);
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const usageContext = getUsageContext();
      if (!usageContext) {
        alert('Data belum lengkap untuk membuat AI Disclosure Statement.');
        return;
      }
      const searchTerms = getSearchTerms ? (getSearchTerms() || '') : '';

      const originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membuat pernyataan...';

      try {
        const res = await fetch('/api/generate-ai-disclosure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolName, usageContext, searchTerms })
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
          alert(data.message || 'Gagal membuat AI Disclosure Statement.');
          return;
        }

        if (textarea) textarea.value = data.statement;
        if (resultWrapper) {
          resultWrapper.style.display = 'block';
          resultWrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      } catch (err) {
        console.error('[AI Disclosure]', err);
        alert('Gagal menghubungi server untuk membuat AI Disclosure Statement.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    });

    if (copyBtn && textarea) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(textarea.value).then(() => {
          const orig = copyBtn.innerHTML;
          copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
          setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
        });
      });
    }
  }

  // Pasang tombol AI Disclosure Statement di keempat fitur AI form-based.
  // Pakai document.getElementById langsung di getUsageContext (bukan closure ke
  // variable input yang dideklarasikan di tempat lain) supaya tidak bergantung
  // urutan deklarasi.
  setupAiDisclosureButton({
    btnId: 'matchDisclosureBtn',
    resultWrapperId: 'matchDisclosureResult',
    textareaId: 'matchDisclosureText',
    copyBtnId: 'matchDisclosureCopyBtn',
    toolName: 'JurnalHub AI Match Score',
    getUsageContext: () => {
      const title = document.getElementById('articleTitle')?.value.trim();
      if (!title) return null;
      return `to identify and recommend suitable Scopus/Sinta target journals for a manuscript titled "${title}" based on its title, keywords, and abstract`;
    }
  });

  setupAiDisclosureButton({
    btnId: 'draftDisclosureBtn',
    resultWrapperId: 'draftDisclosureResult',
    textareaId: 'draftDisclosureText',
    copyBtnId: 'draftDisclosureCopyBtn',
    toolName: 'JurnalHub AI Drafting Companion (Outline Generator)',
    getUsageContext: () => {
      const title = document.getElementById('draftTitle')?.value.trim();
      if (!title) return null;
      return `to generate a structured chapter-by-chapter outline for a manuscript titled "${title}" prior to full drafting`;
    }
  });

  setupAiDisclosureButton({
    btnId: 'litReviewDisclosureBtn',
    resultWrapperId: 'litReviewDisclosureResult',
    textareaId: 'litReviewDisclosureText',
    copyBtnId: 'litReviewDisclosureCopyBtn',
    toolName: 'JurnalHub AI Literature Review & Citation Finder',
    getUsageContext: () => {
      const title = document.getElementById('litReviewTitle')?.value.trim();
      if (!title) return null;
      return `to identify relevant academic literature and draft a preliminary literature review for research on "${title}"`;
    },
    getSearchTerms: () => {
      const title = document.getElementById('litReviewTitle')?.value.trim() || '';
      const keywords = document.getElementById('litReviewKeywords')?.value.trim() || '';
      return [title, keywords].filter(Boolean).join(', ');
    }
  });

  setupAiDisclosureButton({
    btnId: 'humanizerDisclosureBtn',
    resultWrapperId: 'humanizerDisclosureResult',
    textareaId: 'humanizerDisclosureText',
    copyBtnId: 'humanizerDisclosureCopyBtn',
    toolName: 'JurnalHub Paraphraser & Humanizer Engine',
    getUsageContext: () => {
      const inputText = document.getElementById('humanizerInputText')?.value.trim();
      if (!inputText) return null;
      return 'to paraphrase and refine AI-assisted text into natural academic language while preserving its original meaning and technical terminology';
    }
  });

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
        .replace(/`([^`]+)`/g, '<code class="chat-md-code">$1</code>')
        // URL/DOI mentah (mis. di daftar Referensi Lit Review) jadi link yang bisa
        // diklik - str sudah di-escape lebih dulu (escapeHtml tidak menyentuh "/"),
        // jadi aman langsung dipakai sebagai href.
        .replace(/(https?:\/\/[^\s<]+)/g, (m) => {
          const clean = m.replace(/[.,;:!?)\]]+$/, '');
          const trailing = m.slice(clean.length);
          return `<a href="${clean}" target="_blank" rel="noopener" class="chat-md-link">${clean}</a>${trailing}`;
        });
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
        // Model sering menaruh baris kosong DI ANTARA item list (terutama list
        // bernomor) ATAU di antara item list dan paragraf penjelasannya. Kalau
        // langsung flush di sini, tiap item jadi <ol> terpisah yang masing-masing
        // mulai lagi dari "1." - parah kalau modelnya juga literal menulis "1."
        // di setiap poin (kebiasaan umum LLM, bukan 1/2/3 yang benar). Makanya
        // list HANYA diputus kalau baris berikutnya benar-benar blok lain
        // (heading/hr/tabel) atau teksnya sudah habis - paragraf polos tetap
        // dianggap lanjutan item terakhir (lihat fallthrough paragraf di bawah).
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const nextTrimmed = j < lines.length ? lines[j].trim() : '';
        const nextBreaksList = nextTrimmed === ''
          || /^#{1,6}\s+/.test(nextTrimmed)
          || /^-{3,}$/.test(nextTrimmed)
          || isTableRow(nextTrimmed);
        if (nextBreaksList) {
          flushList();
        }
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
      if (listType && listBuffer.length > 0) {
        // Paragraf polos tepat setelah item list - anggap lanjutan/penjelasan
        // item TERAKHIR, bukan paragraf baru yang memutus list (lihat catatan
        // di blok baris-kosong di atas soal kenapa ini penting untuk penomoran).
        listBuffer[listBuffer.length - 1] += `<br><br>${inline(trimmed)}`;
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
      "cari-referensi": "Cari Referensi",
      "ai-research": "Paraphraser & Humanizer",
      "research-chat": "JurnalHub Intelligence",
      templates: "Template Jurnal",
      "prompt-bank": "Prompt Bank",
      slr: "Systematic Lit Review",
      "patent-search": "Pencarian Paten",
      "koleksi-saya": "Koleksi Saya",
      pengaturan: "Pengaturan",
      sidebar_more: "Lainnya",
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
      humanizer_title: "Paraphraser & Humanizer",
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
      research_chat_upgrade_btn: "Upgrade PRO",
      research_chat_attach_btn: "Lampirkan Dokumen",
      research_chat_prompt_shortcut_heading: "Shortcut Prompt Bank",
      // Pencarian Paten (Patent Search)
      patent_search_title: "Pencarian Paten (Semantic Search)",
      patent_search_intro: "Tempel judul, abstrak, atau klaim ide riset Anda. Sistem akan mencari paten global yang mirip secara makna (bukan sekadar kata kunci) menggunakan data Patsnap — cocok untuk cek novelty sebelum mengajukan permohonan paten atau hibah.",
      patent_search_placeholder: "Contoh: Material katoda baterai lithium-ion dengan stabilitas termal yang ditingkatkan untuk kendaraan listrik...",
      patent_search_hint_default: "Minimal 20 karakter. Semakin detail teksnya, semakin akurat hasilnya.",
      patent_search_hint_remaining: "Minimal 20 karakter. Sisa kuota bulan ini: {n}x (batas {limit}/bulan untuk akun {type}).",
      patent_search_hint_limit_reached: "Kuota pencarian paten bulan ini habis (batas {limit}/bulan untuk akun {type}).",
      patent_search_upgrade_link: "Upgrade",
      patent_search_upgrade_suffix: "untuk kuota lebih besar.",
      patent_search_btn: "Cari Paten Serupa",
      peer_review_quota_unlimited: "Kuota Tanpa Batas",
      peer_review_quota_remaining: "Sisa Kuota: {n}/{limit} bulan ini",
      peer_review_quota_limit_reached: "Kuota bulan ini habis (batas {limit}/bulan)",
      peer_review_upgrade_link: "Upgrade",
      patent_search_searching: "Mencari paten serupa secara semantik...",
      patent_search_no_results: "Tidak ditemukan paten yang mirip.",
      patent_search_summary: "Menampilkan {n} paten paling mirip dari total {total} hasil. Klik \"Lihat Detail\" untuk membaca abstrak dan status legal lengkapnya di Google Patents.",
      patent_search_view_detail: "Lihat Detail",
      patent_search_similar_badge: "mirip",
      patent_search_no_title: "Judul tidak tersedia",
      patent_search_published: "Publikasi",
      patent_search_min_chars_alert: "Masukkan judul, abstrak, atau klaim minimal 20 karakter agar pencarian semantik akurat.",
      patent_search_generic_error: "Gagal menghubungi server untuk mencari paten.",
      // Database Jurnal sub-tabs
      db_subtab_main: "Database Utama",
      db_subtab_noapc: "No APC Database",
      realtime_filter_type_label: "TIPE DOKUMEN",
      realtime_filter_all: "Semua Tipe",
      realtime_filter_article: "Artikel",
      realtime_filter_dissertation: "Disertasi/Tesis",
      realtime_mode_label: "MODE PENCARIAN",
      realtime_boolean_label: "Mode Boolean (AND/OR/NOT)",
      realtime_search_btn: "Cari",
      realtime_search_placeholder_normal: "Cari 480 juta+ karya ilmiah dari OpenAlex... (bisa pakai AND / OR / NOT)",
      realtime_search_placeholder_example: "Contoh: \"machine learning\" AND (education OR pedagogy) NOT survey",
      realtime_default_hint: "Ketik kata kunci lalu klik Cari untuk menampilkan hasil (maks. 50).",
      realtime_min_chars_alert: "Ketik kata kunci (minimal 3 karakter) terlebih dahulu.",
      realtime_no_results: "Tidak ditemukan hasil untuk kata kunci ini.",
      realtime_showing_results: "Menampilkan {n} dari maks. 50 hasil",
      realtime_searching: "Mencari...",
      realtime_cited_suffix: "x dikutip",
      realtime_open_source: "Buka Sumber",
      realtime_generic_error: "Gagal mencari data dari OpenAlex.",
      realtime_conn_error: "Gagal menghubungi server untuk mencari data.",
      // Kode Promo
      promo_apply_btn: "Terapkan",
      promo_input_placeholder: "Punya kode promo? (khusus paket bulanan)",
      promo_monthly_only_msg: "Kode promo hanya berlaku untuk paket Bulanan - pindah ke tab Bulanan dulu.",
      promo_applied_msg: "Kode {code} diterapkan - potongan {percent}% untuk paket bulanan.",
      promo_invalid_msg: "Kode promo tidak valid.",
      promo_conn_error_msg: "Terjadi kesalahan koneksi. Coba lagi.",
      // Outline doc type & quick-tool chip (JurnalHub Intelligence)
      outline_doctype_jurnal: "Jurnal Ilmiah (IMRaD)",
      outline_doctype_tesis: "Tesis",
      outline_doctype_disertasi: "Disertasi",
      quicktool_outline_chip: "Mode: Outline Generator - pilih jenis dokumen, jelaskan topik, lalu kirim",
      quicktool_outline_placeholder: "Jelaskan topik/rencana penelitian Anda...",
      quicktool_deeplit_chip: "Mode: Deep Lit Review - jelaskan topik Anda lalu kirim",
      quicktool_deeplit_placeholder: "Jelaskan topik penelitian yang ingin dicari referensinya (mendalam)...",
      quicktool_litreview_chip: "Mode: Lit Review - jelaskan topik Anda lalu kirim",
      quicktool_litreview_placeholder: "Jelaskan topik penelitian yang ingin dicari referensinya...",
      // Export & citation popover
      export_btn_pdf_title: "Unduh PDF",
      export_btn_docx_title: "Unduh Word (.doc)",
      export_btn_ris_title: "Unduh referensi .ris",
      export_btn_bib_title: "Unduh referensi .bib",
      cite_popover_pdf_title: "Unduh PDF (Open Access)",
      cite_popover_no_title: "Tanpa judul",
      cite_popover_citations_suffix: "sitasi",
      cite_popover_open_source: "Buka sumber"
    },
    en: {
      beranda: "Home",
      "database-jurnal": "Journal Database",
      "cari-referensi": "Search References",
      "ai-research": "Paraphraser & Humanizer",
      "research-chat": "JurnalHub Intelligence",
      templates: "Journal Templates",
      "prompt-bank": "Prompt Bank",
      slr: "Systematic Lit Review",
      "patent-search": "Patent Search",
      "koleksi-saya": "My Collection",
      pengaturan: "Settings",
      sidebar_more: "More",
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
      humanizer_title: "Paraphraser & Humanizer",
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
      research_chat_upgrade_btn: "Upgrade PRO",
      research_chat_attach_btn: "Attach Document",
      research_chat_prompt_shortcut_heading: "Prompt Bank Shortcuts",
      // Patent Search
      patent_search_title: "Patent Search (Semantic Search)",
      patent_search_intro: "Paste the title, abstract, or claims of your research idea. The system will search global patents that are semantically similar (not just keyword matching) using Patsnap data - useful for checking novelty before filing a patent application or grant proposal.",
      patent_search_placeholder: "Example: Lithium-ion battery cathode material with improved thermal stability for electric vehicles...",
      patent_search_hint_default: "Minimum 20 characters. The more detailed the text, the more accurate the results.",
      patent_search_hint_remaining: "Minimum 20 characters. Remaining quota this month: {n}x (limit {limit}/month for {type} accounts).",
      patent_search_hint_limit_reached: "Monthly patent search quota reached (limit {limit}/month for {type} accounts).",
      patent_search_upgrade_link: "Upgrade",
      patent_search_upgrade_suffix: "for a larger quota.",
      patent_search_btn: "Search Similar Patents",
      peer_review_quota_unlimited: "Unlimited Quota",
      peer_review_quota_remaining: "Remaining Quota: {n}/{limit} this month",
      peer_review_quota_limit_reached: "Monthly quota reached (limit {limit}/month)",
      peer_review_upgrade_link: "Upgrade",
      patent_search_searching: "Searching for semantically similar patents...",
      patent_search_no_results: "No similar patents found.",
      patent_search_summary: "Showing {n} most similar patents out of {total} total results. Click \"View Detail\" to read the full abstract and legal status on Google Patents.",
      patent_search_view_detail: "View Detail",
      patent_search_similar_badge: "similar",
      patent_search_no_title: "Title unavailable",
      patent_search_published: "Published",
      patent_search_min_chars_alert: "Enter a title, abstract, or claim with at least 20 characters for accurate semantic search.",
      patent_search_generic_error: "Failed to contact the server to search for patents.",
      // Journal Database sub-tabs
      db_subtab_main: "Main Database",
      db_subtab_noapc: "No APC Database",
      realtime_filter_type_label: "DOCUMENT TYPE",
      realtime_filter_all: "All Types",
      realtime_filter_article: "Article",
      realtime_filter_dissertation: "Dissertation/Thesis",
      realtime_mode_label: "SEARCH MODE",
      realtime_boolean_label: "Boolean Mode (AND/OR/NOT)",
      realtime_search_btn: "Search",
      realtime_search_placeholder_normal: "Search 480 million+ scholarly works from OpenAlex... (supports AND / OR / NOT)",
      realtime_search_placeholder_example: "Example: \"machine learning\" AND (education OR pedagogy) NOT survey",
      realtime_default_hint: "Type a keyword and click Search to show results (max. 50).",
      realtime_min_chars_alert: "Type a keyword (minimum 3 characters) first.",
      realtime_no_results: "No results found for this keyword.",
      realtime_showing_results: "Showing {n} of max. 50 results",
      realtime_searching: "Searching...",
      realtime_cited_suffix: "x cited",
      realtime_open_source: "Open Source",
      realtime_generic_error: "Failed to fetch data from OpenAlex.",
      realtime_conn_error: "Failed to contact the server to search for data.",
      // Promo Code
      promo_apply_btn: "Apply",
      promo_input_placeholder: "Have a promo code? (monthly plans only)",
      promo_monthly_only_msg: "Promo codes only apply to Monthly plans - switch to the Monthly tab first.",
      promo_applied_msg: "Code {code} applied - {percent}% off monthly plans.",
      promo_invalid_msg: "Invalid promo code.",
      promo_conn_error_msg: "A connection error occurred. Please try again.",
      // Outline doc type & quick-tool chip (JurnalHub Intelligence)
      outline_doctype_jurnal: "Journal Article (IMRaD)",
      outline_doctype_tesis: "Thesis",
      outline_doctype_disertasi: "Dissertation",
      quicktool_outline_chip: "Mode: Outline Generator - pick a document type, describe your topic, then send",
      quicktool_outline_placeholder: "Describe your research topic/plan...",
      quicktool_deeplit_chip: "Mode: Deep Lit Review - describe your topic then send",
      quicktool_deeplit_placeholder: "Describe the research topic you want to find references for (in-depth)...",
      quicktool_litreview_chip: "Mode: Lit Review - describe your topic then send",
      quicktool_litreview_placeholder: "Describe the research topic you want to find references for...",
      // Export & citation popover
      export_btn_pdf_title: "Download PDF",
      export_btn_docx_title: "Download Word (.doc)",
      export_btn_ris_title: "Download .ris reference",
      export_btn_bib_title: "Download .bib reference",
      cite_popover_pdf_title: "Download PDF (Open Access)",
      cite_popover_no_title: "Untitled",
      cite_popover_citations_suffix: "citations",
      cite_popover_open_source: "Open source"
    }
  };
  window.TRANSLATIONS_REF = TRANSLATIONS;

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

  // Match Score sekarang menyatu di tab Database Jurnal (bukan lagi sub-tab
  // terpisah di bawah AI For Research) - helper ini pindah ke tab lalu buka
  // panel Cek Peluang Diterima AI dan scroll ke sana.
  window.openMatchScoreInDatabaseTab = () => {
    if (window.switchTab) window.switchTab('database-jurnal');
    setTimeout(() => {
      const panel = document.getElementById('dbAiCheckPanel');
      const toggleBtn = document.getElementById('dbAiCheckToggleBtn');
      if (panel && panel.style.display === 'none') {
        if (toggleBtn) toggleBtn.click();
        else panel.style.display = 'block';
      }
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
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

  // --- TOGGLE PANEL "CEK PELUANG DITERIMA DENGAN AI" (menyatu di tab Database Jurnal) ---
  (function initDbAiCheckToggle() {
    const toggleBtn = document.getElementById('dbAiCheckToggleBtn');
    const panel = document.getElementById('dbAiCheckPanel');
    const closeBtn = document.getElementById('dbAiCheckCloseBtn');
    const toggleText = document.getElementById('dbAiCheckToggleText');
    if (!toggleBtn || !panel) return;

    function setOpen(open) {
      panel.style.display = open ? 'block' : 'none';
      if (toggleText) {
        toggleText.textContent = open
          ? (window.currentLanguage === 'en' ? 'Hide AI Check Panel' : 'Sembunyikan Panel AI')
          : (window.currentLanguage === 'en' ? 'Check with AI' : 'Cek Peluang Diterima dengan AI');
      }
      if (open) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    toggleBtn.addEventListener('click', () => setOpen(panel.style.display === 'none'));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
  })();

  // --- SIDEBAR COLLAPSE TOGGLE (ala Claude) ---
  (function initSidebarCollapse() {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.getElementById('sidebarCollapseToggle');
    if (!sidebar || !toggleBtn) return;

    function applyCollapsed(collapsed) {
      sidebar.classList.toggle('collapsed', collapsed);
      if (mainContent) mainContent.classList.toggle('sidebar-collapsed', collapsed);
      toggleBtn.title = collapsed ? 'Buka sidebar' : 'Lipat sidebar';
      localStorage.setItem('jurnalhub_sidebar_collapsed', collapsed ? '1' : '0');

      // Saat dilipat, teks label sidebar disembunyikan (display:none) - kasih
      // title attribute di tiap link supaya tetap ada tooltip nama menu saat hover ikon.
      if (collapsed) {
        sidebar.querySelectorAll('.sidebar-link').forEach(link => {
          const span = link.querySelector('span:not(.pro-badge)');
          if (span && !link.getAttribute('title')) {
            link.setAttribute('title', span.textContent.trim());
          }
        });
      }
    }

    applyCollapsed(localStorage.getItem('jurnalhub_sidebar_collapsed') === '1');

    toggleBtn.addEventListener('click', () => {
      applyCollapsed(!sidebar.classList.contains('collapsed'));
    });
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
            
            updateExportDraftDocxLock(isUltimate);

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
                if (window.openMatchScoreInDatabaseTab) window.openMatchScoreInDatabaseTab();
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

            // Kunci toggle mode "Pro" Lit Review hanya untuk akun Ultimate (unlimited, tanpa kuota bulanan)
            const litModeProBtnState = document.getElementById('litModeProBtn');
            if (litModeProBtnState) {
              litModeProBtnState.classList.toggle('locked', !isUltimate);
              if (!isUltimate && litModeProBtnState.classList.contains('active')) {
                litModeProBtnState.classList.remove('active');
                const litModeStandardBtnState = document.getElementById('litModeStandardBtn');
                if (litModeStandardBtnState) litModeStandardBtnState.classList.add('active');
                if (typeof litReviewMode !== 'undefined') litReviewMode = 'standard';
              }
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

            updateExportDraftDocxLock(false);

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
                if (window.openMatchScoreInDatabaseTab) window.openMatchScoreInDatabaseTab();
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

            // Free user tidak pernah akses mode Pro - pastikan toggle terkunci & kembali ke Standar
            const litModeProBtnFreeState = document.getElementById('litModeProBtn');
            if (litModeProBtnFreeState) {
              litModeProBtnFreeState.classList.add('locked');
              if (litModeProBtnFreeState.classList.contains('active')) {
                litModeProBtnFreeState.classList.remove('active');
                const litModeStandardBtnState = document.getElementById('litModeStandardBtn');
                if (litModeStandardBtnState) litModeStandardBtnState.classList.add('active');
                if (typeof litReviewMode !== 'undefined') litReviewMode = 'standard';
              }
            }

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
          updateSlrAccess(currentUser.user);
          updatePatentSearchAccess(currentUser.user);
          updatePeerReviewerAccess(currentUser.user);
          updateCitationGraphAccess(currentUser.user);
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
      humanizer: { label: t.hist_type_humanizer, icon: 'fa-solid fa-wand-magic-sparkles', bg: 'rgba(245, 158, 11, 0.08)', color: '#f59e0b' },
      slr: { label: t.hist_type_slr || "Systematic Lit Review", icon: 'fa-solid fa-book-bookmark', bg: 'rgba(236, 72, 153, 0.08)', color: '#ec4899' }
    };
  }

  function berandaHistoryItemTitle(item, lang) {
    const t = TRANSLATIONS[lang] || TRANSLATIONS.id;
    if (item.type === 'match') return item.input.title || t.hist_fallback_match;
    if (item.type === 'draft') return item.input.title || t.hist_fallback_draft;
    if (item.type === 'lit-review') return item.input.title || t.hist_fallback_litreview;
    if (item.type === 'humanizer') return item.input.text ? item.input.text.slice(0, 60) + '...' : t.hist_fallback_humanizer;
    if (item.type === 'slr') return item.input.query || t.hist_fallback_slr || "Systematic Literature Review";
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
          if (window.openHistoryDetail) window.openHistoryDetail(id);
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
  let isResearchChatProUser = false; // Premium/Ultimate - buka Model Pro, Deep Thinking, & lampiran dokumen

  // Ekspor panduan outline ke .docx - khusus akun Ultimate
  function updateExportDraftDocxLock(isUltimate) {
    const btn = document.getElementById('exportDraftDocxBtn');
    if (!btn) return;
    btn.classList.toggle('btn-upgrade-trigger', !isUltimate);
    btn.style.opacity = isUltimate ? '1' : '0.6';
  }

  function updateResearchChatAccess(user) {
    const lock = document.getElementById('researchChatPremiumLock');
    const quotaText = document.getElementById('researchChatQuotaText');
    if (!lock) return;

    // Semua tier sekarang punya akses - Free dijatah 20 pesan/bulan, Premium & Ultimate unlimited
    lock.style.display = 'none';

    isResearchChatProUser = user.type === 'premium' || user.type === 'ultimate';

    // Model Pro, Deep Thinking, Lampiran Dokumen, dan Shortcut Prompt Bank dikunci untuk akun Free
    const pillModelPro = document.getElementById('pillModelPro');
    const pillModeThinking = document.getElementById('pillModeThinking');
    const attachBtn = document.getElementById('researchChatAttachBtn');
    const promptShuffleBtn = document.getElementById('researchChatPromptShuffleBtn');
    [pillModelPro, pillModeThinking, attachBtn, promptShuffleBtn].forEach(el => {
      if (!el) return;
      el.classList.toggle('composer-pill-locked', !isResearchChatProUser);
      el.classList.toggle('btn-upgrade-trigger', !isResearchChatProUser);
      el.title = isResearchChatProUser ? '' : (window.currentLanguage === 'en' ? 'Premium/Ultimate only - click to upgrade' : 'Khusus Premium/Ultimate - klik untuk upgrade');
    });

    // Deep Lit Review (quick-tool chat) eksklusif Ultimate - Outline Generator &
    // Lit Review standar terbuka untuk semua tier (Free dijatah kuota di server).
    const toolDeepLitReviewBtn = document.getElementById('researchChatToolDeepLitReviewBtn');
    const isUltimateUserForChat = !!(user && user.type === 'ultimate');
    if (toolDeepLitReviewBtn) {
      toolDeepLitReviewBtn.classList.toggle('locked', !isUltimateUserForChat);
      toolDeepLitReviewBtn.title = isUltimateUserForChat ? '' : (window.currentLanguage === 'en' ? 'Ultimate only - click to upgrade' : 'Khusus Ultimate - klik untuk upgrade');
    }

    // Kalau user baru saja downgrade (mis. langganan habis) sementara pilihan lama
    // masih Pro/Thinking, paksa balik ke Lite/Standar supaya tidak nyangkut di mode terkunci.
    if (!isResearchChatProUser) {
      const pillModelLite = document.getElementById('pillModelLite');
      const pillModeBasic = document.getElementById('pillModeBasic');
      if (pillModelPro && pillModelPro.classList.contains('active')) {
        pillModelPro.classList.remove('active');
        if (pillModelLite) pillModelLite.classList.add('active');
        if (typeof selectedResearchModel !== 'undefined') selectedResearchModel = 'lite';
      }
      if (pillModeThinking && pillModeThinking.classList.contains('active')) {
        pillModeThinking.classList.remove('active');
        if (pillModeBasic) pillModeBasic.classList.add('active');
        if (typeof selectedResearchMode !== 'undefined') selectedResearchMode = 'basic';
      }
      if (typeof window.removeResearchChatAttachment === 'function') {
        window.removeResearchChatAttachment();
      }
    }

    if (quotaText) {
      if (user.type === 'ultimate' || user.type === 'premium') {
        quotaText.textContent = window.currentLanguage === 'en' ? 'Unlimited' : 'Tanpa Batas';
      } else {
        const used = user.researchChatCountThisMonth || 0;
        const limit = user.researchChatLimit || 20;
        quotaText.textContent = window.currentLanguage === 'en'
          ? `Quota: ${used}/${limit} This Month`
          : `Kuota: ${used}/${limit} Bulan Ini`;
      }
    }

    // Kuota Outline Generator & Lit Review khusus akun Free (3x/bulan masing-masing) -
    // dulu cuma tampil di panel form lama yang sekarang tidak lagi bisa diakses dari
    // sidebar, jadi user Free tidak tahu sisa kuotanya sama sekali. Tampilkan lagi
    // di bawah tombol quick-tool chat.
    const toolQuotaEl = document.getElementById('researchChatToolQuotaText');
    if (toolQuotaEl) {
      if (!isResearchChatProUser) {
        const draftsLeft = user.draftsRemaining !== undefined ? user.draftsRemaining : 3;
        const litReviewsLeft = user.litReviewsRemaining !== undefined ? user.litReviewsRemaining : 3;
        toolQuotaEl.textContent = window.currentLanguage === 'en'
          ? `Free quota: Outline Generator ${draftsLeft}/3 · Lit Review ${litReviewsLeft}/3 this month`
          : `Kuota Free: Outline Generator ${draftsLeft}/3 · Lit Review ${litReviewsLeft}/3 bulan ini`;
        toolQuotaEl.style.display = 'block';
      } else {
        toolQuotaEl.style.display = 'none';
      }
    }
  }

  function updatePatentSearchAccess(user) {
    const hintEl = document.getElementById('patentSearchHint');
    const btn = document.getElementById('patentSearchBtn');
    if (!hintEl || !btn) return;

    if (!user) return;

    const t = TRANSLATIONS[window.currentLanguage || 'id'];
    const limitLabel = { free: '1x', premium: '5x', ultimate: '20x' }[user.type] || '1x';
    const remaining = typeof user.patentSearchRemaining === 'number' ? user.patentSearchRemaining : null;

    if (user.isPatentSearchLimitReached) {
      const msg = t.patent_search_hint_limit_reached.replace('{limit}', limitLabel).replace('{type}', user.type);
      hintEl.innerHTML = `${msg} <a href="#" class="btn-upgrade-trigger" style="color: var(--brand-blue); font-weight: 700;">${t.patent_search_upgrade_link}</a> ${t.patent_search_upgrade_suffix}`;
      btn.disabled = true;
    } else {
      hintEl.textContent = remaining !== null
        ? t.patent_search_hint_remaining.replace('{n}', remaining).replace('{limit}', limitLabel).replace('{type}', user.type)
        : t.patent_search_hint_default;
      btn.disabled = false;
    }
  }

  function updatePeerReviewerAccess(user) {
    const badgeEl = document.getElementById('peerReviewerQuotaDisclaimer');
    const btn = document.getElementById('runPeerReviewerBtn');
    if (!badgeEl || !user) return;

    const t = TRANSLATIONS[window.currentLanguage || 'id'];
    const limitLabel = { free: '2x', premium: '15x' }[user.type];
    const remaining = typeof user.peerReviewRemaining === 'number' ? user.peerReviewRemaining : null;

    if (user.type === 'ultimate' || !limitLabel) {
      badgeEl.innerHTML = `<i class="fa-solid fa-infinity" style="color: #059669;"></i> <span>${t.peer_review_quota_unlimited}</span>`;
      if (btn) btn.disabled = false;
      return;
    }

    if (user.isPeerReviewLimitReached) {
      const msg = t.peer_review_quota_limit_reached.replace('{limit}', limitLabel);
      badgeEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #dc2626;"></i> <span>${msg}</span> <a href="#" class="btn-upgrade-trigger" style="color: var(--brand-blue); font-weight: 700;">${t.peer_review_upgrade_link}</a>`;
      if (btn) btn.disabled = true;
    } else {
      const msg = t.peer_review_quota_remaining.replace('{n}', remaining !== null ? remaining : '-').replace('{limit}', limitLabel);
      badgeEl.innerHTML = `<i class="fa-solid fa-bolt" style="color: #059669;"></i> <span>${msg}</span>`;
      if (btn) btn.disabled = false;
    }
  }
  function updateCitationGraphAccess(user) {
    const badgeEl = document.getElementById('citationGraphQuotaBadge');
    if (!badgeEl || !user) return;

    const limitLabel = { free: '5x', premium: '20x', ultimate: '100x' }[user.type] || '5x';
    const remaining = typeof user.citationGraphRemaining === 'number' ? user.citationGraphRemaining : null;
    badgeEl.style.display = 'block';

    window.citationGraphLimitReached = !!user.isCitationGraphLimitReached;
    if (user.isCitationGraphLimitReached) {
      badgeEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #dc2626;"></i> Limit ${limitLabel}/bulan eksplorasi peta sitasi tercapai. <a href="#" class="btn-upgrade-trigger" style="color: var(--brand-blue); font-weight: 700;">Upgrade</a> untuk kuota lebih besar.`;
    } else {
      badgeEl.innerHTML = `<i class="fa-solid fa-bolt" style="color: #059669;"></i> Sisa ${remaining !== null ? remaining : '-'}x eksplorasi bulan ini (akun ${user.type}, limit ${limitLabel}/bulan).`;
    }
  }
  window.updateCitationGraphAccess = updateCitationGraphAccess;
  window.updatePeerReviewerAccess = updatePeerReviewerAccess;
  window.updatePatentSearchAccess = updatePatentSearchAccess;

  function updateSlrAccess(user) {
    const lock = document.getElementById('slrUltimateLock');
    if (!lock) return;

    if (!user) {
      lock.style.display = 'none';
      return;
    }

    const isEn = (window.currentLanguage === 'en');
    const isUltimate = user.type === 'ultimate';
    const isLimitReached = user.isSlrLimitReached;

    if (isUltimate) {
      lock.style.display = 'none';
    } else if (isLimitReached) {
      lock.style.display = 'flex';
      
      const titleEl = document.getElementById('slrLockTitle');
      const descEl = document.getElementById('slrLockDesc');
      const btnTextEl = document.getElementById('slrUpgradeBtnText');

      if (titleEl) {
        titleEl.textContent = isEn ? 'SLR Quota Limit Reached' : 'Limit Kuota SLR Tercapai';
      }

      if (descEl) {
        if (user.type === 'free') {
          descEl.textContent = isEn
            ? 'Free accounts are limited to 1 trial of Systematic Literature Review per month. Upgrade to Premium (5x/month) or Ultimate (Unlimited) to continue.'
            : 'Akun Free dibatasi 1x coba Systematic Literature Review per bulan. Upgrade ke Premium (5/bulan) atau Ultimate (Tanpa Batas) untuk melanjutkan.';
        } else {
          descEl.textContent = isEn
            ? 'Premium accounts are limited to 5 Systematic Literature Reviews per month. Upgrade to Ultimate for unlimited access.'
            : 'Akun Premium dibatasi 5x Systematic Literature Review per bulan. Upgrade ke Ultimate (Tanpa Batas) untuk akses tidak terbatas.';
        }
      }

      if (btnTextEl) {
        btnTextEl.textContent = isEn ? 'Upgrade Account' : 'Upgrade Akun';
      }
    } else {
      lock.style.display = 'none';
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
       chunk = activeJournals.slice(0, 3);
       isLimited = activeJournals.length > 3;
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
         <h3 style="margin-bottom: 0.5rem;">${isEn ? `${activeJournals.length - 3} More Journals Hidden` : `${activeJournals.length - 3} Jurnal Lainnya Disembunyikan`}</h3>
         <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.5rem;">${isEn ? 'Free account can only view the top 3 recommendations. Upgrade to PRO to view all results.' : 'Akun Free hanya dapat melihat 3 rekomendasi teratas. Tingkatkan ke PRO untuk melihat semua hasil.'}</p>
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
    const matchDisclosureWrapper = document.getElementById('matchDisclosureWrapper');

    if (journals.length === 0) {
      matchResultsContainer.innerHTML = `
        <div class="empty-state match-empty-state">
          <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
          <h3>Belum Ada Rekomendasi Cocok</h3>
          <p>Coba tambahkan keyword, bidang, atau abstrak yang lebih spesifik.</p>
        </div>
      `;
      matchResultsContainer.style.display = 'grid';
      if (matchDisclosureWrapper) matchDisclosureWrapper.style.display = 'none';
      return;
    }

    journals.forEach((journal, index) => {
      const card = document.createElement('div');
      const isOpenAlex = journal.source === 'openalex';
      card.className = `journal-card match-result-card ${isOpenAlex ? 'openalex' : journal.type.toLowerCase()}-card`;
      card.style.animationDelay = `${index * 0.04}s`;

      const typeBadgeClass = isOpenAlex ? 'type-openalex' : (journal.type === 'Scopus' ? 'type-scopus' : 'type-sinta');
      const typeIcon = isOpenAlex ? 'fa-solid fa-globe' : (journal.type === 'Scopus' ? 'fa-solid fa-globe' : 'fa-solid fa-medal');
      const rankBadgeClass = `rank-${journal.rank.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const apcClass = journal.isFree ? 'free' : 'paid';
      const matchReason = journal.matchReason ? `<p class="match-reason">${journal.matchReason}</p>` : '';

      card.innerHTML = `
        <div>
          <div class="card-header">
            <div class="card-badge-group">
              ${getMatchScoreBadge(journal.matchScore)}
              <span class="card-type-tag ${typeBadgeClass}" ${isOpenAlex ? 'title="Sumber: OpenAlex (belum diverifikasi status Scopus/Sinta)"' : ''}>
                <i class="${typeIcon}"></i>
                ${journal.type}
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span class="rank-badge ${rankBadgeClass}">${journal.rank}</span>
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

    matchResultsContainer.style.display = 'grid';
    if (matchDisclosureWrapper) matchDisclosureWrapper.style.display = 'block';
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

  // --- Sub-tab Database Jurnal: Database Utama / No APC Database ---
  // Keduanya sama-sama menampilkan grid 756 database lokal (dbSubtabMainWrap) -
  // bedanya cuma checkbox "Hanya Gratis" langsung dicentang otomatis untuk No APC,
  // jadi tidak perlu duplikasi seluruh pipeline render/filter.
  const dbSubtabMainBtn = document.getElementById('dbSubtabMainBtn');
  const dbSubtabNoApcBtn = document.getElementById('dbSubtabNoApcBtn');
  const checkFreeOnlyEl = document.getElementById('checkFreeOnly');

  function setActiveDbSubtab(tab) {
    [dbSubtabMainBtn, dbSubtabNoApcBtn].forEach(btn => {
      if (btn) btn.classList.toggle('active', btn.getAttribute('data-dbtab') === tab);
    });

    if (tab === 'noapc' && checkFreeOnlyEl && !checkFreeOnlyEl.checked) {
      checkFreeOnlyEl.checked = true;
      filterJournals();
    } else if (tab === 'main' && checkFreeOnlyEl && checkFreeOnlyEl.checked) {
      checkFreeOnlyEl.checked = false;
      filterJournals();
    }
  }

  if (dbSubtabMainBtn) dbSubtabMainBtn.addEventListener('click', () => setActiveDbSubtab('main'));
  if (dbSubtabNoApcBtn) dbSubtabNoApcBtn.addEventListener('click', () => setActiveDbSubtab('noapc'));

  // --- Cari Referensi: miniatur pencarian live OpenAlex ---
  const realtimeSearchInput = document.getElementById('realtimeSearchInput');
  const realtimeClearSearch = document.getElementById('realtimeClearSearch');
  const realtimeFilterType = document.getElementById('realtimeFilterType');
  const realtimeBooleanToggle = document.getElementById('realtimeBooleanToggle');
  const realtimeSearchBtn = document.getElementById('realtimeSearchBtn');
  const realtimeResultsContainer = document.getElementById('realtimeResultsContainer');
  const realtimeResultsCount = document.getElementById('realtimeResultsCount');

  if (realtimeSearchInput && realtimeClearSearch) {
    realtimeSearchInput.addEventListener('input', () => {
      realtimeClearSearch.style.display = realtimeSearchInput.value.length > 0 ? 'block' : 'none';
    });
    realtimeClearSearch.addEventListener('click', () => {
      realtimeSearchInput.value = '';
      realtimeClearSearch.style.display = 'none';
      realtimeSearchInput.focus();
    });
    realtimeSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runRealtimeSearch();
      }
    });
  }

  async function runRealtimeSearch() {
    if (!realtimeSearchInput || !realtimeResultsContainer) return;
    const t = TRANSLATIONS[window.currentLanguage || 'id'];
    const query = realtimeSearchInput.value.trim();
    if (!query || query.length < 3) {
      alert(t.realtime_min_chars_alert);
      realtimeSearchInput.focus();
      return;
    }

    const originalHtml = realtimeSearchBtn.innerHTML;
    realtimeSearchBtn.disabled = true;
    realtimeSearchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t.realtime_searching}`;
    realtimeResultsContainer.innerHTML = '';
    if (realtimeResultsCount) {
      realtimeResultsCount.textContent = t.realtime_searching;
      delete realtimeResultsCount.dataset.hasResults;
    }

    try {
      const params = new URLSearchParams({ q: query });
      const typeVal = realtimeFilterType ? realtimeFilterType.value : '';
      if (typeVal) params.set('type', typeVal);

      const res = await fetch(`/api/works/search-live?${params.toString()}`);
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (realtimeResultsCount) realtimeResultsCount.textContent = data.message || t.realtime_generic_error;
        return;
      }

      const works = data.works || [];
      if (works.length === 0) {
        if (realtimeResultsCount) realtimeResultsCount.textContent = t.realtime_no_results;
        return;
      }

      if (realtimeResultsCount) {
        realtimeResultsCount.textContent = t.realtime_showing_results.replace('{n}', works.length);
        realtimeResultsCount.dataset.hasResults = '1';
      }

      works.forEach((work, index) => {
        const card = document.createElement('div');
        card.className = 'journal-card openalex-card';
        card.style.animationDelay = `${index * 0.02}s`;
        const abstractSnippet = work.abstract
          ? (work.abstract.length > 180 ? work.abstract.slice(0, 180) + '…' : work.abstract)
          : '';
        card.innerHTML = `
          <div>
            <div class="card-header">
              <div class="card-badge-group">
                <span class="card-type-tag type-openalex" title="OpenAlex (real-time data)">
                  <i class="fa-solid fa-globe"></i> OpenAlex
                </span>
                ${work.isOpenAccess ? '<span class="card-type-tag" style="background: rgba(16,185,129,0.1); color:#10b981; border-color: rgba(16,185,129,0.2);">Open Access</span>' : ''}
              </div>
              <span class="rank-badge" style="background: rgba(139,92,246,0.1); color: #7c3aed; border: 1px solid rgba(139,92,246,0.2);">${work.citedByCount}${t.realtime_cited_suffix}</span>
            </div>
            <div class="card-body">
              <h3 class="journal-title" title="${escapeHtml(work.title)}">${escapeHtml(work.title)}</h3>
              <span class="journal-publisher"><i class="fa-regular fa-building"></i> ${escapeHtml(work.journal)} · ${escapeHtml(work.year)}</span>
              <p class="journal-desc">${escapeHtml(work.authors)}</p>
              ${abstractSnippet ? `<p class="journal-desc" style="margin-top: 0.4rem; font-style: italic;">"${escapeHtml(abstractSnippet)}"</p>` : ''}
            </div>
          </div>
          <div class="card-footer-wrapper">
            <div class="card-footer" style="margin-top: 1.25rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;">
              <a href="${work.url}" target="_blank" class="journal-link">${t.realtime_open_source} <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
              <button type="button" class="reset-filter-btn realtime-save-ref-btn" style="width: auto; padding: 0.4rem 0.8rem; font-size: 0.78rem;">
                <i class="fa-regular fa-bookmark"></i> Simpan
              </button>
            </div>
          </div>
        `;
        const saveBtn = card.querySelector('.realtime-save-ref-btn');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            if (window.openSaveReferenceModal) window.openSaveReferenceModal(work);
          });
        }
        realtimeResultsContainer.appendChild(card);
      });
    } catch (err) {
      console.error('[Realtime Database Search]', err);
      if (realtimeResultsCount) realtimeResultsCount.textContent = t.realtime_conn_error;
    } finally {
      realtimeSearchBtn.disabled = false;
      realtimeSearchBtn.innerHTML = originalHtml;
    }
  }

  // --- Pencarian Paten (Patsnap semantic search) ---
  const patentSearchInput = document.getElementById('patentSearchInput');
  const patentSearchBtn = document.getElementById('patentSearchBtn');
  const patentSearchStatus = document.getElementById('patentSearchStatus');
  const patentSearchSummary = document.getElementById('patentSearchSummary');
  const patentSearchResults = document.getElementById('patentSearchResults');

  async function runPatentSearch() {
    if (!patentSearchInput || !patentSearchResults) return;
    const t = TRANSLATIONS[window.currentLanguage || 'id'];
    const text = patentSearchInput.value.trim();
    if (text.length < 20) {
      alert(t.patent_search_min_chars_alert);
      patentSearchInput.focus();
      return;
    }

    const originalHtml = patentSearchBtn.innerHTML;
    patentSearchBtn.disabled = true;
    patentSearchBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t.patent_search_searching}`;
    patentSearchResults.innerHTML = '';
    if (patentSearchSummary) patentSearchSummary.style.display = 'none';
    if (patentSearchStatus) {
      patentSearchStatus.style.display = 'block';
      patentSearchStatus.textContent = t.patent_search_searching;
    }

    try {
      const res = await fetch('/api/patents/search-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (patentSearchStatus) patentSearchStatus.textContent = data.message || t.patent_search_generic_error;
        return;
      }

      const patents = data.patents || [];
      if (patentSearchStatus) patentSearchStatus.style.display = 'none';

      if (patents.length === 0) {
        if (patentSearchStatus) {
          patentSearchStatus.style.display = 'block';
          patentSearchStatus.textContent = t.patent_search_no_results;
        }
        return;
      }

      if (patentSearchSummary) {
        patentSearchSummary.style.display = 'block';
        patentSearchSummary.textContent = t.patent_search_summary.replace('{n}', patents.length).replace('{total}', data.totalCount);
      }

      patents.forEach((patent, index) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; animation-delay: ' + (index * 0.03) + 's;';

        const metaParts = [];
        if (patent.assignee) metaParts.push(`<i class="fa-regular fa-building"></i> ${escapeHtml(patent.assignee)}`);
        if (patent.publicationDate) metaParts.push(`<i class="fa-regular fa-calendar"></i> ${t.patent_search_published} ${escapeHtml(patent.publicationDate)}`);

        card.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span class="rank-badge" style="background: rgba(7,135,220,0.1); color: var(--brand-blue); border: 1px solid rgba(7,135,220,0.2); white-space: nowrap;">${escapeHtml(patent.relevancy)} ${t.patent_search_similar_badge}</span>
              <span style="font-weight: 700; font-family: monospace; font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(patent.patentNumber)}</span>
            </div>
            <a href="${patent.googlePatentsUrl}" target="_blank" rel="noopener" class="journal-link">${t.patent_search_view_detail} <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
          </div>
          <h3 class="journal-title" style="margin: 0;">${patent.title ? escapeHtml(patent.title) : `<span style="color: var(--text-muted); font-weight: 400;">${t.patent_search_no_title}</span>`}</h3>
          ${metaParts.length ? `<p class="journal-desc" style="margin: 0; display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.82rem;">${metaParts.join('')}</p>` : ''}
        `;
        patentSearchResults.appendChild(card);
      });

      fetch('/api/me').then(r => r.json()).then(meData => {
        if (meData.loggedIn && meData.user) {
          currentUser = meData;
          window.currentUser = meData;
          if (window.updatePatentSearchAccess) window.updatePatentSearchAccess(meData.user);
        }
      }).catch(() => {});
    } catch (err) {
      console.error('[Patent Search Live]', err);
      if (patentSearchStatus) {
        patentSearchStatus.style.display = 'block';
        patentSearchStatus.textContent = t.patent_search_generic_error;
      }
    } finally {
      patentSearchBtn.disabled = false;
      patentSearchBtn.innerHTML = originalHtml;
    }
  }

  if (patentSearchBtn) patentSearchBtn.addEventListener('click', runPatentSearch);

  // --- Citation Graph (Peta Sitasi) - powered by OpenAlex ---
  (function () {
    const searchInput = document.getElementById('citationGraphSearchInput');
    const searchBtn = document.getElementById('citationGraphSearchBtn');
    const searchStatus = document.getElementById('citationGraphSearchStatus');
    const searchResults = document.getElementById('citationGraphSearchResults');
    const workspace = document.getElementById('citationGraphWorkspace');
    const canvasEl = document.getElementById('citationGraphCanvas');
    const detailPanel = document.getElementById('citationGraphDetailPanel');
    const resetBtn = document.getElementById('citationGraphResetBtn');
    const zoomInBtn = document.getElementById('citationGraphZoomInBtn');
    const zoomOutBtn = document.getElementById('citationGraphZoomOutBtn');
    const fitBtn = document.getElementById('citationGraphFitBtn');
    const modeTopicBtn = document.getElementById('citationGraphModeTopic');
    const modeAuthorBtn = document.getElementById('citationGraphModeAuthor');
    const authorResultsHint = document.getElementById('citationGraphAuthorResultsHint');
    let searchMode = 'topic';
    let lastAuthorSearchResults = null;

    if (!searchInput || !searchBtn) return; // elemen tab belum ada di halaman ini

    const NODE_COLORS = { seed: '#0787dc', reference: '#34d399', citedBy: '#f59e0b', related: '#a78bfa' };
    // Parameter cose default terlalu rapat untuk 20-30 node - dilonggarkan supaya
    // node dan garis tidak saling tindih (jarak antar-node & gaya tolak diperbesar,
    // iterasi ditambah supaya sempat "settle" ke posisi yang lebih rapi).
    const COSE_LAYOUT_OPTIONS = {
      name: 'cose',
      fit: true,
      padding: 50,
      nodeRepulsion: 15000,
      idealEdgeLength: 100,
      nodeOverlap: 6,
      gravity: 0.35,
      numIter: 2000,
      componentSpacing: 120,
      randomize: true
    };
    const DETAIL_EMPTY_HTML = '<p style="color: var(--text-muted); font-size: 0.85rem; margin: 0;">Klik sebuah node di graf untuk melihat detailnya di sini.</p>';
    let cy = null;
    const expandedNodeIds = new Set();

    function shortTitle(title) {
      const t = String(title || '');
      return t.length > 60 ? t.slice(0, 57) + '...' : t;
    }

    function initGraph() {
      if (cy) return cy;
      if (typeof cytoscape === 'undefined') {
        canvasEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem;">Gagal memuat modul visualisasi graf. Periksa koneksi internet Anda lalu muat ulang halaman.</div>';
        return null;
      }
      // Label judul TIDAK ditampilkan permanen di setiap node - dengan puluhan node
      // sekaligus, teks di bawah tiap node saling tindih dan bikin graf tak
      // terbaca (lihat kaca hasil sebelumnya). Judul cuma muncul saat node
      // di-hover atau sedang dipilih (class "show-label" di-toggle lewat JS di
      // bawah); detail lengkap tetap selalu ada di panel kanan begitu diklik.
      cy = cytoscape({
        container: canvasEl,
        style: [
          { selector: 'node', style: {
              'background-color': (ele) => NODE_COLORS[ele.data('kind')] || '#94a3b8',
              'width': (ele) => 14 + Math.min(20, Math.sqrt(ele.data('citedByCount') || 0) / 1.4),
              'height': (ele) => 14 + Math.min(20, Math.sqrt(ele.data('citedByCount') || 0) / 1.4),
              'border-width': 2,
              'border-color': '#fff'
            }
          },
          { selector: 'node.show-label', style: {
              'label': 'data(shortTitle)',
              'font-size': 9,
              'font-weight': 700,
              'color': '#0f172a',
              'text-wrap': 'wrap',
              'text-max-width': '90px',
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-background-color': '#fff',
              'text-background-opacity': 0.85,
              'text-background-padding': '2px',
              'z-index': 999
            }
          },
          { selector: 'node[?expanded]', style: { 'border-color': '#0f172a', 'border-width': 3 } },
          { selector: 'edge', style: {
              'width': 1.2,
              'line-color': (ele) => NODE_COLORS[ele.data('kind')] || '#cbd5e1',
              'target-arrow-color': (ele) => NODE_COLORS[ele.data('kind')] || '#cbd5e1',
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.7,
              'curve-style': 'bezier',
              'opacity': 0.45
            }
          }
        ],
        layout: { name: 'cose' },
        // Default wheelSensitivity (1) kelewat agresif - 1x scroll notch langsung
        // lompat jauh dan terasa "kaku"/susah dikontrol presisi. Diperlembut ke
        // 0.25 supaya zoom lebih halus & bertahap, plus dibatasi rentangnya
        // supaya tidak bisa zoom sampai titik yang tidak berguna.
        wheelSensitivity: 0.25,
        minZoom: 0.15,
        maxZoom: 3
      });

      let pinnedLabelNode = null;
      cy.on('mouseover', 'node', (evt) => evt.target.addClass('show-label'));
      cy.on('mouseout', 'node', (evt) => {
        if (evt.target.id() !== (pinnedLabelNode && pinnedLabelNode.id())) evt.target.removeClass('show-label');
      });

      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        if (pinnedLabelNode) pinnedLabelNode.removeClass('show-label');
        node.addClass('show-label');
        pinnedLabelNode = node;
        renderDetailPanel(node.data());
        expandNode(node.data('id'));
      });

      return cy;
    }

    function addNodeToGraph(paper, kind) {
      if (!cy || cy.getElementById(paper.id).nonempty()) return;
      cy.add({ group: 'nodes', data: Object.assign({}, paper, { kind, shortTitle: shortTitle(paper.title) }) });
    }

    function addEdgeToGraph(sourceId, targetId, kind) {
      if (!cy) return;
      const edgeId = sourceId + '->' + targetId;
      if (cy.getElementById(edgeId).nonempty()) return;
      cy.add({ group: 'edges', data: { id: edgeId, source: sourceId, target: targetId, kind } });
    }

    const tldrCache = new Map(); // nodeId -> { en, id } atau { error }
    let currentDetailNodeId = null;

    function renderDetailPanel(data) {
      if (!detailPanel || !data) return;
      currentDetailNodeId = data.id;
      const oaBadge = data.isOpenAccess ? '<span style="background: rgba(52,211,153,0.12); color: #059669; padding: 0.15rem 0.5rem; border-radius: 20px; font-size: 0.7rem; font-weight: 700;">Open Access</span>' : '';
      detailPanel.innerHTML = `
        <h4 style="margin: 0; font-size: 0.98rem; line-height: 1.35;">${escapeHtml(data.title || '')}</h4>
        <p style="margin: 0; font-size: 0.82rem; color: var(--text-muted);">${escapeHtml(data.authors || '')}</p>
        <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(data.journal || '-')} &middot; ${escapeHtml(data.year || '-')}</p>
        <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted);"><i class="fa-solid fa-quote-right"></i> Disitasi ${data.citedByCount || 0}x ${oaBadge}</p>
        ${data.doi ? `<a href="https://doi.org/${escapeHtml(data.doi)}" target="_blank" rel="noopener" class="journal-link">Buka Paper <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
        <div id="citationGraphTldrBox" style="margin-top: 0.5rem; padding-top: 0.65rem; border-top: 1px solid var(--border-light-hover);"></div>
      `;
      renderTldrBox(data);
    }

    function renderTldrResult(box, result) {
      if (!box) return;
      if (result.error) {
        box.innerHTML = `<p style="margin:0; font-size:0.78rem; color:#dc2626;"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(result.error)}</p>`;
        return;
      }
      box.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:0.55rem;">
          <div>
            <span style="font-size:0.66rem; font-weight:800; text-transform:uppercase; letter-spacing:0.04em; color: var(--brand-blue);">TL;DR (English)</span>
            <p style="margin:0.2rem 0 0; font-size:0.82rem; line-height:1.45; color: var(--text-main);">${escapeHtml(result.en)}</p>
          </div>
          <div>
            <span style="font-size:0.66rem; font-weight:800; text-transform:uppercase; letter-spacing:0.04em; color:#f59e0b;">TL;DR (Bahasa Indonesia)</span>
            <p style="margin:0.2rem 0 0; font-size:0.82rem; line-height:1.45; color: var(--text-main);">${escapeHtml(result.id)}</p>
          </div>
        </div>
      `;
    }

    function renderTldrBox(data) {
      const box = document.getElementById('citationGraphTldrBox');
      if (!box) return;

      if (!data.abstract) {
        box.innerHTML = '<p style="margin:0; font-size:0.78rem; color:var(--text-muted); font-style:italic;">Abstrak tidak tersedia dari OpenAlex untuk paper ini - TL;DR tidak dapat dibuat.</p>';
        return;
      }

      const cached = tldrCache.get(data.id);
      if (cached) {
        renderTldrResult(box, cached);
        return;
      }

      box.innerHTML = '<p style="margin:0; font-size:0.78rem; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Membuat TL;DR (EN & ID)...</p>';

      fetch('/api/citation-graph/tldr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: data.title, abstract: data.abstract })
      })
        .then((r) => r.json())
        .then((result) => {
          if (currentDetailNodeId !== data.id) return; // user sudah pindah ke node lain
          const stored = result.ok ? { en: result.en, id: result.id } : { error: result.message || 'Gagal membuat TL;DR.' };
          tldrCache.set(data.id, stored);
          renderTldrResult(document.getElementById('citationGraphTldrBox'), stored);
        })
        .catch(() => {
          if (currentDetailNodeId !== data.id) return;
          const stored = { error: 'Gagal membuat TL;DR. Coba lagi.' };
          tldrCache.set(data.id, stored);
          renderTldrResult(document.getElementById('citationGraphTldrBox'), stored);
        });
    }

    async function expandNode(workId) {
      if (!cy || expandedNodeIds.has(workId)) return;
      if (window.citationGraphLimitReached) {
        alert('Limit bulanan eksplorasi peta sitasi Anda sudah tercapai. Upgrade untuk kuota lebih besar.');
        return;
      }
      expandedNodeIds.add(workId);
      const node = cy.getElementById(workId);
      if (node.nonempty()) node.data('expanded', true);

      try {
        const res = await fetch('/api/citation-graph/expand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workId })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          expandedNodeIds.delete(workId);
          if (data.message) alert(data.message);
          return;
        }

        (data.references || []).forEach((paper) => {
          addNodeToGraph(paper, 'reference');
          addEdgeToGraph(workId, paper.id, 'reference');
        });
        (data.citedBy || []).forEach((paper) => {
          addNodeToGraph(paper, 'citedBy');
          addEdgeToGraph(paper.id, workId, 'citedBy');
        });
        (data.related || []).forEach((paper) => {
          addNodeToGraph(paper, 'related');
          addEdgeToGraph(workId, paper.id, 'related');
        });

        cy.layout(Object.assign({}, COSE_LAYOUT_OPTIONS, { animate: true, animationDuration: 500 })).run();

        fetch('/api/me').then(r => r.json()).then(meData => {
          if (meData.loggedIn && meData.user) {
            window.currentUser = meData;
            if (window.updateCitationGraphAccess) window.updateCitationGraphAccess(meData.user);
          }
        }).catch(() => {});
      } catch (err) {
        expandedNodeIds.delete(workId);
        console.error('[Citation Graph Expand]', err);
        alert('Gagal memuat data sitasi. Coba lagi.');
      }
    }

    function startGraphWithSeed(paper) {
      if (!initGraph()) return;
      searchResults.innerHTML = '';
      searchResults.style.display = 'none';
      if (searchStatus) searchStatus.style.display = 'none';
      workspace.style.display = 'grid';
      expandedNodeIds.clear();
      cy.elements().remove();
      addNodeToGraph(paper, 'seed');
      cy.layout(COSE_LAYOUT_OPTIONS).run();
      renderDetailPanel(paper);
      expandNode(paper.id);
    }

    function setSearchMode(mode) {
      searchMode = mode;
      if (modeTopicBtn) modeTopicBtn.classList.toggle('active', mode === 'topic');
      if (modeAuthorBtn) modeAuthorBtn.classList.toggle('active', mode === 'author');
      searchInput.placeholder = mode === 'author'
        ? 'Cari nama penulis (mis. Yann LeCun)...'
        : 'Cari judul atau topik paper untuk mulai (mis. transformer neural network)...';
      searchInput.value = '';
      searchResults.innerHTML = '';
      searchResults.style.display = 'none';
      if (authorResultsHint) authorResultsHint.style.display = 'none';
      if (searchStatus) searchStatus.style.display = 'none';
      lastAuthorSearchResults = null;
    }
    if (modeTopicBtn) modeTopicBtn.addEventListener('click', () => setSearchMode('topic'));
    if (modeAuthorBtn) modeAuthorBtn.addEventListener('click', () => setSearchMode('author'));

    function renderPaperCards(papers) {
      searchResults.innerHTML = '';
      papers.forEach((paper) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'padding: 0.85rem 1rem; cursor: pointer; display: flex; flex-direction: column; gap: 0.25rem;';
        card.innerHTML = `
          <h4 style="margin: 0; font-size: 0.92rem;">${escapeHtml(paper.title)}</h4>
          <p style="margin: 0; font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(paper.authors)} &middot; ${escapeHtml(paper.year)} &middot; ${escapeHtml(paper.journal)} &middot; ${paper.citedByCount}x disitasi</p>
        `;
        card.addEventListener('click', () => startGraphWithSeed(paper));
        searchResults.appendChild(card);
      });
    }

    function renderAuthorCards(authors) {
      searchResults.innerHTML = '';
      authors.forEach((author) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'padding: 0.85rem 1rem; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;';
        card.innerHTML = `
          <div>
            <h4 style="margin: 0; font-size: 0.92rem;"><i class="fa-solid fa-user" style="color: var(--brand-blue); margin-right: 0.35rem;"></i>${escapeHtml(author.name)}</h4>
            <p style="margin: 0.15rem 0 0; font-size: 0.78rem; color: var(--text-muted);">${author.institution ? escapeHtml(author.institution) + ' &middot; ' : ''}${author.worksCount} paper &middot; ${author.citedByCount}x disitasi</p>
          </div>
          <i class="fa-solid fa-chevron-right" style="color: var(--text-muted);"></i>
        `;
        card.addEventListener('click', () => loadAuthorWorks(author));
        searchResults.appendChild(card);
      });
    }

    async function loadAuthorWorks(author) {
      searchResults.innerHTML = '';
      if (searchStatus) {
        searchStatus.style.display = 'block';
        searchStatus.textContent = `Memuat paper oleh ${author.name}...`;
      }
      try {
        const res = await fetch('/api/citation-graph/author-works?authorId=' + encodeURIComponent(author.id));
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (searchStatus) searchStatus.textContent = data.message || 'Gagal memuat paper penulis.';
          return;
        }

        const papers = data.results || [];
        if (searchStatus) searchStatus.style.display = 'none';
        if (papers.length === 0) {
          if (searchStatus) {
            searchStatus.style.display = 'block';
            searchStatus.textContent = `${author.name} tidak punya paper dengan abstrak yang bisa dipetakan.`;
          }
          return;
        }

        if (authorResultsHint) {
          authorResultsHint.style.display = 'block';
          authorResultsHint.innerHTML = `<a href="#" id="citationGraphBackToAuthors" style="color: var(--brand-blue); font-weight: 600;"><i class="fa-solid fa-arrow-left"></i> Kembali ke daftar penulis</a> &middot; Menampilkan paper oleh <strong>${escapeHtml(author.name)}</strong>`;
          const backLink = document.getElementById('citationGraphBackToAuthors');
          if (backLink) {
            backLink.addEventListener('click', (e) => {
              e.preventDefault();
              if (lastAuthorSearchResults) renderAuthorCards(lastAuthorSearchResults);
              if (authorResultsHint) authorResultsHint.style.display = 'none';
            });
          }
        }
        renderPaperCards(papers);
      } catch (err) {
        console.error('[Citation Graph Author Works]', err);
        if (searchStatus) {
          searchStatus.style.display = 'block';
          searchStatus.textContent = 'Gagal memuat paper penulis. Coba lagi.';
        }
      }
    }

    async function runCitationGraphSearch() {
      const query = (searchInput.value || '').trim();
      if (query.length < 3) {
        alert(searchMode === 'author' ? 'Masukkan nama penulis minimal 3 karakter.' : 'Masukkan judul atau kata kunci minimal 3 karakter.');
        searchInput.focus();
        return;
      }

      const originalHtml = searchBtn.innerHTML;
      searchBtn.disabled = true;
      searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mencari...';
      searchResults.innerHTML = '';
      searchResults.style.display = 'flex';
      if (authorResultsHint) authorResultsHint.style.display = 'none';
      if (searchStatus) {
        searchStatus.style.display = 'block';
        searchStatus.textContent = searchMode === 'author' ? 'Mencari penulis di OpenAlex...' : 'Mencari paper di OpenAlex...';
      }

      try {
        const endpoint = searchMode === 'author' ? '/api/citation-graph/search-author' : '/api/citation-graph/search';
        const res = await fetch(endpoint + '?q=' + encodeURIComponent(query));
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (searchStatus) searchStatus.textContent = data.message || 'Gagal mencari.';
          return;
        }

        const results = data.results || [];
        if (searchStatus) searchStatus.style.display = 'none';
        if (results.length === 0) {
          if (searchStatus) {
            searchStatus.style.display = 'block';
            searchStatus.textContent = 'Tidak ada hasil. Coba kata kunci lain.';
          }
          return;
        }

        if (searchMode === 'author') {
          lastAuthorSearchResults = results;
          renderAuthorCards(results);
        } else {
          renderPaperCards(results);
        }
      } catch (err) {
        console.error('[Citation Graph Search]', err);
        if (searchStatus) {
          searchStatus.style.display = 'block';
          searchStatus.textContent = 'Gagal mencari. Coba lagi.';
        }
      } finally {
        searchBtn.disabled = false;
        searchBtn.innerHTML = originalHtml;
      }
    }

    searchBtn.addEventListener('click', runCitationGraphSearch);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runCitationGraphSearch();
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        workspace.style.display = 'none';
        setSearchMode('topic');
        expandedNodeIds.clear();
        tldrCache.clear();
        currentDetailNodeId = null;
        if (cy) cy.elements().remove();
        if (detailPanel) detailPanel.innerHTML = DETAIL_EMPTY_HTML;
      });
    }

    // Tombol zoom manual - pelengkap scroll/pinch untuk yang merasa kontrol
    // wheel-zoom kurang presisi. Step 20% per klik, dizoom ke tengah kanvas.
    function zoomBy(factor) {
      if (!cy) return;
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: w / 2, y: h / 2 } });
    }
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomBy(1.25));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomBy(0.8));
    if (fitBtn) fitBtn.addEventListener('click', () => { if (cy) cy.fit(undefined, 40); });

    // Hook debug ringan - berguna untuk cek state graf lewat devtools console.
    window.__citationGraph = { getCy: () => cy };
  })();

  if (realtimeSearchBtn) realtimeSearchBtn.addEventListener('click', runRealtimeSearch);
  if (realtimeBooleanToggle) {
    realtimeBooleanToggle.addEventListener('change', () => {
      if (!realtimeSearchInput) return;
      const t = TRANSLATIONS[window.currentLanguage || 'id'];
      realtimeSearchInput.placeholder = realtimeBooleanToggle.checked
        ? t.realtime_search_placeholder_example
        : t.realtime_search_placeholder_normal;
    });
  }

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
  const draftDocType = document.getElementById('draftDocType');
  const draftTitle = document.getElementById('draftTitle');
  const draftAbstract = document.getElementById('draftAbstract');
  const draftSummary = document.getElementById('draftSummary');
  const draftResultsPanel = document.getElementById('draftResultsPanel');
  const draftSegmentsContainer = document.getElementById('draftSegmentsContainer');
  let currentGeneratedDraft = null;
  let currentDraftSegments = null; // metadata {key, label} dari server, sesuai docType yang dipilih
  let currentDraftDocType = 'jurnal';

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

      const docType = draftDocType ? draftDocType.value : 'jurnal';
      const abstract = draftAbstract.value.trim();
      // Form disederhanakan jadi satu kolom bebas - judul diturunkan otomatis dari
      // deskripsi topik (ditulis balik ke field draftTitle yang disembunyikan supaya
      // semua kode lain yang membaca draftTitle.value - ekspor .docx/.txt, dsb - tetap
      // konsisten tanpa perlu diubah).
      draftTitle.value = abstract.slice(0, 120);
      const title = draftTitle.value;

      if (!title || !abstract) {
        draftSummary.textContent = 'Harap jelaskan topik/rencana penelitian Anda terlebih dahulu.';
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
          body: JSON.stringify({ title, abstract, docType })
        });

        if (!response.ok) throw new Error('Gagal memproses draf panduan.');
        const resData = await response.json();

        if (resData.ok && resData.draft) {
          currentGeneratedDraft = resData.draft;
          currentDraftSegments = resData.segments || null;
          currentDraftDocType = resData.docType || docType;
          renderDraftGuide(resData.draft, currentDraftSegments);
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

  // Fallback default (jurnal IMRaD) kalau server belum mengembalikan metadata segments
  // (mis. respons lama sebelum fitur multi-jenis-dokumen ditambahkan).
  const DEFAULT_DRAFT_SEGMENTS = [
    { key: 'introduction', label: '1. Pendahuluan / Latar Belakang (Introduction / Background)' },
    { key: 'literature_review', label: '2. Tinjauan Pustaka / Landasan Teori (Literature Review)' },
    { key: 'method', label: '3. Metode Penelitian (Methodology)' },
    { key: 'results_discussion', label: '4. Hasil & Pembahasan (Results & Discussion)' },
    { key: 'conclusion', label: '5. Kesimpulan & Saran (Conclusion & Future Work)' }
  ];
  const DRAFT_SEGMENT_STYLES = [
    { icon: 'fa-book-open', color: '#60a5fa' },
    { icon: 'fa-book', color: '#34d399' },
    { icon: 'fa-flask', color: '#fbbf24' },
    { icon: 'fa-chart-pie', color: '#a78bfa' },
    { icon: 'fa-circle-check', color: '#f87171' }
  ];

  function renderDraftGuide(draft, segmentsMeta) {
    if (!draftSegmentsContainer) return;
    draftSegmentsContainer.innerHTML = '';

    const segments = (segmentsMeta && segmentsMeta.length ? segmentsMeta : DEFAULT_DRAFT_SEGMENTS).map((seg, idx) => ({
      ...seg,
      ...DRAFT_SEGMENT_STYLES[idx % DRAFT_SEGMENT_STYLES.length]
    }));

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

    revealWordsInElement(draftSegmentsContainer);
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

      const segments = currentDraftSegments && currentDraftSegments.length ? currentDraftSegments : DEFAULT_DRAFT_SEGMENTS;

      segments.forEach(seg => {
        textContent += `${seg.label.toUpperCase()}:\n`;
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

  // Ekspor panduan outline jadi file .docx berformat rapi - khusus akun Ultimate
  const exportDraftDocxBtn = document.getElementById('exportDraftDocxBtn');
  if (exportDraftDocxBtn) {
    exportDraftDocxBtn.addEventListener('click', async () => {
      if (!currentGeneratedDraft) return;

      const isUltimate = currentUser.user && currentUser.user.type === 'ultimate';
      if (!isUltimate) {
        const upgradeModal = document.getElementById('upgradeModal');
        if (upgradeModal) upgradeModal.classList.add('active');
        return;
      }

      const title = draftTitle.value.trim();
      const abstract = draftAbstract.value.trim();

      const originalHtml = exportDraftDocxBtn.innerHTML;
      exportDraftDocxBtn.disabled = true;
      exportDraftDocxBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membuat .docx...';

      try {
        const response = await fetch('/api/generate-template-draft/export-docx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, abstract, draft: currentGeneratedDraft, docType: currentDraftDocType })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          alert(data.message || 'Gagal membuat file .docx.');
          return;
        }

        const blob = await response.blob();
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `Panduan_Draft_${title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_')}.docx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (err) {
        console.error('[Export Draft DOCX] Error:', err);
        alert('Gagal menghubungi server untuk membuat file .docx.');
      } finally {
        exportDraftDocxBtn.disabled = false;
        exportDraftDocxBtn.innerHTML = originalHtml;
      }
    });
  }

  // Expose function to window
  window.renderTemplatesTab = renderTemplatesTab;

  // --- 5. INITIALIZATION ---
  async function init() {
    await checkAuthState();
    updateResearchChatGreeting();

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

    // --- Hapus Akun (Zona Berbahaya) - hak "right to erasure" UU PDP/GDPR ---
    const btnOpenDeleteAccount = document.getElementById('btnOpenDeleteAccount');
    const deleteAccountModal = document.getElementById('deleteAccountModal');
    const closeDeleteAccountModalBtn = document.getElementById('closeDeleteAccountModalBtn');
    const cancelDeleteAccountBtn = document.getElementById('cancelDeleteAccountBtn');
    const confirmDeleteAccountBtn = document.getElementById('confirmDeleteAccountBtn');
    const deleteAccountPasswordField = document.getElementById('deleteAccountPasswordField');
    const deleteAccountEmailField = document.getElementById('deleteAccountEmailField');
    const deleteAccountPassword = document.getElementById('deleteAccountPassword');
    const deleteAccountEmail = document.getElementById('deleteAccountEmail');
    const deleteAccountMessage = document.getElementById('deleteAccountMessage');

    function closeDeleteAccountModal() {
      if (deleteAccountModal) deleteAccountModal.classList.remove('active');
      if (deleteAccountPassword) deleteAccountPassword.value = '';
      if (deleteAccountEmail) deleteAccountEmail.value = '';
      if (deleteAccountMessage) {
        deleteAccountMessage.style.display = 'none';
        deleteAccountMessage.textContent = '';
      }
    }

    if (btnOpenDeleteAccount && deleteAccountModal) {
      btnOpenDeleteAccount.addEventListener('click', () => {
        // Akun Google tidak punya password lokal - minta ketik ulang email sebagai
        // gantinya (lihat hasPassword dari /api/me).
        const hasPassword = !!(currentUser && currentUser.user && currentUser.user.hasPassword);
        if (deleteAccountPasswordField) deleteAccountPasswordField.style.display = hasPassword ? 'block' : 'none';
        if (deleteAccountEmailField) deleteAccountEmailField.style.display = hasPassword ? 'none' : 'block';
        deleteAccountModal.classList.add('active');
      });
    }
    if (closeDeleteAccountModalBtn) closeDeleteAccountModalBtn.addEventListener('click', closeDeleteAccountModal);
    if (cancelDeleteAccountBtn) cancelDeleteAccountBtn.addEventListener('click', closeDeleteAccountModal);
    if (deleteAccountModal) {
      deleteAccountModal.addEventListener('click', (e) => {
        if (e.target === deleteAccountModal) closeDeleteAccountModal();
      });
    }

    if (confirmDeleteAccountBtn) {
      confirmDeleteAccountBtn.addEventListener('click', async () => {
        const hasPassword = !!(currentUser && currentUser.user && currentUser.user.hasPassword);
        const payload = hasPassword
          ? { password: deleteAccountPassword ? deleteAccountPassword.value : '' }
          : { confirmEmail: deleteAccountEmail ? deleteAccountEmail.value : '' };

        if (hasPassword && !payload.password) {
          deleteAccountMessage.textContent = 'Masukkan kata sandi Anda.';
          deleteAccountMessage.style.display = 'block';
          return;
        }
        if (!hasPassword && !payload.confirmEmail) {
          deleteAccountMessage.textContent = 'Ketik ulang email akun Anda.';
          deleteAccountMessage.style.display = 'block';
          return;
        }

        const originalHtml = confirmDeleteAccountBtn.innerHTML;
        confirmDeleteAccountBtn.disabled = true;
        confirmDeleteAccountBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menghapus...';
        if (deleteAccountMessage) deleteAccountMessage.style.display = 'none';

        try {
          const res = await fetch('/api/account/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            deleteAccountMessage.textContent = data.message || 'Gagal menghapus akun.';
            deleteAccountMessage.style.display = 'block';
            confirmDeleteAccountBtn.disabled = false;
            confirmDeleteAccountBtn.innerHTML = originalHtml;
            return;
          }
          alert('Akun Anda telah dihapus secara permanen. Terima kasih pernah menggunakan JurnalHub.');
          window.location.href = '/landing.html';
        } catch (err) {
          console.error('[Delete Account]', err);
          deleteAccountMessage.textContent = 'Gagal menghapus akun. Coba lagi.';
          deleteAccountMessage.style.display = 'block';
          confirmDeleteAccountBtn.disabled = false;
          confirmDeleteAccountBtn.innerHTML = originalHtml;
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
    let promptBankDataLang = null;
    let activePromptTab = 'scopus'; // 'scopus' atau 'tesis_disertasi'
    let activePromptStage = '';

    window.initPromptBankTab = async function(forceReload) {
      const lang = window.currentLanguage === 'en' ? 'en' : 'id';
      if (!promptBankData || promptBankDataLang !== lang || forceReload) {
        if (promptBankDataLang && promptBankDataLang !== lang) {
          // Kategori tersimpan berupa label string dalam bahasa lama - reset supaya
          // tidak nyangkut ke label yang sudah tidak ada setelah ganti bahasa.
          activePromptStage = '';
        }
        try {
          const res = await fetch(`/api/prompts?lang=${lang}`);
          if (!res.ok) throw new Error('Gagal memuat database prompt');
          const data = await res.json();
          if (data.ok) {
            promptBankData = {
              scopus: data.scopus || [],
              tesis_disertasi: data.tesis_disertasi || []
            };
            promptBankDataLang = lang;
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
    // Lit Review Standar/Pro mode toggle
    let litReviewMode = 'standard';
    const litModeStandardBtn = document.getElementById('litModeStandardBtn');
    const litModeProBtn = document.getElementById('litModeProBtn');
    const litModeInfoBtn = document.getElementById('litModeInfoBtn');
    const litModeInfoPopover = document.getElementById('litModeInfoPopover');

    function isUltimateUser() {
      return !!(currentUser && currentUser.user && currentUser.user.type === 'ultimate');
    }

    function setLitReviewMode(mode) {
      if (mode === 'pro' && !isUltimateUser()) {
        const upgradeModal = document.getElementById('upgradeModal');
        if (upgradeModal) upgradeModal.classList.add('active');
        return;
      }
      litReviewMode = mode;
      if (litModeStandardBtn) litModeStandardBtn.classList.toggle('active', mode === 'standard');
      if (litModeProBtn) litModeProBtn.classList.toggle('active', mode === 'pro');
    }

    if (litModeStandardBtn) litModeStandardBtn.addEventListener('click', () => setLitReviewMode('standard'));
    if (litModeProBtn) {
      litModeProBtn.classList.toggle('locked', !isUltimateUser());
      litModeProBtn.addEventListener('click', () => setLitReviewMode('pro'));
    }
    if (litModeInfoBtn && litModeInfoPopover) {
      litModeInfoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        litModeInfoPopover.style.display = litModeInfoPopover.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', (e) => {
        if (!litModeInfoPopover.contains(e.target) && e.target !== litModeInfoBtn) {
          litModeInfoPopover.style.display = 'none';
        }
      });
    }

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

        const abstract = abstractInput ? abstractInput.value.trim() : '';
        if (!abstract) {
          alert('Mohon jelaskan topik penelitian yang ingin dicari referensinya terlebih dahulu.');
          return;
        }
        // Form disederhanakan jadi satu kolom bebas - judul diturunkan otomatis dari
        // deskripsi topik (ditulis balik ke field litReviewTitle yang disembunyikan
        // supaya kode lain yang membaca litReviewTitle.value tetap konsisten).
        if (titleInput) titleInput.value = abstract.slice(0, 150);
        const title = titleInput ? titleInput.value : abstract.slice(0, 150);
        const keywords = keywordsInput ? keywordsInput.value.trim() : '';

        const originalBtnHtml = runLitReviewBtn.innerHTML;
        runLitReviewBtn.disabled = true;

        const resultsPanel = document.getElementById('litReviewResultsPanel');
        const textContainer = document.getElementById('litReviewTextContainer');
        const citationsContainer = document.getElementById('litReviewCitationsContainer');

        if (resultsPanel) resultsPanel.style.display = 'none';

        const stopStatus = startProcessingStatus(runLitReviewBtn, [
          'Mencari referensi ilmiah di web...',
          'Menganalisis studi terdahulu...',
          'Menyusun kerangka konseptual...',
          'Merangkum gap analysis & peluang novelty...',
          'Menyelesaikan draf tinjauan pustaka...'
        ]);

        try {
          const response = await fetch('/api/lit-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, keywords, abstract, mode: litReviewMode })
          });

          const data = await response.json();

          if (!response.ok) {
            alert(data.message || 'Terjadi kesalahan saat memproses data.');
            return;
          }

          // Update UI
          currentCitations = data.citations || [];
          if (textContainer) {
            const truncatedNote = data.truncated
              ? '<p style="background:#fef3c7; border:1px solid rgba(217,119,6,0.3); color:#92400e; padding:0.75rem 1rem; border-radius:8px; font-size:0.82rem; margin-bottom:1rem;"><i class="fa-solid fa-triangle-exclamation"></i> Respons AI terpotong sebelum selesai (output terlalu panjang). Bagian di bawah adalah hasil yang sempat didapat - coba generate ulang jika perlu hasil yang lebih lengkap.</p>'
              : '';
            textContainer.innerHTML = truncatedNote + (data.review || '<p>Tidak ada draf yang dihasilkan.</p>');
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

          revealWordsInElement(textContainer);
          revealWordsInElement(citationsContainer);

          // Sinkronisasi status limit terbaru
          justGeneratedLitReview = true;
          await checkAuthState();

        } catch (error) {
          console.error('[Lit Review UI] Error:', error);
          alert('Gagal menghubungi server untuk memproses literature review.');
        } finally {
          stopStatus();
          runLitReviewBtn.disabled = false;
          runLitReviewBtn.innerHTML = originalBtnHtml;
        }
      });
    }

    // --- AI PEER REVIEWER (DEDICATED TAB) ---
    const runPeerReviewerBtn = document.getElementById('runPeerReviewerBtn');
    const peerReviewTitle = document.getElementById('peerReviewTitle');
    const peerReviewTarget = document.getElementById('peerReviewTarget');
    const peerReviewText = document.getElementById('peerReviewText');
    const peerReviewUploadBtn = document.getElementById('peerReviewUploadBtn');
    const peerReviewFileInput = document.getElementById('peerReviewFileInput');
    const peerReviewFileChip = document.getElementById('peerReviewFileChip');
    const peerReviewFileName = document.getElementById('peerReviewFileName');
    const peerReviewFileRemoveBtn = document.getElementById('peerReviewFileRemoveBtn');
    const peerReviewResultsPanel = document.getElementById('peerReviewResultsPanel');
    const peerReviewContentEl = document.getElementById('peerReviewContentEl');
    const copyPeerReviewBtn = document.getElementById('copyPeerReviewBtn');

    if (peerReviewUploadBtn && peerReviewFileInput) {
      peerReviewUploadBtn.addEventListener('click', () => {
        peerReviewFileInput.click();
      });

      peerReviewFileInput.addEventListener('change', async () => {
        const file = peerReviewFileInput.files && peerReviewFileInput.files[0];
        if (!file) return;

        const maxUploadBytes = 1 * 1024 * 1024;
        if (file.size > maxUploadBytes) {
          alert(window.currentLanguage === 'en'
            ? 'File is too large. Maximum upload size is 1MB.'
            : 'Ukuran file terlalu besar. Maksimal unggah 1MB.');
          peerReviewFileInput.value = '';
          return;
        }

        const originalHtml = peerReviewUploadBtn.innerHTML;
        peerReviewUploadBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membaca Paper...';
        peerReviewUploadBtn.disabled = true;

        try {
          const formData = new FormData();
          formData.append('document', file);
          const res = await fetch('/api/research-chat/upload', { method: 'POST', body: formData });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            alert(data.message || 'Gagal mengunggah dokumen.');
            return;
          }

          if (peerReviewText) peerReviewText.value = data.text;
          if (peerReviewFileChip && peerReviewFileName) {
            peerReviewFileName.textContent = `${data.fileName} (${data.wordCount.toLocaleString('id-ID')} kata)`;
            peerReviewFileChip.style.display = 'inline-flex';
          }
        } catch (err) {
          console.error('[Peer Reviewer File Upload]', err);
          alert('Gagal mengekstrak dokumen paper.');
        } finally {
          peerReviewUploadBtn.innerHTML = originalHtml;
          peerReviewUploadBtn.disabled = false;
          peerReviewFileInput.value = '';
        }
      });
    }

    if (peerReviewFileRemoveBtn) {
      peerReviewFileRemoveBtn.addEventListener('click', () => {
        if (peerReviewFileChip) peerReviewFileChip.style.display = 'none';
        if (peerReviewText) peerReviewText.value = '';
      });
    }

    if (runPeerReviewerBtn) {
      runPeerReviewerBtn.addEventListener('click', async () => {
        const title = peerReviewTitle ? peerReviewTitle.value.trim() : '';
        const targetJournal = peerReviewTarget ? peerReviewTarget.value : 'Scopus Q1/Q2';
        const text = peerReviewText ? peerReviewText.value.trim() : '';

        if (!text && !title) {
          alert('Harap tempelkan draf naskah/abstrak Anda atau unggah file paper terlebih dahulu.');
          return;
        }

        const originalHtml = runPeerReviewerBtn.innerHTML;
        runPeerReviewerBtn.disabled = true;
        runPeerReviewerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mensimulasikan Reviewer AI...';
        if (peerReviewResultsPanel) peerReviewResultsPanel.style.display = 'none';

        try {
          const res = await fetch('/api/peer-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, abstract: text, text, targetJournal })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.message || 'Gagal melakukan evaluasi.');

          if (peerReviewContentEl) {
            peerReviewContentEl.innerHTML = renderPeerReviewReportHtml(data.review);
          }
          if (peerReviewResultsPanel) {
            peerReviewResultsPanel.style.display = 'block';
            peerReviewResultsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }

          fetch('/api/me').then(r => r.json()).then(meData => {
            if (meData.loggedIn && meData.user) {
              currentUser = meData;
              window.currentUser = meData;
              updatePeerReviewerAccess(meData.user);
              updateCitationGraphAccess(meData.user);
            }
          }).catch(() => {});
        } catch (err) {
          console.error('[AI Peer Reviewer Tab]', err);
          alert(err.message || 'Gagal memproses evaluasi.');
        } finally {
          runPeerReviewerBtn.disabled = false;
          runPeerReviewerBtn.innerHTML = originalHtml;
        }
      });
    }

    function renderPeerReviewReportHtml(rawMarkdown) {
      if (!rawMarkdown) return '';

      // Bersihkan sintaks markdown mentah yang berpotensi merusak layout
      let clean = rawMarkdown
        .replace(/###\s*\*\*([^*]+)\*\*/g, '### $1')
        .replace(/####\s*\*\*([^*]+)\*\*/g, '#### $1')
        .replace(/\*\*###\s*/g, '### ')
        .replace(/^\s*-{3,}\s*$/gm, '')
        .replace(/^\s*\*{3,}\s*$/gm, '');

      // renderMarkdownSafe() adalah parser markdown internal yang sama dipakai
      // chat biasa - tidak bergantung pada library eksternal `marked` yang
      // sebelumnya dipakai di sini padahal tidak pernah di-load, sehingga
      // sintaks mentah (###, **, ***) lolos apa adanya ke layar.
      let rawHtml = renderMarkdownSafe(clean);

      const temp = document.createElement('div');
      temp.innerHTML = rawHtml;

      const container = document.createElement('div');
      container.className = 'peer-review-report-container';

      let currentCard = null;

      Array.from(temp.childNodes).forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'h3') {
          currentCard = document.createElement('div');
          currentCard.className = 'peer-review-section-card';
          container.appendChild(currentCard);

          const h3 = document.createElement('h3');
          h3.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #059669; font-size: 1rem;"></i> ${node.textContent.replace(/\*/g, '').trim()}`;
          currentCard.appendChild(h3);
        } else {
          if (!currentCard) {
            currentCard = document.createElement('div');
            currentCard.className = 'peer-review-section-card';
            container.appendChild(currentCard);
          }
          currentCard.appendChild(node.cloneNode(true));
        }
      });

      // Style badge & highlight text di dalam container
      container.querySelectorAll('strong').forEach(strong => {
        strong.style.color = 'var(--text-main, #0b1a30)';
        strong.style.fontWeight = '700';
      });

      return container.innerHTML;
    }

    const downloadPeerReviewPdfBtn = document.getElementById('downloadPeerReviewPdfBtn');
    if (downloadPeerReviewPdfBtn) {
      downloadPeerReviewPdfBtn.addEventListener('click', () => {
        if (!peerReviewContentEl || !peerReviewContentEl.innerText.trim()) {
          alert('Belum ada laporan evaluasi untuk diunduh.');
          return;
        }
        const titleText = peerReviewTitle ? peerReviewTitle.value.trim() : 'Evaluasi_Naskah';
        const cleanTitle = titleText.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_') || 'Naskah';
        exportElementToPdf(peerReviewContentEl, `JurnalHub_Peer_Review_${cleanTitle}.pdf`);
      });
    }

    if (copyPeerReviewBtn) {
      copyPeerReviewBtn.addEventListener('click', () => {
        if (!peerReviewContentEl) return;
        const textToCopy = peerReviewContentEl.innerText || peerReviewContentEl.textContent;
        navigator.clipboard.writeText(textToCopy).then(() => {
          const originalText = copyPeerReviewBtn.innerHTML;
          copyPeerReviewBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
          setTimeout(() => { copyPeerReviewBtn.innerHTML = originalText; }, 2000);
        });
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

        if (typeof html2pdf === 'undefined') {
          alert('Gagal memuat modul PDF. Periksa koneksi internet Anda lalu coba lagi.');
          return;
        }

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
            revealTextIntoTextarea(humanizerOutputText, data.humanizedText);
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
    let activeQuickTool = null; // null | 'outline' | 'lit-review'
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

    let activeContextMenuEl = null;

    function closeActiveContextMenu() {
      if (activeContextMenuEl) {
        activeContextMenuEl.remove();
        activeContextMenuEl = null;
      }
    }

    document.addEventListener('click', (e) => {
      if (activeContextMenuEl && !e.target.closest('.research-chat-context-menu') && !e.target.closest('.history-action-btn.menu-btn')) {
        closeActiveContextMenu();
      }
    });

    // Ikon+warna pembeda untuk item riwayat AI tools (Journal Matcher/Outline
    // Generator/Lit Review/Humanizer/SLR) yang digabung ke Riwayat Percakapan,
    // supaya beda dari chat JurnalHub Intelligence biasa (fa-comment abu-abu).
    function historyKindIconMeta(kind) {
      switch (kind) {
        case 'match': return { icon: 'fa-solid fa-magnifying-glass-chart', color: '#38bdf8' };
        case 'draft': return { icon: 'fa-regular fa-file-lines', color: '#34d399' };
        case 'lit-review': return { icon: 'fa-solid fa-book-open-reader', color: '#a78bfa' };
        case 'humanizer': return { icon: 'fa-solid fa-wand-magic-sparkles', color: '#fbbf24' };
        case 'slr': return { icon: 'fa-solid fa-book-bookmark', color: '#f472b6' };
        default: return { icon: 'fa-regular fa-comment', color: 'rgba(255,255,255,0.6)' };
      }
    }

    function renderHistoryItemHtml(c) {
      const kind = c.kind || 'chat';
      if (kind !== 'chat') {
        const meta = historyKindIconMeta(kind);
        return `
          <button type="button" class="research-chat-history-item" data-conv-id="${c.id}" data-kind="${kind}">
            <i class="${meta.icon}" style="font-size: 0.85rem; color: ${meta.color}; flex-shrink: 0;"></i>
            <span class="research-chat-history-item-title">${escapeHtml(c.title)}</span>
          </button>
        `;
      }
      const isPinned = !!c.pinned;
      const isActive = c.id === currentResearchChatId;
      return `
        <button type="button" class="research-chat-history-item ${isActive ? 'active' : ''} ${isPinned ? 'is-pinned' : ''}" data-conv-id="${c.id}" data-kind="chat">
          <i class="fa-regular fa-comment" style="font-size: 0.85rem; color: rgba(255,255,255,0.6); flex-shrink: 0;"></i>
          <span class="research-chat-history-item-title">${escapeHtml(c.title)}</span>
          <div class="research-chat-history-item-actions">
            <span class="history-action-btn pin-btn ${isPinned ? 'pinned-active' : ''}" data-action-pin="${c.id}" title="${isPinned ? 'Lepas sematan' : 'Sematkan chat'}">
              <i class="fa-solid fa-thumbtack"></i>
            </span>
            <span class="history-action-btn menu-btn" data-action-menu="${c.id}" data-conv-title="${escapeHtml(c.title)}" data-conv-pinned="${isPinned}" title="Opsi">
              <i class="fa-solid fa-ellipsis"></i>
            </span>
          </div>
        </button>
      `;
    }

    // Gabungkan percakapan JurnalHub Intelligence dengan riwayat AI tools
    // (Journal Matcher/Outline Generator/Lit Review/Humanizer/SLR) jadi satu
    // daftar terurut - dipakai bareng oleh sidebar "Riwayat Percakapan" dan
    // chat search modal supaya keduanya konsisten menampilkan hal yang sama.
    async function fetchMergedSidebarHistory() {
      const [convData, histData] = await Promise.all([
        fetch('/api/research-chat/conversations').then(r => r.json()).catch(() => ({ ok: false })),
        fetch('/api/history').then(r => r.json()).catch(() => ({ ok: false }))
      ]);

      const conversations = convData.ok ? (convData.conversations || []) : [];
      const historyRaw = histData.ok ? (histData.history || []) : [];
      allHistory = historyRaw; // cache supaya showHistoryDetails(id) bisa langsung dipakai

      const chatItems = conversations.map(c => ({ id: c.id, title: c.title, pinned: !!c.pinned, updatedAt: c.updatedAt, kind: 'chat' }));
      const historyItems = historyRaw.map(h => ({
        id: h.id,
        title: berandaHistoryItemTitle(h, window.currentLanguage || 'id'),
        pinned: false,
        updatedAt: h.timestamp,
        kind: h.type
      }));

      return [...chatItems, ...historyItems].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    async function renderResearchChatHistoryList() {
      const pinnedSectionEl = document.getElementById('researchChatPinnedSection');
      const pinnedListEl = document.getElementById('researchChatPinnedList');
      if (!researchChatHistoryListEl) return;
      try {
        const merged = await fetchMergedSidebarHistory();
        const pinnedConvs = merged.filter(c => c.pinned);
        const unpinnedConvs = merged.filter(c => !c.pinned);

        if (pinnedSectionEl && pinnedListEl) {
          if (pinnedConvs.length > 0) {
            pinnedSectionEl.style.display = 'block';
            pinnedListEl.innerHTML = pinnedConvs.map(renderHistoryItemHtml).join('');
          } else {
            pinnedSectionEl.style.display = 'none';
            pinnedListEl.innerHTML = '';
          }
        }

        if (unpinnedConvs.length === 0 && pinnedConvs.length === 0) {
          researchChatHistoryListEl.innerHTML = '';
          if (researchChatHistoryEmptyEl) researchChatHistoryListEl.appendChild(researchChatHistoryEmptyEl);
          return;
        }

        researchChatHistoryListEl.innerHTML = unpinnedConvs.map(renderHistoryItemHtml).join('');
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

    async function togglePinConversation(id, currentPinned) {
      try {
        const res = await fetch(`/api/research-chat/conversations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: !currentPinned })
        });
        const data = await res.json();
        if (data.ok) renderResearchChatHistoryList();
      } catch (e) {
        console.error('Gagal memin percakapan:', e);
      }
    }

    async function renameConversation(id, oldTitle) {
      const newTitle = prompt('Masukkan nama baru untuk percakapan ini:', oldTitle);
      if (!newTitle || !newTitle.trim() || newTitle.trim() === oldTitle) return;
      try {
        const res = await fetch(`/api/research-chat/conversations/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle.trim() })
        });
        const data = await res.json();
        if (data.ok) renderResearchChatHistoryList();
      } catch (e) {
        alert('Gagal merename percakapan.');
      }
    }

    async function deleteConversation(id) {
      if (!confirm('Hapus percakapan ini secara permanen?')) return;
      try {
        const res = await fetch(`/api/research-chat/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          if (id === currentResearchChatId) {
            currentResearchChatId = null;
            researchChatMessages = [];
            renderResearchChatMessages();
          }
          renderResearchChatHistoryList();
        }
      } catch (e) {
        alert('Gagal menghapus percakapan.');
      }
    }

    function openContextMenu(btnEl, id, title, isPinned) {
      closeActiveContextMenu();
      const rect = btnEl.getBoundingClientRect();
      const menu = document.createElement('div');
      menu.className = 'research-chat-context-menu';
      
      const topPos = Math.min(rect.bottom + 4, window.innerHeight - 150);
      const leftPos = Math.min(rect.left, window.innerWidth - 180);

      menu.style.top = topPos + 'px';
      menu.style.left = leftPos + 'px';

      menu.innerHTML = `
        <button type="button" class="context-menu-item" data-action="rename">
          <i class="fa-regular fa-pen-to-square"></i> <span>Rename</span>
        </button>
        <button type="button" class="context-menu-item" data-action="pin">
          <i class="fa-solid fa-thumbtack"></i> <span>${isPinned ? 'Unpin chat' : 'Pin chat'}</span>
        </button>
        <button type="button" class="context-menu-item danger" data-action="delete">
          <i class="fa-regular fa-trash-can"></i> <span>Delete</span>
        </button>
      `;

      menu.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('.context-menu-item');
        if (!actionBtn) return;
        const action = actionBtn.getAttribute('data-action');
        closeActiveContextMenu();

        if (action === 'rename') renameConversation(id, title);
        else if (action === 'pin') togglePinConversation(id, isPinned);
        else if (action === 'delete') deleteConversation(id);
      });

      document.body.appendChild(menu);
      activeContextMenuEl = menu;
    }

    function handleHistoryListClick(e) {
      const pinBtn = e.target.closest('[data-action-pin]');
      if (pinBtn) {
        e.stopPropagation();
        const id = pinBtn.getAttribute('data-action-pin');
        const item = pinBtn.closest('.research-chat-history-item');
        const isPinned = item ? item.classList.contains('is-pinned') : false;
        togglePinConversation(id, isPinned);
        return;
      }

      const menuBtn = e.target.closest('[data-action-menu]');
      if (menuBtn) {
        e.stopPropagation();
        const id = menuBtn.getAttribute('data-action-menu');
        const title = menuBtn.getAttribute('data-conv-title');
        const isPinned = menuBtn.getAttribute('data-conv-pinned') === 'true';
        openContextMenu(menuBtn, id, title, isPinned);
        return;
      }

      const item = e.target.closest('.research-chat-history-item');
      if (item) {
        const id = item.getAttribute('data-conv-id');
        const kind = item.getAttribute('data-kind') || 'chat';
        if (kind !== 'chat') {
          if (window.openHistoryDetail) window.openHistoryDetail(id);
          return;
        }
        if (id !== currentResearchChatId) loadResearchChatConversation(id);
        if (window.switchTab) window.switchTab('research-chat');
      }
    }

    if (researchChatHistoryListEl) {
      researchChatHistoryListEl.addEventListener('click', handleHistoryListClick);
    }
    const pinnedListEl = document.getElementById('researchChatPinnedList');
    if (pinnedListEl) {
      pinnedListEl.addEventListener('click', handleHistoryListClick);
    }

    // --- Chat Search Modal (ala Claude/ChatGPT) - dipicu dari ikon kaca
    // pembesar di sidebar, mencari di seluruh riwayat percakapan lewat judul. ---
    (function initChatSearchModal() {
      const overlay = document.getElementById('chatSearchOverlay');
      const searchToggleBtn = document.getElementById('sidebarSearchToggle');
      const closeBtn = document.getElementById('chatSearchCloseBtn');
      const input = document.getElementById('chatSearchInput');
      const resultsEl = document.getElementById('chatSearchResults');
      if (!overlay || !searchToggleBtn || !input || !resultsEl) return;

      let allItems = [];
      let highlightedIndex = -1;

      function renderResults(list) {
        if (list.length === 0) {
          resultsEl.innerHTML = '<div class="chat-search-empty">Tidak ada percakapan atau riwayat yang cocok.</div>';
          highlightedIndex = -1;
          return;
        }
        resultsEl.innerHTML = list.map((c, i) => {
          const meta = historyKindIconMeta(c.kind);
          return `
            <button type="button" class="chat-search-result-item${i === 0 ? ' highlighted' : ''}" data-conv-id="${c.id}" data-kind="${c.kind}">
              <i class="${meta.icon}" style="color: ${c.kind === 'chat' ? '' : meta.color};"></i>
              <span class="chat-search-result-title">${escapeHtml(c.title)}</span>
              <span class="chat-search-result-time">${formatResearchChatRelativeTime(c.updatedAt)}</span>
            </button>
          `;
        }).join('');
        highlightedIndex = 0;
      }

      function filterAndRender() {
        const q = input.value.trim().toLowerCase();
        const filtered = q ? allItems.filter(c => c.title.toLowerCase().includes(q)) : allItems;
        renderResults(filtered);
      }

      function setHighlighted(index) {
        const items = resultsEl.querySelectorAll('.chat-search-result-item');
        if (items.length === 0) return;
        highlightedIndex = Math.max(0, Math.min(index, items.length - 1));
        items.forEach((it, i) => it.classList.toggle('highlighted', i === highlightedIndex));
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
      }

      function openModal() {
        overlay.classList.add('active');
        input.value = '';
        input.focus();
        resultsEl.innerHTML = '<div class="chat-search-empty">Memuat...</div>';
        fetchMergedSidebarHistory()
          .then(merged => {
            allItems = merged;
            filterAndRender();
          })
          .catch(() => {
            resultsEl.innerHTML = '<div class="chat-search-empty">Gagal memuat percakapan.</div>';
          });
      }

      function closeModal() {
        overlay.classList.remove('active');
      }

      function openResultItem(id, kind) {
        closeModal();
        if (kind !== 'chat') {
          if (window.openHistoryDetail) window.openHistoryDetail(id);
          return;
        }
        if (window.switchTab) window.switchTab('research-chat');
        if (id !== currentResearchChatId) loadResearchChatConversation(id);
      }

      searchToggleBtn.addEventListener('click', openModal);
      closeBtn.addEventListener('click', closeModal);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
      });
      input.addEventListener('input', filterAndRender);
      resultsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.chat-search-result-item');
        if (item) openResultItem(item.getAttribute('data-conv-id'), item.getAttribute('data-kind'));
      });

      document.addEventListener('keydown', (e) => {
        if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (overlay.classList.contains('active')) closeModal();
          else openModal();
          return;
        }
        if (!overlay.classList.contains('active')) return;
        if (e.key === 'Escape') {
          closeModal();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlighted(highlightedIndex + 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlighted(highlightedIndex - 1);
        } else if (e.key === 'Enter') {
          const items = resultsEl.querySelectorAll('.chat-search-result-item');
          if (highlightedIndex >= 0 && items[highlightedIndex]) {
            openResultItem(items[highlightedIndex].getAttribute('data-conv-id'), items[highlightedIndex].getAttribute('data-kind'));
          }
        }
      });
    })();

    // --- Modal "Create Folder" - dipakai bareng oleh tombol "Buat Folder Baru" di
    // flyout sidebar Koleksi Saya dan tombol "Buat Riset Baru" di halaman tab-nya.
    // window.openCreateFolderModal(onCreated) dipanggil dari kedua tempat itu
    // dengan callback berbeda (lihat initMyReferencesTab). ---
    (function initCreateFolderModal() {
      const overlay = document.getElementById('createFolderModal');
      const closeBtn = document.getElementById('closeCreateFolderModalBtn');
      const cancelBtn = document.getElementById('cancelCreateFolderBtn');
      const confirmBtn = document.getElementById('confirmCreateFolderBtn');
      const input = document.getElementById('createFolderInput');
      const errorEl = document.getElementById('createFolderError');
      if (!overlay || !input) return;

      let onCreatedCallback = null;

      function closeModal() {
        overlay.classList.remove('active');
      }

      window.openCreateFolderModal = function (onCreated) {
        onCreatedCallback = onCreated || null;
        input.value = '';
        if (errorEl) errorEl.style.display = 'none';
        overlay.classList.add('active');
        setTimeout(() => input.focus(), 50);
      };

      async function submitCreateFolder() {
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }
        if (errorEl) errorEl.style.display = 'none';
        try {
          const res = await fetch('/api/my-references/researches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (!data.ok) {
            if (errorEl) {
              errorEl.textContent = data.message || 'Gagal membuat folder baru.';
              errorEl.style.display = 'block';
            }
            return;
          }
          closeModal();
          if (onCreatedCallback) onCreatedCallback(data.research);
        } catch (err) {
          if (errorEl) {
            errorEl.textContent = 'Gagal menghubungi server.';
            errorEl.style.display = 'block';
          }
        }
      }

      if (closeBtn) closeBtn.addEventListener('click', closeModal);
      if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
      if (confirmBtn) confirmBtn.addEventListener('click', submitCreateFolder);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitCreateFolder();
        }
      });
    })();

    // --- Referensi Saya: modal "Simpan ke Riset" dipanggil dari tombol Simpan di
    // popover sitasi (showLitCitePopover, dipakai Lit Review/JurnalHub Intelligence/
    // SLR/Riwayat) maupun kartu hasil Cari Referensi. window.openSaveReferenceModal
    // dipanggil dari sana dengan data paper mentah (title/authors/journal/year/doi/
    // url/abstract/citedByCount/isOpenAccess - field mana pun yang tersedia). ---
    (function initSaveReferenceModal() {
      const overlay = document.getElementById('saveReferenceModal');
      const closeBtn = document.getElementById('closeSaveReferenceModalBtn');
      const paperTitleEl = document.getElementById('saveReferenceModalPaperTitle');
      const newResearchInput = document.getElementById('saveReferenceNewResearchInput');
      const createBtn = document.getElementById('saveReferenceCreateBtn');
      const listEl = document.getElementById('saveReferenceResearchList');
      const emptyHintEl = document.getElementById('saveReferenceEmptyHint');
      const messageEl = document.getElementById('saveReferenceMessage');
      if (!overlay || !listEl) return;

      let pendingPaper = null;

      function showMessage(text, isError) {
        if (!messageEl) return;
        messageEl.textContent = text;
        messageEl.style.color = isError ? '#dc2626' : '#059669';
        messageEl.style.display = 'block';
      }

      function renderResearchList(researches) {
        if (researches.length === 0) {
          listEl.innerHTML = '';
          if (emptyHintEl) emptyHintEl.style.display = 'block';
          return;
        }
        if (emptyHintEl) emptyHintEl.style.display = 'none';
        listEl.innerHTML = researches.map(r => `
          <button type="button" class="save-reference-research-item" data-research-id="${r.id}" style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; width: 100%; padding: 0.7rem 0.9rem; border: 1px solid var(--border-light-hover); background: var(--bg-card, #fff); border-radius: 8px; cursor: pointer; text-align: left; font-family: inherit; transition: all 0.15s;">
            <span style="font-weight: 700; font-size: 0.85rem; color: var(--text-main);"><i class="fa-solid fa-folder" style="color: var(--brand-blue); margin-right: 0.4rem;"></i>${escapeHtml(r.name)}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${r.referenceCount} paper</span>
          </button>
        `).join('');
      }

      async function loadResearches() {
        listEl.innerHTML = '<div style="text-align:center; padding: 1rem; color: var(--text-muted); font-size: 0.85rem;">Memuat...</div>';
        try {
          const res = await fetch('/api/my-references/researches');
          const data = await res.json();
          if (data.ok) renderResearchList(data.researches || []);
        } catch (err) {
          listEl.innerHTML = '<div style="text-align:center; padding: 1rem; color: #dc2626; font-size: 0.85rem;">Gagal memuat daftar riset.</div>';
        }
      }

      async function saveToResearch(researchId) {
        if (!pendingPaper) return;
        showMessage('Menyimpan & membuat ringkasan TL;DR...', false);
        try {
          const res = await fetch('/api/my-references', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              researchId,
              title: pendingPaper.title,
              authors: pendingPaper.authors,
              journal: pendingPaper.journal,
              year: pendingPaper.year,
              doi: pendingPaper.doi,
              url: pendingPaper.url,
              abstract: pendingPaper.abstract
            })
          });
          const data = await res.json();
          if (!data.ok) {
            showMessage(data.message || 'Gagal menyimpan referensi.', true);
            return;
          }
          showMessage('Tersimpan!', false);
          setTimeout(() => { overlay.classList.remove('active'); }, 700);
        } catch (err) {
          showMessage('Gagal menghubungi server.', true);
        }
      }

      window.openSaveReferenceModal = function (paper) {
        pendingPaper = paper;
        if (paperTitleEl) paperTitleEl.textContent = (paper && paper.title) || '-';
        if (newResearchInput) newResearchInput.value = '';
        if (messageEl) messageEl.style.display = 'none';
        overlay.classList.add('active');
        loadResearches();
      };

      if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('active');
      });

      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.save-reference-research-item');
        if (item) saveToResearch(item.getAttribute('data-research-id'));
      });

      async function createResearchAndSave() {
        const name = (newResearchInput.value || '').trim();
        if (!name) {
          newResearchInput.focus();
          return;
        }
        try {
          const res = await fetch('/api/my-references/researches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (!data.ok) {
            showMessage(data.message || 'Gagal membuat riset baru.', true);
            return;
          }
          newResearchInput.value = '';
          await loadResearches();
          if (pendingPaper) saveToResearch(data.research.id);
        } catch (err) {
          showMessage('Gagal menghubungi server.', true);
        }
      }

      if (createBtn) createBtn.addEventListener('click', createResearchAndSave);
      if (newResearchInput) {
        newResearchInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createResearchAndSave();
          }
        });
      }
    })();

    // --- Referensi Saya (tab): grid folder Riset -> tabel paper di dalamnya ---
    (function initMyReferencesTab() {
      const foldersView = document.getElementById('myRefFoldersView');
      const detailView = document.getElementById('myRefDetailView');
      const foldersGrid = document.getElementById('myRefFoldersGrid');
      const foldersEmpty = document.getElementById('myRefFoldersEmpty');
      const createResearchBtn = document.getElementById('myRefCreateResearchBtn');
      const backBtn = document.getElementById('myRefBackBtn');
      const detailTitle = document.getElementById('myRefDetailTitle');
      const renameBtn = document.getElementById('myRefRenameResearchBtn');
      const deleteResearchBtn = document.getElementById('myRefDeleteResearchBtn');
      const tableBody = document.getElementById('myRefTableBody');
      const tableEmpty = document.getElementById('myRefTableEmpty');
      if (!foldersGrid || !tableBody) return;

      let currentResearchId = null;
      let currentResearchName = '';

      function truncate(text, max) {
        if (!text) return '-';
        return text.length > max ? text.slice(0, max) + '…' : text;
      }

      async function loadMyReferencesFolders() {
        foldersGrid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: var(--text-muted);">Memuat...</div>';
        try {
          const res = await fetch('/api/my-references/researches');
          const data = await res.json();
          const researches = data.ok ? (data.researches || []) : [];
          if (researches.length === 0) {
            foldersGrid.innerHTML = '';
            if (foldersEmpty) foldersEmpty.style.display = 'block';
            return;
          }
          if (foldersEmpty) foldersEmpty.style.display = 'none';
          foldersGrid.innerHTML = researches.map(r => `
            <button type="button" class="my-ref-folder-card filter-box-card" data-research-id="${r.id}" data-research-name="${escapeHtml(r.name)}" style="text-align: left; cursor: pointer; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; font-family: inherit; border: 1px solid var(--border-light-hover);">
              <i class="fa-solid fa-folder" style="font-size: 1.5rem; color: var(--brand-blue);"></i>
              <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 0.95rem; color: var(--text-main); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(r.name)}</h4>
              <span style="font-size: 0.78rem; color: var(--text-muted);">${r.referenceCount} paper</span>
            </button>
          `).join('');
        } catch (err) {
          foldersGrid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 2rem; color: #dc2626;">Gagal memuat daftar riset.</div>';
        }
      }
      window.loadMyReferencesFolders = loadMyReferencesFolders;

      async function loadReferencesTable(researchId) {
        tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 2rem; color: var(--text-muted);">Memuat...</td></tr>`;
        if (tableEmpty) tableEmpty.style.display = 'none';
        try {
          const res = await fetch(`/api/my-references?researchId=${encodeURIComponent(researchId)}`);
          const data = await res.json();
          const references = data.ok ? (data.references || []) : [];
          if (references.length === 0) {
            tableBody.innerHTML = '';
            if (tableEmpty) tableEmpty.style.display = 'block';
            return;
          }
          tableBody.innerHTML = references.map(ref => `
            <tr data-ref-id="${ref.id}" style="border-bottom: 1px solid rgba(8,34,64,0.04);">
              <td style="padding: 0.85rem 1rem; vertical-align: top; max-width: 260px;">
                ${ref.url ? `<a href="${ref.url}" target="_blank" rel="noopener" style="font-weight: 700; color: var(--text-main); text-decoration: none;" title="${escapeHtml(ref.title)}">${escapeHtml(truncate(ref.title, 70))}</a>` : `<span style="font-weight: 700; color: var(--text-main);" title="${escapeHtml(ref.title)}">${escapeHtml(truncate(ref.title, 70))}</span>`}
              </td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; white-space: nowrap;"><i class="fa-solid fa-magnifying-glass" style="color: var(--text-muted); margin-right: 0.3rem;"></i>Journal Article</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-muted);">${escapeHtml(truncate(ref.authors, 40))}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-muted);">${escapeHtml(truncate(ref.journal, 30))}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-muted);">${escapeHtml(ref.year || '-')}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-muted); font-size: 0.78rem;">${ref.doi ? escapeHtml(ref.doi) : '-'}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-main); line-height: 1.4;" title="${escapeHtml(ref.tldrEn || '')}">${ref.tldrEn ? escapeHtml(truncate(ref.tldrEn, 100)) : '<span style="color: var(--text-muted);">-</span>'}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top; color: var(--text-main); line-height: 1.4;" title="${escapeHtml(ref.tldrId || '')}">${ref.tldrId ? escapeHtml(truncate(ref.tldrId, 100)) : '<span style="color: var(--text-muted);">-</span>'}</td>
              <td style="padding: 0.85rem 1rem; vertical-align: top;">
                <button type="button" class="my-ref-delete-btn" data-ref-id="${ref.id}" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 0.85rem;" title="Hapus dari riset ini">
                  <i class="fa-regular fa-trash-can"></i>
                </button>
              </td>
            </tr>
          `).join('');
        } catch (err) {
          tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding: 2rem; color: #dc2626;">Gagal memuat referensi.</td></tr>`;
        }
      }

      function openResearchDetail(id, name) {
        currentResearchId = id;
        currentResearchName = name;
        if (detailTitle) detailTitle.textContent = name;
        if (foldersView) foldersView.style.display = 'none';
        if (detailView) detailView.style.display = 'block';
        loadReferencesTable(id);
      }
      // Dipakai flyout "Koleksi Saya" di sidebar - klik folder di flyout langsung
      // pindah ke tab ini DAN buka folder tsb, tanpa transit ke grid folder dulu.
      window.openMyReferenceResearchDetail = openResearchDetail;

      function backToFolders() {
        if (foldersView) foldersView.style.display = 'block';
        if (detailView) detailView.style.display = 'none';
        loadMyReferencesFolders();
      }

      foldersGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.my-ref-folder-card');
        if (card) openResearchDetail(card.getAttribute('data-research-id'), card.getAttribute('data-research-name'));
      });

      if (backBtn) backBtn.addEventListener('click', backToFolders);

      if (createResearchBtn) {
        createResearchBtn.addEventListener('click', () => {
          if (window.openCreateFolderModal) {
            window.openCreateFolderModal(() => loadMyReferencesFolders());
          }
        });
      }

      if (renameBtn) {
        renameBtn.addEventListener('click', async () => {
          if (!currentResearchId) return;
          const newName = prompt('Nama baru untuk riset ini:', currentResearchName);
          if (!newName || !newName.trim() || newName.trim() === currentResearchName) return;
          try {
            const res = await fetch(`/api/my-references/researches/${encodeURIComponent(currentResearchId)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName.trim() })
            });
            const data = await res.json();
            if (!data.ok) {
              alert(data.message || 'Gagal mengganti nama riset.');
              return;
            }
            currentResearchName = newName.trim();
            if (detailTitle) detailTitle.textContent = currentResearchName;
          } catch (err) {
            alert('Gagal menghubungi server.');
          }
        });
      }

      if (deleteResearchBtn) {
        deleteResearchBtn.addEventListener('click', async () => {
          if (!currentResearchId) return;
          if (!confirm(`Hapus riset "${currentResearchName}" beserta seluruh referensi di dalamnya? Tindakan ini tidak dapat dibatalkan.`)) return;
          try {
            const res = await fetch(`/api/my-references/researches/${encodeURIComponent(currentResearchId)}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.ok) {
              alert(data.message || 'Gagal menghapus riset.');
              return;
            }
            backToFolders();
          } catch (err) {
            alert('Gagal menghubungi server.');
          }
        });
      }

      tableBody.addEventListener('click', async (e) => {
        const delBtn = e.target.closest('.my-ref-delete-btn');
        if (!delBtn) return;
        if (!confirm('Hapus paper ini dari riset?')) return;
        try {
          const res = await fetch(`/api/my-references/${encodeURIComponent(delBtn.getAttribute('data-ref-id'))}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.ok && currentResearchId) {
            loadReferencesTable(currentResearchId);
          }
        } catch (err) {
          alert('Gagal menghubungi server.');
        }
      });

      // --- Flyout sidebar "Koleksi Saya" - daftar folder dinamis + buat folder baru ---
      const flyoutList = document.getElementById('flyoutKoleksiSayaList');
      const flyoutEmpty = document.getElementById('flyoutKoleksiSayaEmpty');
      const flyoutNewBtn = document.getElementById('flyoutKoleksiSayaNewBtn');

      async function loadKoleksiSayaFlyout() {
        if (!flyoutList) return;
        try {
          const res = await fetch('/api/my-references/researches');
          const data = await res.json();
          const researches = data.ok ? (data.researches || []) : [];
          if (researches.length === 0) {
            flyoutList.innerHTML = '';
            if (flyoutEmpty) flyoutEmpty.style.display = 'block';
            return;
          }
          if (flyoutEmpty) flyoutEmpty.style.display = 'none';
          flyoutList.innerHTML = researches.map(r => `
            <button type="button" class="sidebar-flyout-folder-item" data-research-id="${r.id}" data-research-name="${escapeHtml(r.name)}">
              <span><i class="fa-solid fa-folder" style="margin-right: 0.5rem; color: var(--brand-blue);"></i>${escapeHtml(r.name)}</span>
              <span class="sidebar-flyout-folder-count">${r.referenceCount}</span>
            </button>
          `).join('');
        } catch (err) {
          flyoutList.innerHTML = '';
          if (flyoutEmpty) {
            flyoutEmpty.textContent = 'Gagal memuat folder.';
            flyoutEmpty.style.display = 'block';
          }
        }
      }
      window.loadKoleksiSayaFlyout = loadKoleksiSayaFlyout;

      if (flyoutList) {
        flyoutList.addEventListener('click', (e) => {
          const item = e.target.closest('.sidebar-flyout-folder-item');
          if (!item) return;
          if (window.switchTab) window.switchTab('koleksi-saya');
          openResearchDetail(item.getAttribute('data-research-id'), item.getAttribute('data-research-name'));
        });
      }

      if (flyoutNewBtn) {
        flyoutNewBtn.addEventListener('click', () => {
          if (window.openCreateFolderModal) {
            window.openCreateFolderModal((research) => {
              loadKoleksiSayaFlyout();
              if (window.switchTab) window.switchTab('koleksi-saya');
              openResearchDetail(research.id, research.name);
            });
          }
        });
      }
    })();

    function updateResearchChatGreeting() {
      const greetingEl = document.getElementById('researchChatGreeting');
      if (!greetingEl) return;
      const lang = window.currentLanguage || 'id';
      const user = currentUser && currentUser.user;
      const displayName = (user && user.name && user.name.trim())
        || (user && user.email && user.email.includes('@') && user.email.split('@')[0])
        || 'Peneliti';
      greetingEl.textContent = lang === 'en' ? `What do you want to write today, ${displayName}?` : `Mau nulis apa hari ini, ${displayName}?`;
    }

    function renderResearchChatMessages() {
      if (!researchChatMessagesEl) return;
      const t = TRANSLATIONS[window.currentLanguage || 'id'];
      const chatMainEl = document.querySelector('.research-chat-main');
      if (researchChatMessages.length === 0) {
        researchChatMessagesEl.innerHTML = '';
        if (researchChatEmptyState) {
          updateResearchChatGreeting();
          researchChatMessagesEl.appendChild(researchChatEmptyState);
        }
        if (chatMainEl) chatMainEl.classList.add('chat-empty');
        return;
      }
      if (chatMainEl) chatMainEl.classList.remove('chat-empty');
      const messagesHtml = researchChatMessages.map((m, idx) => {
        if (m.role === 'user') {
          return `<div class="research-chat-bubble user">${escapeHtml(m.content)}</div>`;
        }
        let bodyHtml = `<div class="chat-main-content">${renderMarkdownSafe(m.content)}</div>`;
        if (m.reasoning || m.thinking) {
          const thinkingText = m.reasoning || m.thinking;
          bodyHtml = `
            <details class="research-chat-thinking-block">
              <summary class="research-chat-thinking-summary">
                <span style="display: flex; align-items: center; gap: 0.4rem;">
                  <i class="fa-solid fa-brain" style="color: #8b5cf6;"></i>
                  <span>Proses Berpikir AI</span>
                </span>
                <i class="fa-solid fa-chevron-down thinking-chevron"></i>
              </summary>
              <div class="research-chat-thinking-body">
                ${renderMarkdownSafe(thinkingText)}
              </div>
            </details>
          ` + bodyHtml;
        }
        const hasCitations = Array.isArray(m.citations) && m.citations.length > 0;
        if (hasCitations) {
          bodyHtml = wrapCitationMarkers(bodyHtml, m.citations);
        }
        return `
          <div class="research-chat-assistant-block">
            <div class="research-chat-bubble assistant" id="researchChatMsgBody${idx}">${bodyHtml}</div>
            <div class="research-chat-msg-actions">
              <button class="research-chat-copy-btn" type="button" data-msg-index="${idx}" title="Salin jawaban">
                <i class="fa-regular fa-copy"></i> <span>Salin</span>
              </button>
              <button class="research-chat-disclosure-btn" type="button" data-msg-index="${idx}" title="Generate AI Disclosure Statement">
                <i class="fa-solid fa-file-shield"></i> <span>Disclosure</span>
              </button>
              <button class="research-chat-export-btn" type="button" data-msg-index="${idx}" data-export="pdf" title="${t.export_btn_pdf_title}">
                <i class="fa-solid fa-file-pdf"></i> <span>PDF</span>
              </button>
              <button class="research-chat-export-btn" type="button" data-msg-index="${idx}" data-export="docx" title="${t.export_btn_docx_title}">
                <i class="fa-solid fa-file-word"></i> <span>DOCX</span>
              </button>
              ${hasCitations ? `
              <button class="research-chat-export-btn" type="button" data-msg-index="${idx}" data-export="ris" title="${t.export_btn_ris_title}">
                <i class="fa-solid fa-book"></i> <span>.ris</span>
              </button>
              <button class="research-chat-export-btn" type="button" data-msg-index="${idx}" data-export="bib" title="${t.export_btn_bib_title}">
                <i class="fa-solid fa-book"></i> <span>.bib</span>
              </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      let warningBannerHtml = '';
      if (researchChatMessages.length >= 30) {
        const remaining = Math.max(0, 40 - researchChatMessages.length);
        const isEn = (window.currentLanguage === 'en');
        warningBannerHtml = `
          <div id="researchChatLimitWarningBanner" style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(217, 119, 6, 0.12)); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 12px; padding: 0.75rem 1rem; margin: 1rem 0 0.5rem 0; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; backdrop-filter: blur(4px);">
            <div style="display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; color: #b45309; font-weight: 700;">
              <i class="fa-solid fa-triangle-exclamation" style="font-size: 1.15rem; color: #d97706;"></i>
              <span>${isEn ? `This thread is approaching the limit (${researchChatMessages.length}/40 messages, ${remaining} left).` : `Percakapan ini mendekati batas thread (${researchChatMessages.length}/40 pesan, sisa ${remaining} pesan).`}</span>
            </div>
            <button type="button" id="btnSummarizeThread" style="background: linear-gradient(135deg, #f59e0b, #d97706); color: #ffffff; border: none; padding: 0.45rem 0.95rem; border-radius: 8px; font-size: 0.8rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 0.4rem; transition: all 0.2s; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.25);">
              <i class="fa-solid fa-wand-magic-sparkles"></i> <span>${isEn ? 'Summarize & Start New Chat' : 'Rangkum & Pindah Chat Baru'}</span>
            </button>
          </div>
        `;
      }

      researchChatMessagesEl.innerHTML = messagesHtml + warningBannerHtml;
      researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;

      const summarizeBtn = document.getElementById('btnSummarizeThread');
      if (summarizeBtn) {
        summarizeBtn.addEventListener('click', summarizeAndStartNewChat);
      }
    }

    async function summarizeAndStartNewChat() {
      if (!researchChatMessages || researchChatMessages.length === 0) return;

      const modal = document.getElementById('summarizeChatModal');
      const loader = document.getElementById('summarizeChatLoader');
      const textArea = document.getElementById('summarizeChatModalText');
      const copyBtn = document.getElementById('summarizeChatModalCopyBtn');
      const startNewBtn = document.getElementById('summarizeChatModalStartNewBtn');

      if (!modal || !textArea) return;

      modal.classList.add('active');
      if (loader) loader.style.display = 'block';
      textArea.style.display = 'none';
      textArea.value = '';

      try {
        const promptText = "Tolong buatkan Rangkuman Konteks Eksekutif (Context Summary) dari seluruh poin diskusi di atas secara padat dan jelas. Rangkuman ini akan digunakan sebagai konteks instruksi awal di sesi percakapan baru. Tuliskan dalam 2-3 paragraf ringkas yang mencakup: 1) Topik Utama & Latar Belakang Riset, 2) Temuan / Keputusan Penting yang telah didiskusikan, 3) Pertanyaan / Langkah selanjutnya.";
        
        const outgoingMessages = [...researchChatMessages, { role: 'user', content: promptText }];
        
        const response = await fetch('/api/research-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: outgoingMessages,
            conversationId: currentResearchChatId,
            modelType: selectedResearchModel,
            thinkingType: 'basic'
          })
        });

        if (!response.ok) throw new Error('Gagal merangkum percakapan.');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
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
              if (data.type === 'content') {
                contentText += data.content;
              }
            } catch (e) {}
          }
        }

        if (loader) loader.style.display = 'none';
        textArea.style.display = 'block';
        textArea.value = contentText.trim();
      } catch (err) {
        console.error('[Summarize Thread]', err);
        if (loader) loader.style.display = 'none';
        textArea.style.display = 'block';
        
        const userMsgs = researchChatMessages.filter(m => m.role === 'user').map(m => m.content).slice(-5).join(' | ');
        textArea.value = `Rangkuman Konteks Percakapan Sebelumnya:\nTopik Diskusi: ${userMsgs.slice(0, 300)}`;
      }

      if (startNewBtn) {
        startNewBtn.onclick = () => {
          modal.classList.remove('active');
          const summary = textArea.value.trim();
          
          currentResearchChatId = null;
          researchChatMessages = [];
          renderResearchChatMessages();

          if (researchChatInput) {
            researchChatInput.value = `Berikut adalah rangkuman konteks dari percakapan sebelumnya:\n\n${summary}\n\n---\n\nMari kita lanjutkan diskusi mengenai `;
            researchChatInput.focus();
            researchChatInput.style.height = 'auto';
            researchChatInput.style.height = Math.min(researchChatInput.scrollHeight, 180) + 'px';
          }
        };
      }

      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(textArea.value).then(() => {
            const origHtml = copyBtn.innerHTML;
            copyBtn.innerHTML = '<i class="fa-solid fa-check" style="color: #10b981;"></i> Tersalin!';
            setTimeout(() => { copyBtn.innerHTML = origHtml; }, 2000);
          });
        };
      }
    }

    const closeSummarizeModalBtn = document.getElementById('closeSummarizeChatModalBtn');
    if (closeSummarizeModalBtn) {
      closeSummarizeModalBtn.addEventListener('click', () => {
        const modal = document.getElementById('summarizeChatModal');
        if (modal) modal.classList.remove('active');
      });
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

      researchChatMessagesEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.research-chat-disclosure-btn');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-msg-index'), 10);
        const message = researchChatMessages[idx];
        if (!message) return;

        const modal = document.getElementById('aiDisclosureModal');
        const textarea = document.getElementById('aiDisclosureModalText');
        if (!modal || !textarea) return;

        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Membuat...</span>';

        try {
          const res = await fetch('/api/generate-ai-disclosure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              toolName: 'JurnalHub Intelligence (Prof Juju)',
              usageContext: 'to receive critical academic feedback and guidance on the manuscript\'s novelty, methodology, and overall quality during the research and writing process'
            })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            alert(data.message || 'Gagal membuat AI Disclosure Statement.');
            return;
          }
          textarea.value = data.statement;
          modal.classList.add('active');
        } catch (err) {
          console.error('[AI Disclosure Chat]', err);
          alert('Gagal menghubungi server untuk membuat AI Disclosure Statement.');
        } finally {
          btn.disabled = false;
          btn.innerHTML = originalHtml;
        }
      });
    }

    if (researchChatMessagesEl) {
      researchChatMessagesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.research-chat-export-btn');
        if (!btn) return;
        const idx = parseInt(btn.getAttribute('data-msg-index'), 10);
        const message = researchChatMessages[idx];
        if (!message) return;
        const exportType = btn.getAttribute('data-export');
        const citations = message.citations || [];
        // Lit Review sudah punya judul topiknya sendiri (litReviewTitle); untuk
        // jawaban chat biasa, pakai pertanyaan user tepat sebelum jawaban ini
        // sebagai judul file - lebih deskriptif daripada nama generik.
        const precedingUserMsg = [...researchChatMessages.slice(0, idx)].reverse().find(m => m.role === 'user');
        const titleText = message.litReviewTitle || (precedingUserMsg && precedingUserMsg.content.slice(0, 60)) || 'Jawaban JurnalHub Intelligence';
        const cleanTitle = titleText.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_') || 'Jawaban_JurnalHub_Intelligence';

        if (exportType === 'pdf') {
          exportElementToPdf(document.getElementById(`researchChatMsgBody${idx}`), `${cleanTitle}.pdf`);
          return;
        }

        if (exportType === 'docx') {
          exportElementToDocx(document.getElementById(`researchChatMsgBody${idx}`), escapeHtml(titleText), `${cleanTitle}.doc`);
          return;
        }

        if (exportType === 'ris') {
          if (citations.length === 0) { alert('Belum ada referensi untuk diekspor.'); return; }
          let risContent = '';
          citations.forEach(cit => {
            risContent += 'TY  - JOUR\r\n';
            risContent += `TI  - ${cit.title || 'Untitled'}\r\n`;
            if (cit.authors) {
              String(cit.authors).split(/,|&|dan/i).forEach(auth => {
                if (auth.trim()) risContent += `AU  - ${auth.trim()}\r\n`;
              });
            }
            if (cit.journal) risContent += `JO  - ${cit.journal}\r\n`;
            if (cit.year) risContent += `PY  - ${cit.year}\r\n`;
            if (cit.url) risContent += `UR  - ${cit.url}\r\n`;
            risContent += 'ER  - \r\n\r\n';
          });
          const blob = new Blob([risContent], { type: 'text/plain;charset=utf-8' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'Referensi_Kutipan.ris';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          return;
        }

        if (exportType === 'bib') {
          if (citations.length === 0) { alert('Belum ada referensi untuk diekspor.'); return; }
          let bibContent = '';
          citations.forEach((cit, i) => {
            const firstAuthor = cit.authors ? String(cit.authors).split(/,| /)[0].toLowerCase().replace(/[^a-z]/g, '') : 'author';
            const year = cit.year || '2026';
            const titleWord = cit.title ? String(cit.title).split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') : 'article';
            const citeKey = `${firstAuthor}${year}${titleWord}${i + 1}`;
            bibContent += `@article{${citeKey},\r\n`;
            bibContent += `  title = {${cit.title || 'Untitled'}},\r\n`;
            if (cit.authors) bibContent += `  author = {${cit.authors}},\r\n`;
            if (cit.journal) bibContent += `  journal = {${cit.journal}},\r\n`;
            if (cit.year) bibContent += `  year = {${cit.year}},\r\n`;
            if (cit.url) bibContent += `  url = {${cit.url}},\r\n`;
            bibContent += '}\r\n\r\n';
          });
          const blob = new Blob([bibContent], { type: 'text/plain;charset=utf-8' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'Referensi_Kutipan.bib';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }
      });
    }

    // Modal AI Disclosure Statement (dipakai oleh tombol Disclosure di chat)
    const aiDisclosureModal = document.getElementById('aiDisclosureModal');
    const closeAiDisclosureModalBtn = document.getElementById('closeAiDisclosureModalBtn');
    const aiDisclosureModalCopyBtn = document.getElementById('aiDisclosureModalCopyBtn');

    if (closeAiDisclosureModalBtn && aiDisclosureModal) {
      closeAiDisclosureModalBtn.addEventListener('click', (e) => {
        e.preventDefault();
        aiDisclosureModal.classList.remove('active');
      });
    }
    if (aiDisclosureModal) {
      aiDisclosureModal.addEventListener('click', (e) => {
        if (e.target === aiDisclosureModal) {
          aiDisclosureModal.classList.remove('active');
        }
      });
    }
    if (aiDisclosureModalCopyBtn) {
      aiDisclosureModalCopyBtn.addEventListener('click', () => {
        const textarea = document.getElementById('aiDisclosureModalText');
        if (!textarea) return;
        navigator.clipboard.writeText(textarea.value).then(() => {
          const originalHtml = aiDisclosureModalCopyBtn.innerHTML;
          aiDisclosureModalCopyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Tersalin!';
          setTimeout(() => { aiDisclosureModalCopyBtn.innerHTML = originalHtml; }, 1500);
        }).catch(() => {
          alert('Gagal menyalin teks.');
        });
      });
    }

    // Export PDF/DOCX generik dari sebuah elemen DOM - dipakai di riwayat Outline
    // Generator & Lit Review (dan bisa dipakai ulang di tempat lain nanti) supaya
    // tidak duplikasi logic html2pdf/blob .doc di banyak tempat.
    function exportElementToPdf(el, filename) {
      if (!el || !el.innerText.trim()) {
        alert('Tidak ada konten untuk diunduh.');
        return;
      }
      if (typeof html2pdf === 'undefined') {
        alert('Gagal memuat modul PDF. Periksa koneksi internet Anda lalu coba lagi.');
        return;
      }
      html2pdf().set({
        margin: 1,
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
      }).from(el).save();
    }

    function exportElementToDocx(el, title, filename) {
      if (!el || !el.innerText.trim()) {
        alert('Tidak ada konten untuk diunduh.');
        return;
      }
      const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
                     "xmlns:w='urn:schemas-microsoft-com:office:word' " +
                     "xmlns='http://www.w3.org/TR/REC-html40'>" +
                     "<head><title>" + title + "</title><style>body { font-family: Arial, sans-serif; line-height: 1.6; } h1, h2, h3 { color: #0b1a30; }</style></head><body>" +
                     "<h2>" + title + "</h2>";
      const footer = "</body></html>";
      const blob = new Blob(['﻿' + header + el.innerHTML + footer], { type: 'application/msword;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    // Konversi HTML hasil Lit Review (tag h4/p/table/li dst) jadi markdown ringkas
    // yang dipahami renderMarkdownSafe() (yang mem-escape HTML mentah demi keamanan,
    // jadi tag asli tidak bisa dikirim langsung ke situ).
    function convertResultHtmlToMarkdown(html) {
      let text = String(html || '');
      text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (m, inner) => {
        const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r =>
          [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim())
        );
        if (rows.length === 0) return '';
        const [header, ...body] = rows;
        const lines = [
          '| ' + header.join(' | ') + ' |',
          '| ' + header.map(() => '---').join(' | ') + ' |',
          ...body.map(r => '| ' + r.join(' | ') + ' |')
        ];
        return '\n' + lines.join('\n') + '\n';
      });
      return text
        .replace(/<h[1-6][^>]*>/gi, '\n### ')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/li>/gi, '')
        .replace(/<\/(p|div)>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<strong>/gi, '**').replace(/<\/strong>/gi, '**')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Ubah marker sitasi "[n]" (dituliskan model sesuai nomor urut paper di
    // daftar yang diberikan, lihat systemPrompt Lit Review di server) jadi span
    // yang bisa di-hover, supaya user bisa lihat kartu preview paper & klik ke
    // sumber aslinya tanpa harus scroll ke daftar Referensi di bawah.
    function wrapCitationMarkers(html, citations) {
      if (!citations || citations.length === 0) return html;
      return html.replace(/\[(\d{1,2})\]/g, (match, numStr) => {
        const idx = parseInt(numStr, 10) - 1;
        if (idx < 0 || idx >= citations.length) return match;
        return `<span class="lit-cite-marker" data-cite-idx="${idx}" tabindex="0">${match}</span>`;
      });
    }

    // Kartu preview sitasi (satu elemen dipakai ulang untuk semua marker) - muncul
    // saat hover/focus ke marker [n], mirip Consensus/Elicit.
    let litCitePopoverEl = null;
    let litCitePopoverHideTimer = null;
    let currentPopoverCitation = null;
    function ensureLitCitePopover() {
      if (litCitePopoverEl) return litCitePopoverEl;
      litCitePopoverEl = document.createElement('div');
      litCitePopoverEl.id = 'litCitePopover';
      litCitePopoverEl.className = 'lit-cite-popover';
      document.body.appendChild(litCitePopoverEl);
      // Ada jarak (gap) antara marker [n] dan kartu popover di atas/bawahnya -
      // begitu mouse lewat jarak itu, event mouseout marker langsung nutup popover
      // sebelum sempat masuk ke kartunya. Kartu sendiri juga perlu jadi "zona aman":
      // batalkan timer tutup saat mouse ada di dalam kartu, jadwalkan lagi saat keluar.
      litCitePopoverEl.addEventListener('mouseenter', cancelLitCitePopoverHide);
      litCitePopoverEl.addEventListener('mouseleave', scheduleLitCitePopoverHide);
      litCitePopoverEl.addEventListener('click', (e) => {
        if (e.target.closest('.lit-cite-popover-save-btn') && currentPopoverCitation && window.openSaveReferenceModal) {
          window.openSaveReferenceModal(currentPopoverCitation);
        }
      });
      return litCitePopoverEl;
    }

    function cancelLitCitePopoverHide() {
      if (litCitePopoverHideTimer) {
        clearTimeout(litCitePopoverHideTimer);
        litCitePopoverHideTimer = null;
      }
    }

    function scheduleLitCitePopoverHide() {
      cancelLitCitePopoverHide();
      litCitePopoverHideTimer = setTimeout(() => {
        if (litCitePopoverEl) litCitePopoverEl.style.display = 'none';
        litCitePopoverHideTimer = null;
      }, 500);
    }

    function showLitCitePopover(markerEl, citation) {
      cancelLitCitePopoverHide();
      currentPopoverCitation = citation;
      const pop = ensureLitCitePopover();
      const t = TRANSLATIONS[window.currentLanguage || 'id'];
      const abstractText = citation.abstract
        ? (citation.abstract.length > 200 ? citation.abstract.slice(0, 200) + '…' : citation.abstract)
        : '';
      pop.innerHTML = `
        <div class="lit-cite-popover-title">${escapeHtml(citation.title || t.cite_popover_no_title)}</div>
        ${abstractText ? `<div class="lit-cite-popover-abstract">"${escapeHtml(abstractText)}"</div>` : ''}
        <div class="lit-cite-popover-meta">
          <span>${escapeHtml(citation.year || '-')}</span>
          ${typeof citation.citedByCount === 'number' ? `<span>· ${citation.citedByCount} ${t.cite_popover_citations_suffix}</span>` : ''}
          ${citation.isOpenAccess ? `<span class="lit-cite-popover-oa">· Open Access</span>` : ''}
        </div>
        <div class="lit-cite-popover-authors">${escapeHtml(citation.authors || '')}</div>
        <div class="lit-cite-popover-journal">${escapeHtml(citation.journal || '-')}</div>
        <div class="lit-cite-popover-actions">
          ${citation.url ? `<a href="${citation.url}" target="_blank" rel="noopener" class="lit-cite-popover-link">${t.cite_popover_open_source} <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
          ${citation.pdfUrl ? `<a href="${citation.pdfUrl}" target="_blank" rel="noopener" class="lit-cite-popover-pdf" title="${t.cite_popover_pdf_title}"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : ''}
          <button type="button" class="lit-cite-popover-save-btn"><i class="fa-regular fa-bookmark"></i> Simpan</button>
        </div>
      `;
      pop.style.display = 'block';

      const rect = markerEl.getBoundingClientRect();
      const popWidth = 300;
      let left = rect.left + window.scrollX;
      if (left + popWidth > window.innerWidth - 12) {
        left = window.innerWidth - popWidth - 12 + window.scrollX;
      }
      pop.style.width = popWidth + 'px';
      pop.style.left = Math.max(12, left) + 'px';

      // Coba taruh di atas marker dulu; kalau ruangnya kurang, taruh di bawah.
      const popHeightEstimate = pop.offsetHeight || 160;
      const spaceAbove = rect.top;
      // Jarak ke marker dibikin kecil (bukan 10px) supaya makin sedikit "zona mati"
      // yang harus dilewati mouse sebelum sampai ke kartu - dikombinasikan dengan
      // grace period di scheduleLitCitePopoverHide().
      if (spaceAbove > popHeightEstimate + 16) {
        pop.style.top = (rect.top + window.scrollY - popHeightEstimate - 4) + 'px';
      } else {
        pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
      }
    }

    if (researchChatMessagesEl) {
      researchChatMessagesEl.addEventListener('mouseover', (e) => {
        const marker = e.target.closest('.lit-cite-marker');
        if (!marker) return;
        const block = marker.closest('.research-chat-assistant-block');
        const msgIndex = block ? parseInt(block.querySelector('[data-msg-index]')?.getAttribute('data-msg-index'), 10) : NaN;
        const message = researchChatMessages[msgIndex];
        const idx = parseInt(marker.getAttribute('data-cite-idx'), 10);
        if (!message || !message.citations || !message.citations[idx]) return;
        showLitCitePopover(marker, message.citations[idx]);
      });
      researchChatMessagesEl.addEventListener('focusin', (e) => {
        const marker = e.target.closest('.lit-cite-marker');
        if (!marker) return;
        marker.dispatchEvent(new Event('mouseover', { bubbles: true }));
      });
      researchChatMessagesEl.addEventListener('mouseout', (e) => {
        const marker = e.target.closest('.lit-cite-marker');
        if (!marker) return;
        if (e.relatedTarget && litCitePopoverEl && litCitePopoverEl.contains(e.relatedTarget)) return;
        scheduleLitCitePopoverHide();
      });
      researchChatMessagesEl.addEventListener('focusout', (e) => {
        const marker = e.target.closest('.lit-cite-marker');
        if (!marker) return;
        scheduleLitCitePopoverHide();
      });
    }

    function setActiveQuickTool(tool) {
      activeQuickTool = tool;
      const chip = document.getElementById('researchChatToolChip');
      const chipText = document.getElementById('researchChatToolChipText');
      const chipIcon = document.getElementById('researchChatToolChipIcon');
      const outlineBtn = document.getElementById('researchChatToolOutlineBtn');
      const litReviewBtn = document.getElementById('researchChatToolLitReviewBtn');
      const deepLitReviewBtn = document.getElementById('researchChatToolDeepLitReviewBtn');
      const outlineDocTypeSelect = document.getElementById('researchChatOutlineDocType');
      if (outlineBtn) outlineBtn.classList.toggle('active', tool === 'outline');
      if (litReviewBtn) litReviewBtn.classList.toggle('active', tool === 'lit-review');
      if (deepLitReviewBtn) deepLitReviewBtn.classList.toggle('active', tool === 'deep-lit-review');
      if (outlineDocTypeSelect) outlineDocTypeSelect.style.display = tool === 'outline' ? 'inline-block' : 'none';

      const t = TRANSLATIONS[window.currentLanguage || 'id'];
      if (tool && chip) {
        chip.style.display = 'flex';
        if (tool === 'outline') {
          if (chipIcon) chipIcon.className = 'fa-solid fa-wand-magic-sparkles';
          if (chipText) chipText.textContent = t.quicktool_outline_chip;
          if (researchChatInput) researchChatInput.placeholder = t.quicktool_outline_placeholder;
        } else if (tool === 'deep-lit-review') {
          if (chipIcon) chipIcon.className = 'fa-solid fa-layer-group';
          if (chipText) chipText.textContent = t.quicktool_deeplit_chip;
          if (researchChatInput) researchChatInput.placeholder = t.quicktool_deeplit_placeholder;
        } else {
          if (chipIcon) chipIcon.className = 'fa-solid fa-book-open';
          if (chipText) chipText.textContent = t.quicktool_litreview_chip;
          if (researchChatInput) researchChatInput.placeholder = t.quicktool_litreview_placeholder;
        }
      } else if (chip) {
        chip.style.display = 'none';
        if (researchChatInput) researchChatInput.placeholder = t.research_chat_input_placeholder;
      }
    }
    window.setActiveQuickTool = setActiveQuickTool;

    // Outline Generator & Lit Review & Peer Reviewer dipanggil langsung dari chat (bukan lewat
    // /api/research-chat) - hasilnya dirender sebagai bubble asisten biasa dan ikut
    // masuk ke researchChatMessages, jadi tetap jadi konteks untuk follow-up prompt
    // berikutnya (dan otomatis tersimpan ke riwayat begitu user kirim chat normal
    // berikutnya, karena server menyimpan seluruh array messages yang dikirim).
    async function sendQuickToolMessage(tool, text) {
      // Ambil jenis dokumen yang dipilih SEBELUM setActiveQuickTool(null) menyembunyikan
      // dropdown-nya - selectnya cuma tampil saat mode outline aktif.
      const outlineDocTypeSelect = document.getElementById('researchChatOutlineDocType');
      const selectedDocType = outlineDocTypeSelect ? outlineDocTypeSelect.value : 'jurnal';

      let fullPayloadText = text;
      if (typeof researchChatAttachment !== 'undefined' && researchChatAttachment) {
        fullPayloadText = `[Dokumen terlampir: ${researchChatAttachment.fileName}]\n\n${researchChatAttachment.text}\n\n${text}`.trim();
        window.removeResearchChatAttachment();
      }

      researchChatMessages.push({ role: 'user', content: text });
      researchChatInput.value = '';
      researchChatInput.style.height = 'auto';
      renderResearchChatMessages();
      setActiveQuickTool(null);

      const loadingBubble = document.createElement('div');
      loadingBubble.className = 'research-chat-bubble loading';
      researchChatMessagesEl.appendChild(loadingBubble);
      researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;

      const quickToolStatusMessages = {
        outline: [
          'Menganalisis topik/rencana penelitian Anda...',
          'Menyusun kerangka sesuai struktur dokumen...',
          'Merapikan poin-poin per bab...'
        ],
        'lit-review': [
          'Mencari paper ilmiah relevan di OpenAlex...',
          'Menyaring paper paling relevan...',
          'Menyusun narasi tinjauan pustaka...',
          'Merangkai daftar referensi...'
        ],
        'deep-lit-review': [
          'Mencari paper ilmiah relevan di OpenAlex...',
          'Memperkaya data lewat Semantic Scholar...',
          'Menyusun tabel kerangka konseptual...',
          'Menganalisis gap penelitian & peluang novelty...',
          'Merangkai daftar referensi...'
        ]
      };
      const stopQuickToolStatus = startProcessingStatus(loadingBubble, quickToolStatusMessages[tool] || quickToolStatusMessages['lit-review'], 2500);

      researchChatSendBtn.disabled = true;
      const originalBtnHtml = researchChatSendBtn.innerHTML;
      researchChatSendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

      try {
        let resultMarkdown;
        let litReviewCitations = null;
        if (tool === 'outline') {
          const res = await fetch('/api/generate-template-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: fullPayloadText.slice(0, 120), abstract: fullPayloadText, docType: selectedDocType })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.message || 'Gagal membuat outline.');
          const segments = data.segments || [];
          const docTypeLabel = { jurnal: 'Jurnal Ilmiah (IMRaD)', tesis: 'Tesis', disertasi: 'Disertasi' }[selectedDocType] || 'Jurnal Ilmiah (IMRaD)';
          resultMarkdown = `### Outline Generator - ${docTypeLabel}\n\n` + segments.map(seg => {
            const points = (data.draft && data.draft[seg.key]) || [];
            return `#### ${seg.label}\n` + points.map(p => `- ${p}`).join('\n');
          }).join('\n\n');
        } else {
          const isDeep = tool === 'deep-lit-review';
          const res = await fetch('/api/lit-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: fullPayloadText.slice(0, 150), keywords: '', abstract: fullPayloadText, mode: isDeep ? 'pro' : 'standard' })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.message || 'Gagal membuat literature review.');
          const citationsList = data.citations || [];
          const citations = citationsList.map((c, i) => `${i + 1}. **${c.title}** - ${c.authors} (${c.year}). ${c.url}`).join('\n');
          resultMarkdown = `### ${isDeep ? 'Deep Lit Review' : 'Literature Review'}\n\n${convertResultHtmlToMarkdown(data.review)}` + (citations ? `\n\n#### Referensi\n${citations}` : '');
          litReviewCitations = citationsList;
        }

        loadingBubble.remove();
        const assistantMsg = { role: 'assistant', content: resultMarkdown };
        if (tool !== 'outline' && litReviewCitations && litReviewCitations.length > 0) {
          assistantMsg.citations = litReviewCitations;
          assistantMsg.litReviewTitle = text.slice(0, 60);
        }
        researchChatMessages.push(assistantMsg);
        renderResearchChatMessages();

        const assistantContents = researchChatMessagesEl.querySelectorAll('.research-chat-bubble.assistant .chat-main-content');
        const lastContentEl = assistantContents[assistantContents.length - 1];
        if (lastContentEl) revealWordsInElement(lastContentEl, { tickMs: 20, targetDurationMs: 1600 });

        justGeneratedDraft = true;
        justGeneratedLitReview = true;
        await checkAuthState();
      } catch (error) {
        console.error('[Research Chat Quick Tool]', error);
        loadingBubble.remove();
        researchChatMessages.pop();
        renderResearchChatMessages();
        alert(error.message || 'Gagal memproses permintaan.');
        researchChatInput.value = text;
      } finally {
        stopQuickToolStatus();
        researchChatSendBtn.disabled = false;
        researchChatSendBtn.innerHTML = originalBtnHtml;
      }
    }

    async function sendResearchChatMessage() {
      if (!researchChatInput) return;
      const rawInputText = researchChatInput.value.trim();
      const hasAttachment = typeof researchChatAttachment !== 'undefined' && researchChatAttachment;
      if ((!rawInputText && !hasAttachment) || researchChatSendBtn.disabled) return;

      const text = rawInputText || (hasAttachment ? `Mohon analisis dokumen terlampir: ${researchChatAttachment.fileName}` : '');

      if (activeQuickTool) {
        return sendQuickToolMessage(activeQuickTool, text);
      }

      researchChatMessages.push({ role: 'user', content: text });
      researchChatInput.value = '';
      researchChatInput.style.height = 'auto';
      renderResearchChatMessages();

      // Bubble loading sementara menunggu token pertama dari stream - pesan berganti
      // tiap beberapa detik supaya user tahu ini masih berjalan, bukan macet/error.
      const loadingBubble = document.createElement('div');
      loadingBubble.className = 'research-chat-bubble loading';
      researchChatMessagesEl.appendChild(loadingBubble);
      researchChatMessagesEl.scrollTop = researchChatMessagesEl.scrollHeight;

      const chatStatusList = [
        '🔍 Mencari referensi & paper ilmiah di OpenAlex...',
        '🌐 Memetakan konteks & publikasi terkait...',
        '🧠 Melakukan analisis & penalaran mendalam...',
        '✍️ Menyusun balasan berstandar akademik...'
      ];
      if (typeof researchChatAttachment !== 'undefined' && researchChatAttachment) {
        chatStatusList.unshift(`📄 Membaca & mengekstraksi isi dokumen (${researchChatAttachment.fileName})...`);
      }
      const stopChatStatus = startProcessingStatus(loadingBubble, chatStatusList, 2200);

      researchChatSendBtn.disabled = true;
      const originalBtnHtml = researchChatSendBtn.innerHTML;
      researchChatSendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

      // conversationId dibuat sekali di sini kalau ini pesan pertama percakapan baru,
      // supaya server bisa membuat entri riwayat baru begitu balasan pertama selesai.
      if (!currentResearchChatId) {
        currentResearchChatId = (crypto.randomUUID ? crypto.randomUUID() : `conv_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      }

      // Kalau ada dokumen terlampir, sisipkan isinya HANYA di payload request kali
      // ini (bukan disimpan permanen di researchChatMessages) - supaya dokumen besar
      // tidak ikut ke-resend berulang-ulang di setiap giliran chat berikutnya.
      let outgoingMessages = researchChatMessages;
      if (typeof researchChatAttachment !== 'undefined' && researchChatAttachment) {
        const lastIdx = researchChatMessages.length - 1;
        outgoingMessages = researchChatMessages.map((m, idx) => {
          if (idx === lastIdx && m.role === 'user') {
            return {
              role: 'user',
              content: `[Dokumen terlampir: ${researchChatAttachment.fileName}]\n\n${researchChatAttachment.text}\n\n---\n\nPertanyaan pengguna: ${m.content}`
            };
          }
          return m;
        });
      }

      try {
        const response = await fetch('/api/research-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: outgoingMessages,
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
        let streamCitations = null;

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
              } else if (data.type === 'citations') {
                streamCitations = data.citations;
              }
            } catch (e) {
              // Abaikan line parsial yang corrupt
            }
          }

          let html = '';
          if (thinkingText) {
            const isOpen = !contentText; // Tetap terbuka selama contentText belum mulai masuk
            html += `
              <details class="research-chat-thinking-block" ${isOpen ? 'open' : ''}>
                <summary class="research-chat-thinking-summary">
                  <span style="display: flex; align-items: center; gap: 0.4rem;">
                    <i class="fa-solid fa-brain ${isOpen ? 'fa-pulse' : ''}" style="color: #8b5cf6;"></i>
                    <span>${isOpen ? 'Proses Berpikir AI (Sedang Menganalisis...)' : 'Proses Berpikir AI'}</span>
                  </span>
                  <i class="fa-solid fa-chevron-down thinking-chevron"></i>
                </summary>
                <div class="research-chat-thinking-body">
                  ${renderMarkdownSafe(thinkingText)}
                </div>
              </details>
            `;
          }

          if (contentText) {
            html += `<div class="chat-main-content">${renderMarkdownSafe(contentText)}</div>`;
          }

          assistantBubbleEl.innerHTML = html || '<div style="color: var(--text-muted); font-size: 0.85rem; font-weight: 600; padding: 0.25rem 0;"><i class="fa-solid fa-spinner fa-spin" style="color: var(--brand-blue); margin-right: 0.4rem;"></i> Menyiapkan jawaban...</div>';
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

        const newAssistantMsg = { role: 'assistant', content: contentText };
        if (thinkingText) {
          newAssistantMsg.reasoning = thinkingText;
        }
        if (streamCitations && streamCitations.length > 0) {
          newAssistantMsg.citations = streamCitations;
        }
        researchChatMessages.push(newAssistantMsg);
        // Re-render penuh supaya bubble sementara diganti struktur final (dengan tombol salin)
        renderResearchChatMessages();
        // Percakapan baru saja disimpan/diperbarui di server - refresh daftar riwayat
        renderResearchChatHistoryList();
        // Lampiran dokumen cuma berlaku sekali pakai per pesan - bersihkan setelah terkirim
        if (typeof window.removeResearchChatAttachment === 'function') {
          window.removeResearchChatAttachment();
        }

        // Refresh kuota tampilan setelah 1 pesan terpakai (khusus Premium)
        fetch('/api/me').then(r => r.json()).then(meData => {
          if (meData.loggedIn && meData.user) {
            currentUser = meData;
            updateResearchChatAccess(meData.user);
            updateSlrAccess(meData.user);
            updatePatentSearchAccess(meData.user);
            updatePeerReviewerAccess(meData.user);
            updateCitationGraphAccess(meData.user);
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
        stopChatStatus();
        researchChatSendBtn.disabled = false;
        researchChatSendBtn.innerHTML = originalBtnHtml;
      }
    }

    if (researchChatSendBtn) {
      researchChatSendBtn.addEventListener('click', sendResearchChatMessage);
    }

    const researchChatToolOutlineBtn = document.getElementById('researchChatToolOutlineBtn');
    const researchChatToolLitReviewBtn = document.getElementById('researchChatToolLitReviewBtn');
    const researchChatToolDeepLitReviewBtn = document.getElementById('researchChatToolDeepLitReviewBtn');
    const researchChatToolChipRemoveBtn = document.getElementById('researchChatToolChipRemoveBtn');
    // Outline Generator & Lit Review (standar) terbuka untuk semua tier (Free dijatah
    // 3x/bulan lewat kuota server) - hanya Deep Lit Review yang eksklusif Ultimate.
    function isDeepLitReviewLockedForUser() {
      return !(currentUser && currentUser.user && currentUser.user.type === 'ultimate');
    }
    if (researchChatToolOutlineBtn) {
      researchChatToolOutlineBtn.addEventListener('click', () => {
        setActiveQuickTool(activeQuickTool === 'outline' ? null : 'outline');
        if (researchChatInput) researchChatInput.focus();
      });
    }
    if (researchChatToolLitReviewBtn) {
      researchChatToolLitReviewBtn.addEventListener('click', () => {
        setActiveQuickTool(activeQuickTool === 'lit-review' ? null : 'lit-review');
        if (researchChatInput) researchChatInput.focus();
      });
    }
    if (researchChatToolDeepLitReviewBtn) {
      researchChatToolDeepLitReviewBtn.addEventListener('click', () => {
        if (isDeepLitReviewLockedForUser()) {
          const upgradeModal = document.getElementById('upgradeModal');
          if (upgradeModal) upgradeModal.classList.add('active');
          return;
        }
        setActiveQuickTool(activeQuickTool === 'deep-lit-review' ? null : 'deep-lit-review');
        if (researchChatInput) researchChatInput.focus();
      });
    }
    if (researchChatToolChipRemoveBtn) {
      researchChatToolChipRemoveBtn.addEventListener('click', () => setActiveQuickTool(null));
    }

    const sidebarLogoHomeLink = document.getElementById('sidebarLogoHomeLink');
    if (sidebarLogoHomeLink) {
      sidebarLogoHomeLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.switchTab) window.switchTab('research-chat');
      });
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
        // Tombol ini sekarang persisten di sidebar utama (bisa diklik dari tab manapun),
        // bukan cuma di dalam tab JurnalHub Intelligence - jadi pastikan pindah ke sana.
        if (window.switchTab) window.switchTab('research-chat');
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
        if (!isResearchChatProUser) return; // terkunci - klik ditangkap oleh listener global .btn-upgrade-trigger
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
        if (!isResearchChatProUser) return; // terkunci - klik ditangkap oleh listener global .btn-upgrade-trigger
        selectedResearchMode = 'thinking';
        pillModeThinking.classList.add('active');
        pillModeBasic.classList.remove('active');
      });
    }

    // --- Lampiran Dokumen (Premium/Ultimate saja) ---
    let researchChatAttachment = null; // { fileName, wordCount, text }
    const researchChatAttachBtn = document.getElementById('researchChatAttachBtn');
    const researchChatFileInput = document.getElementById('researchChatFileInput');
    const researchChatAttachmentChip = document.getElementById('researchChatAttachmentChip');
    const researchChatAttachmentName = document.getElementById('researchChatAttachmentName');
    const researchChatAttachmentRemoveBtn = document.getElementById('researchChatAttachmentRemoveBtn');

    window.removeResearchChatAttachment = function() {
      researchChatAttachment = null;
      if (researchChatFileInput) researchChatFileInput.value = '';
      if (researchChatAttachmentChip) researchChatAttachmentChip.style.display = 'none';
    };

    if (researchChatAttachBtn && researchChatFileInput) {
      researchChatAttachBtn.addEventListener('click', () => {
        if (!isResearchChatProUser) return; // terkunci - klik ditangkap oleh listener global .btn-upgrade-trigger
        closeResearchChatPlusMenu();
        researchChatFileInput.click();
      });

      researchChatFileInput.addEventListener('change', async () => {
        const file = researchChatFileInput.files && researchChatFileInput.files[0];
        if (!file) return;

        const maxUploadBytes = 1 * 1024 * 1024;
        if (file.size > maxUploadBytes) {
          alert(window.currentLanguage === 'en'
            ? 'File is too large. Maximum upload size is 1MB.'
            : 'Ukuran file terlalu besar. Maksimal unggah 1MB.');
          researchChatFileInput.value = '';
          return;
        }

        const originalHtml = researchChatAttachBtn.innerHTML;
        researchChatAttachBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + (window.currentLanguage === 'en' ? 'Uploading...' : 'Mengunggah...');
        researchChatAttachBtn.disabled = true;

        try {
          const formData = new FormData();
          formData.append('document', file);
          const res = await fetch('/api/research-chat/upload', { method: 'POST', body: formData });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            alert(data.message || (window.currentLanguage === 'en' ? 'Failed to upload document.' : 'Gagal mengunggah dokumen.'));
            return;
          }
          researchChatAttachment = { fileName: data.fileName, wordCount: data.wordCount, text: data.text };
          if (researchChatAttachmentChip && researchChatAttachmentName) {
            researchChatAttachmentName.textContent = `${data.fileName} (${data.wordCount.toLocaleString('id-ID')} kata)`;
            researchChatAttachmentChip.style.display = 'flex';
          }
        } catch (err) {
          console.error('[Research Chat] Upload error:', err);
          alert(window.currentLanguage === 'en' ? 'Failed to connect to server to upload document.' : 'Gagal menghubungi server untuk mengunggah dokumen.');
        } finally {
          researchChatAttachBtn.innerHTML = originalHtml;
          researchChatAttachBtn.disabled = false;
          researchChatFileInput.value = '';
        }
      });
    }

    if (researchChatAttachmentRemoveBtn) {
      researchChatAttachmentRemoveBtn.addEventListener('click', () => window.removeResearchChatAttachment());
    }

    // --- Tombol "+" (popup: lampirkan dokumen + shortcut Prompt Bank) ---
    const researchChatPlusBtn = document.getElementById('researchChatPlusBtn');
    const researchChatPlusMenu = document.getElementById('researchChatPlusMenu');
    const researchChatPromptShortcutList = document.getElementById('researchChatPromptShortcutList');
    const researchChatPromptShuffleBtn = document.getElementById('researchChatPromptShuffleBtn');
    let researchChatShortcutPool = []; // flat list {category, text} dari seluruh Prompt Bank

    function closeResearchChatPlusMenu() {
      if (researchChatPlusMenu) researchChatPlusMenu.classList.remove('open');
      if (researchChatPlusBtn) researchChatPlusBtn.classList.remove('active');
    }

    function pickRandomShortcuts() {
      if (!researchChatPromptShortcutList || researchChatShortcutPool.length === 0) return;

      // Ambil maksimal 5 prompt, tiap prompt dari kategori yang berbeda (biar variatif,
      // bukan 5 prompt dari kategori yang sama).
      const byCategory = new Map();
      researchChatShortcutPool.forEach(item => {
        if (!byCategory.has(item.category)) byCategory.set(item.category, []);
        byCategory.get(item.category).push(item);
      });
      const categories = [...byCategory.keys()].sort(() => Math.random() - 0.5).slice(0, 5);
      const picks = categories.map(cat => {
        const items = byCategory.get(cat);
        return items[Math.floor(Math.random() * items.length)];
      });

      researchChatPromptShortcutList.innerHTML = picks.map((p, idx) => `
        <button type="button" class="research-chat-prompt-shortcut-item" data-shortcut-idx="${idx}">
          <span class="shortcut-category">${escapeHtml(p.category.replace(/^\d+\s+/, ''))}</span>
          ${escapeHtml(p.text.length > 90 ? p.text.slice(0, 90) + '...' : p.text)}
        </button>
      `).join('');

      researchChatPromptShortcutList.querySelectorAll('.research-chat-prompt-shortcut-item').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
          if (researchChatInput) {
            researchChatInput.value = picks[idx].text;
            researchChatInput.style.height = 'auto';
            researchChatInput.style.height = researchChatInput.scrollHeight + 'px';
            researchChatInput.focus();
          }
          closeResearchChatPlusMenu();
        });
      });
    }

    async function ensureShortcutPoolLoaded() {
      if (researchChatShortcutPool.length > 0) return;
      try {
        const lang = window.currentLanguage === 'en' ? 'en' : 'id';
        const res = await fetch(`/api/prompts?lang=${lang}`);
        const data = await res.json();
        if (!data.ok) return;
        const allCategories = [...(data.scopus || []), ...(data.tesis_disertasi || [])];
        researchChatShortcutPool = allCategories.flatMap(cat =>
          (cat.prompts || []).map(p => ({ category: cat.category, text: p.text }))
        );
      } catch (err) {
        console.error('[Research Chat] Gagal memuat shortcut Prompt Bank:', err);
      }
    }

    function renderLockedShortcuts() {
      if (!researchChatPromptShortcutList) return;
      const msg = window.currentLanguage === 'en' ? 'Premium/Ultimate only - click to upgrade' : 'Khusus Premium/Ultimate - klik untuk upgrade';
      researchChatPromptShortcutList.innerHTML = `
        <button type="button" class="research-chat-prompt-shortcut-item btn-upgrade-trigger" style="text-align:center; color: var(--text-muted); display: flex; align-items: center; justify-content: center; gap: 0.4rem;">
          <i class="fa-solid fa-lock" style="color:#fbbf24;"></i> ${msg}
        </button>
      `;
    }

    if (researchChatPlusBtn && researchChatPlusMenu) {
      researchChatPlusBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isOpen = researchChatPlusMenu.classList.contains('open');
        if (isOpen) {
          closeResearchChatPlusMenu();
          return;
        }
        researchChatPlusMenu.classList.add('open');
        researchChatPlusBtn.classList.add('active');

        if (!isResearchChatProUser) {
          renderLockedShortcuts();
          return;
        }

        if (researchChatPromptShortcutList) {
          researchChatPromptShortcutList.innerHTML = `<p style="text-align:center; color: var(--text-muted); font-size: 0.78rem; padding: 0.5rem;"><i class="fa-solid fa-spinner fa-spin"></i></p>`;
        }
        await ensureShortcutPoolLoaded();
        pickRandomShortcuts();
      });

      document.addEventListener('click', (e) => {
        if (!researchChatPlusMenu.contains(e.target) && !researchChatPlusBtn.contains(e.target)) {
          closeResearchChatPlusMenu();
        }
      });
    }

    if (researchChatPromptShuffleBtn) {
      researchChatPromptShuffleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isResearchChatProUser) return; // terkunci - klik ditangkap oleh listener global .btn-upgrade-trigger
        pickRandomShortcuts();
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

        // Buka tab kosong SEKARANG (masih dalam gesture klik, supaya tidak
        // diblokir popup blocker) - lihat penjelasan lengkap di index.html
        // pada handler upgrade-btn-select (pola yang sama, alasan yang sama).
        const paymentWindow = window.open('', '_blank');

        try {
          const response = await fetch('/api/payment/topup/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageId })
          });

          const data = await response.json();

          if (!response.ok) {
            if (paymentWindow) paymentWindow.close();
            alert(data.message || 'Gagal membuat transaksi top-up.');
            return;
          }

          if (data.redirectUrl) {
            if (paymentWindow) {
              paymentWindow.location.href = data.redirectUrl;
            } else {
              window.location.href = data.redirectUrl;
            }
          } else {
            if (paymentWindow) paymentWindow.close();
            alert('Gagal mendapatkan tautan pembayaran.');
          }
        } catch (error) {
          if (paymentWindow) paymentWindow.close();
          console.error('[Top-up Purchase] Error:', error);
          alert('Terjadi kesalahan koneksi saat memproses pembelian.');
        } finally {
          selectBtn.disabled = false;
          selectBtn.innerHTML = originalBtnHtml;
        }
      }
    });

    // --- RIWAYAT AI TOOLS (Journal Matcher/Outline Generator/Lit Review/
    // Humanizer/SLR) - tab "Riwayat AI" terpisah sudah dihapus, item-itemnya
    // sekarang digabung ke dalam "Riwayat Percakapan" di sidebar (lihat
    // renderResearchChatHistoryList) dan chat search (initChatSearchModal),
    // dibedakan lewat ikon per jenis. allHistory tetap dipakai sebagai cache
    // supaya showHistoryDetails(id) bisa menampilkan modal detail aslinya. ---
    let allHistory = [];

    async function loadAllHistoryCache() {
      try {
        const response = await fetch('/api/history');
        const data = await response.json();
        if (data.ok) allHistory = data.history || [];
      } catch (err) {
        console.error('Gagal memuat riwayat AI tools:', err);
      }
      return allHistory;
    }

    async function openHistoryDetail(id) {
      if (!allHistory.find(h => h.id === id)) {
        await loadAllHistoryCache();
      }
      showHistoryDetails(id);
    }
    window.openHistoryDetail = openHistoryDetail;

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
      } else if (item.type === 'slr') {
        typeIcon = 'fa-solid fa-book-bookmark';
        iconColor = '#ec4899';
        iconBg = 'rgba(236, 72, 153, 0.1)';
        typeLabel = 'Systematic Lit Review';
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
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">PANDUAN OUTLINE DRAFT</h5>
              <div style="display: flex; gap: 0.5rem;">
                <button id="copyHistoryDraftBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #10b981; color: white;" type="button">
                  <i class="fa-regular fa-copy"></i> Salin Semua Draf
                </button>
                <button id="exportHistoryDraftPdfBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #ef4444; color: white;" type="button">
                  <i class="fa-solid fa-file-pdf"></i> PDF
                </button>
                <button id="exportHistoryDraftDocxBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #2563eb; color: white;" type="button">
                  <i class="fa-solid fa-file-word"></i> DOCX
                </button>
              </div>
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

          const cleanFileTitle = (item.input.title || 'Outline_Draft').slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_') || 'Outline_Draft';
          const exportPdfBtn = document.getElementById('exportHistoryDraftPdfBtn');
          if (exportPdfBtn) {
            exportPdfBtn.addEventListener('click', () => {
              exportElementToPdf(document.getElementById('historyDraftTextWrapper'), `Outline_${cleanFileTitle}.pdf`);
            });
          }
          const exportDocxBtn = document.getElementById('exportHistoryDraftDocxBtn');
          if (exportDocxBtn) {
            exportDocxBtn.addEventListener('click', () => {
              exportElementToDocx(document.getElementById('historyDraftTextWrapper'), `Outline Draft: ${escapeHtml(item.input.title || '')}`, `Outline_${cleanFileTitle}.doc`);
            });
          }
        }, 100);

      } else if (item.type === 'lit-review') {
        const citations = item.output.citations || [];
        historyDetailBody.innerHTML = `
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">INPUT METADATA</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem;">
              <div><strong>Topik/Judul Penelitian:</strong> ${escapeHtml(item.input.title) || '-'}</div>
            </div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">HASIL LITERATURE REVIEW</h5>
              <div style="display: flex; gap: 0.5rem;">
                <button id="copyHistoryLitReviewBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #8b5cf6; color: white;" type="button">
                  <i class="fa-regular fa-copy"></i> Salin Review
                </button>
                <button id="exportHistoryLitReviewPdfBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #ef4444; color: white;" type="button">
                  <i class="fa-solid fa-file-pdf"></i> PDF
                </button>
                <button id="exportHistoryLitReviewDocxBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #2563eb; color: white;" type="button">
                  <i class="fa-solid fa-file-word"></i> DOCX
                </button>
              </div>
            </div>
            <div id="historyLitReviewTextWrapper" style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1.25rem; font-size: 0.85rem; background: #ffffff; line-height: 1.6; max-height: 300px; overflow-y: auto; color: var(--text-main);">
              ${wrapCitationMarkers(item.output.review, citations)}
            </div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">REFERENSI (${citations.length})</h5>
              ${citations.length > 0 ? `
              <div style="display: flex; gap: 0.5rem;">
                <button id="exportHistoryRisBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #f59e0b; color: #051329;" type="button">.ris</button>
                <button id="exportHistoryBibBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.7rem; font-size: 0.72rem; background: #f59e0b; color: #051329;" type="button">.bib</button>
              </div>` : ''}
            </div>
            <div id="historyLitReviewCitationsWrapper" style="display: flex; flex-direction: column; gap: 0.6rem; max-height: 300px; overflow-y: auto; padding-right: 0.25rem;">
              ${citations.length === 0 ? `<p style="font-size: 0.82rem; color: var(--text-muted);">Tidak ada data referensi tersimpan untuk riwayat ini.</p>` : citations.map((cit, i) => `
                <div style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 0.75rem 1rem; background: #ffffff; text-align: left;">
                  <h6 style="font-weight: 700; font-size: 0.85rem; color: var(--text-main); margin: 0 0 0.25rem 0;">${i + 1}. ${escapeHtml(cit.title || 'Tanpa judul')}</h6>
                  <p style="font-size: 0.76rem; color: var(--text-muted); margin: 0 0 0.35rem 0;">${escapeHtml(cit.authors || '-')} · ${escapeHtml(String(cit.year || '-'))} · ${escapeHtml(cit.journal || '-')}</p>
                  ${cit.url ? `<a href="${cit.url}" target="_blank" rel="noopener" style="font-size: 0.76rem; color: var(--brand-blue); font-weight: 600; text-decoration: none;">Buka sumber <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `;

        setTimeout(() => {
          // Sama seperti popover sitasi [n] di JurnalHub Intelligence chat - hover/fokus
          // ke marker menampilkan kartu preview paper, biar konsisten dengan tampilan
          // lit review "biasa" (bukan cuma dump teks HTML mentah tanpa marker interaktif).
          const litReviewTextWrapper = document.getElementById('historyLitReviewTextWrapper');
          if (litReviewTextWrapper) {
            litReviewTextWrapper.addEventListener('mouseover', (e) => {
              const marker = e.target.closest('.lit-cite-marker');
              if (!marker) return;
              const idx = parseInt(marker.getAttribute('data-cite-idx'), 10);
              if (!citations[idx]) return;
              showLitCitePopover(marker, citations[idx]);
            });
            litReviewTextWrapper.addEventListener('focusin', (e) => {
              const marker = e.target.closest('.lit-cite-marker');
              if (!marker) return;
              marker.dispatchEvent(new Event('mouseover', { bubbles: true }));
            });
            litReviewTextWrapper.addEventListener('mouseout', (e) => {
              const marker = e.target.closest('.lit-cite-marker');
              if (!marker) return;
              if (e.relatedTarget && litCitePopoverEl && litCitePopoverEl.contains(e.relatedTarget)) return;
              scheduleLitCitePopoverHide();
            });
            litReviewTextWrapper.addEventListener('focusout', (e) => {
              const marker = e.target.closest('.lit-cite-marker');
              if (!marker) return;
              scheduleLitCitePopoverHide();
            });
          }

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

          const cleanLitReviewFileTitle = (item.input.title || 'Tinjauan_Pustaka').slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_') || 'Tinjauan_Pustaka';
          const exportLitReviewPdfBtn = document.getElementById('exportHistoryLitReviewPdfBtn');
          if (exportLitReviewPdfBtn) {
            exportLitReviewPdfBtn.addEventListener('click', () => {
              exportElementToPdf(document.getElementById('historyLitReviewTextWrapper'), `Tinjauan_Pustaka_${cleanLitReviewFileTitle}.pdf`);
            });
          }
          const exportLitReviewDocxBtn = document.getElementById('exportHistoryLitReviewDocxBtn');
          if (exportLitReviewDocxBtn) {
            exportLitReviewDocxBtn.addEventListener('click', () => {
              exportElementToDocx(document.getElementById('historyLitReviewTextWrapper'), `Tinjauan Pustaka: ${escapeHtml(item.input.title || '')}`, `Tinjauan_Pustaka_${cleanLitReviewFileTitle}.doc`);
            });
          }

          const exportRisBtn = document.getElementById('exportHistoryRisBtn');
          if (exportRisBtn) {
            exportRisBtn.addEventListener('click', () => {
              let risContent = '';
              citations.forEach(cit => {
                risContent += 'TY  - JOUR\r\n';
                risContent += `TI  - ${cit.title || 'Untitled'}\r\n`;
                if (cit.authors) {
                  String(cit.authors).split(/,|&|dan/i).forEach(auth => {
                    if (auth.trim()) risContent += `AU  - ${auth.trim()}\r\n`;
                  });
                }
                if (cit.journal) risContent += `JO  - ${cit.journal}\r\n`;
                if (cit.year) risContent += `PY  - ${cit.year}\r\n`;
                if (cit.url) risContent += `UR  - ${cit.url}\r\n`;
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

          const exportBibBtn = document.getElementById('exportHistoryBibBtn');
          if (exportBibBtn) {
            exportBibBtn.addEventListener('click', () => {
              let bibContent = '';
              citations.forEach((cit, i) => {
                const firstAuthor = cit.authors ? String(cit.authors).split(/,| /)[0].toLowerCase().replace(/[^a-z]/g, '') : 'author';
                const year = cit.year || '2026';
                const titleWord = cit.title ? String(cit.title).split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') : 'article';
                const citeKey = `${firstAuthor}${year}${titleWord}${i + 1}`;
                bibContent += `@article{${citeKey},\r\n`;
                bibContent += `  title = {${cit.title || 'Untitled'}},\r\n`;
                if (cit.authors) bibContent += `  author = {${cit.authors}},\r\n`;
                if (cit.journal) bibContent += `  journal = {${cit.journal}},\r\n`;
                if (cit.year) bibContent += `  year = {${cit.year}},\r\n`;
                if (cit.url) bibContent += `  url = {${cit.url}},\r\n`;
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
      } else if (item.type === 'slr') {
        const result = item.output || {};
        historyDetailBody.innerHTML = `
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">METADATA PENCARIAN</h5>
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; display: flex; flex-direction: column; gap: 0.5rem; text-align: left;">
              <div><strong>Kata Kunci:</strong> ${escapeHtml(item.input.query) || '-'}</div>
              <div><strong>Pertanyaan Penelitian:</strong> ${escapeHtml(item.input.questions) || '-'}</div>
              <div><strong>Kriteria Inklusi:</strong> ${escapeHtml(item.input.criteria?.inclusion) || '-'}</div>
              <div><strong>Kriteria Eksklusi:</strong> ${escapeHtml(item.input.criteria?.exclusion) || '-'}</div>
            </div>
          </div>
          <div>
            <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin-bottom: 0.5rem;">DIAGRAM PRISMA</h5>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; text-align: center;">
              <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 6px;">
                <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Identified</div>
                <div style="font-size: 1.2rem; font-weight: 800; color: var(--brand-blue);">${result.prisma?.identified || 0}</div>
              </div>
              <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 6px;">
                <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Screened</div>
                <div style="font-size: 1.2rem; font-weight: 800; color: var(--brand-blue);">${result.prisma?.screened || 0}</div>
              </div>
              <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 6px;">
                <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Eligible</div>
                <div style="font-size: 1.2rem; font-weight: 800; color: var(--brand-blue);">${result.prisma?.eligible || 0}</div>
              </div>
              <div style="background: #f1f5f9; padding: 0.5rem; border-radius: 6px;">
                <div style="font-size: 0.65rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">Included</div>
                <div style="font-size: 1.2rem; font-weight: 800; color: var(--brand-blue);">${result.prisma?.included || 0}</div>
              </div>
            </div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">MATRIKS SINTESIS & LAPORAN</h5>
              <button id="loadHistorySlrBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: var(--brand-blue); color: white;" type="button">
                <i class="fa-solid fa-cloud-arrow-down"></i> Tampilkan di Tab SLR
              </button>
            </div>
            <div style="background: #ffffff; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.82rem; color: var(--text-muted); text-align: center;">
              Klik tombol di atas untuk memuat data lengkap dan narasi Systematic Review ini ke dalam tab navigasi Systematic Lit Review Anda.
            </div>
          </div>
        `;

        setTimeout(() => {
          const loadBtn = document.getElementById('loadHistorySlrBtn');
          if (loadBtn) {
            loadBtn.addEventListener('click', () => {
              if (window.switchTab) window.switchTab('slr');
              if (window.loadSlrFromHistory) window.loadSlrFromHistory(result);
              if (historyDetailModal) historyDetailModal.classList.remove('active');
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
      const matcherHeader = document.querySelector('#dbAiCheckPanel .match-header h3');
      const matcherDesc = document.querySelector('#dbAiCheckPanel .match-header p');
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
      const researchChatAttachBtnTextEl = document.getElementById('researchChatAttachBtnText');
      if (researchChatAttachBtnTextEl) researchChatAttachBtnTextEl.textContent = TRANSLATIONS[lang].research_chat_attach_btn;
      const researchChatPromptShortcutHeadingEl = document.getElementById('researchChatPromptShortcutHeading');
      if (researchChatPromptShortcutHeadingEl) researchChatPromptShortcutHeadingEl.textContent = TRANSLATIONS[lang].research_chat_prompt_shortcut_heading;
      if (currentUser?.user) {
        updateResearchChatAccess(currentUser.user);
        updateSlrAccess(currentUser.user);
        updatePatentSearchAccess(currentUser.user);
        updatePeerReviewerAccess(currentUser.user);
        updateCitationGraphAccess(currentUser.user);
      }
      // Re-render chat bubbles so export button tooltips (PDF/DOCX/.ris/.bib) pick up the new language
      if (typeof renderResearchChatMessages === 'function' && typeof researchChatMessages !== 'undefined' && researchChatMessages.length > 0) {
        renderResearchChatMessages();
      }

      // 9j. Translate Pencarian Paten (Patent Search) tab
      const patentSearchTitleEl = document.getElementById('patentSearchTitle');
      if (patentSearchTitleEl) patentSearchTitleEl.textContent = TRANSLATIONS[lang].patent_search_title;
      const patentSearchIntroEl = document.getElementById('patentSearchIntro');
      if (patentSearchIntroEl) patentSearchIntroEl.textContent = TRANSLATIONS[lang].patent_search_intro;
      const patentSearchInputEl = document.getElementById('patentSearchInput');
      if (patentSearchInputEl) patentSearchInputEl.placeholder = TRANSLATIONS[lang].patent_search_placeholder;
      const patentSearchBtnTextEl = document.getElementById('patentSearchBtnText');
      if (patentSearchBtnTextEl) patentSearchBtnTextEl.textContent = TRANSLATIONS[lang].patent_search_btn;
      // Kuota hint di-refresh langsung dari data user terkini (bukan cuma teks statis)
      if (currentUser?.user && window.updatePatentSearchAccess) {
        window.updatePatentSearchAccess(currentUser.user);
      } else {
        const patentSearchHintEl = document.getElementById('patentSearchHint');
        if (patentSearchHintEl) patentSearchHintEl.textContent = TRANSLATIONS[lang].patent_search_hint_default;
      }

      // 9k. Translate Database Jurnal sub-tabs (Database Utama / No APC)
      const dbSubtabMainBtnTextEl = document.getElementById('dbSubtabMainBtnText');
      if (dbSubtabMainBtnTextEl) dbSubtabMainBtnTextEl.textContent = TRANSLATIONS[lang].db_subtab_main;
      const dbSubtabNoApcBtnTextEl = document.getElementById('dbSubtabNoApcBtnText');
      if (dbSubtabNoApcBtnTextEl) dbSubtabNoApcBtnTextEl.textContent = TRANSLATIONS[lang].db_subtab_noapc;

      const realtimeFilterTypeLabelEl = document.getElementById('realtimeFilterTypeLabel');
      if (realtimeFilterTypeLabelEl) realtimeFilterTypeLabelEl.textContent = TRANSLATIONS[lang].realtime_filter_type_label;
      const realtimeFilterTypeAllEl = document.getElementById('realtimeFilterTypeAll');
      if (realtimeFilterTypeAllEl) realtimeFilterTypeAllEl.textContent = TRANSLATIONS[lang].realtime_filter_all;
      const realtimeFilterTypeArticleEl = document.getElementById('realtimeFilterTypeArticle');
      if (realtimeFilterTypeArticleEl) realtimeFilterTypeArticleEl.textContent = TRANSLATIONS[lang].realtime_filter_article;
      const realtimeFilterTypeDissertationEl = document.getElementById('realtimeFilterTypeDissertation');
      if (realtimeFilterTypeDissertationEl) realtimeFilterTypeDissertationEl.textContent = TRANSLATIONS[lang].realtime_filter_dissertation;
      const realtimeModeLabelEl = document.getElementById('realtimeModeLabel');
      if (realtimeModeLabelEl) realtimeModeLabelEl.textContent = TRANSLATIONS[lang].realtime_mode_label;
      const realtimeBooleanToggleLabelEl = document.getElementById('realtimeBooleanToggleLabel');
      if (realtimeBooleanToggleLabelEl) realtimeBooleanToggleLabelEl.textContent = TRANSLATIONS[lang].realtime_boolean_label;
      const realtimeSearchBtnTextEl = document.getElementById('realtimeSearchBtnText');
      if (realtimeSearchBtnTextEl) realtimeSearchBtnTextEl.textContent = TRANSLATIONS[lang].realtime_search_btn;
      const realtimeSearchInputEl = document.getElementById('realtimeSearchInput');
      const realtimeBooleanToggleEl = document.getElementById('realtimeBooleanToggle');
      if (realtimeSearchInputEl) {
        realtimeSearchInputEl.placeholder = (realtimeBooleanToggleEl && realtimeBooleanToggleEl.checked)
          ? TRANSLATIONS[lang].realtime_search_placeholder_example
          : TRANSLATIONS[lang].realtime_search_placeholder_normal;
      }
      const realtimeResultsCountEl = document.getElementById('realtimeResultsCount');
      if (realtimeResultsCountEl && !realtimeResultsCountEl.dataset.hasResults) {
        realtimeResultsCountEl.textContent = TRANSLATIONS[lang].realtime_default_hint;
      }

      // 9l. Translate Promo Code UI in the upgrade modal
      const promoCodeInputEl = document.getElementById('promoCodeInput');
      if (promoCodeInputEl) promoCodeInputEl.placeholder = TRANSLATIONS[lang].promo_input_placeholder;
      const promoCodeApplyBtnTextEl = document.getElementById('promoCodeApplyBtnText');
      if (promoCodeApplyBtnTextEl) promoCodeApplyBtnTextEl.textContent = TRANSLATIONS[lang].promo_apply_btn;

      // 9m. Translate Outline Generator doc type dropdown (quick-tool chip in JurnalHub Intelligence)
      const outlineDocTypeOptions = document.querySelectorAll('#researchChatOutlineDocType option');
      if (outlineDocTypeOptions.length >= 3) {
        outlineDocTypeOptions[0].textContent = TRANSLATIONS[lang].outline_doctype_jurnal;
        outlineDocTypeOptions[1].textContent = TRANSLATIONS[lang].outline_doctype_tesis;
        outlineDocTypeOptions[2].textContent = TRANSLATIONS[lang].outline_doctype_disertasi;
      }
      // Re-render chip text/placeholder for currently active quick-tool (if any)
      if (typeof activeQuickTool !== 'undefined' && window.setActiveQuickTool) {
        window.setActiveQuickTool(activeQuickTool);
      }

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

      const activeTabLink = document.querySelector('.sidebar-link.active');

      // Re-fetch & re-render Prompt Bank in the new language if currently on that tab
      if (activeTabLink && activeTabLink.getAttribute('data-tab') === 'prompt-bank' && window.initPromptBankTab) {
        window.initPromptBankTab(true);
      }

      // Update current title element text. "research-chat" (JurnalHub Intelligence)
      // sekarang jadi dashboard default & tidak lagi punya sidebar-link aktif untuk
      // dideteksi, jadi itu jadi fallback-nya (bukan 'beranda' yang sudah tidak dipakai).
      const activeTab = document.querySelector('.sidebar-link.active')?.getAttribute('data-tab') || 'research-chat';
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

    // Initialize SLR Wizard Feature
    initSlrWizard();

    // --- SYSTEMATIC LITERATURE REVIEW (SLR) WIZARD LOGIC ---
    function initSlrWizard() {
      let currentStep = 1;
      let fetchedPapers = [];
      let slrResult = null;
      let slrCitationLookup = [];
      // Paper yang benar-benar dikirim ke /api/slr/synthesize (subset tercentang dari
      // fetchedPapers) - urutannya inilah yang jadi acuan [Paper N]/paperIndex dari AI,
      // BUKAN fetchedPapers (yang berisi semua hasil pencarian, termasuk yang tidak dicentang).
      let lastSynthesizedPapers = [];

      // Sitasi di Laporan Naratif & Matriks Sintesis ditulis AI sebagai teks bebas
      // "Nama et al. (Tahun)" (bukan marker angka [n] seperti Lit Review biasa),
      // jadi wrapping-nya dicocokkan lewat nama+tahun dari kolom authorYear di
      // matrix, bukan pola [n]. Toleransi variasi "Nama, Tahun" vs "Nama (Tahun)"
      // karena narasi AI kadang beda format tulisan dari kolom authorYear aslinya.
      function findFullSlrPaper(row, papers) {
        // Cocokkan lewat paperIndex (nomor urut [Paper N] yang dikirim ke AI) dulu -
        // 100% akurat, tidak tergantung AI menyalin ulang judul persis sama. Kalau
        // riwayat lama belum punya paperIndex (dibuat sebelum field ini ada), fallback
        // ke pencocokan judul yang lebih toleran (bukan exact match) supaya tetap
        // dapat menemukan datanya selama judulnya cukup mirip.
        if (!papers || papers.length === 0) return null;
        if (row.paperIndex && papers[row.paperIndex - 1]) return papers[row.paperIndex - 1];
        if (!row.title) return null;
        const rowTitle = row.title.trim().toLowerCase();
        const exact = papers.find(p => p.title && p.title.trim().toLowerCase() === rowTitle);
        if (exact) return exact;
        return papers.find(p => p.title && (
          p.title.trim().toLowerCase().includes(rowTitle) || rowTitle.includes(p.title.trim().toLowerCase())
        )) || null;
      }

      function buildSlrCitationLookup(matrix, papers) {
        return (matrix || []).map((row, idx) => {
          const fullPaper = findFullSlrPaper(row, papers);
          const yearMatch = String(row.authorYear || '').match(/\d{4}/);
          return {
            idx,
            authorYear: row.authorYear || '',
            title: (fullPaper && fullPaper.title) || row.title,
            authors: (fullPaper && fullPaper.authors) || row.authorYear,
            year: (fullPaper && fullPaper.year) || (yearMatch ? yearMatch[0] : '-'),
            journal: (fullPaper && fullPaper.journal) || '-',
            url: fullPaper && fullPaper.url,
            abstract: fullPaper && fullPaper.abstract,
            citedByCount: fullPaper && fullPaper.citedByCount,
            isOpenAccess: fullPaper && fullPaper.isOpenAccess
          };
        });
      }

      function wrapSlrCitationMentions(html, lookup) {
        if (!html || !lookup || lookup.length === 0) return html;
        const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let result = html;
        lookup.forEach((entry) => {
          const yearMatch = String(entry.authorYear).match(/\d{4}/);
          if (!yearMatch) return;
          const year = yearMatch[0];
          const namePart = String(entry.authorYear).replace(/[,\s]*\(?\d{4}\)?\s*$/, '').trim();
          if (!namePart) return;
          const pattern = new RegExp(escapeRegex(namePart) + '[,\\s]*\\(?' + year + '\\)?', 'g');
          result = result.replace(pattern, (match) =>
            `<span class="lit-cite-marker" data-slr-cite-idx="${entry.idx}" tabindex="0">${match}</span>`
          );
        });
        return result;
      }

      // Event delegation di container tab SLR (bukan langsung di slrNarrativeOutput/
      // slrMatrixTableBody) karena kedua elemen itu innerHTML-nya diganti total tiap
      // kali renderSynthesisOutput() jalan - delegasi di ancestor yang stabil supaya
      // listener-nya tetap jalan tanpa perlu di-attach ulang tiap render.
      const slrTabContainer = document.getElementById('tabContentSlr');
      if (slrTabContainer) {
        slrTabContainer.addEventListener('mouseover', (e) => {
          const marker = e.target.closest('[data-slr-cite-idx]');
          if (!marker) return;
          const idx = parseInt(marker.getAttribute('data-slr-cite-idx'), 10);
          if (!slrCitationLookup[idx]) return;
          showLitCitePopover(marker, slrCitationLookup[idx]);
        });
        slrTabContainer.addEventListener('focusin', (e) => {
          const marker = e.target.closest('[data-slr-cite-idx]');
          if (!marker) return;
          marker.dispatchEvent(new Event('mouseover', { bubbles: true }));
        });
        slrTabContainer.addEventListener('mouseout', (e) => {
          const marker = e.target.closest('[data-slr-cite-idx]');
          if (!marker) return;
          if (e.relatedTarget && litCitePopoverEl && litCitePopoverEl.contains(e.relatedTarget)) return;
          scheduleLitCitePopoverHide();
        });
        slrTabContainer.addEventListener('focusout', (e) => {
          const marker = e.target.closest('[data-slr-cite-idx]');
          if (!marker) return;
          scheduleLitCitePopoverHide();
        });
      }

      const progressLine = document.getElementById('slrProgressLine');
      const prevBtn = document.getElementById('slrPrevBtn');
      const nextBtn = document.getElementById('slrNextBtn');
      const loader = document.getElementById('slrStepLoader');
      const loaderText = document.getElementById('slrLoaderText');

      const steps = [
        document.getElementById('slrStep1'),
        document.getElementById('slrStep2'),
        document.getElementById('slrStep3'),
        document.getElementById('slrStep4')
      ];

      function updateStepUI() {
        // Show/hide step content
        steps.forEach((step, idx) => {
          if (step) {
            step.classList.toggle('active', idx + 1 === currentStep);
            step.style.display = idx + 1 === currentStep ? 'block' : 'none';
          }
        });

        // Update step nodes active/completed states
        const nodes = document.querySelectorAll('.slr-step-node');
        nodes.forEach((node) => {
          const stepNum = parseInt(node.getAttribute('data-step'));
          node.classList.toggle('active', stepNum === currentStep);
          node.classList.toggle('completed', stepNum < currentStep);
        });

        // Update progress line width
        if (progressLine) {
          const percent = ((currentStep - 1) / (steps.length - 1)) * 100;
          progressLine.style.width = `${percent}%`;
        }

        // Update footer buttons visibility & labels
        if (prevBtn) {
          prevBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';
        }

        if (nextBtn) {
          if (currentStep === 1) {
            nextBtn.innerHTML = `Cari Artikel <i class="fa-solid fa-arrow-right"></i>`;
          } else if (currentStep === 3) {
            nextBtn.innerHTML = `Mulai Sintesis <i class="fa-solid fa-wand-magic-sparkles"></i>`;
          } else if (currentStep === 4) {
            nextBtn.innerHTML = `Mulai Baru <i class="fa-solid fa-rotate-right"></i>`;
          } else {
            nextBtn.innerHTML = `Selanjutnya <i class="fa-solid fa-arrow-right"></i>`;
          }
        }
      }

      // Step 1: Cari Artikel dari OpenAlex
      async function searchArticles() {
        const query = document.getElementById('slrQuery').value.trim();
        if (!query || query.length < 3) {
          alert('Kata kunci pencarian minimal 3 karakter.');
          return;
        }

        const startYear = document.getElementById('slrStartYear').value.trim();
        const endYear = document.getElementById('slrEndYear').value.trim();
        const oaOnly = document.getElementById('slrOaOnly').checked;
        const limit = document.getElementById('slrLimit').value;

        if (loader) {
          loaderText.textContent = 'Mencari artikel ilmiah di OpenAlex...';
          loader.style.display = 'flex';
        }
        if (nextBtn) nextBtn.disabled = true;

        try {
          const res = await fetch('/api/slr/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query, startYear, endYear, oaOnly, limit })
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.message);

          fetchedPapers = data.papers || [];
          renderStep3SelectionList();

          currentStep = 2; // Auto advance to Step 2: Criteria
          updateStepUI();
        } catch (err) {
          alert('Error: ' + err.message);
        } finally {
          if (loader) loader.style.display = 'none';
          if (nextBtn) nextBtn.disabled = false;
        }
      }

      // Render Step 3 list with checkboxes
      function renderStep3SelectionList() {
        const container = document.getElementById('slrPapersSelectionList');
        if (!container) return;

        if (fetchedPapers.length === 0) {
          container.innerHTML = `
            <div style="text-align: center; padding: 3rem 0; color: var(--text-muted);">
              <i class="fa-solid fa-triangle-exclamation" style="font-size: 2rem; margin-bottom: 0.75rem; display: block; opacity: 0.5;"></i>
              Tidak ada artikel yang ditemukan. Coba perluas kata kunci pencarian Anda.
            </div>
          `;
          updateCounter(0);
          return;
        }

        container.innerHTML = fetchedPapers.map((p, idx) => {
          return `
            <div class="filter-box-card" style="padding: 1rem; border-radius: 10px; border: 1px solid rgba(8,34,64,0.06); background: #ffffff; display: flex; gap: 1rem; align-items: flex-start; text-align: left; margin-bottom: 0.75rem;">
              <input type="checkbox" class="slr-paper-checkbox" data-index="${idx}" checked style="margin-top: 0.25rem; width: 18px; height: 18px; cursor: pointer; flex-shrink: 0;">
              <div style="flex: 1; overflow: hidden;">
                <h5 style="font-family: var(--font-outfit); font-weight: 800; font-size: 0.95rem; margin: 0 0 0.25rem; color: var(--text-main); line-height: 1.3;">${escapeHtml(p.title)}</h5>
                <div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 0.5rem; font-weight: 500;">
                  <span>${escapeHtml(p.authors)}</span> &bull; 
                  <span>${escapeHtml(p.journal)} (${p.year})</span> &bull; 
                  <span>Dikutip ${p.citedByCount}x</span>
                  ${p.isOpenAccess ? ' &bull; <span style="color: #10b981; font-weight: 700;">Open Access</span>' : ''}
                </div>
                <details style="font-size: 0.8rem; color: var(--text-muted); cursor: pointer; outline: none;">
                  <summary style="font-weight: 700; margin-bottom: 0.25rem; color: var(--brand-blue);">Tampilkan Abstrak</summary>
                  <div style="padding-top: 0.25rem; line-height: 1.5; color: var(--text-main);">${escapeHtml(p.abstract)}</div>
                </details>
                <div class="slr-ai-badge-container" id="slrAiBadgeContainer_${idx}"></div>
              </div>
            </div>
          `;
        }).join('');

        // Attach change listeners to checkboxes to update counter
        const checkboxes = container.querySelectorAll('.slr-paper-checkbox');
        checkboxes.forEach((cb) => {
          cb.addEventListener('change', () => {
            const checkedCount = container.querySelectorAll('.slr-paper-checkbox:checked').length;
            updateCounter(checkedCount);
          });
        });

        updateCounter(fetchedPapers.length);
      }

      function updateCounter(checkedCount) {
        const counter = document.getElementById('slrSelectedCounter');
        if (counter) {
          counter.textContent = `${checkedCount} dari ${fetchedPapers.length} Artikel Dipilih`;
        }
      }

      // Step 4: Sintesis menggunakan DeepSeek
      async function runSynthesis() {
        const container = document.getElementById('slrPapersSelectionList');
        if (!container) return;

        const checkedCheckboxes = container.querySelectorAll('.slr-paper-checkbox:checked');
        if (checkedCheckboxes.length === 0) {
          alert('Silakan pilih minimal 1 artikel untuk disintesis.');
          return;
        }

        const selectedPapers = [];
        checkedCheckboxes.forEach((cb) => {
          const idx = parseInt(cb.getAttribute('data-index'));
          selectedPapers.push(fetchedPapers[idx]);
        });

        const researchQuestions = document.getElementById('slrQuestions').value.trim();
        const inclusionCriteria = document.getElementById('slrInclusion').value.trim();
        const exclusionCriteria = document.getElementById('slrExclusion').value.trim();

        lastSynthesizedPapers = selectedPapers;

        if (loader) {
          loaderText.textContent = 'Menyusun ulasan sistematis dengan AI...';
          loader.style.display = 'flex';
        }
        if (nextBtn) nextBtn.disabled = true;

        try {
          const res = await fetch('/api/slr/synthesize', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              papers: selectedPapers,
              researchQuestions,
              inclusionCriteria,
              exclusionCriteria
            })
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.message);

          slrResult = data.result;
          renderSynthesisOutput();

          currentStep = 4;
          updateStepUI();

          // Refresh user quota information after successful synthesis
          fetch('/api/me')
            .then(r => r.json())
            .then(meData => {
              if (meData && meData.user) {
                currentUser = meData;
                if (window.currentUser) {
                  window.currentUser = meData;
                }
                updateSlrAccess(meData.user);
                updatePatentSearchAccess(meData.user);
                updatePeerReviewerAccess(meData.user);
                updateCitationGraphAccess(meData.user);
                updateVisualQuotaTracker(meData.user);
              }
            })
            .catch(err => console.error('Error refreshing SLR quota:', err));
        } catch (err) {
          alert('Error: ' + err.message);
        } finally {
          if (loader) loader.style.display = 'none';
          if (nextBtn) nextBtn.disabled = false;
        }
      }

      function renderSynthesisOutput() {
        if (!slrResult) return;

        // Update PRISMA counts
        const prisma = slrResult.prisma || {};
        const iden = document.getElementById('prismaIdentifiedCount');
        const scre = document.getElementById('prismaScreenedCount');
        const excl = document.getElementById('prismaExcludedCount');
        const sought = document.getElementById('prismaSoughtCount');
        const elig = document.getElementById('prismaEligibleCount');
        const incl = document.getElementById('prismaIncludedCount');

        const totalIdentified = prisma.identified || fetchedPapers.length;
        const checkedCount = document.querySelectorAll('.slr-paper-checkbox:checked').length;
        const excludedCount = Math.max(0, totalIdentified - checkedCount);

        if (iden) iden.textContent = totalIdentified;
        if (scre) scre.textContent = totalIdentified;
        if (excl) excl.textContent = excludedCount;
        if (sought) sought.textContent = checkedCount;
        if (elig) elig.textContent = checkedCount;
        if (incl) incl.textContent = prisma.included || checkedCount;

        // Update Matrix Table
        const matrixTableBody = document.getElementById('slrMatrixTableBody');
        const matrix = slrResult.matrix || [];
        slrCitationLookup = buildSlrCitationLookup(matrix, lastSynthesizedPapers);
        if (matrixTableBody) {
          if (matrix.length === 0) {
            matrixTableBody.innerHTML = `<tr><td colspan="5" style="padding: 2rem; text-align: center; color: var(--text-muted);">Tidak ada matriks sintesis dari AI.</td></tr>`;
          } else {
            matrixTableBody.innerHTML = matrix.map((row, idx) => {
              const rob = row.riskOfBias || {};
              const rating = rob.rating || 'Moderate Risk';
              let badgeStyle = 'background: #fef9c3; color: #854d0e; border: 1px solid #fde047;';
              if (rating === 'Low Risk') badgeStyle = 'background: #dcfce7; color: #166534; border: 1px solid #86efac;';
              else if (rating === 'High Risk') badgeStyle = 'background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;';

              return `
                <tr style="border-bottom: 1px solid rgba(8,34,64,0.04);">
                  <td style="padding: 0.85rem 1rem; font-weight: 700; color: var(--text-main); vertical-align: top;"><span class="lit-cite-marker" data-slr-cite-idx="${idx}" tabindex="0">${escapeHtml(row.authorYear)}</span><br><span style="font-size: 0.72rem; color: var(--text-muted); font-weight: 500; display: block; margin-top: 0.2rem;">${escapeHtml(row.title)}</span></td>
                  <td style="padding: 0.85rem 1rem; vertical-align: top;">
                    <span style="display: inline-block; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.72rem; font-weight: 800; ${badgeStyle}">${escapeHtml(rating)}</span>
                    ${rob.reason ? `<div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.35rem; line-height: 1.3;">${escapeHtml(rob.reason)}</div>` : ''}
                  </td>
                  <td style="padding: 0.85rem 1rem; color: var(--text-main); vertical-align: top; font-weight: 500;">${escapeHtml(row.methodology)}</td>
                  <td style="padding: 0.85rem 1rem; color: var(--text-main); vertical-align: top; line-height: 1.4;">${escapeHtml(row.findings)}</td>
                  <td style="padding: 0.85rem 1rem; color: var(--text-main); vertical-align: top; line-height: 1.4;">${escapeHtml(row.gap)}</td>
                </tr>
              `;
            }).join('');
          }
        }

        // Update Narrative Output
        const narrativeOutput = document.getElementById('slrNarrativeOutput');
        if (narrativeOutput) {
          narrativeOutput.innerHTML = slrResult.narrative
            ? wrapSlrCitationMentions(slrResult.narrative, slrCitationLookup)
            : '<p style="color: var(--text-muted); text-align: center;">Respons naratif tidak tersedia.</p>';
        }

        // Reset internal Step 4 sub-tabs view to "prisma"
        const subTabs = document.querySelectorAll('.slr-tab-btn');
        subTabs.forEach((tab) => {
          tab.classList.toggle('active', tab.getAttribute('data-slr-tab') === 'prisma');
        });
        const subContents = [
          document.getElementById('slrSubContentPrisma'),
          document.getElementById('slrSubContentMatrix'),
          document.getElementById('slrSubContentNarrative')
        ];
        subContents.forEach((c) => {
          if (c) c.style.display = c.id === 'slrSubContentPrisma' ? 'block' : 'none';
        });
      }

      function exportSlrToDocx() {
        if (!slrResult) {
          alert('Belum ada hasil sintesis SLR untuk diunduh.');
          return;
        }

        const queryTitle = document.getElementById('slrQuery')?.value.trim() || 'Systematic Literature Review';
        const questions = document.getElementById('slrQuestions')?.value.trim() || '-';
        const inclusion = document.getElementById('slrInclusion')?.value.trim() || '-';
        const exclusion = document.getElementById('slrExclusion')?.value.trim() || '-';

        const prisma = slrResult.prisma || {};
        const matrix = slrResult.matrix || [];
        const narrative = slrResult.narrative || '';

        let docHtml = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
            <h1 style="color: #0b1a30; font-size: 18pt; text-align: center; margin-bottom: 5pt;">SYSTEMATIC LITERATURE REVIEW (PRISMA 2020)</h1>
            <p style="text-align: center; font-style: italic; color: #64748b; margin-top: 0;">Topik: ${escapeHtml(queryTitle)}</p>
            <hr style="border: 0; border-top: 1px solid #cbd5e1; margin: 15pt 0;">

            <h2 style="color: #0b1a30; font-size: 14pt;">1. Informasi Protokol & Kriteria Seleksi</h2>
            <p><b>Pertanyaan Penelitian (Research Questions):</b><br>${escapeHtml(questions).replace(/\n/g, '<br>')}</p>
            <p><b>Kriteria Inklusi:</b><br>${escapeHtml(inclusion).replace(/\n/g, '<br>')}</p>
            <p><b>Kriteria Eksklusi:</b><br>${escapeHtml(exclusion).replace(/\n/g, '<br>')}</p>

            <h2 style="color: #0b1a30; font-size: 14pt; margin-top: 20pt;">2. Ringkasan Diagram Alir PRISMA 2020</h2>
            <table border="1" cellspacing="0" cellpadding="8" style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 10pt;">
              <tr style="background: #f1f5f9; font-weight: bold;">
                <th>Fase PRISMA 2020</th>
                <th>Main Flow (Studi Lolos)</th>
                <th>Exclusions (Studi Dieksklusi)</th>
              </tr>
              <tr>
                <td><b>Identification</b></td>
                <td>Pencarian Database OpenAlex & Semantic Scholar (n = ${prisma.identified || 0})</td>
                <td>Duplikasi Dihapus (n = 0)</td>
              </tr>
              <tr>
                <td><b>Screening</b></td>
                <td>Penyaringan Judul & Abstrak (n = ${prisma.screened || 0})</td>
                <td>Tidak Memenuhi Kriteria (n = ${Math.max(0, (prisma.identified || 0) - (prisma.eligible || 0))})</td>
              </tr>
              <tr>
                <td><b>Eligibility</b></td>
                <td>Evaluasi Kelayakan Full-Text (n = ${prisma.eligible || 0})</td>
                <td>Laporan Tidak Ditemukan / Dieksklusi (n = 0)</td>
              </tr>
              <tr>
                <td><b>Included</b></td>
                <td><b>Studi Akhir Dimasukkan dalam Sintesis (n = ${prisma.included || 0})</b></td>
                <td>-</td>
              </tr>
            </table>

            <h2 style="color: #0b1a30; font-size: 14pt; margin-top: 20pt;">3. Matriks Sintesis & Evaluasi Risiko Bias (Risk of Bias)</h2>
            <table border="1" cellspacing="0" cellpadding="6" style="width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; font-size: 9.5pt;">
              <tr style="background: #0b1a30; color: #ffffff; font-weight: bold;">
                <th style="width: 22%;">Penulis & Tahun</th>
                <th style="width: 18%;">Risk of Bias</th>
                <th style="width: 18%;">Metodologi</th>
                <th style="width: 22%;">Temuan Utama</th>
                <th style="width: 20%;">Celah Penelitian (Gap)</th>
              </tr>
              ${matrix.map(r => {
                const rob = r.riskOfBias || {};
                return `
                  <tr>
                    <td><b>${escapeHtml(r.authorYear)}</b><br><span style="font-size: 8.5pt; color: #475569;">${escapeHtml(r.title)}</span></td>
                    <td><b>${escapeHtml(rob.rating || 'Moderate Risk')}</b><br><span style="font-size: 8pt; color: #64748b;">${escapeHtml(rob.reason || '-')}</span></td>
                    <td>${escapeHtml(r.methodology)}</td>
                    <td>${escapeHtml(r.findings)}</td>
                    <td>${escapeHtml(r.gap)}</td>
                  </tr>
                `;
              }).join('')}
            </table>

            <h2 style="color: #0b1a30; font-size: 14pt; margin-top: 20pt;">4. Laporan Naratif SLR Terstruktur</h2>
            <div style="font-size: 10.5pt; line-height: 1.6;">
              ${narrative}
            </div>
          </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = docHtml;
        const cleanFileName = `SLR_PRISMA2020_${queryTitle.replace(/[^a-z0-9]/gi, '_')}.doc`;
        exportElementToDocx(tempDiv, `Systematic Literature Review - ${queryTitle}`, cleanFileName);
      }

      // Attach step click actions
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (currentStep > 1) {
            currentStep--;
            updateStepUI();
          }
        });
      }

      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          if (currentStep === 1) {
            searchArticles();
          } else if (currentStep === 2) {
            // Validate Step 2 inputs are filled
            const q = document.getElementById('slrQuestions').value.trim();
            if (!q) {
              alert('Silakan masukkan pertanyaan penelitian terlebih dahulu.');
              return;
            }
            currentStep = 3;
            updateStepUI();
          } else if (currentStep === 3) {
            runSynthesis();
          } else if (currentStep === 4) {
            // Restart wizard
            currentStep = 1;
            fetchedPapers = [];
            slrResult = null;
            document.getElementById('slrQuery').value = '';
            document.getElementById('slrQuestions').value = '';
            document.getElementById('slrInclusion').value = '';
            document.getElementById('slrExclusion').value = '';
            const container = document.getElementById('slrPapersSelectionList');
            if (container) {
              container.innerHTML = `
                <div style="text-align: center; padding: 3rem 0; color: var(--text-muted);">
                  <i class="fa-solid fa-cloud-arrow-down" style="font-size: 2rem; margin-bottom: 0.75rem; display: block; opacity: 0.5;"></i>
                  Belum ada data. Silakan kembali ke Langkah 1 dan klik "Cari Artikel".
                </div>
              `;
            }
            updateStepUI();
          }
        });
      }

      // Step 3: Check/Uncheck all
      const checkAll = document.getElementById('slrCheckAllBtn');
      const uncheckAll = document.getElementById('slrUncheckAllBtn');
      if (checkAll) {
        checkAll.addEventListener('click', () => {
          const checkboxes = document.querySelectorAll('.slr-paper-checkbox');
          checkboxes.forEach(cb => cb.checked = true);
          updateCounter(checkboxes.length);
        });
      }
      if (uncheckAll) {
        uncheckAll.addEventListener('click', () => {
          const checkboxes = document.querySelectorAll('.slr-paper-checkbox');
          checkboxes.forEach(cb => cb.checked = false);
          updateCounter(0);
        });
      }

      // Step 4: Sub-tabs click listener
      const subTabs = document.querySelectorAll('.slr-tab-btn');
      subTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          subTabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');

          const tabName = tab.getAttribute('data-slr-tab');
          const contents = {
            prisma: document.getElementById('slrSubContentPrisma'),
            matrix: document.getElementById('slrSubContentMatrix'),
            narrative: document.getElementById('slrSubContentNarrative')
          };

          Object.keys(contents).forEach((key) => {
            if (contents[key]) {
              contents[key].style.display = key === tabName ? 'block' : 'none';
            }
          });
        });
      });

      // Step 4: Export CSV Button
      const exportCsv = document.getElementById('slrExportCsvBtn');
      if (exportCsv) {
        exportCsv.addEventListener('click', () => {
          if (!slrResult || !slrResult.matrix) return;
          const rows = [
            ['Penulis & Tahun', 'Judul Paper', 'Metodologi', 'Temuan Utama', 'Research Gap']
          ];
          slrResult.matrix.forEach((row) => {
            rows.push([
              row.authorYear || '',
              row.title || '',
              row.methodology || '',
              row.findings || '',
              row.gap || ''
            ]);
          });

          const csvContent = "data:text/csv;charset=utf-8," 
            + rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");
          
          const encodedUri = encodeURI(csvContent);
          const link = document.createElement("a");
          link.setAttribute("href", encodedUri);
          link.setAttribute("download", `synthesis_matrix_${Date.now()}.csv`);
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        });
      }

      // Step 4: Copy Narrative Button
      const copyNarrative = document.getElementById('slrCopyNarrativeBtn');
      if (copyNarrative) {
        copyNarrative.addEventListener('click', () => {
          const narrativeOutput = document.getElementById('slrNarrativeOutput');
          if (!narrativeOutput) return;

          // Extract plain text from HTML
          const tempElement = document.createElement('div');
          tempElement.innerHTML = narrativeOutput.innerHTML;
          const text = tempElement.innerText || tempElement.textContent;

          navigator.clipboard.writeText(text).then(() => {
            const originalText = copyNarrative.innerHTML;
            copyNarrative.innerHTML = `<i class="fa-solid fa-check"></i> Disalin!`;
            setTimeout(() => {
              copyNarrative.innerHTML = originalText;
            }, 2000);
          }).catch(err => {
            alert('Gagal menyalin teks: ' + err.message);
          });
        });
      }

      // Step 2 suggestions generator
      const suggestBtns = document.querySelectorAll('.btn-slr-ai-suggest');
      suggestBtns.forEach((btn) => {
        btn.addEventListener('click', async () => {
          const query = document.getElementById('slrQuery').value.trim();
          if (!query) {
            alert(window.currentLanguage === 'en' 
              ? 'Please fill in Keywords / Research Topic in Step 1 first.' 
              : 'Silakan isi Kata Kunci / Judul Topik Penelitian terlebih dahulu di Langkah 1.');
            currentStep = 1;
            updateStepUI();
            return;
          }
          
          const field = btn.getAttribute('data-field');
          const targetTextarea = document.getElementById(
            field === 'questions' ? 'slrQuestions' : (field === 'inclusion' ? 'slrInclusion' : 'slrExclusion')
          );
          if (!targetTextarea) return;

          const originalHtml = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating...`;

          try {
            const res = await fetch('/api/slr/generate-criteria', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ query, field })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.message);
            targetTextarea.value = data.suggestions;
          } catch (err) {
            alert('Gagal membuat rekomendasi: ' + err.message);
          } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
          }
        });
      });

      // Step 3 AI Auto-Screen
      const aiScreenBtn = document.getElementById('slrAiScreenBtn');
      if (aiScreenBtn) {
        aiScreenBtn.addEventListener('click', async () => {
          if (fetchedPapers.length === 0) {
            alert(window.currentLanguage === 'en' ? 'No papers to screen.' : 'Tidak ada artikel untuk disaring.');
            return;
          }

          const query = document.getElementById('slrQuery').value.trim();
          const questions = document.getElementById('slrQuestions').value.trim();
          const inclusion = document.getElementById('slrInclusion').value.trim();
          const exclusion = document.getElementById('slrExclusion').value.trim();

          const originalHtml = aiScreenBtn.innerHTML;
          aiScreenBtn.disabled = true;
          aiScreenBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Auto Screening...`;

          try {
            const res = await fetch('/api/slr/auto-screen', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                query,
                questions,
                inclusion,
                exclusion,
                papers: fetchedPapers.map((p, idx) => ({
                   id: idx,
                   title: p.title,
                   abstract: p.abstract
                }))
              })
             });
             const data = await res.json();
             if (!data.ok) throw new Error(data.message);

             // Process screening results
             const results = data.results || [];
             results.forEach((resItem) => {
               const idx = parseInt(resItem.id);
               const checkbox = document.querySelector(`.slr-paper-checkbox[data-index="${idx}"]`);
               if (checkbox) {
                 checkbox.checked = (resItem.decision === 'include');
               }

               const badgeContainer = document.getElementById(`slrAiBadgeContainer_${idx}`);
               if (badgeContainer) {
                 badgeContainer.innerHTML = `
                   <div class="slr-screen-badge ${resItem.decision}">
                     <i class="fa-solid ${resItem.decision === 'include' ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
                     <span>AI: ${resItem.decision === 'include' ? 'Lolos' : 'Eksklusi'} - ${escapeHtml(resItem.reason)}</span>
                   </div>
                 `;
               }
             });

             // Update counter based on checks
             const checkedCount = document.querySelectorAll('.slr-paper-checkbox:checked').length;
             updateCounter(checkedCount);

             alert(window.currentLanguage === 'en' 
               ? 'AI screening completed! You can review the decisions and adjust them manually.' 
               : 'Screening AI selesai! Anda dapat meninjau keputusan dan menyesuaikannya secara manual.');
          } catch (err) {
            alert('Gagal melakukan auto-screening: ' + err.message);
          } finally {
            aiScreenBtn.disabled = false;
            aiScreenBtn.innerHTML = originalHtml;
          }
        });
      }

      // Expose history loader and access control globally
      window.loadSlrFromHistory = function(result) {
        slrResult = result;
        renderSynthesisOutput();
        currentStep = 4;
        updateStepUI();
      };
      window.updateSlrAccess = updateSlrAccess;
    }
  }

  init();
});

