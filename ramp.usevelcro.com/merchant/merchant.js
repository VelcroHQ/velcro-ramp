// Velcro Merchant: landing interactions, sign-in (password or Google), and the merchant dashboard
// (overview, prices, settings with branding + business verification, guided tour).
// Talks to /api/merchant/*; the signed-in token lives in localStorage.

const TOKEN_KEY = 'velcro_merchant_token';
const TOUR_KEY = 'velcro_merchant_tour_done';
const CLAIM_KEY = 'velcro_merchant_claim'; // store address picked on the landing page, used at set-up
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

  const name = $('pv-name');
  const renderPreview = () => {
    const title = name.value.trim() || 'Your store';
    $('pv-title').textContent = title;
    $('pv-logo').textContent = title.charAt(0).toUpperCase();
    $('pv-slug').textContent = slugify(title) || 'your-store';
  };
  name.addEventListener('input', renderPreview);
  document.querySelectorAll('.m-swatch').forEach(sw => sw.addEventListener('click', () => {
    document.querySelectorAll('.m-swatch').forEach(x => x.classList.toggle('is-on', x === sw));
    $('pv-store').style.setProperty('--brand', sw.dataset.color);
  }));

  const vol = $('calc-vol');
  const mk = $('calc-mk');
  const renderCalc = () => {
    $('calc-vol-out').textContent = naira(vol.value);
    $('calc-mk-out').textContent = Number(mk.value).toFixed(1) + '%';
    $('calc-out').textContent = naira(vol.value * mk.value / 100);
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
    ? 'New to Velcro Merchant? <button type="button" class="font-bold text-velcro-navy" onclick="setAuthMode(\'signup\')">Create an account</button>'
    : 'Already have an account? <button type="button" class="font-bold text-velcro-navy" onclick="setAuthMode(\'signin\')">Sign in</button>';
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
    google.accounts.id.renderButton($('google-btn'), { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 340 });
    googleReady = true;
    if ($('auth').classList.contains('is-open')) setAuthMode(authMode);
  };
  document.head.appendChild(s);
}

function signOut() {
  setToken('');
  me = merchant = null;
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

function renderAll() {
  renderHeader();
  renderOverview();
  renderPrices();
  renderSettings();
}

function openTab(name) {
  if (!$('tab-' + name)) name = 'overview';
  if (name === 'settings') openSettings(null);
  document.querySelectorAll('.d-tab').forEach(t => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  document.querySelectorAll('.d-tabs button').forEach(b => b.classList.toggle('is-on', b.dataset.tab === name));
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function storeName() {
  return merchant.brand.name || merchant.business_name || 'Your store';
}

function renderHeader() {
  paintLogo($('hdr-logo'), merchant.brand, storeName());
  $('hdr-name').textContent = storeName();
  $('hdr-email').textContent = me.email;
  $('menu-name').textContent = me.name || storeName();
  $('avatar-initial').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
  const [cls, words] = HDR_STATUS[merchant.status] || HDR_STATUS.DRAFT;
  $('hdr-status').className = 'd-hdr-status is-' + cls;
  $('hdr-status').textContent = words;
  const url = merchant.storefront_url;
  $('hdr-link-text').textContent = url ? url.replace(/^https?:\/\//, '') : 'Pick your store link';
  $('hdr-link').onclick = () => (url ? shareStore() : (openTab('settings'), openSettings('store')));
  const view = $('hdr-view');
  view.classList.toggle('hidden', !url);
  if (url) view.href = url;
}

const HDR_STATUS = { DRAFT: ['draft', 'Not live'], PENDING: ['pending', 'In review'], REJECTED: ['bad', 'Needs changes'], APPROVED: ['live', 'Live'], SUSPENDED: ['bad', 'Suspended'] };

const BANNERS = {
  DRAFT: ['', 'Verify your business to put your store live.', 'It takes about three minutes. You can set up your store while we review it.', 'Start verification', () => goToKyb()],
  PENDING: ['is-pending', "We're reviewing your business.", "Usually within a working day. We'll email you as soon as you're approved.", 'View details', () => goToKyb()],
  REJECTED: ['is-bad', 'We need a few changes before your store can go live.', '', 'Fix details', () => goToKyb()],
  SUSPENDED: ['is-bad', 'Your store is suspended and offline.', '', 'Contact support', () => window.open('https://chat.whatsapp.com/FNiWMH0bnwgHT7lHhF32ab', '_blank')],
  APPROVED: ['is-live', 'Your store is live.', '', 'Copy store link', () => shareStore()],
};

function renderOverview() {
  const now = new Date();
  $('ov-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const who = (me.name || '').split(' ')[0] || merchant.brand.name || me.email.split('@')[0];
  $('ov-hello').textContent = `${part}, ${who}`;

  const [cls, title, sub, btn, action] = BANNERS[merchant.status] || BANNERS.DRAFT;
  const note = merchant.review_note ? `Reason: ${merchant.review_note}` : sub;
  const liveSub = merchant.status === 'APPROVED' ? (merchant.storefront_url ? 'Your store is live at ' + merchant.storefront_url.replace(/^https?:\/\//, '') + '. Share the link with your customers.' : 'Choose your store address to get your link.') : note;
  const banner = $('ov-banner');
  banner.className = 'd-banner mt-6 ' + cls;
  banner.innerHTML = `<div><b>${esc(title)}</b><small>${esc(liveSub)}</small></div><button type="button" class="d-banner-btn">${esc(btn)} →</button>`;
  banner.querySelector('button').onclick = action;

  // Launch checklist.
  const ck = merchant.checklist;
  const steps = [
    ['branded', 'Personalize your store', 'Name, address and look', () => openTab('settings')],
    ['priced', 'Set your prices', 'Your markup per coin', () => openTab('prices')],
    ['verified', 'Verify your business', merchant.status === 'PENDING' ? 'Under review' : 'Goes live after approval', () => goToKyb()],
  ];
  const done = steps.filter(s => ck[s[0]]).length;
  $('ck-count').textContent = `${done}/${steps.length}`;
  requestAnimationFrame(() => { $('ck-bar').style.width = `${(done / steps.length) * 100}%`; });
  const list = $('ck-list');
  list.innerHTML = steps.map(([key, label, hint], i) => `<li><button type="button" class="d-check ${ck[key] ? 'is-done' : ''}" data-i="${i}"><i>✓</i><span>${esc(label)}</span><em>${ck[key] ? 'Done' : esc(hint)}</em></button></li>`).join('');
  list.querySelectorAll('button').forEach(b => { b.onclick = steps[b.dataset.i][3]; });
  $('qa-brand').classList.toggle('is-done', !!ck.branded);
  $('qa-prices').classList.toggle('is-done', !!ck.priced);
  $('qa-share-sub').textContent = merchant.slug ? `…/m/${merchant.slug}` : 'Pick your store address first.';

  // Price list, as customers see it.
  $('ov-price-rows').innerHTML = Object.entries(me.coins).map(([sym, name]) => {
    const p = merchant.pricing[sym];
    const on = p.buy_on || p.sell_on;
    const cell = side => {
      if (!p[side + '_on']) return '<span class="d-pill off">Off</span>';
      const rate = customerRate(sym, side, p[side]);
      return rate ? `<span class="d-price"><b>${rateText(rate)}</b><small>${side === 'buy' ? '+' : '−'}${p[side]}% on Velcro</small></span>` : '<span class="text-slate-400">—</span>';
    };
    return `<tr><td><span class="d-coin"><img src="${COIN_LOGOS[sym]}" alt=""><span>${sym}<small>${esc(name)}</small></span></span></td>
      <td>${cell('buy')}</td><td>${cell('sell')}</td>
      <td><span class="d-pill ${on && merchant.status === 'APPROVED' ? 'live' : 'off'}">${on ? (merchant.status === 'APPROVED' ? 'Live' : 'Ready') : 'Off'}</span></td></tr>`;
  }).join('');
}

function goToKyb() {
  openTab('settings');
  openSettings('kyb');
}

// Settings: a home of cards, each opening one panel.
const SETTINGS_PANELS = { store: 'panel-store', kyb: 'kyb-form', security: 'panel-security', support: 'panel-support' };

function openSettings(panel) {
  $('set-home').classList.toggle('hidden', !!panel);
  $('set-panel').classList.toggle('hidden', !panel);
  Object.entries(SETTINGS_PANELS).forEach(([key, id]) => $(id).classList.toggle('hidden', key !== panel));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const STATUS_WORDS = { DRAFT: ['pending', 'Not verified yet'], PENDING: ['pending', 'Verification under review'], REJECTED: ['rejected', 'Changes needed'], APPROVED: ['approved', 'Verified'], SUSPENDED: ['suspended', 'Suspended'] };

function renderSettingsHome() {
  paintLogo($('set-logo'), merchant.brand, storeName());
  $('set-name').textContent = storeName();
  $('set-email').textContent = me.email;
  const [cls, words] = STATUS_WORDS[merchant.status] || STATUS_WORDS.DRAFT;
  $('set-badge').className = 'm-status-badge ' + cls;
  $('set-badge').textContent = words;
  const live = merchant.status === 'APPROVED' && merchant.storefront_url;
  $('set-cta').textContent = live ? 'View store' : merchant.status === 'PENDING' ? 'View details' : 'Complete verification';
  $('set-cta').onclick = () => (live ? window.open(merchant.storefront_url, '_blank') : openSettings('kyb'));
  $('set-kyb-sub').textContent = {
    DRAFT: 'Verify your business to put your store live.',
    PENDING: "We're reviewing your details. Usually within a working day.",
    REJECTED: 'We need a few changes. Open to see what.',
    APPROVED: 'Your business is verified.',
    SUSPENDED: 'Your store is suspended.',
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
    toast('Choose your store address first');
    openTab('settings');
    setTimeout(() => $('b-slug').focus(), 150);
    return;
  }
  try {
    await navigator.clipboard.writeText(merchant.storefront_url);
    toast(merchant.status === 'APPROVED' ? 'Store link copied' : 'Link copied. It goes live once you’re verified');
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

const rateText = v => '$1 = ₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderPrices() {
  pricingDraft = JSON.parse(JSON.stringify(merchant.pricing));
  pricingDraft._display = merchant.rate_display || 'final';
  document.querySelectorAll('input[name="rate-display"]').forEach(r => {
    r.checked = r.value === pricingDraft._display;
    r.onchange = () => { pricingDraft._display = r.value; paintPriceRows(true); };
  });
  $('max-markup').textContent = me.max_markup;
  $('price-rows').innerHTML = Object.entries(me.coins).map(([sym, name]) => {
    const toggle = side => `<button type="button" class="d-toggle" role="switch" aria-label="${sym} ${side} on/off" data-sym="${sym}" data-side="${side}"></button>`;
    const markup = side => `<label class="d-markup"><input type="number" inputmode="decimal" min="0" max="${me.max_markup}" step="0.05" data-sym="${sym}" data-side="${side}" aria-label="${sym} ${side} markup %"><span>%</span></label>`;
    return `<tr data-row="${sym}"><td><span class="d-coin"><img src="${COIN_LOGOS[sym]}" alt=""><span>${sym}<small>${esc(name)}</small></span></span></td>
      <td><span class="d-cell">${toggle('buy')}${markup('buy')}</span></td><td class="d-price" data-out="${sym}-buy"></td>
      <td><span class="d-cell">${toggle('sell')}${markup('sell')}</span></td><td class="d-price" data-out="${sym}-sell"></td></tr>`;
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
      out.closest('td').classList.toggle('is-off', !on);
      out.innerHTML = !on ? '<span class="d-pill off">Hidden</span>'
        : rate ? `<b>${rateText(rate)}</b><small>Velcro ${rateText(base)}</small>` : '<span class="text-slate-400">Rate unavailable</span>';
    });
  });
  // Example for the display choice, from the first coin with a buy rate.
  const ex = Object.keys(me.coins).find(sym => customerRate(sym, 'buy', pricingDraft[sym].buy));
  if (ex) {
    $('disp-final').textContent = rateText(customerRate(ex, 'buy', pricingDraft[ex].buy)) + ` · ${ex}`;
    $('disp-breakdown').textContent = `${rateText(velcroRates[ex].buy)} + ${pricingDraft[ex].buy}% fee · ${ex}`;
  }
  $('prices-save').disabled = !dirty;
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
  let claimed = '';
  try { claimed = merchant.slug ? '' : (localStorage.getItem(CLAIM_KEY) || ''); } catch (e) { /* ignore */ }
  brandDraft = {
    name: merchant.brand.name || merchant.business_name || '',
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
  $('b-slug').readOnly = locked;
  $('b-slug-msg').className = 'm-hint';
  $('b-slug-msg').textContent = locked ? 'Your address is fixed now that you’re verified.' : "Lowercase letters, numbers and hyphens. It's fixed once you're verified.";
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
  const coins = Object.keys((me && me.coins) || {}).filter(sym => merchant.pricing[sym] && (merchant.pricing[sym].buy_on || merchant.pricing[sym].sell_on));
  const rate = (sym, side) => {
    const p = merchant.pricing[sym];
    const r = p[side + '_on'] ? customerRate(sym, side, p[side]) : null;
    return r ? '₦' + Number(r).toLocaleString('en-NG', { maximumFractionDigits: 0 }) : '—';
  };
  // Rates are naira per $1, so a stablecoin shows the amount exactly; anything else shows its dollar value.
  const first = ['USDT', 'USDC'].find(sym => coins.includes(sym) && merchant.pricing[sym].buy_on) || coins.find(sym => merchant.pricing[sym].buy_on) || 'USDT';
  const firstRate = merchant.pricing[first] ? customerRate(first, 'buy', merchant.pricing[first].buy) : null;
  const usd = firstRate ? 100000 / firstRate : null;
  const stable = first === 'USDT' || first === 'USDC';
  const name = d.name.trim() || 'Your store';
  screen.innerHTML = `
    <div class="pv-status"><b>9:41</b><span><i></i><i></i><i></i></span></div>
    <div class="pv-top"><span class="pv-logo" id="pv-logo"></span><b>${esc(name)}</b><span class="pv-signin">Sign in</span></div>
    <div class="pv-hero">
      <h3>${esc(name)}</h3>
      <p>${esc(d.welcome.trim() || 'Buy and sell crypto with naira. Pay by bank transfer, get paid to any Nigerian bank.')}</p>
    </div>
    <div class="pv-card">
      <div class="pv-tabs"><span class="is-on">Buy</span><span>Sell</span></div>
      <div class="pv-field"><small>You pay</small><b>₦100,000</b><em>NGN</em></div>
      <div class="pv-field"><small>${stable ? 'You get' : 'You get (in dollars)'}</small><b>${usd ? (stable ? '' : '$') + usd.toFixed(2) : '…'}</b><em>${first}</em></div>
      <span class="pv-cta">Buy ${first}</span>
    </div>
    <div class="pv-rates">
      <div class="pv-rates-head"><b>Today's rates</b><span>We sell · We buy</span></div>
      ${coins.length ? coins.map(sym => `<div class="pv-rate"><img src="${COIN_LOGOS[sym]}" alt=""><b>${sym}</b><span>${rate(sym, 'buy')}</span><span>${rate(sym, 'sell')}</span></div>`).join('') : '<p class="pv-empty">Switch on coins in Listed offers to show rates.</p>'}
    </div>
    <p class="pv-foot">${esc(name)} · Powered by Velcro</p>`;
  paintLogo($('pv-logo'), brand, 'Y');
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
    try { localStorage.removeItem(CLAIM_KEY); } catch (e2) { /* ignore */ }
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

const KYB_BADGES = { DRAFT: ['pending', 'Not started'], PENDING: ['pending', 'Under review'], REJECTED: ['rejected', 'Changes needed'], APPROVED: ['approved', 'Verified'], SUSPENDED: ['suspended', 'Suspended'] };

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
  $('kyb-badge').className = 'm-status-badge ' + cls;
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
    err.textContent = 'Choose your store address in "Your store" above first.';
    err.classList.remove('hidden');
    $('b-slug').focus();
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

const TOUR = [
  ['ov-banner', 'Verify your business', 'Submit your business details here. Your store goes live as soon as we approve them.'],
  ['qa-brand', 'Make it yours', 'Pick your store name and address, upload your logo and choose your colours.'],
  ['qa-prices', 'Set your prices', 'Add your markup on top of Velcro’s price, coin by coin. That margin is what you earn.'],
  ['qa-share', 'Share your store', 'Copy your store link and send it to your customers. Every order lands in your dashboard.'],
];
let tourIndex = -1;

function startTour(force) {
  if (!force && tourIndex >= 0) return;
  $('avatar-menu').classList.add('hidden');
  openTab('overview');
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
    tip.classList.toggle('is-above', !below);
    tip.style.left = left + window.scrollX + 'px';
    tip.style.top = (below ? r.bottom + 14 : r.top - th - 14) + window.scrollY + 'px';
    tip.style.setProperty('--arrow', Math.max(16, Math.min(tw - 30, r.left + Math.min(r.width / 2, 120) - left - 7)) + 'px');
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
  $('panel-security').addEventListener('submit', submitSecurity);
  $('panel-support').addEventListener('submit', submitSupport);
  $('kyb-form').addEventListener('submit', submitKyb);
  $('b-name').addEventListener('input', () => {
    brandDraft.name = $('b-name').value;
    if (!merchant.slug && !$('b-slug').dataset.edited) { $('b-slug').value = slugify(brandDraft.name); checkSlug(); }
    paintBrand();
  });
  $('b-slug').addEventListener('input', () => { $('b-slug').dataset.edited = '1'; checkSlug(); });
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
