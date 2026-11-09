// Merchant store page (/m/{slug}): the store's branding, live rates with the merchant's markup,
// checkout, and customer sign-in (per store: password or Google). Talks to
// /api/merchant/storefront/{slug} and /api/store/{slug}/*.

function detectSlug() {
  const host = (location.hostname || '').toLowerCase();
  const hostMatch = host.match(/^([a-z0-9-]{3,30})\.usevelcro\.com$/);
  if (hostMatch && !['www', 'ramp', 'goat', 'merchant', 'api', 'admin', 'mail'].includes(hostMatch[1])) {
    return hostMatch[1];
  }
  const pathMatch = location.pathname.match(/^\/m\/([a-z0-9-]{3,30})\/?$/i);
  if (pathMatch) return pathMatch[1].toLowerCase();
  const urlParam = new URLSearchParams(location.search).get('store');
  if (urlParam && /^[a-z0-9-]{3,30}$/i.test(urlParam)) return urlParam.toLowerCase();
  return '';
}
const SLUG = detectSlug();
const TOKEN_KEY = 'velcro_store_' + SLUG;
const MERCHANT_TOKEN_KEY = 'velcro_merchant_token'; // lets a merchant preview their own store before approval
const COIN_LOGOS = { BTC: '/logos/bitcoin.png', ETH: '/logos/ethereum.png', SOL: '/logos/solana.png', USDT: '/logos/usdt.png', USDC: '/logos/usdc.png' };
const BUY_CHIPS = [10000, 50000, 100000, 500000];
const RATE_REFRESH_MS = 60000;
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const ICON_WHATSAPP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12Z"/></svg>';

const $ = id => document.getElementById(id);
const store = { info: null, coins: {}, side: 'buy', coin: null };
let token = '';
let me = null;
let authMode = 'signin';
let googleReady = false;
let pendingTrade = false; // they tapped Buy/Sell before signing in; carry on once they have
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* private mode */ }

const fmtNgn = v => '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCoin = (v, sym) => Number(v).toLocaleString('en-US', ['USDT', 'USDC'].includes(sym) ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 8 });
const fmtDate = v => {
  const s = String(v || '');
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const shortRef = r => { const s = String(r || ''); return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s; };
const tradeTime = (sym, buying) => (sym === 'BTC' ? (buying ? '10–60 minutes' : '20–60 minutes') : 'A few minutes');

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
  let data;
  try {
    // Started in the page's <head>, so it is usually back by the time this script runs.
    data = await (window.storefrontRequest || api('/api/merchant/storefront/' + SLUG));
    store.info = data.store;
    store.coins = data.coins || {};
    store.googleClientId = data.google_client_id;

    // If accessed via dedicated subdomain but domain is not active, redirect to standard /m/ path
    const host = (location.hostname || '').toLowerCase();
    if (host.endsWith('.usevelcro.com') && !host.startsWith('ramp.') && data.store && data.store.dedicated_domain === false) {
      location.replace('https://ramp.usevelcro.com/m/' + SLUG + location.search);
      return;
    }
  } catch (e) {
    return showMissing();
  }
  const s = store.info;
  document.title = `${s.name} · Buy & sell crypto with naira`;
  document.documentElement.style.setProperty('--brand', s.color);
  document.documentElement.style.setProperty('--on-brand', s.button_text || onBrand(s.color));
  document.documentElement.style.setProperty('--on-brand-auto', onBrand(s.color));
  document.body.classList.add('s-layout-' + (s.layout || 'classic'));
  $('s-name').textContent = s.name;
  $('s-title').textContent = s.name;
  if (s.welcome) {
    $('s-lede').textContent = s.welcome;
    $('s-lede').classList.add('has-welcome');
  }
  document.querySelector('.s-ngn-store').textContent = s.name;
  $('s-foot-name').textContent = s.name;
  $('s-home').href = location.pathname.startsWith('/m/') ? '/m/' + SLUG : '/';
  paintLogo($('s-logo'));
  paintLogo($('auth-logo'));
  if (s.support_url) {
    const isWa = /wa\.me|whatsapp/i.test(s.support_url);
    const supp = $('s-support');
    supp.href = s.support_url;
    supp.innerHTML = `${isWa ? ICON_WHATSAPP : ICON_CHAT}<span>${isWa ? `Chat with ${esc(s.name)} on WhatsApp` : `Need help? Chat with ${esc(s.name)}`}</span>`;
    supp.classList.toggle('is-wa', Boolean(isWa));
    supp.hidden = false;

    const footSupp = $('s-foot-support');
    if (footSupp) {
      footSupp.href = s.support_url;
      footSupp.textContent = isWa ? 'WhatsApp Support' : 'Support';
      footSupp.hidden = false;
    }
  }
  $('s-preview').hidden = !s.is_owner_preview;
  $('s-loading').hidden = true;
  $('s-app').hidden = false;
  setupPwa(s);
  setupNetworkStatus();
  // Older visits may have kept orders and an email in this browser; the account is the only record now.
  try { localStorage.removeItem('velcro_recent_orders_' + SLUG); localStorage.removeItem('velcro_email'); } catch (e) { /* ignore */ }
  const coins = Object.values(store.coins);
  const first = preferredCoin(coins.filter(c => c.buy_on), 'buy') || preferredCoin(coins, 'buy') || coins[0];
  initGoogle();
  if (token) loadMe();
  if (!first) {
    paintBoard();
    $('s-note').textContent = 'This exchange isn’t quoting any coins right now.';
    $('s-go').disabled = true;
    return;
  }
  store.side = first.buy_on ? 'buy' : 'sell';
  store.coin = first.symbol;
  setSide(store.side);
  // Keep the prices live while the page is open; sooner if these came from an older copy.
  if (Number(data.rates_age) >= 60) setTimeout(refreshRates, 6000);
  setInterval(refreshRates, RATE_REFRESH_MS);
}

async function refreshRates() {
  if (document.hidden || !$('s-coin-list').hidden) return;
  try {
    const data = await api('/api/merchant/storefront/' + SLUG);
    store.coins = data.coins || store.coins;
    paintBoard();
    paintCoin();
    render();
  } catch (e) { /* keep showing the last rates */ }
}

function showMissing() {
  $('s-loading').hidden = true;
  $('s-missing').hidden = false;
}

// Today's rates for the side the customer is on, per $1. Tapping one picks that coin.
function paintBoard() {
  const side = store.side || 'buy';
  $('s-rates-side').textContent = side === 'buy' ? 'to buy, per $1' : 'to sell, per $1';
  $('s-board-rows').innerHTML = Object.values(store.coins).filter(c => c[side + '_on'] && c[side + '_rate']).map(c =>
    `<button type="button" class="s-rate" data-sym="${c.symbol}" aria-label="${side === 'buy' ? 'Buy' : 'Sell'} ${esc(c.symbol)} at ${fmtNgn(c[side + '_rate'])} per dollar"><span><img src="${COIN_LOGOS[c.symbol]}" alt="">${esc(c.symbol)}</span><b>${fmtNgn(c[side + '_rate'])}</b></button>`
  ).join('') || '<p class="s-rates-empty">No rates right now.</p>';
  document.querySelectorAll('#s-board-rows .s-rate').forEach(b => b.addEventListener('click', () => pickFromBoard(b.dataset.sym, side)));
  markBoard();
}

// A price on the board opens that coin and side in the trade card.
function pickFromBoard(sym, side) {
  if (checkout) showForm();
  if (store.side !== side) setSide(side);
  store.coin = sym;
  paintCoin();
  render();
  if (window.innerWidth < 960) document.querySelector('.s-trade').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!isAnyAmountCoin(sym, side) && window.innerWidth >= 960) {
    setTimeout(() => $('f-in').focus({ preventScroll: true }), 300);
  }
}

function markBoard() {
  document.querySelectorAll('#s-board-rows .s-rate').forEach(b => b.classList.toggle('is-on', b.dataset.sym === store.coin));
}

// Pick a coin that has a live positive rate first (USDT, USDC, BTC, ETH, SOL, or first available).
function preferredCoin(list, side = store.side || 'buy') {
  if (!list || !list.length) return null;
  const withRate = list.filter(c => c && Number(side === 'buy' ? c.buy_rate : c.sell_rate) > 0);
  const pool = withRate.length ? withRate : list;
  return pool.find(c => c.symbol === 'USDT')
    || pool.find(c => c.symbol === 'USDC')
    || pool.find(c => c.symbol === 'BTC')
    || pool.find(c => c.symbol === 'ETH')
    || pool.find(c => c.symbol === 'SOL')
    || pool[0];
}

function isAnyAmountCoin(sym, side) {
  return side === 'sell' && (sym === 'BTC' || sym === 'ETH' || (store.coins && store.coins[sym] && store.coins[sym].provider === 'hostfi'));
}

let lastEditedField = 'in';

function setSide(side) {
  store.side = side;
  lastEditedField = 'in';
  $('t-buy').setAttribute('aria-selected', String(side === 'buy'));
  $('t-sell').setAttribute('aria-selected', String(side === 'sell'));
  const available = Object.values(store.coins).filter(c => c[side + '_on']);
  const currentCoinValid = available.some(c => c.symbol === store.coin && Number(c[side + '_rate']) > 0);
  if (!currentCoinValid) {
    store.coin = (preferredCoin(available, side) || {}).symbol || null;
  }
  // Steps and details read differently for buying and selling.
  const buying = side === 'buy';
  $('how-2-title').textContent = buying ? 'Pay by bank transfer' : 'Send your crypto';
  $('how-2-text').textContent = buying ? 'You get an account number for your order. Transfer from any Nigerian bank.' : 'You get a deposit address for your order. Send from any wallet or exchange.';
  $('how-3-title').textContent = buying ? 'Receive your crypto' : 'Get paid in naira';
  $('how-3-text').textContent = buying ? "It's sent to your wallet automatically. Follow every step and get a receipt by email." : 'Naira goes to your bank account automatically. Follow every step and get a receipt by email.';
  $('s-dest').textContent = buying ? 'Delivered to your wallet' : 'Paid to your bank account';
  $('s-chips').innerHTML = buying ? BUY_CHIPS.map(v => `<button type="button" data-v="${v}" aria-label="Pay ${fmtNgn(v)}">₦${v / 1000}k</button>`).join('') : '';
  document.querySelectorAll('#s-chips button').forEach(b => b.addEventListener('click', () => {
    $('f-in').value = Number(b.dataset.v).toLocaleString('en-US');
    lastEditedField = 'in';
    render();
  }));

  const chipsOut = $('s-chips-out');
  if (chipsOut) {
    chipsOut.innerHTML = !buying ? BUY_CHIPS.map(v => `<button type="button" data-v="${v}" aria-label="Receive ${fmtNgn(v)}">₦${v / 1000}k</button>`).join('') : '';
    chipsOut.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      $('f-out').value = Number(b.dataset.v).toLocaleString('en-US');
      lastEditedField = 'out';
      render();
    }));
  }

  $('f-in').value = '';
  $('f-out').value = '';
  paintBoard();
  paintCoin(available);
  render();
}

function paintCoin(available) {
  const c = store.coins[store.coin];
  $('s-coin-btn').disabled = !c;
  if (c) {
    $('s-coin-img').src = COIN_LOGOS[c.symbol];
    $('s-coin-sym').textContent = c.symbol;
    $('s-coin-name').textContent = c.name;
  }
  const side = store.side;
  $('s-coin-list').innerHTML = (available || Object.values(store.coins).filter(x => x[side + '_on'])).map(x => {
    const rate = side === 'buy' ? x.buy_rate : x.sell_rate;
    return `<li><button type="button" role="option" aria-selected="${x.symbol === store.coin}" data-sym="${x.symbol}"><img src="${COIN_LOGOS[x.symbol]}" alt=""><span><b>${esc(x.symbol)}</b><small>${esc(x.name)}</small></span><em>${rate ? '$1 = ' + fmtNgn(rate) : 'Unavailable'}</em></button></li>`;
  }).join('');
  document.querySelectorAll('#s-coin-list button').forEach(b => b.addEventListener('click', () => {
    store.coin = b.dataset.sym;
    toggleCoins(false);
    paintCoin();
    render();
  }));
}

function toggleCoins(open) {
  const list = $('s-coin-list');
  const show = typeof open === 'boolean' ? open : list.hidden;
  list.hidden = !show;
  $('s-coin-btn').setAttribute('aria-expanded', String(show));
}

const amountEntered = () => Number(String($('f-in').value).replace(/,/g, '')) || 0;
const amountOutEntered = () => Number(String($('f-out').value).replace(/,/g, '')) || 0;

// Commas as they type, keeping the cursor where it was among the digits.
function formatInput(el, maxDecimals = 2) {
  const caret = el.selectionStart ?? el.value.length;
  const raw = el.value.replace(/[^0-9.]/g, '');
  if (!raw) {
    el.value = '';
    return;
  }
  const digitsBefore = el.value.slice(0, caret).replace(/[^0-9.]/g, '').length;
  const [whole, ...rest] = raw.split('.');
  const int = whole.replace(/^0+(?=\d)/, '').slice(0, 12);
  const dec = rest.length ? '.' + rest.join('').slice(0, maxDecimals) : '';
  el.value = (int ? Number(int).toLocaleString('en-US') : (dec ? '0' : '')) + dec;
  let seen = 0;
  let pos = 0;
  while (pos < el.value.length && seen < digitsBefore) {
    if (/[0-9.]/.test(el.value[pos])) seen += 1;
    pos += 1;
  }
  try { el.setSelectionRange(pos, pos); } catch (e) { /* not focused */ }
}

function onAmountInput() {
  lastEditedField = 'in';
  const buying = store.side === 'buy';
  formatInput($('f-in'), buying ? 2 : 8);
  render();
}

function onAmountOutInput() {
  lastEditedField = 'out';
  const buying = store.side === 'buy';
  formatInput($('f-out'), buying ? 8 : 2);
  render();
}

function calculateFromIn() {
  const c = store.coins[store.coin];
  const buying = store.side === 'buy';
  const amount = amountEntered();
  const rate = buying ? (c ? c.buy_rate : 0) : (c ? c.sell_rate : 0);

  if (!c || !rate || !c.usd_price || !(amount > 0)) {
    $('f-out').value = '';
    return;
  }

  if (buying) {
    const maxDec = ['USDT', 'USDC'].includes(c.symbol) ? 2 : 8;
    const coinAmt = Number((amount / rate / c.usd_price).toFixed(maxDec));
    $('f-out').value = coinAmt > 0 ? fmtCoin(coinAmt, c.symbol) : '';
  } else {
    const ngnAmt = Number((amount * c.usd_price * rate).toFixed(2));
    $('f-out').value = ngnAmt > 0 ? Number(ngnAmt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  }
}

function calculateFromOut() {
  const c = store.coins[store.coin];
  const buying = store.side === 'buy';
  const outAmt = amountOutEntered();
  const rate = buying ? (c ? c.buy_rate : 0) : (c ? c.sell_rate : 0);

  if (!c || !rate || !c.usd_price || !(outAmt > 0)) {
    $('f-in').value = '';
    return;
  }

  if (buying) {
    const ngnAmt = Number((outAmt * rate * c.usd_price).toFixed(2));
    $('f-in').value = ngnAmt > 0 ? Number(ngnAmt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
  } else {
    const maxDec = ['USDT', 'USDC'].includes(c.symbol) ? 2 : 8;
    const coinAmt = Number((outAmt / (c.usd_price * rate)).toFixed(maxDec));
    $('f-in').value = coinAmt > 0 ? fmtCoin(coinAmt, c.symbol) : '';
  }
}

function render() {
  const c = store.coins[store.coin];
  const buying = store.side === 'buy';
  const anyAmount = isAnyAmountCoin(store.coin, store.side);
  markBoard();

  $('f-in-wrap').hidden = anyAmount;
  $('f-out-wrap').hidden = anyAmount;
  $('s-chips').hidden = !buying;
  const chipsOut = $('s-chips-out');
  if (chipsOut) chipsOut.hidden = buying || anyAmount;
  $('s-any-amount').hidden = !anyAmount;
  if (anyAmount && c) $('s-any-coin').textContent = c.symbol;

  $('f-out').classList.toggle('is-empty', !(amountEntered() > 0 || amountOutEntered() > 0));
  $('f-in-label').textContent = buying ? 'You pay' : 'You send';
  $('f-out-label').textContent = buying ? 'You get' : 'You receive';
  $('f-in-cur').textContent = buying ? 'NGN' : (c ? c.symbol : '');
  $('f-out-cur').textContent = buying ? (c ? c.symbol : '') : 'NGN';
  $('s-go').textContent = c ? `${buying ? 'Buy' : 'Sell'} ${c.symbol}` : 'Continue';
  $('s-note').textContent = '';
  if (!c) {
    $('s-note').textContent = `No coins to ${store.side} right now.`;
    $('s-go').disabled = true;
    return;
  }
  $('s-time').textContent = tradeTime(c.symbol, buying);
  const rate = buying ? c.buy_rate : c.sell_rate;
  if (!rate || !c.usd_price) {
    $('s-coin-name').textContent = 'Rate unavailable right now';
    $('f-out').value = '';
    $('s-go').disabled = true;
    return;
  }
  $('s-go').disabled = false;
  // The merchant chooses: one final rate, or Velcro's rate plus their markup.
  const base = buying ? c.velcro_buy_rate : c.velcro_sell_rate;
  const pct = buying ? c.buy_markup_percent : c.sell_markup_percent;
  // The rate sits under the coin in the picker.
  $('s-coin-name').textContent = store.info.rate_display === 'breakdown' && base
    ? `$1 = ${fmtNgn(base)} + ${pct}% fee`
    : `$1 = ${fmtNgn(rate)}`;

  if (lastEditedField === 'out') {
    calculateFromOut();
  } else {
    calculateFromIn();
  }
}

async function goTrade() {
  const c = store.coins[store.coin];
  if (!c) return;
  const selling = store.side === 'sell';
  const anyAmount = isAnyAmountCoin(c.symbol, store.side);
  let amount = amountEntered();
  if (anyAmount) {
    amount = 0;
  } else if (!(amount > 0)) {
    $('s-note').textContent = store.side === 'buy' ? 'Enter how much naira you want to spend.' : 'Enter how much you want to sell.';
    if (selling && lastEditedField === 'out') {
      $('f-out').focus();
    } else {
      $('f-in').focus();
    }
    return;
  }
  if (!me && token) await loadMe();
  if (!me) {
    pendingTrade = true;
    openAuth('signin');
    return;
  }
  const btn = $('s-go');
  btn.disabled = true;
  const [nets, banks] = await Promise.all([
    networksFor(c.provider, c.symbol, selling),
    selling ? banksFor(c.provider) : Promise.resolve([])
  ]);
  btn.disabled = false;
  if (!nets.length || (selling && !banks.length)) {
    toast(`${selling ? 'Selling' : 'Buying'} ${c.symbol} isn't available right now. Try again shortly.`);
    return;
  }
  checkout = {
    step: 'details', side: store.side, coin: c.symbol, provider: c.provider, amount, nets, network: nets[0].code,
    wallet: '', banks, bank: '', account: '', accountName: '', order: null,
  };
  renderCheckout();
}

// Networks per provider and side. Each code is exactly what that provider's order expects.
async function networksFor(provider, symbol, selling) {
  if (provider === 'paj') return [{ code: 'solana', chain: 'solana', label: 'Solana' }];
  if (provider === 'switch') return switchNetworks(symbol, selling);
  return selling ? hostfiSellNetworks(symbol) : hostfiNetworks(symbol);
}

const TOP_BANK_CODES = [
  '100004', // OPay
  '000014', // Access Bank
  '000013', // GTBank
  '000015', // Zenith Bank
  '000016', // First Bank of Nigeria
  '000004', // United Bank for Africa (UBA)
  '000007', // Fidelity Bank
  '000018', // Union Bank
  '000017', // Wema Bank / ALAT
  '000001', // Sterling Bank
  '000010', // Ecobank
  '090267', // Kuda Bank
  '000008', // Kuda Bank (alt)
  '000012', // Stanbic IBTC
  '000003', // FCMB
  '100033', // PalmPay
  '090405', // Moniepoint
  '090393', // Moniepoint MFB
  '000011', // Unity Bank
  '000002', // Standard Chartered
];

const FALLBACK_NIGERIAN_BANKS = [
  { code: '100004', name: 'OPay' },
  { code: '000014', name: 'Access Bank' },
  { code: '000013', name: 'Guaranty Trust Bank' },
  { code: '000015', name: 'Zenith Bank' },
  { code: '000016', name: 'First Bank of Nigeria' },
  { code: '000004', name: 'United Bank For Africa' },
  { code: '000007', name: 'Fidelity Bank' },
  { code: '000018', name: 'Union Bank' },
  { code: '000017', name: 'Wema Bank (ALAT)' },
  { code: '000001', name: 'Sterling Bank' },
  { code: '000010', name: 'Ecobank Nigeria' },
  { code: '090267', name: 'Kuda Bank' },
  { code: '000012', name: 'Stanbic IBTC Bank' },
  { code: '000003', name: 'First City Monument Bank (FCMB)' },
  { code: '100033', name: 'PalmPay' },
  { code: '090405', name: 'Moniepoint MFB' },
  { code: '000011', name: 'Unity Bank' },
  { code: '000008', name: 'Polaris Bank' },
  { code: '000023', name: 'Providus Bank' },
  { code: '000026', name: 'TAJ Bank' },
  { code: '000027', name: 'Globus Bank' },
  { code: '000029', name: 'Lotus Bank' },
  { code: '000031', name: 'Premium Trust Bank' },
  { code: '000006', name: 'Jaiz Bank' },
  { code: '000021', name: 'Standard Chartered Bank' }
];

function sortBanks(banks) {
  return [...banks].sort((a, b) => {
    const aTop = TOP_BANK_CODES.indexOf(a.code);
    const bTop = TOP_BANK_CODES.indexOf(b.code);
    if (aTop !== -1 && bTop !== -1) return aTop - bTop;
    if (aTop !== -1) return -1;
    if (bTop !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
}

// Payout banks: PAJ keeps its own list; HostFi and Switch both take Switch's bank codes.
const bankLists = {};
async function banksFor(provider) {
  const key = provider === 'paj' ? 'paj' : 'switch';
  if (!bankLists[key] || !bankLists[key].length) {
    try {
      const cached = sessionStorage.getItem('velcro_banks_' + key);
      if (cached) {
        bankLists[key] = JSON.parse(cached);
        return bankLists[key];
      }
    } catch (e) {}
    try {
      const raw = await api(key === 'paj' ? '/api/paj/banks' : '/api/institutions?country=NG&currency=NGN&channel=BANK');
      const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
      const list = arr.filter(b => b && b.name)
        .map(b => ({
          id: String(key === 'paj' ? (b.id || b.code) : (b.code || b.id)),
          code: String(b.code || b.id || ''),
          name: String(b.name).trim()
        }));
      bankLists[key] = sortBanks(list.length ? list : FALLBACK_NIGERIAN_BANKS.map(b => ({ id: b.code, code: b.code, name: b.name })));
      try { sessionStorage.setItem('velcro_banks_' + key, JSON.stringify(bankLists[key])); } catch (e) {}
    } catch (e) {
      bankLists[key] = sortBanks(FALLBACK_NIGERIAN_BANKS.map(b => ({ id: b.code, code: b.code, name: b.name })));
    }
  }
  return bankLists[key];
}

// ── Checkout ──

// Networks come from HostFi's own list, so the code we send is exactly the one it expects.
const CHAIN_LABELS = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', solana: 'Solana', polygon: 'Polygon', arbitrum: 'Arbitrum', optimism: 'Optimism', tron: 'Tron' };
const CHAIN_LOGOS = {
  bitcoin: '/logos/bitcoin.png',
  ethereum: '/logos/ethereum.png',
  base: '/logos/base.png',
  bsc: '/logos/bsc.png',
  bnb: '/logos/bsc.png',
  solana: '/logos/solana.png',
  polygon: '/logos/polygon.png',
  arbitrum: '/logos/arbitrum.png',
  optimism: '/logos/optimism.png',
  tron: '/logos/tron.png',
  celo: '/logos/celo.png',
  avalanche: '/logos/avalanche.png',
  sui: '/logos/sui.png',
  linea: '/logos/linea.png',
  mantle: '/logos/mantle.png',
};

function getChainLogo(chain) {
  if (!chain) return '';
  const raw = String(chain).toLowerCase().split(':')[0].trim();
  const clean = raw.replace(/[^a-z0-9]/g, '');
  const alias = {
    bnb: 'bsc',
    binance: 'bsc',
    bnbchain: 'bsc',
    bep20: 'bsc',
    bsc: 'bsc',
    trx: 'tron',
    trc20: 'tron',
    tron: 'tron',
    sol: 'solana',
    spl: 'solana',
    solana: 'solana',
    eth: 'ethereum',
    erc20: 'ethereum',
    ethereum: 'ethereum',
    btc: 'bitcoin',
    bitcoin: 'bitcoin',
    matic: 'polygon',
    pol: 'polygon',
    polygon: 'polygon',
    arb: 'arbitrum',
    arbitrum: 'arbitrum',
    op: 'optimism',
    optimism: 'optimism',
    avax: 'avalanche',
    avaxc: 'avalanche',
    avalanche: 'avalanche',
    base: 'base',
    celo: 'celo',
    sui: 'sui',
    linea: 'linea',
    mantle: 'mantle',
    gnosis: 'gnosis',
    monad: 'monad',
    plasma: 'plasma',
    sonic: 'sonic',
    berachain: 'berachain',
    hyperevm: 'hyperevm',
  };
  const resolved = alias[clean] || alias[raw] || clean;
  return CHAIN_LOGOS[resolved] || `/logos/${resolved}.png`;
}

const EVM_RULE = [/^0x[a-fA-F0-9]{40}$/, 'an address that starts with 0x'];
const WALLET_RULES = {
  bitcoin: [/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, 'a Bitcoin address (starts with bc1, 1 or 3)'],
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a Solana address'],
  tron: [/^T[1-9A-HJ-NP-Za-km-z]{33}$/, 'a Tron address (starts with T)'],
  ethereum: EVM_RULE, base: EVM_RULE, bsc: EVM_RULE, polygon: EVM_RULE, arbitrum: EVM_RULE, optimism: EVM_RULE,
};
let buyAssets = null;

// Switch's networks for stablecoins, the common ones first. The code sent is "chain:symbol".
const SWITCH_CHAINS = ['tron', 'bsc', 'solana', 'base', 'ethereum', 'polygon', 'arbitrum', 'optimism'];
let switchAssets = null;

async function switchNetworks(symbol, selling = false) {
  if (!switchAssets) {
    try { switchAssets = await api('/api/assets'); } catch (e) { return []; }
  }
  const chains = ((switchAssets[selling ? 'offramp' : 'onramp'] || {})[symbol] || {}).chains || [];
  return SWITCH_CHAINS.filter(ch => chains.includes(ch)).map(ch => ({ code: `${ch}:${symbol.toLowerCase()}`, chain: ch, label: CHAIN_LABELS[ch] }));
}

async function hostfiNetworks(symbol) {
  if (!buyAssets) {
    try { buyAssets = await api('/api/hostfi/buy-assets'); } catch (e) { return []; }
  }
  const a = (buyAssets || []).find(x => x.symbol === symbol);
  return a ? a.networks.map(n => ({ code: n.code, chain: n.chain, label: CHAIN_LABELS[n.chain] || n.code })) : [];
}
let sellAssets = null;
async function hostfiSellNetworks(symbol) {
  if (!sellAssets) {
    try { sellAssets = await api('/api/hostfi/assets'); } catch (e) { return []; }
  }
  const a = (sellAssets || []).find(x => x.symbol === symbol);
  return a ? a.networks.map(n => ({ code: n.code, chain: n.chain, label: CHAIN_LABELS[n.chain] || n.code })) : [];
}

const PAJ_MINTS = { SOL: 'So11111111111111111111111111111111111111112' };
const WAITING_STATUSES = ['AWAITING_DEPOSIT', 'PENDING', 'INITIATED'];
const RECEIVED_STATUSES = ['DETECTED', 'RECEIVED', 'VERIFIED', 'CONFIRMED', 'PROCESSING', 'COMPLETED'];
const ENDED_STATUSES = ['FAILED', 'CANCELLED', 'EXPIRED'];
let checkout = null;
let pollTimer = null;
let expiryTimer = null;
const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

function stopTimers() {
  clearInterval(pollTimer);
  clearInterval(expiryTimer);
}

function showForm() {
  stopTimers();
  checkout = null;
  document.body.classList.remove('s-in-checkout');
  $('s-checkout').hidden = true;
  $('s-form').hidden = false;
}

function renderCheckout() {
  document.body.classList.add('s-in-checkout');
  $('s-form').hidden = true;
  const box = $('s-checkout');
  box.hidden = false;
  const selling = checkout.side === 'sell' || (checkout.order && checkout.order.side === 'sell');
  if (checkout.step === 'details') box.innerHTML = selling ? sellDetailsHtml() : checkoutDetailsHtml();
  else if (checkout.step === 'pay') {
    box.innerHTML = selling ? sellPayHtml() : checkoutPayHtml();
    if (selling && checkout.order && checkout.order.address) {
      const qrEl = $('co-sell-qr');
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        try {
          const qrSize = Math.max(220, Math.min(280, (window.innerWidth || 360) - 80));
          new QRCode(qrEl, {
            text: checkout.order.address,
            width: qrSize,
            height: qrSize,
            colorDark: '#15151f',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
          const canvas = qrEl.querySelector('canvas');
          if (canvas) canvas.style.display = 'none';
        } catch (e) { /* ignore */ }
      }
    }
  }
  else if (checkout.step === 'orders') box.innerHTML = ordersHtml();
  wireCheckout();
  const top = document.querySelector('.s-trade').getBoundingClientRect().top;
  if (top < 0) window.scrollBy({ top: top - 12, behavior: 'smooth' });
  if (checkout.step === 'details' && window.innerWidth >= 960) setTimeout(() => { const f = $('co-wallet'); if (f && !f.value) f.focus(); }, 50);
}

function estimateFor(symbol, ngn) {
  const c = store.coins[symbol];
  return c && c.buy_rate && c.usd_price ? ngn / c.buy_rate / c.usd_price : 0;
}

// Naira a sale of `amount` coin pays at the store's rate.
function payoutFor(symbol, amount) {
  const c = store.coins[symbol];
  return c && c.sell_rate && c.usd_price ? amount * c.usd_price * c.sell_rate : 0;
}

function netLabel() {
  return (checkout.nets.find(n => n.code === checkout.network) || {}).label || '';
}

function netPickerHtml(label) {
  const nets = checkout.nets;
  if (nets.length < 2) return '';
  return `<span class="s-label">${label}</span><div class="s-seg" data-cols="${nets.length === 2 ? '2' : '3'}">${nets.map(n => {
    const logo = getChainLogo(n.chain || n.code || n.label);
    return `<button type="button" data-net="${esc(n.code)}" aria-pressed="${n.code === checkout.network}">${logo ? `<img src="${logo}" alt="" class="s-net-icon" onerror="this.style.display='none'">` : ''}<span>${esc(n.label)}</span></button>`;
  }).join('')}</div>`;
}

const shortAddr = a => { const s = String(a || ''); return s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s; };

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

function resolveStoreBankName(o) {
  if (o.payoutBank && String(o.payoutBank).toLowerCase() !== 'bank') return o.payoutBank;
  const acct = String(o.payoutAccount || '');
  if (/^[789][01]\d{8}$/.test(acct)) return 'OPay';
  return 'Bank Account';
}

function orderReceiptHtml(o) {
  let isBuy = (o.side === 'buy') ||
    (typeof checkout !== 'undefined' && checkout && checkout.side === 'buy') ||
    (o.type && String(o.type).toUpperCase() === 'ONRAMP') ||
    (o.direction && String(o.direction).toUpperCase() === 'ONRAMP') ||
    (Boolean(o.account) && !o.address) ||
    (Boolean(o.wallet) && !o.address);

  // Absolute safety guard: if order has bank transfer details or recipient wallet without a deposit address, it is definitively a BUY
  if (!o.address && (o.account || o.bank || o.wallet)) {
    isBuy = true;
  }
  if (o.address && !o.account) {
    isBuy = false;
  }

  const cryptoAmt = isBuy
    ? (o.destAmount ? `${fmtCoin(o.destAmount, o.coin)} ${esc(o.coin)}` : (o.amount ? `${fmtCoin(estimateFor(o.coin, o.amount), o.coin)} ${esc(o.coin)}` : esc(o.coin)))
    : (o.sendAmount ? `${fmtCoin(o.sendAmount, o.coin)} ${esc(o.coin)}` : (o.amount ? `${fmtCoin(o.amount, o.coin)} ${esc(o.coin)}` : esc(o.coin)));
  let fiatAmt;
  if (isBuy) {
    fiatAmt = fmtNgn(o.amount);
  } else {
    const rawFiat = o.payoutAmount || (o.side === 'sell' ? o.destAmount : null) || (o.progress && o.progress.payout_amount) || payoutFor(o.coin, o.sendAmount || o.amount);
    fiatAmt = rawFiat > 0 ? fmtNgn(rawFiat) : 'Worked out on arrival';
  }
  const explorerUrl = (o.progress && o.progress.explorer_url) ? o.progress.explorer_url : (o.hash ? getExplorerUrl(o.hash, o.network || o.coin) : '');
  const shortW = shortAddr(o.wallet);
  const shortH = shortAddr(o.hash);

  return `
    <div class="s-receipt-box">
      <div class="s-receipt-grid">
        <div class="s-receipt-item"><small>${isBuy ? 'You pay' : 'You send'}</small><b>${isBuy ? fiatAmt : cryptoAmt}</b></div>
        <div class="s-receipt-item"><small>You receive</small><b>${isBuy ? cryptoAmt : fiatAmt}</b></div>
      </div>
      ${isBuy && o.wallet ? `
        <div class="s-receipt-row">
          <small>Receiving wallet (${esc(o.network || o.coin)})</small>
          <div class="s-receipt-val"><code title="${esc(o.wallet)}">${esc(shortW)}</code><button type="button" class="s-copy-sm" data-copy="${esc(o.wallet)}">Copy</button></div>
        </div>` : ''}
      ${!isBuy && (o.payoutBank || o.payoutAccount) ? `
        <div class="s-receipt-row">
          <small>Payout destination</small>
          <div class="s-receipt-val"><b>${esc(resolveStoreBankName(o))}</b> · <code>${esc(o.payoutAccount || '')}</code>${o.payoutName ? ` <small>(${esc(o.payoutName)})</small>` : ''}</div>
        </div>` : ''}
      ${o.hash ? `
        <div class="s-receipt-row">
          <small>Transaction hash</small>
          <div class="s-receipt-val"><code title="${esc(o.hash)}">${esc(shortH)}</code><button type="button" class="s-copy-sm" data-copy="${esc(o.hash)}">Copy</button>${explorerUrl ? `<a href="${esc(explorerUrl)}" target="_blank" rel="noopener" class="s-exp-sm">Explorer ↗</a>` : ''}</div>
        </div>` : ''}
      ${o.createdAt ? `
        <div class="s-receipt-row">
          <small>Order date</small>
          <div class="s-receipt-val"><span>${fmtDate(o.createdAt)}</span></div>
        </div>` : ''}
    </div>`;
}

const bankRow = (label, value, copy, cls = '') => `<div><div class="s-bank-k"><span>${label}</span><b class="${cls}">${value}</b></div>${copy ? `<button type="button" class="s-copy" data-copy="${esc(copy)}" aria-label="Copy ${label}">${ICON_COPY}Copy</button>` : ''}</div>`;

function waSupportLink(s, o, msgPrefix = 'I need help with my Order') {
  if (!s || !s.support_url) return '';
  const isWa = /wa\.me|whatsapp/i.test(s.support_url);
  if (!isWa || !o || !o.reference) return s.support_url;
  const side = (o.side || 'trade').toUpperCase();
  const coin = o.coin || '';
  const text = `Hello ${s.name}, ${msgPrefix} ${o.reference} (${side} ${coin})`;
  return `${s.support_url}${s.support_url.includes('?') ? '&' : '?'}text=${encodeURIComponent(text)}`;
}

const orderFootHtml = o => {
  const s = store && store.info;
  const isWa = s && s.support_url && /wa\.me|whatsapp/i.test(s.support_url);
  const helpUrl = waSupportLink(s, o, 'I need help with my Order');
  const helpLink = s && s.support_url ? ` · <a href="${esc(helpUrl)}" target="_blank" rel="noopener" class="s-help-link">Need help? Chat with ${esc(s.name)}${isWa ? ' on WhatsApp' : ''}</a>` : '';
  return `<p class="s-order-ref">Order <button type="button" data-copy="${esc(o.reference)}" title="Copy order number"><code>${esc(shortRef(o.reference))}</code></button> · your receipt goes to ${esc(me ? me.email : 'your email')}${helpLink}</p>`;
};

// Where an order stands. An account or address past its time is never shown as payable.
function orderState(o) {
  const waiting = WAITING_STATUSES.includes(o.status);
  const lapsed = waiting && o.expiresAt > 0 && Date.now() > o.expiresAt;
  return { waiting: waiting && !lapsed, ended: lapsed || ENDED_STATUSES.includes(o.status), done: o.status === 'COMPLETED' };
}

function endedHtml(o) {
  const sell = o.side === 'sell';
  const s = store && store.info;
  const isWa = s && s.support_url && /wa\.me|whatsapp/i.test(s.support_url);
  const helpUrl = waSupportLink(s, o, 'I have an issue with Order');
  const help = s && s.support_url ? `<a href="${esc(helpUrl)}" target="_blank" rel="noopener">Chat with ${esc(s.name)}${isWa ? ' on WhatsApp' : ''}</a>` : `Contact ${esc(s ? s.name : 'us')}`;
  if (o.status === 'FAILED') return `<div class="s-ended"><b>This order didn't go through</b>${help} if you've already ${sell ? 'sent your crypto' : 'paid'}.</div>`;
  return `<div class="s-ended"><b>This order has expired</b>Don't ${sell ? 'send anything to this address' : 'pay into this account'}. Start a new order instead. Already ${sell ? 'sent it' : 'paid'}? ${help}.</div>`;
}

function toggleBankDropdown(open) {
  const dd = $('co-bank-dropdown');
  const btn = $('co-bank-btn');
  if (!dd || !btn) return;
  const show = typeof open === 'boolean' ? open : dd.hidden;
  dd.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
  if (show) {
    renderBankList($('co-bank-search')?.value || '');
    setTimeout(() => $('co-bank-search')?.focus({ preventScroll: true }), 50);
  }
}

function clearBankSearch() {
  const input = $('co-bank-search');
  if (input) {
    input.value = '';
    renderBankList('');
    input.focus();
  }
  if ($('co-bank-clear')) $('co-bank-clear').hidden = true;
}

function filterBanks(query) {
  if ($('co-bank-clear')) $('co-bank-clear').hidden = !query;
  renderBankList(query);
}

function selectBank(id) {
  checkout.bank = id;
  const bank = (checkout.banks || []).find(b => b.id === id);
  const selectedEl = $('co-bank-selected');
  if (selectedEl) {
    selectedEl.textContent = bank ? bank.name : 'Choose your bank';
    selectedEl.className = bank ? 'has-bank' : 'is-empty';
  }
  toggleBankDropdown(false);
  checkAccountName();
}

function renderBankList(query) {
  const listEl = $('co-bank-list');
  if (!listEl) return;
  const q = String(query || '').toLowerCase().trim();
  const banks = (checkout.banks || []).filter(b => !q || b.name.toLowerCase().includes(q) || b.code.includes(q));
  if (!banks.length) {
    listEl.innerHTML = `<div class="s-bank-empty">No banks found matching "${esc(query)}"</div>`;
    return;
  }
  listEl.innerHTML = banks.map(b => `<button type="button" role="option" class="s-bank-item${b.id === checkout.bank ? ' is-selected' : ''}" data-bid="${esc(b.id)}"><span>${esc(b.name)}</span>${b.id === checkout.bank ? ICON_CHECK : ''}</button>`).join('');
  listEl.querySelectorAll('.s-bank-item').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      selectBank(btn.dataset.bid);
    };
  });
}

document.addEventListener('click', e => {
  const wrap = $('co-bank-wrap');
  if (wrap && !wrap.contains(e.target)) {
    toggleBankDropdown(false);
  }
});

const nameOkHtml = name => `<div class="s-name-ok">${ICON_CHECK}<span>${esc(name)}</span></div>`;

function sellDetailsHtml() {
  const c = store.coins[checkout.coin];
  const isAny = isAnyAmountCoin(c.symbol, checkout.side) || !(checkout.amount > 0);
  const est = checkout.amount > 0 ? payoutFor(c.symbol, checkout.amount) : 0;
  const currentBank = (checkout.banks || []).find(b => b.id === checkout.bank);
  const selectedBankName = currentBank ? currentBank.name : '';

  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">Sell ${esc(c.symbol)}</h2>
    <div class="s-co-sum">
      <div><span>You send</span><b>${isAny ? `Any amount of ${esc(c.symbol)}` : `${fmtCoin(checkout.amount, c.symbol)} ${esc(c.symbol)}`}</b></div>
      <div><span>You receive about</span><b>${est > 0 ? fmtNgn(est) : 'Worked out on arrival'}</b></div>
    </div>
    ${netPickerHtml("Network you'll send on")}

    <span class="s-label" id="co-bank-label">Your bank</span>
    <div class="s-bank-select" id="co-bank-wrap">
      <button type="button" class="s-bank-trigger" id="co-bank-btn" aria-labelledby="co-bank-label" aria-haspopup="listbox" aria-expanded="false" onclick="toggleBankDropdown()">
        <span id="co-bank-selected" class="${selectedBankName ? 'has-bank' : 'is-empty'}">${esc(selectedBankName || 'Choose your bank')}</span>
        ${ICON_DOWN}
      </button>
      <div class="s-bank-dropdown" id="co-bank-dropdown" hidden>
        <div class="s-bank-search-bar">
          ${ICON_SEARCH}
          <input type="text" id="co-bank-search" placeholder="Search banks" aria-label="Search banks" autocomplete="off" autocorrect="off" spellcheck="false" oninput="filterBanks(this.value)">
          <button type="button" class="s-bank-search-clear" id="co-bank-clear" onclick="clearBankSearch()" hidden aria-label="Clear search">✕</button>
        </div>
        <div class="s-bank-list" id="co-bank-list" role="listbox"></div>
      </div>
    </div>

    <label class="s-label" for="co-acct">Account number</label>
    <input id="co-acct" class="s-input s-mono" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="10 digits" value="${esc(checkout.account)}">
    <div id="co-name" class="s-name-box">${checkout.accountName ? nameOkHtml(checkout.accountName) : 'We check the name on the account before you send anything.'}</div>

    <p id="co-error" class="s-error" hidden></p>
    <button type="button" class="s-btn s-go" data-act="create"${checkout.accountName ? '' : ' disabled'}>Get deposit address</button>
    <p class="s-trust">Naira is paid only to an account in the name shown above.</p>`;
}

function sellPayHtml() {
  const o = checkout.order;
  const { waiting, ended, done } = orderState(o);
  const amount = o.sendAmount ? `${fmtCoin(o.sendAmount, o.coin)} ${esc(o.coin)}` : esc(o.coin);
  const title = done ? 'Naira paid'
    : ended ? (o.status === 'FAILED' ? "Order didn't go through" : 'Order expired')
    : waiting ? (o.claimed ? `Confirming your ${esc(o.coin)}` : (o.sendAmount ? `Send ${amount}` : `Send ${esc(o.coin)}`))
    : `Selling ${esc(o.coin)}`;
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">${title}</h2>
    ${ended ? endedHtml(o) : !waiting ? '' : o.claimed && !o.showDetails ? checkingHtml(o, `your ${amount}`) : `
    <p class="s-co-lede">Send ${o.exact ? 'exactly this amount' : (o.sendAmount ? 'your ' + esc(o.coin) : 'any amount of ' + esc(o.coin))} to the address below${o.network ? `, on the <b>${esc(o.network)}</b> network` : ''}. We'll detect it automatically.</p>
    <div class="s-net-alert">
      <div class="s-net-badge">
        <span class="s-net-dot"></span>
        <span>Network: <b>${esc(o.network || o.coin)}</b></span>
      </div>
      <p class="s-net-desc">⚠️ Send only <b>${esc(o.coin)}</b> on the <b>${esc(o.network || o.coin)}</b> network. Sending via other networks will result in permanent loss.</p>
    </div>
    ${o.address ? `
    <div class="s-qr-wrap">
      <div class="s-qr-pill"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/></svg><span>Scan to pay</span></div>
      <div id="co-sell-qr" class="s-qr-code"></div>
      <span class="s-qr-caption">Scan with any <b>${esc(o.coin)}</b> wallet</span>
    </div>` : ''}
    <div class="s-bank">
      ${bankRow('Address', esc(o.address), o.address, 's-mono')}
      ${o.memo ? bankRow('Memo', esc(o.memo), o.memo, 's-mono') : ''}
      ${o.sendAmount ? bankRow('Amount', amount, String(o.sendAmount)) : ''}
      ${o.payTo ? bankRow('Payout destination', esc(o.payTo)) : ''}
    </div>
    <p class="s-expiry" id="co-expiry"></p>
    ${o.claimed ? '<button type="button" class="s-link-btn" data-act="hide-details">Back to checking</button>' : `<button type="button" class="s-btn s-go" data-act="paid">I’ve sent the ${esc(o.coin)}</button>
    <p class="s-hint s-center-text">Tap this once it has left your wallet.</p>`}`}
    ${orderReceiptHtml(o)}
    <div class="s-tear" aria-hidden="true"></div>
    <ol class="s-progress" id="co-steps">${sellProgressHtml(o)}</ol>
    ${done ? '<button type="button" class="s-btn s-go" data-act="new">Start a new order</button>' : ''}
    ${orderFootHtml(o)}`;
}

// Sell steps: waiting for the coin → received → paying the bank → paid.
function sellProgressHtml(o) {
  const p = o.progress || {};
  const received = RECEIVED_STATUSES.includes(o.status) || !!p.amount;
  const paying = received && (p.payout === 'pending' || p.converted === 'done' || o.status === 'PROCESSING');
  const paid = p.payout === 'done' || o.status === 'COMPLETED';
  const steps = [
    [received ? 'Order created' : `Waiting for your ${esc(o.coin)}`, received ? 'done' : 'now', received ? '' : 'We check for it every few seconds.'],
    [`${esc(o.coin)} received`, received ? 'done' : 'next', received && p.amount ? `${fmtCoin(p.amount, o.coin)} ${esc(o.coin)}` : ''],
    ['Paying your bank', paid ? 'done' : (received ? 'now' : 'next'), paying && p.converted === 'pending' ? 'Converting…' : ''],
    ['Naira paid', paid ? 'done' : 'next', p.payout_amount ? fmtNgn(p.payout_amount) : ''],
  ];
  if (p.payout === 'failed' || p.payout === 'review' || o.status === 'REVIEW') {
    steps[2] = ['We’re checking your order', 'warn', "Your money is safe. We'll email you shortly."];
  }
  return steps.map(([t, st, d]) => `<li class="is-${st}"><i>${st === 'done' ? ICON_CHECK : ''}</i><div><b>${t}</b>${d ? `<span>${d}</span>` : ''}</div></li>`).join('');
}

// Checks the account name with the provider that will pay it.
let nameTimer = null;

function parseResolvedName(d) {
  if (!d) return '';
  const obj = d.data ?? d;
  const name = obj.accountName || obj.account_name || obj.holder_name || obj.name || (obj.data && (obj.data.account_name || obj.data.accountName)) || '';
  return String(name).trim();
}

async function resolveAccount(bank, accountNumber) {
  const num = String(accountNumber || '').trim();
  const bankCode = bank.code || bank.id;
  const bankName = bank.name || '';
  const pajId = bank.id || bank.code;

  const attempts = [];

  if (checkout.provider === 'paj') {
    // 1. Try PAJ resolve -> 2. Switch resolve -> 3. HostFi resolve
    attempts.push(() => api('/api/paj/resolve', { method: 'POST', body: { bank: pajId, accountNumber: num } }));
    attempts.push(() => api('/api/resolve', { method: 'POST', body: { country: 'NG', beneficiary: { account_number: num, bank_code: bankCode } } }));
    attempts.push(() => api('/api/hostfi/resolve', { method: 'POST', body: { bankCode, bankName, accountNumber: num } }));
  } else if (checkout.provider === 'hostfi') {
    // 1. Try HostFi resolve -> 2. Switch resolve
    attempts.push(() => api('/api/hostfi/resolve', { method: 'POST', body: { bankCode, bankName, accountNumber: num } }));
    attempts.push(() => api('/api/resolve', { method: 'POST', body: { country: 'NG', beneficiary: { account_number: num, bank_code: bankCode } } }));
  } else {
    // Switch order: 1. Switch resolve -> 2. HostFi resolve
    attempts.push(() => api('/api/resolve', { method: 'POST', body: { country: 'NG', beneficiary: { account_number: num, bank_code: bankCode } } }));
    attempts.push(() => api('/api/hostfi/resolve', { method: 'POST', body: { bankCode, bankName, accountNumber: num } }));
  }

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const res = await fn();
      const name = parseResolvedName(res);
      if (name) return name;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Could not verify account name.');
}

function checkAccountName() {
  if ($('co-acct')) {
    checkout.account = $('co-acct').value.replace(/\D/g, '').slice(0, 10);
    $('co-acct').value = checkout.account;
  }
  checkout.accountName = '';
  const out = $('co-name');
  const go = $('s-checkout')?.querySelector('[data-act="create"]');
  if (go) go.disabled = true;
  if (!out) return;

  clearTimeout(nameTimer);

  if (!checkout.bank) {
    out.textContent = 'Choose your bank above to check the account.';
    return;
  }

  if (checkout.account.length < 10) {
    out.textContent = 'Enter your 10-digit account number.';
    return;
  }

  out.innerHTML = '<div class="s-name-wait"><span class="s-spinner" aria-hidden="true"></span>Checking the account…</div>';

  const bank = (checkout.banks || []).find(b => b.id === checkout.bank) || {};
  const currentKey = checkout.bank + ':' + checkout.account;

  nameTimer = setTimeout(async () => {
    try {
      const resolvedName = await resolveAccount(bank, checkout.account);
      if (currentKey !== checkout.bank + ':' + checkout.account) return;
      if (!resolvedName) throw new Error('We couldn’t find that account. Check the number and bank.');

      checkout.accountName = resolvedName;
      out.innerHTML = nameOkHtml(checkout.accountName);
      if (go) go.disabled = false;
    } catch (e) {
      if (currentKey !== checkout.bank + ':' + checkout.account) return;
      out.innerHTML = `<div class="s-name-bad">${esc(e.message || 'We couldn’t verify this account.')}<small>Naira is only paid to an account we can verify. Check the details, or try again in a moment.</small></div>`;
    }
  }, 500);
}

async function createSell() {
  const err = $('co-error');
  err.hidden = true;
  const bank = checkout.banks.find(b => b.id === checkout.bank) || {};
  if (!checkout.accountName) return;
  const btn = $('s-checkout').querySelector('[data-act="create"]');
  btn.disabled = true;
  btn.textContent = 'Creating your order…';
  const base = {
    side: 'sell',
    coin: checkout.coin,
    amount: checkout.amount,
    sendAmount: checkout.amount > 0 ? checkout.amount : null,
    payoutAmount: checkout.amount > 0 ? payoutFor(checkout.coin, checkout.amount) : null,
    status: 'AWAITING_DEPOSIT',
    network: netLabel(),
    payoutBank: bank.name,
    payoutAccount: checkout.account,
    payoutName: checkout.accountName,
    payTo: `${checkout.accountName} · ${bank.name}`,
    progress: {}
  };
  try {
    if (checkout.provider === 'hostfi') {
      const d = await api('/api/hostfi/sell', { method: 'POST', body: { store: SLUG, asset: checkout.coin, network: checkout.network, bankCode: bank.code, bankName: bank.name, accountNumber: checkout.account, amount: checkout.amount || 0 } });
      checkout.order = { ...base, reference: d.reference, address: d.address, memo: d.memo, sendAmount: checkout.amount > 0 ? checkout.amount : null, payoutAmount: Number(d.estimate_ngn) || base.payoutAmount, exact: false, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
    } else if (checkout.provider === 'paj') {
      const d = await api('/api/paj/sell', { method: 'POST', body: { store: SLUG, fiatAmount: Math.floor(payoutFor(checkout.coin, checkout.amount)), mint: PAJ_MINTS[checkout.coin], bank: bank.id, bankName: bank.name, accountNumber: checkout.account, accountName: checkout.accountName } });
      checkout.order = { ...base, reference: d.id, address: d.address, sendAmount: Number(d.amount) || checkout.amount, payoutAmount: Number(d.fiatAmount) || base.payoutAmount, exact: true, expiresAt: Date.now() + 3600 * 1000 };
    } else {
      const d = await api('/api/initiate', {
        method: 'POST',
        body: {
          store: SLUG, direction: 'OFFRAMP', amount: checkout.amount, country: 'NG', currency: 'NGN', channel: 'BANK', asset: checkout.network,
          beneficiary: { holder_type: 'INDIVIDUAL', holder_name: checkout.accountName, account_number: checkout.account, bank_code: bank.code, bank_name: bank.name },
        },
      });
      const dep = d.deposit;
      const dest = d.destination || {};
      checkout.order = {
        ...base, reference: d.velcro_reference || d.reference, address: (typeof dep === 'string' ? dep : (dep && dep.address)) || d.address || '',
        sendAmount: Number((d.source || {}).amount) || checkout.amount, payoutAmount: Number(dest.amount) || base.payoutAmount, exact: true, expiresAt: Date.now() + 3600 * 1000,
      };
    }
    checkout.step = 'pay';
    renderCheckout();
    startPolling();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Get deposit address';
  }
}

function checkoutDetailsHtml() {
  const c = store.coins[checkout.coin];
  const nets = checkout.nets;
  const est = estimateFor(c.symbol, checkout.amount);
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">Buy ${esc(c.symbol)}</h2>
    <div class="s-co-sum">
      <div><span>You pay</span><b>${fmtNgn(checkout.amount)}</b></div>
      <div><span>You get about</span><b>${est > 0 ? `${fmtCoin(est, c.symbol)} ${esc(c.symbol)}` : 'Shown next'}</b></div>
    </div>
    ${netPickerHtml('Network')}
    <label class="s-label" for="co-wallet">Your ${esc(c.symbol)} wallet address${nets.length === 1 ? '' : ` on ${esc(netLabel())}`}</label>
    <input id="co-wallet" class="s-input s-mono" autocomplete="off" spellcheck="false" placeholder="Paste your address" value="${esc(checkout.wallet)}">
    <p class="s-hint">Double-check it. Crypto sent to the wrong address can't be recovered.</p>
    <p id="co-error" class="s-error" hidden></p>
    <button type="button" class="s-btn s-go" data-act="create">Get payment details</button>
    <p class="s-trust">The network fee is taken from the ${esc(c.symbol)} you receive.</p>`;
}

function checkoutPayHtml() {
  const o = checkout.order;
  const { waiting, ended, done } = orderState(o);
  const title = done ? `${esc(o.coin)} sent`
    : ended ? (o.status === 'FAILED' ? "Order didn't go through" : 'Order expired')
    : waiting ? (o.claimed ? 'Confirming your payment' : `Transfer ${fmtNgn(o.amount)}`)
    : `Buying ${esc(o.coin)}`;
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">${title}</h2>
    ${ended ? endedHtml(o) : !waiting ? '' : o.claimed && !o.showDetails ? checkingHtml(o, `your ${fmtNgn(o.amount)} transfer`) : `
    <p class="s-co-lede">Send exactly this amount from any Nigerian bank to the account below. We'll detect it automatically.</p>
    <div class="s-bank">
      ${bankRow('Account number', esc(o.account), o.account, 'is-big')}
      ${bankRow('Bank', esc(o.bank))}
      ${bankRow('Account name', esc(o.accountName))}
      ${bankRow('Amount', fmtNgn(o.amount), String(o.amount))}
    </div>
    <p class="s-expiry" id="co-expiry"></p>
    ${o.claimed ? '<button type="button" class="s-link-btn" data-act="hide-details">Back to checking</button>' : `<button type="button" class="s-btn s-go" data-act="paid">I’ve sent the money</button>
    <p class="s-hint s-center-text">Tap this once your transfer has gone through.</p>`}`}
    ${orderReceiptHtml(o)}
    <div class="s-tear" aria-hidden="true"></div>
    <ol class="s-progress" id="co-steps">${progressHtml(o)}</ol>
    ${done ? '<button type="button" class="s-btn s-go" data-act="new">Start a new order</button>' : ''}
    ${orderFootHtml(o)}`;
}

// After "I've sent it": what we're waiting for, how long we've been looking, and where they'll hear.
function checkingHtml(o, what) {
  return `
    <div class="s-checking">
      <span class="s-checking-ring" aria-hidden="true"></span>
      <div>
        <b>Checking for ${what}</b>
        <p>Most ${o.side === 'sell' ? 'deposits' : 'transfers'} show up within 1–5 minutes. You can leave this page; we'll email you at ${esc(me ? me.email : 'your email')} at each step.</p>
        <span class="s-checking-time" id="co-checking"></span>
      </div>
    </div>
    <button type="button" class="s-link-btn" data-act="show-details">Show ${o.side === 'sell' ? 'deposit' : 'payment'} details</button>`;
}

const PAID_KEY = ref => 'velcro_paid_' + ref;
function paidAt(ref) {
  try { return Number(localStorage.getItem(PAID_KEY(ref))) || 0; } catch (e) { return 0; }
}

// Steps from the order's live status: waiting → received → converting/sending → sent → confirmed.
function progressHtml(o) {
  const p = o.progress || {};
  const received = RECEIVED_STATUSES.includes(o.status) || !!p.amount;
  const sent = p.payout === 'sent' || p.payout === 'done' || o.status === 'COMPLETED';
  const confirmed = p.payout === 'done' || o.status === 'COMPLETED';
  const steps = [
    [received ? 'Order created' : 'Waiting for your transfer', received ? 'done' : 'now', received ? '' : 'We check for it every few seconds.'],
    ['Payment received', received ? 'done' : 'next', received && p.amount ? fmtNgn(p.amount) : ''],
    [`Sending ${esc(o.coin)} to your wallet`, sent ? 'done' : (received ? 'now' : 'next'), p.converted === 'pending' ? 'Converting…' : ''],
    [`${esc(o.coin)} confirmed on the network`, confirmed ? 'done' : (sent ? 'now' : 'next'),
      sent && p.explorer_url ? `<a href="${esc(p.explorer_url)}" target="_blank" rel="noopener">View on explorer</a>` : (p.payout_amount ? `${sent ? '' : 'About '}${fmtCoin(p.payout_amount, o.coin)} ${esc(o.coin)}` : '')],
  ];
  if (p.payout === 'failed' || p.payout === 'review') {
    steps[2] = ['We’re checking your order', 'warn', "Your money is safe. We'll email you shortly."];
  }
  return steps.map(([t, st, d]) => `<li class="is-${st}"><i>${st === 'done' ? ICON_CHECK : ''}</i><div><b>${t}</b>${d ? `<span>${d}</span>` : ''}</div></li>`).join('');
}

function wireCheckout() {
  const box = $('s-checkout');
  box.querySelectorAll('[data-act="back"]').forEach(b => b.onclick = () => (checkout.from === 'orders' ? showOrders() : showForm()));
  box.querySelectorAll('[data-act="new"]').forEach(b => b.onclick = showForm);
  box.querySelectorAll('[data-net]').forEach(b => b.onclick = () => {
    if ($('co-wallet')) checkout.wallet = $('co-wallet').value.trim();
    if ($('co-acct')) checkout.account = $('co-acct').value.replace(/\D/g, '').slice(0, 10);
    checkout.network = b.dataset.net;
    renderCheckout();
  });
  if ($('co-acct')) {
    $('co-acct').oninput = checkAccountName;
    $('co-acct').onpaste = () => setTimeout(checkAccountName, 50);
  }
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch (e) { toast(b.dataset.copy); }
  });
  box.querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(b.dataset.order));
  const paid = box.querySelector('[data-act="paid"]');
  if (paid) paid.onclick = () => {
    const o = checkout.order;
    o.claimed = Date.now();
    o.showDetails = false;
    try { localStorage.setItem(PAID_KEY(o.reference), String(o.claimed)); } catch (e) { /* ignore */ }
    renderCheckout();
    startPolling(3000);
  };
  box.querySelectorAll('[data-act="show-details"], [data-act="hide-details"]').forEach(b => b.onclick = () => {
    checkout.order.showDetails = b.dataset.act === 'show-details';
    renderCheckout();
  });
  const create = box.querySelector('[data-act="create"]');
  if (create) create.onclick = checkout.side === 'sell' ? createSell : createBuy;
}

async function createBuy() {
  const wallet = $('co-wallet').value.trim();
  const rule = WALLET_RULES[(checkout.nets.find(n => n.code === checkout.network) || {}).chain];
  const err = $('co-error');
  err.hidden = true;
  if (rule && !rule[0].test(wallet)) {
    err.textContent = `That doesn't look like ${rule[1]}.`;
    err.hidden = false;
    return;
  }
  if (checkout.provider === 'switch') {
    const chain = (checkout.nets.find(n => n.code === checkout.network) || {}).chain;
    const min = ['tron', 'ethereum'].includes(chain) ? 5 : 1;
    if (estimateFor(checkout.coin, checkout.amount) < min) {
      err.textContent = `The minimum on ${CHAIN_LABELS[chain] || chain} is ${min} ${checkout.coin}. Go back and enter a bigger amount.`;
      err.hidden = false;
      return;
    }
  }
  checkout.wallet = wallet;
  const btn = $('s-checkout').querySelector('[data-act="create"]');
  btn.disabled = true;
  btn.textContent = 'Creating your order…';

  const base = {
    side: 'buy',
    coin: checkout.coin,
    amount: checkout.amount,
    destAmount: estimateFor(checkout.coin, checkout.amount),
    network: netLabel(),
    wallet,
    status: 'AWAITING_DEPOSIT',
    progress: {}
  };

  try {
    if (checkout.provider === 'switch') {
      const d = await api('/api/initiate', {
        method: 'POST',
        body: { store: SLUG, direction: 'ONRAMP', amount: checkout.amount, country: 'NG', currency: 'NGN', channel: 'BANK', asset: checkout.network, wallet_address: wallet },
      });
      const dep = d.deposit || {};
      checkout.order = {
        ...base,
        reference: d.velcro_reference || d.reference,
        destAmount: Number(d.destination && d.destination.amount) || base.destAmount,
        bank: dep.bank_name || '',
        account: dep.account_number || '',
        accountName: dep.account_name || 'Velcro checkout',
        expiresAt: Date.now() + 3600 * 1000,
      };
    } else if (checkout.provider === 'paj') {
      const d = await api('/api/paj/initiate', { method: 'POST', body: { store: SLUG, fiatAmount: checkout.amount, recipient: wallet, mint: PAJ_MINTS[checkout.coin] } });
      const orderAmount = (Number(d.fiatAmount) > 0 && Math.abs(Number(d.fiatAmount) - checkout.amount) < 0.15)
        ? checkout.amount
        : (Number(d.fiatAmount) > 0 ? Number(d.fiatAmount) : checkout.amount);
      checkout.order = {
        ...base,
        reference: d.id,
        amount: orderAmount,
        destAmount: Number(d.cryptoAmount) || base.destAmount,
        bank: d.bank || 'Partner Bank',
        account: d.accountNumber || '',
        accountName: d.accountName || '',
        expiresAt: Date.now() + 3600 * 1000,
      };
    } else {
      const d = await api('/api/hostfi/buy', { method: 'POST', body: { store: SLUG, asset: checkout.coin, network: checkout.network, wallet, amount: checkout.amount } });
      checkout.order = {
        ...base,
        reference: d.reference,
        destAmount: Number(d.crypto_amount) || base.destAmount,
        bank: d.bank_name,
        account: d.account_number,
        accountName: d.account_name,
        expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
      };
    }
    checkout.step = 'pay';
    renderCheckout();
    startPolling();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Get payment details';
  }
}

function startPolling(every = 5000) {
  stopTimers();
  const o = checkout.order;
  if (!o.claimed) o.claimed = paidAt(o.reference);
  if (o.claimed) every = 3000;
  const tickExpiry = () => {
    const chk = $('co-checking');
    if (chk && o.claimed) {
      const s2 = Math.max(0, Math.floor((Date.now() - o.claimed) / 1000));
      chk.textContent = `Checking for ${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
    }
    if (!o.expiresAt || !WAITING_STATUSES.includes(o.status)) return;
    const left = Math.floor((o.expiresAt - Date.now()) / 1000);
    if (left < 0) {
      // Time's up: take the account or address off the screen.
      clearInterval(expiryTimer);
      if (checkout && checkout.order === o) renderCheckout();
      return;
    }
    const el = $('co-expiry');
    if (el) el.textContent = `This ${o.side === 'sell' ? 'address' : 'account'} is for this order only and expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  };
  tickExpiry();
  expiryTimer = setInterval(tickExpiry, 1000);
  const poll = async () => {
    try {
      const t = await api('/api/transactions/' + encodeURIComponent(o.reference));
      const was = o.status;
      o.status = String(t.status || '').toUpperCase();
      if (t.type) {
        const isOff = String(t.type).toUpperCase() === 'OFFRAMP';
        o.side = isOff ? 'sell' : 'buy';
        if (typeof checkout !== 'undefined' && checkout) checkout.side = o.side;
      }
      if (t.direction) {
        const isOff = String(t.direction).toUpperCase() === 'OFFRAMP';
        o.side = isOff ? 'sell' : 'buy';
        if (typeof checkout !== 'undefined' && checkout) checkout.side = o.side;
      }
      if (t.destination_amount) {
        o.destAmount = Number(t.destination_amount);
        if (o.side === 'sell') o.payoutAmount = Number(t.destination_amount);
      }
      if (t.source_amount && o.side === 'sell') {
        o.sendAmount = Number(t.source_amount);
      }
      o.progress = (t.hostfi_progress || [])[0] || {
        payout: o.status === 'COMPLETED' ? 'done' : (t.hash ? 'sent' : 'waiting'),
        explorer_url: t.explorer_url || null,
        payout_amount: Number(t.destination_amount) || o.payoutAmount || o.destAmount || null,
      };
      if (!WAITING_STATUSES.includes(o.status)) {
        clearInterval(expiryTimer);
        try { localStorage.removeItem(PAID_KEY(o.reference)); } catch (e) { /* ignore */ }
      }
      if (o.status === 'COMPLETED' || ENDED_STATUSES.includes(o.status)) clearInterval(pollTimer);
      // Paid or finished: redraw without the bank details.
      if (was !== o.status && (WAITING_STATUSES.includes(was) || o.status === 'COMPLETED' || ENDED_STATUSES.includes(o.status))) {
        if (checkout && checkout.order === o) renderCheckout();
        return;
      }
      const steps = $('co-steps');
      if (steps) steps.innerHTML = o.side === 'sell' ? sellProgressHtml(o) : progressHtml(o);
    } catch (e) { /* keep trying */ }
  };
  poll();
  pollTimer = setInterval(poll, every);
}

// ── My orders ──

async function showOrders() {
  const menu = $('s-menu');
  if (menu) menu.hidden = true;
  if (!me && token) await loadMe();
  if (!me) return openAuth('signin');
  try {
    const data = await api(`/api/store/${SLUG}/me`);
    store.orders = data.orders || [];
  } catch (e) {
    return toast(e.message);
  }
  stopTimers();
  checkout = { step: 'orders' };
  renderCheckout();
  if (window.innerWidth < 960) document.querySelector('.s-trade').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const STATUS_LABELS = { AWAITING_DEPOSIT: ['Awaiting payment', 'wait'], PENDING: ['Awaiting payment', 'wait'], INITIATED: ['Awaiting payment', 'wait'], DETECTED: ['Payment seen', 'busy'], RECEIVED: ['Payment received', 'busy'], VERIFIED: ['Payment received', 'busy'], CONFIRMED: ['Payment received', 'busy'], PROCESSING: ['Processing', 'busy'], COMPLETED: ['Completed', 'ok'], REVIEW: ['Being checked', 'warn'], CANCELLED: ['Cancelled', 'off'], EXPIRED: ['Expired', 'off'], FAILED: ['Failed', 'warn'] };

function ordersHtml() {
  const rows = store.orders || [];
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">My orders</h2>
    ${rows.length ? `<ul class="s-orders">${rows.map(o => {
      const buy = String(o.type).toUpperCase() === 'ONRAMP';
      const sym = orderCoin(o);
      const status = String(o.status).toUpperCase();
      const lapsed = WAITING_STATUSES.includes(status) && Number(o.expires_at) > 0 && Date.now() > Number(o.expires_at) * 1000;
      const [label, cls] = lapsed ? STATUS_LABELS.EXPIRED : (STATUS_LABELS[status] || [o.status, 'off']);
      // A buy is priced in naira; a sell in the coin the customer sends.
      const amount = buy ? fmtNgn(o.amount) : (Number(o.send_amount) > 0 ? `${fmtCoin(o.send_amount, sym)} ${esc(sym)}` : esc(sym));
      return `<li><button type="button" data-order="${esc(o.reference)}">${COIN_LOGOS[sym] ? `<img src="${COIN_LOGOS[sym]}" alt="">` : ''}<span class="s-orders-l"><b>${buy ? 'Buy' : 'Sell'} ${esc(sym)}</b><small>${fmtDate(o.created_at)}</small></span><span class="s-orders-r"><b>${amount}</b><em class="s-pill is-${cls}">${esc(label)}</em></span></button></li>`;
    }).join('')}</ul>` : '<p class="s-co-lede">No orders yet. Your buys and sells on this exchange will show up here.</p>'}`;
}

// The coin of an order, whichever side: "base:usdt", "USDT" or the currency columns.
function orderCoin(o) {
  const buy = String(o.type).toUpperCase() === 'ONRAMP';
  const fromAsset = String(o.asset || '').split(':').pop();
  return String((buy ? o.destination_currency : o.source_currency) || fromAsset || '').toUpperCase();
}

function openOrder(ref) {
  const o = (store.orders || []).find(x => x.reference === ref);
  if (!o) return;
  const sell = String(o.type).toUpperCase() === 'OFFRAMP';
  const channel = String(o.channel || '').toUpperCase();
  const chain = String(o.asset || '').includes(':') ? String(o.asset).split(':')[0] : '';
  checkout = {
    step: 'pay',
    from: 'orders',
    side: sell ? 'sell' : 'buy',
    coin: orderCoin(o),
    order: {
      reference: o.reference,
      side: sell ? 'sell' : 'buy',
      coin: orderCoin(o),
      amount: Number(o.amount),
      status: String(o.status).toUpperCase(),
      bank: o.deposit_bank_name,
      account: o.deposit_account_number,
      accountName: o.deposit_account_name,
      address: o.deposit_address,
      memo: String(o.deposit_note || '').replace(/^Memo:\s*/, '') || null,
      network: o.network || CHAIN_LABELS[chain] || (channel === 'PAJ' ? 'Solana' : ''),
      wallet: o.wallet_address || null,
      destAmount: o.destination_amount ? Number(o.destination_amount) : null,
      payoutAmount: sell && o.destination_amount ? Number(o.destination_amount) : (sell && o.amount ? payoutFor(orderCoin(o), Number(o.send_amount || o.amount)) : null),
      sendAmount: Number(o.send_amount) > 0 ? Number(o.send_amount) : null,
      payoutBank: o.payout_bank_name || null,
      payoutAccount: o.payout_account_number || null,
      payoutName: o.payout_account_name || null,
      hash: o.hash || null,
      rate: o.rate ? Number(o.rate) : null,
      createdAt: o.created_at || null,
      exact: channel !== 'HOSTFI',
      expiresAt: Number(o.expires_at) > 0 ? Number(o.expires_at) * 1000 : 0,
      progress: {},
    },
  };
  renderCheckout();
  startPolling();
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
  $('s-join').hidden = !!me;
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
  store.orders = [];
  showForm(); // nothing of theirs stays on screen
  paintAccount();
  toast('Signed out');
}

const AUTH_COPY = {
  signin: () => ['Sign in', `Sign in to ${store.info.name} to buy and sell.`, 'Sign in'],
  signup: () => ['Create your account', `Join ${store.info.name}. We'll email you a code to confirm it's you.`, 'Continue'],
  'signup-code': () => ['Check your email', `We sent a 6-digit code to ${$('a-email').value.trim()}. (Check your spam or junk folder if you don't see it.)`, 'Create account'],
  reset: () => ['Reset your password', "Enter your email and we'll send you a code.", 'Send code'],
  'reset-code': () => ['Set a new password', `We sent a 6-digit code to ${$('a-email').value.trim()}. (Check your spam or junk folder if you don't see it.)`, 'Update password'],
};

function openAuth(mode) {
  setAuthMode(mode);
  $('auth').hidden = false;
  setTimeout(() => $('a-email').focus(), 50);
}

function closeAuth() {
  pendingTrade = false;
  $('auth').hidden = true;
}

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
  const carryOn = pendingTrade;
  setToken(data.token);
  me = { email: data.email, name: data.name };
  closeAuth();
  $('a-pass').value = '';
  $('a-code').value = '';
  paintAccount();
  toast(`Signed in to ${store.info.name}`);
  if (carryOn) goTrade(); // they'd already tapped Buy or Sell
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

let deferredPwaPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const pwaPill = $('s-pwa-install');
  if (pwaPill) pwaPill.hidden = false;
});

async function installPwa() {
  if (!deferredPwaPrompt) return;
  deferredPwaPrompt.prompt();
  const choice = await deferredPwaPrompt.userChoice;
  deferredPwaPrompt = null;
  const pwaPill = $('s-pwa-install');
  if (pwaPill) pwaPill.hidden = true;
}

function setupPwa(s) {
  if (!s) return;
  try {
    const manifest = {
      name: `${s.name} Exchange`,
      short_name: s.name,
      start_url: window.location.href,
      scope: '/m/' + SLUG + '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: s.color || '#16a34a',
      description: s.welcome || `Buy & sell crypto with naira on ${s.name}`,
      icons: [
        { src: s.logo_url || '/apple-touch-icon.png', sizes: '192x192', type: 'image/png' },
        { src: s.logo_url || '/apple-touch-icon.png', sizes: '512x512', type: 'image/png' }
      ]
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    link.href = URL.createObjectURL(blob);
  } catch (e) { /* ignore */ }
}

function setupNetworkStatus() {
  const netEl = $('s-net-status');
  if (!netEl) return;
  window.addEventListener('offline', () => {
    netEl.textContent = '⚠️ Network connection lost. Reconnecting…';
    netEl.className = 's-net-banner is-offline';
    netEl.hidden = false;
  });
  window.addEventListener('online', () => {
    netEl.textContent = '✅ Connection restored';
    netEl.className = 's-net-banner is-online';
    refreshRates();
    setTimeout(() => { netEl.hidden = true; }, 3200);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('f-in').addEventListener('input', onAmountInput);
  $('f-out').addEventListener('input', onAmountOutInput);
  $('auth-form').addEventListener('submit', submitAuth);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#s-me')) { const m = $('s-menu'); if (m) m.hidden = true; }
    if (!e.target.closest('.s-select')) toggleCoins(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleCoins(false); });
  loadStore();
});
