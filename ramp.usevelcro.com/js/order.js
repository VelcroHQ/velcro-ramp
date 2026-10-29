// Velcro Convert — Order lifecycle: create, deposit details, confirm, status polling, reset.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

function showManualConfirm(type) {
  document.getElementById(type + '-manual-confirm').classList.remove('hidden');
  const input = document.getElementById(type + '-tx-hash');
  if (input) input.focus();
  // Ensure button is always re-enabled when reopening
  const btn = type === 'sell'
    ? document.querySelector('#sell-manual-confirm button[onclick]')
    : document.querySelector('#buy-confirm-form button[onclick]');
  if (btn) {
    btn.disabled = false;
    if (type === 'sell') {
      const text = btn.querySelector('.submit-text');
      const spinner = btn.querySelector('.submit-spinner');
      if (text) text.classList.remove('hidden');
      if (spinner) spinner.classList.add('hidden');
    } else {
      btn.textContent = "I've paid";
    }
  }
}

async function confirmProcessing(type) {
  const btn = document.getElementById((type === 'sell' ? '' : 'b') + 'status-3-confirm');
  if (!btn) return;
  const textSpan = btn.querySelector('.confirm-text');
  const loaderSpan = btn.querySelector('.confirm-loader');
  if (textSpan) textSpan.classList.add('hidden');
  if (loaderSpan) loaderSpan.classList.remove('hidden');
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: currentReference })
    });
    const payload = await res.json();
    if (res.ok) {
      showToast('Confirmation sent! Refreshing status...', 'success');
    } else {
      showToast(payload.message || 'Confirmation failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Failed to confirm', 'error');
  } finally {
    if (textSpan) textSpan.classList.remove('hidden');
    if (loaderSpan) loaderSpan.classList.add('hidden');
    btn.disabled = false;
  }
}

async function confirmManual(type) {
  let hash = '';
  if (type === 'sell') {
    hash = document.getElementById('sell-tx-hash').value.trim();
    if (!hash) { showToast('Please enter a transaction hash', 'warning'); return; }
  }

  // Show loading state for buy
  if (type === 'buy') {
    document.getElementById('buy-confirm-form').classList.add('hidden');
    document.getElementById('buy-confirm-loading').classList.remove('hidden');
    // Animate progress bar
    const progress = document.getElementById('buy-confirm-progress');
    if (progress) {
      setTimeout(() => progress.style.width = '30%', 100);
      setTimeout(() => progress.style.width = '60%', 2000);
      setTimeout(() => progress.style.width = '90%', 5000);
    }
  }

  const btn = type === 'sell'
    ? document.querySelector('#sell-manual-confirm button[onclick]')
    : document.querySelector('#buy-confirm-form button[onclick]');
  if (btn) {
    btn.disabled = true;
    if (type === 'sell') {
      const text = btn.querySelector('.submit-text');
      const spinner = btn.querySelector('.submit-spinner');
      if (text) text.classList.add('hidden');
      if (spinner) spinner.classList.remove('hidden');
    } else {
      btn.textContent = 'Verifying...';
    }
  }

  try {
    const body = { reference: currentReference };
    if (hash) body.hash = hash;

    const res = await fetch(`${API_BASE}/api/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await res.json();
    if (!res.ok) {
      showToast(payload.message || 'Confirmation failed', 'error');
      resetConfirmForm(type, btn);
      return;
    }
  } catch (err) {
    showToast(err.message || 'Failed to confirm', 'error');
    resetConfirmForm(type, btn);
    return;
  }

  // Success — hide manual confirm and let polling handle status updates
  document.getElementById(type + '-manual-confirm').classList.add('hidden');
  showToast('Payment confirmed! Processing your payout...', 'success');
  // Reset form for next time
  resetConfirmForm(type, btn);
}

function resetConfirmForm(type, btn) {
  if (type === 'buy') {
    document.getElementById('buy-confirm-form').classList.remove('hidden');
    document.getElementById('buy-confirm-loading').classList.add('hidden');
    const progress = document.getElementById('buy-confirm-progress');
    if (progress) progress.style.width = '0%';
  }
  if (btn) {
    btn.disabled = false;
    if (type === 'sell') {
      const text = btn.querySelector('.submit-text');
      const spinner = btn.querySelector('.submit-spinner');
      if (text) text.classList.remove('hidden');
      if (spinner) spinner.classList.add('hidden');
    } else {
      btn.textContent = "I've paid";
    }
  }
}

function swapPanels(type, btn) {
  const icon = btn.querySelector('i, svg');
  if (icon) icon.style.transform = 'rotate(180deg)';
  const isSell = type === 'sell';
  const container = document.getElementById(isSell ? 'form-sell' : 'form-buy');
  const sendPanel = document.getElementById(isSell ? 'sell-send-panel' : 'buy-send-panel');
  const receivePanel = document.getElementById(isSell ? 'sell-receive-panel' : 'buy-receive-panel');
  const btnWrapper = btn.parentElement;
  if (!sendPanel || !receivePanel) return;

  const sendFirst = Array.from(container.children).indexOf(sendPanel) < Array.from(container.children).indexOf(receivePanel);

  sendPanel.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  receivePanel.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  sendPanel.style.opacity = '0';
  receivePanel.style.opacity = '0';
  sendPanel.style.transform = sendFirst ? 'translateY(12px)' : 'translateY(-12px)';
  receivePanel.style.transform = sendFirst ? 'translateY(-12px)' : 'translateY(12px)';

  setTimeout(() => {
    if (sendFirst) {
      container.insertBefore(receivePanel, sendPanel);
      container.insertBefore(btnWrapper, sendPanel);
    } else {
      container.insertBefore(sendPanel, receivePanel);
      container.insertBefore(btnWrapper, receivePanel);
    }
    sendPanel.style.transform = sendFirst ? 'translateY(-12px)' : 'translateY(12px)';
    receivePanel.style.transform = sendFirst ? 'translateY(12px)' : 'translateY(-12px)';
    requestAnimationFrame(() => {
      sendPanel.style.opacity = '1';
      receivePanel.style.opacity = '1';
      sendPanel.style.transform = 'translateY(0)';
      receivePanel.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      sendPanel.style.transition = '';
      receivePanel.style.transition = '';
      if (icon) icon.style.transform = '';
    }, 300);
  }, 280);
}

async function generateWalletAddress() {
  const userEmail = (localStorage.getItem('velcro_user_email') || '').trim();
  if (!userEmail) {
    promptLoginOverlay(generateWalletAddress);
    return;
  }
  if (currentCountry !== 'NG') {
    showToast('Transactions for this country are currently disabled.', 'warning');
    return;
  }
  if (!currentSellAsset) { showToast('Please select an asset', 'warning'); return; }
  const amount = getNum('sell-amount');
  const receive = getNum('sell-receive');
  const anyAmount = currentProvider === 'hostfi'; // HostFi pays out whatever arrives
  if (!anyAmount && (!amount || amount <= 0)) { showToast('Please enter a valid amount', 'warning'); return; }
  if (!anyAmount && !validateSellLimit(amount)) { showToast(`Maximum sell amount is $${SELL_MAX_LIMIT.toLocaleString()} per transaction`, 'warning'); return; }
  
  const bankNum = document.getElementById('sell-bank-number').value.trim();
  const accountName = document.getElementById('sell-account-name').value.trim();
  if (!currentBankCode) { showToast('Please select your bank', 'warning'); return; }
  if (!bankNum || bankNum.length < 10) { showToast('Please enter a valid account number', 'warning'); return; }
  if (!accountName) { showToast('Please wait for account name verification', 'warning'); return; }

  const btn = document.getElementById('sell-btn');
  document.getElementById('sell-confirm-amount').textContent = Number(amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4});
  btn.innerHTML = '<svg class="animate-spin w-5 h-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Generating...';

  // Offramp flow
  if (currentProvider === 'hostfi') {
    const resetBtn = () => { btn.innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address'; safeLucideInit(); };
    if (!currentSellNetwork) { showToast('Please choose a coin and network', 'warning'); resetBtn(); return; }
    try {
      const res = await fetch(`${API_BASE}/api/hostfi/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset: currentSellAsset,
          network: currentSellNetwork,
          bankCode: currentBankSwitchCode || currentBankCode,
          bankName: currentBankName,
          accountNumber: bankNum,
          email: userEmail,
          ref: localStorage.getItem('velcro_ref') || ''
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.success) throw new Error(payload.message || 'Failed to create your deposit address');
      const data = payload.data;
      currentReference = data.reference;
      document.getElementById('sell-wallet-address').textContent = data.address;
      document.getElementById('sell-reference').textContent = data.reference;
      document.getElementById('sell-confirm-amount').textContent = 'Any amount of';
      document.getElementById('sell-memo').classList.toggle('hidden', !data.memo);
      safeSetText('sell-memo-value', data.memo || '');
      const explorerLink = document.getElementById('sell-status-explorer-link');
      if (explorerLink) explorerLink.href = getWalletExplorerUrl(data.address, data.chain);
      const qr = document.getElementById('sell-qr-code');
      qr.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(qr, { text: data.address, width: 160, height: 160, colorDark: '#0D0D59', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      }

      // Bitcoin waits for confirmations, so it gets a longer window and different expectations.
      const seconds = Number(data.expires_in) || 3600;
      const sendWindow = seconds >= 7200 ? `${Math.round(seconds / 3600)} hours` : `${Math.round(seconds / 60)} minutes`;
      safeSetText('sell-expiry-text', `Send within ${sendWindow}. If it arrives later, we still pay you at the rate when it confirms.`);
      safeSetText('sell-status-hint', data.chain === 'bitcoin'
        ? 'Bitcoin needs network confirmations, usually 10–60 minutes after you send. We pay your bank automatically once it confirms and email your receipt.'
        : 'We pay your bank automatically as soon as your deposit confirms, usually within a few minutes, and email your receipt.');
      document.getElementById('sell-generated-address').classList.remove('hidden');
      startExpiryCountdown('sell', seconds);
      startOrderHelp('sell', data.chain === 'bitcoin' ? 90 * 60 * 1000 : SUPPORT_HINT_DELAY_MS);
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 mr-2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Address ready';
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      lockSellForm();
      safeLucideInit();
      currentTxDetails = {
        type: 'sell',
        reference: data.reference,
        amount: null,
        destinationAmount: null,
        asset: currentSellAsset,
        network: data.chain,
        bankName: data.bank_name || currentBankName,
        accountNumber: bankNum,
        accountName: data.account_name || accountName,
        provider: 'hostfi'
      };
      saveRecentOrder(currentTxDetails);
      startStatusPoll(data.reference, 'sell', `/api/transactions/${encodeURIComponent(data.reference)}`);
    } catch (err) {
      resetBtn();
      showToast(err.message || 'Failed to create your deposit address', 'error');
    }
    return;
  }
  if (currentProvider === 'paj') {
    const mint = PAJ_MINTS[currentSellAsset];
    if (!mint) { showToast('Invalid asset selected', 'warning'); btn.innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address'; safeLucideInit(); return; }
    try {
      const bankId = currentBankPajId || currentBankCode;
      if (!bankId) { showToast('Selected bank is not supported for this asset', 'warning'); btn.innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address'; safeLucideInit(); return; }
      const res = await fetch(`${API_BASE}/api/paj/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fiatAmount: receive, 
          mint, 
          bank: bankId, 
          accountNumber: bankNum,
          email: localStorage.getItem('velcro_user_email') || '', ref: localStorage.getItem('velcro_ref') || ''
        })
      });
      const responseBody = await res.text();
      if (!res.ok) {
        let errorMsg = 'Failed to initiate sell transaction';
        try { const err = JSON.parse(responseBody); errorMsg = err.message || errorMsg; } catch { }
        throw new Error(errorMsg);
      }
      const payload = JSON.parse(responseBody);
      const data = payload.data || {};
      document.getElementById('sell-wallet-address').textContent = data.address || '-';
      document.getElementById('sell-reference').textContent = data.id || '-';
      currentReference = data.id || '';
      
      // Use exact crypto amount from PAJ response if available
      if (data.amount) {
        document.getElementById('sell-confirm-amount').textContent = Number(data.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
      }
      
      // Generate QR Code
      document.getElementById('sell-qr-code').innerHTML = '';
      new QRCode(document.getElementById('sell-qr-code'), {
        text: data.address,
        width: 160,
        height: 160,
        colorDark: "#0D0D59",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
      });

      document.getElementById('sell-generated-address').classList.remove('hidden');
      startExpiryCountdown('sell', 3600);
      startOrderHelp('sell');
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 mr-2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Address ready';
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      lockSellForm();
      safeLucideInit();
      currentTxDetails = {
        type: 'sell',
        reference: data.id,
        amount: amount,
        destinationAmount: receive,
        asset: currentSellAsset,
        network: 'solana',
        bankName: document.getElementById('sell-bank-display').textContent.trim(),
        accountNumber: bankNum,
        accountName: accountName,
        provider: 'paj'
      };
      saveRecentOrder(currentTxDetails);
      startPajStatusPoll(data.id, 'sell');
    } catch (err) {
      btn.innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address';
      safeLucideInit();
      showToast(err.message || 'Failed to generate address', 'error');
    }
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: 'OFFRAMP',
        amount,
        country: currentCountry,
        currency: currentCurrency,
        asset: currentSwitchAsset,
        channel: (currentCountry === 'GH' || currentCountry === 'KE') ? 'MOBILEMONEY' : 'BANK',
        reason: 'PERSONAL_TRANSFER',
        narration: 'Crypto Offramp Settlement',
        beneficiary: {
          holder_type: 'INDIVIDUAL',
          holder_name: accountName,
          account_number: bankNum,
          bank_code: currentBankSwitchCode || currentBankCode
        },
        email: localStorage.getItem('velcro_user_email') || '', ref: localStorage.getItem('velcro_ref') || ''
      })
    });
    if (!res.ok) {
      const errorText = await res.text();
      let errorMsg = 'Failed to initiate transaction';
      try { const err = JSON.parse(errorText); errorMsg = err.message || errorMsg; } catch { }
      throw new Error(errorMsg);
    }
    const payload = await res.json();
    const data = payload.data || {};
    const deposit = data.deposit || {};
    const walletAddress = (typeof deposit === 'string' ? deposit : deposit.address) || data.address || data.pubkey || data.deposit_address || data.wallet_address || '-';
    document.getElementById('sell-wallet-address').textContent = walletAddress;
    document.getElementById('sell-reference').textContent = data.reference || '-';
    currentReference = data.reference || '';
    // Update explorer link in status tracker
    const statusExplorerLink = document.getElementById('sell-status-explorer-link');
    const net = (currentProvider === 'paj' ? 'solana' : currentSellNetwork) || 'solana';
    if (statusExplorerLink && walletAddress && walletAddress !== '-') {
      statusExplorerLink.href = getWalletExplorerUrl(walletAddress, net);
    } else if (statusExplorerLink) {
      statusExplorerLink.href = '#';
    }
    // Generate QR code for wallet address (local)
    const qrContainer = document.getElementById('sell-qr-code');
    if (qrContainer && walletAddress !== '-') {
      qrContainer.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(qrContainer, {
          text: walletAddress,
          width: 160,
          height: 160,
          colorDark: '#0D0D59',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    }
    document.getElementById('sell-generated-address').classList.remove('hidden');
    startExpiryCountdown('sell', 3600);
    startOrderHelp('sell');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 mr-2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Address ready';
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    lockSellForm();
    safeLucideInit();
    // Store tx details for success modal
    const bankDisplay = document.getElementById('sell-bank-display').textContent.trim();
    currentTxDetails = {
      type: 'sell',
      reference: data.reference,
      amount: amount,
      destinationAmount: data.destination?.amount || data.destination_amount,
      bankName: bankDisplay !== 'Select your bank' ? bankDisplay : '-',
      accountNumber: bankNum,
      accountName: accountName,
      asset: currentSellAsset,
      network: currentSellNetwork
    };
    saveRecentOrder(currentTxDetails);
    startStatusPoll(data.reference, 'sell');
  } catch (err) {
    btn.innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address';
    safeLucideInit();
    showToast(err.message || 'Failed to generate address', 'error');
  }
}

function validateWalletInput() {
  const wallet = document.getElementById('buy-wallet').value.trim();
  const errorEl = document.getElementById('buy-wallet-error');
  if (!wallet) { errorEl.classList.add('hidden'); return; }
  if (!validateWalletAddress(wallet, currentBuyNetwork)) {
    errorEl.textContent = `Invalid ${currentBuyNetwork} wallet address format`;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
  }
}

function validateWalletAddress(address, network) {
  const evmRegex = /^0x[a-fA-F0-9]{40}$/;
  const solanaRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const tronRegex = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
  if (network === 'solana') return solanaRegex.test(address);
  if (network === 'tron') return tronRegex.test(address);
  // All other networks (including all EVM chains from Switch) use EVM address format
  return evmRegex.test(address);
}

async function generateBankAccount() {
  const userEmail = (localStorage.getItem('velcro_user_email') || '').trim();
  if (!userEmail) {
    promptLoginOverlay(generateBankAccount);
    return;
  }
  if (currentCountry !== 'NG') {
    showToast('Transactions for this country are currently disabled.', 'warning');
    return;
  }
  if (!currentBuyAsset) { showToast('Please select an asset', 'warning'); return; }
  const amount = getNum('buy-amount');
  const receive = getNum('buy-receive');
  const minBuyLimit = getEffectiveBuyMinLimit();
  if (!amount || amount < minBuyLimit) {
    if (isUsdtOrUsdcOnTrxOrEth()) {
      showToast(`Minimum buy amount for USDT/USDC on TRON/Ethereum is $5 worth (₦${minBuyLimit.toLocaleString()})`, 'warning');
    } else {
      showToast(`Minimum buy amount is ₦${minBuyLimit.toLocaleString()}`, 'warning');
    }
    return;
  }
  if (amount > BUY_MAX_LIMIT) { showToast(`Maximum buy amount is ₦${BUY_MAX_LIMIT.toLocaleString()} per transaction`, 'warning'); return; }
  const wallet = document.getElementById('buy-wallet').value.trim();
  if (!wallet) { showToast('Please enter your wallet address', 'warning'); return; }

  const btn = document.getElementById('buy-btn');
  document.getElementById('buy-confirm-ngn').textContent = Number(amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  btn.innerHTML = '<svg class="animate-spin w-5 h-5 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Generating...';

  // Onramp flow
  if (currentProvider === 'paj') {
    const mint = PAJ_MINTS[currentBuyAsset];
    if (!mint) { showToast('Invalid asset selected', 'warning'); btn.innerHTML = '<i data-lucide="landmark" class="w-5 h-5"></i> Get payment details'; safeLucideInit(); return; }
    try {
      const res = await fetch(`${API_BASE}/api/paj/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fiatAmount: amount, 
          recipient: wallet, 
          mint,
          email: localStorage.getItem('velcro_user_email') || '', ref: localStorage.getItem('velcro_ref') || ''
        })
      });
      const responseBody = await res.text();
      if (!res.ok) {
        let errorMsg = 'Failed to initiate transaction';
        try { const err = JSON.parse(responseBody); errorMsg = err.message || errorMsg; } catch { }
        throw new Error(errorMsg);
      }
      const payload = JSON.parse(responseBody);
      const data = payload.data || {};
      const exactPayAmount = Number(data.fiatAmount) > 0 ? Number(data.fiatAmount) : amount;
      document.getElementById('buy-confirm-ngn').textContent = Number(exactPayAmount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('buy-bank-name').textContent = data.bank || 'Partner Bank';
      document.getElementById('buy-account-number').textContent = data.accountNumber || '-';
      document.getElementById('buy-account-name').textContent = data.accountName || 'Velcro Checkout';
      document.getElementById('buy-reference').textContent = data.id || '-';
      currentReference = data.id || '';
      document.getElementById('buy-generated-account').classList.remove('hidden');
      startExpiryCountdown('buy', 3600);
      startOrderHelp('buy');
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 mr-2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Payment details ready';
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      lockBuyForm();
      safeLucideInit();
      currentTxDetails = {
        type: 'buy',
        reference: data.id,
        amount: exactPayAmount,
        destinationAmount: data.amount || receive,
        asset: currentBuyAsset,
        network: 'solana',
        walletAddress: wallet,
        provider: 'paj'
      };
      saveRecentOrder(currentTxDetails);
      startPajStatusPoll(data.id);
    } catch (err) {
      btn.innerHTML = '<i data-lucide="landmark" class="w-5 h-5"></i> Get payment details';
      safeLucideInit();
      showToast(err.message || 'Failed to generate account', 'error');
    }
    return;
  }

  // Switch Provider flow
  if (!currentBuyNetwork || document.getElementById('buy-network-display').textContent.trim() === 'Choose network') { showToast('Please select a network', 'warning'); return; }
  const minDollars = isUsdtOrUsdcOnTrxOrEth() ? 5 : 1;
  if (receive < minDollars) { showToast(`Minimum receive amount for this asset/network is $${minDollars}`, 'warning'); return; }
  if (!validateWalletAddress(wallet, currentBuyNetwork)) {
    showToast(`Invalid ${currentBuyNetwork} wallet address`, 'warning'); return;
  }
  if (!currentSwitchAsset) { showToast('Please select a valid asset and network', 'warning'); return; }
  try {
    const res = await fetch(`${API_BASE}/api/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: 'ONRAMP',
        amount,
        country: currentCountry,
        currency: currentCurrency,
        asset: currentSwitchAsset,
        channel: (currentCountry === 'GH' || currentCountry === 'KE') ? 'MOBILEMONEY' : 'BANK',
        reason: 'PERSONAL_TRANSFER',
        narration: 'Crypto Onramp Settlement',
        wallet_address: wallet,
        beneficiary: {
          holder_type: 'INDIVIDUAL',
          holder_name: 'Customer',
          wallet_address: wallet
        },
        email: localStorage.getItem('velcro_user_email') || '', ref: localStorage.getItem('velcro_ref') || ''
      })
    });
    const responseBody = await res.text();
    if (!res.ok) {
      let errorMsg = 'Failed to initiate transaction';
      try { const err = JSON.parse(responseBody); errorMsg = err.message || errorMsg; } catch { }
      throw new Error(errorMsg);
    }
    const payload = JSON.parse(responseBody);
    const data = payload.data || {};
    const deposit = data.deposit || {};
    document.getElementById('buy-bank-name').textContent = deposit.bank_name || data.bank_name || '-';
    document.getElementById('buy-account-number').textContent = deposit.account_number || data.account_number || '-';
    document.getElementById('buy-account-name').textContent = 'Velcro(switchLabsLtd. checkout)';
    document.getElementById('buy-reference').textContent = data.reference || '-';
    currentReference = data.reference || '';
    document.getElementById('buy-generated-account').classList.remove('hidden');
    startExpiryCountdown('buy', 3600);
    startOrderHelp('buy');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 mr-2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Payment details ready';
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    lockBuyForm();
    safeLucideInit();
    // Store tx details for success modal
    currentTxDetails = {
      type: 'buy',
      reference: data.reference,
      amount: amount,
      destinationAmount: data.destination?.amount || data.destination_amount || receive,
      asset: currentBuyAsset,
      network: currentBuyNetwork,
      walletAddress: wallet
    };
    saveRecentOrder(currentTxDetails);
    startStatusPoll(data.reference, 'buy');
  } catch (err) {
    btn.innerHTML = '<i data-lucide="landmark" class="w-5 h-5"></i> Get payment details';
    safeLucideInit();
    showToast(err.message || 'Failed to generate account', 'error');
  }
}


// Order-page help: name the exact coin/network next to the deposit address, and offer
// support if the payment still hasn't landed after 10 minutes.
const SUPPORT_HINT_DELAY_MS = 10 * 60 * 1000;
const supportHintTimers = {};
function startOrderHelp(type, delayMs = SUPPORT_HINT_DELAY_MS) {
  if (type === 'sell') {
    safeSetText('sell-warn-asset', document.getElementById('sell-asset-name')?.textContent || '');
    safeSetText('sell-warn-network', document.getElementById('sell-network-name')?.textContent || '');
  }
  stopOrderHelp(type);
  supportHintTimers[type] = setTimeout(() => {
    document.getElementById(type + '-support-hint')?.classList.remove('hidden');
  }, delayMs);
}
function stopOrderHelp(type) {
  clearTimeout(supportHintTimers[type]);
  document.getElementById(type + '-support-hint')?.classList.add('hidden');
}

let buyExpiryInterval = null;
let sellExpiryInterval = null;

function startExpiryCountdown(type, totalSeconds = 3600) {
  const isBuy = (type === 'buy');
  const timerEl = document.getElementById(isBuy ? 'buy-timer' : 'sell-timer');
  if (isBuy && buyExpiryInterval) { clearInterval(buyExpiryInterval); buyExpiryInterval = null; }
  if (!isBuy && sellExpiryInterval) { clearInterval(sellExpiryInterval); sellExpiryInterval = null; }

  let remaining = totalSeconds;
  const updateDisplay = () => {
    if (!timerEl) return;
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    const mmss = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    timerEl.textContent = hours > 0 ? `${hours}:${mmss}` : mmss;
    if (remaining <= 300) {
      timerEl.className = 'text-xs font-mono font-bold bg-red-100 text-red-700 px-2 py-1 rounded-md';
    } else {
      timerEl.className = 'text-xs font-mono font-bold bg-amber-200/80 text-amber-900 px-2 py-1 rounded-md';
    }
  };

  updateDisplay();
  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      if (timerEl) {
        timerEl.textContent = 'Expired';
        timerEl.className = 'text-xs font-mono font-bold bg-red-200 text-red-900 px-2 py-1 rounded-md';
      }
    } else {
      updateDisplay();
    }
  }, 1000);

  if (isBuy) buyExpiryInterval = interval;
  else sellExpiryInterval = interval;
}

// statusUrl: Switch orders use /api/status; HostFi orders are read from our own order record.
// HostFi order screen: a failed payout turns the "Processing payout" step into a retry. The
// Switch "Confirm" button on that step means nothing for HostFi, so it is hidden otherwise.
function applyHostfiProgress(reference, progress) {
  const btn = document.getElementById('status-3-confirm');
  const title = document.querySelector('#status-3 .text-sm');
  const failed = progress.find(d => d.payout === 'failed');
  if (title && title.firstChild) title.firstChild.textContent = failed ? 'Payout failed' : 'Processing payout';
  if (!btn) return;
  if (failed && failed.can_retry) {
    btn.querySelector('.confirm-text').textContent = 'Retry payout';
    btn.onclick = () => retryHostfiPayout(reference, null);
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function startStatusPoll(reference, type = 'buy', statusUrl = `/api/status?reference=${encodeURIComponent(reference)}`) {
  let reviewNotified = false;
  if (statusPollInterval) { clearTimeout(statusPollInterval); clearInterval(statusPollInterval); statusPollInterval = null; }
  activePollReference = reference;
  activePollType = 'standard';
  activePollTxType = type;
  pollCount = 0;
  isPollingPaused = false;

  const doPoll = async () => {
    if (document.hidden) {
      isPollingPaused = true;
      return;
    }
    pollCount++;
    try {
      const res = await fetch(`${API_BASE}${statusUrl}`);
      if (res.ok) {
        const payload = await res.json();
        const data = payload.data || {};
        const status = data.status || payload.status;
        updateStatusUI(status, type);
        if (type === 'sell' && Array.isArray(data.hostfi_progress)) applyHostfiProgress(reference, data.hostfi_progress);
        if (status === 'REVIEW' && !reviewNotified) {
          reviewNotified = true;
          showToast("Your deposit needs a quick manual check. We'll email you once it's paid.", 'info');
          document.getElementById(type + '-support-hint')?.classList.remove('hidden');
        }

        if (type === 'sell') {
          const sellExpLink = document.getElementById('sell-status-explorer-link');
          const txHash = data.hash || data.signature || '';
          const txExplorer = data.explorer_url || (txHash ? getExplorerUrl(txHash, currentSellNetwork) : '');
          if (sellExpLink && txExplorer && txExplorer !== '#') {
            sellExpLink.href = txExplorer;
          }
          const actualSent = data.source?.amount || data.source_amount;
          if (actualSent && Number(actualSent) > 0) {
            const confirmAmtEl = document.getElementById('sell-confirm-amount');
            if (confirmAmtEl) {
              confirmAmtEl.textContent = Number(actualSent).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
            }
          }
        }

        if (type === 'buy' && status === 'COMPLETED') {
          const explorerUrl = data.explorer_url || currentTxDetails.explorerUrl || '';
          const txHash = data.hash || currentTxDetails.hash || '';
          if (txHash) currentTxDetails.hash = txHash;
          if (explorerUrl) currentTxDetails.explorerUrl = explorerUrl;
          const explorerLink = document.getElementById('buy-explorer-link');
          const statusDetail = document.getElementById('buy-status-detail');
          if (explorerLink) {
            if (explorerUrl) {
              explorerLink.href = explorerUrl;
              explorerLink.classList.remove('hidden');
            } else if (txHash) {
              explorerLink.href = getExplorerUrl(txHash, currentBuyNetwork);
              explorerLink.classList.remove('hidden');
            }
          }
          if (statusDetail && txHash) {
            statusDetail.textContent = `Tx: ${txHash.slice(0, 12)}...${txHash.slice(-8)}`;
          }
        }

        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
          activePollReference = null;
          activePollType = null;
          if (statusPollInterval) { clearTimeout(statusPollInterval); statusPollInterval = null; }
          if (status === 'COMPLETED') {
            showToast('Transaction Completed Successfully!', 'success');
            const txHash = data.hash || currentTxDetails.hash || '';
            const txExplorer = data.explorer_url || currentTxDetails.explorerUrl || '';
            const realAmount = data.source?.amount || data.source_amount || (type === 'sell' && data.amount ? data.amount : currentTxDetails.amount);
            const realDestAmount = data.destination?.amount || data.destination_amount || currentTxDetails.destinationAmount;
            const isBuy = (type === 'buy');
            const cryptoVal = isBuy ? realDestAmount : realAmount;
            const fiatVal = isBuy ? realAmount : realDestAmount;
            const modalData = {
              reference: currentTxDetails.reference || data.reference || '',
              amount: realAmount,
              destinationAmount: realDestAmount,
              cryptoAmount: cryptoVal,
              fiatAmount: fiatVal,
              paidAmount: isBuy ? fiatVal : null,
              bankName: currentTxDetails.bankName,
              accountNumber: currentTxDetails.accountNumber,
              accountName: currentTxDetails.accountName,
              asset: currentTxDetails.asset || currentBuyAsset || currentSellAsset,
              network: currentTxDetails.network || currentBuyNetwork || currentSellNetwork,
              walletAddress: currentTxDetails.walletAddress || data.wallet_address || '',
              explorerUrl: txExplorer,
              hash: txHash
            };
            currentTxDetails.amount = realAmount;
            currentTxDetails.destinationAmount = realDestAmount;
            currentTxDetails.hash = txHash;
            currentTxDetails.explorerUrl = txExplorer;
            setTimeout(() => showSuccessModal(type, modalData), 1500);
          } else if (status === 'FAILED') {
            showToast('Transaction Failed. Please contact support.', 'error');
          }
          return;
        }
      }
    } catch (e) { }

    let delay = 5000;
    if (pollCount > 12) delay = 15000;
    else if (pollCount > 6) delay = 10000;
    statusPollInterval = setTimeout(doPoll, delay);
  };

  doPoll();
}

function startPajStatusPoll(txId, type = 'buy') {
  if (statusPollInterval) { clearTimeout(statusPollInterval); clearInterval(statusPollInterval); statusPollInterval = null; }
  activePollReference = txId;
  activePollType = 'paj';
  activePollTxType = type;
  pollCount = 0;
  isPollingPaused = false;

  const doPoll = async () => {
    if (document.hidden) {
      isPollingPaused = true;
      return;
    }
    pollCount++;
    try {
      const res = await fetch(`${API_BASE}/api/paj/status?id=${encodeURIComponent(txId)}`);
      if (res.ok) {
        const payload = await res.json();
        const data = payload.data || {};
        const status = data.status || 'INIT';
        const statusMap = {
          'INIT': 'AWAITING_DEPOSIT',
          'PAID': 'DETECTED',
          'PROCESSING': 'PROCESSING',
          'COMPLETED': 'COMPLETED',
          'FAILED': 'FAILED',
          'CANCELLED': 'CANCELLED'
        };
        const mappedStatus = statusMap[status] || status;
        updateStatusUI(mappedStatus, type);

        if (type === 'sell') {
          const sellExpLink = document.getElementById('sell-status-explorer-link');
          const txHash = data.signature || data.hash || '';
          const depositAddr = data.address || data.pubkey || data.deposit_address || data.recipient || '';
          if (sellExpLink) {
            if (txHash) {
              sellExpLink.href = `https://solscan.io/tx/${txHash}`;
            } else if (depositAddr) {
              sellExpLink.href = `https://solscan.io/account/${depositAddr}`;
            }
          }
        }

        if (status === 'COMPLETED') {
          const txHash = data.signature || data.hash || '';
          const explorerLink = document.getElementById((type === 'sell' ? '' : 'buy') + '-explorer-link');
          const statusDetail = document.getElementById((type === 'sell' ? '' : 'buy') + '-status-detail');

          if (explorerLink && txHash) {
            explorerLink.href = `https://solscan.io/tx/${txHash}`;
            explorerLink.classList.remove('hidden');
          }
          if (statusDetail && txHash) {
            statusDetail.textContent = `Tx: ${txHash.slice(0, 12)}...${txHash.slice(-8)}`;
          }
        }

        if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
          activePollReference = null;
          activePollType = null;
          if (statusPollInterval) { clearTimeout(statusPollInterval); statusPollInterval = null; }
          if (status === 'COMPLETED') {
            showToast('Transaction Completed Successfully!', 'success');
            const txHash = data.signature || data.hash || '';
            const isBuy = (type === 'buy');
            const cryptoVal = isBuy ? (data.amount || currentTxDetails.destinationAmount) : (data.amount || currentTxDetails.amount);
            const fiatVal = isBuy ? (data.fiatAmount || currentTxDetails.amount) : (data.fiatAmount || currentTxDetails.destinationAmount);
            const modalData = {
              reference: currentTxDetails.reference || txId,
              amount: fiatVal,
              destinationAmount: isBuy ? cryptoVal : fiatVal,
              cryptoAmount: cryptoVal,
              fiatAmount: fiatVal,
              paidAmount: isBuy ? fiatVal : null,
              asset: currentTxDetails.asset || 'SOL',
              network: 'solana',
              bankName: currentTxDetails.bankName,
              accountNumber: currentTxDetails.accountNumber,
              accountName: currentTxDetails.accountName,
              walletAddress: currentTxDetails.walletAddress || data.recipient || '',
              explorerUrl: txHash ? `https://solscan.io/tx/${txHash}` : '',
              hash: txHash
            };
            currentTxDetails.destinationAmount = cryptoVal;
            currentTxDetails.amount = fiatVal;
            currentTxDetails.hash = txHash;
            if (txHash) currentTxDetails.explorerUrl = `https://solscan.io/tx/${txHash}`;
            setTimeout(() => showSuccessModal(type, modalData), 1500);
          } else if (status === 'FAILED') {
            showToast('Transaction Failed. Please contact support.', 'error');
          }
          return;
        }
      }
    } catch (e) { }

    let delay = 5000;
    if (pollCount > 12) delay = 15000;
    else if (pollCount > 6) delay = 10000;
    statusPollInterval = setTimeout(doPoll, delay);
  };

  doPoll();
}

function getExplorerUrl(hash, network) {
  const explorers = {
    'solana': `https://solscan.io/tx/${hash}`,
    'ethereum': `https://etherscan.io/tx/${hash}`,
    'bsc': `https://bscscan.com/tx/${hash}`,
    'polygon': `https://polygonscan.com/tx/${hash}`,
    'arbitrum': `https://arbiscan.io/tx/${hash}`,
    'base': `https://basescan.org/tx/${hash}`,
    'tron': `https://tronscan.org/#/transaction/${hash}`,
    'bitcoin': `https://mempool.space/tx/${hash}`,
    'sui': `https://suivision.xyz/txblock/${hash}`,
    'optimism': `https://optimistic.etherscan.io/tx/${hash}`,
    'avalanche': `https://snowtrace.io/tx/${hash}`,
    'gnosis': `https://gnosisscan.io/tx/${hash}`,
    'celo': `https://celoscan.io/tx/${hash}`,
    'linea': `https://lineascan.build/tx/${hash}`,
    'sonic': `https://sonicscan.org/tx/${hash}`,
    'monad': `https://monadscan.io/tx/${hash}`,
    'plasma': `https://plasmascan.io/tx/${hash}`,
    'mantle': `https://mantlescan.info/tx/${hash}`,
    'hyperevm': `https://hyperevmscan.io/tx/${hash}`,
    'berachain': `https://berascan.io/tx/${hash}`
  };
  return explorers[String(network || '').toLowerCase()] || '#';
}

function getWalletExplorerUrl(address, network) {
  const explorers = {
    'solana': `https://solscan.io/account/${address}`,
    'ethereum': `https://etherscan.io/address/${address}`,
    'bsc': `https://bscscan.com/address/${address}`,
    'polygon': `https://polygonscan.com/address/${address}`,
    'arbitrum': `https://arbiscan.io/address/${address}`,
    'base': `https://basescan.org/address/${address}`,
    'tron': `https://tronscan.org/#/address/${address}`,
    'bitcoin': `https://mempool.space/address/${address}`,
    'sui': `https://suivision.xyz/account/${address}`,
    'optimism': `https://optimistic.etherscan.io/address/${address}`,
    'avalanche': `https://snowtrace.io/address/${address}`,
    'gnosis': `https://gnosisscan.io/address/${address}`,
    'celo': `https://celoscan.io/address/${address}`,
    'linea': `https://lineascan.build/address/${address}`,
    'sonic': `https://sonicscan.org/address/${address}`,
    'monad': `https://monadscan.io/address/${address}`,
    'plasma': `https://plasmascan.io/address/${address}`,
    'mantle': `https://mantlescan.info/address/${address}`,
    'hyperevm': `https://hyperevmscan.io/address/${address}`,
    'berachain': `https://berascan.io/address/${address}`
  };
  return explorers[String(network || '').toLowerCase()] || '#';
}

// Each step shows the time it was first reached. A reset (stamp = false) clears the times.
function stampStep(el, titleEl) {
  if (!titleEl || el.dataset.reachedAt) return;
  el.dataset.reachedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const t = document.createElement('span');
  t.className = 'step-time font-normal text-gray-400';
  t.textContent = ' · ' + el.dataset.reachedAt;
  titleEl.appendChild(t);
}
function clearStepStamp(el) {
  delete el.dataset.reachedAt;
  el.querySelector('.step-time')?.remove();
}

function updateStatusUI(status, type, stamp = true) {
  const prefix = type === 'sell' ? '' : 'b';
  const steps = [
    document.getElementById(prefix + 'status-1'),
    document.getElementById(prefix + 'status-2'),
    document.getElementById(prefix + 'status-3'),
    document.getElementById(prefix + 'status-4')
  ];
  const stepIcons = ['clock', 'search', 'refresh-cw', 'check-circle'];
  const statusMap = {
    'AWAITING_DEPOSIT': 1, 'PENDING': 1, 'INITIATED': 1,
    'DETECTED': 2, 'CONFIRMED': 2, 'RECEIVED': 2, 'VERIFIED': 2,
    'PROCESSING': 3, 'REVIEW': 3,
    'COMPLETED': 4, 'FAILED': 4, 'EXPIRED': 4, 'CANCELLED': 4
  };
  const step = statusMap[status] || 1;
  if (step >= 2) stopOrderHelp(type);
  const isFailed = status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED';
  const isCompleted = status === 'COMPLETED';

  steps.forEach((el, idx) => {
    if (!el) return;
    const targetStep = idx + 1;
    const iconContainer = el.querySelector('div[class*="rounded-full"]');
    const titleEl = el.querySelector('.text-sm');
    if (!stamp || targetStep > step) clearStepStamp(el);
    else stampStep(el, titleEl);

    if (targetStep === step) {
      // CURRENT step — active styling
      el.classList.remove('opacity-50', 'bg-gray-50');
      el.classList.add('bg-amber-50');
      if (iconContainer) {
        iconContainer.classList.remove('bg-gray-200');
        iconContainer.classList.add('bg-amber-100');
        // Restore original icon
        iconContainer.innerHTML = `<i data-lucide="${stepIcons[idx]}" class="w-4 h-4 text-amber-600"></i>`;
      }
      if (titleEl) {
        titleEl.classList.remove('text-gray-500');
        titleEl.classList.add('text-amber-700');
      }
      // Show confirm button on step 3 when processing
      const confirmBtn = document.getElementById(prefix + 'status-3-confirm');
      if (confirmBtn && targetStep === 3) {
        confirmBtn.classList.remove('hidden');
      }
    } else if (targetStep < step) {
      // COMPLETED steps — green styling + tick icon
      el.classList.remove('opacity-50', 'bg-gray-50', 'bg-amber-50');
      el.classList.add('bg-green-50');
      if (iconContainer) {
        iconContainer.classList.remove('bg-gray-200', 'bg-amber-100');
        iconContainer.classList.add('bg-green-100');
        // Replace with tick icon
        iconContainer.innerHTML = `<svg class="w-4 h-4 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      }
      if (titleEl) {
        titleEl.classList.remove('text-gray-500', 'text-amber-700');
        titleEl.classList.add('text-green-700');
      }
      // Hide confirm button on step 3 if passed
      const confirmBtn = document.getElementById(prefix + 'status-3-confirm');
      if (confirmBtn && targetStep === 3) {
        confirmBtn.classList.add('hidden');
      }
    } else {
      // FUTURE steps — inactive styling
      el.classList.remove('bg-amber-50', 'bg-green-50');
      el.classList.add('opacity-50', 'bg-gray-50');
      if (iconContainer) {
        iconContainer.classList.remove('bg-amber-100', 'bg-green-100');
        iconContainer.classList.add('bg-gray-200');
        // Restore original icon
        iconContainer.innerHTML = `<i data-lucide="${stepIcons[idx]}" class="w-4 h-4 text-gray-500"></i>`;
      }
      if (titleEl) {
        titleEl.classList.remove('text-amber-700', 'text-green-700');
        titleEl.classList.add('text-gray-500');
      }
      // Hide confirm button on step 3 if not reached
      const confirmBtn = document.getElementById(prefix + 'status-3-confirm');
      if (confirmBtn && targetStep === 3) {
        confirmBtn.classList.add('hidden');
      }
    }
  });
  safeLucideInit();
}

function copyAddress(elementId) {
  const el = document.getElementById(elementId);
  const text = el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard!', 'success');
    el.parentElement.classList.add('copy-flash');
    setTimeout(() => el.parentElement.classList.remove('copy-flash'), 600);
  });
}

let fullSuccessRecipient = '';
function copySuccessDetail() {
  if (!fullSuccessRecipient) {
    const el = document.getElementById('success-detail');
    if (el) fullSuccessRecipient = el.getAttribute('data-full-val') || el.textContent;
  }
  if (!fullSuccessRecipient || fullSuccessRecipient === '-') return;
  copyText(fullSuccessRecipient, 'Recipient copied to clipboard!');
}

function copySuccessReference() {
  const el = document.getElementById('success-reference');
  if (!el) return;
  const ref = el.getAttribute('data-full-ref') || el.textContent;
  if (!ref || ref === '-') return;
  copyText(ref, 'Reference copied!');
}

function copyText(text, label = 'Copied to clipboard!') {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(label, 'success');
    }).catch(() => fallbackCopy(text, label));
  } else {
    fallbackCopy(text, label);
  }
}

function fallbackCopy(text, label) {
  try {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
    showToast(label, 'success');
  } catch (e) {
    showToast('Failed to copy', 'error');
  }
}

function updateStepIndicators(direction) {
  const asset = direction === 'OFFRAMP' ? currentSellAsset : currentBuyAsset;
  const network = direction === 'OFFRAMP' ? currentSellNetwork : currentBuyNetwork;
  const amount = direction === 'OFFRAMP' ? getNum('sell-amount') : getNum('buy-amount');
  const details = direction === 'OFFRAMP' ? currentBankCode : document.getElementById('buy-wallet').value.trim();

  const steps = [!!asset, !!network, amount > 0 || (direction === 'OFFRAMP' && currentProvider === 'hostfi'), !!details];

  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`step-${i + 1}`);
    const line = document.getElementById(`line-${i + 1}`);
    if (dot) dot.className = 'step-dot ' + (steps[i] ? 'active' : 'inactive');
    if (line) line.className = 'step-line ' + (steps[i] ? 'active' : '');
  }
}

function toggleUssdHelper() {
  const container = document.getElementById('ussd-codes-container');
  const arrow = document.getElementById('ussd-toggle-arrow');
  if (!container) return;
  const isHidden = container.classList.contains('hidden');
  if (isHidden) {
    container.classList.remove('hidden');
    if (arrow) arrow.textContent = '▲';
    populateUssdButtons();
  } else {
    container.classList.add('hidden');
    if (arrow) arrow.textContent = '▼';
  }
}

function populateUssdButtons() {
  const btnsContainer = document.getElementById('ussd-bank-buttons');
  if (!btnsContainer) return;
  const acct = (document.getElementById('buy-account-number')?.textContent || '').trim();
  const amtStr = (document.getElementById('buy-amount-to-pay')?.textContent || '').replace(/[^0-9.]/g, '');
  const amt = Math.round(parseFloat(amtStr) || 0);

  const banks = [
    { name: 'GTBank', code: `*737*1*${amt || 'AMOUNT'}*${acct}#` },
    { name: 'Zenith', code: `*966*${amt || 'AMOUNT'}*${acct}#` },
    { name: 'UBA', code: `*919*3*${acct}*${amt || 'AMOUNT'}#` },
    { name: 'Access', code: `*901*1*${amt || 'AMOUNT'}*${acct}#` },
    { name: 'FirstBank', code: `*894*${amt || 'AMOUNT'}*${acct}#` },
    { name: 'Fidelity', code: `*770*${acct}*${amt || 'AMOUNT'}#` },
    { name: 'Stanbic', code: `*909*22*${amt || 'AMOUNT'}*${acct}#` },
    { name: 'Wema', code: `*945*1*${acct}*${amt || 'AMOUNT'}#` }
  ];

  btnsContainer.innerHTML = banks.map(b => `
    <button type="button" onclick="handleUssdClick('${b.code}')" class="p-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-left transition-colors flex flex-col">
      <span class="font-bold text-gray-800 text-[11px]">${b.name}</span>
      <span class="font-mono text-[10px] text-gray-500 truncate">${b.code}</span>
    </button>
  `).join('');
}

function handleUssdClick(code) {
  if (!code) return;
  navigator.clipboard?.writeText(code).then(() => {
    showToast('USSD code copied: ' + code, 'success');
  }).catch(() => {
    showToast('USSD code: ' + code, 'info');
  });
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    window.location.href = 'tel:' + encodeURIComponent(code);
  }
}

function saveRecentOrder(tx) {
  if (!tx || !tx.reference) return;
  try {
    const list = JSON.parse(localStorage.getItem('velcro_recent_orders') || '[]');
    const filtered = list.filter(item => item.reference !== tx.reference);
    filtered.unshift({
      reference: tx.reference,
      type: (tx.type || 'buy').toUpperCase() === 'BUY' ? 'ONRAMP' : 'OFFRAMP',
      status: 'AWAITING_DEPOSIT',
      asset: tx.asset || 'USDT',
      amount: tx.amount,
      destination_amount: tx.destinationAmount,
      wallet_address: tx.walletAddress,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      meta: { network: tx.network }
    });
    localStorage.setItem('velcro_recent_orders', JSON.stringify(filtered.slice(0, 20)));
  } catch (e) {
    console.warn('Failed to save recent order locally', e);
  }
}

function lockSellForm() {
  const inputs = document.querySelectorAll('#form-sell input:not(#sell-tx-hash), #form-sell .asset-pill, #form-sell .network-pill, #form-sell .custom-select-trigger, #form-sell .swap-btn');
  inputs.forEach(el => {
    el.disabled = true;
    el.classList.add('opacity-50', 'pointer-events-none');
  });
}
function unlockSellForm() {
  const inputs = document.querySelectorAll('#form-sell input:not(#sell-tx-hash), #form-sell .asset-pill, #form-sell .network-pill, #form-sell .custom-select-trigger, #form-sell .swap-btn');
  inputs.forEach(el => {
    el.disabled = false;
    el.classList.remove('opacity-50', 'pointer-events-none');
  });
}
async function resetSellTransaction() {
  if (currentReference) {
    try {
      fetch(`${API_BASE}/api/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: currentReference })
      });
    } catch (e) { console.error('Failed to cancel transaction:', e); }
  }
  document.getElementById('sell-generated-address').classList.add('hidden');
  document.getElementById('sell-qr-code').innerHTML = '';
  const statusExplorerLink = document.getElementById('sell-status-explorer-link');
  if (statusExplorerLink) statusExplorerLink.href = '#';
  document.getElementById('sell-btn').disabled = false;
  document.getElementById('sell-btn').classList.remove('opacity-50', 'cursor-not-allowed');
  document.getElementById('sell-btn').innerHTML = '<i data-lucide="wallet" class="w-5 h-5"></i> Get deposit address';
  safeLucideInit();
  unlockSellForm();
  if (statusPollInterval) clearInterval(statusPollInterval);
  if (sellExpiryInterval) { clearInterval(sellExpiryInterval); sellExpiryInterval = null; }
  stopOrderHelp('sell');
  updateStatusUI('AWAITING_DEPOSIT', 'sell', false);
  // Put back the default copy a HostFi order may have changed.
  safeSetText('sell-expiry-text', 'This address is valid for 60 minutes. Please send before expiry.');
  safeSetText('sell-status-hint', "We usually detect deposits within a minute. You can close this page — we'll email your receipt.");
  document.getElementById('sell-memo')?.classList.add('hidden');
  currentReference = '';
  currentTxDetails = null;
}
function lockBuyForm() {
  const inputs = document.querySelectorAll('#form-buy input, #form-buy .asset-pill, #form-buy .network-pill, #form-buy .custom-select-trigger, #form-buy .swap-btn');
  inputs.forEach(el => {
    el.disabled = true;
    el.classList.add('opacity-50', 'pointer-events-none');
  });
}
function unlockBuyForm() {
  const inputs = document.querySelectorAll('#form-buy input, #form-buy .asset-pill, #form-buy .network-pill, #form-buy .custom-select-trigger, #form-buy .swap-btn');
  inputs.forEach(el => {
    el.disabled = false;
    el.classList.remove('opacity-50', 'pointer-events-none');
  });
}
async function resetBuyTransaction() {
  if (currentReference) {
    try {
      fetch(`${API_BASE}/api/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: currentReference })
      });
    } catch (e) { console.error('Failed to cancel transaction:', e); }
  }
  document.getElementById('buy-generated-account').classList.add('hidden');
  document.getElementById('buy-btn').disabled = false;
  document.getElementById('buy-btn').classList.remove('opacity-50', 'cursor-not-allowed');
  document.getElementById('buy-btn').innerHTML = '<i data-lucide="landmark" class="w-5 h-5"></i> Get payment details';
  safeLucideInit();
  unlockBuyForm();
  if (statusPollInterval) clearInterval(statusPollInterval);
  if (buyExpiryInterval) { clearInterval(buyExpiryInterval); buyExpiryInterval = null; }
  stopOrderHelp('buy');
  updateStatusUI('AWAITING_DEPOSIT', 'buy', false);
  currentReference = '';
  currentTxDetails = null;
}
