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
});

function toggleNavMenu() {
  const overlay = document.getElementById('nav-menu-overlay');
  if (!overlay) return;
  if (overlay.classList.contains('hidden')) {
    openNavMenu();
  } else {
    closeNavMenu();
  }
}

function openNavMenu() {
  const overlay = document.getElementById('nav-menu-overlay');
  if (!overlay) return;
  if (typeof pushModalHistory === 'function') pushModalHistory('navMenu');
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeNavMenu() {
  if (typeof popModalHistory === 'function') popModalHistory('navMenu');
  const overlay = document.getElementById('nav-menu-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

function handleMenuClick(action) {
  closeNavMenu();
  switch (action) {
    case 'swap': {
      const convert = document.getElementById('convert');
      if (convert) convert.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'payment': {
      window.location.href = '/store/';
      break;
    }
    case 'history': {
      if (typeof showHistoryModal === 'function') showHistoryModal();
      break;
    }
    case 'earn':
    case 'rewards': {
      if (typeof openProfile === 'function') openProfile();
      break;
    }
    case 'vip': {
      openVipModal();
      break;
    }
    case 'support': {
      window.open('https://wa.me/2347035428475?text=Hello%20Velcro%20Support,%20I%20need%20help%20with%20an%20exchange', '_blank', 'noopener,noreferrer');
      break;
    }
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
