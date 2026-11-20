// Velcro Convert — boot. Loaded last so every feature file is defined before init runs.

(async function init() {
  checkLoginState();
  populateBanks();
  await fetchRequirements();
  fetchInstitutions();

  // Navigation Guard: Intercept browser & device Back button
  window.addEventListener('popstate', function () {
    if (_isNavBackTracking) {
      _isNavBackTracking = false;
      return;
    }

    // 1. If any modal / bottom sheet is open, close it cleanly without leaving the page
    if (typeof getTopOpenModal === 'function' && getTopOpenModal()) {
      closeTopOpenModal();
      return;
    }

    // 2. If Coming Soon view is active, Back navigates back to Swap view
    if (typeof isComingSoonActive === 'function' && isComingSoonActive()) {
      showSwapView(false);
      return;
    }

    // 2. If an order payment screen is active, confirm before exiting to prevent loss of details
    const buyGen = document.getElementById('buy-generated-account');
    const sellGen = document.getElementById('sell-generated-address');
    const isBuyActive = buyGen && !buyGen.classList.contains('hidden');
    const isSellActive = sellGen && !sellGen.classList.contains('hidden');

    if (isBuyActive || isSellActive) {
      const leave = confirm('Leave this order? Your current payment details will be closed.');
      if (leave) {
        if (isBuyActive && typeof resetBuyTransaction === 'function') resetBuyTransaction();
        if (isSellActive && typeof resetSellTransaction === 'function') resetSellTransaction();
      } else {
        if (typeof pushOrderHistory === 'function') pushOrderHistory(isBuyActive ? 'buy' : 'sell');
      }
    }
  });

  // Reload / Tab Close Guard: Trigger native "Changes you made may not be saved" prompt
  window.addEventListener('beforeunload', function (e) {
    if (typeof hasUnsavedRampChanges === 'function' && hasUnsavedRampChanges()) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
})();

// --- Bread-Style Hamburger Menu & Interactive Tools ---
var _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  const btn = document.getElementById('menu-install-btn');
  if (btn) btn.classList.remove('opacity-50');
});

function toggleInfoMenu() {
  const menu = document.getElementById('info-menu');
  if (menu) menu.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
  const widget = document.getElementById('info-widget');
  const menu = document.getElementById('info-menu');
  if (widget && menu && !widget.contains(e.target)) {
    menu.classList.add('hidden');
  }

  const dropdown = document.getElementById('nav-menu-dropdown');
  const toggleBtn = document.getElementById('nav-menu-toggle');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!dropdown.contains(e.target) && (!toggleBtn || !toggleBtn.contains(e.target))) {
      closeNavMenu();
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const hash = (window.location.hash || '').replace('#', '').toLowerCase();
  const email = (localStorage.getItem('velcro_user_email') || '').trim();

  if (hash === 'payment') {
    if (!email) {
      promptLoginOverlay(() => showComingSoon('payment'));
    } else {
      showComingSoon('payment', false);
    }
  } else if (['earn', 'vip'].includes(hash)) {
    showComingSoon(hash, false);
  } else if (hash === 'rewards') {
    if (!email) {
      promptLoginOverlay(openProfile);
    } else {
      if (typeof openProfile === 'function') openProfile();
    }
  } else if (hash === 'history') {
    if (!email) {
      promptLoginOverlay(showHistoryModal);
    } else {
      if (typeof showHistoryModal === 'function') showHistoryModal();
    }
  } else if (hash === 'support') {
    openSupportModal();
  }
});

function toggleNavMenu() {
  const dropdown = document.getElementById('nav-menu-dropdown');
  if (!dropdown) return;
  if (!dropdown.classList.contains('hidden')) {
    closeNavMenu();
  } else {
    openNavMenu();
  }
}

function openNavMenu() {
  const dropdown = document.getElementById('nav-menu-dropdown');
  const backdrop = document.getElementById('nav-menu-backdrop');
  const btn = document.getElementById('nav-menu-toggle');
  const iconLines = document.getElementById('hamburger-icon-lines');
  const iconClose = document.getElementById('hamburger-icon-close');
  if (!dropdown) return;
  if (typeof pushModalHistory === 'function') pushModalHistory('navMenu');
  dropdown.classList.remove('hidden');
  dropdown.classList.add('flex');
  if (backdrop) backdrop.classList.remove('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (iconLines) iconLines.classList.add('hidden');
  if (iconClose) iconClose.classList.remove('hidden');
}

function closeNavMenu() {
  if (typeof popModalHistory === 'function') popModalHistory('navMenu');
  const dropdown = document.getElementById('nav-menu-dropdown');
  const backdrop = document.getElementById('nav-menu-backdrop');
  const btn = document.getElementById('nav-menu-toggle');
  const iconLines = document.getElementById('hamburger-icon-lines');
  const iconClose = document.getElementById('hamburger-icon-close');
  if (dropdown) {
    dropdown.classList.add('hidden');
    dropdown.classList.remove('flex');
  }
  if (backdrop) backdrop.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (iconLines) iconLines.classList.remove('hidden');
  if (iconClose) iconClose.classList.add('hidden');
}

function setActiveMenuPill(activeKey) {
  const keys = ['swap', 'payment', 'history', 'earn', 'vip', 'rewards', 'support'];
  keys.forEach(k => {
    // Mobile modal pill
    const mBtn = document.getElementById('menu-btn-' + k);
    if (mBtn) {
      if (k === activeKey) {
        mBtn.className = 'mobile-menu-pill w-full py-3.5 px-6 rounded-full font-bold text-center text-base bg-[#6b46ff] text-white shadow-lg shadow-purple-500/25 active:scale-95 transition-all cursor-pointer';
      } else {
        mBtn.className = 'mobile-menu-pill w-full py-3.5 px-6 rounded-full font-bold text-center text-base bg-white dark:bg-slate-800 text-[#211138] dark:text-white shadow-md hover:bg-gray-50 dark:hover:bg-slate-700 active:scale-95 transition-all cursor-pointer';
      }
    }
    // Desktop inline pill
    const dBtn = document.getElementById('desk-nav-' + k);
    if (dBtn) {
      if (k === activeKey) {
        dBtn.className = 'desk-nav-pill px-4 py-2 rounded-full text-xs font-semibold transition-all cursor-pointer bg-[#6b46ff] text-white shadow-xs';
      } else {
        dBtn.className = 'desk-nav-pill px-4 py-2 rounded-full text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 transition-all cursor-pointer';
      }
    }
  });
}

const COMING_SOON_DATA = {
  payment: {
    title: 'Payments are on the way.',
    body: "Send and receive payments with a simple link or wallet address. We're getting everything ready for launch.",
    extra: '<a href="/store/" class="inline-flex items-center gap-1.5 text-xs font-semibold text-[#6b46ff] hover:underline">Looking for Velcro Store? Open store &rarr;</a>'
  },
  earn: {
    title: 'Earn is almost here.',
    body: "We're putting the finishing touches on a new way to grow your assets with Velcro. Stay tuned for the launch."
  },
  vip: {
    title: 'Private Client is on the way.',
    body: "Trade large volumes with competitive rates and dedicated execution. We're getting everything ready for launch.",
    extra: '<a href="https://wa.me/2347035428475?text=' + encodeURIComponent('Hi Velcro Desk, I am inquiring about Private Client / VIP OTC trades ($10k+ / ₦15M+).') + '" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-[#6b46ff] text-white hover:bg-[#5b36ef] shadow-sm transition-all">Chat with OTC Desk &rarr;</a>'
  }
};

function isComingSoonActive() {
  const cs = document.getElementById('feature-coming-soon');
  return cs && cs.style.display !== 'none';
}

function showComingSoon(feature, pushState = true) {
  if (feature === 'payment') {
    const email = (localStorage.getItem('velcro_user_email') || '').trim();
    if (!email) {
      promptLoginOverlay(() => showComingSoon('payment', pushState));
      return;
    }
  }

  const data = COMING_SOON_DATA[feature];
  if (!data) return;

  const convert = document.getElementById('convert');
  const cs = document.getElementById('feature-coming-soon');
  const title = document.getElementById('cs-title');
  const body = document.getElementById('cs-body');
  const extra = document.getElementById('cs-extra');

  if (title) title.textContent = data.title;
  if (body) body.textContent = data.body;
  if (extra) extra.innerHTML = data.extra || '';

  if (convert) convert.style.display = 'none';
  if (cs) {
    cs.style.display = 'flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  setActiveMenuPill(feature);

  if (pushState && window.history && window.history.pushState) {
    window.history.pushState({ view: 'coming-soon', feature: feature }, '', '#' + feature);
  }
}

function showSwapView(pushState = true) {
  const convert = document.getElementById('convert');
  const cs = document.getElementById('feature-coming-soon');

  if (cs) cs.style.display = 'none';
  if (convert) {
    convert.style.display = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  setActiveMenuPill('swap');

  if (pushState && window.history && window.history.pushState) {
    window.history.pushState({ view: 'swap' }, '', window.location.pathname);
  }
}

function handleMenuClick(action) {
  closeNavMenu();
  const email = (localStorage.getItem('velcro_user_email') || '').trim();

  switch (action) {
    case 'swap': {
      showSwapView();
      break;
    }
    case 'payment': {
      if (!email) {
        promptLoginOverlay(() => showComingSoon('payment'));
        return;
      }
      showComingSoon('payment');
      break;
    }
    case 'history': {
      if (!email) {
        promptLoginOverlay(showHistoryModal);
        return;
      }
      if (typeof showHistoryModal === 'function') showHistoryModal();
      break;
    }
    case 'earn': {
      showComingSoon('earn');
      break;
    }
    case 'vip': {
      showComingSoon('vip');
      break;
    }
    case 'rewards': {
      if (typeof isComingSoonActive === 'function' && isComingSoonActive()) {
        showSwapView();
      }
      if (!email) {
        promptLoginOverlay(openProfile);
        return;
      }
      if (typeof openProfile === 'function') {
        openProfile();
      }
      break;
    }
    case 'support': {
      openSupportModal();
      break;
    }
  }
}

function openSupportModal() {
  if (typeof pushModalHistory === 'function') pushModalHistory('support');
  const modal = document.getElementById('support-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';
  }
}

function closeSupportModal() {
  if (typeof popModalHistory === 'function') popModalHistory('support');
  const modal = document.getElementById('support-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
  }
}

function openVipModal() {
  if (typeof pushModalHistory === 'function') pushModalHistory('vip');
  const modal = document.getElementById('vip-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';
  }
}

function closeVipModal() {
  if (typeof popModalHistory === 'function') popModalHistory('vip');
  const modal = document.getElementById('vip-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
  }
}

async function triggerPwaInstall() {
  closeNavMenu();
  if (_deferredInstallPrompt) {
    try {
      _deferredInstallPrompt.prompt();
      const choice = await _deferredInstallPrompt.userChoice;
      _deferredInstallPrompt = null;
      if (choice && choice.outcome === 'accepted') {
        if (typeof showToast === 'function') showToast('Velcro installed successfully!', 'success');
      }
    } catch (e) {
      console.warn('PWA install error:', e);
    }
    return;
  }

  // iOS Safari check
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  if (isIos) {
    alert("To install Velcro on iOS:\n1. Tap the Share button in Safari (box with arrow up)\n2. Scroll down and tap 'Add to Home Screen'");
  } else {
    alert("To install Velcro:\nTap your browser menu (⋮) and select 'Install app' or 'Add to Home Screen'.");
  }
}

// --- Interactive Guided Tour ---
const TOUR_STEPS = [
  {
    target: '#convert',
    title: 'Welcome to Velcro Ramp',
    text: 'Exchange crypto (USDT, USDC, BTC, ETH, SOL) with Nigerian Naira instantly with automated bank payouts.'
  },
  {
    target: '#form-sell',
    title: 'Sell or Buy Crypto',
    text: 'Switch between Selling crypto for instant Naira bank payout, or Buying crypto with Naira transfer.'
  },
  {
    target: '#sell-send-panel',
    title: 'Select Coin & Network',
    text: 'Pick your cryptocurrency (USDT, BTC, etc.) and blockchain (Solana, TRON, Ethereum, etc.).'
  },
  {
    target: '#sell-bank-wrap',
    title: 'Verified Bank Settlement',
    text: 'Enter your bank account number. We automatically verify the account name to guarantee funds arrive safely.'
  },
  {
    target: '#sell-btn',
    title: 'Automated 60-Second Payout',
    text: 'Tap "Get deposit address" and send your crypto. Payout arrives in your Nigerian bank account in under 60 seconds!'
  }
];

let _currentTourStep = 0;

function startExchangeTour() {
  closeNavMenu();
  _currentTourStep = 0;
  showTourStep(0);
}

function showTourStep(index) {
  if (index >= TOUR_STEPS.length) {
    endExchangeTour();
    return;
  }
  _currentTourStep = index;
  const step = TOUR_STEPS[index];
  const overlay = document.getElementById('tour-overlay');
  const title = document.getElementById('tour-title');
  const text = document.getElementById('tour-text');
  const stepCounter = document.getElementById('tour-step-counter');
  const nextBtn = document.getElementById('tour-next-btn');

  if (title) title.textContent = step.title;
  if (text) text.textContent = step.text;
  if (stepCounter) stepCounter.textContent = `${index + 1} of ${TOUR_STEPS.length}`;
  if (nextBtn) nextBtn.textContent = (index === TOUR_STEPS.length - 1) ? 'Finish' : 'Next';

  const targetEl = document.querySelector(step.target);
  if (targetEl) {
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
  }
}

function nextTourStep() {
  showTourStep(_currentTourStep + 1);
}

function prevTourStep() {
  if (_currentTourStep > 0) {
    showTourStep(_currentTourStep - 1);
  }
}

function endExchangeTour() {
  const overlay = document.getElementById('tour-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }
}
