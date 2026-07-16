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
              bannerUpgradeBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Mulai AI Match';
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
              bannerUpgradeBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Coba AI Match (Gratis 1x/Bulan)';
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
          renderBillingHistory();
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
          <span style="text-align: left;">${pt}</span>
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

      historyListContainer.innerHTML = `
        <div style="text-align: center; padding: 4rem 2rem; background: rgba(255,255,255,0.6); border: 1px dashed var(--border-light-hover); border-radius: 16px;">
          <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--brand-blue); margin-bottom: 1rem;"></i>
          <p style="color: var(--text-muted); font-size: 0.9rem;">Memuat riwayat penggunaan...</p>
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
              <p style="color: #ef4444; font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;">Gagal Memuat Riwayat</p>
              <p style="color: var(--text-muted); font-size: 0.85rem;">${data.message || 'Terjadi kesalahan pada server.'}</p>
            </div>
          `;
        }
      } catch (err) {
        console.error('Fetch history error:', err);
        historyListContainer.innerHTML = `
          <div style="text-align: center; padding: 4rem 2rem; background: #fff; border: 1px solid rgba(239, 68, 68, 0.1); border-radius: 16px;">
            <i class="fa-solid fa-triangle-exclamation" style="font-size: 2.5rem; color: #ef4444; margin-bottom: 1rem;"></i>
            <p style="color: #ef4444; font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;">Kesalahan Koneksi</p>
            <p style="color: var(--text-muted); font-size: 0.85rem;">Gagal menghubungkan ke server JurnalHub.</p>
          </div>
        `;
      }
    }
    window.renderHistoryTab = renderHistoryTab;

    // Display history items
    function displayHistoryList() {
      if (!historyListContainer) return;

      const filtered = activeHistoryFilter === 'all' 
        ? allHistory 
        : allHistory.filter(item => item.type === activeHistoryFilter);

      if (filtered.length === 0) {
        historyListContainer.innerHTML = `
          <div style="text-align: center; padding: 5rem 2rem; background: #ffffff; border: 1px solid var(--border-light-hover); border-radius: 16px; box-shadow: 0 4px 20px rgba(8,34,64,0.02);">
            <div style="width: 64px; height: 64px; border-radius: 50%; background: #f8fafc; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem auto; color: var(--text-muted); font-size: 1.75rem;">
              <i class="fa-regular fa-clock"></i>
            </div>
            <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.5rem;">Tidak Ada Riwayat</h4>
            <p style="color: var(--text-muted); font-size: 0.88rem; max-width: 400px; margin: 0 auto;">Anda belum pernah menggunakan alat AI dengan kategori ini. Mulai analisis atau humanisasi teks untuk membuat riwayat.</p>
          </div>
        `;
        return;
      }

      historyListContainer.innerHTML = '';
      filtered.forEach(item => {
        const dateStr = new Date(item.timestamp).toLocaleString('id-ID', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        let typeLabel = 'AI Tool';
        let typeIcon = 'fa-solid fa-robot';
        let iconBg = 'rgba(7, 135, 220, 0.08)';
        let iconColor = 'var(--brand-blue)';
        let titleText = 'Penggunaan Alat AI';
        let descText = '';

        if (item.type === 'match') {
          typeLabel = 'Journal Matcher';
          typeIcon = 'fa-solid fa-magnifying-glass-chart';
          iconBg = 'rgba(7, 135, 220, 0.08)';
          iconColor = 'var(--brand-blue)';
          titleText = item.input.title || 'Pencarian Kesesuaian Jurnal';
          descText = `Keywords: ${item.input.keywords || '-'} | Rekomendasi: ${item.output.recommendations ? item.output.recommendations.length : 0} jurnal`;
        } else if (item.type === 'draft') {
          typeLabel = 'Drafting Companion';
          typeIcon = 'fa-regular fa-file-lines';
          iconBg = 'rgba(16, 185, 129, 0.08)';
          iconColor = '#10b981';
          titleText = item.input.title || 'Pembuatan Draf Jurnal';
          descText = `Abstrak: ${item.input.abstract ? item.input.abstract.slice(0, 100) + '...' : '-'}`;
        } else if (item.type === 'lit-review') {
          typeLabel = 'Literature Review';
          typeIcon = 'fa-solid fa-book-open-reader';
          iconBg = 'rgba(139, 92, 246, 0.08)';
          iconColor = '#8b5cf6';
          titleText = item.input.title || 'AI Literature Review';
          descText = `Referensi: ${item.output.citations ? item.output.citations.length : 0} paper ilmiah`;
        } else if (item.type === 'humanizer') {
          typeLabel = 'Humanizer Engine';
          typeIcon = 'fa-solid fa-wand-magic-sparkles';
          iconBg = 'rgba(245, 158, 11, 0.08)';
          iconColor = '#f59e0b';
          titleText = item.input.text ? item.input.text.slice(0, 80) + '...' : 'Teks Terhumanisasi';
          descText = `Mode: ${item.input.mode === 'academic' ? 'Akademik' : 'Standar'} | Nilai Keaslian: ${item.output.originalityScore}% | Biaya: ${item.output.actualCost} kata`;
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
              <h4 style="font-family: var(--font-outfit); font-weight: 800; font-size: 1rem; color: var(--text-main); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${titleText}">${titleText}</h4>
              <p style="font-size: 0.78rem; color: var(--text-muted); margin: 0.15rem 0 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${descText}</p>
            </div>
          </div>
          
          <div style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0;">
            <button class="upgrade-btn show-history-detail-btn" data-id="${item.id}" style="width: auto; padding: 0.5rem 1.25rem; font-size: 0.8rem; background: var(--brand-blue); color: #ffffff;" type="button">
              <i class="fa-regular fa-eye"></i> Lihat Detail
            </button>
            <button class="upgrade-btn delete-history-item-btn" data-id="${item.id}" style="width: auto; padding: 0.5rem; font-size: 0.8rem; background: transparent; border: 1px solid rgba(239, 68, 68, 0.2); color: #ef4444;" type="button" title="Hapus riwayat ini">
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
        typeLabel = 'AI Drafting Companion';
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
              <div><strong>Judul:</strong> ${item.input.title || '-'}</div>
              <div><strong>Kata Kunci:</strong> ${item.input.keywords || '-'}</div>
              <div><strong>Abstrak:</strong> ${item.input.abstract || '-'}</div>
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
              <div><strong>Judul:</strong> ${item.input.title || '-'}</div>
              <div><strong>Abstrak:</strong> ${item.input.abstract || '-'}</div>
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
                      ${points.map(pt => `<li>${pt}</li>`).join('')}
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
              <div><strong>Topik/Judul Penelitian:</strong> ${item.input.title || '-'}</div>
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
            <div style="background: #f8fafc; border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1rem; font-size: 0.85rem; max-height: 150px; overflow-y: auto; color: var(--text-muted); line-height: 1.5; white-space: pre-wrap;">${item.input.text}</div>
          </div>
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <h5 style="font-weight: 700; color: var(--text-main); font-size: 0.9rem; margin: 0;">TEKS HUMANISASI (OUTPUT)</h5>
              <button id="copyHistoryHumanizerBtn" class="upgrade-btn" style="width: auto; padding: 0.35rem 0.85rem; font-size: 0.75rem; background: #f59e0b; color: white;" type="button">
                <i class="fa-regular fa-copy"></i> Salin Hasil
              </button>
            </div>
            <div id="historyHumanizerTextWrapper" style="border: 1px solid var(--border-light-hover); border-radius: 8px; padding: 1.25rem; font-size: 0.85rem; background: #ffffff; line-height: 1.6; max-height: 250px; overflow-y: auto; color: var(--text-main); white-space: pre-wrap;">${item.output.humanizedText}</div>
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

    // --- BILINGUAL (LOCALIZATION) SYSTEM ---
    const TRANSLATIONS = {
      id: {
        beranda: "Beranda",
        "ai-research": "Asisten AI",
        templates: "Template Jurnal",
        "prompt-bank": "Prompt Bank",
        tersimpan: "Tersimpan",
        riwayat: "Riwayat AI",
        pengaturan: "Pengaturan",
        upgrade_pro: "Upgrade ke PRO",
        upgrade_desc: "Buka AI Match Score & filter tanpa batas",
        upgrade_btn: "Upgrade Sekarang",
        hello: "Halo, ",
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
        drafting_title: "AI Drafting Companion",
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
        quota_note_lit: "Limit bulanan Perplexity",
        quota_note_humanizer: "Sisa kuota kata Humanizer",
        // Billing
        billing_title: "Transaksi & Kuitansi",
        billing_desc: "Berikut adalah riwayat pembayaran langganan atau pembelian kuota kata Anda. Gunakan tombol kuitansi untuk mengunduh bukti bayar resmi guna reimbursement kampus/hibah."
      },
      en: {
        beranda: "Home",
        "ai-research": "AI Assistant",
        templates: "Journal Templates",
        "prompt-bank": "Prompt Bank",
        tersimpan: "Bookmarks",
        riwayat: "AI History",
        pengaturan: "Settings",
        upgrade_pro: "Upgrade to PRO",
        upgrade_desc: "Unlock Match Score & unlimited filters",
        upgrade_btn: "Upgrade Now",
        hello: "Hello, ",
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
        drafting_title: "AI Drafting Companion",
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
        quota_note_lit: "Perplexity monthly limit",
        quota_note_humanizer: "Remaining Humanizer words",
        // Billing
        billing_title: "Transactions & Receipts",
        billing_desc: "Here is your payment subscription or word quota purchase history. Use the receipt button to download official payment proof for university/grant reimbursement."
      }
    };

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
      const welcomeSpan = document.getElementById('welcomeText');
      if (welcomeSpan) {
        const email = currentUser?.email || 'user';
        welcomeSpan.textContent = TRANSLATIONS[lang].hello + email;
      }

      // 5. Translate Matcher Tab
      const matcherHeader = document.querySelector('#tabContentMatchScore h3');
      const matcherDesc = document.querySelector('#tabContentMatchScore p');
      const runMatchBtn = document.getElementById('runMatchBtn');
      if (matcherHeader) matcherHeader.textContent = TRANSLATIONS[lang].matcher_title;
      if (matcherDesc) matcherDesc.textContent = TRANSLATIONS[lang].matcher_desc;
      if (runMatchBtn) {
        runMatchBtn.innerHTML = runMatchBtn.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].matcher_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].matcher_btn_run}`;
      }

      // 6. Translate Drafting Tab
      const draftingHeader = document.querySelector('#tabContentDraftingCompanion h3');
      const draftingDesc = document.querySelector('#tabContentDraftingCompanion p');
      const runDraftGenerator = document.getElementById('runDraftGenerator');
      if (draftingHeader) draftingHeader.textContent = TRANSLATIONS[lang].drafting_title;
      if (draftingDesc) draftingDesc.textContent = TRANSLATIONS[lang].drafting_desc;
      if (runDraftGenerator) {
        runDraftGenerator.innerHTML = runDraftGenerator.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].drafting_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].drafting_btn_run}`;
      }

      // 7. Translate Lit Review Tab
      const litHeader = document.querySelector('#tabContentLitReview h3');
      const litDesc = document.querySelector('#tabContentLitReview p');
      const runLitReviewBtn = document.getElementById('runLitReviewBtn');
      if (litHeader) litHeader.textContent = TRANSLATIONS[lang].lit_title;
      if (litDesc) litDesc.textContent = TRANSLATIONS[lang].lit_desc;
      if (runLitReviewBtn) {
        runLitReviewBtn.innerHTML = runLitReviewBtn.classList.contains('loading')
          ? `<i class="fa-solid fa-spinner fa-spin"></i> ${TRANSLATIONS[lang].lit_btn_running}`
          : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${TRANSLATIONS[lang].lit_btn_run}`;
      }

      // 8. Translate Humanizer Tab
      const humanizerHeader = document.querySelector('#tabContentHumanizer h3');
      const humanizerDesc = document.querySelector('#tabContentHumanizer p');
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
        else if (type === 'draft') badge.textContent = lang === 'id' ? 'Drafting Companion' : 'Drafting Companion';
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
        if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = isEn ? 'Match unlimited · Draft 15x/month' : 'Match tanpa batas · Draft 15x/bulan';
      } else {
        const draftLimit = 1;
        txtQuotaMatchDraft.textContent = `${draftUsed} / ${draftLimit}`;
        const pct = Math.min(100, (draftUsed / draftLimit) * 100);
        barQuotaMatchDraft.style.width = `${pct}%`;
        barQuotaMatchDraft.style.background = pct > 85 ? '#ef4444' : (pct > 60 ? '#f59e0b' : 'var(--brand-blue)');
        if (lblMatchDraftLimitNote) lblMatchDraftLimitNote.textContent = isEn ? 'Match 1x/month · Draft 1x/month' : 'Match 1x/bulan · Draft 1x/bulan';
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

    activeJournals = JOURNAL_DATABASE;
    filterJournals(); // Apply preferences automatically
    calculateStats();
  }

  init();
});
