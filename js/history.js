// Velcro Convert — Order history and the success receipt.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

let userHistoryCache = [];
let currentHistoryFilter = 'all';

function safeJsonParse(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function updateHistoryTabCounts() {
  if (!Array.isArray(userHistoryCache)) userHistoryCache = [];
  const allCount = userHistoryCache.length;
  const buyCount = userHistoryCache.filter(tx => (tx && tx.type || '').toUpperCase() === 'ONRAMP').length;
  const sellCount = userHistoryCache.filter(tx => (tx && tx.type || '').toUpperCase() === 'OFFRAMP').length;
  const compCount = userHistoryCache.filter(tx => (tx && tx.status || '').toUpperCase() === 'COMPLETED').length;

  const btnAll = document.getElementById('hist-filter-all');
  const btnBuy = document.getElementById('hist-filter-onramp');
  const btnSell = document.getElementById('hist-filter-offramp');
  const btnComp = document.getElementById('hist-filter-completed');

  if (btnAll) btnAll.textContent = `All (${allCount})`;
  if (btnBuy) btnBuy.textContent = `Buy (${buyCount})`;
  if (btnSell) btnSell.textContent = `Sell (${sellCount})`;
  if (btnComp) btnComp.textContent = `Completed (${compCount})`;
}

function filterHistory(filter) {
  currentHistoryFilter = filter || 'all';
  document.querySelectorAll('.hist-filter-btn').forEach(b => {
    b.className = 'hist-filter-btn px-3 py-1 rounded-full font-medium bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700 transition-all whitespace-nowrap text-xs';
  });
  const activeBtn = document.getElementById(`hist-filter-${currentHistoryFilter}`);
  if (activeBtn) {
    activeBtn.className = 'hist-filter-btn px-3 py-1 rounded-full font-bold bg-[#6b46ff] text-white shadow-2xs transition-all whitespace-nowrap text-xs';
  }

  let filtered = Array.isArray(userHistoryCache) ? userHistoryCache : [];
  if (currentHistoryFilter === 'onramp') {
    filtered = filtered.filter(tx => (tx && tx.type || '').toUpperCase() === 'ONRAMP');
  } else if (currentHistoryFilter === 'offramp') {
    filtered = filtered.filter(tx => (tx && tx.type || '').toUpperCase() === 'OFFRAMP');
  } else if (currentHistoryFilter === 'completed') {
    filtered = filtered.filter(tx => (tx && tx.status || '').toUpperCase() === 'COMPLETED');
  }
  renderHistoryList(filtered);
}

function toggleTxDetails(headerEl) {
  const card = headerEl.closest('.tx-card');
  if (!card) return;
  const details = card.querySelector('.tx-details');
  const chevron = card.querySelector('.tx-chevron');
  if (!details) return;
  const isHidden = details.classList.contains('hidden');
  details.classList.toggle('hidden');
  if (chevron) {
    chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
  }
}

// HostFi orders: each deposit's steps (sell: received → converted → paid to bank; buy: payment
// received → converted → sent to wallet) and, if the last step failed, a retry button. The retry
// can only re-send to the bank or wallet on this order (see /api/hostfi/orders/…/retry).
function hostfiProgressHtml(tx) {
  const deps = Array.isArray(tx.hostfi_progress) ? tx.hostfi_progress : [];
  const status = String(tx.status || '').toUpperCase();
  const isBuy = String(tx.type || '').toUpperCase() === 'ONRAMP';
  if (!deps.length) {
    return status === 'AWAITING_DEPOSIT'
      ? `<p class="mt-3 text-xs text-gray-500 dark:text-gray-400">${isBuy
        ? 'Waiting for your payment. We send your crypto automatically once it arrives.'
        : 'Waiting for your deposit. We pay your bank automatically once it confirms on the network.'}</p>`
      : '';
  }
  const ngn = v => `₦${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dot = { done: 'bg-velcro-green', pending: 'bg-sky-500 animate-pulse', waiting: 'bg-gray-300 dark:bg-slate-600', failed: 'bg-red-500', review: 'bg-amber-500', stopped: 'bg-gray-300 dark:bg-slate-600', resolved: 'bg-gray-400' };
  const step = (state, label, detail) => `
    <li class="flex items-start gap-2.5">
      <i class="mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot[state] || dot.waiting}"></i>
      <span class="min-w-0"><span class="block text-sm ${state === 'failed' ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-velcro-navy dark:text-gray-100 font-medium'}">${label}</span>${detail ? `<span class="block text-xs text-gray-500 dark:text-gray-400">${detail}</span>` : ''}</span>
    </li>`;
  const coin = (v, c) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${c}`;
  return deps.map((d, i) => {
    if (d.kind === 'buy') return hostfiBuyStepsHtml(tx, d, i, deps.length, step, ngn, coin);
    const payout = {
      done: ['Paid to your bank', d.payout_amount ? ngn(d.payout_amount) : ''],
      pending: ['Sending to your bank…', d.payout_amount ? ngn(d.payout_amount) : ''],
      failed: ['Payout failed', d.can_retry ? 'Your naira is safe with us. Tap retry to send it again.' : "Our team will contact you to complete it."],
      review: ['Being checked by our team', "We'll email you once it's paid."],
      resolved: ['Handled by our team', ''],
      waiting: ['Paid to your bank', 'Waiting'],
    }[d.payout] || ['Paid to your bank', ''];
    const converted = { done: 'Converted to naira', pending: 'Converting to naira…', waiting: 'Converting to naira', stopped: 'Converting to naira' }[d.converted] || 'Converting to naira';
    return `
      <div class="mt-3 rounded-xl border border-gray-200/80 dark:border-slate-800 p-3">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">${deps.length > 1 ? `Deposit ${i + 1} progress` : 'Progress'}</p>
        <ol class="space-y-2">
          ${step('done', 'Deposit received', `${Number(d.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${d.currency}`)}
          ${step(d.converted === 'done' ? 'done' : d.converted === 'pending' ? 'pending' : 'waiting', converted, '')}
          ${step(d.payout, payout[0], payout[1])}
        </ol>
        ${d.can_retry ? `<button type="button" onclick="event.stopPropagation(); retryHostfiPayout('${tx.reference}', this)"
          class="mt-3 h-10 w-full rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Retry payout</button>` : ''}
      </div>`;
  }).join('');
}

// One HostFi buy payment: received → converted → sent to the wallet on the order.
function hostfiBuyStepsHtml(tx, d, i, count, step, ngn, coin) {
  const sym = d.payout_currency || '';
  const explorer = d.explorer_url ? ` <a href="${d.explorer_url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" class="font-semibold text-velcro-navy dark:text-velcro-green underline">View on explorer</a>` : '';
  const sent = {
    done: [`${sym} confirmed`, (d.payout_amount ? coin(d.payout_amount, sym) + ' in your wallet.' : '') + explorer],
    sent: [`${sym} sent`, (d.payout_amount ? coin(d.payout_amount, sym) + ' sent. Waiting for network confirmation.' : '') + explorer],
    pending: ['Sending to your wallet…', d.payout_amount ? coin(d.payout_amount, sym) : ''],
    failed: ['Sending failed', d.can_retry ? 'Your money is safe with us. Tap retry to send it again.' : 'Our team will contact you to complete it.'],
    review: ['Being checked by our team', "We'll email you once it's sent."],
    resolved: ['Handled by our team', ''],
    waiting: ['Sent to your wallet', 'Waiting'],
  }[d.payout] || ['Sent to your wallet', ''];
  const converted = d.converted === 'pending' ? `Converting to ${sym}…` : `Converted to ${sym}`;
  return `
      <div class="mt-3 rounded-xl border border-gray-200/80 dark:border-slate-800 p-3">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">${count > 1 ? `Payment ${i + 1} progress` : 'Progress'}</p>
        <ol class="space-y-2">
          ${step('done', 'Payment received', ngn(d.amount))}
          ${step(d.converted === 'done' ? 'done' : d.converted === 'pending' ? 'pending' : 'waiting', converted, '')}
          ${step(d.payout === 'sent' ? 'pending' : d.payout, sent[0], sent[1])}
        </ol>
        ${d.can_retry ? `<button type="button" onclick="event.stopPropagation(); retryHostfiPayout('${tx.reference}', this)"
          class="mt-3 h-10 w-full rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Retry send</button>` : ''}
      </div>`;
}

async function retryHostfiPayout(reference, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
  try {
    const res = await fetch(`${API_BASE}/api/hostfi/orders/${encodeURIComponent(reference)}/retry`, { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    showToast(payload.message || (res.ok ? 'Sent again' : 'Could not retry right now'), res.ok ? 'success' : 'error');
  } catch (e) {
    showToast('Could not retry right now. Please try again shortly.', 'error');
  }
  // Refresh whichever view the customer is on.
  if (!document.getElementById('history-modal')?.classList.contains('hidden')) showHistoryModal();
  if (btn) { btn.disabled = false; btn.textContent = label; }
}

function renderHistoryList(txs) {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!txs || txs.length === 0) {
    list.innerHTML = `
      <div class="text-center py-12 text-gray-400 flex flex-col items-center gap-2">
        <svg class="w-8 h-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
        <p class="text-sm">No transactions found${currentHistoryFilter !== 'all' ? ' for this filter' : ''}</p>
      </div>
    `;
    return;
  }

  const formatFiat = (v, curr) => formatFiatDigits(v, curr || 'NGN');
  const crypto = (v, sym) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym}`;
  const short = s => s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
  const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const copyBtn = (value, label) => `<button onclick="event.stopPropagation(); copyText('${value}', '${label} copied!')" aria-label="Copy ${label.toLowerCase()}" class="success-copy">${copyIcon}</button>`;
  const row = (label, value) => `<div class="success-row"><dt>${label}</dt><dd>${value}</dd></div>`;
  const monoRow = (label, value) => row(label, `<span class="font-mono text-[13px]" title="${value}">${short(value)}</span>${copyBtn(value, label)}`);
  const bankRow = (label, bank, number, name) => row(label, `
    <span class="text-right leading-tight">
      <span class="block">${bank}${number ? ` · <span class="font-mono text-[13px]">${number}</span>` : ''}</span>
      ${name ? `<span class="block mt-0.5 text-xs font-medium text-gray-500 dark:text-gray-400">${name}</span>` : ''}
    </span>${number && !String(number).includes('*') ? copyBtn(number, 'Account number') : ''}`);
  const bankNames = { '100004': 'OPay', '000014': 'Access Bank', '000013': 'GTBank', '000015': 'Zenith Bank', '000016': 'First Bank', '000004': 'UBA', '000007': 'Fidelity Bank', '000017': 'Wema Bank', '090286': 'Safehaven MFB', '100033': 'PalmPay', '100026': 'Kuda Bank' };

  const statusStyles = {
    COMPLETED: 'bg-velcro-green/15 text-velcro-green-dark dark:bg-velcro-green/10 dark:text-velcro-green [&>i]:bg-velcro-green',
    AWAITING_DEPOSIT: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 [&>i]:bg-amber-500',
    PROCESSING: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300 [&>i]:bg-sky-500',
    FAILED: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400 [&>i]:bg-red-500',
    CANCELLED: 'bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-gray-300 [&>i]:bg-gray-400',
    EXPIRED: 'bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300 [&>i]:bg-orange-500',
  };
  const statusGroup = { PENDING: 'AWAITING_DEPOSIT', INITIATED: 'AWAITING_DEPOSIT', INIT: 'AWAITING_DEPOSIT', DETECTED: 'PROCESSING', CONFIRMED: 'PROCESSING', RECEIVED: 'PROCESSING', VERIFIED: 'PROCESSING', PAID: 'PROCESSING' };

  // Group orders under Today / Yesterday / date headers.
  const dayKey = d => d.toDateString();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  let lastDay = '';

  list.innerHTML = txs.map(tx => {
    const status = String(tx.status || 'PENDING').toUpperCase();
    const statusClass = statusStyles[statusGroup[status] || status] || statusStyles.AWAITING_DEPOSIT;
    const statusText = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
    // MySQL "YYYY-MM-DD HH:MM:SS" isn't parsed by Safari; the "T" form is.
    const when = new Date(String(tx.created_at || '').replace(' ', 'T'));
    const valid = !isNaN(when);
    const time = valid ? when.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) : '';
    const day = valid ? (dayKey(when) === dayKey(today) ? 'Today' : dayKey(when) === dayKey(yesterday) ? 'Yesterday' : when.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })) : 'Earlier';
    const groupHeader = day !== lastDay ? `<p class="history-day">${day}</p>` : '';
    lastDay = day;
    const shortRef = String(tx.reference || '').slice(0, 8).toUpperCase();
    const asset = String(tx.asset || '');
    const assetName = (asset.includes(':') ? asset.split(':')[1] : asset).toUpperCase();
    const ben = safeJsonParse(tx.beneficiary);
    const meta = safeJsonParse(tx.meta);
    const network = String(meta.network || meta.chain || (asset.includes(':') ? asset.split(':')[0] : 'solana')).toLowerCase();
    const net = networkInfo(network);

    // Robust wallet resolution across all possible schema locations
    const destWallet = tx.wallet_address
      || ben.wallet_address
      || (meta.beneficiary && meta.beneficiary.wallet_address)
      || meta.recipient
      || (meta.destination && meta.destination.address)
      || '';

    const typeLabel = (tx.type || '').toUpperCase();
    const isBuy = typeLabel === 'ONRAMP';
    const title = `${isBuy ? 'Buy' : typeLabel === 'OFFRAMP' ? 'Sell' : 'Trade'} ${assetName}`;

    const sentCrypto = tx.source_amount || (tx.channel !== 'PAJ' ? tx.amount : null);
    const receivedFiat = tx.destination_amount || (tx.channel === 'PAJ' ? tx.amount : null);
    const txCurr = tx.currency || meta.currency || 'NGN';
    const sent = isBuy ? formatFiat(tx.amount, txCurr) : (sentCrypto ? crypto(sentCrypto, assetName) : assetName);
    const received = isBuy ? (tx.destination_amount ? crypto(tx.destination_amount, assetName) : '—') : (receivedFiat ? formatFiat(receivedFiat, txCurr) : '—');

    let explorer = (tx.hash || tx.explorer_url) ? (tx.explorer_url || getExplorerUrl(tx.hash, network)) : '';
    if (explorer === '#') explorer = '';
    const icon = isBuy
      ? '<path d="M17 7 7 17"/><path d="M17 17H7V7"/>'
      : '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>';

    return groupHeader + `
      <div class="tx-card rounded-2xl border border-gray-200/80 dark:border-slate-800 bg-white dark:bg-slate-900/40 hover:border-velcro-navy/20 dark:hover:border-slate-700 transition-colors">
        <div class="flex items-center gap-3 p-4 cursor-pointer select-none" onclick="toggleTxDetails(this)">
          <span class="shrink-0 w-9 h-9 rounded-full inline-flex items-center justify-center ${isBuy ? 'bg-velcro-green/15 text-velcro-green-dark' : 'bg-velcro-navy/[0.07] text-velcro-navy dark:bg-slate-800'}">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-semibold text-velcro-navy dark:text-white truncate">${title}</p>
              <p class="text-sm font-bold text-velcro-navy dark:text-white tabular-nums whitespace-nowrap">${received}</p>
            </div>
            <div class="mt-1.5 flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0 text-xs text-gray-500 dark:text-gray-400">
                <span class="shrink-0 tabular-nums">${time}</span>
                <button type="button" onclick="event.stopPropagation(); copyText('${tx.reference}', 'Reference copied!')" title="Copy reference ${tx.reference}"
                  class="history-ref">#${shortRef}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
              </div>
              <span class="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${statusClass}"><i class="w-1.5 h-1.5 rounded-full"></i>${statusText}</span>
            </div>
          </div>
          <svg class="tx-chevron shrink-0 w-4 h-4 text-gray-400 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="tx-details hidden px-4 pb-4 animate-fade-in">
          <dl class="success-receipt text-sm">
            ${row('You sent', `<span class="tabular-nums">${sent}</span>`)}
            ${row(tx.channel === 'HOSTFI' && status !== 'COMPLETED' ? "You'll receive" : 'You received', `<span class="tabular-nums">${received}</span>`)}
            ${tx.hostfi_rate
              ? row('Rate', `<span class="tabular-nums">$1 = ${ngn(tx.hostfi_rate.ngn_per_usd)}</span><span class="font-medium text-gray-500 dark:text-gray-400">· ${tx.hostfi_rate.fee_percent}% fee</span>`)
              : (tx.rate ? row('Rate', `<span class="tabular-nums">${ngn(tx.rate)}</span><span class="font-medium text-gray-500 dark:text-gray-400">/ ${assetName}</span>`) : '')}
            ${row('Network', `${net.logo ? `<img src="${net.logo}" alt="">` : ''}${net.label}`)}
            ${isBuy
              ? (destWallet ? monoRow('Wallet', destWallet) : '')
              : bankRow('Payout to', ben.bank_name || ben.bankName || ben.institution || bankNames[ben.bank_code] || ben.bank_code || ben.bank || 'Bank', ben.account_number, ben.holder_name)}
            ${tx.deposit_bank_name ? bankRow('Pay to', tx.deposit_bank_name, tx.deposit_account_number, tx.deposit_account_name) : ''}
            ${tx.deposit_address ? monoRow('Deposit address', tx.deposit_address) : ''}
            ${tx.hash ? monoRow('Transaction', tx.hash) : ''}
            ${monoRow('Reference', tx.reference)}
          </dl>
          ${tx.channel === 'HOSTFI' ? hostfiProgressHtml(tx) : ''}
          ${explorer ? `
            <a href="${explorer}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"
              class="mt-3 h-10 w-full rounded-xl border border-gray-200 dark:border-slate-700 hover:border-velcro-navy/30 hover:bg-gray-50 dark:hover:bg-slate-800 text-sm font-semibold text-velcro-navy dark:text-gray-100 transition-colors inline-flex items-center justify-center gap-2">
              View on explorer
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>
            </a>` : ''}
        </div>
      </div>
    `;
  }).join('');
  safeLucideInit();
}

async function showHistoryModal() {
  const email = (localStorage.getItem('velcro_user_email') || '').trim();
  if (!email) {
    promptLoginOverlay(showHistoryModal);
    return;
  }

  if (typeof pushModalHistory === 'function') pushModalHistory('history');
  const modal = document.getElementById('history-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.style.overflow = 'hidden';

  const list = document.getElementById('history-list');

  if (list) {
    list.innerHTML = `
      <div class="text-center py-10 text-gray-400 flex flex-col items-center gap-2">
        <svg class="animate-spin w-5 h-5 text-[#6b46ff]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="text-xs font-medium">Loading transactions…</span>
      </div>
    `;
  }

  try {
    const res = await fetch(`${API_BASE}/api/transactions?email=${encodeURIComponent(email)}`);
    if (!res.ok) {
      const errPayload = await res.json().catch(() => ({}));
      throw new Error(errPayload.message || `Server returned ${res.status}`);
    }
    const payload = await res.json();
    const listData = Array.isArray(payload.data) ? payload.data : [];
    userHistoryCache = typeof scrub === 'function' ? scrub(listData) : listData;
    updateHistoryTabCounts();
    filterHistory(currentHistoryFilter || 'all');
  } catch (err) {
    console.error('Failed to load history:', err);
    if (list) {
      list.innerHTML = `
        <div class="text-center py-10 flex flex-col items-center gap-2.5">
          <div class="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/40 text-red-500 flex items-center justify-center">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <p class="text-sm font-semibold text-gray-800 dark:text-gray-200">Unable to load order history</p>
          <p class="text-xs text-gray-400 max-w-xs">${typeof escapeHtml === 'function' ? escapeHtml(err.message || 'Please check your connection and try again.') : (err.message || 'Error')}</p>
          <button type="button" onclick="showHistoryModal()" class="mt-1 px-4 py-2 rounded-xl bg-[#6b46ff] hover:bg-[#5b36ef] text-white text-xs font-bold transition-all shadow-xs cursor-pointer">
            Try again
          </button>
        </div>
      `;
    }
  }
}

function hideHistoryModal() {
  if (typeof popModalHistory === 'function') popModalHistory('history');
  const modal = document.getElementById('history-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.style.overflow = '';
}

function formatCryptoDigits(num) {
  if (num === null || num === undefined || num === '') return '0';
  const val = Number(num);
  if (isNaN(val) || val <= 0) return '0';
  if (val >= 1000) {
    return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (val >= 1) {
    return Number(val.toFixed(4)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (val < 0.001) {
    return Number(val.toFixed(6)).toString();
  }
  return Number(val.toFixed(4)).toString();
}

function formatFiatDigits(num, currency = 'NGN') {
  if (num === null || num === undefined || num === '') return '-';
  const val = Number(num);
  if (isNaN(val)) return String(num);
  const c = String(currency || 'NGN').toUpperCase().trim();
  const symbols = {
    'NGN': '₦',
    'GHS': 'GH₵',
    'KES': 'KSh ',
    'ZAR': 'R ',
    'XOF': 'CFA ',
    'XAF': 'CFA ',
    'EGP': 'E£ ',
    'MAD': 'MAD ',
    'UGX': 'USh ',
    'TZS': 'TSh ',
    'RWF': 'RF ',
    'USD': '$',
    'EUR': '€',
    'GBP': '£'
  };
  const symbol = symbols[c] || (c ? `${c} ` : '₦');
  return `${symbol}${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Network display name and chain logo (from /logos), for receipts.
function networkInfo(net) {
  const n = String(net || '').toLowerCase();
  const known = [
    ['bitcoin', 'Bitcoin', 'bitcoin'], ['btc', 'Bitcoin', 'bitcoin'],
    ['solana', 'Solana', 'solana'], ['tron', 'TRON', 'tron'], ['trx', 'TRON', 'tron'],
    ['arbitrum', 'Arbitrum', 'arbitrum'], ['optimism', 'Optimism', 'optimism'], ['avalanche', 'Avalanche', 'avalanche'],
    ['eth', 'Ethereum', 'ethereum'], ['erc20', 'Ethereum', 'ethereum'],
    ['bsc', 'BNB Chain', 'bsc'], ['binance', 'BNB Chain', 'bsc'],
    ['base', 'Base', 'base'], ['polygon', 'Polygon', 'polygon'], ['matic', 'Polygon', 'polygon'],
  ].find(([key]) => n.includes(key));
  if (known) return { label: known[1], logo: `/logos/${known[2]}.png` };
  return { label: net ? net.charAt(0).toUpperCase() + net.slice(1) : '-', logo: null };
}

function renderNetwork(el, net) {
  const { label, logo } = networkInfo(net);
  el.textContent = label;
  if (logo) {
    const img = document.createElement('img');
    img.src = logo;
    img.alt = '';
    el.prepend(img);
  }
}

function showSuccessModal(type, data) {
  if (buyExpiryInterval) { clearInterval(buyExpiryInterval); buyExpiryInterval = null; }
  if (sellExpiryInterval) { clearInterval(sellExpiryInterval); sellExpiryInterval = null; }
  if (typeof pushModalHistory === 'function') pushModalHistory('success');
  const modal = document.getElementById('success-modal');
  const title = document.getElementById('success-title');
  const subtitle = document.getElementById('success-subtitle');
  const amountEl = document.getElementById('success-amount');
  const destLabel = document.getElementById('success-destination-label');
  const destEl = document.getElementById('success-destination');
  const detailLabel = document.getElementById('success-detail-label');
  const detailEl = document.getElementById('success-detail');
  const refEl = document.getElementById('success-reference');
  const explorerLink = document.getElementById('success-explorer-link');

  const heroLabel = document.getElementById('success-hero-label');
  const assetTag = document.getElementById('success-asset-tag');
  const secondaryRow = document.getElementById('success-secondary-row');
  const secondaryLabel = document.getElementById('success-secondary-label');
  const secondaryValue = document.getElementById('success-secondary-value');
  const statusBadge = document.getElementById('success-badge-status');

  const isBuy = (type === 'buy');
  const txCurr = data.currency || (typeof currentCurrency !== 'undefined' ? currentCurrency : 'NGN');
  const rawAsset = (data.asset || (isBuy ? currentBuyAsset : currentSellAsset) || (isBuy ? 'SOL' : 'USDT')).toUpperCase();
  
  let rawCrypto = isBuy ? (data.cryptoAmount || data.destinationAmount) : (data.cryptoAmount || data.amount);
  let rawFiat = isBuy ? (data.fiatAmount || data.paidAmount || data.amount) : (data.fiatAmount || data.destinationAmount);

  // Safety check: if for buy, rawCrypto is suspiciously large (> 500 when asset is SOL/BTC/ETH), fallback to currentTxDetails.destinationAmount
  if (isBuy && Number(rawCrypto) > 500 && ['SOL', 'BTC', 'ETH'].includes(rawAsset)) {
    if (currentTxDetails && currentTxDetails.destinationAmount && Number(currentTxDetails.destinationAmount) < 500) {
      rawCrypto = currentTxDetails.destinationAmount;
    }
  }

  if (detailEl) detailEl.classList.toggle('font-mono', isBuy);

  if (isBuy) {
    if (title) title.textContent = 'Crypto delivered';
    if (subtitle) subtitle.textContent = 'Your tokens have been sent to your wallet.';
    if (statusBadge) statusBadge.textContent = 'Transfer complete';
    if (heroLabel) heroLabel.textContent = 'You received';
    if (amountEl) amountEl.textContent = formatCryptoDigits(rawCrypto);
    if (assetTag) assetTag.textContent = rawAsset;

    if (secondaryRow && secondaryLabel && secondaryValue) {
      if (rawFiat && Number(rawFiat) > 0) {
        secondaryLabel.textContent = 'You paid';
        secondaryValue.textContent = formatFiatDigits(rawFiat, txCurr);
        secondaryRow.classList.remove('hidden');
      } else {
        secondaryRow.classList.add('hidden');
      }
    }

    if (destLabel) destLabel.textContent = 'Network';
    if (destEl) renderNetwork(destEl, data.network || currentTxDetails?.network || currentBuyNetwork || 'Solana');

    const rawWallet = data.walletAddress || currentTxDetails?.walletAddress || '';
    fullSuccessRecipient = rawWallet;
    if (detailLabel) detailLabel.textContent = 'Wallet';
    if (detailEl) {
      detailEl.textContent = rawWallet ? `${rawWallet.slice(0, 6)}…${rawWallet.slice(-6)}` : '-';
      detailEl.setAttribute('data-full-val', rawWallet);
      detailEl.title = rawWallet;
    }

    // Blockchain Explorer link
    const explorerUrl = data.explorerUrl || currentTxDetails?.explorerUrl || '';
    const txHash = data.hash || currentTxDetails?.hash || '';
    const txNetwork = data.network || currentTxDetails?.network || currentBuyNetwork || 'solana';
    if (explorerLink) {
      if (explorerUrl || txHash) {
        explorerLink.href = explorerUrl || getExplorerUrl(txHash, txNetwork);
        explorerLink.classList.remove('hidden');
      } else if (rawWallet && txNetwork) {
        explorerLink.href = getWalletExplorerUrl(rawWallet, txNetwork);
        explorerLink.classList.remove('hidden');
      } else {
        explorerLink.classList.add('hidden');
      }
    }
  } else {
    if (title) title.textContent = 'Payout sent';
    if (subtitle) subtitle.textContent = 'Your funds have been sent to your bank account.';
    if (statusBadge) statusBadge.textContent = 'Payout complete';
    if (heroLabel) heroLabel.textContent = 'You received';
    if (amountEl) amountEl.textContent = formatFiatDigits(rawFiat, txCurr);
    if (assetTag) assetTag.textContent = (txCurr === 'NGN' ? '' : txCurr);

    if (secondaryRow && secondaryLabel && secondaryValue) {
      if (rawCrypto && Number(rawCrypto) > 0) {
        secondaryLabel.textContent = 'You sold';
        secondaryValue.textContent = `${formatCryptoDigits(rawCrypto)} ${rawAsset}`;
        secondaryRow.classList.remove('hidden');
      } else {
        secondaryRow.classList.add('hidden');
      }
    }

    if (destLabel) destLabel.textContent = 'Bank';
    if (destEl) destEl.textContent = data.bankName || currentTxDetails?.bankName || '-';

    const accNum = data.accountNumber || currentTxDetails?.accountNumber || '';
    const accName = data.accountName || currentTxDetails?.accountName || '';
    fullSuccessRecipient = accNum;
    if (detailLabel) detailLabel.textContent = 'Account';
    if (detailEl) {
      detailEl.textContent = accNum ? (accName ? `${accNum} · ${accName}` : accNum) : '-';
      detailEl.setAttribute('data-full-val', `${accNum} ${accName}`);
      detailEl.title = `${accNum} ${accName}`;
    }

    if (explorerLink) {
      explorerLink.classList.add('hidden');
    }
  }

  const ref = data.reference || currentTxDetails?.reference || '-';
  if (refEl) {
    refEl.setAttribute('data-full-ref', ref);
    refEl.textContent = ref.length > 20 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;
    refEl.title = ref;
  }

  const dateEl = document.getElementById('success-date');
  if (dateEl) {
    const when = new Date(data.completedAt || data.updated_at || Date.now());
    dateEl.textContent = (isNaN(when) ? new Date() : when).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.style.overflow = 'hidden';
  safeLucideInit();
  document.getElementById('success-card')?.focus({ preventScroll: true });
}

// "Done" on the receipt: start a fresh order in place instead of reloading the page.
function finishOrder() {
  hideSuccessModal();
  const type = activePollTxType === 'sell' ? 'sell' : 'buy';
  if (type === 'sell') resetSellTransaction(); else resetBuyTransaction();
  ['sell-amount', 'sell-receive', 'buy-amount', 'buy-receive', 'sell-tx-hash'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['sell-preview', 'buy-preview'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  updateStepIndicators(type === 'sell' ? 'OFFRAMP' : 'ONRAMP');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideSuccessModal() {
  if (typeof popModalHistory === 'function') popModalHistory('success');
  const modal = document.getElementById('success-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.style.overflow = '';
}
