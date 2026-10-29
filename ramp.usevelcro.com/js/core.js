// Velcro Convert — Shared state, theme, number formatting, asset/chain logos and asset lists.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

// Dark mode toggle
function toggleDarkMode() {
  const html = document.documentElement;
  const isDark = html.classList.toggle('dark');
  localStorage.setItem('velcro-theme', isDark ? 'dark' : 'light');
  updateDarkModeIcon();
}
function updateDarkModeIcon() {
  const btn = document.getElementById('dark-mode-toggle');
  if (!btn) return;
  const isDark = document.documentElement.classList.contains('dark');
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.innerHTML = isDark
    ? '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
}
document.addEventListener('DOMContentLoaded', updateDarkModeIcon);

var API_BASE = '';
var currentCountry = 'NG';
var currentCurrency = 'NGN';
var currentRate = { sell: 0, buy: 0, sellDirect: 0, buyDirect: 0, paj: 0, pajOfframp: 0, pajOnramp: 0 };
var currentSwitchAsset = '';
var currentSellAsset = '';
var currentBuyAsset = '';
var currentProvider = 'switch'; // provider of the visible tab: 'switch', 'paj' or 'hostfi'
// Buy and sell each remember their own provider, so loading or using one tab never changes the other.
var sellProvider = 'switch';
var buyProvider = 'switch';
var currentSellNetwork = '';
var currentBuyNetwork = '';
var currentBankCode = '';
var currentBankSwitchCode = '';
var currentBankPajId = '';
var countryRequirements = {};
var currentReference = '';
var statusPollInterval = null;
var activePollReference = null;
var activePollType = null; // 'standard' or 'paj'
var activePollTxType = 'buy'; // 'buy' or 'sell'
var pollCount = 0;
var isPollingPaused = false;
var currentTxDetails = {}; // Stores details for success modal
let BUY_MAX_LIMIT = 1000000; // Maximum buy amount per transaction (fetched from /api/settings)
let SELL_MIN_LIMIT = 1; // Minimum sell amount per transaction (fetched from /api/settings)
let SELL_MAX_LIMIT = 10000; // Maximum sell amount per transaction (fetched from /api/settings)
let currentFee = 0.5; // Platform fee percentage (fetched from /api/settings)
let currentPajFee = 0.5; // PAJ fee percentage (fetched from /api/settings or /api/paj/rate)
let currentPajMargin = 0.0; // PAJ rate margin
let pajUsdtEnabled = false;
let pajUsdcEnabled = false;
let switchBanks = [];
let pajBanks = [];
var rateFetchedAt = null;
var rateExpiryInterval = null;
const RATE_EXPIRY_SECONDS = 300; // 5 minutes
var currentSellInputMode = 'USD'; // 'USD' or 'ASSET'
let switchAssetsData = null; // Dynamically fetched from Switch API
// HostFi sells: coins switched on in admin, keyed by symbol (networks, naira and USD price per coin).
let hostfiAssets = {};
let hostfiFee = 0.5;
let sellTimerMinutes = { default: 60 };
let currentSellChain = ''; // chain slug of the selected HostFi network (bitcoin, ethereum, tron…)
let currentBankName = '';

function safeLucideInit() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
}

function getChainLogo(chain) {
  const known = {
    solana: '/logos/solana.png', ethereum: '/logos/ethereum.png', bsc: '/logos/bsc.png',
    polygon: '/logos/polygon.png', arbitrum: '/logos/arbitrum.png', base: '/logos/base.png',
    tron: '/logos/tron.png', optimism: '/logos/optimism.png', avalanche: '/logos/avalanche.png',
    gnosis: '/logos/gnosis.png', monad: '/logos/monad.png', plasma: '/logos/plasma.png',
    celo: '/logos/celo.png', sonic: '/logos/sonic.png', linea: '/logos/linea.png',
    mantle: '/logos/mantle.png', hyperevm: '/logos/hyperevm.png', berachain: '/logos/berachain.png',
    bitcoin: '/logos/bitcoin.png', sui: '/logos/sui.png'
  };
  if (known[chain]) return known[chain];
  const initial = chain.charAt(0).toUpperCase();
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='12' fill='%23A8CF45'/%3E%3Ctext x='12' y='16' text-anchor='middle' fill='white' font-size='12' font-weight='bold' font-family='sans-serif'%3E${initial}%3C/text%3E%3C/svg%3E`;
}

function getAssetLogo(symbol) {
  const known = {
    USDT: '/logos/usdt.png', USDC: '/logos/usdc.png', CNGN: '/logos/cngn.png?v=2',
    BTC: '/logos/bitcoin.png', ETH: '/logos/ethereum.png',
    SOL: '/logos/solana.png', JUP: '/logos/jup.png',
    BONK: 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg',
    WIF: 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg',
    PYTH: 'https://assets.coingecko.com/coins/images/31924/small/pyth.png',
    USDG: '/logos/usdg.png'
  };
  if (known[symbol]) return known[symbol];
  const initial = symbol.charAt(0).toUpperCase();
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='12' fill='%23007BFF'/%3E%3Ctext x='12' y='16' text-anchor='middle' fill='white' font-size='11' font-weight='bold' font-family='sans-serif'%3E${initial}%3C/text%3E%3C/svg%3E`;
}

const ASSET_PRIORITY = ['USDT', 'USDC'];
const CHAIN_PRIORITY = ['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'tron', 'polygon'];

function sortAssets(symbols) {
  return symbols.slice().sort((a, b) => {
    const aIdx = ASSET_PRIORITY.indexOf(a);
    const bIdx = ASSET_PRIORITY.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });
}

function sortChains(chains) {
  return chains.slice().sort((a, b) => {
    const aIdx = CHAIN_PRIORITY.indexOf(a);
    const bIdx = CHAIN_PRIORITY.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });
}

function fmtNum(str, decimals) {
  if (!str && str !== 0) return '';
  let clean = String(str).replace(/[^0-9.]/g, '');
  if (clean === '' || clean === '.') return '';
  const parts = clean.split('.');
  if (parts.length > 2) clean = parts[0] + '.' + parts.slice(1).join('');
  const [intPart, decPart] = clean.split('.');
  let result = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decPart !== undefined && decimals > 0) {
    result += '.' + decPart.slice(0, decimals);
  }
  return result;
}

function handleAmountInput(el, decimals) {
  const oldVal = el.value;
  const cursor = el.selectionStart;
  const beforeCursor = oldVal.slice(0, cursor);
  const digitsBeforeCursor = beforeCursor.replace(/[^0-9]/g, '').length;
  const newVal = fmtNum(oldVal, decimals);
  if (newVal !== oldVal) {
    el.value = newVal;
    let newCursor = 0;
    let digitCount = 0;
    for (let i = 0; i < newVal.length; i++) {
      if (/\d/.test(newVal[i])) digitCount++;
      if (digitCount >= digitsBeforeCursor) {
        newCursor = i + 1;
        break;
      }
    }
    el.setSelectionRange(newCursor, newCursor);
  }
}

function getNum(id) {
  const val = document.getElementById(id)?.value || '';
  return parseFloat(val.replace(/,/g, '')) || 0;
}

function setFmt(id, num, decimals) {
  const el = document.getElementById(id);
  if (!el) return;
  if (num === '' || num === null || num === undefined || Number.isNaN(num)) {
    el.value = '';
    return;
  }
  el.value = fmtNum(num.toFixed(decimals), decimals);
}

async function loadSwitchAssets() {
  try {
    const res = await fetch(`${API_BASE}/api/assets`);
    if (res.ok) {
      const json = await res.json();
      if (json.success) {
        switchAssetsData = json.data;
      }
    }
  } catch (e) {
    console.error('Failed to load Switch assets:', e);
  } finally {
    // Always render lists, even if Switch data is missing (Paj assets are static/internal)
    renderSellAssetList();
    renderBuyAssetList();
    setDefaults();
  }
}

// History rows are rendered via innerHTML and inline onclick='...'. Anyone can create an order
// under any email, so strip characters that could break out of HTML/JS before rendering.
function scrub(v) {
  if (typeof v === 'string') return v.replace(/[<>"'`\\]/g, '');
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k in v) out[k] = scrub(v[k]);
    return out;
  }
  return v;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderSellAssetList() {
  const container = document.getElementById('sell-asset-list');
  if (!container) return;
  
  // Coins HostFi has taken over are shown once, as HostFi items, and dropped from Switch/PAJ.
  const viaHostfi = sym => Object.prototype.hasOwnProperty.call(hostfiAssets, sym);
  const hostfiItems = ['USDT', 'USDC', 'BTC', 'ETH', 'SOL'].filter(viaHostfi).map(sym => {
    const a = hostfiAssets[sym];
    const logo = getAssetLogo(sym);
    const safeName = escapeHtml(a.name && a.name !== sym ? a.name : ({ BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', USDT: 'Tether USD', USDC: 'USD Coin' }[sym] || sym));
    return `<div class="asset-picker-item" data-symbol="${sym}" data-name="${safeName}" onclick="selectSellAsset('${sym}', '${logo}', '${safeName}', 'hostfi')">
          <img src="${logo}" class="asset-picker-logo" alt="${sym}">
          <div class="asset-picker-info">
            <div class="asset-picker-symbol">${sym}</div>
            <div class="asset-picker-name">${safeName}</div>
          </div>
        </div>`;
  }).join('');

  let switchItems = '';
  if (switchAssetsData) {
    const assets = switchAssetsData.offramp || {};
    const symbols = sortAssets(Object.keys(assets)).filter(sym => !viaHostfi(sym));
    switchItems = symbols.map(sym => {
      const asset = assets[sym];
      const logo = getAssetLogo(sym);
      const safeSym = escapeHtml(sym);
      const safeName = escapeHtml(asset.name || sym);
      return `<div class="asset-picker-item" data-symbol="${safeSym}" data-name="${safeName}" onclick="selectSellAsset('${safeSym}', '${logo}', '${safeName}', 'switch')">\n          <img src="${logo}" class="asset-picker-logo" alt="${safeSym}">\n          <div class="asset-picker-info">\n            <div class="asset-picker-symbol">${safeSym}</div>\n            <div class="asset-picker-name">${safeName}</div>\n          </div>\n        </div>`;
    }).join('');
  }

  // Append PAJ assets
  const pajItems = `
    <div class="asset-picker-divider">SOLANA</div>
    ${!viaHostfi('SOL') ? `<div class="asset-picker-item" data-symbol="SOL" data-name="Solana" onclick="selectSellAsset('SOL', '/logos/solana.png', 'Solana', 'paj')">
      <img src="/logos/solana.png" class="asset-picker-logo" alt="SOL">
      <div class="asset-picker-info"><div class="asset-picker-symbol">SOL</div><div class="asset-picker-name">Solana</div></div>
    </div>` : ''}
    <div class="asset-picker-item" data-symbol="USDG" data-name="Global Dollar" onclick="selectSellAsset('USDG', '/logos/usdg.png', 'Global Dollar', 'paj')">
      <img src="/logos/usdg.png" class="asset-picker-logo" alt="USDG">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDG</div><div class="asset-picker-name">Global Dollar</div></div>
    </div>
    ${pajUsdtEnabled && !viaHostfi('USDT') ? `<div class="asset-picker-item" data-symbol="USDT" data-name="Tether USD" onclick="selectSellAsset('USDT', '/logos/usdt.png', 'Tether USD', 'paj')">
      <img src="/logos/usdt.png" class="asset-picker-logo" alt="USDT">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDT</div><div class="asset-picker-name">Tether USD</div></div>
    </div>` : ''}
    ${pajUsdcEnabled && !viaHostfi('USDC') ? `<div class="asset-picker-item" data-symbol="USDC" data-name="USD Coin" onclick="selectSellAsset('USDC', '/logos/usdc.png', 'USD Coin', 'paj')">
      <img src="/logos/usdc.png" class="asset-picker-logo" alt="USDC">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDC</div><div class="asset-picker-name">USD Coin</div></div>
    </div>` : ''}
    <div class="asset-picker-item" data-symbol="JUP" data-name="Jupiter" onclick="selectSellAsset('JUP', '/logos/jup.png', 'Jupiter', 'paj')">
      <img src="/logos/jup.png" class="asset-picker-logo" alt="JUP">
      <div class="asset-picker-info"><div class="asset-picker-symbol">JUP</div><div class="asset-picker-name">Jupiter</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="BONK" data-name="Bonk" onclick="selectSellAsset('BONK', 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg', 'Bonk', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/28600/small/bonk.jpg" class="asset-picker-logo" alt="BONK">
      <div class="asset-picker-info"><div class="asset-picker-symbol">BONK</div><div class="asset-picker-name">Bonk</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="WIF" data-name="dogwifhat" onclick="selectSellAsset('WIF', 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg', 'dogwifhat', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg" class="asset-picker-logo" alt="WIF">
      <div class="asset-picker-info"><div class="asset-picker-symbol">WIF</div><div class="asset-picker-name">dogwifhat</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="PYTH" data-name="Pyth Network" onclick="selectSellAsset('PYTH', 'https://assets.coingecko.com/coins/images/31924/small/pyth.png', 'Pyth Network', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/31924/small/pyth.png" class="asset-picker-logo" alt="PYTH">
      <div class="asset-picker-info"><div class="asset-picker-symbol">PYTH</div><div class="asset-picker-name">Pyth Network</div></div>
    </div>
  `;
  container.innerHTML = hostfiItems + switchItems + pajItems;
}

function renderBuyAssetList() {
  const container = document.getElementById('buy-asset-list');
  if (!container) return;

  let switchItems = '';
  if (switchAssetsData) {
    const assets = switchAssetsData.onramp || {};
    const symbols = sortAssets(Object.keys(assets));
    switchItems = symbols.map(sym => {
      const asset = assets[sym];
      const logo = getAssetLogo(sym);
      const safeSym = escapeHtml(sym);
      const safeName = escapeHtml(asset.name || sym);
      return `<div class="asset-picker-item" data-symbol="${safeSym}" data-name="${safeName}" onclick="selectBuyAsset('${safeSym}', '${logo}', '${safeName}', 'switch')">\n          <img src="${logo}" class="asset-picker-logo" alt="${safeSym}">\n          <div class="asset-picker-info">\n            <div class="asset-picker-symbol">${safeSym}</div>\n            <div class="asset-picker-name">${safeName}</div>\n          </div>\n        </div>`;
    }).join('');
  }
  // Append static PAJ assets
  const pajItems = `
    <div class="asset-picker-divider">SOLANA</div>
    <div class="asset-picker-item" data-symbol="SOL" data-name="Solana" onclick="selectBuyAsset('SOL', '/logos/solana.png', 'Solana', 'paj')">
      <img src="/logos/solana.png" class="asset-picker-logo" alt="SOL">
      <div class="asset-picker-info"><div class="asset-picker-symbol">SOL</div><div class="asset-picker-name">Solana</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="USDG" data-name="Global Dollar" onclick="selectBuyAsset('USDG', '/logos/usdg.png', 'Global Dollar', 'paj')">
      <img src="/logos/usdg.png" class="asset-picker-logo" alt="USDG">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDG</div><div class="asset-picker-name">Global Dollar</div></div>
    </div>
    ${pajUsdtEnabled ? `<div class="asset-picker-item" data-symbol="USDT" data-name="Tether USD" onclick="selectBuyAsset('USDT', '/logos/usdt.png', 'Tether USD', 'paj')">
      <img src="/logos/usdt.png" class="asset-picker-logo" alt="USDT">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDT</div><div class="asset-picker-name">Tether USD</div></div>
    </div>` : ''}
    ${pajUsdcEnabled ? `<div class="asset-picker-item" data-symbol="USDC" data-name="USD Coin" onclick="selectBuyAsset('USDC', '/logos/usdc.png', 'USD Coin', 'paj')">
      <img src="/logos/usdc.png" class="asset-picker-logo" alt="USDC">
      <div class="asset-picker-info"><div class="asset-picker-symbol">USDC</div><div class="asset-picker-name">USD Coin</div></div>
    </div>` : ''}
    <div class="asset-picker-item" data-symbol="JUP" data-name="Jupiter" onclick="selectBuyAsset('JUP', '/logos/jup.png', 'Jupiter', 'paj')">
      <img src="/logos/jup.png" class="asset-picker-logo" alt="JUP">
      <div class="asset-picker-info"><div class="asset-picker-symbol">JUP</div><div class="asset-picker-name">Jupiter</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="BONK" data-name="Bonk" onclick="selectBuyAsset('BONK', 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg', 'Bonk', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/28600/small/bonk.jpg" class="asset-picker-logo" alt="BONK">
      <div class="asset-picker-info"><div class="asset-picker-symbol">BONK</div><div class="asset-picker-name">Bonk</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="WIF" data-name="dogwifhat" onclick="selectBuyAsset('WIF', 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg', 'dogwifhat', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg" class="asset-picker-logo" alt="WIF">
      <div class="asset-picker-info"><div class="asset-picker-symbol">WIF</div><div class="asset-picker-name">dogwifhat</div></div>
    </div>
    <div class="asset-picker-item" data-symbol="PYTH" data-name="Pyth Network" onclick="selectBuyAsset('PYTH', 'https://assets.coingecko.com/coins/images/31924/small/pyth.png', 'Pyth Network', 'paj')">
      <img src="https://assets.coingecko.com/coins/images/31924/small/pyth.png" class="asset-picker-logo" alt="PYTH">
      <div class="asset-picker-info"><div class="asset-picker-symbol">PYTH</div><div class="asset-picker-name">Pyth Network</div></div>
    </div>
  `;
  container.innerHTML = switchItems + pajItems;
}

function renderSellNetworks(symbol) {
  if (!symbol) return;
  const container = document.getElementById('sell-network-options');
  if (!container) return;
  const asset = (switchAssetsData && switchAssetsData.offramp) ? switchAssetsData.offramp[symbol] : null;
  const headerHtml = `
    <div class="dropdown-header flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-800 sm:hidden shrink-0 bg-white dark:bg-slate-900">
      <span class="text-sm font-bold text-gray-900 dark:text-white px-1">Select Blockchain Network</span>
      <button onclick="closeAllDropdowns()" class="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full text-gray-500 dark:text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  `;
  let optionsHtml = '';
  if (!asset) {
    optionsHtml = '<div class="custom-option selected" data-network="solana" data-logo="/logos/solana.png" data-name="Solana"><img src="/logos/solana.png" class="w-6 h-6" alt="Solana"><span class="font-medium">Solana (Native)</span></div>';
  } else {
    optionsHtml = sortChains(asset.chains).map(chain => {
      const bc = (switchAssetsData && switchAssetsData.blockchains) ? switchAssetsData.blockchains[chain] : null;
      const logo = getChainLogo(chain);
      const name = bc ? bc.name : chain.charAt(0).toUpperCase() + chain.slice(1);
      return `<div class="custom-option" data-network="${chain}" data-logo="${logo}" data-name="${name}"><img src="${logo}" class="w-6 h-6" alt="${name}"><span class="font-medium">${name}</span></div>`;
    }).join('');
  }
  container.innerHTML = headerHtml + `<div class="flex-1 overflow-y-auto min-h-0 -webkit-overflow-scrolling-touch">${optionsHtml}</div>`;
}

function renderBuyNetworks(symbol) {
  if (!symbol) return;
  const container = document.getElementById('buy-network-options');
  if (!container) return;
  const asset = (switchAssetsData && switchAssetsData.onramp) ? switchAssetsData.onramp[symbol] : null;
  const headerHtml = `
    <div class="dropdown-header flex items-center justify-between p-3 border-b border-gray-100 dark:border-slate-800 sm:hidden shrink-0 bg-white dark:bg-slate-900">
      <span class="text-sm font-bold text-gray-900 dark:text-white px-1">Select Blockchain Network</span>
      <button onclick="closeAllDropdowns()" class="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full text-gray-500 dark:text-gray-400">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  `;
  let optionsHtml = '';
  if (!asset) {
    optionsHtml = '<div class="custom-option selected" data-network="solana" data-logo="/logos/solana.png" data-name="Solana"><img src="/logos/solana.png" class="w-6 h-6" alt="Solana"><span class="font-medium">Solana (Native)</span></div>';
  } else {
    optionsHtml = sortChains(asset.chains).map(chain => {
      const bc = (switchAssetsData && switchAssetsData.blockchains) ? switchAssetsData.blockchains[chain] : null;
      const logo = getChainLogo(chain);
      const name = bc ? bc.name : chain.charAt(0).toUpperCase() + chain.slice(1);
      return `<div class="custom-option" data-network="${chain}" data-logo="${logo}" data-name="${name}"><img src="${logo}" class="w-6 h-6" alt="${name}"><span class="font-medium">${name}</span></div>`;
    }).join('');
  }
  container.innerHTML = headerHtml + `<div class="flex-1 overflow-y-auto min-h-0 -webkit-overflow-scrolling-touch">${optionsHtml}</div>`;
}

async function setDefaults() {
  // Force everything closed on startup
  closeAllDropdowns();
  try {
    const offramp = switchAssetsData ? switchAssetsData.offramp : null;
    const onramp = switchAssetsData ? switchAssetsData.onramp : null;

    // Sell defaults: prefer USDT on Solana, fallback to first available
    if (offramp && Object.keys(offramp).length > 0 && !currentSellAsset) {
      const sellSym = offramp['USDT'] ? 'USDT' : Object.keys(offramp)[0];
      const sellAsset = offramp[sellSym];
      const sellChain = sellAsset.chains.includes('solana') ? 'solana' : sellAsset.chains[0];
      const sellLogo = getAssetLogo(sellSym);
      const chainLogo = getChainLogo(sellChain);
      const chainName = switchAssetsData.blockchains[sellChain]?.name || sellChain.charAt(0).toUpperCase() + sellChain.slice(1);

      currentSellAsset = sellSym;
      currentSellNetwork = sellChain;
      document.getElementById('sell-asset-display').innerHTML = `<img src="${sellLogo}" class="w-6 h-6" alt="${sellSym}"><span class="font-medium">${sellSym}</span><span class="text-gray-500 text-xs">${sellAsset.name}</span>`;
      document.getElementById('sell-currency-prefix').innerHTML = sellSym === 'CNGN' ? '₦' : '$';
      document.getElementById('sell-asset-name').textContent = sellSym;
      document.getElementById('sell-confirm-asset').textContent = sellSym;
      document.getElementById('sell-confirm-asset-img').src = sellLogo;
      document.getElementById('sell-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
      document.getElementById('sell-network-display').innerHTML = `<img src="${chainLogo}" class="w-6 h-6" alt="${chainName}"><span class="font-semibold">${chainName}</span>`;
      document.getElementById('sell-network-name').textContent = chainName;
      document.getElementById('sell-confirm-network-img').src = chainLogo;
      document.getElementById('sell-amount-step').classList.remove('opacity-50', 'pointer-events-none');
      renderSellNetworks(sellSym);

      document.querySelectorAll('#sell-asset-list .asset-picker-item').forEach(o => {
        if (o.dataset.symbol === sellSym) o.classList.add('selected');
      });
      document.querySelectorAll('#sell-network-options .custom-option').forEach(o => {
        if (o.textContent.includes(chainName)) o.classList.add('selected');
      });
    }

    // Buy defaults: prefer USDT on Solana via Switch, fallback to PAJ SOL if Switch is down
    if (currentBuyAsset) {
      // The user already picked a coin while the asset list was loading; keep it.
    } else if (onramp && Object.keys(onramp).length > 0) {
      const buySym = onramp['USDT'] ? 'USDT' : Object.keys(onramp)[0];
      const buyAsset = onramp[buySym];
      const buyChain = buyAsset.chains.includes('solana') ? 'solana' : buyAsset.chains[0];
      const buyLogo = getAssetLogo(buySym);
      const chainLogo = getChainLogo(buyChain);
      const chainName = switchAssetsData.blockchains[buyChain]?.name || buyChain.charAt(0).toUpperCase() + buyChain.slice(1);

      currentBuyAsset = buySym;
      currentBuyNetwork = buyChain;
      buyProvider = 'switch';
      document.getElementById('buy-asset-display').innerHTML = `<img src="${buyLogo}" class="w-6 h-6" alt="${buySym}"><span class="font-medium">${buySym}</span><span class="text-gray-500 text-xs">${buyAsset.name}</span>`;
      document.getElementById('buy-amount-label').textContent = buySym;
      document.getElementById('buy-confirm-asset').textContent = buySym;
      document.getElementById('buy-confirm-asset-img').src = buyLogo;
      document.getElementById('buy-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
      const netCol = document.getElementById('buy-network-col');
      if (netCol) netCol.style.display = '';
      document.getElementById('buy-network-display').innerHTML = `<img src="${chainLogo}" class="w-6 h-6" alt="${chainName}"><span class="font-semibold">${chainName}</span>`;
      document.getElementById('buy-confirm-network').textContent = chainName;
      document.getElementById('buy-confirm-network-img').src = chainLogo;
      document.getElementById('buy-amount-step').classList.remove('opacity-50', 'pointer-events-none');
      renderBuyNetworks(buySym);

      document.querySelectorAll('#buy-asset-list .asset-picker-item').forEach(o => {
        if (o.dataset.symbol === buySym) o.classList.add('selected');
      });
      document.querySelectorAll('#buy-network-options .custom-option').forEach(o => {
        if (o.textContent.includes(chainName)) o.classList.add('selected');
      });
    } else {
      // Fallback to PAJ SOL if Switch is down
      const buySym = 'SOL';
      const buyLogo = '/logos/solana.png';
      currentBuyAsset = buySym;
      currentBuyNetwork = 'solana';
      buyProvider = 'paj';
      document.getElementById('buy-asset-display').innerHTML = `<img src="${buyLogo}" class="w-6 h-6" alt="${buySym}"><span class="font-medium">${buySym}</span><span class="text-gray-500 text-xs">Solana</span>`;
      document.getElementById('buy-amount-label').textContent = buySym;
      safeSetText('buy-confirm-asset', buySym);
      safeSetSrc('buy-confirm-asset-img', buyLogo);
      document.getElementById('buy-network-display').innerHTML = '<img src="/logos/solana.png" class="w-5 h-5 rounded-full"><span class="font-medium text-sm">Solana</span>';
      safeSetText('buy-confirm-network', 'Solana');
      safeSetSrc('buy-confirm-network-img', '/logos/solana.png');
      const netCol = document.getElementById('buy-network-col');
      if (netCol) netCol.style.display = '';
      const netOptions = document.getElementById('buy-network-options');
      if (netOptions) {
        netOptions.innerHTML = '<div class="custom-option selected" data-network="solana" data-logo="/logos/solana.png" data-name="Solana"><img src="/logos/solana.png" class="w-6 h-6" alt="Solana"><span class="font-medium">Solana (Native)</span></div>';
      }
      document.getElementById('buy-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
      document.getElementById('buy-amount-step').classList.remove('opacity-50', 'pointer-events-none');
      fetchPajRate();
    }

    currentProvider = document.getElementById('form-sell').classList.contains('hidden') ? buyProvider : sellProvider;
    currentSwitchAsset = getSwitchAsset(currentSellAsset, currentSellNetwork);
    if (currentSwitchAsset) {
      await fetchRate('OFFRAMP');
      await fetchRate('ONRAMP');
      updateRateDisplays();
    }
  } catch (e) {
    console.error('setDefaults error:', e);
  }
}

function pruneLocalStorageCache() {
  try {
    const now = Date.now();
    const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('velcro_tx_') || key.startsWith('velcro_cache_'))) {
        try {
          const item = JSON.parse(localStorage.getItem(key));
          if (item && item.timestamp && (now - item.timestamp > MAX_AGE_MS)) {
            localStorage.removeItem(key);
          }
        } catch (e) { }
      }
    }
  } catch (e) { }
}

document.addEventListener('DOMContentLoaded', () => {
  safeLucideInit();
  pruneLocalStorageCache();
  fetchSettings();
  switchTab(initialTab());
  loadSwitchAssets();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBuyAssetPicker();
    closeSellAssetPicker();
    closeAllDropdowns();
    hideHistoryModal();
    hideSuccessModal();
    closeLoginOverlay();
    hideProfile();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (statusPollInterval) {
      clearTimeout(statusPollInterval);
      clearInterval(statusPollInterval);
      statusPollInterval = null;
      isPollingPaused = true;
    }
  } else {
    if (isPollingPaused && activePollReference) {
      isPollingPaused = false;
      if (activePollType === 'paj') {
        startPajStatusPoll(activePollReference, activePollTxType);
      } else if (activePollType === 'standard') {
        startStatusPoll(activePollReference, activePollTxType);
      }
    }
  }
});

function getSwitchAsset(symbol, network) {
  if (!symbol || !network) return '';
  return `${network}:${symbol.toLowerCase()}`;
}

function formatCurrency(value) {
  const symbol = '₦';
  return symbol + Number(value).toLocaleString();
}

function copyAmountToPay() {
  const el = document.getElementById('buy-confirm-ngn');
  if (!el) return;
  const clean = el.textContent.replace(/,/g, '').trim();
  if (!clean || clean === '0.00') return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(clean).then(() => {
      showToast(`Copied exact amount: ₦${el.textContent}`, 'success');
    }).catch(() => fallbackCopy(clean));
  } else {
    fallbackCopy(clean);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`Copied exact amount: ₦${el.textContent}`, 'success');
  }
}

function startRateExpiryTimer() {
  rateFetchedAt = Date.now();
  if (rateExpiryInterval) clearInterval(rateExpiryInterval);
  rateExpiryInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - rateFetchedAt) / 1000);
    const remaining = RATE_EXPIRY_SECONDS - elapsed;
    const sellTimer = document.getElementById('sell-rate-timer');
    const buyTimer = document.getElementById('buy-rate-timer');
    if (remaining > 0) {
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const text = `Rates live • Refreshes in ${mins > 0 ? mins + 'm ' : ''}${secs}s`;
      if (sellTimer) { 
        sellTimer.textContent = text; 
        sellTimer.classList.remove('hidden', 'text-red-500', 'text-velcro-green'); 
      }
      if (buyTimer) { 
        buyTimer.textContent = text; 
        buyTimer.classList.remove('hidden', 'text-red-500', 'text-velcro-green'); 
      }
    } else {
      if (sellTimer) { 
        sellTimer.textContent = 'Refreshing live rates...'; 
        sellTimer.classList.add('text-velcro-green'); 
      }
      if (buyTimer) { 
        buyTimer.textContent = 'Refreshing live rates...'; 
        buyTimer.classList.add('text-velcro-green'); 
      }
      fetchAllRates();
    }
  }, 1000);
}
