// Velcro Convert — Buy/sell form: pickers, tabs, asset/network/bank selection and amount maths.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

// Mobile-friendly network dropdown delegation
function setupNetworkDropdown(containerId, selectFn) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-option');
    if (!option) return;
    e.stopPropagation();
    
    const id = option.dataset.network;
    const logo = option.dataset.logo;
    const name = option.dataset.name;
    if (id && logo && name) {
      selectFn(id, logo, name, option);
    }
  });
}
setupNetworkDropdown('sell-network-options', selectSellNetwork);
setupNetworkDropdown('buy-network-options', selectBuyNetwork);

// Bank dropdown event handling
(function setupBankDropdown() {
  const container = document.getElementById('sell-bank-options');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const option = e.target.closest('.custom-option');
    if (!option) return;
    const name = option.dataset.bankName;
    const sc = option.dataset.switchCode;
    const pj = option.dataset.pajId;
    if (!name) return;
    e.stopPropagation();
    selectSellBank(name, sc, pj, option);
  });
})();

function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function safeSetSrc(id, src) {
  const el = document.getElementById(id);
  if (el) el.src = src;
}

function handleNetworkClick(tab) {
  const isSell = tab === 'sell';
  const currentAsset = isSell ? currentSellAsset : currentBuyAsset;
  if (!currentAsset) {
    showToast('Please choose an asset first', 'info');
    if (isSell) openSellAssetPicker();
    else openBuyAssetPicker();
    return;
  }
  const dropdownId = isSell ? 'sell-network-options' : 'buy-network-options';
  toggleDropdown(dropdownId);
}

function toggleDropdown(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isOpen = el.classList.contains('open');
  closeAllDropdowns();
  if (!isOpen) {
    el.classList.add('open');
    const parent = el.closest('.custom-select');
    if (parent) parent.style.zIndex = '100001';
    const card = el.closest('.premium-card');
    if (card) card.style.zIndex = '100000';

    if (window.innerWidth <= 640) {
      // On mobile, teleport el to document.body so position:fixed is never trapped inside card stacking context
      if (el.parentElement !== document.body) {
        el._originalParent = el.parentElement;
        el._nextSibling = el.nextSibling;
        document.body.appendChild(el);
      }
      const backdrop = document.getElementById('dropdown-backdrop');
      if (backdrop) backdrop.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  }
}

function closeAllDropdowns() {
  // Do not blur search inputs inside open modals/dropdowns when closing
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    const tag = document.activeElement.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      document.activeElement.blur();
    }
  }
  document.querySelectorAll('.custom-select-options').forEach(o => {
    o.classList.remove('open');
    const p = o.closest('.custom-select');
    if (p) p.style.zIndex = '';
    // Return teleported element to original position in DOM tree
    if (o._originalParent && o.parentElement === document.body) {
      if (o._nextSibling && o._originalParent.contains(o._nextSibling)) {
        o._originalParent.insertBefore(o, o._nextSibling);
      } else {
        o._originalParent.appendChild(o);
      }
    }
  });
  document.querySelectorAll('.premium-card').forEach(c => c.style.zIndex = '');
  document.querySelectorAll('.asset-picker-modal').forEach(o => o.classList.remove('open'));
  document.body.style.overflow = '';
  const backdrop = document.getElementById('dropdown-backdrop');
  if (backdrop) backdrop.classList.remove('active');
}

function openBuyAssetPicker() {
  closeAllDropdowns();
  const modal = document.getElementById('buy-asset-options');
  const searchInput = document.getElementById('buy-asset-search');
  if (searchInput) { searchInput.value = ''; filterBuyAssets(); }
  // Highlight current selection
  document.querySelectorAll('#buy-asset-list .asset-picker-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.symbol === currentBuyAsset);
  });
  if (modal) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (window.innerWidth > 640 && searchInput) setTimeout(() => searchInput.focus(), 50);
  }
}

function closeBuyAssetPicker() {
  const modal = document.getElementById('buy-asset-options');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function filterBuyAssets() {
  const term = document.getElementById('buy-asset-search').value.trim().toLowerCase();
  const items = document.querySelectorAll('#buy-asset-list .asset-picker-item');
  const dividers = document.querySelectorAll('#buy-asset-list .asset-picker-divider');
  items.forEach(item => {
    const symbol = (item.dataset.symbol || '').toLowerCase();
    const name = (item.dataset.name || '').toLowerCase();
    item.style.display = (!term || symbol.includes(term) || name.includes(term)) ? '' : 'none';
  });
  // Hide dividers if all items below them are hidden
  dividers.forEach(div => {
    let next = div.nextElementSibling;
    let anyVisible = false;
    while (next && !next.classList.contains('asset-picker-divider')) {
      if (next.classList.contains('asset-picker-item') && next.style.display !== 'none') {
        anyVisible = true; break;
      }
      next = next.nextElementSibling;
    }
    div.style.display = anyVisible ? '' : 'none';
  });
}

function openSellAssetPicker() {
  closeAllDropdowns();
  const modal = document.getElementById('sell-asset-options');
  const searchInput = document.getElementById('sell-asset-search');
  if (searchInput) { searchInput.value = ''; filterSellAssets(); }
  // Highlight current selection
  document.querySelectorAll('#sell-asset-list .asset-picker-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.symbol === currentSellAsset);
  });
  if (modal) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (window.innerWidth > 640 && searchInput) setTimeout(() => searchInput.focus(), 50);
  }
}

function closeSellAssetPicker() {
  const modal = document.getElementById('sell-asset-options');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function filterSellAssets() {
  const term = document.getElementById('sell-asset-search').value.trim().toLowerCase();
  const items = document.querySelectorAll('#sell-asset-list .asset-picker-item');
  const dividers = document.querySelectorAll('#sell-asset-list .asset-picker-divider');
  items.forEach(item => {
    const symbol = (item.dataset.symbol || '').toLowerCase();
    const name = (item.dataset.name || '').toLowerCase();
    item.style.display = (!term || symbol.includes(term) || name.includes(term)) ? '' : 'none';
  });
  // Hide dividers if all items below them are hidden
  dividers.forEach(div => {
    let next = div.nextElementSibling;
    let anyVisible = false;
    while (next && !next.classList.contains('asset-picker-divider')) {
      if (next.classList.contains('asset-picker-item') && next.style.display !== 'none') {
        anyVisible = true; break;
      }
      next = next.nextElementSibling;
    }
    div.style.display = anyVisible ? '' : 'none';
  });
}

function switchTab(tab) {
  currentProvider = tab === 'sell' ? sellProvider : buyProvider;
  const indicator = document.getElementById('tab-indicator');
  const sellTab = document.getElementById('tab-sell');
  const buyTab = document.getElementById('tab-buy');
  const sellForm = document.getElementById('form-sell');
  const buyForm = document.getElementById('form-buy');
  const stepLabels = document.getElementById('step-labels');

  if (tab === 'sell') {
    indicator.style.left = '4px';
    sellTab.classList.remove('text-gray-500');
    sellTab.classList.add('text-velcro-navy');
    buyTab.classList.remove('text-velcro-navy');
    buyTab.classList.add('text-gray-500');
    sellForm.classList.remove('hidden');
    buyForm.classList.add('hidden');
    if (stepLabels) stepLabels.innerHTML = '<span>Coin</span><span>Network</span><span>Amount</span><span>Bank</span>';
  } else {
    indicator.style.left = 'calc(50% + 2px)';
    sellTab.classList.remove('text-velcro-navy');
    sellTab.classList.add('text-gray-500');
    buyTab.classList.remove('text-gray-500');
    buyTab.classList.add('text-velcro-navy');
    sellForm.classList.add('hidden');
    buyForm.classList.remove('hidden');
    if (stepLabels) stepLabels.innerHTML = '<span>Coin</span><span>Network</span><span>Amount</span><span>Wallet</span>';
  }
  sellTab.setAttribute('aria-selected', String(tab === 'sell'));
  buyTab.setAttribute('aria-selected', String(tab !== 'sell'));
  try { localStorage.setItem('velcro-tab', tab); } catch (e) {}
  updateStepIndicators(tab === 'sell' ? 'OFFRAMP' : 'ONRAMP');
  fetchRate();
  safeLucideInit();
}

// Display name for a HostFi network, e.g. {code: 'TRC20', chain: 'tron'} → "TRON (TRC20)".
function hostfiNetworkName(n) {
  const names = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'TRON', bsc: 'BNB Chain', solana: 'Solana', polygon: 'Polygon', base: 'Base', stellar: 'Stellar', arbitrum: 'Arbitrum', optimism: 'Optimism', avalanche: 'Avalanche' };
  const name = names[n.chain] || n.code;
  return ['bitcoin', 'solana'].includes(n.chain) || name === n.code ? name : `${name} (${n.code})`;
}

// Returning visitors land on the tab they used last; first-time visitors start on Sell.
function initialTab() {
  try { return localStorage.getItem('velcro-tab') === 'buy' ? 'buy' : 'sell'; } catch (e) { return 'sell'; }
}

async function selectSellAsset(symbol, logo, name, provider) {
  closeAllDropdowns(); // Clear everything first
  currentSellAsset = symbol;
  sellProvider = currentProvider = provider || 'switch';
  currentBankCode = currentProvider === 'paj' ? (currentBankPajId || currentBankCode) : (currentBankSwitchCode || currentBankCode);
  currentSellInputMode = 'USD';
  const prefix = document.getElementById('sell-currency-prefix');
  if (prefix) prefix.textContent = '$';

  document.getElementById('sell-asset-display').innerHTML = `
    <img src="${logo}" class="w-6 h-6" alt="${symbol}">
    <span class="font-bold text-sm sm:text-base">${symbol}</span>
    <span class="text-gray-400 text-[10px] hidden sm:inline ml-1">${name}</span>
  `;
  closeSellAssetPicker();
  safeSetText('sell-asset-name', symbol);
  safeSetText('sell-confirm-asset', symbol);
  safeSetSrc('sell-confirm-asset-img', logo);
  document.querySelectorAll('#sell-asset-list .asset-picker-item').forEach(o => o.classList.remove('selected'));
  document.querySelectorAll('#sell-asset-list .asset-picker-item').forEach(o => {
    if (o.dataset.symbol === symbol) o.classList.add('selected');
  });

  // Reset network, bank, and render supported chains for this asset
  currentSellNetwork = '';
  currentSwitchAsset = '';
  currentBankCode = '';
  currentBankSwitchCode = '';
  currentBankPajId = '';
  document.getElementById('sell-bank-display').innerHTML = '<span class="text-gray-400">Select your bank</span>';
  document.getElementById('sell-network-display').innerHTML = '<span class="text-gray-400 text-sm">Choose network</span>';
  document.getElementById('sell-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
  document.getElementById('sell-amount-step').classList.add('opacity-50', 'pointer-events-none');
  currentSellChain = '';

  if (currentProvider === 'hostfi') {
    const a = hostfiAssets[symbol];
    const networks = (a && a.networks) || [];
    currentRate.sell = a ? Number(a.ngn_per_unit) : 0;
    const netOptions = document.getElementById('sell-network-options');
    if (netOptions) {
      netOptions.innerHTML = networks.map(n => {
        const name = hostfiNetworkName(n);
        return `<div class="custom-option" data-network="${escapeHtml(n.code)}" data-logo="${getChainLogo(n.chain)}" data-name="${escapeHtml(name)}"><img src="${getChainLogo(n.chain)}" class="w-6 h-6" alt="${escapeHtml(name)}"><span class="font-medium">${escapeHtml(name)}</span></div>`;
      }).join('');
    }
    if (networks[0]) {
      const first = netOptions && netOptions.querySelector('.custom-option');
      selectSellNetwork(networks[0].code, getChainLogo(networks[0].chain), hostfiNetworkName(networks[0]), first);
    }
    updateRateDisplays();
    if (!switchBanks || switchBanks.length === 0) fetchInstitutions();
    populateBanks();
  } else if (currentProvider === 'paj') {
    currentSellNetwork = 'solana';
    currentRate.sell = 0;
    document.getElementById('sell-network-display').innerHTML = '<img src="/logos/solana.png" class="w-5 h-5 rounded-full"><span class="font-medium text-sm">Solana</span>';
    safeSetText('sell-network-name', 'Solana');
    safeSetText('sell-confirm-network', 'Solana');
    safeSetSrc('sell-confirm-network-img', '/logos/solana.png');
    const netOptions = document.getElementById('sell-network-options');
    if (netOptions) {
      netOptions.innerHTML = '<div class="custom-option selected" data-network="solana" data-logo="/logos/solana.png" data-name="Solana"><img src="/logos/solana.png" class="w-6 h-6" alt="Solana"><span class="font-medium">Solana (Native)</span></div>';
    }
    document.getElementById('sell-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
    document.getElementById('sell-amount-step').classList.remove('opacity-50', 'pointer-events-none');
    fetchPajRate();
    fetchPajBanks();
    if (!switchBanks || switchBanks.length === 0) {
      fetchInstitutions();
    }
    populateBanks();
  } else {
    currentRate.paj = 0;
    renderSellNetworks(symbol);
    // Auto-select default network (Solana preferred) and fetch rate immediately
    const asset = switchAssetsData.offramp[symbol];
    const chains = asset ? sortChains(asset.chains) : [];
    const defaultChain = chains[0] || '';
    if (defaultChain) {
      currentSellNetwork = defaultChain;
      const bc = switchAssetsData.blockchains[defaultChain];
      const chainLogo = getChainLogo(defaultChain);
      const chainName = bc ? bc.name : defaultChain.charAt(0).toUpperCase() + defaultChain.slice(1);
      document.getElementById('sell-network-display').innerHTML = `<img src="${chainLogo}" class="w-5 h-5 rounded-full" alt="${chainName}"><span class="font-medium text-sm">${chainName}</span>`;
      safeSetText('sell-network-name', chainName);
      safeSetText('sell-confirm-network', chainName);
      safeSetSrc('sell-confirm-network-img', chainLogo);
      document.querySelectorAll('#sell-network-options .custom-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.network === defaultChain);
      });
      currentSwitchAsset = getSwitchAsset(symbol, defaultChain);
      if (currentSwitchAsset) fetchRate('OFFRAMP');
      document.getElementById('sell-amount-step').classList.remove('opacity-50', 'pointer-events-none');
    }
    await fetchRequirements();
    fetchInstitutions(); // Switch banks
    populateBanks();
  }
  calculateSell();
  updateStepIndicators('OFFRAMP');
}

async function fetchPajBanks() {
  try {
    const res = await fetch(`${API_BASE}/api/paj/banks`);
    if (!res.ok) throw new Error('PAJ banks unavailable');
    const payload = await res.json();
    const rawBanks = payload.data || payload.banks || [];
    if (Array.isArray(rawBanks) && rawBanks.length > 0) {
      pajBanks = rawBanks
        .filter(b => b && b.name && String(b.name).trim())
        .map(b => ({
          id: String(b.id || b.code || '').trim(),
          code: String(b.code || b.id || '').trim(),
          name: String(b.name).trim()
        }));
      mergeBanks();
      return;
    }
  } catch (err) {
    console.warn('PAJ banks notice:', err.message);
  }
  // Seamlessly fall back to Switch/institutional banks if PAJ directory is unavailable
  if (!switchBanks || switchBanks.length === 0) {
    fetchInstitutions();
  } else {
    mergeBanks();
  }
}

function selectSellNetwork(id, logo, name, optionEl) {
  currentSellNetwork = id;
  if (id !== 'solana' && currentProvider === 'paj') {
    sellProvider = currentProvider = 'switch';
  }
  document.getElementById('sell-network-display').innerHTML = `
    <img src="${logo}" class="w-5 h-5 rounded-full" alt="${name}">
    <span class="font-medium text-sm">${name}</span>
  `;
  safeSetText('sell-network-name', name);
  safeSetText('sell-confirm-network', name);
  safeSetSrc('sell-confirm-network-img', logo);
  
  // Update highlights
  document.querySelectorAll('#sell-network-options .custom-option').forEach(o => o.classList.remove('selected'));
  if (optionEl) optionEl.classList.add('selected');
  
  closeAllDropdowns();
  document.getElementById('sell-amount-step').classList.remove('opacity-50', 'pointer-events-none');
  if (currentProvider === 'hostfi') {
    const n = ((hostfiAssets[currentSellAsset] || {}).networks || []).find(x => x.code === id);
    currentSellChain = n ? n.chain : '';
    currentSwitchAsset = '';
  } else {
    currentSwitchAsset = getSwitchAsset(currentSellAsset, currentSellNetwork);
    if (currentSwitchAsset) fetchRate();
  }
  updateStepIndicators('OFFRAMP');
  populateBanks();
}

function selectSellBank(name, switchCode, pajId, optionEl) {
  currentBankSwitchCode = switchCode || '';
  currentBankPajId = pajId || '';
  currentBankName = name || '';
  currentBankCode = currentProvider === 'paj' ? (pajId || switchCode) : (switchCode || pajId);
  document.getElementById('sell-bank-display').innerHTML = `<span class="text-gray-900 font-medium">${escapeHtml(name)}</span>`;
  
  // Update highlights
  document.querySelectorAll('#sell-bank-options .custom-option').forEach(o => o.classList.remove('selected'));
  if (optionEl) optionEl.classList.add('selected');
  
  closeAllDropdowns();
  validateAccount();
  updateStepIndicators('OFFRAMP');
}

let _resolveTimer = null;
async function resolveAccountName() {
  const bankNum = document.getElementById('sell-bank-number').value.trim();
  const nameInput = document.getElementById('sell-account-name');
  const nameLoading = document.getElementById('sell-name-loading');
  const nameError = document.getElementById('sell-name-error');

  if (!currentBankCode || !bankNum || bankNum.length < 10) return;

  nameInput.classList.add('hidden');
  nameLoading.classList.remove('hidden');
  nameError.classList.add('hidden');

  try {
    let payload;
    if (currentProvider === 'hostfi') {
      const res = await fetch(`${API_BASE}/api/hostfi/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankCode: currentBankSwitchCode || currentBankCode, bankName: currentBankName, accountNumber: bankNum })
      });
      payload = await res.json();
      if (!res.ok) throw new Error(payload.message || 'Could not resolve account name');
    } else if (currentProvider === 'paj') {
      const bankId = currentBankPajId || currentBankCode;
      if (!bankId) { nameLoading.classList.add('hidden'); nameInput.classList.remove('hidden'); nameError.textContent = 'Selected bank is not supported for this asset'; nameError.classList.remove('hidden'); return; }
      const res = await fetch(`${API_BASE}/api/paj/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank: bankId, accountNumber: bankNum })
      });
      payload = await res.json();
      if (!res.ok) throw new Error(payload.message || 'Could not resolve account name');
    } else {
      const switchCode = currentBankSwitchCode || currentBankCode;
      if (!switchCode) { nameLoading.classList.add('hidden'); nameInput.classList.remove('hidden'); nameError.textContent = 'Selected bank is not supported for this asset'; nameError.classList.remove('hidden'); return; }
      const res = await fetch(`${API_BASE}/api/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: currentCountry,
          beneficiary: { account_number: bankNum, bank_code: switchCode }
        })
      });
      payload = await res.json();
      if (!res.ok) throw new Error(payload.message || 'Could not resolve account name');
    }
    const resolvedName = payload.data?.accountName || payload.data?.account_name || payload.data?.holder_name || payload.data?.name;
    if (resolvedName) {
      nameInput.value = resolvedName;
      nameInput.classList.remove('hidden');
      nameLoading.classList.add('hidden');
      nameError.classList.add('hidden');
    } else {
      throw new Error('Account name not found');
    }
  } catch (err) {
    nameLoading.classList.add('hidden');
    nameInput.classList.remove('hidden');
    nameError.textContent = err.message || 'Could not verify account. Please check details.';
    nameError.classList.remove('hidden');
  }
}

function validateAccount() {
  const bankNum = document.getElementById('sell-bank-number').value.trim();
  const errorEl = document.getElementById('sell-bank-error');
  const nameWrap = document.getElementById('sell-name-wrap');
  const nameInput = document.getElementById('sell-account-name');
  const accReq = countryRequirements['account_number'];
  const regex = accReq?.regex ? new RegExp(accReq.regex) : /^[0-9]{10,11}$/;

  if (!bankNum) {
    errorEl.classList.add('hidden');
    nameWrap?.classList.add('hidden');
    nameInput.value = '';
    return;
  }
  if (!regex.test(bankNum) || bankNum.length < 10) {
    errorEl.textContent = accReq?.hint || 'Enter a valid account number (10+ digits)';
    errorEl.classList.remove('hidden');
    nameWrap?.classList.add('hidden');
    nameInput.value = '';
    return;
  }
  errorEl.classList.add('hidden');
  if (currentBankCode && nameWrap) {
    nameWrap.classList.remove('hidden');
    clearTimeout(_resolveTimer);
    _resolveTimer = setTimeout(() => resolveAccountName(), 600);
  }
}

async function selectBuyAsset(symbol, logo, name, provider) {
  closeAllDropdowns(); // Clear everything first
  currentBuyAsset = symbol;
  buyProvider = currentProvider = provider || 'switch';
  document.getElementById('buy-asset-display').innerHTML = `
    <img src="${logo}" class="w-6 h-6" alt="${symbol}">
    <span class="font-bold text-sm sm:text-base">${symbol}</span>
    <span class="text-gray-400 text-[10px] hidden sm:inline ml-1">${name}</span>
  `;
  // Close modal picker
  closeBuyAssetPicker();
  document.querySelectorAll('#buy-asset-list .asset-picker-item').forEach(o => o.classList.remove('selected'));
  if (event && event.currentTarget) event.currentTarget.classList.add('selected');

  document.getElementById('buy-amount-label').textContent = symbol;
  safeSetText('buy-confirm-asset', symbol);
  safeSetSrc('buy-confirm-asset-img', logo);

  if (currentProvider === 'paj') {
    currentBuyNetwork = 'solana';
    currentRate.buy = 0;
    const netCol = document.getElementById('buy-network-col');
    if (netCol) netCol.style.display = '';
    document.getElementById('buy-network-display').innerHTML = '<img src="/logos/solana.png" class="w-5 h-5 rounded-full"><span class="font-medium text-sm">Solana</span>';
    safeSetText('buy-confirm-network', 'Solana');
    safeSetSrc('buy-confirm-network-img', '/logos/solana.png');
    const netOptions = document.getElementById('buy-network-options');
    if (netOptions) {
      netOptions.innerHTML = '<div class="custom-option selected" data-network="solana" data-logo="/logos/solana.png" data-name="Solana"><img src="/logos/solana.png" class="w-6 h-6" alt="Solana"><span class="font-medium">Solana (Native)</span></div>';
    }
    document.getElementById('buy-network-wrap').classList.remove('opacity-50', 'pointer-events-none');
    document.getElementById('buy-amount-step').classList.remove('opacity-50', 'pointer-events-none');
    await fetchPajRate();
  } else {
    currentRate.paj = 0;
    // Show network selector column for Switch assets
    const netCol = document.getElementById('buy-network-col');
    if (netCol) netCol.style.display = '';
    renderBuyNetworks(symbol);
    // Auto-select default network (Solana preferred) and fetch rate immediately
    const asset = switchAssetsData.onramp[symbol];
    const chains = asset ? sortChains(asset.chains) : [];
    const defaultChain = chains[0] || '';
    if (defaultChain) {
      currentBuyNetwork = defaultChain;
      const bc = switchAssetsData.blockchains[defaultChain];
      const chainLogo = getChainLogo(defaultChain);
      const chainName = bc ? bc.name : defaultChain.charAt(0).toUpperCase() + defaultChain.slice(1);
      document.getElementById('buy-network-display').innerHTML = `<img src="${chainLogo}" class="w-5 h-5 rounded-full" alt="${chainName}"><span class="font-medium text-sm">${chainName}</span>`;
      safeSetText('buy-confirm-network', chainName);
      safeSetSrc('buy-confirm-network-img', chainLogo);
      document.querySelectorAll('#buy-network-options .custom-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.network === defaultChain);
      });
      currentSwitchAsset = getSwitchAsset(symbol, defaultChain);
      if (currentSwitchAsset) fetchRate('ONRAMP');
      document.getElementById('buy-amount-step').classList.remove('opacity-50', 'pointer-events-none');
    }
  }
  calculateBuy();
  updateStepIndicators('ONRAMP');
}

function selectBuyNetwork(id, logo, name, optionEl) {
  currentBuyNetwork = id;
  if (id !== 'solana' && currentProvider === 'paj') {
    buyProvider = currentProvider = 'switch';
  }
  document.getElementById('buy-network-display').innerHTML = `
    <img src="${logo}" class="w-5 h-5 rounded-full" alt="${name}">
    <span class="font-medium text-sm">${name}</span>
  `;
  safeSetText('buy-confirm-network', name);
  safeSetSrc('buy-confirm-network-img', logo);
  
  // Update highlights
  document.querySelectorAll('#buy-network-options .custom-option').forEach(o => o.classList.remove('selected'));
  if (optionEl) optionEl.classList.add('selected');
  
  closeAllDropdowns();
  document.getElementById('buy-amount-step').classList.remove('opacity-50', 'pointer-events-none');
  currentSwitchAsset = getSwitchAsset(currentBuyAsset, currentBuyNetwork);
  if (currentSwitchAsset) fetchRate();
  updateStepIndicators('ONRAMP');
}

function toggleSellInputMode() {
  if (!currentSellAsset) return;
  currentSellInputMode = currentSellInputMode === 'USD' ? 'ASSET' : 'USD';
  const prefix = document.getElementById('sell-currency-prefix');
  prefix.textContent = currentSellInputMode === 'USD' ? '$' : currentSellAsset;
  calculateSell();
}

// Effective rate from the final numbers the user sees, so it always matches what they get.
function setPreviewRate(type, fiat, crypto, asset) {
  const el = document.getElementById(type + '-preview-rate');
  if (!el) return;
  if (!(fiat > 0 && crypto > 0)) { el.textContent = ''; return; }
  const fee = currentProvider === 'hostfi' ? hostfiFee : (currentProvider === 'paj' && typeof currentPajFee === 'number' ? currentPajFee : currentFee);
  const usdPrice = type === 'sell' && currentProvider === 'hostfi' ? Number((hostfiAssets[currentSellAsset] || {}).usd_per_unit) || 0 : 0;
  if (usdPrice > 0) {
    // HostFi coins: show HostFi's real rate per dollar, then our fee in naira, so nothing is hidden.
    const beforeFee = fee > 0 && fee < 100 ? fiat / (1 - fee / 100) : fiat;
    const ngn = v => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el.textContent = `$1 = ₦${ngn(beforeFee / (crypto * usdPrice))} · Velcro fee ${fee}% (₦${ngn(beforeFee - fiat)}) · final amount set when your deposit confirms`;
    return;
  }
  el.textContent = `₦${(fiat / crypto).toLocaleString(undefined, { maximumFractionDigits: 2 })} per ${asset} · ${fee}% fee included`;
}

function calculateSell() {
  const amount = getNum('sell-amount');
  validateSellLimit(amount);
  const pajRate = Number(currentRate.pajOfframp || currentRate.paj);
  const tokenUsd = Number(PAJ_TOKEN_PRICES[currentSellAsset] || 0);
  const switchRate = Number(currentRate.sell);
  
  let receiveAfterFee = 0;
  let cryptoToSend = 0;
  let hostfiGross = null; // HostFi: naira before its payout charge, so the rate and fee line stay exact

  if (currentProvider === 'hostfi') {
    // ngn_per_unit already has the fee taken off; the $ field is converted at the coin's USD price.
    const a = hostfiAssets[currentSellAsset] || {};
    const usdPrice = Number(a.usd_per_unit) || 0;
    cryptoToSend = currentSellInputMode === 'USD' ? (usdPrice > 0 ? amount / usdPrice : 0) : amount;
    hostfiGross = cryptoToSend * (Number(a.ngn_per_unit) || 0);
    receiveAfterFee = Math.max(0, hostfiGross - (Number(a.payout_fee_ngn) || 0)); // HostFi's per-payout charge
  } else if (currentProvider === 'paj') {
    const activeFee = typeof currentPajFee === 'number' ? currentPajFee : currentFee;
    if (currentSellInputMode === 'USD') {
      // Input is in USD ($)
      const receiveBeforeFee = amount * pajRate;
      receiveAfterFee = receiveBeforeFee * (1 - activeFee / 100);
      cryptoToSend = tokenUsd > 0 ? amount / tokenUsd : 0;
    } else {
      // Input is in ASSET (any PAJ token)
      const price = tokenUsd > 0 ? tokenUsd : (currentSellAsset === 'USDT' || currentSellAsset === 'USDC' || currentSellAsset === 'USDG' ? 1 : 0);
      const receiveBeforeFee = amount * (pajRate * price);
      receiveAfterFee = receiveBeforeFee * (1 - activeFee / 100);
      cryptoToSend = amount;
    }
  } else {
    // Switch provider: currentRate.sell is the rate returned by Switch API with developer_fee=0.5
    // Switch will pay out cryptoAmount * switchRate directly to user's bank. No double fee deduction!
    receiveAfterFee = amount * switchRate;
    cryptoToSend = amount;
  }

  if (receiveAfterFee > 0) {
    setFmt('sell-receive', receiveAfterFee, 2);
  } else {
    setFmt('sell-receive', '', 2);
  }

  // Update preview
  const preview = document.getElementById('sell-preview');
  const previewCrypto = document.getElementById('sell-preview-crypto');
  const previewFiat = document.getElementById('sell-preview-fiat');
  if (amount > 0 && cryptoToSend > 0) {
    previewCrypto.textContent = `${Number(cryptoToSend).toLocaleString(undefined, {maximumFractionDigits: 4})} ${currentSellAsset}`;
    previewFiat.textContent = `₦${receiveAfterFee.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    setPreviewRate('sell', hostfiGross !== null ? hostfiGross : receiveAfterFee, cryptoToSend, currentSellAsset);
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
  }
  updateStepIndicators('OFFRAMP');
}

function calculateSellFromNgn() {
  const ngn = getNum('sell-receive');
  const pajRate = Number(currentRate.pajOfframp || currentRate.paj);
  const tokenUsd = Number(PAJ_TOKEN_PRICES[currentSellAsset] || 0);
  const switchRate = Number(currentRate.sell);
  const activeFee = currentProvider === 'paj' ? (typeof currentPajFee === 'number' ? currentPajFee : currentFee) : currentFee;

  const ngnBeforeFee = ngn / (1 - activeFee / 100);

  if (currentProvider === 'hostfi') {
    const a = hostfiAssets[currentSellAsset] || {};
    const crypto = Number(a.ngn_per_unit) > 0 && ngn > 0 ? (ngn + (Number(a.payout_fee_ngn) || 0)) / Number(a.ngn_per_unit) : 0;
    if (currentSellInputMode === 'USD') setFmt('sell-amount', crypto * (Number(a.usd_per_unit) || 0), 2);
    else setFmt('sell-amount', crypto, 8);
  } else if (currentProvider === 'paj') {
    if (currentSellInputMode === 'USD') {
      const usd = ngnBeforeFee / (pajRate > 0 ? pajRate : 1);
      setFmt('sell-amount', usd, 2);
    } else {
      const price = tokenUsd > 0 ? tokenUsd : (currentSellAsset === 'USDT' || currentSellAsset === 'USDC' || currentSellAsset === 'USDG' ? 1 : 1);
      const crypto = ngnBeforeFee / ((pajRate > 0 ? pajRate : 1) * price);
      setFmt('sell-amount', crypto, 4);
    }
  } else {
    // Switch provider: receiveAfterFee = amount * switchRate => amount = ngn / switchRate
    const crypto = switchRate > 0 ? (ngn / switchRate) : 0;
    setFmt('sell-amount', crypto, 4);
  }
  calculateSell(); // To update preview
}

const BUY_MIN_LIMIT = 2000;

function isUsdtOrUsdcOnTrxOrEth() {
  const asset = (currentBuyAsset || '').toUpperCase();
  const net = (currentBuyNetwork || '').toLowerCase();
  const isUsdToken = asset === 'USDT' || asset === 'USDC';
  const isTrxOrEthNet = net.includes('tron') || net.includes('trx') || net.includes('eth') || net.includes('ethereum');
  return isUsdToken && isTrxOrEthNet;
}

function getEffectiveBuyMinLimit() {
  if (isUsdtOrUsdcOnTrxOrEth()) {
    const rate = Number(currentRate.buy) || Number(currentRate.paj) || 1500;
    const fiveUsdInNgn = Math.ceil(5 * rate);
    return Math.max(BUY_MIN_LIMIT, fiveUsdInNgn);
  }
  return BUY_MIN_LIMIT;
}

function updateBuyMinLimitUI() {
  const minLabel = document.getElementById('buy-min-label');
  if (!minLabel) return;
  if (isUsdtOrUsdcOnTrxOrEth()) {
    const minLimit = getEffectiveBuyMinLimit();
    minLabel.textContent = `Min: ₦${minLimit.toLocaleString()} ($5)`;
  } else {
    minLabel.textContent = `Min: ₦${BUY_MIN_LIMIT.toLocaleString()}`;
  }
}

function validateBuyLimit(amount) {
  updateBuyMinLimitUI();
  const errorEl = document.getElementById('buy-limit-error');
  if (!errorEl) return true;
  const minLimit = getEffectiveBuyMinLimit();
  if (amount > 0 && amount < minLimit) {
    if (isUsdtOrUsdcOnTrxOrEth()) {
      errorEl.textContent = `Minimum buy amount for USDT/USDC on TRON/Ethereum is $5 worth (₦${minLimit.toLocaleString()}).`;
    } else {
      errorEl.textContent = `Minimum buy amount is ₦${BUY_MIN_LIMIT.toLocaleString()}.`;
    }
    errorEl.classList.remove('hidden');
    return false;
  }
  if (amount > BUY_MAX_LIMIT) {
    errorEl.textContent = `Maximum buy amount is ₦${BUY_MAX_LIMIT.toLocaleString()} per transaction.`;
    errorEl.classList.remove('hidden');
    return false;
  }
  errorEl.classList.add('hidden');
  return true;
}

function validateSellLimit(amount) {
  if (currentProvider === 'hostfi' && currentSellInputMode !== 'USD') {
    amount = amount * (Number((hostfiAssets[currentSellAsset] || {}).usd_per_unit) || 0);
  }
  const errorEl = document.getElementById('sell-limit-error');
  const symbol = currentSellInputMode === 'USD' || currentProvider === 'hostfi' ? '$' : '';
  if (amount > 0 && amount < SELL_MIN_LIMIT) {
    if (errorEl) {
      errorEl.textContent = `Minimum sell amount is ${symbol}${SELL_MIN_LIMIT.toLocaleString()}.`;
      errorEl.classList.remove('hidden');
    }
    return false;
  }
  if (amount > SELL_MAX_LIMIT) {
    if (errorEl) {
      errorEl.textContent = `Maximum sell amount is ${symbol}${SELL_MAX_LIMIT.toLocaleString()} per transaction.`;
      errorEl.classList.remove('hidden');
    }
    return false;
  }
  if (errorEl) errorEl.classList.add('hidden');
  return true;
}

const PAJ_MINTS = {
  'SOL': 'So11111111111111111111111111111111111111112',
  'JUP': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  'PYTH': 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  'USDG': '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};
let pajValueTimeout = null;

function calculateBuy() {
  const amount = getNum('buy-amount');
  validateBuyLimit(amount);

  // PAJ provider: use exact PAJ value only — no frontend calculations
  if (currentProvider === 'paj') {
    setFmt('buy-receive', '', 4);
    document.getElementById('buy-preview').classList.add('hidden');
    if (amount > 0) {
      if (pajValueTimeout) clearTimeout(pajValueTimeout);
      pajValueTimeout = setTimeout(() => fetchPajValue(amount), 300);
    }
    updateStepIndicators('ONRAMP');
    return;
  }

  const rate = Number(currentRate.buy);
  if (Number.isNaN(rate) || rate <= 0) {
    setFmt('buy-receive', '', 4);
    document.getElementById('buy-preview').classList.add('hidden');
    updateStepIndicators('ONRAMP');
    return;
  }
  const feePercent = currentFee;
  const feeFactor = feePercent > 0 && feePercent < 100 ? (1 - (feePercent / 100)) : 1;
  const receive = (amount * feeFactor) / rate;
  if (Number.isNaN(receive)) {
    setFmt('buy-receive', '', 4);
    document.getElementById('buy-preview').classList.add('hidden');
    updateStepIndicators('ONRAMP');
    return;
  }
  setFmt('buy-receive', receive, 4);
  // Update preview
  const preview = document.getElementById('buy-preview');
  const previewFiat = document.getElementById('buy-preview-fiat');
  const previewCrypto = document.getElementById('buy-preview-crypto');
  const previewUsd = document.getElementById('buy-preview-usd');
  if (amount > 0) {
    previewFiat.textContent = `₦${amount.toLocaleString()}`;
    const tokenUsd = Number(PAJ_TOKEN_PRICES[currentBuyAsset] || 0);
    const usdVal = tokenUsd ? (receive * tokenUsd).toFixed(2) : (currentRate.paj ? (amount / currentRate.paj).toFixed(2) : '');
    previewUsd.textContent = usdVal ? `(~$${usdVal})` : '';
    previewCrypto.textContent = `${receive.toFixed(4)} ${currentBuyAsset || 'USDT'}`;
    setPreviewRate('buy', amount, receive, currentBuyAsset || 'USDT');
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
    previewUsd.textContent = '';
  }
  updateStepIndicators('ONRAMP');
}

async function fetchPajValue(fiatAmount) {
  const mint = PAJ_MINTS[currentBuyAsset];
  if (!mint) return null;
  try {
    const res = await fetch(`${API_BASE}/api/paj/value`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiatAmount, mint })
    });
    if (!res.ok) throw new Error('Failed to fetch PAJ value');
    const payload = await res.json();
    const data = payload.data;
    let tokenAmount = null;
    if (typeof data === 'number' && data > 0) {
      tokenAmount = data;
    } else if (data && typeof data === 'object') {
      if (data.amount !== undefined && Number(data.amount) > 0) {
        tokenAmount = Number(data.amount);
      } else if (data.tokenRate && data.tokenRate > 0) {
        tokenAmount = fiatAmount / data.tokenRate;
      }
    }
    if (tokenAmount !== null) {
      setFmt('buy-receive', tokenAmount, 4);
      const preview = document.getElementById('buy-preview');
      const previewFiat = document.getElementById('buy-preview-fiat');
      const previewCrypto = document.getElementById('buy-preview-crypto');
      const previewUsd = document.getElementById('buy-preview-usd');
      previewFiat.textContent = `₦${Number(fiatAmount).toLocaleString()}`;
      const usdVal = currentRate.paj ? (fiatAmount / currentRate.paj).toFixed(2) : '';
      previewUsd.textContent = usdVal ? `(~$${usdVal})` : '';
      previewCrypto.textContent = `${tokenAmount.toFixed(4)} ${currentBuyAsset}`;
      setPreviewRate('buy', Number(fiatAmount), tokenAmount, currentBuyAsset);
      preview.classList.remove('hidden');
      return tokenAmount;
    }
  } catch (err) {
    // PAJ value fetch failed — leave field blank
  }
  return null;
}

function calculateBuyFromCrypto() {
  const crypto = getNum('buy-receive');
  if (!crypto || crypto <= 0) {
    setFmt('buy-amount', '', 2);
    document.getElementById('buy-preview').classList.add('hidden');
    return;
  }
  let ngn = 0;
  if (currentProvider === 'paj') {
    const approxRate = computePajTokenRate(currentBuyAsset);
    const feePercent = typeof currentPajFee === 'number' ? currentPajFee : 0.5;
    // User inputs crypto -> Naira amount includes developer profit
    const feeFactor = feePercent > 0 && feePercent < 100 ? (1 - (feePercent / 100)) : 1;
    ngn = approxRate > 0 ? ((crypto * approxRate) / feeFactor) : 0;
  } else {
    const feePercent = currentFee;
    const feeFactor = feePercent > 0 && feePercent < 100 ? (1 - (feePercent / 100)) : 1;
    ngn = currentRate.buy > 0 ? ((crypto * currentRate.buy) / feeFactor) : 0;
  }
  setFmt('buy-amount', ngn, 2);
  validateBuyLimit(ngn);

  // Update preview card
  const preview = document.getElementById('buy-preview');
  const previewFiat = document.getElementById('buy-preview-fiat');
  const previewCrypto = document.getElementById('buy-preview-crypto');
  const previewUsd = document.getElementById('buy-preview-usd');
  if (preview && previewFiat && previewCrypto) {
    previewFiat.textContent = `₦${Number(ngn.toFixed(2)).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const usdVal = currentRate.paj ? (ngn / currentRate.paj).toFixed(2) : '';
    if (previewUsd) previewUsd.textContent = usdVal ? `(~$${usdVal})` : '';
    previewCrypto.textContent = `${crypto.toFixed(4)} ${currentBuyAsset}`;
    setPreviewRate('buy', ngn, crypto, currentBuyAsset);
    preview.classList.remove('hidden');
  }
  updateStepIndicators('ONRAMP');
}

// ─── Keyboard access for the coin, network and bank pickers ───
// Options are rendered from many templates, so they are made focusable here as they appear
// rather than in each template. Enter/Space selects, arrows move, Escape returns to the trigger.
const PICKER_LISTS = {
  'sell-asset-list': { trigger: '#sell-asset-wrap [role="button"]', search: 'sell-asset-search' },
  'buy-asset-list': { trigger: '#buy-asset-wrap [role="button"]', search: 'buy-asset-search' },
  'sell-network-options': { trigger: '#sell-network-wrap' },
  'buy-network-options': { trigger: '#buy-network-wrap' },
  'sell-bank-options': { trigger: '#sell-bank-wrap [role="button"]', search: 'bank-filter' },
};
const PICKER_ITEM = '.asset-picker-item, .custom-option[data-network], .custom-option[data-bank-name]';
let usingKeyboard = false;
document.addEventListener('keydown', () => { usingKeyboard = true; }, true);
document.addEventListener('pointerdown', () => { usingKeyboard = false; }, true);

// The list an element belongs to, counting each list's search box (which sits outside it).
function pickerListOf(el) {
  for (const [id, cfg] of Object.entries(PICKER_LISTS)) {
    const list = document.getElementById(id);
    if (list && (list.contains(el) || (cfg.search && el.id === cfg.search))) return list;
  }
  return null;
}
function visiblePickerItems(list) {
  return [...list.querySelectorAll(PICKER_ITEM)].filter(i => i.getClientRects().length > 0);
}
function markPickerItems(list) {
  list.querySelectorAll(PICKER_ITEM).forEach(item => {
    if (item.hasAttribute('tabindex')) return;
    item.setAttribute('tabindex', '0');
    item.setAttribute('role', 'option');
  });
}
function focusPickerTrigger(list) {
  document.querySelector(PICKER_LISTS[list.id].trigger)?.focus({ preventScroll: true });
}
// When a list opens from the keyboard, move focus into it: the search box if it has one,
// otherwise the selected (or first) option.
function focusIntoPicker(list) {
  const search = PICKER_LISTS[list.id].search && document.getElementById(PICKER_LISTS[list.id].search);
  if (search && search.getClientRects().length > 0) { search.focus({ preventScroll: true }); return; }
  const items = visiblePickerItems(list);
  (items.find(i => i.classList.contains('selected')) || items[0])?.focus({ preventScroll: true });
}

document.addEventListener('DOMContentLoaded', () => {
  Object.keys(PICKER_LISTS).forEach(id => {
    const list = document.getElementById(id);
    if (!list) return;
    list.setAttribute('role', 'listbox');
    markPickerItems(list);
    new MutationObserver(() => markPickerItems(list)).observe(list, { childList: true, subtree: true });
    // Asset lists live inside a modal and network/bank lists toggle 'open' on themselves.
    const opener = list.closest('.asset-picker-modal') || list;
    new MutationObserver(() => {
      if (usingKeyboard && opener.classList.contains('open') && !list.contains(document.activeElement)) {
        setTimeout(() => focusIntoPicker(list), 60);
      }
    }).observe(opener, { attributes: true, attributeFilter: ['class'] });
  });
});

document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  const list = pickerListOf(el);

  if (e.key === 'Enter' || e.key === ' ') {
    if (el.matches(PICKER_ITEM) && list) {
      e.preventDefault();
      el.click();
      // Selection closes the list; hand focus back to its trigger so the user can tab on.
      setTimeout(() => { if (!list.contains(document.activeElement)) focusPickerTrigger(list); }, 60);
    } else if (el.getAttribute('role') === 'button' && el.tagName !== 'BUTTON') {
      e.preventDefault();
      el.click();
    }
    return;
  }
  if (!list) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = visiblePickerItems(list);
    if (!items.length) return;
    e.preventDefault();
    const idx = items.indexOf(el);
    const next = idx === -1
      ? (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])
      : items[Math.min(items.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Escape') {
    setTimeout(() => focusPickerTrigger(list), 0);
  }
});
