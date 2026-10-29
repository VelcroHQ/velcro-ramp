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
  const nav = $('l-nav');
  const onScroll = () => nav.classList.toggle('is-solid', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // "Claim your store address": checked live, then carried into sign-up and store set-up.
  const claim = $('claim-slug');
  const msg = $('claim-msg');
  const defaultMsg = msg.textContent;
  let timer = null;
  const check = async () => {
    const slug = claim.value;
    if (!slug) { msg.className = 'mt-2.5 text-sm text-[#7a7e96] min-h-[1.25rem]'; msg.textContent = defaultMsg; return null; }
    try {
      const r = await api('/api/merchant/slug-check?slug=' + encodeURIComponent(slug));
      if (r.slug !== claim.value) return null;
      msg.className = 'mt-2.5 text-sm min-h-[1.25rem] ' + (r.available ? 'is-ok' : 'is-bad');
      msg.textContent = r.available ? `ramp.usevelcro.com/m/${r.slug} is available.` : r.reason;
      return r.available;
    } catch (e) { return null; }
  };
  claim.addEventListener('input', () => {
    claim.value = claim.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    clearTimeout(timer);
    timer = setTimeout(check, 350);
  });
  $('claim-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (claim.value) {
      if ((await check()) === false) return claim.focus();
      try { localStorage.setItem(CLAIM_KEY, claim.value); } catch (err) { /* ignore */ }
    }
    openAuth('signup');
  });

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
  $('avatar-btn').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
  const view = $('hdr-view');
  view.classList.toggle('hidden', !merchant.storefront_url);
  if (merchant.storefront_url) view.href = merchant.storefront_url;
}

const BANNERS = {
  DRAFT: ['', 'Verify your business to put your store live.', 'It takes about three minutes. You can set up your store while we review it.', 'Start verification', () => goToKyb()],
  PENDING: ['is-pending', "We're reviewing your business.", "Usually within a working day. We'll email you as soon as you're approved.", 'View details', () => goToKyb()],
  REJECTED: ['is-bad', 'We need a few changes before your store can go live.', '', 'Fix details', () => goToKyb()],
  SUSPENDED: ['is-bad', 'Your store is suspended and offline.', '', 'Contact support', () => window.open('https://chat.whatsapp.com/FNiWMH0bnwgHT7lHhF32ab', '_blank')],
  APPROVED: ['is-live', 'Your business is verified.', '', 'Copy store link', () => shareStore()],
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
  const liveSub = merchant.status === 'APPROVED' ? (merchant.storefront_url ? 'Your store page is coming online soon. Your link is ready to share.' : 'Choose your store address to get your link.') : note;
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
  setTimeout(() => $('kyb-form').scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
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
  brandDraft = { name: merchant.brand.name || merchant.business_name || '', slug: merchant.slug || claimed, color: merchant.brand.color, logo: merchant.brand.logo, logoData: null, removeLogo: false };
  $('b-name').value = brandDraft.name;
  $('b-slug').value = brandDraft.slug;
  const locked = ['APPROVED', 'SUSPENDED'].includes(merchant.status) && !!merchant.slug;
  $('b-slug').readOnly = locked;
  $('b-slug-msg').className = 'm-hint';
  $('b-slug-msg').textContent = locked ? 'Your address is fixed now that you’re verified.' : "Lowercase letters, numbers and hyphens. It's fixed once you're verified.";
  $('brand-error').classList.add('hidden');
  paintBrand();
  renderKyb();
}

function paintBrand() {
  const brand = { name: brandDraft.name, color: brandDraft.color, logo: brandDraft.removeLogo ? null : (brandDraft.logoData || brandDraft.logo) };
  document.querySelectorAll('.d-swatch').forEach(s => s.classList.toggle('is-on', s.dataset.color === brandDraft.color));
  $('b-color').value = brandDraft.color;
  paintLogo($('b-logo-preview'), brand, 'Y');
  paintLogo($('bp-logo'), brand, 'Y');
  $('b-preview').style.setProperty('--brand', brandDraft.color);
  $('bp-name').textContent = brandDraft.name || 'Your store';
  $('bp-slug').textContent = brandDraft.slug || 'your-store';
  $('b-logo-remove').classList.toggle('hidden', !brand.logo);
  const usdtRate = merchant ? customerRate('USDT', 'buy', merchant.pricing.USDT.buy) : null;
  const usdt = usdtRate ? 100000 / usdtRate : null;
  $('bp-get').textContent = usdt ? `${usdt.toFixed(2)} USDT` : '… USDT';
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
    const body = { name: $('b-name').value.trim(), slug: $('b-slug').value.trim(), color: brandDraft.color };
    if (brandDraft.logoData) body.logo = brandDraft.logoData;
    if (brandDraft.removeLogo) body.remove_logo = true;
    merchant = await api('/api/merchant/brand', { method: 'POST', body });
    try { localStorage.removeItem(CLAIM_KEY); } catch (e2) { /* ignore */ }
    toast('Store saved');
    renderAll();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save store';
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
  $('kyb-form').addEventListener('submit', submitKyb);
  $('b-name').addEventListener('input', () => {
    brandDraft.name = $('b-name').value;
    if (!merchant.slug && !$('b-slug').dataset.edited) { $('b-slug').value = slugify(brandDraft.name); checkSlug(); }
    paintBrand();
  });
  $('b-slug').addEventListener('input', () => { $('b-slug').dataset.edited = '1'; checkSlug(); });
  document.querySelectorAll('.d-swatch').forEach(s => s.addEventListener('click', () => { brandDraft.color = s.dataset.color; paintBrand(); }));
  $('b-color').addEventListener('input', () => { brandDraft.color = $('b-color').value.toLowerCase(); paintBrand(); });
  $('b-logo').addEventListener('change', () => pickLogo($('b-logo').files[0]));
  $('b-logo-remove').addEventListener('click', () => { brandDraft.logoData = null; brandDraft.removeLogo = true; $('b-logo').value = ''; paintBrand(); });
  $('f-type').addEventListener('change', () => $('f-reg-row').classList.toggle('hidden', $('f-type').value !== 'registered'));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAuth(); endTour(); } });
  document.addEventListener('click', e => { if (!e.target.closest('#avatar-btn') && !e.target.closest('#avatar-menu')) $('avatar-menu').classList.add('hidden'); });
  if (token) showApp();
});
