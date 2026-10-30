// Merchant store page (/m/{slug}): the store's branding, live rates with the merchant's markup,
// and customer sign-in (per store: password or Google). Talks to /api/merchant/storefront/{slug}
// and /api/store/{slug}/*.

const SLUG = (location.pathname.match(/^\/m\/([a-z0-9-]{3,30})\/?$/) || [])[1] || '';
// The name from the link ("ada-crypto" → "Ada Crypto") shows while the store loads.
if (SLUG) {
  const pretty = SLUG.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  document.getElementById('s-loading-text').textContent = `Loading ${pretty}…`;
  document.title = pretty;
}
const TOKEN_KEY = 'velcro_store_' + SLUG;
const MERCHANT_TOKEN_KEY = 'velcro_merchant_token'; // lets a merchant preview their own store before approval
const COIN_LOGOS = { BTC: '/logos/bitcoin.png', ETH: '/logos/ethereum.png', SOL: '/logos/solana.png', USDT: '/logos/usdt.png', USDC: '/logos/usdc.png' };
const BUY_CHIPS = [10000, 50000, 100000, 500000];
const esc = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

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
  document.documentElement.style.setProperty('--on-brand', s.button_text || onBrand(s.color));
  document.documentElement.style.setProperty('--on-brand-auto', onBrand(s.color));
  document.body.classList.add('s-layout-' + (s.layout || 'classic'));
  if (s.welcome) document.querySelector('.s-lede').textContent = s.welcome;
  $('s-name').textContent = s.name;
  $('s-eyebrow').textContent = `${s.name} · live rates`;
  document.querySelector('.s-ngn-store').textContent = s.name;
  $('s-foot-name').textContent = s.name;
  $('s-home').href = '/m/' + SLUG;
  paintLogo($('s-logo'));
  paintLogo($('auth-logo'));
  paintBoard();
  if (s.support_url) {
    $('s-support').href = s.support_url;
    $('s-support').querySelector('span').textContent = `Need help? Chat with ${s.name}`;
    $('s-support').hidden = false;
    $('s-nav-help').href = s.support_url;
    $('s-nav-help').hidden = false;
  }
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

// Today's rates: per $1, what the store sells at (customers buy) and buys at (customers sell).
// Today's rates as one row of pills for the side the customer is on; a pill picks that coin.
function paintBoard() {
  const side = store.side || 'buy';
  $('s-rates-side').textContent = side === 'buy' ? 'to buy, per $1' : 'to sell, per $1';
  $('s-board-rows').innerHTML = Object.values(store.coins).filter(c => c[side + '_on'] && c[side + '_rate']).map(c =>
    `<button type="button" class="s-rate-pill" data-sym="${c.symbol}" aria-label="${side === 'buy' ? 'Buy' : 'Sell'} ${esc(c.symbol)} at ${fmtNgn(c[side + '_rate'])} per dollar"><img src="${COIN_LOGOS[c.symbol]}" alt=""><b>${esc(c.symbol)}</b><span>${fmtNgn(c[side + '_rate'])}</span></button>`
  ).join('') || '<p class="s-rates-empty">No rates right now.</p>';
  document.querySelectorAll('#s-board-rows .s-rate-pill').forEach(b => b.addEventListener('click', () => pickFromBoard(b.dataset.sym, side)));
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
  setTimeout(() => $('f-in').focus({ preventScroll: true }), 300);
}

function markBoard() {
  document.querySelectorAll('#s-board-rows .s-rate-pill').forEach(b => b.classList.toggle('is-on', b.dataset.sym === store.coin));
}

function setSide(side) {
  store.side = side;
  $('t-buy').setAttribute('aria-selected', String(side === 'buy'));
  $('t-sell').setAttribute('aria-selected', String(side === 'sell'));
  const available = Object.values(store.coins).filter(c => c[side + '_on']);
  if (!available.some(c => c.symbol === store.coin)) store.coin = available[0] ? available[0].symbol : null;
  // Steps and details read differently for buying and selling.
  const buying = side === 'buy';
  $('how-2-title').textContent = buying ? 'Pay by bank transfer' : 'Send your crypto';
  $('how-2-text').textContent = buying ? 'You get an account number for your order. Transfer from any Nigerian bank.' : 'You get a deposit address for your order. Send from any wallet or exchange.';
  $('how-3-title').textContent = buying ? 'Receive your crypto' : 'Get paid in naira';
  $('how-3-text').textContent = buying ? "It's sent to your wallet automatically. Follow every step and get a receipt by email." : 'Naira goes to your bank account automatically. Follow every step and get a receipt by email.';
  $('s-dest-label').textContent = buying ? 'Delivered to' : 'Paid to';
  $('s-dest').textContent = buying ? 'Your wallet' : 'Your bank account';
  $('s-chips').innerHTML = buying ? BUY_CHIPS.map(v => `<button type="button" data-v="${v}">₦${v >= 1000 ? (v / 1000) + 'k' : v}</button>`).join('') : '';
  document.querySelectorAll('#s-chips button').forEach(b => b.addEventListener('click', () => { $('f-in').value = Number(b.dataset.v).toLocaleString('en-NG'); render(); }));
  $('f-in').value = '';
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
    return `<li><button type="button" role="option" aria-selected="${x.symbol === store.coin}" data-sym="${x.symbol}"><img src="${COIN_LOGOS[x.symbol]}" alt=""><span><b>${esc(x.symbol)}</b><small>${esc(x.name)}</small></span><em>${rate ? '$1 = ' + fmtNgn(rate) : ''}</em></button></li>`;
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

function render() {
  const c = store.coins[store.coin];
  const buying = store.side === 'buy';
  paintBoard();
  $('f-out').classList.toggle('is-empty', !(Number(String($('f-in').value).replace(/,/g, '')) > 0));
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
  const rate = buying ? c.buy_rate : c.sell_rate;
  if (!rate || !c.usd_price) {
    $('s-coin-name').textContent = 'Rate unavailable right now';
    $('f-out').textContent = '0';
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
  $('s-time').textContent = buying ? (c.symbol === 'BTC' ? '10–60 minutes' : 'A few minutes') : (c.symbol === 'BTC' ? '20–60 minutes' : 'A few minutes');
  const amount = Number(String($('f-in').value).replace(/,/g, '')) || 0;
  if (buying) {
    // naira → $ at the store's rate → coin at its $ price
    $('f-out').textContent = amount > 0 ? fmtCoin(amount / rate / c.usd_price, c.symbol) : '0';
  } else {
    $('f-out').textContent = amount > 0 ? fmtNgn(amount * c.usd_price * rate).replace('₦', '') : '0';
  }
}

async function goTrade() {
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
  const c = store.coins[store.coin];
  // Checkout is live for HostFi coins first; the others follow.
  if (store.side !== 'buy' || c.provider !== 'hostfi') {
    toast(`${store.side === 'buy' ? 'Buying' : 'Selling'} ${c.symbol} on ${store.info.name} opens very soon.`);
    return;
  }
  const nets = await hostfiNetworks(c.symbol);
  if (!nets.length) {
    toast(`Buying ${c.symbol} isn't available right now. Try again shortly.`);
    return;
  }
  checkout = { step: 'details', coin: c.symbol, amount, nets, network: nets[0].code, wallet: '', order: null };
  renderCheckout();
}

// ── Checkout (buy) ──

// Networks come from HostFi's own list, so the code we send is exactly the one it expects.
const CHAIN_LABELS = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', base: 'Base', bsc: 'BNB Chain', solana: 'Solana', polygon: 'Polygon', arbitrum: 'Arbitrum', optimism: 'Optimism' };
const EVM_RULE = [/^0x[a-fA-F0-9]{40}$/, 'an address that starts with 0x'];
const WALLET_RULES = {
  bitcoin: [/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, 'a Bitcoin address (starts with bc1, 1 or 3)'],
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a Solana address'],
  ethereum: EVM_RULE, base: EVM_RULE, bsc: EVM_RULE, polygon: EVM_RULE, arbitrum: EVM_RULE, optimism: EVM_RULE,
};
let buyAssets = null;

async function hostfiNetworks(symbol) {
  if (!buyAssets) {
    try { buyAssets = await api('/api/hostfi/buy-assets'); } catch (e) { return []; }
  }
  const a = (buyAssets || []).find(x => x.symbol === symbol);
  return a ? a.networks.map(n => ({ code: n.code, chain: n.chain, label: CHAIN_LABELS[n.chain] || n.code })) : [];
}
let checkout = null;
let pollTimer = null;
let expiryTimer = null;
const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';

function showForm() {
  clearInterval(pollTimer);
  clearInterval(expiryTimer);
  checkout = null;
  $('s-checkout').hidden = true;
  $('s-form').hidden = false;
}

function renderCheckout() {
  $('s-form').hidden = true;
  const box = $('s-checkout');
  box.hidden = false;
  if (checkout.step === 'details') box.innerHTML = checkoutDetailsHtml();
  else if (checkout.step === 'pay') box.innerHTML = checkoutPayHtml();
  else if (checkout.step === 'orders') box.innerHTML = ordersHtml();
  wireCheckout();
  if (checkout.step === 'details') setTimeout(() => $('co-wallet') && $('co-wallet').focus(), 50);
}

function estimateFor(symbol, ngn) {
  const c = store.coins[symbol];
  return c && c.buy_rate && c.usd_price ? ngn / c.buy_rate / c.usd_price : 0;
}

function checkoutDetailsHtml() {
  const c = store.coins[checkout.coin];
  const nets = checkout.nets;
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">Buy ${esc(c.symbol)}</h2>
    <div class="s-co-sum">
      <div><span>You pay</span><b>${fmtNgn(checkout.amount)}</b></div>
      <div><span>You get about</span><b>${estimateFor(c.symbol, checkout.amount) > 0 ? `${fmtCoin(estimateFor(c.symbol, checkout.amount), c.symbol)} ${esc(c.symbol)}` : 'Shown next'}</b></div>
    </div>
    ${nets.length > 1 ? `<span class="s-label">Network</span><div class="s-seg">${nets.map(n => `<button type="button" data-net="${n.code}" aria-pressed="${n.code === checkout.network}">${esc(n.label)}</button>`).join('')}</div>` : ''}
    <label class="s-label" for="co-wallet">Your ${esc(c.symbol)} wallet address${nets.length === 1 ? '' : ` on ${esc((nets.find(n => n.code === checkout.network) || {}).label || '')}`}</label>
    <input id="co-wallet" class="s-input s-mono" autocomplete="off" spellcheck="false" placeholder="Paste your address" value="${esc(checkout.wallet)}">
    <p class="s-hint">Double-check it. Crypto sent to the wrong address can't be recovered.</p>
    <p id="co-error" class="s-error" hidden></p>
    <button type="button" class="s-btn-brand s-go" data-act="create">Get payment details</button>
    <p class="s-trust">The network fee is taken from the ${esc(c.symbol)} you receive. Your final amount is shown on the next step.</p>`;
}

function checkoutPayHtml() {
  const o = checkout.order;
  const done = o.status === 'COMPLETED';
  const waiting = o.status === 'AWAITING_DEPOSIT';
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}${done ? 'New order' : 'Back'}</button>
    <h2 class="s-co-title">${done ? `${esc(o.coin)} sent` : waiting ? `Transfer ${fmtNgn(o.amount)}` : `Buying ${esc(o.coin)}`}</h2>
    ${!waiting ? '' : `
    <p class="s-co-lede">Send exactly this amount from any Nigerian bank to the account below. We'll detect it automatically.</p>
    <div class="s-bank">
      <div><span>Bank</span><b>${esc(o.bank)}</b></div>
      <div><span>Account number</span><b class="s-mono">${esc(o.account)}</b><button type="button" class="s-copy" data-copy="${esc(o.account)}">${ICON_COPY}Copy</button></div>
      <div><span>Account name</span><b>${esc(o.accountName)}</b></div>
      <div><span>Amount</span><b>${fmtNgn(o.amount)}</b><button type="button" class="s-copy" data-copy="${esc(String(o.amount))}">${ICON_COPY}Copy</button></div>
    </div>
    <p class="s-expiry" id="co-expiry"></p>`}
    <ol class="s-progress" id="co-steps">${progressHtml(o)}</ol>
    <p class="s-trust">Order ${esc(o.reference)} · you'll get a receipt at ${esc(me.email)}.</p>`;
}

// Steps from the order's live status: waiting → received → converting/sending → sent → confirmed.
function progressHtml(o) {
  const p = o.progress || {};
  const received = ['CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(o.status) || !!p.amount;
  const sent = p.payout === 'sent' || p.payout === 'done' || o.status === 'COMPLETED';
  const confirmed = p.payout === 'done' || o.status === 'COMPLETED';
  const steps = [
    [received ? 'Order created' : 'Waiting for your transfer', received ? 'done' : 'now', received ? '' : 'We check for it every few seconds.'],
    ['Payment received', received ? 'done' : 'next', received && p.amount ? fmtNgn(p.amount) : ''],
    [`Sending ${esc(o.coin)} to your wallet`, sent ? 'done' : (received ? 'now' : 'next'), p.converted === 'pending' ? 'Converting…' : ''],
    [`${esc(o.coin)} confirmed on the network`, confirmed ? 'done' : (sent ? 'now' : 'next'),
      sent && p.explorer_url ? `<a href="${esc(p.explorer_url)}" target="_blank" rel="noopener">View on explorer</a>` : (p.payout_amount ? `${fmtCoin(p.payout_amount, o.coin)} ${esc(o.coin)}` : '')],
  ];
  if (p.payout === 'failed' || p.payout === 'review') {
    steps[2] = ['We’re checking your order', 'warn', "Your money is safe. We'll email you shortly."];
  }
  return steps.map(([t, st, d]) => `<li class="is-${st}"><i>${st === 'done' ? ICON_CHECK : ''}</i><div><b>${t}</b>${d ? `<span>${d}</span>` : ''}</div></li>`).join('');
}

function wireCheckout() {
  const box = $('s-checkout');
  box.querySelectorAll('[data-act="back"]').forEach(b => b.onclick = () => (checkout.step === 'pay' || checkout.step === 'orders') ? showForm() : showForm());
  box.querySelectorAll('[data-net]').forEach(b => b.onclick = () => { checkout.wallet = $('co-wallet').value.trim(); checkout.network = b.dataset.net; renderCheckout(); });
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch (e) { toast(b.dataset.copy); }
  });
  box.querySelectorAll('[data-order]').forEach(b => b.onclick = () => openOrder(b.dataset.order));
  const create = box.querySelector('[data-act="create"]');
  if (create) create.onclick = createBuy;
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
  checkout.wallet = wallet;
  const btn = $('s-checkout').querySelector('[data-act="create"]');
  btn.disabled = true;
  btn.textContent = 'Creating your order…';
  try {
    const d = await api('/api/hostfi/buy', { method: 'POST', body: { store: SLUG, asset: checkout.coin, network: checkout.network, wallet, amount: checkout.amount } });
    checkout.order = {
      reference: d.reference, coin: checkout.coin, amount: checkout.amount, status: 'AWAITING_DEPOSIT',
      bank: d.bank_name, account: d.account_number, accountName: d.account_name, expiresAt: Date.now() + (d.expires_in || 3600) * 1000, progress: {},
    };
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

function startPolling() {
  clearInterval(pollTimer);
  clearInterval(expiryTimer);
  const o = checkout.order;
  const tickExpiry = () => {
    const el = $('co-expiry');
    if (!el || !o.expiresAt) return;
    const left = Math.max(0, Math.floor((o.expiresAt - Date.now()) / 1000));
    el.textContent = left > 0 ? `This account is for this order only and expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'This account has expired. Start a new order if you haven’t paid.';
  };
  tickExpiry();
  expiryTimer = setInterval(tickExpiry, 1000);
  const poll = async () => {
    try {
      const t = await api('/api/transactions/' + encodeURIComponent(o.reference));
      const was = o.status;
      o.status = String(t.status || '').toUpperCase();
      o.progress = (t.hostfi_progress || [])[0] || {};
      if (o.status !== 'AWAITING_DEPOSIT') clearInterval(expiryTimer);
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(o.status)) clearInterval(pollTimer);
      // Paid (or finished): redraw without the bank details.
      if (was !== o.status && (was === 'AWAITING_DEPOSIT' || o.status === 'COMPLETED')) {
        if (checkout && checkout.order === o) renderCheckout();
        return;
      }
      const steps = $('co-steps');
      if (steps) steps.innerHTML = progressHtml(o);
    } catch (e) { /* keep trying */ }
  };
  poll();
  pollTimer = setInterval(poll, 5000);
}

// ── My orders ──

async function showOrders() {
  $('s-menu').hidden = true;
  if (!me) return openAuth('signin');
  try {
    const data = await api(`/api/store/${SLUG}/me`);
    store.orders = data.orders || [];
  } catch (e) {
    return toast(e.message);
  }
  clearInterval(pollTimer);
  clearInterval(expiryTimer);
  checkout = { step: 'orders' };
  renderCheckout();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const STATUS_LABELS = { AWAITING_DEPOSIT: ['Awaiting payment', 'wait'], CONFIRMED: ['Payment received', 'busy'], PROCESSING: ['Processing', 'busy'], COMPLETED: ['Completed', 'ok'], REVIEW: ['Being checked', 'warn'], CANCELLED: ['Cancelled', 'off'], EXPIRED: ['Expired', 'off'], FAILED: ['Failed', 'warn'] };

function ordersHtml() {
  const rows = store.orders || [];
  return `
    <button type="button" class="s-back" data-act="back">${ICON_BACK}Back</button>
    <h2 class="s-co-title">My orders</h2>
    ${rows.length ? `<ul class="s-orders">${rows.map(o => {
      const sym = String(o.destination_currency || (o.asset || '').split(':')[1] || '').toUpperCase();
      const [label, cls] = STATUS_LABELS[String(o.status).toUpperCase()] || [o.status, 'off'];
      const buy = String(o.type).toUpperCase() === 'ONRAMP';
      return `<li><button type="button" data-order="${esc(o.reference)}"><span><b>${buy ? 'Buy' : 'Sell'} ${esc(sym)}</b><small>${new Date(String(o.created_at).replace(' ', 'T') + 'Z').toLocaleString()}</small></span><span class="s-orders-right"><b>${fmtNgn(o.amount)}</b><em class="s-pill is-${cls}">${esc(label)}</em></span></button></li>`;
    }).join('')}</ul>` : '<p class="s-co-lede">No orders yet. Your buys and sells on this store will show up here.</p>'}`;
}

function openOrder(ref) {
  const o = (store.orders || []).find(x => x.reference === ref);
  if (!o) return;
  const sym = String(o.destination_currency || (o.asset || '').split(':')[1] || '').toUpperCase();
  checkout = {
    step: 'pay',
    order: { reference: o.reference, coin: sym, amount: Number(o.amount), status: String(o.status).toUpperCase(), bank: o.deposit_bank_name, account: o.deposit_account_number, accountName: o.deposit_account_name, expiresAt: 0, progress: {} },
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
  document.addEventListener('click', e => {
    if (!e.target.closest('#s-me')) { const m = $('s-menu'); if (m) m.hidden = true; }
    if (!e.target.closest('.s-select')) toggleCoins(false);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleCoins(false); });
  loadStore();
});
