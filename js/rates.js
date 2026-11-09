// Velcro Convert — Settings, live rates (Switch + PAJ), banks and country selection.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

async function fetchSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    const data = await res.json();
    if (data.success) {
      if (typeof data.data.platform_fee === 'number') {
        currentFee = data.data.platform_fee;
      }
      if (typeof data.data.paj_fee === 'number') {
        currentPajFee = data.data.paj_fee;
      }
      if (typeof data.data.paj_rate_margin === 'number') {
        currentPajMargin = data.data.paj_rate_margin;
      }
      if (typeof data.data.referral_fee === 'number') {
        document.getElementById('refer-earn-fee').textContent = data.data.referral_fee;
      }
      // Update fee badges
      const activeFee = currentProvider === 'paj' ? currentPajFee : currentFee;
      const sellBadge = document.getElementById('sell-fee-badge');
      const buyBadge = document.getElementById('buy-fee-badge');
      if (sellBadge) sellBadge.textContent = `${activeFee}% fee`;
      if (buyBadge) buyBadge.textContent = `${activeFee}% fee`;
      // Recalculate displayed amounts with new fee
      calculateSell();
      calculateBuy();
      if (data.data.buy_max_limit !== undefined) {
        BUY_MAX_LIMIT = Math.max(parseInt(data.data.buy_max_limit) || 1000000, 1000000);
        const maxLabel = document.getElementById('buy-max-label');
        const errMsg = document.getElementById('buy-limit-error');
        if (maxLabel) maxLabel.textContent = `Max: ₦${BUY_MAX_LIMIT.toLocaleString()}`;
        if (errMsg) errMsg.textContent = `Maximum buy amount is ₦${BUY_MAX_LIMIT.toLocaleString()} per transaction.`;
      }
      if (typeof data.data.sell_min_limit === 'number') {
        SELL_MIN_LIMIT = data.data.sell_min_limit;
      }
      if (typeof data.data.sell_max_limit === 'number') {
        SELL_MAX_LIMIT = data.data.sell_max_limit;
        const maxLabel = document.getElementById('sell-max-label');
        if (maxLabel) maxLabel.textContent = `Max: $${SELL_MAX_LIMIT.toLocaleString()}`;
      }
      if (Array.isArray(data.data.routes_off)) {
        routesOff = data.data.routes_off;
        renderSellAssetList();
        renderBuyAssetList();
      }
      if (typeof data.data.hostfi_fee === 'number') hostfiFee = data.data.hostfi_fee;
      if (data.data.sell_timer_minutes) sellTimerMinutes = data.data.sell_timer_minutes;
      if (Array.isArray(data.data.hostfi_assets) && data.data.hostfi_assets.length) loadHostfiAssets();
      if (Array.isArray(data.data.hostfi_buy_assets) && data.data.hostfi_buy_assets.length) loadHostfiBuyAssets();
    }
  } catch (err) {
    // Use defaults
  }
}

// Coins bought through HostFi, with the networks it can send them on (and their fees).
async function loadHostfiBuyAssets() {
  try {
    const res = await fetch(`${API_BASE}/api/hostfi/buy-assets`);
    const json = await res.json();
    if (!json.success) return;
    hostfiBuyAssets = {};
    (json.data || []).forEach(a => { hostfiBuyAssets[a.symbol] = a; });
    renderBuyAssetList();
    // A default coin picked before this loaded moves to HostFi if HostFi now sells it.
    if (hostfiBuyAssets[currentBuyAsset] && buyProvider !== 'hostfi' && !currentReference) {
      const onBuy = !document.getElementById('form-buy').classList.contains('hidden');
      await selectBuyAsset(currentBuyAsset, getAssetLogo(currentBuyAsset), currentBuyAsset, 'hostfi');
      if (!onBuy) currentProvider = sellProvider;
    } else if (buyProvider === 'hostfi') {
      updateRateDisplays();
    }
  } catch (e) {
    console.error('Failed to load HostFi buy assets:', e);
  }
}

// Coins sold through HostFi, with their networks and current naira price. A coin that fails to
// load is simply left off the list.
async function loadHostfiAssets() {
  try {
    const res = await fetch(`${API_BASE}/api/hostfi/assets`);
    const json = await res.json();
    if (!json.success) return;
    hostfiAssets = {};
    (json.data || []).forEach(a => { hostfiAssets[a.symbol] = a; });
    renderSellAssetList();
    // A default coin picked before this loaded (e.g. USDT via Switch) moves to HostFi if HostFi now sells it.
    if (hostfiAssets[currentSellAsset] && sellProvider !== 'hostfi' && !currentReference) {
      const onSell = !document.getElementById('form-sell').classList.contains('hidden');
      await selectSellAsset(currentSellAsset, getAssetLogo(currentSellAsset), currentSellAsset, 'hostfi');
      if (!onSell) currentProvider = buyProvider;
    } else if (currentProvider === 'hostfi') {
      updateRateDisplays();
    }
  } catch (e) {
    console.error('Failed to load HostFi assets:', e);
  }
}

async function fetchAllRates() {
  try {
    const res = await fetch(`${API_BASE}/api/rates`);
    if (!res.ok) throw new Error('Failed to fetch global rates');
    const payload = await res.json();
    const rates = payload.data || [];

    // Store global rates for quick access
    rates.forEach(r => {
      if (r.currency === currentCurrency) {
        const rawRate = Number(r.rate) || 0;
        currentRate.sell = rawRate;
        currentRate.buy = rawRate;
        currentRate.sellDirect = Number(r.direct_rate) || (rawRate / (1 - currentFee / 100));
        currentRate.buyDirect = Number(r.direct_rate) || (rawRate * (1 - currentFee / 100));
      }
    });

    startRateExpiryTimer();
    updateRateDisplays();
    calculateSell();
    calculateBuy();
  } catch (err) {
    // Rate fetch failed
  }
}

async function fetchRate(forcedDirection) {
  // Fallback or forced single rate fetch
  const direction = forcedDirection || (document.getElementById('form-sell').classList.contains('hidden') ? 'ONRAMP' : 'OFFRAMP');
  const asset = direction === 'OFFRAMP' ? currentSellAsset : currentBuyAsset;
  const network = direction === 'OFFRAMP' ? currentSellNetwork : currentBuyNetwork;
  currentSwitchAsset = getSwitchAsset(asset, network);
  if (!currentSwitchAsset) return;
  try {
    const body = {
      direction,
      asset: currentSwitchAsset,
      country: currentCountry,
      currency: currentCurrency,
      channel: 'BANK'
    };
    const res = await fetch(`${API_BASE}/api/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Failed to fetch rate');
    const payload = await res.json();
    const data = payload.data || {};
    const rate = Number(data.rate || data.data?.rate || 0);
    const directRate = Number(data.direct_rate || data.data?.direct_rate || 0);
    if (rate > 0) {
      if (direction === 'OFFRAMP') {
        currentRate.sell = rate;
        currentRate.sellDirect = directRate > 0 ? directRate : (rate / (1 - currentFee / 100));
      } else {
        currentRate.buy = rate;
        currentRate.buyDirect = directRate > 0 ? directRate : (rate * (1 - currentFee / 100));
      }
    }
    updateRateDisplays();
    if (direction === 'OFFRAMP') calculateSell();
    else calculateBuy();
  } catch (err) {
    showToast(err.message || 'Failed to fetch rate', 'error');
  }
}

const PAJ_TOKEN_PRICES = {};

async function fetchPajTokenPrices() {
  try {
    const ids = 'solana,jupiter-exchange-solana,bonk,dogwifhat,pyth-network,global-dollar,tether,usd-coin';
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, { cache: 'default' });
    if (!res.ok) throw new Error('CoinGecko response not ok');
    const data = await res.json();
    PAJ_TOKEN_PRICES['SOL'] = data['solana']?.usd || 0;
    PAJ_TOKEN_PRICES['JUP'] = data['jupiter-exchange-solana']?.usd || 0;
    PAJ_TOKEN_PRICES['BONK'] = data['bonk']?.usd || 0;
    PAJ_TOKEN_PRICES['WIF'] = data['dogwifhat']?.usd || 0;
    PAJ_TOKEN_PRICES['PYTH'] = data['pyth-network']?.usd || 0;
    PAJ_TOKEN_PRICES['USDG'] = data['global-dollar']?.usd || 1;
    PAJ_TOKEN_PRICES['USDT'] = data['tether']?.usd || 1;
    PAJ_TOKEN_PRICES['USDC'] = data['usd-coin']?.usd || 1;
  } catch (e) {
    // Token price fetch failed — leave existing prices intact
  }
}

function computePajTokenRate(asset) {
  const pajRate = currentRate.paj || 0;
  const tokenUsd = PAJ_TOKEN_PRICES[asset] || 0;
  if (pajRate > 0 && tokenUsd > 0) {
    return pajRate * tokenUsd;
  }
  return 0;
}

async function fetchPajRate() {
  try {
    const res = await fetch(`${API_BASE}/api/paj/rate`);
    if (!res.ok) throw new Error('Failed to fetch PAJ rate');
    const payload = await res.json();
    const data = payload.data || {};
    
    // Use onramp or offramp rate depending on context
    const direction = document.getElementById('form-sell').classList.contains('hidden') ? 'ONRAMP' : 'OFFRAMP';
    const onrampRate = Number(data.onramp?.rate ?? data.onramp) || 0;
    const offrampRate = Number(data.offramp?.rate ?? data.offramp) || 0;
    currentRate.pajOnramp = onrampRate;
    currentRate.pajOfframp = offrampRate;
    const rawRate = direction === 'ONRAMP' ? onrampRate : offrampRate;
    const activeRate = Number(rawRate);
    if (!Number.isNaN(activeRate) && activeRate > 0) {
      currentRate.paj = activeRate;
    }

    // Fetch token prices and compute approximate token rates
    await fetchPajTokenPrices();
    
    const currentAsset = direction === 'OFFRAMP' ? currentSellAsset : currentBuyAsset;
    if (currentAsset && currentProvider === 'paj') {
      const approxRate = computePajTokenRate(currentAsset);
      if (direction === 'OFFRAMP') {
        currentRate.sell = approxRate > 0 ? approxRate : 0;
        currentRate.sellDirect = approxRate > 0 ? approxRate : 0;
      } else {
        currentRate.buy = approxRate > 0 ? approxRate : 0;
        currentRate.buyDirect = approxRate > 0 ? approxRate : 0;
      }
    }
    if (typeof data.fee_percent === 'number') {
      currentPajFee = data.fee_percent;
    }
    updateRateDisplays();
    if (direction === 'OFFRAMP') calculateSell();
    else calculateBuy();
  } catch (err) {
  }
}

function updateRateDisplays() {
  const sellRateEl = document.getElementById('sell-rate-display');
  const buyRateEl = document.getElementById('buy-rate-display');
  const sellBadge = document.getElementById('sell-fee-badge');
  const buyBadge = document.getElementById('buy-fee-badge');
  const pulse = '<span class="w-2 h-2 rounded-full bg-green-500 live-pulse"></span>';
  // Shown instead of an empty "--" while a rate is loading or before a coin is picked.
  const pending = '<span class="w-2 h-2 rounded-full bg-gray-300 animate-pulse"></span><span class="text-gray-400">Fetching rate…</span>';
  const noAsset = '<span class="text-gray-400">Choose a coin to see the rate</span>';

  const activeFee = currentProvider === 'paj' ? currentPajFee : (currentProvider === 'hostfi' ? hostfiFee : currentFee);
  if (sellBadge) sellBadge.textContent = `${activeFee}% fee`;
  if (buyBadge) buyBadge.textContent = `${buyProvider === 'hostfi' ? hostfiFee : (currentProvider === 'paj' ? currentPajFee : currentFee)}% fee`;

  if (sellRateEl) {
    if (currentProvider === 'hostfi') {
      const a = hostfiAssets[currentSellAsset];
      // HostFi's own rate per dollar of the coin; our fee is shown separately in the fee badge.
      const gross = Number(a && (a.ngn_per_unit_gross || a.ngn_per_unit));
      sellRateEl.innerHTML = gross > 0 && a.usd_per_unit > 0
        ? `${pulse}Rate: $1 = ₦${(gross / Number(a.usd_per_unit)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : pending;
    } else if (currentProvider === 'paj') {
      const pajDirect = currentRate.pajOfframp || currentRate.paj;
      if (pajDirect) {
        const formatted = Number(pajDirect).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        sellRateEl.innerHTML = `${pulse}Rate: $1 = ₦${formatted}`;
      } else {
        sellRateEl.innerHTML = pending;
      }
    } else if (currentSellAsset) {
      const directRate = currentRate.sellDirect || (currentRate.sell ? (currentRate.sell / (1 - currentFee / 100)) : 0);
      if (directRate > 0) {
        const isUsdStable = currentSellAsset === 'USDT' || currentSellAsset === 'USDC' || currentSellAsset === 'USDG';
        const label = isUsdStable ? '$1' : `1 ${currentSellAsset}`;
        const formatted = Number(directRate).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        sellRateEl.innerHTML = `${pulse}Rate: ${label} = ₦${formatted}`;
      } else {
        sellRateEl.innerHTML = pending;
      }
    } else {
      sellRateEl.innerHTML = noAsset;
    }
  }

  if (buyRateEl) {
    if (buyProvider === 'hostfi') {
      const a = hostfiBuyAssets[currentBuyAsset];
      const gross = Number(a && a.ngn_per_unit_gross);
      buyRateEl.innerHTML = gross > 0 && a.usd_per_unit > 0
        ? `${pulse}Rate: $1 = ₦${(gross / Number(a.usd_per_unit)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : pending;
    } else if (currentProvider === 'paj') {
      const pajDirect = currentRate.pajOnramp || currentRate.paj;
      if (pajDirect) {
        const formatted = Number(pajDirect).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        buyRateEl.innerHTML = `${pulse}Rate: $1 = ₦${formatted}`;
      } else {
        buyRateEl.innerHTML = pending;
      }
    } else if (currentBuyAsset) {
      const directRate = currentRate.buyDirect || (currentRate.buy ? (currentRate.buy * (1 - currentFee / 100)) : 0);
      if (directRate > 0) {
        const isUsdStable = currentBuyAsset === 'USDT' || currentBuyAsset === 'USDC' || currentBuyAsset === 'USDG';
        const label = isUsdStable ? '$1' : `1 ${currentBuyAsset}`;
        const formatted = Number(directRate).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        buyRateEl.innerHTML = `${pulse}Rate: ${label} = ₦${formatted}`;
      } else {
        buyRateEl.innerHTML = pending;
      }
    } else {
      buyRateEl.innerHTML = noAsset;
    }
  }
}

function updateCurrencySymbols() {
  const symbol = '&#8358;';
  const sellReceiveCurrency = document.getElementById('sell-receive-currency');
  const buySendCurrency = document.getElementById('buy-send-currency');
  const buyConfirmSymbol = document.getElementById('buy-confirm-currency-symbol');
  const sellReceiveCode = document.getElementById('sell-receive-currency-code');
  const buySendCode = document.getElementById('buy-send-currency-code');
  const sellReceiveFlag = document.getElementById('sell-receive-flag');
  const buySendFlag = document.getElementById('buy-send-flag');
  const flagMap = { 'NGN': '/flags/ng.png' };
  if (sellReceiveCurrency) sellReceiveCurrency.innerHTML = symbol;
  if (buySendCurrency) buySendCurrency.innerHTML = symbol;
  if (buyConfirmSymbol) buyConfirmSymbol.innerHTML = symbol;
  if (sellReceiveCode) sellReceiveCode.textContent = 'NGN';
  if (buySendCode) buySendCode.textContent = 'NGN';
  if (sellReceiveFlag) sellReceiveFlag.src = flagMap['NGN'];
  if (buySendFlag) buySendFlag.src = flagMap['NGN'];
}

async function fetchRequirements() {
  try {
    const res = await fetch(`${API_BASE}/api/requirements?direction=OFFRAMP&country=${currentCountry}&currency=${currentCurrency}`);
    if (!res.ok) return;
    const payload = await res.json();
    countryRequirements = {};
    const reqs = payload.data || [];
    reqs.forEach(r => {
      countryRequirements[r.path] = r;
    });
  } catch (e) {
    showToast('Failed to load bank list', 'error');
  }
}

const DEFAULT_NIGERIAN_BANKS = [
  { code: '058', switchCode: '058', pajId: '058', name: 'Guaranty Trust Bank (GTBank)' },
  { code: '044', switchCode: '044', pajId: '044', name: 'Access Bank' },
  { code: '057', switchCode: '057', pajId: '057', name: 'Zenith Bank' },
  { code: '011', switchCode: '011', pajId: '011', name: 'First Bank of Nigeria' },
  { code: '033', switchCode: '033', pajId: '033', name: 'United Bank for Africa (UBA)' },
  { code: '100004', switchCode: '100004', pajId: '100004', name: 'Opay (PayCom)' },
  { code: '100033', switchCode: '100033', pajId: '100033', name: 'PalmPay' },
  { code: '090267', switchCode: '090267', pajId: '090267', name: 'Kuda Bank' },
  { code: '090405', switchCode: '090405', pajId: '090405', name: 'Moniepoint MFB' },
  { code: '070', switchCode: '070', pajId: '070', name: 'Fidelity Bank' },
  { code: '214', switchCode: '214', pajId: '214', name: 'First City Monument Bank (FCMB)' },
  { code: '221', switchCode: '221', pajId: '221', name: 'Stanbic IBTC Bank' },
  { code: '232', switchCode: '232', pajId: '232', name: 'Sterling Bank' },
  { code: '032', switchCode: '032', pajId: '032', name: 'Union Bank of Nigeria' },
  { code: '215', switchCode: '215', pajId: '215', name: 'Unity Bank' },
  { code: '035', switchCode: '035', pajId: '035', name: 'Wema Bank' },
  { code: '076', switchCode: '076', pajId: '076', name: 'Polaris Bank' },
  { code: '050', switchCode: '050', pajId: '050', name: 'Ecobank Nigeria' },
  { code: '082', switchCode: '082', pajId: '082', name: 'Keystone Bank' },
  { code: '090110', switchCode: '090110', pajId: '090110', name: 'VFD Microfinance Bank' },
  { code: '090701', switchCode: '090701', pajId: '090701', name: 'Carbon' },
  { code: '090551', switchCode: '090551', pajId: '090551', name: 'FairMoney MFB' },
  { code: '301', switchCode: '301', pajId: '301', name: 'Jaiz Bank' },
  { code: '302', switchCode: '302', pajId: '302', name: 'Taj Bank' },
  { code: '303', switchCode: '303', pajId: '303', name: 'Lotus Bank' },
  { code: '101', switchCode: '101', pajId: '101', name: 'Providus Bank' },
  { code: '102', switchCode: '102', pajId: '102', name: 'Titan Trust Bank' },
  { code: '105', switchCode: '105', pajId: '105', name: 'PremiumTrust Bank' },
  { code: '068', switchCode: '068', pajId: '068', name: 'Standard Chartered Bank' },
  { code: '023', switchCode: '023', pajId: '023', name: 'Citibank Nigeria' }
];

let cachedBanks = [...DEFAULT_NIGERIAN_BANKS];
async function fetchInstitutions() {
  const bankReq = countryRequirements['bank_code'];
  switchBanks = bankReq?.option || [];
  mergeBanks();
}

function normalizeBankName(name) {
  return name.toLowerCase()
    .replace(/\b(bank|plc|limited|ltd|inc|corp|co\.?|ng)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function mergeBanks() {
  const byNorm = {};

  // Seed with DEFAULT_NIGERIAN_BANKS when country is Nigeria
  if (currentCountry === 'NG') {
    for (const b of DEFAULT_NIGERIAN_BANKS) {
      if (!b || !b.name) continue;
      const norm = normalizeBankName(b.name);
      if (norm) byNorm[norm] = { ...b, switchCode: b.code || '', pajId: b.id || b.pajId || b.code || '' };
    }
  }

  // Merge Switch banks
  for (const b of switchBanks) {
    if (!b || !b.name) continue;
    const norm = normalizeBankName(b.name);
    if (!norm) continue;
    if (byNorm[norm]) {
      byNorm[norm].switchCode = b.code;
      if (!byNorm[norm].code) byNorm[norm].code = b.code;
    } else {
      byNorm[norm] = {
        name: b.name,
        code: b.code,
        switchCode: b.code,
        pajId: ''
      };
    }
  }

  // Merge PAJ banks
  for (const b of pajBanks) {
    if (!b || !b.name) continue;
    const norm = normalizeBankName(b.name);
    if (!norm) continue;
    const targetPajId = b.id || b.code || '';
    if (byNorm[norm]) {
      byNorm[norm].pajId = targetPajId;
      if (!byNorm[norm].code) byNorm[norm].code = b.code;
    } else {
      // Try fuzzy match
      let matched = false;
      for (const key of Object.keys(byNorm)) {
        if (norm.includes(key) || key.includes(norm)) {
          byNorm[key].pajId = targetPajId;
          matched = true;
          break;
        }
      }
      if (!matched) {
        byNorm[norm] = {
          name: b.name,
          code: b.code,
          switchCode: '',
          pajId: targetPajId
        };
      }
    }
  }

  const merged = Object.values(byNorm).filter(b => b && b.name);
  cachedBanks = (merged.length > 0 ? merged : [...DEFAULT_NIGERIAN_BANKS]).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  populateBanks();
}

const TOP_BANK_CODES = ['100004', '000014', '000013', '000015', '000016', '000004', '000007', '000018', '000017', '000001', '000010', '000008', '000003', '000012', '000002', '000011'];

function populateBanks(filter = '') {
  const container = document.getElementById('sell-bank-options');
  if (!container) return;
  
  // Initialize header if not present
  if (!container.querySelector('.dropdown-header')) {
    container.innerHTML = `
      <div class="dropdown-header shrink-0 p-3 border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div class="flex items-center gap-2 mb-2 sm:hidden">
          <span class="text-sm font-bold text-gray-900 dark:text-white flex-1 px-1">Choose bank</span>
          <button onclick="closeAllDropdowns()" class="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full text-gray-500 dark:text-gray-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
        <div class="relative">
          <input type="text" id="bank-filter" placeholder="Search banks..." autocomplete="off" autocorrect="off" 
            class="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:border-velcro-green bg-gray-50 dark:bg-slate-800 dark:text-white transition-all" 
            oninput="populateBanks(this.value)" onclick="event.stopPropagation()">
        </div>
      </div>
      <div id="bank-list-items" class="flex-1 overflow-y-auto min-h-0 -webkit-overflow-scrolling-touch overscroll-contain"></div>
    `;
  }

  const listContainer = document.getElementById('bank-list-items');
  let banks = (cachedBanks && cachedBanks.length > 0) ? cachedBanks : (currentCountry === 'NG' ? DEFAULT_NIGERIAN_BANKS : []);
  banks = banks.filter(b => b && b.name);
  if (banks.length === 0) {
    listContainer.innerHTML = `<div class="p-4 text-center text-gray-400 text-xs flex flex-col items-center gap-2">
      <i data-lucide="alert-circle" class="w-5 h-5 opacity-50"></i>
      <span>No banks available</span>
    </div>`;
    safeLucideInit();
    return;
  }

  banks = [...banks].sort((a, b) => {
    const aTop = TOP_BANK_CODES.indexOf(a.code);
    const bTop = TOP_BANK_CODES.indexOf(b.code);
    if (aTop !== -1 && bTop !== -1) return aTop - bTop;
    if (aTop !== -1) return -1;
    if (bTop !== -1) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const term = filter.trim().toLowerCase();
  if (term) {
    banks = banks.filter(b => (b.name || '').toLowerCase().includes(term));
  }

  // Deduplicate banks by code
  const uniqueBanks = [];
  const seenCodes = new Set();
  for (const b of banks) {
    if (!seenCodes.has(b.code)) {
      uniqueBanks.push(b);
      seenCodes.add(b.code);
    }
  }
  banks = uniqueBanks;

  let html = '';
  let topCount = 0;
  banks.forEach((b, i) => {
    const isTop = TOP_BANK_CODES.includes(b.code);
    if (!isTop && topCount > 0 && topCount < 16 && !term) {
      html += `<div class="px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-y border-gray-100">More Banks</div>`;
      topCount = 99;
    }
    if (isTop) topCount++;
    const safeName = escapeHtml(b.name || '');
    const sc = escapeHtml(b.switchCode || '');
    const pj = escapeHtml(b.pajId || '');
    const safeCode = escapeHtml(b.code || '');
    html += `<div class="custom-option" data-bank-code="${safeCode}" data-bank-name="${safeName}" data-switch-code="${sc}" data-paj-id="${pj}">${safeName}</div>`;
  });

  if (banks.length === 0) {
    html += `<div class="custom-option text-gray-400">No banks found</div>`;
  }
  listContainer.innerHTML = html;
}

async function selectCountry(code, currency, label, flag) {
  currentCountry = code;
  currentCurrency = currency;
  const flagHtml = flag ? `<img src="${flag}" class="w-5 h-auto rounded-sm" alt="${code}">` : '';
  document.getElementById('country-display').innerHTML = `<span class="flex items-center gap-2 font-medium text-gray-900">${flagHtml} ${label}</span>`;
  document.querySelectorAll('#country-options .custom-option').forEach(o => o.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  document.getElementById('country-options').classList.remove('open');
  
  // Reset state for new country
  cachedBanks = [];
  countryRequirements = {};
  populateBanks();
  
  // Only fetch rates/requirements for Nigeria for now
  if (code !== 'NG') {
    showToast(`${label} support is coming soon!`, 'info');
    updateCurrencySymbols();
    return;
  }

  // Reset state for new country
  cachedBanks = [...DEFAULT_NIGERIAN_BANKS];
  countryRequirements = {};
  populateBanks();
  
  updateCurrencySymbols();
  
  // Force rate refresh for both directions
  fetchRate('OFFRAMP');
  fetchRate('ONRAMP');
  
  await fetchRequirements();
  fetchInstitutions();
}

let lastModalClose = 0;

document.addEventListener('click', (e) => {
  const isSelect = e.target.closest('.custom-select');
  const isOption = e.target.closest('.custom-option');
  const isDropdown = e.target.closest('.custom-select-options');
  const isAssetModal = e.target.closest('.asset-picker-modal');
  const isAssetPill = e.target.closest('.asset-pill');

  if (isAssetModal || isAssetPill) {
    return;
  }

  if ((!isSelect && !isDropdown) || isOption) {
    closeAllDropdowns();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllDropdowns();
});

let lastWindowWidth = window.innerWidth;
let resizeTimeout;
window.addEventListener('resize', () => {
  // Only close dropdowns if window WIDTH changes (e.g. screen orientation or desktop window resize).
  // Ignore height changes caused by mobile soft keyboard popups.
  if (Math.abs(window.innerWidth - lastWindowWidth) > 10) {
    lastWindowWidth = window.innerWidth;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(closeAllDropdowns, 100);
  }
});
