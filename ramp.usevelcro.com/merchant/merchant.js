// Velcro Merchant: landing interactions, sign-in (password or Google), and the merchant dashboard
// (overview, prices, settings with branding + business verification, guided tour).
// Talks to /api/merchant/*; the signed-in token lives in localStorage.

const TOKEN_KEY = 'velcro_merchant_token';
const TOUR_KEY = 'velcro_merchant_tour_done';
const CLAIM_KEY = 'velcro_merchant_claim'; // store address picked on the landing page, used at set-up
const CLAIM_NAME_KEY = 'velcro_merchant_claim_name'; // and the name it came from
const COIN_LOGOS = { BTC: '/logos/bitcoin.png', ETH: '/logos/ethereum.png', SOL: '/logos/solana.png', USDT: '/logos/usdt.png', USDC: '/logos/usdc.png' };

let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* private mode */ }
let authMode = 'signin'; // signin | signup | signup-code | reset | reset-code
let me = null;            // /api/merchant/me payload
let merchant = null;      // me.merchant, kept fresh after every save
let velcroRates = {};     // Velcro's naira per $1 per coin, our fee included: {SYM: {buy, sell, provider}}
let pricingDraft = null;  // edits on the Prices tab before saving
let brandDraft = null;    // edits on the Settings tab before saving

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const naira = v => '₦' + Number(v).toLocaleString('en-NG', { maximumFractionDigits: Number(v) >= 1000 ? 0 : 2 });

function toast(msg) {
  const t = $('m-toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('is-on'), 3200);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Merchant-Token'] = token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.includes('/auth/')) setToken('');
  if (!res.ok) throw new Error(json.message || json.error || 'Something went wrong. Try again.');
  return json.data ?? json;
}

function setToken(t) {
  token = t || '';
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
}

// Store logo: the uploaded image, or the first letter on the brand colour.
function paintLogo(el, brand, fallbackName) {
  if (!el) return;
  el.style.setProperty('--brand', brand.color);
  if (brand.logo) {
    el.style.backgroundImage = `url("${brand.logo}")`;
    el.classList.add('has-img');
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
    el.textContent = (brand.name || fallbackName || 'V').trim().charAt(0).toUpperCase() || 'V';
  }
}

// ── Landing ──

function initLanding() {
  const nav = $('m-nav');
  const onScroll = () => nav.classList.toggle('is-solid', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Type a name, pick a colour: the exchange in the window changes as you go, and sign-up remembers it.
  const name = $('pv-name');
  const renderPreview = () => {
    const title = name.value.trim() || 'Your exchange';
    $('pv-logo').textContent = title.charAt(0).toUpperCase();
    $('pv-slug').textContent = slugify(title) || 'your-exchange';
  };
  name.addEventListener('input', () => {
    renderPreview();
    try {
      localStorage.setItem(CLAIM_KEY, slugify(name.value));
      localStorage.setItem(CLAIM_NAME_KEY, name.value.trim());
    } catch (e) { /* ignore */ }
  });
  document.querySelectorAll('.m-swatch').forEach(sw => sw.addEventListener('click', () => {
    document.querySelectorAll('.m-swatch').forEach(x => x.classList.toggle('is-on', x === sw));
    $('pv-store').style.setProperty('--brand', sw.dataset.color);
    $('pv-store').style.setProperty('--on-brand', autoText(sw.dataset.color));
  }));

  const vol = $('calc-vol');
  const mk = $('calc-mk');
  const fill = r => r.style.setProperty('--fill', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  const renderCalc = () => {
    $('calc-vol-out').textContent = naira(vol.value);
    $('calc-mk-out').textContent = Number(mk.value).toFixed(1) + '%';
    $('calc-out').textContent = naira(vol.value * mk.value / 100);
    fill(vol);
    fill(mk);
  };
  vol.addEventListener('input', renderCalc);
  mk.addEventListener('input', renderCalc);
  renderCalc();
}

// ── Auth dialog ──

const AUTH_COPY = {
  signin: ['Welcome back', 'Sign in to your merchant dashboard.', 'Sign in'],
  signup: ['Get started with Velcro Merchant', "Create your account. We'll email you a code to confirm it's you.", 'Continue'],
  'signup-code': ['Check your email', '', 'Create account'],
  reset: ['Reset your password', "Enter your email and we'll send you a code.", 'Send code'],
  'reset-code': ['Set a new password', '', 'Update password'],
};

function openAuth(mode) {
  if (token) { showApp(); return; }
  setAuthMode(mode);
  $('auth').classList.add('is-open');
  setTimeout(() => $('a-email').focus(), 50);
}

function closeAuth() { $('auth').classList.remove('is-open'); }

function setAuthMode(mode) {
  authMode = mode;
  const [title, sub, btn] = AUTH_COPY[mode];
  $('auth-title').textContent = title;
  $('auth-sub').textContent = sub || `We sent a 6-digit code to ${$('a-email').value.trim()}.`;
  $('auth-btn').textContent = btn;
  $('auth-error').classList.add('hidden');
  const codeStep = mode === 'signup-code' || mode === 'reset-code';
  $('a-code-row').classList.toggle('hidden', !codeStep);
  $('a-pass-row').classList.toggle('hidden', mode === 'signup' || mode === 'reset');
  $('a-forgot').classList.toggle('hidden', mode !== 'signin');
  $('a-pass-hint').classList.toggle('hidden', !codeStep);
  $('a-pass-label').textContent = codeStep ? 'Choose a password' : 'Password';
  $('a-pass').autocomplete = codeStep ? 'new-password' : 'current-password';
  $('a-email').readOnly = codeStep;
  $('google-wrap').classList.toggle('hidden', !googleReady || codeStep || mode === 'reset');
  $('auth-switch').innerHTML = mode === 'signin'
    ? 'New to Velcro Merchant? <button type="button" onclick="setAuthMode(\'signup\')">Create an account</button>'
    : 'Already have an account? <button type="button" onclick="setAuthMode(\'signin\')">Sign in</button>';
  if (codeStep) setTimeout(() => $('a-code').focus(), 50);
}

function authError(msg) {
  $('auth-error').textContent = msg;
  $('auth-error').classList.remove('hidden');
}

async function submitAuth(e) {
  e.preventDefault();
  const btn = $('auth-btn');
  const email = $('a-email').value.trim();
  const password = $('a-pass').value;
  const otp = $('a-code').value.trim();
  $('auth-error').classList.add('hidden');
  if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  try {
    if (authMode === 'signin') {
      signedIn(await api('/api/merchant/auth/login', { method: 'POST', body: { email, password } }));
    } else if (authMode === 'signup') {
      await api('/api/merchant/auth/signup/code', { method: 'POST', body: { email } });
      setAuthMode('signup-code');
    } else if (authMode === 'signup-code') {
      signedIn(await api('/api/merchant/auth/signup', { method: 'POST', body: { email, otp, password } }));
    } else if (authMode === 'reset') {
      await api('/api/merchant/auth/reset/code', { method: 'POST', body: { email } });
      setAuthMode('reset-code');
    } else if (authMode === 'reset-code') {
      signedIn(await api('/api/merchant/auth/reset', { method: 'POST', body: { email, otp, password } }));
    }
  } catch (err) {
    authError(err.message);
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Please wait…') btn.textContent = label;
  }
}

function signedIn(data) {
  setToken(data.token);
  closeAuth();
  $('a-pass').value = '';
  $('a-code').value = '';
  showApp();
}

let googleReady = false;
async function initGoogle() {
  let cfg;
  try { cfg = await api('/api/merchant/config'); } catch (e) { return; }
  if (!cfg.google_client_id) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      callback: async resp => {
        try {
          signedIn(await api('/api/merchant/auth/google', { method: 'POST', body: { credential: resp.credential } }));
        } catch (err) { authError(err.message); }
      },
    });
    google.accounts.id.renderButton($('google-btn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
    googleReady = true;
    if ($('auth').classList.contains('is-open')) setAuthMode(authMode);
  };
  document.head.appendChild(s);
}

function signOut() {
  setToken('');
  me = merchant = null;
  // Nothing of this account stays on the page for whoever signs in next.
  orders = customers = earnings = null;
  clearTimeout(ordersTimer);
  ['ord-list', 'cus-list', 'wd-list', 'ov-recent', 'ord-sum', 'cus-sum'].forEach(id => { $(id).innerHTML = ''; });
  endTour();
  $('avatar-menu').classList.add('hidden');
  $('app').classList.add('hidden');
  $('landing').classList.remove('hidden');
  history.replaceState(null, '', '/merchant/');
  window.scrollTo(0, 0);
}

function toggleMenu() {
  const menu = $('avatar-menu');
  menu.classList.toggle('hidden');
  $('avatar-btn').setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
}

// ── Dashboard ──

async function showApp() {
  $('landing').classList.add('hidden');
  $('app').classList.remove('hidden');
  document.querySelectorAll('.d-tab').forEach(t => t.classList.add('hidden'));
  $('app-loading').classList.remove('hidden');
  window.scrollTo(0, 0);
  try {
    const [data, prices] = await Promise.all([api('/api/merchant/me'), api('/api/merchant/prices').catch(() => ({ prices: {} }))]);
    me = data;
    merchant = data.merchant;
    velcroRates = prices.rates || {};
    $('app-loading').classList.add('hidden');
    renderAll();
    openTab((location.hash || '').replace('#', '') || 'overview');
    let toured = false;
    try { toured = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { toured = true; }
    if (!toured) setTimeout(() => startTour(false), 600);
  } catch (err) {
    if (!token) { signOut(); openAuth('signin'); return; }
    $('app-loading').textContent = err.message;
  }
}

// ── Orders ──

let orders = null;
let orderFilter = 'all';
let ordersTimer = null;
let activeModalRef = null;
const OPEN_STATUSES = ['AWAITING_DEPOSIT', 'PENDING', 'DETECTED', 'RECEIVED', 'VERIFIED', 'CONFIRMED', 'PROCESSING', 'INITIATED', 'REVIEW'];
const ORDER_STATUS = {
  INITIATED: ['Initiated', 'wait'],
  AWAITING_DEPOSIT: ['Awaiting deposit', 'wait'],
  PENDING: ['Pending', 'wait'],
  DETECTED: ['Deposit detected', 'busy'],
  CONFIRMED: ['Deposit confirmed', 'busy'],
  RECEIVED: ['Payment received', 'busy'],
  VERIFIED: ['Payment verified', 'busy'],
  PROCESSING: ['Processing swap', 'busy'],
  REVIEW: ['Under review', 'warn'],
  COMPLETED: ['Completed', 'live'],
  FAILED: ['Failed', 'bad'],
  CANCELLED: ['Cancelled', 'off'],
  EXPIRED: ['Expired', 'off'],
};
const PROVIDER_NAMES = {
  hostfi: 'HostFi',
  switch: 'Switch',
  paj: 'PAJ',
};

function getOrderProvider(o) {
  if (o.provider) return o.provider.toLowerCase();
  const rawCh = String(o.channel || '').toUpperCase();
  if (rawCh === 'HOSTFI') return 'hostfi';
  if (rawCh === 'PAJ' || String(o.reference || '').startsWith('paj_')) return 'paj';
  if (o.coin === 'BTC' || o.coin === 'ETH') return 'hostfi';
  return 'switch';
}

function getOrderStepNumber(status) {
  const s = String(status || '').toUpperCase();
  if (['COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(s)) return 4;
  if (['PROCESSING', 'REVIEW'].includes(s)) return 3;
  if (['DETECTED', 'CONFIRMED', 'RECEIVED', 'VERIFIED'].includes(s)) return 2;
  return 1;
}

function getOrderNetworkLabel(o) {
  if (o.network) return o.network;
  const c = String(o.coin || '').toUpperCase();
  if (c === 'BTC') return 'Bitcoin';
  if (c === 'SOL') return 'Solana';
  if (c === 'ETH') return 'Ethereum';
  if (c === 'USDT' || c === 'USDC') return 'TRON / Arbitrum';
  return '';
}

const statusHtml = ([label, cls]) => `<span class="d-st is-${cls}">${esc(label)}</span>`;
const coinText = o => (o.coin_amount ? `${Number(o.coin_amount).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${esc(o.coin)}` : esc(o.coin));
const shortRef = r => { const v = String(r || ''); return v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-5)}` : v; };
const logoImg = sym => (COIN_LOGOS[sym] ? `<img src="${COIN_LOGOS[sym]}" alt="">` : '');
const when = v => { const d = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

async function loadOrders() {
  try {
    const data = await api('/api/merchant/orders');
    orders = data.orders || [];
    const sm = data.summary || {};
    $('ov-orders').textContent = String(sm.orders_month || 0);
    $('ov-volume').textContent = naira(sm.volume_month_ngn || 0);
    $('ov-earned').textContent = naira(sm.earned_month_ngn || 0);
    $('ord-sum').innerHTML = `<span><b>${orders.length}</b> orders</span><span><b>${naira(sm.earned_total_ngn || 0)}</b> earned in total</span>`;
    renderOrders();
    renderRecentOrders();
    if (activeModalRef && $('ord-modal').classList.contains('is-open')) {
      openOrderDetail(activeModalRef, true);
    }
  } catch (e) {
    $('ord-list').innerHTML = `<p class="d-sheet-msg">${esc(e.message)}</p>`;
    $('ov-recent').innerHTML = `<p class="d-quiet">${esc(e.message)}</p>`;
  }
  // Orders still moving refresh themselves while the tab is open or modal is displayed.
  clearTimeout(ordersTimer);
  const hasActive = orders && orders.some(o => OPEN_STATUSES.includes(o.status));
  if ((hasActive || activeModalRef) && (!$('tab-orders').classList.contains('hidden') || $('ord-modal').classList.contains('is-open'))) {
    ordersTimer = setTimeout(loadOrders, 15000);
  }
}

function shownOrders() {
  const q = ($('ord-q').value || '').trim().toLowerCase();
  return (orders || []).filter(o => {
    if (orderFilter === 'buy' || orderFilter === 'sell') { if (o.side !== orderFilter) return false; }
    if (orderFilter === 'open' && !OPEN_STATUSES.includes(o.status)) return false;
    if (orderFilter === 'done' && o.status !== 'COMPLETED') return false;
    return !q || [o.customer_email, o.customer_name, o.coin, o.reference].some(v => String(v || '').toLowerCase().includes(q));
  });
}

function getExplorerUrl(hash, network) {
  if (!hash) return '';
  const net = String(network || '').toLowerCase();
  if (net.includes('sol')) return `https://solscan.io/tx/${hash}`;
  if (net.includes('eth')) return `https://etherscan.io/tx/${hash}`;
  if (net.includes('btc') || net.includes('bitcoin')) return `https://mempool.space/tx/${hash}`;
  if (net.includes('bsc') || net.includes('binance')) return `https://bscscan.com/tx/${hash}`;
  if (net.includes('tron') || net.includes('trc')) return `https://tronscan.org/#/transaction/${hash}`;
  if (net.includes('base')) return `https://basescan.org/tx/${hash}`;
  if (net.includes('poly') || net.includes('matic')) return `https://polygonscan.com/tx/${hash}`;
  if (net.includes('arb')) return `https://arbiscan.io/tx/${hash}`;
  return '';
}

function getWalletExplorerUrl(address, network) {
  if (!address) return '';
  const net = String(network || '').toLowerCase();
  if (net.includes('sol')) return `https://solscan.io/account/${address}`;
  if (net.includes('btc') || net.includes('bitcoin')) return `https://mempool.space/address/${address}`;
  if (net.includes('tron') || net.includes('trc')) return `https://tronscan.org/#/address/${address}`;
  if (net.includes('base')) return `https://basescan.org/address/${address}`;
  if (net.includes('poly') || net.includes('matic')) return `https://polygonscan.com/address/${address}`;
  if (net.includes('arb')) return `https://arbiscan.io/address/${address}`;
  if (net.includes('bsc') || net.includes('binance')) return `https://bscscan.com/address/${address}`;
  if (net.includes('opt')) return `https://optimistic.etherscan.io/address/${address}`;
  return `https://etherscan.io/address/${address}`;
}

function copyOrdText(text, msg = 'Copied to clipboard') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    toast(msg);
  });
}

function closeOrderModal() {
  activeModalRef = null;
  const m = $('ord-modal');
  if (m) m.classList.remove('is-open');
}

function orderTimelineHtml(o) {
  const isBuy = o.side === 'buy';
  const status = String(o.status || '').toUpperCase();
  const step = getOrderStepNumber(status);
  const prov = getOrderProvider(o);
  const done = status === 'COMPLETED';
  const isFailed = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(status);
  const net = getOrderNetworkLabel(o);

  const step1State = step >= 1 ? 'is-done' : 'is-pending';
  const step1Desc = isBuy ? 'Naira bank transfer account generated' : `Deposit address & QR generated for ${esc(o.coin)}`;

  let step2State = 'is-pending';
  let step2Title = 'Deposit detected';
  let step2Desc = '';
  if (step === 2) {
    step2State = 'is-active';
    if (isBuy) {
      step2Title = 'Payment detected';
      step2Desc = 'Naira bank transfer seen on interbank network';
    } else if (prov === 'hostfi' && o.coin === 'BTC') {
      step2Desc = 'Seen on Bitcoin mempool; awaiting 1 network confirmation (10–60m)';
    } else if (prov === 'hostfi' && o.coin === 'ETH') {
      step2Desc = 'Seen on Ethereum network; awaiting block confirmations';
    } else if (prov === 'paj') {
      step2Desc = 'Deposit detected on Solana network';
    } else {
      step2Desc = `Deposit detected on ${esc(net || 'network')}; confirming blocks`;
    }
  } else if (step > 2) {
    step2State = 'is-done';
    step2Title = isBuy ? 'Payment received' : 'Deposit confirmed';
    step2Desc = isBuy ? 'Naira transfer verified via banking rails' : `Deposit confirmed on ${esc(net || 'blockchain')}`;
  } else {
    step2State = 'is-pending';
    step2Title = isBuy ? 'Awaiting transfer' : 'Awaiting crypto deposit';
    step2Desc = isBuy ? 'Checking Nigerian interbank network' : `Waiting for transfer on ${esc(net || 'network')}`;
  }

  let step3State = 'is-pending';
  let step3Title = isBuy ? `Sending ${esc(o.coin)}` : 'Paying Naira to bank';
  let step3Desc = '';
  if (status === 'REVIEW') {
    step3State = 'is-warn';
    step3Title = 'Compliance review';
    step3Desc = 'Order held under safety review. Funds are protected and will settle shortly.';
  } else if (step === 3) {
    step3State = 'is-active';
    if (isBuy) {
      step3Desc = `${PROVIDER_NAMES[prov] || 'Provider'} broadcasting ${coinText(o)} to customer wallet`;
    } else {
      step3Desc = `Converting and dispatching ${naira(o.naira)} via NIP bank transfer`;
    }
  } else if (step > 3 && done) {
    step3State = 'is-done';
    step3Title = isBuy ? `${esc(o.coin)} sent` : 'Naira paid';
    step3Desc = isBuy ? `Broadcasted to customer wallet on ${esc(net)}` : `Sent to ${esc(o.payout_bank_name || 'bank')} account`;
  } else if (step > 3 && isFailed) {
    step3State = 'is-bad';
    step3Title = 'Swap stopped';
    step3Desc = 'Order did not complete.';
  } else {
    step3State = 'is-pending';
    step3Desc = isBuy ? `Dispatches ${esc(o.coin)} upon payment verification` : `Dispatches Naira upon ${esc(o.coin)} confirmation`;
  }

  let step4State = 'is-pending';
  let step4Title = 'Settled';
  let step4Desc = 'Final ledger settlement';
  if (done) {
    step4State = 'is-done';
    step4Title = 'Completed & settled';
    step4Desc = isBuy ? (o.hash ? `Confirmed on-chain (Tx: ${esc(shortRef(o.hash))})` : 'Confirmed in customer wallet') : `Naira settled to ${esc(o.payout_account_number ? o.payout_account_number.slice(0, 4) + '•••' + o.payout_account_number.slice(-3) : 'customer bank')}`;
  } else if (isFailed) {
    step4State = 'is-bad';
    step4Title = `Order ${status.toLowerCase()}`;
    step4Desc = status === 'EXPIRED' ? 'Payment window expired before deposit arrived' : 'Order was cancelled or failed.';
  }

  const checkIco = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const crossIco = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const warnIco = `!`;

  return `
    <div class="ord-timeline">
      <div class="ord-step ${step1State}">
        <span class="ord-step-dot">${step1State === 'is-done' ? checkIco : '1'}</span>
        <div class="ord-step-body">
          <div class="ord-step-title">Order Created</div>
          <div class="ord-step-desc">${step1Desc}</div>
        </div>
      </div>
      <div class="ord-step ${step2State}">
        <span class="ord-step-dot">${step2State === 'is-done' ? checkIco : (step2State === 'is-bad' ? crossIco : '2')}</span>
        <div class="ord-step-body">
          <div class="ord-step-title">${step2Title}</div>
          <div class="ord-step-desc">${step2Desc}</div>
        </div>
      </div>
      <div class="ord-step ${step3State}">
        <span class="ord-step-dot">${step3State === 'is-done' ? checkIco : (step3State === 'is-warn' ? warnIco : (step3State === 'is-bad' ? crossIco : '3'))}</span>
        <div class="ord-step-body">
          <div class="ord-step-title">${step3Title}</div>
          <div class="ord-step-desc">${step3Desc}</div>
        </div>
      </div>
      <div class="ord-step ${step4State}">
        <span class="ord-step-dot">${step4State === 'is-done' ? checkIco : (step4State === 'is-bad' ? crossIco : '4')}</span>
        <div class="ord-step-body">
          <div class="ord-step-title">${step4Title}</div>
          <div class="ord-step-desc">${step4Desc}</div>
        </div>
      </div>
    </div>
  `;
}

function orderDepositBoxHtml(o) {
  if (!o.deposit_address) return '';
  const prov = getOrderProvider(o);
  const net = getOrderNetworkLabel(o);

  let techNotice = '';
  if (prov === 'hostfi' && o.coin === 'BTC') {
    techNotice = `<div class="ord-tech-notice is-hostfi"><strong>HostFi Bitcoin Rails:</strong> Dynamic deposit address. Accepts any amount. Bitcoin confirmations typically take 10–60 minutes. Payout to customer bank triggers automatically upon 1 block confirmation.</div>`;
  } else if (prov === 'hostfi') {
    techNotice = `<div class="ord-tech-notice is-hostfi"><strong>HostFi Dynamic Address:</strong> Accepts any incoming deposit amount. Converted and paid out to customer bank upon network confirmation.</div>`;
  } else if (prov === 'switch') {
    techNotice = `<div class="ord-tech-notice is-switch"><strong>Switch Rails:</strong> Customer sends crypto on ${esc(net || 'network')}. Payout to customer bank executes automatically upon transaction confirmation.</div>`;
  } else if (prov === 'paj') {
    techNotice = `<div class="ord-tech-notice is-paj"><strong>PAJ Solana Rails:</strong> High-speed Solana network settlement. Confirms within seconds.</div>`;
  }

  const memoClean = o.deposit_note ? String(o.deposit_note).replace(/^Memo:\s*/i, '').trim() : '';
  const explorerAddrUrl = getWalletExplorerUrl(o.deposit_address, o.network || o.coin);

  return `
    <div class="ord-qr-card">
      <div class="ord-qr-header">
        <span class="ord-qr-pill">Scan to Pay Deposit Address</span>
        <p class="ord-qr-instruction">Scan with any <b>${esc(o.coin)}</b> wallet on <b>${esc(net || 'network')}</b></p>
      </div>

      <div class="ord-qr-wrap">
        <div id="ord-qr-code"></div>
      </div>

      <div class="ord-addr-block">
        <code title="${esc(o.deposit_address)}">${esc(o.deposit_address)}</code>
        <button type="button" class="ord-copy-btn" onclick="copyOrdText('${esc(o.deposit_address)}', 'Deposit address copied')">
          Copy
        </button>
      </div>

      ${memoClean ? `
        <div class="ord-memo-callout">
          <div class="ord-memo-top">
            <span class="ord-memo-label">⚠️ Required Memo / Tag</span>
          </div>
          <div class="ord-memo-val">
            <code>${esc(memoClean)}</code>
            <button type="button" class="ord-copy-btn" onclick="copyOrdText('${esc(memoClean)}', 'Memo copied')">Copy Memo</button>
          </div>
          <span class="ord-memo-sub">Customer must include this memo when transferring, otherwise the deposit cannot be credited.</span>
        </div>
      ` : ''}

      ${techNotice}

      ${explorerAddrUrl ? `
        <a href="${esc(explorerAddrUrl)}" target="_blank" rel="noopener" class="ord-link-subtle">
          View deposit address on blockchain explorer ↗
        </a>
      ` : ''}
    </div>
  `;
}

function orderBankPayHtml(o) {
  if (o.side !== 'buy' || !o.deposit_bank_name || !o.deposit_account_number) return '';
  const prov = getOrderProvider(o);
  return `
    <div class="ord-bank-pay-card">
      <div class="ord-bank-pay-head">
        <span class="ord-bank-pay-pill">Naira Bank Transfer Details</span>
        <small>${PROVIDER_NAMES[prov] || 'Velcro'} dynamic account</small>
      </div>
      <div class="ord-bank-rows">
        <div class="ord-bank-row">
          <span>Bank</span>
          <b>${esc(o.deposit_bank_name)}</b>
        </div>
        <div class="ord-bank-row is-highlight">
          <span>Account number</span>
          <div class="ord-val-copy">
            <code>${esc(o.deposit_account_number)}</code>
            <button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.deposit_account_number)}', 'Account number copied')">Copy</button>
          </div>
        </div>
        ${o.deposit_account_name ? `
          <div class="ord-bank-row">
            <span>Account name</span>
            <b>${esc(o.deposit_account_name)}</b>
          </div>
        ` : ''}
        <div class="ord-bank-row">
          <span>Amount to send</span>
          <div class="ord-val-copy">
            <b>${naira(o.naira)}</b>
            <button type="button" class="ord-copy" onclick="copyOrdText('${Math.round(o.naira)}', 'Amount copied')">Copy</button>
          </div>
        </div>
      </div>
      <p class="ord-bank-tech-note">Customer transfers directly from any Nigerian banking app. Monitored in real-time via ${PROVIDER_NAMES[prov] || 'Velcro'} rails.</p>
    </div>
  `;
}

function renderModalQr(address) {
  const qrEl = $('ord-qr-code');
  if (!qrEl || !address) return;
  qrEl.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    try {
      new QRCode(qrEl, {
        text: address,
        width: 140,
        height: 140,
        colorDark: '#15151f',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (e) {
      qrEl.innerHTML = '<span style="font-size:12px;color:var(--muted)">QR Code ready</span>';
    }
  } else {
    qrEl.innerHTML = '<span style="font-size:12px;color:var(--muted)">QR Code ready</span>';
  }
}

function openOrderDetail(ref, isSilentUpdate = false) {
  const o = (orders || []).find(x => x.reference === ref);
  if (!o) return;
  activeModalRef = ref;
  const done = o.status === 'COMPLETED';
  const isBuy = o.side === 'buy';
  const prov = getOrderProvider(o);
  const net = getOrderNetworkLabel(o);
  const [statusName, statusCls] = ORDER_STATUS[o.status] || [o.status, 'off'];
  const explorerUrl = o.hash ? getExplorerUrl(o.hash, o.network || o.coin) : '';
  const shortH = o.hash && o.hash.length > 18 ? `${o.hash.slice(0, 10)}…${o.hash.slice(-8)}` : (o.hash || '');
  const shortW = o.wallet_address && o.wallet_address.length > 18 ? `${o.wallet_address.slice(0, 10)}…${o.wallet_address.slice(-8)}` : (o.wallet_address || '');

  $('ord-modal-body').innerHTML = `
    <div class="ord-head">
      <div class="ord-head-main">
        ${logoImg(o.coin)}
        <div class="ord-head-titles">
          <div class="ord-head-title-row">
            <h2 id="ord-modal-title">${isBuy ? 'Buy' : 'Sell'} ${esc(o.coin)}</h2>
            <span class="ord-tag ord-tag-prov is-${prov}">Rail: ${PROVIDER_NAMES[prov] || prov}</span>
            ${net ? `<span class="ord-tag ord-tag-net">${esc(net)}</span>` : ''}
          </div>
          <p>${when(o.created_at)} · Ref: <code>${esc(shortRef(o.reference))}</code></p>
        </div>
      </div>
      <span class="d-st is-${statusCls}">${esc(statusName)}</span>
    </div>

    ${orderTimelineHtml(o)}

    ${o.deposit_address && !done ? orderDepositBoxHtml(o) : ''}
    ${isBuy && o.deposit_bank_name && !done ? orderBankPayHtml(o) : ''}

    <div class="ord-receipt">
      <div class="ord-receipt-hero">
        <div>
          <small>${isBuy ? 'Customer pays' : 'Customer sends'}</small>
          <b>${isBuy ? (o.naira ? naira(o.naira) : '—') : coinText(o)}</b>
        </div>
        <div>
          <small>${isBuy ? 'Customer gets' : 'Customer receives'}</small>
          <b>${isBuy ? coinText(o) : (o.naira ? naira(o.naira) : '—')}</b>
        </div>
      </div>

      <div class="ord-dl">
        <div class="ord-row">
          <dt>Reference</dt>
          <dd class="ord-val-copy">
            <code>${esc(o.reference)}</code>
            <button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.reference)}', 'Reference copied')">Copy</button>
          </dd>
        </div>
        <div class="ord-row">
          <dt>Customer</dt>
          <dd><b>${esc(o.customer_name || 'Customer')}</b> <span style="font-weight:400;color:var(--muted)">(${esc(o.customer_email || '—')})</span></dd>
        </div>
        ${o.rate ? `<div class="ord-row"><dt>Rate</dt><dd>${naira(o.rate)}</dd></div>` : ''}
        <div class="ord-row">
          <dt>Your markup</dt>
          <dd>${o.markup_percent}%</dd>
        </div>
        <div class="ord-row">
          <dt>Your earnings</dt>
          <dd><b class="${done ? 'is-earned' : 'is-pending'}">${o.earned ? naira(o.earned) : '₦0'}</b>${done ? '' : ' <small style="font-weight:400;color:var(--muted)">(pending completion)</small>'}</dd>
        </div>
        <div class="ord-row">
          <dt>Processing rail</dt>
          <dd><b>${PROVIDER_NAMES[prov] || prov}</b> <span style="font-weight:400;color:var(--muted)">(${prov === 'hostfi' ? 'HostFi API' : (prov === 'paj' ? 'PAJ Solana' : 'Switch EVM/TRON')})</span></dd>
        </div>
      </div>
    </div>

    <div class="ord-dl" style="padding: 0 4px;">
      ${isBuy && o.wallet_address ? `
        <div class="ord-row">
          <dt>Customer wallet</dt>
          <dd class="ord-val-copy">
            <code title="${esc(o.wallet_address)}">${esc(shortW)}</code>
            <button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.wallet_address)}', 'Wallet address copied')">Copy</button>
          </dd>
        </div>` : ''}

      ${!isBuy && (o.payout_bank_name || o.payout_account_number) ? `
        <div class="ord-row">
          <dt>Payout destination</dt>
          <dd class="ord-val-copy">
            <span>${esc(o.payout_bank_name || 'Bank')} · <code>${esc(o.payout_account_number || '')}</code></span>
            ${o.payout_account_number ? `<button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.payout_account_number)}', 'Account number copied')">Copy</button>` : ''}
          </dd>
        </div>
        ${o.payout_account_name ? `
        <div class="ord-row">
          <dt>Account name</dt>
          <dd>${esc(o.payout_account_name)}</dd>
        </div>` : ''}` : ''}

      ${o.deposit_bank_name && done ? `
        <div class="ord-row">
          <dt>Paid via</dt>
          <dd class="ord-val-copy">
            <span>${esc(o.deposit_bank_name)} · <code>${esc(o.deposit_account_number || '')}</code></span>
          </dd>
        </div>` : ''}

      ${o.deposit_address && done ? `
        <div class="ord-row">
          <dt>Deposit address</dt>
          <dd class="ord-val-copy">
            <code>${esc(o.deposit_address.length > 18 ? o.deposit_address.slice(0, 10) + '…' + o.deposit_address.slice(-8) : o.deposit_address)}</code>
            <button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.deposit_address)}', 'Deposit address copied')">Copy</button>
          </dd>
        </div>` : ''}

      ${o.hash ? `
        <div class="ord-row">
          <dt>Transaction hash</dt>
          <dd class="ord-val-copy">
            <code title="${esc(o.hash)}">${esc(shortH)}</code>
            <button type="button" class="ord-copy" onclick="copyOrdText('${esc(o.hash)}', 'Transaction hash copied')">Copy</button>
          </dd>
        </div>` : ''}
    </div>

    ${explorerUrl ? `
      <a href="${esc(explorerUrl)}" target="_blank" rel="noopener" class="ord-btn-link">
        View on Blockchain Explorer ↗
      </a>` : (isBuy && o.wallet_address ? `
      <a href="${esc(getWalletExplorerUrl(o.wallet_address, o.network || o.coin))}" target="_blank" rel="noopener" class="ord-btn-link ord-btn-subtle">
        Check Wallet on Explorer ↗
      </a>` : '')}
  `;

  if (o.deposit_address && !done) {
    renderModalQr(o.deposit_address);
  }

  if (!isSilentUpdate) {
    $('ord-modal').classList.add('is-open');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeOrderModal();
});

function renderOrders() {
  const list = $('ord-list');
  if (!orders || !orders.length) { list.innerHTML = $('ord-empty').innerHTML; return; }
  const rows = shownOrders();
  list.innerHTML = rows.length ? `<table class="d-table d-orders"><thead><tr><th>Order</th><th>Customer</th><th class="is-num">Amount</th><th class="is-num">Your markup</th><th>Status</th><th class="is-end">Date</th></tr></thead><tbody>${rows.map(o => {
    const done = o.status === 'COMPLETED';
    const prov = getOrderProvider(o);
    const net = getOrderNetworkLabel(o);
    return `<tr class="is-clickable" onclick="openOrderDetail('${esc(o.reference)}')">
      <td class="c-order">
        <span class="d-who">${logoImg(o.coin)}
          <span class="d-cell">
            <span class="d-cell-row">
              <b>${o.side === 'buy' ? 'Buy' : 'Sell'} ${esc(o.coin)}</b>
              <span class="d-badge-mini is-${prov}">${PROVIDER_NAMES[prov] || prov}</span>
            </span>
            <small title="${esc(o.reference)}">${esc(shortRef(o.reference))}${net ? ' · ' + esc(net) : ''}</small>
          </span>
        </span>
      </td>
      <td class="c-who"><span class="d-cell"><b>${esc(o.customer_name || (o.customer_email || '').split('@')[0])}</b><small>${esc(o.customer_email || '')}</small></span></td>
      <td class="c-amt is-num"><span class="d-cell"><b>${o.naira ? naira(o.naira) : '—'}</b><small>${coinText(o)}</small></span></td>
      <td class="c-earn is-num"><span class="d-cell"><b class="${done ? 'is-earned' : 'is-pending'}">${o.earned ? naira(o.earned) : '—'}</b><small>${o.markup_percent}%${done ? '' : ' · if completed'}</small></span></td>
      <td class="c-st">${statusHtml(ORDER_STATUS[o.status] || [o.status, 'off'])}</td>
      <td class="c-date is-end"><span class="d-date">${when(o.created_at)}</span></td>
    </tr>`;
  }).join('')}</tbody></table>` : '<p class="d-sheet-msg">No orders match.</p>';
}

// The five newest, on the overview.
function renderRecentOrders() {
  const rows = (orders || []).slice(0, 5);
  $('ov-recent').innerHTML = rows.length ? rows.map(o => {
    const prov = getOrderProvider(o);
    return `<div class="d-mini is-clickable" onclick="openOrderDetail('${esc(o.reference)}')">${logoImg(o.coin)}
      <span class="d-mini-l">
        <span class="d-cell-row">
          <b>${o.side === 'buy' ? 'Buy' : 'Sell'} ${esc(o.coin)}</b>
          <span class="d-badge-mini is-${prov}">${PROVIDER_NAMES[prov] || prov}</span>
        </span>
        <small>${esc(o.customer_name || o.customer_email || '')}</small>
      </span>
      <span class="d-mini-r"><b>${o.naira ? naira(o.naira) : coinText(o)}</b>${statusHtml(ORDER_STATUS[o.status] || [o.status, 'off'])}</span>
    </div>`;
  }).join('') : `<div class="d-mini-empty"><p>Every buy and sell on your exchange shows up here.</p><button type="button" class="d-btn-quiet" onclick="shareStore()">Share your exchange</button></div>`;
}

function exportOrders() {
  const rows = shownOrders();
  if (!rows.length) return toast('No orders to export');
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Date', 'Reference', 'Customer', 'Email', 'Side', 'Coin', 'Coin amount', 'Naira', 'Markup %', 'Earned (NGN)', 'Status']]
    .concat(rows.map(o => [o.created_at, o.reference, o.customer_name || '', o.customer_email || '', o.side, o.coin, o.coin_amount ?? '', o.naira, o.markup_percent, o.earned, o.status]))
    .map(r => r.map(cell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${(merchant.slug || 'exchange')}-orders.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Customers ──

let customers = null;
async function loadCustomers() {
  try {
    const data = await api('/api/merchant/customers');
    customers = data.customers || [];
    const active = customers.filter(c => c.orders > 0).length;
    $('cus-sum').innerHTML = `<span><b>${customers.length}</b> customers</span><span><b>${active}</b> have ordered</span>`;
    renderCustomers();
  } catch (e) {
    $('cus-list').innerHTML = `<p class="d-sheet-msg">${esc(e.message)}</p>`;
  }
}

function renderCustomers() {
  const list = $('cus-list');
  if (!customers || !customers.length) { list.innerHTML = $('cus-empty').innerHTML; return; }
  const q = ($('cus-q').value || '').trim().toLowerCase();
  const rows = customers.filter(c => !q || [c.email, c.name].some(v => String(v || '').toLowerCase().includes(q)));
  list.innerHTML = rows.length ? `<table class="d-table d-customers"><thead><tr><th>Customer</th><th class="is-num">Orders</th><th class="is-num">Completed volume</th><th>Last order</th><th class="is-end">Joined</th></tr></thead><tbody>${rows.map(c => `<tr>
      <td class="c-who"><span class="d-who"><span class="d-av">${esc((c.name || c.email).trim().charAt(0).toUpperCase())}</span><span class="d-cell"><b>${esc(c.name || c.email.split('@')[0])}</b><small>${esc(c.email)}</small></span></span></td>
      <td class="c-orders is-num" data-label="Orders"><b>${c.orders}</b></td>
      <td class="c-vol is-num" data-label="Volume"><b>${c.volume_ngn ? naira(c.volume_ngn) : '—'}</b></td>
      <td class="c-last" data-label="Last order"><span class="d-date">${c.last_order_at ? when(c.last_order_at) : '—'}</span></td>
      <td class="c-joined is-end" data-label="Joined"><span class="d-date">${when(c.since)}</span></td>
    </tr>`).join('')}</tbody></table>` : '<p class="d-sheet-msg">No customers match.</p>';
}

// ── Earnings and withdrawals ──

let earnings = null;
let wdCurrency = 'NGN';
let wdStep = 1;
let wdBanks = null;
let wdAccountName = '';
const WD_STATUS = { PENDING: ['Waiting to be paid', 'wait'], APPROVED: ['Paid', 'live'], REJECTED: ['Not sent', 'bad'] };

async function loadEarnings() {
  try {
    earnings = await api('/api/merchant/earnings');
  } catch (e) {
    $('wd-list').innerHTML = `<p class="d-sheet-msg">${esc(e.message)}</p>`;
    return;
  }
  const e = earnings;
  $('earn-available').textContent = naira(e.available_ngn);
  $('ov-available').textContent = naira(e.available_ngn);
  $('earn-usd').textContent = e.available_usd !== null ? `≈ $${Number(e.available_usd).toFixed(2)} · minimum $${e.min_usd}` : '';
  $('earn-total').textContent = naira(e.earned_ngn);
  $('earn-pending').textContent = naira(e.pending_ngn);
  $('earn-paid').textContent = naira(e.paid_ngn);
  $('earn-reason').textContent = e.reason || '';
  $('earn-reason').classList.toggle('hidden', !e.reason);
  $('earn-withdraw').disabled = !e.can_withdraw;
  $('wd-chain').innerHTML = Object.entries(e.chains || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  $('wd-list').innerHTML = e.withdrawals.length ? `<table class="d-table d-wds"><thead><tr><th>Amount</th><th>To</th><th>Status</th><th class="is-end">Requested</th></tr></thead><tbody>${e.withdrawals.map(w => `<tr>
      <td class="c-amt"><span class="d-cell"><b>${w.currency === 'NGN' ? naira(w.amount_ngn) : '$' + Number(w.amount_usd).toFixed(2) + ' USDC'}</b><small>${w.currency === 'NGN' ? 'Naira' : naira(w.amount_ngn) + ' of earnings'}</small></span></td>
      <td class="c-to"><span class="d-cell">${esc(w.to)}${w.payout_ref ? `<small>Ref ${esc(w.payout_ref)}</small>` : ''}${w.status === 'REJECTED' && w.note ? `<small class="is-bad-note">${esc(w.note)}</small>` : ''}</span></td>
      <td class="c-st">${statusHtml(WD_STATUS[w.status] || [w.status, 'off'])}</td>
      <td class="c-date is-end"><span class="d-date">${when(w.created_at)}</span></td>
    </tr>`).join('')}</tbody></table>` : '<p class="d-sheet-msg">No withdrawals yet. Your markup on every completed order adds up here.</p>';
}

async function openWithdraw() {
  if (!earnings || !earnings.can_withdraw) return;
  wdStep = 1;
  $('wd-step2').classList.add('hidden');
  $('wd-error').classList.add('hidden');
  $('wd-btn').textContent = 'Email me a code';
  $('wd-amount').textContent = naira(earnings.available_ngn);
  $('wd-form').classList.remove('hidden');
  setWdCurrency(wdCurrency);
  $('wd-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!wdBanks) {
    try {
      const raw = await api('/api/institutions?country=NG&currency=NGN&channel=BANK');
      wdBanks = (Array.isArray(raw) ? raw : (raw.data || [])).filter(b => b && b.name).sort((a, b) => a.name.localeCompare(b.name));
      $('wd-bank').innerHTML = '<option value="">Choose your bank</option>' + wdBanks.map(b => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join('');
    } catch (e) { /* the naira option shows the error on lookup */ }
  }
}

function closeWithdraw() {
  $('wd-form').classList.add('hidden');
}

function setWdCurrency(c) {
  wdCurrency = c;
  document.querySelectorAll('[data-wd]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.wd === c)));
  $('wd-ngn').classList.toggle('hidden', c !== 'NGN');
  $('wd-usdc').classList.toggle('hidden', c !== 'USDC');
  const usd = earnings && earnings.available_usd !== null ? `$${Number(earnings.available_usd).toFixed(2)} USDC` : 'USDC';
  $('wd-amount').textContent = c === 'NGN' ? naira(earnings.available_ngn) : usd;
}

// HostFi pays the naira, so its lookup is the name shown (and checked again on the server).
let wdNameTimer = null;
function checkWdAccount() {
  const acct = $('wd-acct').value.replace(/\D/g, '').slice(0, 10);
  $('wd-acct').value = acct;
  wdAccountName = '';
  const out = $('wd-name');
  out.className = 'm-hint d-span-2';
  clearTimeout(wdNameTimer);
  const bank = (wdBanks || []).find(b => b.code === $('wd-bank').value);
  if (!bank || acct.length !== 10) { out.textContent = 'We check the name on the account before anything is sent.'; return; }
  out.textContent = 'Checking the account…';
  wdNameTimer = setTimeout(async () => {
    try {
      const d = await api('/api/hostfi/resolve', { method: 'POST', body: { bankCode: bank.code, bankName: bank.name, accountNumber: acct } });
      if (!d.accountName) throw new Error('We couldn’t find that account.');
      wdAccountName = d.accountName;
      out.className = 'm-hint d-span-2 is-ok';
      out.textContent = '✓ ' + d.accountName;
    } catch (e) {
      out.className = 'm-hint d-span-2 is-bad';
      out.textContent = e.message;
    }
  }, 300);
}

async function submitWithdraw(ev) {
  ev.preventDefault();
  const err = $('wd-error');
  const btn = $('wd-btn');
  err.classList.add('hidden');
  const body = { currency: wdCurrency };
  if (wdCurrency === 'NGN') {
    const bank = (wdBanks || []).find(b => b.code === $('wd-bank').value);
    if (!bank || !wdAccountName) { err.textContent = 'Choose your bank and enter an account number we can verify.'; err.classList.remove('hidden'); return; }
    Object.assign(body, { bank_code: bank.code, bank_name: bank.name, account_number: $('wd-acct').value });
  } else {
    Object.assign(body, { chain: $('wd-chain').value, address: $('wd-addr').value.trim() });
    if (!body.address) { err.textContent = 'Paste your USDC wallet address.'; err.classList.remove('hidden'); return; }
  }
  btn.disabled = true;
  try {
    if (wdStep === 1) {
      await api('/api/merchant/withdraw/code', { method: 'POST' });
      wdStep = 2;
      $('wd-step2').classList.remove('hidden');
      btn.textContent = `Withdraw ${$('wd-amount').textContent}`;
      $('wd-code').focus();
      toast(`Code sent to ${me.email}`);
    } else {
      await api('/api/merchant/withdraw', { method: 'POST', body: { ...body, otp: $('wd-code').value.trim() } });
      $('wd-code').value = '';
      closeWithdraw();
      toast('Withdrawal requested. We’ll email you when it’s sent.');
      loadEarnings();
    }
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

function renderAll() {
  renderHeader();
  renderOverview();
  renderPrices();
  renderSettings();
}

function openTab(name) {
  if (!$('tab-' + name)) name = 'overview';
  if (name === 'settings') openSettings(null);
  if (name === 'orders' || name === 'overview') loadOrders();
  if (name === 'customers') loadCustomers();
  if (name === 'earnings' || name === 'overview') loadEarnings();
  document.querySelectorAll('.d-tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  document.querySelectorAll('.d-tabs button').forEach(b => b.classList.toggle('is-on', b.dataset.tab === name));
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function storeName() {
  return merchant.brand.name || merchant.business_name || 'Your exchange';
}

function renderHeader() {
  paintLogo($('hdr-logo'), merchant.brand, storeName());
  $('hdr-name').textContent = storeName();
  $('hdr-email').textContent = me.email;
  $('menu-name').textContent = me.name || storeName();
  $('avatar-initial').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
  const [cls, words] = HDR_STATUS[merchant.status] || HDR_STATUS.DRAFT;
  $('hdr-status').className = 'd-st is-' + cls;
  $('hdr-status').textContent = words;
  const url = merchant.storefront_url;
  ['hdr-view', 'menu-view'].forEach(id => {
    $(id).classList.toggle('hidden', !url);
    if (url) $(id).href = url;
  });
}

const HDR_STATUS = { DRAFT: ['off', 'Not live'], PENDING: ['wait', 'In review'], REJECTED: ['bad', 'Needs changes'], APPROVED: ['live', 'Live'], SUSPENDED: ['bad', 'Suspended'] };

const BANNERS = {
  DRAFT: ['Verify your business to put your exchange live.', 'It takes about three minutes. You can set up your exchange while we review it.', 'Start verification', () => goToKyb()],
  PENDING: ["We're reviewing your business.", "Usually within a working day. We'll email you as soon as you're approved.", 'View details', () => goToKyb()],
  REJECTED: ['We need a few changes before your exchange can go live.', '', 'Fix details', () => goToKyb()],
  SUSPENDED: ['Your exchange is suspended and offline.', '', 'Contact support', () => window.open('https://chat.whatsapp.com/FNiWMH0bnwgHT7lHhF32ab', '_blank')],
};

function renderOverview() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const who = (me.name || '').split(' ')[0] || storeName();
  $('ov-hello').textContent = `${part}, ${who}`;
  paintStrip();
  paintSteps();
  paintOverviewPrices();
}

// The bottom of the ledger: the live link, or what's between the merchant and going live.
function paintStrip() {
  const strip = $('ov-strip');
  const url = merchant.storefront_url;
  if (merchant.status === 'APPROVED' && url) {
    strip.innerHTML = `<span class="d-st is-live">Live</span><span class="d-strip-url">${esc(url.replace(/^https?:\/\//, ''))}</span>
      <span class="d-strip-btns"><button type="button" onclick="shareStore()">Copy link</button><a href="${esc(url)}" target="_blank" rel="noopener">Open exchange</a></span>`;
    return;
  }
  const [title, sub, btn, action] = BANNERS[merchant.status] || BANNERS.DRAFT;
  const note = merchant.review_note ? `Reason: ${merchant.review_note}` : sub;
  strip.innerHTML = `<span class="d-strip-text"><b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</span><span class="d-strip-btns"><button type="button" class="d-btn-lime">${esc(btn)}</button></span>`;
  strip.querySelector('button').onclick = action;
}

// Set-up steps show only until they're done.
function paintSteps() {
  const ck = merchant.checklist;
  const steps = [
    ['branded', 'Personalize your exchange', 'Name, address and look', () => openPanel('store')],
    ['priced', 'Set your prices', 'Your markup per coin', () => openTab('prices')],
    ['verified', 'Verify your business', merchant.status === 'PENDING' ? 'Under review' : 'Goes live after approval', () => goToKyb()],
  ];
  const box = $('ov-steps');
  const waiting = steps.filter(([key]) => !ck[key] && !(key === 'verified' && merchant.status === 'PENDING'));
  box.classList.toggle('hidden', !waiting.length);
  box.innerHTML = steps.map(([key, label, hint], i) => `<button type="button" class="${ck[key] ? 'is-done' : ''}" data-i="${i}"><i>${ck[key] ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>' : i + 1}</i><span><b>${esc(label)}</b><small>${ck[key] ? 'Done' : esc(hint)}</small></span></button>`).join('');
  box.querySelectorAll('button').forEach(b => { b.onclick = steps[b.dataset.i][3]; });
}

// What customers pay right now, coin by coin.
function paintOverviewPrices() {
  const cell = (sym, side) => {
    const p = merchant.pricing[sym];
    if (!p[side + '_on']) return '<i>Off</i>';
    const rate = customerRate(sym, side, p[side]);
    return rate ? nairaRate(rate) : '<i>—</i>';
  };
  $('ov-price-rows').innerHTML = `<div class="d-rate-head"><span></span><span>They buy at</span><span>They sell at</span></div>` + Object.keys(me.coins).map(sym => `<div class="d-rate"><span>${logoImg(sym)}${sym}</span><span>${cell(sym, 'buy')}</span><span>${cell(sym, 'sell')}</span></div>`).join('');
}

function openPanel(panel) {
  openTab('settings');
  openSettings(panel);
}

function goToKyb() {
  openPanel('kyb');
}

// Settings: a home of cards, each opening one panel.
const SETTINGS_PANELS = { store: 'panel-store', kyb: 'kyb-form', security: 'panel-security', support: 'panel-support' };

function openSettings(panel) {
  $('set-home').classList.toggle('hidden', !!panel);
  $('set-panel').classList.toggle('hidden', !panel);
  Object.entries(SETTINGS_PANELS).forEach(([key, id]) => $(id).classList.toggle('hidden', key !== panel));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const STATUS_WORDS = { DRAFT: ['wait', 'Not verified yet'], PENDING: ['wait', 'Verification under review'], REJECTED: ['bad', 'Changes needed'], APPROVED: ['live', 'Verified'], SUSPENDED: ['bad', 'Suspended'] };

function renderSettingsHome() {
  paintLogo($('set-logo'), merchant.brand, storeName());
  $('set-name').textContent = storeName();
  $('set-email').textContent = me.email;
  const [cls, words] = STATUS_WORDS[merchant.status] || STATUS_WORDS.DRAFT;
  $('set-badge').className = 'd-st is-' + cls;
  $('set-badge').textContent = words;
  const live = merchant.status === 'APPROVED' && merchant.storefront_url;
  $('set-cta').textContent = live ? 'View exchange' : merchant.status === 'PENDING' ? 'View details' : 'Complete verification';
  $('set-cta').onclick = () => (live ? window.open(merchant.storefront_url, '_blank') : openSettings('kyb'));
  $('set-kyb-sub').textContent = {
    DRAFT: 'Verify your business to put your exchange live.',
    PENDING: "We're reviewing your details. Usually within a working day.",
    REJECTED: 'We need a few changes. Open to see what.',
    APPROVED: 'Your business is verified.',
    SUSPENDED: 'Your exchange is suspended.',
  }[merchant.status] || '';
  $('sec-email').textContent = me.email;
  $('sup-url').value = merchant.brand.support_url || '';
}

let secStep = 1;
async function submitSecurity(e) {
  e.preventDefault();
  const btn = $('sec-btn');
  const err = $('sec-error');
  err.classList.add('hidden');
  btn.disabled = true;
  try {
    if (secStep === 1) {
      await api('/api/merchant/auth/reset/code', { method: 'POST', body: { email: me.email } });
      secStep = 2;
      $('sec-step2').classList.remove('hidden');
      btn.textContent = 'Update password';
      $('sec-code').focus();
    } else {
      const data = await api('/api/merchant/auth/reset', { method: 'POST', body: { email: me.email, otp: $('sec-code').value.trim(), password: $('sec-pass').value } });
      setToken(data.token);
      secStep = 1;
      $('sec-step2').classList.add('hidden');
      $('sec-code').value = '';
      $('sec-pass').value = '';
      btn.textContent = 'Email me a code';
      toast('Password updated. Other devices were signed out.');
      openSettings(null);
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function submitSupport(e) {
  e.preventDefault();
  const btn = $('sup-btn');
  const err = $('sup-error');
  err.classList.add('hidden');
  btn.disabled = true;
  try {
    merchant = await api('/api/merchant/support', { method: 'POST', body: { support_url: $('sup-url').value.trim() } });
    toast($('sup-url').value.trim() ? 'Support link saved' : 'Support link removed');
    renderAll();
    openSettings(null);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function shareStore() {
  if (!merchant.slug) {
    toast('Choose your exchange address first');
    openPanel('store');
    setTimeout(() => $('b-slug').focus(), 150);
    return;
  }
  try {
    await navigator.clipboard.writeText(merchant.storefront_url);
    toast(merchant.status === 'APPROVED' ? 'Exchange link copied' : 'Link copied. It goes live once you’re verified');
  } catch (e) {
    toast(merchant.storefront_url);
  }
}

// ── Prices ──

/** A customer's naira per $1: Velcro's rate with the markup added (buy) or taken off (sell). */
function customerRate(sym, side, markup) {
  const base = (velcroRates[sym] || {})[side];
  if (!base) return null;
  return side === 'buy' ? base * (1 + markup / 100) : base * (1 - markup / 100);
}

const nairaRate = v => '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateText = v => '$1 = ' + nairaRate(v);

function renderPrices() {
  pricingDraft = JSON.parse(JSON.stringify(merchant.pricing));
  pricingDraft._display = merchant.rate_display || 'final';
  document.querySelectorAll('input[name="rate-display"]').forEach(r => {
    r.checked = r.value === pricingDraft._display;
    r.onchange = () => { pricingDraft._display = r.value; paintPriceRows(true); };
  });
  $('max-markup').textContent = me.max_markup;
  $('price-rows').innerHTML = Object.entries(me.coins).map(([sym, name]) => {
    const side = (key, label) => `<div class="d-side-cell" data-cell="${sym}-${key}">
        <span class="d-side-label">${label}</span>
        <button type="button" class="d-toggle" role="switch" aria-label="${sym} ${key} on/off" data-sym="${sym}" data-side="${key}"></button>
        <label class="d-markup"><input type="number" inputmode="decimal" min="0" max="${me.max_markup}" step="0.05" data-sym="${sym}" data-side="${key}" aria-label="${sym} ${key} markup %"><span>%</span></label>
        <div class="d-result" data-out="${sym}-${key}"></div>
      </div>`;
    return `<div class="d-price-row" data-row="${sym}"><span class="d-coin">${logoImg(sym)}<span><b>${sym}</b><small>${esc(name)}</small></span></span>${side('buy', 'Customers buy')}${side('sell', 'Customers sell')}</div>`;
  }).join('');
  document.querySelectorAll('#price-rows input').forEach(inp => {
    inp.value = pricingDraft[inp.dataset.sym][inp.dataset.side];
    inp.addEventListener('input', () => {
      pricingDraft[inp.dataset.sym][inp.dataset.side] = Math.max(0, Math.min(me.max_markup, Number(inp.value) || 0));
      paintPriceRows(true);
    });
  });
  document.querySelectorAll('#price-rows .d-toggle').forEach(t => t.addEventListener('click', () => {
    const p = pricingDraft[t.dataset.sym];
    p[t.dataset.side + '_on'] = !p[t.dataset.side + '_on'];
    paintPriceRows(true);
  }));
  paintPriceRows(false);
}

function paintPriceRows(dirty) {
  Object.keys(me.coins).forEach(sym => {
    const p = pricingDraft[sym];
    ['buy', 'sell'].forEach(side => {
      const on = p[side + '_on'];
      const base = (velcroRates[sym] || {})[side];
      const rate = customerRate(sym, side, p[side]);
      document.querySelector(`.d-toggle[data-sym="${sym}"][data-side="${side}"]`).setAttribute('aria-checked', String(on));
      document.querySelector(`input[data-sym="${sym}"][data-side="${side}"]`).disabled = !on;
      const out = document.querySelector(`[data-out="${sym}-${side}"]`);
      document.querySelector(`[data-cell="${sym}-${side}"]`).classList.toggle('is-off', !on);
      out.innerHTML = !on ? '<span class="is-none">Hidden</span>'
        : rate ? `<b>${rateText(rate)}</b><small>Velcro ${nairaRate(base)}</small>` : '<span class="is-none">Rate unavailable</span>';
    });
  });
  // Example for the display choice, from the first coin with a buy rate.
  const ex = Object.keys(me.coins).find(sym => customerRate(sym, 'buy', pricingDraft[sym].buy));
  if (ex) {
    $('disp-final').textContent = rateText(customerRate(ex, 'buy', pricingDraft[ex].buy)) + ` · ${ex}`;
    $('disp-breakdown').textContent = `${rateText(velcroRates[ex].buy)} + ${pricingDraft[ex].buy}% fee · ${ex}`;
  }
  $('prices-bar').classList.toggle('is-on', dirty);
}

async function savePrices() {
  const btn = $('prices-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const { _display: display, ...coins } = pricingDraft;
    merchant = await api('/api/merchant/pricing', { method: 'POST', body: { coins, display } });
    toast('Prices saved');
    renderAll();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  } finally {
    btn.textContent = 'Save prices';
  }
}

// ── Settings: branding ──

function renderSettings() {
  // The name they tried on the public page carries over until they've saved their own.
  let claimed = '';
  let claimedName = '';
  try {
    claimed = merchant.slug ? '' : (localStorage.getItem(CLAIM_KEY) || '');
    claimedName = merchant.slug ? '' : (localStorage.getItem(CLAIM_NAME_KEY) || '');
  } catch (e) { /* ignore */ }
  brandDraft = {
    name: merchant.brand.name || merchant.business_name || claimedName,
    slug: merchant.slug || claimed,
    color: merchant.brand.color,
    buttonText: merchant.brand.button_text || null,
    welcome: merchant.brand.welcome || '',
    layout: merchant.brand.layout || 'classic',
    logo: merchant.brand.logo,
    logoData: null,
    removeLogo: false,
  };
  brandSaved = JSON.stringify(brandSnapshot());
  $('b-name').value = brandDraft.name;
  $('b-slug').value = brandDraft.slug;
  $('b-welcome').value = brandDraft.welcome;
  const locked = ['APPROVED', 'SUSPENDED'].includes(merchant.status) && !!merchant.slug;
  $('b-name').readOnly = locked;
  $('b-slug').readOnly = locked;
  $('b-name-msg').classList.toggle('hidden', !locked);
  $('b-slug-msg').className = 'm-hint';
  $('b-slug-msg').textContent = locked ? 'Your exchange link is fixed now that you’re verified.' : "Lowercase letters, numbers and hyphens. It's fixed once you're verified.";
  delete $('b-slug').dataset.edited;
  $('brand-error').classList.add('hidden');
  paintBrand();
  renderKyb();
  renderSettingsHome();
}

// Contrast ratio between two hex colours (WCAG), 1 to 21.
function contrast(a, b) {
  const lum = hex => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// Black or white, whichever reads better on the colour. Matches the store page.
const autoText = hex => contrast(hex, '#14142b') > contrast(hex, '#ffffff') ? '#14142b' : '#ffffff';
const isHex = v => /^#[0-9a-f]{6}$/i.test(v);
let brandSaved = '';

function brandSnapshot() {
  const d = brandDraft;
  return { name: d.name.trim(), slug: d.slug, color: d.color, buttonText: d.buttonText, welcome: d.welcome.trim(), layout: d.layout, logo: d.removeLogo ? null : (d.logoData || d.logo) };
}

function paintReadability(id, label, ratio) {
  const [word, cls] = ratio >= 7 ? ['Great', 'ok'] : ratio >= 4.5 ? ['Good', 'ok'] : ratio >= 3 ? ['Fair, fine for big text', 'meh'] : ['Hard to read', 'bad'];
  const box = $(id);
  box.className = 'd-read is-' + cls;
  box.querySelector('p').textContent = `${label}: ${word} (${ratio.toFixed(1)}:1)`;
  box.querySelector('i').style.width = Math.min(100, (ratio / 7) * 100) + '%';
}

function paintBrand() {
  const d = brandDraft;
  const brand = { name: d.name, color: d.color, logo: d.removeLogo ? null : (d.logoData || d.logo) };
  const btnText = d.buttonText || autoText(d.color);
  document.querySelectorAll('.d-swatch').forEach(s => s.classList.toggle('is-on', s.dataset.color === d.color));
  $('b-color').value = d.color;
  $('b-btn').value = btnText;
  if (document.activeElement !== $('b-color-hex')) $('b-color-hex').value = d.color.toUpperCase();
  if (document.activeElement !== $('b-btn-hex')) $('b-btn-hex').value = btnText.toUpperCase();
  $('b-btn-auto').innerHTML = d.buttonText ? '<button type="button" class="d-link" id="b-btn-reset">Use automatic</button>' : 'Picked for best contrast';
  const reset = $('b-btn-reset');
  if (reset) reset.onclick = () => { d.buttonText = null; paintBrand(); };
  $('b-welcome-count').textContent = `${d.welcome.length}/140`;
  paintLogo($('b-logo-preview'), brand, 'Y');
  $('b-logo-remove').classList.toggle('hidden', !brand.logo);
  document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.layout === d.layout)));
  const cardThumb = document.querySelector('[data-layout="card"] .d-lay');
  if (cardThumb) cardThumb.style.setProperty('--brand', d.color);
  paintReadability('rd-theme', 'Theme colour on white', contrast(d.color, '#ffffff'));
  paintReadability('rd-btn', 'Button text', contrast(btnText, d.color));
  renderPhone(brand, btnText);
  const dirty = JSON.stringify(brandSnapshot()) !== brandSaved;
  $('brand-dirty').textContent = dirty ? 'Unsaved changes' : 'No unsaved changes';
  $('brand-dirty').classList.toggle('is-dirty', dirty);
}

// A phone-sized copy of the store page, drawn from the draft.
function renderPhone(brand, btnText) {
  const d = brandDraft;
  const screen = $('b-preview');
  screen.className = 'd-phone-screen is-' + d.layout;
  screen.style.setProperty('--brand', d.color);
  screen.style.setProperty('--on-brand', btnText);
  screen.style.setProperty('--on-brand-auto', autoText(d.color));
  const coins = Object.keys((me && me.coins) || {}).filter(sym => merchant.pricing[sym] && merchant.pricing[sym].buy_on);
  const buyRate = sym => customerRate(sym, 'buy', merchant.pricing[sym].buy);
  // USDT first, like the store itself.
  const first = ['USDT', 'USDC'].find(sym => coins.includes(sym) && buyRate(sym)) || coins.find(buyRate) || coins[0] || 'USDT';
  const rate = coins.includes(first) ? buyRate(first) : null;
  const usdPrice = ['USDT', 'USDC'].includes(first) ? 1 : (velcroRates[first] || {}).usd;
  const getAmount = rate && usdPrice ? 100000 / rate / usdPrice : null;
  const getText = getAmount ? getAmount.toLocaleString('en-US', ['USDT', 'USDC'].includes(first) ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 6 }) : '…';
  const name = d.name.trim() || 'Your exchange';
  const welcome = d.welcome.trim();
  const shown = coins.filter(buyRate);
  screen.innerHTML = `
    <div class="bp-status"><span>9:41</span><span aria-hidden="true"><i></i><i></i><i></i></span></div>
    <div class="bp-top"><span class="bp-logo" id="bp-logo"></span><b>${esc(name)}</b><span>Sign in</span></div>
    ${welcome ? `<p class="bp-welcome">${esc(welcome)}</p>` : ''}
    <div class="bp-ticket">
      <div class="bp-tabs"><span class="is-on">Buy</span><span>Sell</span></div>
      <div class="bp-stack">
        <div class="bp-coin">${logoImg(first)}<span><b>${first}</b><small>${rate ? rateText(rate) : 'Rate unavailable right now'}</small></span></div>
        <div class="bp-field"><small>You pay</small><p><b>100,000</b><em>NGN</em></p></div>
        <div class="bp-field is-out"><small>You get</small><p><b>${getText}</b><em>${first}</em></p></div>
      </div>
      <div class="bp-tear" aria-hidden="true"></div>
      <span class="bp-cta">Buy ${first}</span>
    </div>
    <div class="bp-rates">
      <b>Today's rates <small>to buy, per $1</small></b>
      ${shown.length ? `<div class="bp-rate-row">${shown.map(sym => `<div class="bp-rate"><span>${logoImg(sym)}${sym}</span><b>${nairaRate(buyRate(sym))}</b></div>`).join('')}</div>` : '<p class="bp-empty">Switch on coins in Prices to show rates.</p>'}
    </div>
    <p class="bp-foot">${esc(name)} · Powered by Velcro</p>`;
  paintLogo($('bp-logo'), brand, 'Y');
  $('bp-open').href = '/m/' + (merchant.slug || '');
  $('bp-open').classList.toggle('hidden', !merchant.slug);
}

let slugTimer = null;
function checkSlug() {
  const input = $('b-slug');
  if (input.readOnly) return;
  input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
  brandDraft.slug = input.value;
  paintBrand();
  const msg = $('b-slug-msg');
  clearTimeout(slugTimer);
  if (!input.value) { msg.className = 'm-hint'; msg.textContent = 'Lowercase letters, numbers and hyphens.'; return; }
  msg.className = 'm-hint';
  msg.textContent = 'Checking…';
  slugTimer = setTimeout(async () => {
    try {
      const r = await api('/api/merchant/slug-check?slug=' + encodeURIComponent(input.value));
      if (r.slug !== input.value) return;
      msg.className = 'm-hint ' + (r.available ? 'is-ok' : 'is-bad');
      msg.textContent = r.available ? `✓ ramp.usevelcro.com/m/${r.slug} is available` : r.reason;
    } catch (err) {
      msg.className = 'm-hint is-bad';
      msg.textContent = err.message;
    }
  }, 350);
}

function pickLogo(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Use a PNG, JPG or WebP image');
  if (file.size > 400 * 1024) return toast('Logos can be up to 400 KB');
  const reader = new FileReader();
  reader.onload = () => { brandDraft.logoData = reader.result; brandDraft.removeLogo = false; paintBrand(); };
  reader.readAsDataURL(file);
}

async function saveBrand(e) {
  e.preventDefault();
  const btn = $('brand-save');
  const err = $('brand-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const body = {
      name: $('b-name').value.trim(),
      slug: $('b-slug').value.trim(),
      color: brandDraft.color,
      button_text: brandDraft.buttonText,
      welcome: brandDraft.welcome.trim(),
      layout: brandDraft.layout,
    };
    if (brandDraft.logoData) body.logo = brandDraft.logoData;
    if (brandDraft.removeLogo) body.remove_logo = true;
    merchant = await api('/api/merchant/brand', { method: 'POST', body });
    try { localStorage.removeItem(CLAIM_KEY); localStorage.removeItem(CLAIM_NAME_KEY); } catch (e2) { /* ignore */ }
    toast('Changes saved');
    renderAll();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

// ── Settings: business verification ──

const KYB_BADGES = { DRAFT: ['off', 'Not started'], PENDING: ['wait', 'Under review'], REJECTED: ['bad', 'Changes needed'], APPROVED: ['live', 'Verified'], SUSPENDED: ['bad', 'Suspended'] };

function fillSelect(sel, options, placeholder, value) {
  sel.innerHTML = `<option value="">${esc(placeholder)}</option>` + Object.entries(options).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = value || '';
}

function renderKyb() {
  const f = $('kyb-form');
  fillSelect($('f-type'), me.business_types, 'Choose one', merchant.business_type);
  fillSelect($('f-volume'), me.volumes, 'Choose a range', merchant.monthly_volume);
  ['business_name', 'registration_number', 'contact_name', 'phone', 'website', 'description'].forEach(k => { f.elements[k].value = merchant[k] || ''; });
  if (!f.elements.contact_name.value && me.name) f.elements.contact_name.value = me.name;
  $('f-reg-row').classList.toggle('hidden', $('f-type').value !== 'registered');
  const [cls, label] = KYB_BADGES[merchant.status] || KYB_BADGES.DRAFT;
  $('kyb-badge').className = 'd-st is-' + cls;
  $('kyb-badge').textContent = label;
  $('kyb-note').classList.toggle('hidden', !merchant.review_note);
  $('kyb-note').textContent = merchant.review_note ? 'Reason: ' + merchant.review_note : '';
  const locked = ['APPROVED', 'SUSPENDED'].includes(merchant.status);
  $('kyb-fields').disabled = locked;
  $('kyb-save').classList.toggle('hidden', locked);
  $('kyb-save').textContent = merchant.status === 'DRAFT' ? 'Submit for verification' : 'Update and resubmit';
  $('f-terms').checked = false;
  $('kyb-error').classList.add('hidden');
}

async function submitKyb(e) {
  e.preventDefault();
  const f = $('kyb-form');
  const err = $('kyb-error');
  err.classList.add('hidden');
  const slug = merchant.slug || $('b-slug').value.trim();
  if (!slug) {
    toast('Choose your exchange link first, then come back to verify');
    openSettings('store');
    setTimeout(() => $('b-slug').focus(), 150);
    return;
  }
  const body = Object.fromEntries(['business_name', 'business_type', 'registration_number', 'contact_name', 'phone', 'website', 'monthly_volume', 'description'].map(k => [k, f.elements[k].value.trim()]));
  body.slug = slug;
  body.agree_terms = $('f-terms').checked;
  const btn = $('kyb-save');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Submitting…';
  try {
    merchant = await api('/api/merchant/verification', { method: 'POST', body });
    toast('Submitted for verification');
    renderAll();
    openTab('overview');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Submitting…') btn.textContent = label;
  }
}

// ── Guided tour ──

// A live exchange has its link to share; any other has verification to finish.
const tourSteps = () => [
  merchant.status === 'APPROVED'
    ? ['ov-strip', 'Share your exchange', 'Copy your exchange link and send it to your customers. Every order lands in your dashboard.']
    : ['ov-strip', 'Verify your business', 'Submit your business details here. Your exchange goes live as soon as we approve them.'],
  ['tabbtn-settings', 'Make it yours', 'Pick your exchange name and address, upload your logo and choose your colours.'],
  ['tabbtn-prices', 'Set your prices', 'Add your markup on top of Velcro’s price, coin by coin. That margin is what you earn.'],
];
let TOUR = [];
let tourIndex = -1;

function startTour(force) {
  if (!force && tourIndex >= 0) return;
  $('avatar-menu').classList.add('hidden');
  openTab('overview');
  TOUR = tourSteps();
  tourIndex = 0;
  setTimeout(showTourStep, 250);
}

function showTourStep() {
  document.querySelectorAll('.d-tour-target').forEach(el => el.classList.remove('d-tour-target'));
  const [id, title, body] = TOUR[tourIndex];
  const target = $(id);
  const tip = $('tour');
  target.classList.add('d-tour-target');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('tour-title').textContent = title;
  $('tour-body').textContent = body;
  $('tour-step').textContent = `${tourIndex + 1} of ${TOUR.length}`;
  $('tour-back').classList.toggle('hidden', tourIndex === 0);
  $('tour-next').textContent = tourIndex === TOUR.length - 1 ? 'Done' : 'Next';
  tip.classList.remove('hidden');
  setTimeout(() => {
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = Math.max(16, Math.min(window.innerWidth - tw - 16, r.left + Math.min(r.width / 2, 120) - 40));
    const below = r.bottom + 14 + th < window.innerHeight;
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = (below ? r.bottom + 14 : r.top - th - 14) + window.scrollY + 'px';
  }, 380);
}

function tourGo(step) {
  tourIndex += step;
  if (tourIndex >= TOUR.length) return endTour();
  showTourStep();
}

function endTour() {
  tourIndex = -1;
  $('tour').classList.add('hidden');
  document.querySelectorAll('.d-tour-target').forEach(el => el.classList.remove('d-tour-target'));
  try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* ignore */ }
}

// ── Wire up ──

document.addEventListener('DOMContentLoaded', () => {
  initLanding();
  initGoogle();
  $('auth-form').addEventListener('submit', submitAuth);
  document.querySelectorAll('.d-tabs button').forEach(b => b.addEventListener('click', () => openTab(b.dataset.tab)));
  $('brand-form').addEventListener('submit', saveBrand);
  $('ord-q').addEventListener('input', renderOrders);
  $('wd-form').addEventListener('submit', submitWithdraw);
  $('wd-bank').addEventListener('change', checkWdAccount);
  $('wd-acct').addEventListener('input', checkWdAccount);
  document.querySelectorAll('[data-wd]').forEach(b => b.addEventListener('click', () => setWdCurrency(b.dataset.wd)));
  $('cus-q').addEventListener('input', renderCustomers);
  document.querySelectorAll('[data-of]').forEach(b => b.addEventListener('click', () => {
    orderFilter = b.dataset.of;
    document.querySelectorAll('[data-of]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderOrders();
  }));
  $('panel-security').addEventListener('submit', submitSecurity);
  $('panel-support').addEventListener('submit', submitSupport);
  $('kyb-form').addEventListener('submit', submitKyb);
  $('b-name').addEventListener('input', () => {
    if ($('b-name').readOnly) return;
    brandDraft.name = $('b-name').value;
    if (!merchant.slug && !$('b-slug').dataset.edited) { $('b-slug').value = slugify(brandDraft.name); checkSlug(); }
    paintBrand();
  });
  $('b-slug').addEventListener('input', () => {
    if ($('b-slug').readOnly) return;
    $('b-slug').dataset.edited = '1';
    checkSlug();
  });
  document.querySelectorAll('.d-swatch').forEach(s => s.addEventListener('click', () => { brandDraft.color = s.dataset.color; paintBrand(); }));
  $('b-color').addEventListener('input', () => { brandDraft.color = $('b-color').value.toLowerCase(); paintBrand(); });
  $('b-btn').addEventListener('input', () => { brandDraft.buttonText = $('b-btn').value.toLowerCase(); paintBrand(); });
  $('b-color-hex').addEventListener('input', () => { const v = '#' + $('b-color-hex').value.replace(/[^0-9a-f]/gi, ''); if (isHex(v)) { brandDraft.color = v.toLowerCase(); paintBrand(); } });
  $('b-btn-hex').addEventListener('input', () => { const v = '#' + $('b-btn-hex').value.replace(/[^0-9a-f]/gi, ''); if (isHex(v)) { brandDraft.buttonText = v.toLowerCase(); paintBrand(); } });
  ['b-color-hex', 'b-btn-hex'].forEach(id => $(id).addEventListener('blur', paintBrand));
  $('b-welcome').addEventListener('input', () => { brandDraft.welcome = $('b-welcome').value; paintBrand(); });
  document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => { brandDraft.layout = b.dataset.layout; paintBrand(); }));
  $('brand-cancel').addEventListener('click', () => { renderSettings(); openSettings(null); });
  $('b-logo').addEventListener('change', () => pickLogo($('b-logo').files[0]));
  $('b-logo-remove').addEventListener('click', () => { brandDraft.logoData = null; brandDraft.removeLogo = true; $('b-logo').value = ''; paintBrand(); });
  $('f-type').addEventListener('change', () => $('f-reg-row').classList.toggle('hidden', $('f-type').value !== 'registered'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAuth(); endTour(); } });
  document.addEventListener('click', e => { if (!e.target.closest('#avatar-btn') && !e.target.closest('#avatar-menu')) $('avatar-menu').classList.add('hidden'); });
  if (token) showApp();
});
