// Velcro Convert — Toasts, email connection, referrals and the profile sheet.
// Classic script sharing globals with the other files in /js; load order is set in index.html.

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto translate-x-full opacity-0 transition-all duration-300 ease-out flex items-center gap-3 min-w-[280px] max-w-[400px] rounded-2xl shadow-xl border px-4 py-3.5';

  const styles = {
    success: 'bg-white border-green-200 text-gray-900',
    error: 'bg-white border-red-200 text-gray-900',
    info: 'bg-white border-gray-200 text-gray-900',
    warning: 'bg-white border-amber-200 text-gray-900'
  };
  const iconColors = { success: 'text-green-600', error: 'text-red-500', info: 'text-velcro-navy', warning: 'text-amber-500' };
  const icons = {
    success: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    warning: '<svg class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };

  toast.classList.add(...styles[type].split(' '));
  toast.innerHTML = `
    <div class="${iconColors[type]}">${icons[type]}</div>
    <p class="text-sm font-medium leading-snug flex-1">${message}</p>
    <button onclick="this.parentElement.remove()" class="text-gray-400 hover:text-gray-600 transition-colors p-0.5">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="absolute bottom-0 left-4 right-4 h-0.5 rounded-full overflow-hidden"><div class="h-full ${type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : type === 'warning' ? 'bg-amber-500' : 'bg-velcro-navy'} toast-progress"></div></div>
  `;
  toast.style.position = 'relative';
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.remove('translate-x-full', 'opacity-0'));

  const progress = toast.querySelector('.toast-progress');
  if (progress) {
    progress.style.width = '100%';
    progress.style.transition = 'width 3.5s linear';
    requestAnimationFrame(() => { progress.style.width = '0%'; });
  }

  const timer = setTimeout(() => {
    toast.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);

  toast.addEventListener('mouseenter', () => clearTimeout(timer));
}

function checkLoginState() {
  const email = (localStorage.getItem('velcro_user_email') || '').trim();
  const overlay = document.getElementById('login-overlay');
  const loginNavBtn = document.getElementById('btn-login-nav');
  const navSection = document.getElementById('user-nav-section');
  const navDisplay = document.getElementById('user-email-display');
  const convertSection = document.getElementById('convert');
  
  if (convertSection) {
    convertSection.classList.remove('hidden');
  }

  if (!email) {
    // No email yet: show the Add email button in nav
    if (loginNavBtn) {
      loginNavBtn.classList.remove('hidden');
      loginNavBtn.classList.add('inline-flex');
    }
    if (navSection) {
      navSection.classList.add('hidden');
      navSection.classList.remove('flex');
    }
  } else {
    // Connected state: show email + logout in nav, hide the email prompt
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
    }
    if (loginNavBtn) {
      loginNavBtn.classList.add('hidden');
      loginNavBtn.classList.remove('inline-flex');
    }
    if (navSection) {
      navSection.classList.remove('hidden');
      navSection.classList.add('flex');
    }
    if (navDisplay) {
      navDisplay.textContent = email;
      navDisplay.setAttribute('title', email);
    }
  }
}

// Action to resume after the user connects their email (e.g. the order they tried to start).
let pendingLoginAction = null;

function promptLoginOverlay(next) {
  pendingLoginAction = typeof next === 'function' ? next : null;
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    const emailInput = document.getElementById('login-email');
    if (emailInput) {
      emailInput.value = (localStorage.getItem('velcro_user_email') || '').trim();
      emailInput.focus();
    }
  }
}

function closeLoginOverlay() {
  pendingLoginAction = null;
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
  }
}

function handleLoginSubmit(e) {
  e.preventDefault();
  const emailInput = document.getElementById('login-email');
  const email = emailInput.value.trim().toLowerCase();
  if (!email) return;
  
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
  if (!emailRegex.test(email)) {
    showToast('Please enter a valid email address', 'warning');
    return;
  }
  
  localStorage.setItem('velcro_user_email', email);
  const next = pendingLoginAction;
  closeLoginOverlay();
  checkLoginState();
  showToast('Email saved', 'success');
  if (typeof lucide !== 'undefined') lucide.createIcons();
  if (next) next();
}

function logoutUser() {
  localStorage.removeItem('velcro_user_email');
  clearRefToken();
  checkLoginState();
  showToast('Logged out', 'success');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Referral links: ?ref=CODE. The first link a browser opens wins; the code rides along on its orders.
(function captureReferral() {
  const params = new URLSearchParams(location.search);
  const ref = (params.get('ref') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(ref)) return;
  try { if (!localStorage.getItem('velcro_ref')) localStorage.setItem('velcro_ref', ref); } catch (e) {}
  params.delete('ref');
  history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
})();

let profileData = null;
const withdrawForm = { chain: 'solana', address: '', step: 'form' }; // step: form | code

const usd = v => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const profileEmail = () => (localStorage.getItem('velcro_user_email') || '').trim();
const referralLink = () => `${location.origin}/?ref=${profileData.code}`;

// Verified-email token for the referral API (issued after the emailed code is confirmed).
let verifyStep = 'send'; // send | code
function refToken() {
  try {
    const a = JSON.parse(localStorage.getItem('velcro_ref_auth') || 'null');
    return a && a.email === profileEmail() ? a.token : '';
  } catch (e) { return ''; }
}
function clearRefToken() {
  try { localStorage.removeItem('velcro_ref_auth'); } catch (e) {}
  profileData = null;
}

function renderVerify() {
  const body = document.getElementById('profile-body');
  const lock = '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  body.innerHTML = `
    <div class="rounded-2xl border border-gray-200/80 dark:border-slate-800 p-5 text-center">
      <span class="mx-auto w-12 h-12 rounded-2xl bg-velcro-green/15 text-velcro-navy dark:text-velcro-green inline-flex items-center justify-center">${lock}</span>
      <h3 class="mt-3 text-lg font-bold text-velcro-navy dark:text-white">Verify your email</h3>
      ${verifyStep === 'send' ? `
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">To keep your referral earnings safe, we'll send a 6-digit code to <b class="text-gray-700 dark:text-gray-200">${profileEmail()}</b>.</p>
        <button type="button" onclick="sendVerifyCode(this)" class="mt-5 w-full h-12 rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Send code</button>` : `
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">Enter the code we sent to <b class="text-gray-700 dark:text-gray-200">${profileEmail()}</b>.</p>
        <input id="verify-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" class="login-input mt-4 text-center tracking-[0.4em] font-semibold">
        <button type="button" onclick="submitVerifyCode(this)" class="mt-3 w-full h-12 rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Verify</button>
        <button type="button" onclick="sendVerifyCode(this)" class="mt-2 w-full h-10 text-sm font-semibold text-gray-500 hover:text-velcro-navy dark:hover:text-white">Resend code</button>`}
    </div>`;
}

async function sendVerifyCode(btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await referralPost('/api/referral/verify/otp', {});
    verifyStep = 'code';
    renderVerify();
    showToast(`We sent a 6-digit code to ${profileEmail()}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function submitVerifyCode(btn) {
  const otp = document.getElementById('verify-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) { showToast('Enter the 6-digit code from your email', 'warning'); return; }
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    const payload = await referralPost('/api/referral/verify', { otp });
    localStorage.setItem('velcro_ref_auth', JSON.stringify({ email: profileEmail(), token: payload.data.token }));
    verifyStep = 'send';
    document.getElementById('profile-body').innerHTML = '<p class="py-10 text-center text-sm text-gray-400">Loading…</p>';
    loadProfile();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

function openProfile() {
  const email = profileEmail();
  if (!email) { promptLoginOverlay(openProfile); return; }
  document.getElementById('profile-email').textContent = email;
  document.getElementById('profile-avatar').textContent = email.slice(0, 2).toUpperCase();
  const modal = document.getElementById('profile-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.style.overflow = 'hidden';
  if (profileData && !refToken()) profileData = null;
  if (!profileData) document.getElementById('profile-body').innerHTML = '<p class="py-10 text-center text-sm text-gray-400">Loading…</p>';
  loadProfile();
}

function hideProfile() {
  const modal = document.getElementById('profile-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.body.style.overflow = '';
}

async function loadProfile() {
  if (!refToken()) { renderVerify(); return; }
  try {
    const res = await fetch(`${API_BASE}/api/referral/me?email=${encodeURIComponent(profileEmail())}`, { headers: { 'X-Ref-Token': refToken() } });
    if (res.status === 401) { clearRefToken(); renderVerify(); return; }
    const payload = await res.json();
    if (!res.ok || !payload.success) throw new Error(payload.message || 'Could not load your profile');
    profileData = scrub(payload.data);
    renderProfile();
  } catch (err) {
    document.getElementById('profile-body').innerHTML = '<p class="py-10 text-center text-sm text-red-500">Could not load your profile. Try again.</p>';
  }
}

async function referralPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ref-Token': refToken() }, body: JSON.stringify({ email: profileEmail(), ...body }) });
  if (res.status === 401) { clearRefToken(); verifyStep = 'send'; renderVerify(); throw new Error('Please verify your email again'); }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.success) throw new Error(payload.message || 'Something went wrong');
  return payload;
}

async function generateReferralLink(btn) {
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    profileData = scrub((await referralPost('/api/referral/link', {})).data);
    renderProfile();
    showToast('Your referral link is ready', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Get my referral link';
  }
}

function shareReferralLink() {
  const link = referralLink();
  if (navigator.share) {
    navigator.share({ title: 'Velcro Convert', text: 'Buy and sell crypto with Naira on Velcro Convert', url: link }).catch(() => {});
  } else {
    copyText(link, 'Referral link copied!');
  }
}

function isPayoutAddress(chain, address) {
  return chain === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function requestWithdrawCode(btn) {
  withdrawForm.address = document.getElementById('ref-address').value.trim();
  withdrawForm.chain = document.getElementById('ref-chain').value;
  if (!isPayoutAddress(withdrawForm.chain, withdrawForm.address)) {
    showToast(`Enter a valid USDC address for ${profileData.chains[withdrawForm.chain]}`, 'warning');
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Sending code…';
  try {
    await referralPost('/api/referral/withdraw/otp', {});
    withdrawForm.step = 'code';
    renderProfile();
    showToast(`We sent a 6-digit code to ${profileEmail()}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = `Withdraw ${usd(profileData.available_usd)}`;
  }
}

async function confirmWithdraw(btn) {
  const otp = document.getElementById('ref-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) { showToast('Enter the 6-digit code from your email', 'warning'); return; }
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    profileData = scrub((await referralPost('/api/referral/withdraw', { otp, chain: withdrawForm.chain, address: withdrawForm.address })).data);
    withdrawForm.step = 'form';
    withdrawForm.address = '';
    renderProfile();
    showToast('Withdrawal requested. We will review it shortly.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Confirm withdrawal';
  }
}

function renderProfile() {
  const d = profileData;
  const body = document.getElementById('profile-body');
  const gift = '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>';

  // No link yet: only the invitation. Wallet stays hidden until a link exists.
  if (!d.code) {
    body.innerHTML = `
      <div class="rounded-2xl border border-gray-200/80 dark:border-slate-800 p-5 text-center">
        <span class="mx-auto w-12 h-12 rounded-2xl bg-velcro-green/15 text-velcro-navy dark:text-velcro-green inline-flex items-center justify-center">${gift}</span>
        <h3 class="mt-3 text-lg font-bold text-velcro-navy dark:text-white">Refer & earn</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">Invite friends with your link and earn <b class="text-velcro-navy dark:text-white">${d.fee_percent}%</b> of every successful order they make, paid out in USDC.</p>
        <button type="button" onclick="generateReferralLink(this)" class="mt-5 w-full h-12 rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Get my referral link</button>
      </div>`;
    return;
  }

  const canWithdraw = d.available_usd >= d.min_withdrawal_usd && d.pending_usd <= 0;
  let withdraw;
  if (d.pending_usd > 0) {
    withdraw = `<p class="text-sm text-gray-500 dark:text-gray-400">Your ${usd(d.pending_usd)} withdrawal is awaiting approval.</p>`;
  } else if (!canWithdraw) {
    withdraw = `<p class="text-sm text-gray-500 dark:text-gray-400">You can withdraw once your balance reaches ${usd(d.min_withdrawal_usd)}.</p>`;
  } else if (withdrawForm.step === 'code') {
    withdraw = `
      <p class="text-sm text-gray-600 dark:text-gray-300">Enter the code we emailed to confirm ${usd(d.available_usd)} USDC to <span class="font-mono">${withdrawForm.address.slice(0, 6)}…${withdrawForm.address.slice(-6)}</span> on ${d.chains[withdrawForm.chain]}.</p>
      <input id="ref-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" class="login-input mt-3 text-center tracking-[0.4em] font-semibold">
      <button type="button" onclick="confirmWithdraw(this)" class="mt-3 w-full h-12 rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Confirm withdrawal</button>
      <button type="button" onclick="withdrawForm.step = 'form'; renderProfile();" class="mt-2 w-full h-10 text-sm font-semibold text-gray-500 hover:text-velcro-navy dark:hover:text-white">Change address</button>`;
  } else {
    const options = Object.entries(d.chains).map(([k, v]) => `<option value="${k}" ${k === withdrawForm.chain ? 'selected' : ''}>${v}</option>`).join('');
    withdraw = `
      <label for="ref-chain" class="block mb-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">Network</label>
      <select id="ref-chain" class="login-input" onchange="withdrawForm.chain = this.value">${options}</select>
      <label for="ref-address" class="block mt-3 mb-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">USDC address</label>
      <input id="ref-address" autocomplete="off" spellcheck="false" placeholder="Paste your USDC wallet address" value="${withdrawForm.address}" oninput="withdrawForm.address = this.value.trim()" class="login-input font-mono text-sm">
      <button type="button" onclick="requestWithdrawCode(this)" class="mt-4 w-full h-12 rounded-xl bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-sm font-bold transition-colors">Withdraw ${usd(d.available_usd)}</button>
      <p class="mt-2 text-xs text-gray-400 text-center">Minimum ${usd(d.min_withdrawal_usd)}. We'll email you a code to confirm.</p>`;
  }

  const statusClass = { PENDING: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400', APPROVED: 'bg-velcro-green/15 text-velcro-green-dark dark:text-velcro-green', REJECTED: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400' };
  const statusText = { PENDING: 'Awaiting approval', APPROVED: 'Paid', REJECTED: 'Rejected' };
  const history = (d.withdrawals || []).map(w => `
    <div class="success-row">
      <dt class="!font-normal"><span class="block font-semibold text-velcro-navy dark:text-white tabular-nums">${usd(w.amount_usd)}</span><span class="block text-xs text-gray-400">${d.chains[w.chain] || w.chain} · ${new Date(String(w.created_at).replace(' ', 'T')).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</span></dt>
      <dd><span class="text-[11px] font-semibold px-2 py-0.5 rounded-full ${statusClass[w.status] || ''}">${statusText[w.status] || w.status}</span></dd>
    </div>`).join('');

  body.innerHTML = `
    <p class="text-xs font-semibold uppercase tracking-[0.08em] text-gray-400">Your referral link</p>
    <div class="ref-link mt-2">
      <span class="flex-1 min-w-0 truncate font-mono text-[13px] text-velcro-navy dark:text-gray-100">${referralLink().replace(/^https?:\/\//, '')}</span>
      <button type="button" onclick="copyText(referralLink(), 'Referral link copied!')" class="shrink-0 h-9 px-3 rounded-lg bg-velcro-green hover:bg-velcro-green-dark text-velcro-navy text-xs font-bold transition-colors">Copy</button>
      <button type="button" onclick="shareReferralLink()" aria-label="Share link" class="shrink-0 w-9 h-9 rounded-lg inline-flex items-center justify-center text-velcro-navy dark:text-gray-100 hover:bg-white/60 dark:hover:bg-slate-800 transition-colors">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">You earn <b class="text-velcro-navy dark:text-white">${d.fee_percent}%</b> of every successful order made through your link.</p>

    <div class="mt-5 flex gap-2.5">
      <div class="ref-stat"><p class="text-xs text-gray-500 dark:text-gray-400">Total earned</p><p class="mt-0.5 text-base font-bold text-velcro-navy dark:text-white tabular-nums">${usd(d.earned_usd)}</p></div>
      <div class="ref-stat"><p class="text-xs text-gray-500 dark:text-gray-400">Successful orders</p><p class="mt-0.5 text-base font-bold text-velcro-navy dark:text-white tabular-nums">${d.completed_orders}<span class="text-xs font-medium text-gray-400"> / ${d.referred_orders}</span></p></div>
    </div>

    <div class="ref-wallet mt-5">
      <p class="text-xs font-medium text-white/70">Available to withdraw</p>
      <p class="mt-1 flex items-baseline gap-1.5"><span class="text-3xl font-extrabold tracking-tight tabular-nums">${usd(d.available_usd)}</span><span class="text-sm font-semibold text-velcro-green">USDC</span></p>
      <p class="mt-1 text-xs text-white/60">Pending ${usd(d.pending_usd)} · Paid out ${usd(d.paid_usd)}</p>
    </div>

    <div class="mt-5">${withdraw}</div>

    ${history ? `<p class="mt-6 text-xs font-semibold uppercase tracking-[0.08em] text-gray-400">Withdrawals</p><dl class="success-receipt mt-2 text-sm">${history}</dl>` : ''}`;
}


window.addEventListener('scroll', () => {
  const isAnyOpen = document.querySelector('.custom-select-options.open, .asset-picker-modal.open');
  if (!isAnyOpen) {
    document.querySelectorAll('.premium-card').forEach(c => c.style.zIndex = '');
    const backdrop = document.getElementById('dropdown-backdrop');
    if (backdrop) backdrop.classList.remove('active');
  }
  const nav = document.getElementById('main-nav');
  if (nav) {
    if (window.scrollY > 10) {
      nav.classList.add('nav-scrolled');
    } else {
      nav.classList.remove('nav-scrolled');
    }
  }
}, true);
