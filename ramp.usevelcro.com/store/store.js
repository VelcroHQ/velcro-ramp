// Merchant store page (/m/{slug}): the store's branding, live rates with the merchant's markup,
// and customer sign-in (per store: password or Google). Talks to /api/merchant/storefront/{slug}
// and /api/store/{slug}/*.

const SLUG = (location.pathname.match(/^\/m\/([a-z0-9-]{3,30})\/?$/) || [])[1] || '';
const TOKEN_KEY = 'velcro_store_' + SLUG;
const MERCHANT_TOKEN_KEY = 'velcro_merchant_token'; // lets a merchant preview their own store before approval
const COIN_LOGOS = { BTC: '/logos/bitcoin.png', ETH: '/logos/ethereum.png', SOL: '/logos/solana.png', USDT: '/logos/usdt.png', USDC: '/logos/usdc.png' };

const $ = id => document.getElementById(id);
const store = { info: null, coins: {}, side: 'buy', coin: null };
let token = '';
let me = null;
let authMode = 'signin';
let googleReady = false;
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* private mode */ }

const fmtNgn = v => '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCoin = (v, sym) => Number(v).toLocaleString('en-US', ['USDT', 'USDC'].includes(sym) ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 8 });

function toast(msg) {
  const t = $('s-toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('is-on'), 3200);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Store-Token'] = token;
  try {
    const mt = localStorage.getItem(MERCHANT_TOKEN_KEY);
    if (mt) headers['X-Merchant-Token'] = mt;
  } catch (e) { /* ignore */ }
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.error || 'Something went wrong. Try again.');
    err.status = res.status;
    throw err;
  }
  return json.data ?? json;
}

function setToken(t) {
  token = t || '';
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
}

// Readable text on the brand colour: white on dark colours, near-black on light ones.
function onBrand(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#14142b' : '#ffffff';
}

function paintLogo(el) {
  const s = store.info;
  if (s.logo) {
    el.style.backgroundImage = `url("${s.logo}")`;
    el.classList.add('has-img');
    el.textContent = '';
  } else {
    el.textContent = s.name.trim().charAt(0).toUpperCase();
  }
}

// ── Store ──

async function loadStore() {
  if (!SLUG) return showMissing();
  try {
    const data = await api('/api/merchant/storefront/' + SLUG);
    store.info = data.store;
    store.coins = data.coins || {};
    store.googleClientId = data.google_client_id;
  } catch (e) {
    return showMissing();
  }
  const s = store.info;
  document.title = `${s.name} · Buy & sell crypto with naira`;
  document.documentElement.style.setProperty('--brand', s.color);
  document.documentElement.style.setProperty('--on-brand', onBrand(s.color));
  $('s-name').textContent = s.name;
  $('s-foot-name').textContent = s.name;
  $('s-home').href = '/m/' + SLUG;
  paintLogo($('s-logo'));
  paintLogo($('auth-logo'));
  $('s-preview').hidden = !s.is_owner_preview;
  $('s-loading').hidden = true;
  $('s-app').hidden = false;
  const first = Object.values(store.coins).find(c => c.buy_on) || Object.values(store.coins)[0];
  if (!first) {
    $('s-note').textContent = 'This store isn’t quoting any coins right now.';
    $('s-go').disabled = true;
    return;
  }
  store.side = first.buy_on ? 'buy' : 'sell';
  store.coin = first.symbol;
  setSide(store.side);
  initGoogle();
  if (token) loadMe();
}

function showMissing() {
  $('s-loading').hidden = true;
  $('s-missing').hidden = false;
}

function setSide(side) {
  store.side = side;
  $('t-buy').setAttribute('aria-selected', String(side === 'buy'));
  $('t-sell').setAttribute('aria-selected', String(side === 'sell'));
  const available = Object.values(store.coins).filter(c => c[side + '_on']);
  if (!available.some(c => c.symbol === store.coin)) store.coin = available[0] ? available[0].symbol : null;
  $('s-coins').innerHTML = available.map(c => `<button type="button" class="s-coin" role="radio" aria-checked="${c.symbol === store.coin}" data-sym="${c.symbol}"><img src="${COIN_LOGOS[c.symbol]}" alt="">${c.symbol}</button>`).join('')
    || `<p class="s-note">No coins to ${side} right now.</p>`;
  document.querySelectorAll('.s-coin').forEach(b => b.addEventListener('click', () => { store.coin = b.dataset.sym; setSide(store.side); }));
  $('f-in').value = '';
  render();
}

function render() {
  const c = store.coins[store.coin];
  const buying = store.side === 'buy';
  $('f-in-label').textContent = buying ? 'You pay' : 'You send';
  $('f-out-label').textContent = buying ? 'You get' : 'You receive';
  $('f-in-cur').textContent = buying ? 'NGN' : (c ? c.symbol : '');
  $('f-out-cur').textContent = buying ? (c ? c.symbol : '') : 'NGN';
  $('s-go').textContent = c ? `${buying ? 'Buy' : 'Sell'} ${c.symbol}` : 'Continue';
  $('s-note').textContent = '';
  if (!c) return;
  const rate = buying ? c.buy_rate : c.sell_rate;
  if (!rate || !c.usd_price) {
    $('s-rate').textContent = 'Rate unavailable right now. Try again in a minute.';
    $('f-out').textContent = '0';
    $('s-go').disabled = true;
    return;
  }
  $('s-go').disabled = false;
  // The merchant chooses: one final rate, or Velcro's rate plus their markup.
  const base = buying ? c.velcro_buy_rate : c.velcro_sell_rate;
  const pct = buying ? c.buy_markup_percent : c.sell_markup_percent;
  $('s-rate').innerHTML = store.info.rate_display === 'breakdown' && base
    ? `Rate: <b>$1 = ${fmtNgn(base)}</b> + ${pct}% fee`
    : `Rate: <b>$1 = ${fmtNgn(rate)}</b>`;
  const amount = Number(String($('f-in').value).replace(/,/g, '')) || 0;
  if (buying) {
    // naira → $ at the store's rate → coin at its $ price
    $('f-out').textContent = amount > 0 ? fmtCoin(amount / rate / c.usd_price, c.symbol) : '0';
  } else {
    $('f-out').textContent = amount > 0 ? fmtNgn(amount * c.usd_price * rate).replace('₦', '') : '0';
  }
}

function goTrade() {
  const amount = Number(String($('f-in').value).replace(/,/g, '')) || 0;
  if (!(amount > 0)) {
    $('s-note').textContent = store.side === 'buy' ? 'Enter how much naira you want to spend.' : 'Enter how much you want to sell.';
    $('f-in').focus();
    return;
  }
  if (!me) {
    openAuth('signin');
    return;
  }
  // Checkout on merchant stores is switched on next; until then nothing is charged.
  toast(`Trading on ${store.info.name} opens very soon. We’ll email you at ${me.email}.`);
}

// ── Customer account ──

async function loadMe() {
  try {
    const data = await api(`/api/store/${SLUG}/me`);
    me = data.customer;
  } catch (e) {
    if (e.status === 401) setToken('');
    me = null;
  }
  paintAccount();
}

function paintAccount() {
  $('s-signin').hidden = !!me;
  $('s-me').hidden = !me;
  if (me) {
    $('s-avatar').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
    $('s-me-email').textContent = me.email;
  }
}

function toggleMenu() {
  const m = $('s-menu');
  m.hidden = !m.hidden;
  $('s-avatar').setAttribute('aria-expanded', String(!m.hidden));
}

function signOut() {
  setToken('');
  me = null;
  $('s-menu').hidden = true;
  paintAccount();
  toast('Signed out');
}

const AUTH_COPY = {
  signin: () => ['Sign in', `Sign in to ${store.info.name} to buy and sell.`, 'Sign in'],
  signup: () => ['Create your account', `Join ${store.info.name}. We'll email you a code to confirm it's you.`, 'Continue'],
  'signup-code': () => ['Check your email', `We sent a 6-digit code to ${$('a-email').value.trim()}.`, 'Create account'],
  reset: () => ['Reset your password', "Enter your email and we'll send you a code.", 'Send code'],
  'reset-code': () => ['Set a new password', `We sent a 6-digit code to ${$('a-email').value.trim()}.`, 'Update password'],
};

function openAuth(mode) {
  setAuthMode(mode);
  $('auth').hidden = false;
  setTimeout(() => $('a-email').focus(), 50);
}

function closeAuth() { $('auth').hidden = true; }

function setAuthMode(mode) {
  authMode = mode;
  const [title, sub, btn] = AUTH_COPY[mode]();
  $('auth-title').textContent = title;
  $('auth-sub').textContent = sub;
  $('auth-btn').textContent = btn;
  $('auth-error').hidden = true;
  const codeStep = mode.endsWith('-code');
  $('a-code-row').hidden = !codeStep;
  $('a-pass-row').hidden = mode === 'signup' || mode === 'reset';
  $('a-forgot').hidden = mode !== 'signin';
  $('a-pass-hint').hidden = !codeStep;
  $('a-pass-label').textContent = codeStep ? 'Choose a password' : 'Password';
  $('a-pass').autocomplete = codeStep ? 'new-password' : 'current-password';
  $('a-email').readOnly = codeStep;
  $('google-wrap').hidden = !googleReady || codeStep || mode === 'reset';
  $('auth-switch').innerHTML = mode === 'signin'
    ? 'New here? <button type="button" onclick="setAuthMode(\'signup\')">Create an account</button>'
    : 'Already have an account? <button type="button" onclick="setAuthMode(\'signin\')">Sign in</button>';
  if (codeStep) setTimeout(() => $('a-code').focus(), 50);
}

async function submitAuth(e) {
  e.preventDefault();
  const email = $('a-email').value.trim();
  const password = $('a-pass').value;
  const otp = $('a-code').value.trim();
  const btn = $('auth-btn');
  $('auth-error').hidden = true;
  if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  const base = `/api/store/${SLUG}/auth`;
  try {
    if (authMode === 'signin') signedIn(await api(base + '/login', { method: 'POST', body: { email, password } }));
    else if (authMode === 'signup') { await api(base + '/signup/code', { method: 'POST', body: { email } }); setAuthMode('signup-code'); }
    else if (authMode === 'signup-code') signedIn(await api(base + '/signup', { method: 'POST', body: { email, otp, password } }));
    else if (authMode === 'reset') { await api(base + '/reset/code', { method: 'POST', body: { email } }); setAuthMode('reset-code'); }
    else if (authMode === 'reset-code') signedIn(await api(base + '/reset', { method: 'POST', body: { email, otp, password } }));
  } catch (err) {
    authError(err.message);
  } finally {
    btn.disabled = false;
    if (btn.textContent === 'Please wait…') btn.textContent = label;
  }
}

function authError(msg) {
  $('auth-error').textContent = msg;
  $('auth-error').hidden = false;
}

function signedIn(data) {
  setToken(data.token);
  me = { email: data.email, name: data.name };
  closeAuth();
  $('a-pass').value = '';
  $('a-code').value = '';
  paintAccount();
  toast(`Signed in to ${store.info.name}`);
}

function initGoogle() {
  if (!store.googleClientId) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: store.googleClientId,
      callback: async resp => {
        try {
          signedIn(await api(`/api/store/${SLUG}/auth/google`, { method: 'POST', body: { credential: resp.credential } }));
        } catch (err) { authError(err.message); }
      },
    });
    google.accounts.id.renderButton($('google-btn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 320 });
    googleReady = true;
    if (!$('auth').hidden) setAuthMode(authMode);
  };
  document.head.appendChild(s);
}

document.addEventListener('DOMContentLoaded', () => {
  $('f-in').addEventListener('input', render);
  $('auth-form').addEventListener('submit', submitAuth);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });
  document.addEventListener('click', e => { if (!e.target.closest('#s-me')) { const m = $('s-menu'); if (m) m.hidden = true; } });
  loadStore();
});
