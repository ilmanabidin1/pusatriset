/**
 * Logika Aplikasi JurnalHub
 * Mengatur pencarian, filter, tampilan grid/list, lazy-loading, dan perhitungan statistik.
 */

document.addEventListener('DOMContentLoaded', () => {
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
  let isMatchMode = false;

  // --- 1. TAMPILAN MENYELURUH (RENDERING) ---
  
  // Fungsi merender kartu ke HTML (dilengkapi lazy-loading)
  function renderCards() {
    resultsContainer.innerHTML = '';
    
    // Update label jumlah hasil pencarian keseluruhan
    resultsCount.textContent = isMatchMode
      ? `Rekomendasi match: ${activeJournals.length} jurnal`
      : `Menampilkan ${activeJournals.length} jurnal`;

    if (activeJournals.length === 0) {
      resultsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i class="fa-solid fa-folder-open"></i></div>
          <h3>Jurnal Tidak Ditemukan</h3>
          <p>${isMatchMode ? 'Coba tambahkan keyword, bidang, atau abstrak yang lebih spesifik.' : 'Coba gunakan kata kunci lain, bersihkan filter, atau periksa ejaan Anda.'}</p>
        </div>
      `;
      loadMoreContainer.style.display = 'none';
      return;
    }

    // Ambil data sebagian sesuai visibleCount
    const chunk = activeJournals.slice(0, visibleCount);

    chunk.forEach((journal, index) => {
      const card = document.createElement('div');
      card.className = `journal-card ${journal.type.toLowerCase()}-card`;
      // Efek stagger animasi masuk
      card.style.animationDelay = `${(index % 30) * 0.03}s`;

      const typeBadgeClass = journal.type === 'Scopus' ? 'type-scopus' : 'type-sinta';
      const rankBadgeClass = `rank-${journal.rank.toLowerCase()}`;
      const apcClass = journal.isFree ? 'free' : 'paid';
      const matchBadge = journal.matchScore ? `
        <span class="match-score-badge">
          <i class="fa-solid fa-chart-simple"></i> ${journal.matchScore}% cocok
        </span>
      ` : '';

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
            <span class="rank-badge ${rankBadgeClass}">${journal.rank}</span>
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
            ${journal.isFastTrack ? `
            <div class="meta-detail-row" style="color: #fbbf24; font-weight: 600;">
              <span class="meta-label">Fast Track:</span>
              <span class="meta-value"><i class="fa-solid fa-bolt"></i> ${journal.responseTime || 'Ya'}</span>
            </div>
            ` : ''}
          </div>
          
          <div class="card-footer" style="margin-top: 1.25rem;">
            <a href="${journal.url}" target="_blank" class="journal-link">
              Kunjungi Jurnal <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </a>
          </div>
        </div>
      `;

      resultsContainer.appendChild(card);
    });

    // Atur visibilitas tombol "Muat Lebih Banyak"
    if (visibleCount < activeJournals.length) {
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

    if (allWords.length === 0) return 0;

    const journalTitle = normalizeText(journal.title);
    const journalSubject = normalizeText(`${journal.subject} ${journal.keilmuan}`);
    const journalProfile = normalizeText(`${journal.title} ${journal.publisher} ${journal.subject} ${journal.keilmuan} ${journal.description}`);

    const titleHits = countMatches(allWords, journalTitle);
    const subjectHits = countMatches(allWords, journalSubject);
    const profileHits = countMatches(allWords, journalProfile);
    const keywordHits = countMatches(keywordWords, journalProfile);

    const titleScore = Math.min(35, titleHits * 9);
    const subjectScore = Math.min(30, subjectHits * 10);
    const profileScore = Math.min(25, Math.round((profileHits / allWords.length) * 55));
    const keywordScore = Math.min(10, keywordHits * 4);
    const freeBonus = journal.isFree ? 3 : 0;
    const fastTrackBonus = journal.isFastTrack ? 2 : 0;

    return Math.min(100, titleScore + subjectScore + profileScore + keywordScore + freeBonus + fastTrackBonus);
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
      });

    isMatchMode = true;
    activeJournals = ranked;
    visibleCount = 30;
    clearMatchBtn.style.display = 'inline-flex';
    matchSummary.textContent = ranked.length > 0
      ? `Ditemukan ${ranked.length} rekomendasi. Hasil diurutkan dari match score tertinggi.`
      : 'Belum ada jurnal yang cocok. Coba tambahkan keyword atau abstrak yang lebih spesifik.';
    renderCards();
    document.getElementById('resultsContainer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearJournalMatch() {
    isMatchMode = false;
    articleTitle.value = '';
    articleKeywords.value = '';
    articleAbstract.value = '';
    clearMatchBtn.style.display = 'none';
    matchSummary.textContent = 'Isi minimal judul artikel atau keyword untuk melihat rekomendasi jurnal terbaik.';
    filterJournals();
  }
  
  function filterJournals() {
    isMatchMode = false;
    clearMatchBtn.style.display = 'none';
    matchSummary.textContent = 'Isi minimal judul artikel atau keyword untuk melihat rekomendasi jurnal terbaik.';
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

  // Efek animasi angka bertambah (counter up)
  function animateValue(element, start, end, duration) {
    if (start === end) {
      element.textContent = end;
      return;
    }
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      element.textContent = Math.floor(progress * (end - start) + start);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        element.textContent = end;
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

  runMatchBtn.addEventListener('click', runJournalMatch);
  clearMatchBtn.addEventListener('click', clearJournalMatch);

  [articleTitle, articleKeywords, articleAbstract].forEach(field => {
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.ctrlKey) {
        runJournalMatch();
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
  mobileToggle.addEventListener('click', () => {
    navLinks.classList.toggle('show');
    const isShowing = navLinks.classList.contains('show');
    mobileToggle.innerHTML = isShowing ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-bars"></i>';
  });

  // Tutup menu mobile ketika link di-klik
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('show');
      mobileToggle.innerHTML = '<i class="fa-solid fa-bars"></i>';
    });
  });

  // Efek Glass Navbar saat digeser (Scroll)
  window.addEventListener('scroll', () => {
    const navbar = document.getElementById('navbar');
    if (window.scrollY > 50) {
      navbar.style.padding = '0.75rem 2rem';
      navbar.style.backgroundColor = 'rgba(7, 9, 14, 0.9)';
    } else {
      navbar.style.padding = '1.25rem 2rem';
      navbar.style.backgroundColor = 'rgba(7, 9, 14, 0.75)';
    }
  });

  // --- 5. INITIALIZATION ---
  function init() {
    activeJournals = JOURNAL_DATABASE;
    renderCards();
    calculateStats();
  }

  init();
});
