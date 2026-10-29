// Velcro Convert admin dashboard.

// Dark mode toggle
function toggleDarkMode() {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    localStorage.setItem('velcro-admin-theme', isDark ? 'dark' : 'light');
    updateDarkModeIcon();
}
function updateDarkModeIcon() {
    const btn = document.getElementById('dark-mode-toggle');
    if (!btn) return;
    const isDark = document.documentElement.classList.contains('dark');
    btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.innerHTML = isDark
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
}
document.addEventListener('DOMContentLoaded', updateDarkModeIcon);

// API Base URL config. All API requests are relative paths so that the panel
// remains origin-agnostic (e.g. ramp.usevelcro.com/goat).
const API_BASE = '';

// Only a signed session token is stored, never the password. Older builds saved the raw
// password under this key; anything that is not a token is discarded and forces a fresh login.
let savedKey = localStorage.getItem('velcro_admin_key') || '';
if (!/^Bearer adm1\./.test(savedKey)) {
    localStorage.removeItem('velcro_admin_key');
    savedKey = '';
}
let adminKey = savedKey;
let currentTxs = [];
let currentUsers = [];

function authenticate() {
    const pass = document.getElementById('admin-pass').value.trim().replace(/^Bearer\s+/i, '');
    const errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';

    fetch(`${API_BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
    })
        .then(res => res.ok ? res.json() : Promise.reject(new Error(res.status === 401 ? 'denied' : `server returned ${res.status}`)))
        .then(data => {
            adminKey = `Bearer ${data.token}`;
            localStorage.setItem('velcro_admin_key', adminKey);
            document.getElementById('admin-pass').value = '';
            document.getElementById('auth-overlay').style.display = 'none';
            fetchData();
        })
        .catch(err => {
            errEl.innerText = err.message === 'denied'
                ? 'Incorrect access key. Access denied.'
                : 'Unable to connect to server: ' + err.message;
            errEl.style.display = 'block';
        });
}

let currentConfig = {};
let currentSettings = null;

function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.style.cssText = 'pointer-events:auto;min-width:240px;max-width:380px;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,0.15);transition:all 0.3s ease;display:flex;align-items:center;gap:10px;color:white;opacity:0;transform:translateY(10px);';
    if (type === 'success') {
        toast.style.background = '#10B981';
    } else if (type === 'error') {
        toast.style.background = '#EF4444';
    } else {
        toast.style.background = '#0D0D59';
    }
    toast.innerText = message;
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

async function fetchData() {
    const btn = document.querySelector('.refresh-btn');
    if (btn) btn.classList.add('spinning');
    const headers = { 'Authorization': adminKey };

    try {
        // Fetch stats, config, transactions, users, settings in parallel for maximum speed
        const [statsRes, configRes, txRes, userRes, settingsRes] = await Promise.all([
            fetch(`${API_BASE}/api/admin/stats`, { headers }),
            fetch(`${API_BASE}/api/admin/config`, { headers }),
            fetch(`${API_BASE}/api/admin/transactions`, { headers }),
            fetch(`${API_BASE}/api/admin/users`, { headers }),
            fetch(`${API_BASE}/api/admin/settings`, { headers })
        ]);

        if ([statsRes, configRes, txRes, userRes, settingsRes].some(r => r.status === 401)) {
            throw new Error('Status: 401');
        }

        // 1. Stats
        if (statsRes.ok) {
            const stats = await statsRes.json();
            document.getElementById('stat-total-users').innerText = stats.totalUsers;
            document.getElementById('stat-total-txs').innerText = stats.allTransactions;
            document.getElementById('stat-total-volume').innerText = `$${Number(stats.totalVolumeUSD).toLocaleString(undefined, {maximumFractionDigits: 0})} | ₦${Number(stats.totalVolumeNGN).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
            document.getElementById('stat-total-earned').innerText = `${Number(stats.developerFees.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${stats.developerFees.currency || 'USDC'}`;
        }

        // 2. Config (recipient address, etc.)
        if (configRes.ok) {
            currentConfig = await configRes.json();
            const recipientEl = document.getElementById('withdraw-recipient-display');
            if (recipientEl && currentConfig.developer_recipient) {
                recipientEl.innerText = currentConfig.developer_recipient.slice(0, 6) + '...' + currentConfig.developer_recipient.slice(-6);
                recipientEl.title = currentConfig.developer_recipient;
            }
            const banner = document.getElementById('withdraw-security-banner');
            const withdrawBtn = document.getElementById('btn-withdraw-otp');
            if (banner && currentConfig.withdrawal_allowed === false) {
                banner.classList.remove('hidden');
                if (withdrawBtn) {
                    withdrawBtn.style.opacity = '0.5';
                    withdrawBtn.style.cursor = 'not-allowed';
                    withdrawBtn.title = 'Withdrawal blocked — address not whitelisted';
                }
            } else if (banner) {
                banner.classList.add('hidden');
                if (withdrawBtn) {
                    withdrawBtn.style.opacity = '1';
                    withdrawBtn.style.cursor = 'pointer';
                    withdrawBtn.title = 'Withdraw all fees to Solana wallet';
                }
            }
        }

        // 3. Transactions
        if (txRes.ok) {
            currentTxs = scrub(await txRes.json());
            renderTransactions(currentTxs);
            computeStats(currentTxs);
        }

        // 4. Users (Wallets)
        if (userRes.ok) {
            const users = scrub(await userRes.json());
            currentUsers = users || [];
            renderUsers(currentUsers);
        }

        // 5. Settings
        if (settingsRes.ok) {
            const settings = await settingsRes.json();
            currentSettings = settings;
            document.getElementById('fee-input').value = settings.platform_fee;
            if (document.getElementById('paj-fee-input')) {
                document.getElementById('paj-fee-input').value = settings.paj_fee !== undefined ? settings.paj_fee : 0.5;
            }
            if (document.getElementById('paj-margin-input')) {
                document.getElementById('paj-margin-input').value = settings.paj_rate_margin !== undefined ? settings.paj_rate_margin : 0.0;
            }
            document.getElementById('buy-max-input').value = settings.buy_max_limit;
            document.getElementById('sell-min-input').value = settings.sell_min_limit;
            document.getElementById('sell-max-input').value = settings.sell_max_limit;
            document.getElementById('paj-email-input').value = settings.paj_email || '';
            if (document.getElementById('telegram-bot-token')) {
                document.getElementById('telegram-bot-token').value = settings.telegram_bot_token || '';
                document.getElementById('telegram-chat-id').value = settings.telegram_chat_id || '';
                document.getElementById('telegram-alerts-toggle').checked = !!settings.telegram_alerts_enabled;
            }
        }

        // 6. PAJ Session
        await fetchPajSession();

        lucide.createIcons();
    } catch (e) {
        console.error(e);
        if (e.message.includes('401')) { logout(); return; }
        const isRateLimit = e.message.includes('429');
        const errMsg = isRateLimit ? 'Rate limit exceeded. Please wait a minute before retrying.' : 'Unable to connect to server.';
        
        // Show connection error in stats area
        document.getElementById('stat-total-users').innerText = '—';
        document.getElementById('stat-total-txs').innerText = '—';
        document.getElementById('stat-total-volume').innerText = isRateLimit ? 'Rate limit exceeded' : 'Server unreachable';
        document.getElementById('stat-total-earned').innerText = '—';
        document.getElementById('stat-completed').innerText = '—';
        document.getElementById('stat-success-rate').innerText = '';
        document.getElementById('stat-pending').innerText = '—';
        document.getElementById('stat-onramp-vol').innerText = '—';
        document.getElementById('stat-offramp-vol').innerText = '—';
        const retryBtn = `<button onclick="fetchData()" class="btn-primary" style="margin-top:10px;">Retry</button>`;
        document.getElementById('tx-summary-body').innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--failed);padding:20px;">${errMsg}<br>${retryBtn}</td></tr>`;
        document.getElementById('all-tx-body').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--failed);padding:20px;">${errMsg}<br>${retryBtn}</td></tr>`;
    } finally {
        if (btn) btn.classList.remove('spinning');
    }
}

function setPajMessage(text, type) {
    const el = document.getElementById('paj-message');
    el.innerText = text;
    el.classList.remove('hidden');
    if (type === 'error') {
        el.style.background = '#fef2f2';
        el.style.color = '#dc2626';
        el.style.borderColor = '#fecaca';
    } else if (type === 'success') {
        el.style.background = '#f0fdf4';
        el.style.color = '#166534';
        el.style.borderColor = '#bbf7d0';
    } else {
        el.style.background = '#f8f9fc';
        el.style.color = 'var(--text-main)';
        el.style.borderColor = 'var(--border)';
    }
    setTimeout(() => el.classList.add('hidden'), 6000);
}

function formatDate(d) {
    if (!d) return '';
    const date = new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setPajStatus(state, title, sub, iconName, expiresAt) {
    const statusEl = document.getElementById('paj-session-status');
    const iconWrap = document.getElementById('paj-status-icon');
    const titleEl = document.getElementById('paj-status-title');
    const subEl = document.getElementById('paj-status-sub');

    titleEl.innerText = title;
    let subtitle = sub || '';
    if (state === 'active' && expiresAt) {
        subtitle += (subtitle ? ' · ' : '') + 'Expires ' + formatDate(expiresAt);
    }
    subEl.innerText = subtitle;
    iconWrap.innerHTML = `<i data-lucide="${iconName}" style="width: 20px; height: 20px; color: white;"></i>`;

    if (state === 'active') {
        statusEl.style.background = '#f0fdf4';
        statusEl.style.borderColor = '#bbf7d0';
        iconWrap.style.background = 'var(--success)';
    } else if (state === 'expired') {
        statusEl.style.background = '#fffbeb';
        statusEl.style.borderColor = '#fde68a';
        iconWrap.style.background = '#f59e0b';
    } else if (state === 'error') {
        statusEl.style.background = '#fef2f2';
        statusEl.style.borderColor = '#fecaca';
        iconWrap.style.background = 'var(--failed)';
    } else {
        statusEl.style.background = '#f8f9fc';
        statusEl.style.borderColor = 'var(--border)';
        iconWrap.style.background = '#cbd5e1';
    }
    if (window.lucide) lucide.createIcons();
}

async function fetchPajSession() {
    try {
        const res = await fetch(`${API_BASE}/api/paj/session`, { headers: { 'Authorization': adminKey } });
        const data = await res.json();
        const status = data.data || {};
        const otpSection = document.getElementById('paj-otp-section');
        const initiateBtn = document.getElementById('paj-initiate-btn');

        if (status.isValid) {
            setPajStatus('active', 'Session Active', `Email: ${status.email || '-'}`, 'check', status.expiresAt);
            if (otpSection) otpSection.classList.add('hidden');
            if (initiateBtn) initiateBtn.innerHTML = '<i data-lucide="refresh-cw" style="width: 16px; height: 16px;"></i><span>Re-initiate</span>';
        } else if (status.hasSession) {
            setPajStatus('expired', 'Session Expired', `Email: ${status.email || '-'} — Re-verify to continue`, 'clock', status.expiresAt);
            if (otpSection) otpSection.classList.remove('hidden');
            if (initiateBtn) initiateBtn.innerHTML = '<i data-lucide="send" style="width: 16px; height: 16px;"></i><span>Initiate Session</span>';
        } else {
            setPajStatus('inactive', 'No Active Session', 'Launch session manager to activate', 'shield-alert');
            if (otpSection) otpSection.classList.add('hidden');
            if (initiateBtn) initiateBtn.innerHTML = '<i data-lucide="send" style="width: 16px; height: 16px;"></i><span>Initiate Session</span>';
        }
        if (window.lucide) lucide.createIcons();
    } catch (e) {
        setPajStatus('error', 'Connection Error', 'Could not reach PAJ service', 'wifi-off');
        console.error('PAJ session fetch failed:', e);
    }
}

async function initiatePajSession() {
    const btn = document.getElementById('paj-initiate-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader-2" style="width: 16px; height: 16px;" class="spinning"></i><span>Sending...</span>';
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/admin/paj/initiate`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
            setPajMessage('OTP sent! Check your email inbox.', 'success');
            document.getElementById('paj-otp-section').classList.remove('hidden');
            document.getElementById('paj-otp-input').focus();
        } else {
            setPajMessage(data.error || 'Failed to initiate PAJ session', 'error');
        }
    } catch (e) {
        setPajMessage('Error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
}

async function verifyPajOtp() {
    const otp = document.getElementById('paj-otp-input').value.trim();
    if (!otp) { setPajMessage('Please enter the OTP', 'error'); return; }
    const btn = document.getElementById('paj-verify-btn');
    const originalText = btn.innerText;
    btn.innerText = 'Verifying...';
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/admin/paj/verify`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ otp })
        });
        const data = await res.json();
        if (data.success) {
            setPajMessage('PAJ session verified successfully!', 'success');
            document.getElementById('paj-otp-input').value = '';
            await fetchPajSession();
        } else {
            setPajMessage(data.error || 'Verification failed', 'error');
        }
    } catch (e) {
        setPajMessage('Error: ' + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function setSettingsMessage(text, type) {
    const el = document.getElementById('settings-message');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    if (type === 'error') {
        el.style.background = '#fef2f2';
        el.style.color = '#dc2626';
        el.style.border = '1px solid #fecaca';
    } else if (type === 'success') {
        el.style.background = '#f0fdf4';
        el.style.color = '#166534';
        el.style.border = '1px solid #bbf7d0';
    } else {
        el.style.background = '#f8f9fc';
        el.style.color = 'var(--text-main)';
        el.style.border = '1px solid var(--border)';
    }
    setTimeout(() => { el.classList.add('hidden'); }, 5000);
}

async function saveSettings() {
    const feeInput = document.getElementById('fee-input');
    const fee = parseFloat(feeInput.value);
    if (Number.isNaN(fee) || fee < 0 || fee > 10) {
        setSettingsMessage('Switch Fee must be between 0 and 10%', 'error');
        return;
    }
    const pajFeeInput = document.getElementById('paj-fee-input');
    const pajFee = pajFeeInput ? parseFloat(pajFeeInput.value) : 0.5;
    if (Number.isNaN(pajFee) || pajFee < 0 || pajFee > 10) {
        setSettingsMessage('PAJ Fee must be between 0 and 10%', 'error');
        return;
    }
    const pajMarginInput = document.getElementById('paj-margin-input');
    const pajMargin = pajMarginInput ? (parseFloat(pajMarginInput.value) || 0.0) : 0.0;

    const buyMax = parseFloat(document.getElementById('buy-max-input').value);
    const sellMin = parseFloat(document.getElementById('sell-min-input').value);
    const sellMax = parseFloat(document.getElementById('sell-max-input').value);
    if (Number.isNaN(buyMax) || buyMax < 1000 || buyMax > 10000000) {
        setSettingsMessage('Buy maximum must be between 1,000 and 10,000,000', 'error');
        return;
    }
    if (Number.isNaN(sellMin) || sellMin < 1 || sellMin > 100000) {
        setSettingsMessage('Sell minimum must be between 1 and 100,000', 'error');
        return;
    }
    if (Number.isNaN(sellMax) || sellMax < 10 || sellMax > 1000000) {
        setSettingsMessage('Sell maximum must be between 10 and 1,000,000', 'error');
        return;
    }
    if (sellMax <= sellMin) {
        setSettingsMessage('Sell maximum must be greater than sell minimum', 'error');
        return;
    }
    const btn = document.querySelector('#section-settings .btn-primary');
    const originalText = btn.innerText;
    btn.innerText = 'Saving...';
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/admin/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': adminKey },
            body: JSON.stringify({
                platform_fee: fee,
                paj_fee: pajFee,
                paj_rate_margin: pajMargin,
                buy_max_limit: buyMax,
                sell_min_limit: sellMin,
                sell_max_limit: sellMax
            })
        });
        const data = await res.json();
        if (data.success) {
            setSettingsMessage(`Saved successfully. Switch Fee: ${fee}%, PAJ Fee: ${pajFee}%, PAJ Margin: ₦${pajMargin}`, 'success');
        } else {
            setSettingsMessage(data.error || 'Failed to save settings', 'error');
        }
    } catch (e) {
        setSettingsMessage('Error saving settings: ' + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function savePajEmail() {
    const emailInput = document.getElementById('paj-email-input');
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) { setPajMessage('Please enter a valid email', 'error'); return; }
    const btn = document.getElementById('paj-save-email-btn');
    const originalText = btn.innerText;
    btn.innerText = 'Saving...';
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/admin/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': adminKey },
            body: JSON.stringify({ paj_email: email })
        });
        const data = await res.json();
        if (data.success) {
            setPajMessage('PAJ email updated to ' + email, 'success');
            await fetchPajSession();
        } else {
            setPajMessage(data.error || 'Failed to save email', 'error');
        }
    } catch (e) {
        setPajMessage('Error saving email: ' + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function syncAllLiveStatuses() {
    const btn = document.getElementById('sync-all-btn');
    const statusEl = document.getElementById('sync-all-status');
    if (btn) { btn.disabled = true; btn.innerText = 'Syncing Live...'; }
    if (statusEl) statusEl.style.display = 'none';
    try {
        const res = await fetch(`${API_BASE}/api/admin/sync-all-statuses`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--success)';
                statusEl.innerText = `Synced ${data.synced_count} pending transaction(s) directly from Switch/PAJ APIs.`;
            }
            if (btn) btn.innerText = 'Synced ✓';
            await fetchDashboardData();
        } else {
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--failed)';
                statusEl.innerText = data.error || 'Sync failed';
            }
            if (btn) { btn.disabled = false; btn.innerText = 'Sync All Pending'; }
        }
    } catch (e) {
        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.innerText = e.message || 'Network error';
        }
        if (btn) { btn.disabled = false; btn.innerText = 'Sync All Pending'; }
    }
}

async function fixPajStatuses() {
    const btn = document.getElementById('fix-paj-status-btn');
    const statusEl = document.getElementById('fix-paj-status-result');
    btn.disabled = true;
    btn.innerText = 'Fixing...';
    statusEl.style.display = 'none';
    try {
        const res = await fetch(`${API_BASE}/api/admin/fix-paj-statuses`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--success)';
            statusEl.innerText = `Fixed ${data.fixed} PAJ transactions. Refresh to see changes.`;
            btn.innerText = 'Fixed ✓';
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.innerText = data.error || 'Fix failed';
            btn.disabled = false;
            btn.innerText = 'Fix PAJ Statuses';
        }
    } catch (e) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.innerText = e.message || 'Network error';
        btn.disabled = false;
        btn.innerText = 'Fix PAJ Statuses';
    }
}

async function fixPajChannels() {
    const btn = document.getElementById('fix-paj-btn');
    const statusEl = document.getElementById('fix-paj-status');
    btn.disabled = true;
    btn.innerText = 'Fixing...';
    statusEl.style.display = 'none';
    try {
        const res = await fetch(`${API_BASE}/api/admin/fix-paj-channels`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--success)';
            statusEl.innerText = `Fixed ${data.fixed} PAJ transactions. Refresh to see changes.`;
            btn.innerText = 'Fixed ✓';
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.innerText = data.error || 'Fix failed';
            btn.disabled = false;
            btn.innerText = 'Fix PAJ Channels';
        }
    } catch (e) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.innerText = e.message || 'Network error';
        btn.disabled = false;
        btn.innerText = 'Fix PAJ Channels';
    }
}

function getWalletExplorerUrl(address, network) {
    const map = {
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
    return map[network?.toLowerCase()] || '#';
}

// Switch assets are "chain:symbol"; PAJ assets are bare symbols and always on Solana.
function txChain(tx) {
    const asset = String(tx.asset || '');
    return asset.includes(':') ? asset.split(':')[0].toLowerCase() : 'solana';
}

function assetSymbol(asset) {
    const a = String(asset || '');
    return (a.includes(':') ? a.split(':')[1] : a).toUpperCase();
}

function getTxExplorerUrl(hash, network) {
    const map = {
        'solana': `https://solscan.io/tx/${hash}`,
        'ethereum': `https://etherscan.io/tx/${hash}`,
        'bsc': `https://bscscan.com/tx/${hash}`,
        'polygon': `https://polygonscan.com/tx/${hash}`,
        'arbitrum': `https://arbiscan.io/tx/${hash}`,
        'base': `https://basescan.org/tx/${hash}`,
        'tron': `https://tronscan.org/#/transaction/${hash}`,
        'optimism': `https://optimistic.etherscan.io/tx/${hash}`,
        'avalanche': `https://snowtrace.io/tx/${hash}`,
    };
    return map[String(network || '').toLowerCase()] || '#';
}

function isPajTx(tx) {
    if (!tx) return false;
    if (tx.channel === 'PAJ') return true;
    if (tx.reference?.startsWith('paj_')) return true;
    if (tx.deposit_bank_name?.toLowerCase().includes('paj')) return true;
    try {
        const meta = JSON.parse(tx.meta || '{}');
        if (meta.mint || meta.provider === 'PAJ' || meta.id?.startsWith('paj')) return true;
    } catch (e) {}
    return false;
}

function getTxCurrencySymbol(tx) {
    if (!tx) return '$';
    if (tx.type === 'ONRAMP') return '\u20A6';
    if (isPajTx(tx)) return '\u20A6'; // PAJ OFFRAMP amounts are in NGN
    return '$'; // Switch OFFRAMP amounts are in crypto (USD)
}

function getTxVolumes(tx) {
    if (!tx) return { usd: 0, ngn: 0 };
    const rate = safeNum(tx.rate, 1500) || 1500;
    const isPaj = isPajTx(tx);
    const amt = safeNum(tx.amount || tx.fiat_amount);
    const dest = safeNum(tx.destination_amount);
    const asset = ((tx.asset || '') + '').toUpperCase();
    const curr = ((tx.currency || '') + '').toUpperCase();
    const destCurr = ((tx.destination_currency || '') + '').toUpperCase();
    const isDollarAsset = ['USDT', 'USDC', 'USD'].includes(asset) ||
        ['USDT', 'USDC', 'USD'].includes(curr) ||
        ['USDT', 'USDC', 'USD'].includes(destCurr);

    let usd = 0;
    let ngn = 0;

    if (tx.type === 'ONRAMP') {
        ngn = amt;
        if (isDollarAsset && dest > 0) {
            usd = dest;
        } else {
            usd = rate > 0 ? (amt / rate) : (amt / 1500);
        }
    } else {
        // OFFRAMP (Sell)
        if (isPaj) {
            ngn = amt;
            usd = rate > 0 ? (amt / rate) : (amt / 1500);
        } else {
            // Switch OFFRAMP: amt is crypto/USD, dest is NGN
            if (dest > 0) {
                ngn = dest;
                usd = (isDollarAsset && amt > 0) ? amt : (dest / (rate > 0 ? rate : 1500));
            } else if (isDollarAsset && amt > 0) {
                usd = amt;
                ngn = amt * (rate > 0 ? rate : 1500);
            } else {
                usd = amt;
                ngn = usd * (rate > 0 ? rate : 1500);
            }
        }
    }
    return { usd, ngn };
}

function formatTxTableAmount(tx) {
    const vols = getTxVolumes(tx);
    const sym = getTxCurrencySymbol(tx);
    const amt = safeNum(tx.amount);
    const maxDigits = sym === '$' ? 4 : 2;
    const primary = `${sym}${amt.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: maxDigits})}`;
    
    let approx = '';
    if (sym === '\u20A6') {
        approx = `~$${vols.usd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} USD`;
    } else {
        approx = `~₦${vols.ngn.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} NGN`;
    }
    return `<div><b>${primary}</b><div style="font-size: 11px; color: var(--text-secondary); font-weight: 500; margin-top: 1px;">${approx}</div></div>`;
}

function getDisplayUser(tx) {
    let email = tx.email;
    let wallet = tx.wallet_address || tx.deposit_address || '';
    if (!wallet && tx.beneficiary) {
        try {
            const ben = typeof tx.beneficiary === 'string' ? JSON.parse(tx.beneficiary) : tx.beneficiary;
            if (ben && ben.wallet_address) {
                wallet = ben.wallet_address;
            }
        } catch (e) {}
    }

    // Cross-reference: if email is missing, find matching email from other transactions with same wallet
    if (!email && wallet && typeof currentTxs !== 'undefined' && Array.isArray(currentTxs)) {
        const match = currentTxs.find(t => t.email && (
            (t.wallet_address && t.wallet_address.toLowerCase() === wallet.toLowerCase()) ||
            (t.deposit_address && t.deposit_address.toLowerCase() === wallet.toLowerCase())
        ));
        if (match) {
            email = match.email;
        }
    }

    if (email) {
        const avatarVal = email.slice(0, 2).toUpperCase();
        return {
            avatar: avatarVal,
            display: email,
            wallet: wallet
        };
    }
    if (wallet) {
        return {
            avatar: wallet.slice(0, 2).toUpperCase(),
            display: wallet.length > 14 ? (wallet.slice(0, 6) + '...' + wallet.slice(-4)) : wallet,
            wallet: wallet
        };
    }
    return {
        avatar: 'GU',
        display: 'Guest User',
        wallet: ''
    };
}

function renderTransactions(txs) {
    const summaryBody = document.getElementById('tx-summary-body');
    const allBody = document.getElementById('all-tx-body');
    
    const channelBadge = (tx) => {
        const paj = isPajTx(tx);
        const label = paj ? 'PAJ' : 'Switch';
        const color = paj ? 'background: rgba(124, 58, 237, 0.1); color: #7c3aed;' : 'background: rgba(13, 13, 89, 0.1); color: var(--velcro-navy);';
        return `<span style="${color} padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700;">${label}</span>`;
    };
    const summaryRows = txs.map(tx => {
        const user = getDisplayUser(tx);
        const userVal = tx.email || tx.wallet_address || tx.deposit_address || '';
        return `
        <tr onclick="viewTransaction('${tx.reference}')" style="cursor: pointer;" title="Click to view details">
            <td data-label="User" onclick="event.stopPropagation(); ${userVal ? `viewWalletDetails('${userVal}')` : ''}" title="${userVal ? 'Click to view user profile' : ''}"><div class="user-cell" style="cursor: pointer;"><div class="avatar">${user.avatar}</div><b style="font-size: 11px; max-width: 150px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary-link);" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${user.display}</b></div></td>
            <td data-label="Type"><b>${tx.type}</b></td>
            <td data-label="Channel">${channelBadge(tx)}</td>
            <td data-label="Amount">${formatTxTableAmount(tx)}</td>
            <td data-label="Status"><span class="status-pill ${tx.status.toLowerCase()}">${statusLabel(tx.status)}</span></td>
            <td data-label="Time">${new Date(tx.created_at).toLocaleDateString()}</td>
        </tr>
        `;
    });

    const allRows = txs.map(tx => {
        const user = getDisplayUser(tx);
        const userVal = tx.email || tx.wallet_address || tx.deposit_address || '';
        return `
        <tr>
            <td data-label="User" onclick="event.stopPropagation(); ${userVal ? `viewWalletDetails('${userVal}')` : ''}" title="${userVal ? 'Click to view user profile' : ''}"><div class="user-cell" style="cursor: pointer;"><div class="avatar">${user.avatar}</div><b style="font-size: 11px; max-width: 150px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary-link);" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${user.display}</b></div></td>
            <td data-label="Reference" class="hide-mobile">${tx.reference.slice(0, 10)}...</td>
            <td data-label="Type"><b>${tx.type}</b></td>
            <td data-label="Channel">${channelBadge(tx)}</td>
            <td data-label="Amount">${formatTxTableAmount(tx)}</td>
            <td data-label="Status"><span class="status-pill ${tx.status.toLowerCase()}">${statusLabel(tx.status)}</span></td>
            <td data-label="Date" class="hide-mobile">${new Date(tx.created_at).toLocaleDateString()}</td>
            <td data-label="Action"><button class="btn-view" onclick="viewTransaction('${tx.reference}')">Details</button></td>
        </tr>
        `;
    });

    if (summaryRows.length === 0) {
        summaryBody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary);font-size:13px;">No transactions found</td></tr>';
    } else {
        summaryBody.innerHTML = summaryRows.slice(0, 8).join('');
    }

    if (allRows.length === 0) {
        allBody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-secondary);font-size:13px;">No transactions found</td></tr>';
    } else {
        allBody.innerHTML = allRows.join('');
    }
}

function filterUsers() {
    const query = (document.getElementById('user-search-input')?.value || '').trim().toLowerCase();
    if (!query) {
        renderUsers(currentUsers);
        return;
    }
    const filtered = currentUsers.filter(u => 
        (u.id && u.id.toLowerCase().includes(query)) ||
        (u.email && u.email.toLowerCase().includes(query)) ||
        (u.wallet_address && u.wallet_address.toLowerCase().includes(query)) ||
        (Array.isArray(u.wallets) && u.wallets.some(w => w && w.toLowerCase().includes(query)))
    );
    renderUsers(filtered);
}

function renderUsers(users) {
    const countLabel = document.getElementById('user-count-label');
    if (countLabel) countLabel.innerText = `${users.length} users found.`;
    const body = document.getElementById('user-body');
    if (!body) return;

    if (!users || users.length === 0) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary);font-size:13px;">No users found</td></tr>';
        return;
    }

    body.innerHTML = users.map(u => {
        const volUSD = safeNum(u.total_volume_usd !== undefined ? u.total_volume_usd : u.total_volume);
        const volNGN = safeNum(u.total_volume_ngn) || (volUSD * 1500);
        const email = u.email || (u.id && u.id.includes('@') ? u.id : '');
        const wallets = (Array.isArray(u.wallets) && u.wallets.length) ? u.wallets : (u.wallet_address ? [u.wallet_address] : []);
        const primaryWallet = wallets[0] || u.wallet_address || '';
        const targetKey = email || primaryWallet || u.id;

        const emailHtml = email 
            ? `<div style="display:flex;align-items:center;gap:6px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--primary-link);flex-shrink:0;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>
                <b style="font-size: 12px; color: var(--primary-link); word-break: break-all;">${email}</b>
               </div>`
            : `<span style="font-size: 11px; color: var(--text-secondary); font-style: italic;">No email</span>`;

        let walletHtml = '';
        if (!wallets.length) {
            walletHtml = `<span style="font-size: 11px; color: var(--text-secondary); font-style: italic;">—</span>`;
        } else if (wallets.length === 1) {
            const w = wallets[0];
            walletHtml = `<div style="font-family: monospace; font-size: 11px; color: var(--text-secondary); display:flex; align-items:center; gap:4px;" title="${w}">
                <span>${w.length > 16 ? w.slice(0, 8) + '...' + w.slice(-6) : w}</span>
                <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${w}'); showToast('Wallet copied', 'success');" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-secondary);font-size:11px;" title="Copy wallet">📋</button>
               </div>`;
        } else {
            const w = wallets[0];
            const tooltipList = wallets.map((addr, idx) => `${idx + 1}. ${addr}`).join('\n');
            walletHtml = `<div style="display:flex; flex-direction:column; gap:4px;">
                <div style="font-family: monospace; font-size: 11px; color: var(--text-secondary); display:flex; align-items:center; gap:4px;" title="${w}">
                    <span>${w.length > 14 ? w.slice(0, 6) + '...' + w.slice(-4) : w}</span>
                    <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${w}'); showToast('Wallet copied', 'success');" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-secondary);font-size:11px;" title="Copy latest address">📋</button>
                </div>
                <div>
                    <span onclick="event.stopPropagation(); viewWalletDetails('${targetKey}')" style="background: rgba(13, 13, 89, 0.08); color: var(--velcro-navy); padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;" title="User has used ${wallets.length} addresses:\n${tooltipList}">
                        +${wallets.length - 1} more (${wallets.length} addrs)
                    </span>
                </div>
            </div>`;
        }

        return `
        <tr>
            <td data-label="User Email">${emailHtml}</td>
            <td data-label="Addresses Used">${walletHtml}</td>
            <td data-label="First Seen">${new Date(u.created_at).toLocaleDateString()}</td>
            <td data-label="Total Volume">
                <div><b>$${volUSD.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</b></div>
                <div style="font-size: 11px; color: var(--text-secondary); font-weight: 500;">~₦${volNGN.toLocaleString(undefined, {maximumFractionDigits: 0})}</div>
            </td>
            <td data-label="TXs">${u.tx_count}</td>
            <td data-label="Action"><button class="btn-view" onclick="viewWalletDetails('${targetKey}')">View</button></td>
        </tr>
        `;
    }).join('');
}

function safeNum(val, fallback = 0) {
    if (val === null || val === undefined || val === '') return fallback;
    const n = Number(val);
    return isNaN(n) ? fallback : n;
}

function computeStats(txs) {
    if (!txs || !txs.length) {
        document.getElementById('stat-completed').innerText = '0';
        document.getElementById('stat-success-rate').innerText = '0% success';
        document.getElementById('stat-pending').innerText = '0';
        document.getElementById('stat-onramp-vol').innerText = '$0 | ~₦0';
        document.getElementById('stat-offramp-vol').innerText = '$0 | ~₦0';
        renderAnalytics(txs);
        return;
    }

    const completed = txs.filter(t => t.status === 'COMPLETED');
    const pending = txs.filter(t => ['PENDING', 'AWAITING_DEPOSIT', 'DETECTED', 'PROCESSING', 'INITIATED'].includes(t.status));
    const successRate = txs.length ? Math.round((completed.length / txs.length) * 100) : 0;

    let onrampUSD = 0, onrampNGN = 0;
    let offrampUSD = 0, offrampNGN = 0;

    completed.forEach(t => {
        const vols = getTxVolumes(t);
        if (t.type === 'ONRAMP') {
            onrampNGN += vols.ngn;
            onrampUSD += vols.usd;
        } else if (t.type === 'OFFRAMP') {
            offrampNGN += vols.ngn;
            offrampUSD += vols.usd;
        }
    });

    document.getElementById('stat-completed').innerText = completed.length.toLocaleString();
    document.getElementById('stat-success-rate').innerText = `${successRate}% success rate`;
    document.getElementById('stat-pending').innerText = pending.length.toLocaleString();
    document.getElementById('stat-onramp-vol').innerText = `$${safeNum(onrampUSD).toLocaleString(undefined, {maximumFractionDigits: 2})} | ~₦${safeNum(onrampNGN).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
    document.getElementById('stat-offramp-vol').innerText = `$${safeNum(offrampUSD).toLocaleString(undefined, {maximumFractionDigits: 2})} | ~₦${safeNum(offrampNGN).toLocaleString(undefined, {maximumFractionDigits: 0})}`;

    renderAnalytics(txs);
}

function renderAnalytics(txs) {
    if (!txs) txs = currentTxs || [];
    const completed = txs.filter(t => t.status === 'COMPLETED');

    // Calculate revenue using dynamic platform fee from settings (or default 0.5%)
    const feePercent = (currentSettings && currentSettings.platform_fee !== undefined) ? Number(currentSettings.platform_fee) : 0.5;
    const feeRate = feePercent / 100;

    function txRevenueUSD(t) {
        const vols = getTxVolumes(t);
        return vols.usd * feeRate;
    }

    const totalRevenueUSD = completed.reduce((s, t) => s + txRevenueUSD(t), 0);

    const pajCompleted = completed.filter(t => isPajTx(t));
    const switchCompleted = completed.filter(t => !isPajTx(t));
    const pajRevenueUSD = pajCompleted.reduce((s, t) => s + txRevenueUSD(t), 0);
    const switchRevenueUSD = switchCompleted.reduce((s, t) => s + txRevenueUSD(t), 0);

    // Avg transaction size in USD
    const avgTx = completed.length ? (completed.reduce((s, t) => s + getTxVolumes(t).usd, 0) / completed.length) : 0;

    document.getElementById('analytic-total-revenue').innerText = `$${safeNum(totalRevenueUSD).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('analytic-paj-revenue').innerText = `$${safeNum(pajRevenueUSD).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('analytic-switch-revenue').innerText = `$${safeNum(switchRevenueUSD).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    document.getElementById('analytic-avg-tx').innerText = `$${safeNum(avgTx).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

    renderBreakdowns(txs);
    calculateProfit();
}

function renderBreakdowns(txs) {
    const statuses = {};
    const channels = { PAJ: 0, Switch: 0 };
    txs.forEach(t => {
        statuses[t.status] = (statuses[t.status] || 0) + 1;
        channels[isPajTx(t) ? 'PAJ' : 'Switch']++;
    });
    const total = txs.length || 1;

    const statusColors = {
        COMPLETED: '#A8CF45',
        PENDING: '#ffb547',
        AWAITING_DEPOSIT: '#f59e0b',
        DETECTED: '#3b82f6',
        PROCESSING: '#8b5cf6',
        FAILED: '#ee5d50',
        CANCELLED: '#94a3b8',
        INITIATED: '#06b6d4'
    };

    const statusHtml = Object.entries(statuses).sort((a, b) => b[1] - a[1]).map(([status, count]) => {
        const pct = Math.round((count / total) * 100);
        const color = statusColors[status] || '#64748b';
        return `
            <div class="breakdown-row">
                <div class="label"><span class="dot" style="background:${color}"></span>${status.replace(/_/g, ' ')}</div>
                <div class="value">${count} <span style="color:var(--text-secondary);font-weight:500">(${pct}%)</span></div>
            </div>
            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        `;
    }).join('');
    document.getElementById('status-breakdown').innerHTML = statusHtml || '<p style="color:var(--text-secondary);font-size:13px">No data</p>';

    const channelTotal = (channels.PAJ + channels.Switch) || 1;
    const pajPct = Math.round((channels.PAJ / channelTotal) * 100);
    const switchPct = Math.round((channels.Switch / channelTotal) * 100);
    const channelHtml = `
        <div class="breakdown-row">
            <div class="label"><span class="dot" style="background:#7c3aed"></span>PAJ</div>
            <div class="value">${channels.PAJ} <span style="color:var(--text-secondary);font-weight:500">(${pajPct}%)</span></div>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pajPct}%;background:#7c3aed"></div></div>
        <div class="breakdown-row" style="margin-top:16px">
            <div class="label"><span class="dot" style="background:var(--velcro-navy)"></span>Switch</div>
            <div class="value">${channels.Switch} <span style="color:var(--text-secondary);font-weight:500">(${switchPct}%)</span></div>
        </div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${switchPct}%;background:var(--velcro-navy)"></div></div>
    `;
    document.getElementById('channel-breakdown').innerHTML = channelHtml;
}

function calculateProfit() {
    const revenueText = document.getElementById('analytic-total-revenue').innerText.replace(/[^0-9.]/g, '');
    const revenue = parseFloat(revenueText) || 0;

    const costs = ['cost-switch', 'cost-paj', 'cost-infra', 'cost-marketing', 'cost-other'].map(id => {
        const val = document.getElementById(id)?.value;
        return parseFloat(val) || 0;
    });
    const totalCost = costs.reduce((a, b) => a + b, 0);
    const net = revenue - totalCost;
    const margin = revenue > 0 ? ((net / revenue) * 100) : 0;

    const netEl = document.getElementById('profit-net');
    const marginEl = document.getElementById('profit-margin');

    netEl.innerText = `${net >= 0 ? '$' : '-$'}${Math.abs(net).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    netEl.style.color = net >= 0 ? '#A8CF45' : '#ee5d50';
    marginEl.innerText = `${margin >= 0 ? '+' : ''}${margin.toFixed(1)}% margin · $${totalCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} total costs`;
}

// Load saved costs
['cost-switch', 'cost-paj', 'cost-infra', 'cost-marketing', 'cost-other'].forEach(id => {
    const saved = localStorage.getItem('velcro_cost_' + id);
    if (saved !== null) {
        const el = document.getElementById(id);
        if (el) el.value = saved;
    }
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
        localStorage.setItem('velcro_cost_' + id, el.value);
    });
});

let currentModalTx = null;

function viewTransaction(ref) {
    const tx = currentTxs.find(t => t.reference === ref);
    if (!tx) return;
    currentModalTx = tx;
    document.getElementById('modal-ref').innerText = tx.reference;
    
    updateReceiptDisplay(tx);

    document.getElementById('modal-status').innerText = statusLabel(tx.status);
    document.getElementById('modal-status').className = `status-pill ${tx.status.toLowerCase()}`;
    const modalVols = getTxVolumes(tx);
    const modalSym = getTxCurrencySymbol(tx);
    const modalPrimary = `${modalSym}${safeNum(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const modalApprox = modalSym === '\u20A6'
        ? `~$${modalVols.usd.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} USD`
        : `~₦${modalVols.ngn.toLocaleString(undefined, {maximumFractionDigits: 0})} NGN`;
    document.getElementById('modal-amount').innerHTML = `${modalPrimary} <span style="font-size: 13px; font-weight: normal; color: var(--text-secondary); margin-left: 6px;">(${modalApprox})</span>`;
    document.getElementById('modal-type').innerText = tx.type;
    document.getElementById('modal-channel').innerText = isPajTx(tx) ? 'PAJ' : 'Switch';
    const hashLink = document.getElementById('modal-hash-link');
    const walletExplorerLink = document.getElementById('modal-wallet-explorer-link');
    if (tx.hash) {
        hashLink.innerText = tx.hash;
        hashLink.href = tx.explorer_url || getTxExplorerUrl(tx.hash, txChain(tx));
        walletExplorerLink.style.display = 'none';
    } else if (tx.wallet_address) {
        hashLink.innerText = 'No hash available';
        hashLink.href = '#';
        walletExplorerLink.href = getWalletExplorerUrl(tx.wallet_address, txChain(tx));
        walletExplorerLink.style.display = 'block';
    } else {
        hashLink.innerText = 'No hash available';
        hashLink.href = '#';
        walletExplorerLink.style.display = 'none';
    }
    document.getElementById('modal-date').innerText = new Date(tx.created_at).toLocaleString();

    // Amount Breakdown
    const sentEl = document.getElementById('modal-sent');
    const receivedEl = document.getElementById('modal-received');
    if (tx.type === 'ONRAMP') {
        sentEl.innerText = `₦${safeNum(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        const dest = safeNum(tx.destination_amount);
        receivedEl.innerText = dest > 0 ? `${dest.toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 6})} ${assetSymbol(tx.asset)}` : '-';
    } else {
        // OFFRAMP
        if (isPajTx(tx)) {
            sentEl.innerText = `₦${safeNum(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} NGN (${assetSymbol(tx.asset) || 'Crypto'})`;
            const dest = safeNum(tx.destination_amount || tx.amount);
            receivedEl.innerText = `₦${dest.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        } else {
            sentEl.innerText = `$${safeNum(tx.amount).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} ${assetSymbol(tx.asset)}`;
            const dest = safeNum(tx.destination_amount);
            receivedEl.innerText = dest > 0 ? `₦${dest.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '-';
        }
    }

    // Rate & Fees
    const rateEl = document.getElementById('modal-rate');
    const feesEl = document.getElementById('modal-fees');
    if (tx.rate) {
        rateEl.innerText = `1 ${tx.asset || 'USD'} = ₦${Number(tx.rate).toLocaleString()}`;
    } else {
        rateEl.innerText = '-';
    }
    const feeParts = [];
    if (tx.fee_total) feeParts.push(`Total: ₦${Number(tx.fee_total).toLocaleString()}`);
    if (tx.fee_platform) feeParts.push(`Platform: ₦${Number(tx.fee_platform).toLocaleString()}`);
    if (tx.fee_developer) {
        if (tx.channel === 'PAJ') {
            feeParts.push(`Dev: $${Number(tx.fee_developer).toFixed(2)}`);
        } else {
            feeParts.push(`Dev: ₦${Number(tx.fee_developer).toLocaleString()}`);
        }
    }
    feesEl.innerText = feeParts.length ? feeParts.join(' | ') : '-';

    // Type-specific details
    const onrampSection = document.getElementById('modal-onramp-details');
    const offrampSection = document.getElementById('modal-offramp-details');
    let benObj = {};
    try { if (tx.beneficiary) benObj = typeof tx.beneficiary === 'string' ? JSON.parse(tx.beneficiary) : tx.beneficiary; } catch (e) {}
    let metaObj = {};
    try { if (tx.meta) metaObj = typeof tx.meta === 'string' ? JSON.parse(tx.meta) : tx.meta; } catch (e) {}
    const resolvedWallet = tx.wallet_address
        || benObj.wallet_address
        || (metaObj.beneficiary && metaObj.beneficiary.wallet_address)
        || metaObj.recipient
        || (metaObj.destination && metaObj.destination.address)
        || '';

    if (tx.type === 'ONRAMP') {
        onrampSection.style.display = 'block';
        offrampSection.style.display = 'none';
        // Crypto received
        const destAmount = tx.destination_amount || 0;
        document.getElementById('modal-crypto-amount').innerText = destAmount > 0 ? Number(destAmount).toLocaleString(undefined, {minimumFractionDigits: 4, maximumFractionDigits: 4}) : '-';
        document.getElementById('modal-crypto-asset').innerText = tx.asset || '-';
        document.getElementById('modal-rate-display').innerText = tx.rate ? `1 ${tx.asset} = ₦${Number(tx.rate).toLocaleString()}` : '-';
        // Wallet
        document.getElementById('modal-wallet-address').innerText = resolvedWallet || 'Not provided';
        // Deposit bank
        document.getElementById('modal-deposit-bank').innerText = tx.deposit_bank_name || '-';
        document.getElementById('modal-deposit-number').innerText = tx.deposit_account_number || '-';
        document.getElementById('modal-deposit-name').innerText = tx.deposit_account_name || '-';
    } else {
        onrampSection.style.display = 'none';
        offrampSection.style.display = 'block';
        // Deposit address
        const depAddr = tx.deposit_address || '';
        document.getElementById('modal-deposit-address').innerText = depAddr || 'Not generated';
        // Deposit address explorer link
        const depExplorer = document.getElementById('modal-deposit-explorer');
        const depNetwork = tx.asset?.includes(':') ? tx.asset.split(':')[0] : (tx.meta ? (() => { try { const m = JSON.parse(tx.meta); return m.network || m.chain; } catch(e) { return null; } })() : null) || 'solana';
        if (depAddr && depExplorer) {
            depExplorer.href = getWalletExplorerUrl(depAddr, depNetwork);
            depExplorer.style.display = 'inline-flex';
        } else if (depExplorer) {
            depExplorer.style.display = 'none';
        }
        // Beneficiary
        let ben = {};
        try {
            if (typeof tx.beneficiary === 'object' && tx.beneficiary !== null) {
                ben = tx.beneficiary;
            } else if (typeof tx.beneficiary === 'string') {
                ben = JSON.parse(tx.beneficiary);
            }
        } catch (e) {}
        if (!ben || Object.keys(ben).length === 0) {
            try {
                const meta = typeof tx.meta === 'string' ? JSON.parse(tx.meta) : (tx.meta || {});
                if (meta.beneficiary && typeof meta.beneficiary === 'object') {
                    ben = meta.beneficiary;
                }
            } catch (e) {}
        }
        const BANK_NAMES = {
            '100004': 'OPay (PayCom)',
            '000014': 'Access Bank',
            '000013': 'GTBank',
            '000015': 'Zenith Bank',
            '000016': 'First Bank of Nigeria',
            '000004': 'United Bank For Africa (UBA)',
            '000007': 'Fidelity Bank',
            '000018': 'Union Bank',
            '000017': 'Wema Bank',
            '000001': 'Sterling Bank',
            '000010': 'Ecobank',
            '000008': 'Polaris Bank',
            '000003': 'FCMB',
            '000012': 'Stanbic IBTC',
            '000002': 'First City Monument Bank',
            '000011': 'Unity Bank',
            '090286': 'Safehaven Microfinance Bank',
            '100033': 'PalmPay',
            '100026': 'Kuda Bank',
            '100007': 'Carbon'
        };
        const bankName = ben.institution || ben.bankName || ben.bank_name || ben.bank || (ben.bank_code && BANK_NAMES[ben.bank_code] ? BANK_NAMES[ben.bank_code] : ben.bank_code) || '-';
        const accountNum = ben.accountNumber || ben.account_number || '-';
        const accountName = ben.holder_name || ben.accountName || ben.account_name || ben.name || '-';

        document.getElementById('modal-beneficiary-bank').innerText = bankName;
        document.getElementById('modal-beneficiary-number').innerText = accountNum;
        document.getElementById('modal-beneficiary-name').innerText = accountName;
    }

    // Admin confirm section
    const confirmSection = document.getElementById('modal-confirm-section');
    const hashInputWrap = document.getElementById('modal-hash-input-wrap');
    const hashInput = document.getElementById('modal-hash-input');
    const confirmStatus = document.getElementById('modal-confirm-status');

    confirmStatus.style.display = 'none';
    confirmStatus.textContent = '';
    hashInput.value = tx.hash || '';

    const canConfirm = ['AWAITING_DEPOSIT', 'PENDING', 'INITIATED', 'DETECTED', 'EXPIRED'].includes((tx.status || '').toUpperCase());
    confirmSection.style.display = canConfirm ? 'block' : 'none';

    if (tx.type === 'OFFRAMP' || (tx.status || '').toUpperCase() === 'EXPIRED') {
        hashInputWrap.style.display = 'block';
    } else {
        hashInputWrap.style.display = 'none';
    }

    document.getElementById('tx-modal').style.display = 'flex';
    lucide.createIcons();

    // If the transaction is pending, automatically check live provider
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes((tx.status || '').toUpperCase())) {
        refreshTransactionStatus();
    }
}

async function confirmTransactionFromModal() {
    if (!currentModalTx) return;
    const btn = document.getElementById('modal-confirm-btn');
    const statusEl = document.getElementById('modal-confirm-status');
    const hashInput = document.getElementById('modal-hash-input');

    let hash = '';
    if (currentModalTx.type === 'OFFRAMP') {
        hash = hashInput.value.trim();
        if (!hash) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.textContent = 'Transaction hash is required for sell (OFFRAMP) confirmations.';
            return;
        }
    } else {
        hash = (hashInput?.value || '').trim();
    }

    btn.innerText = 'Confirming...';
    btn.disabled = true;

    try {
        const body = { reference: currentModalTx.reference };
        if (hash) body.hash = hash;

        const res = await fetch(`${API_BASE}/api/confirm`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (res.ok && data.success) {
            const txStatus = (data.data?.status || data.status || '').toUpperCase();
            if (txStatus === 'COMPLETED') {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--success)';
                statusEl.textContent = 'Transaction confirmed and completed!';
                btn.innerText = 'Completed ✓';
                showToast('Transaction confirmed and completed!', 'success');
                setTimeout(() => { closeTxModal(); fetchData(); }, 1500);
            } else if (txStatus === 'PROCESSING') {
                statusEl.style.display = 'block';
                statusEl.style.color = '#3b82f6';
                statusEl.textContent = 'Hash submitted. Provider is processing payout...';
                btn.innerText = 'Processing...';
                showToast('Provider is processing payout', 'info');
                setTimeout(() => { closeTxModal(); fetchData(); }, 1500);
            } else if (txStatus === 'AWAITING_DEPOSIT') {
                statusEl.style.display = 'block';
                statusEl.style.color = '#f59e0b';
                statusEl.textContent = '⚠️ Hash submitted to provider, but status is still Awaiting Deposit. Payout has not been completed by provider.';
                btn.innerText = 'Confirm Transaction';
                btn.disabled = false;
                showToast('Provider status still Awaiting Deposit', 'warning');
                fetchData();
            } else {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--text-secondary)';
                statusEl.textContent = `Provider status: ${txStatus || 'Submitted'}`;
                btn.innerText = 'Confirm Transaction';
                btn.disabled = false;
                showToast(`Provider status: ${txStatus || 'Submitted'}`, 'info');
                fetchData();
            }
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.textContent = data.message || 'Confirmation failed.';
            btn.innerText = 'Confirm Transaction';
            btn.disabled = false;
        }
    } catch (err) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.textContent = err.message || 'Network error. Try Force Confirm.';
        btn.innerText = 'Confirm Transaction';
        btn.disabled = false;
    }
}

async function forceConfirmFromModal() {
    if (!currentModalTx) return;
    const btn = document.getElementById('modal-force-confirm-btn') || document.querySelector('#modal-confirm-section button:last-child');
    const statusEl = document.getElementById('modal-confirm-status');
    const hashInput = document.getElementById('modal-hash-input');
    const hash = (hashInput?.value || '').trim();

    btn.innerText = 'Retrying...';
    try {
        const body = { reference: currentModalTx.reference };
        if (hash) body.hash = hash;

        const res = await fetch(`${API_BASE}/api/confirm`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (res.ok && data.success) {
            const txStatus = (data.data?.status || data.status || '').toUpperCase();
            if (txStatus === 'COMPLETED') {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--success)';
                statusEl.textContent = 'Force confirm completed!';
                showToast('Transaction confirmed and completed!', 'success');
                setTimeout(() => { closeTxModal(); fetchData(); }, 1500);
            } else if (txStatus === 'PROCESSING') {
                statusEl.style.display = 'block';
                statusEl.style.color = '#3b82f6';
                statusEl.textContent = 'Force confirm submitted. Provider is processing payout...';
                showToast('Provider is processing payout', 'info');
                setTimeout(() => { closeTxModal(); fetchData(); }, 1500);
            } else if (txStatus === 'AWAITING_DEPOSIT') {
                statusEl.style.display = 'block';
                statusEl.style.color = '#f59e0b';
                statusEl.textContent = '⚠️ Request sent, but provider status is still Awaiting Deposit.';
                btn.innerText = 'Force Confirm';
                showToast('Provider status still Awaiting Deposit', 'warning');
                fetchData();
            } else {
                statusEl.style.display = 'block';
                statusEl.style.color = 'var(--text-secondary)';
                statusEl.textContent = `Provider status: ${txStatus || 'Submitted'}`;
                btn.innerText = 'Force Confirm';
                showToast(`Provider status: ${txStatus || 'Submitted'}`, 'info');
                fetchData();
            }
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.textContent = data.message || 'Force confirm failed.';
            btn.innerText = 'Force Confirm';
        }
    } catch (err) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.textContent = err.message || 'Network error.';
        btn.innerText = 'Force Confirm';
    }
}

function updateReceiptDisplay(tx) {
    const emailInput = document.getElementById('modal-email-input');
    const badge = document.getElementById('modal-receipt-badge');
    const btn = document.getElementById('modal-send-receipt-btn');
    const statusMsg = document.getElementById('modal-receipt-status');

    if (emailInput) {
        emailInput.value = tx.email || '';
    }
    if (statusMsg) {
        statusMsg.style.display = 'none';
        statusMsg.textContent = '';
    }
    if (badge) {
        if (tx.receipt_sent_at) {
            const d = new Date(tx.receipt_sent_at);
            const dateStr = !isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : tx.receipt_sent_at;
            badge.textContent = `Receipt sent (${dateStr})`;
            badge.style.background = 'rgba(16, 185, 129, 0.15)';
            badge.style.color = 'var(--success)';
        } else {
            badge.textContent = 'Receipt: Not sent';
            badge.style.background = 'rgba(245, 158, 11, 0.15)';
            badge.style.color = '#f59e0b';
        }
    }
    if (btn) {
        btn.innerHTML = `<i data-lucide="mail" style="width: 14px; height: 14px;"></i> ${tx.receipt_sent_at ? 'Resend Receipt' : 'Send Receipt'}`;
        if (window.lucide) lucide.createIcons();
    }
}

async function sendReceiptFromModal() {
    if (!currentModalTx) return;
    const btn = document.getElementById('modal-send-receipt-btn');
    const statusEl = document.getElementById('modal-receipt-status');
    const emailInput = document.getElementById('modal-email-input');
    const email = (emailInput ? emailInput.value.trim() : '') || currentModalTx.email || '';

    if (!email) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.textContent = 'Please enter a valid recipient email address.';
        return;
    }

    const prevHtml = btn.innerHTML;
    btn.innerHTML = 'Sending...';
    btn.disabled = true;
    statusEl.style.display = 'none';

    try {
        const res = await fetch(`${API_BASE}/api/admin/transactions/send-receipt`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reference: currentModalTx.reference, email: email })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--success)';
            statusEl.textContent = data.message || 'Receipt sent successfully!';
            showToast('Receipt sent successfully!', 'success');
            currentModalTx.receipt_sent_at = new Date().toISOString();
            currentModalTx.email = email;
            updateReceiptDisplay(currentModalTx);
            // Also update in currentTxs cache so table/refresh has it
            const cached = currentTxs.find(t => t.reference === currentModalTx.reference);
            if (cached) {
                cached.receipt_sent_at = currentModalTx.receipt_sent_at;
                cached.email = email;
            }
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = 'var(--failed)';
            statusEl.textContent = data.error || data.message || 'Failed to send receipt.';
            showToast(statusEl.textContent, 'error');
        }
    } catch (e) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--failed)';
        statusEl.textContent = 'Error: ' + e.message;
    } finally {
        btn.innerHTML = prevHtml;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
}

function applyFilters() {
    const search = document.getElementById('filter-search').value.trim().toLowerCase();
    const type = document.getElementById('filter-type').value;
    const status = document.getElementById('filter-status').value;
    const channel = document.getElementById('filter-channel').value;
    const dateFrom = document.getElementById('filter-date-from').value;
    const dateTo = document.getElementById('filter-date-to').value;

    let filtered = currentTxs.filter(tx => {
        // Search: reference, amount, wallet address, email
        const matchesSearch = !search ||
            tx.reference.toLowerCase().includes(search) ||
            tx.wallet_address?.toLowerCase().includes(search) ||
            tx.email?.toLowerCase().includes(search) ||
            String(tx.amount).includes(search) ||
            String(tx.destination_amount || '').includes(search);

        // Type filter
        const matchesType = !type || tx.type === type;

        // Status filter
        const matchesStatus = !status || tx.status === status;

        // Channel filter
        const matchesChannel = !channel || tx.channel === channel;

        // Date filter
        let matchesDate = true;
        const txDate = new Date(tx.created_at);
        if (dateFrom) {
            const from = new Date(dateFrom);
            from.setHours(0, 0, 0, 0);
            if (txDate < from) matchesDate = false;
        }
        if (dateTo) {
            const to = new Date(dateTo);
            to.setHours(23, 59, 59, 999);
            if (txDate > to) matchesDate = false;
        }

        return matchesSearch && matchesType && matchesStatus && matchesChannel && matchesDate;
    });

    renderTransactions(filtered);
    document.getElementById('filter-count').innerText = `Showing ${filtered.length} of ${currentTxs.length} transactions`;
}

function clearFilters() {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-status').value = '';
    document.getElementById('filter-channel').value = '';
    document.getElementById('filter-date-from').value = '';
    document.getElementById('filter-date-to').value = '';
    renderTransactions(currentTxs);
    document.getElementById('filter-count').innerText = 'Showing all transactions';
}

async function viewWalletDetails(wallet) {
    if (!wallet) return;
    const target = wallet.toLowerCase();

    // Find aggregate user record from currentUsers
    const matchedUser = (currentUsers || []).find(u => 
        (u.id && u.id.toLowerCase() === target) ||
        (u.email && u.email.toLowerCase() === target) ||
        (u.wallet_address && u.wallet_address.toLowerCase() === target) ||
        (Array.isArray(u.wallets) && u.wallets.some(w => w && w.toLowerCase() === target))
    );

    const displayEmail = matchedUser?.email || (wallet.includes('@') ? wallet : '');
    const knownWallets = (matchedUser && Array.isArray(matchedUser.wallets)) ? [...matchedUser.wallets] : [];
    if (matchedUser?.wallet_address && !knownWallets.includes(matchedUser.wallet_address)) {
        knownWallets.push(matchedUser.wallet_address);
    }
    if (!wallet.includes('@') && !knownWallets.includes(wallet)) {
        knownWallets.push(wallet);
    }
    const lowerKnown = knownWallets.map(w => w.toLowerCase());

    const userTxs = currentTxs.filter(t => {
        const tEmail = (t.email || '').toLowerCase();
        const tWallet = (t.wallet_address || '').toLowerCase();
        return (tEmail && (tEmail === target || (displayEmail && tEmail === displayEmail.toLowerCase()))) ||
               (tWallet && (tWallet === target || lowerKnown.includes(tWallet)));
    });

    // Gather all distinct destination addresses from transactions as well
    userTxs.forEach(t => {
        if (t.wallet_address && !knownWallets.some(w => w.toLowerCase() === t.wallet_address.toLowerCase())) {
            knownWallets.push(t.wallet_address);
        }
    });
    
    let userUSD = 0;
    let userNGN = 0;
    let completedCount = 0;
    userTxs.forEach(t => {
        if (t.status === 'COMPLETED') {
            completedCount++;
            const vols = getTxVolumes(t);
            userUSD += vols.usd;
            userNGN += vols.ngn;
        }
    });

    if (matchedUser) {
        const apiUSD = safeNum(matchedUser.total_volume_usd !== undefined ? matchedUser.total_volume_usd : matchedUser.total_volume);
        const apiNGN = safeNum(matchedUser.total_volume_ngn);
        if (apiUSD > userUSD) userUSD = apiUSD;
        if (apiNGN > userNGN) userNGN = apiNGN;
    }
    if (userNGN === 0 && userUSD > 0) {
        userNGN = userUSD * 1500;
    }

    const isEmail = Boolean(displayEmail);
    const headerTitle = document.getElementById('detail-header-title');
    const activityTitle = document.getElementById('detail-activity-title');
    if (headerTitle) headerTitle.innerText = isEmail ? 'User Insights' : 'Wallet Insights';
    if (activityTitle) activityTitle.innerText = isEmail ? 'User Activity' : 'Wallet Activity';
    
    const profileIconEl = document.querySelector('.user-profile-lg');
    if (profileIconEl) {
        profileIconEl.innerHTML = isEmail 
            ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' 
            : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
    }

    const usernameEl = document.getElementById('detail-username');
    const subTitleEl = document.getElementById('detail-user-subtitle');
    if (displayEmail) {
        if (usernameEl) usernameEl.innerText = displayEmail;
        if (subTitleEl) {
            const count = knownWallets.length;
            subTitleEl.innerText = `Active User · ${count} destination address${count === 1 ? '' : 'es'} used`;
        }
    } else {
        if (usernameEl) usernameEl.innerText = knownWallets[0] || wallet;
        if (subTitleEl) subTitleEl.innerText = 'Active Wallet';
    }

    document.getElementById('detail-vol').innerText = `$${userUSD.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const approxEl = document.getElementById('detail-vol-approx');
    if (approxEl) {
        approxEl.innerText = `~₦${userNGN.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} NGN`;
    }
    document.getElementById('detail-success').innerText = completedCount || userTxs.filter(t => t.status === 'COMPLETED').length;
    document.getElementById('detail-tx-count').innerText = (matchedUser && matchedUser.tx_count > userTxs.length) ? matchedUser.tx_count : userTxs.length;

    // Render Destination Addresses Card
    const addrsCountEl = document.getElementById('detail-addresses-count');
    const addrsListEl = document.getElementById('detail-addresses-list');
    if (addrsCountEl) addrsCountEl.innerText = `${knownWallets.length} address${knownWallets.length === 1 ? '' : 'es'}`;
    
    if (addrsListEl) {
        if (knownWallets.length === 0) {
            addrsListEl.innerHTML = `<div style="font-size: 12px; color: var(--text-secondary); font-style: italic; padding: 12px 0;">No destination blockchain addresses recorded for this user.</div>`;
        } else {
            addrsListEl.innerHTML = knownWallets.map((addr, idx) => {
                const addrTxs = userTxs.filter(t => t.wallet_address && t.wallet_address.toLowerCase() === addr.toLowerCase());
                const assets = [...new Set(addrTxs.map(t => t.asset).filter(Boolean))];
                let addrVolUSD = 0;
                addrTxs.forEach(t => {
                    if (t.status === 'COMPLETED') {
                        const vols = getTxVolumes(t);
                        addrVolUSD += vols.usd;
                    }
                });

                return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--bg-hover, rgba(0,0,0,0.02)); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 250px;">
                        <span style="font-size: 11px; font-weight: 700; color: var(--text-secondary); width: 22px;">#${idx + 1}</span>
                        <code style="font-size: 12px; font-weight: 600; color: var(--text-main); word-break: break-all;">${addr}</code>
                        <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${addr}'); showToast('Address copied', 'success');" style="background: none; border: none; cursor: pointer; padding: 2px 4px; color: var(--primary-link);" title="Copy address">📋</button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px; font-size: 11px;">
                        ${assets.length ? `<span style="display: flex; gap: 4px;">${assets.map(a => `<span style="background: var(--input-bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 6px; font-weight: 600; font-size: 10px;">${a}</span>`).join('')}</span>` : ''}
                        <span style="color: var(--text-secondary);">${addrTxs.length} order${addrTxs.length === 1 ? '' : 's'}</span>
                        ${addrVolUSD > 0 ? `<b style="color: var(--velcro-green);">$${addrVolUSD.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</b>` : ''}
                    </div>
                </div>
                `;
            }).join('');
        }
    }

    // Render Activity Rows with Destination Address Column
    document.getElementById('detail-tx-body').innerHTML = userTxs.map(tx => {
        const txAddr = tx.wallet_address || '';
        const addrDisplay = txAddr 
            ? `<div style="font-family: monospace; font-size: 11px; display: flex; align-items: center; gap: 4px;" title="${txAddr}">
                <span>${txAddr.length > 14 ? txAddr.slice(0, 6) + '...' + txAddr.slice(-4) : txAddr}</span>
                <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${txAddr}'); showToast('Address copied', 'success');" style="background:none;border:none;cursor:pointer;padding:2px;color:var(--text-secondary);font-size:11px;" title="Copy address">📋</button>
               </div>`
            : '<span style="font-size: 11px; color: var(--text-secondary); font-style: italic;">—</span>';

        return `
        <tr onclick="viewTransaction('${tx.reference}')" style="cursor: pointer;" title="Click to view details">
            <td data-label="Reference"><code>${tx.reference.slice(0, 8)}...</code></td>
            <td data-label="Type"><b>${tx.type}</b></td>
            <td data-label="Amount">${formatTxTableAmount(tx)}</td>
            <td data-label="Destination / Wallet">${addrDisplay}</td>
            <td data-label="Status"><span class="status-pill ${tx.status.toLowerCase()}">${statusLabel(tx.status)}</span></td>
            <td data-label="Date">${new Date(tx.created_at).toLocaleDateString()}</td>
        </tr>
        `;
    }).join('');

    switchSection('user-detail');
}

async function requestWithdrawOTP() {
    const recipient = currentConfig.developer_recipient || 'unknown';
    if (!confirm(`Withdraw all accumulated fees to:\n${recipient}\n\nAn OTP will be sent to your admin email. Proceed?`)) return;

    const btn = document.getElementById('btn-withdraw-otp');
    const otpSection = document.getElementById('withdraw-otp-section');
    const statusEl = document.getElementById('withdraw-otp-status');
    const originalText = btn.innerText;

    btn.innerText = '⌛ Sending OTP...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/withdraw/otp`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' }
        });
        const data = await res.json();

        if (data.success) {
            otpSection.classList.remove('hidden');
            statusEl.style.display = 'block';
            statusEl.style.color = '#166534';
            statusEl.innerText = data.message;
            document.getElementById('withdraw-otp-input').focus();
            btn.innerText = '⏳ Waiting for OTP...';
        } else {
            alert(`Error: ${data.error}`);
            btn.innerText = originalText;
            btn.disabled = false;
        }
    } catch (e) {
        alert('Network error: ' + e.message);
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function cancelWithdrawal() {
    document.getElementById('withdraw-otp-section').classList.add('hidden');
    document.getElementById('withdraw-otp-input').value = '';
    const btn = document.getElementById('btn-withdraw-otp');
    btn.innerText = 'Withdraw Fees to Solana';
    btn.disabled = false;
}

async function confirmWithdrawal() {
    const otp = document.getElementById('withdraw-otp-input').value.trim();
    if (!otp) { alert('Please enter the OTP'); return; }

    const btn = document.getElementById('btn-withdraw-confirm');
    const statusEl = document.getElementById('withdraw-otp-status');
    const originalText = btn.innerText;

    btn.innerText = 'Processing...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/withdraw`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset: 'solana:usdc', otp })
        });
        const data = await res.json();

        if (data.success) {
            alert(`Success! Withdrawal initiated.\nHash: ${data.data.hash}\nRecipient: ${currentConfig.developer_recipient || 'unknown'}`);
            cancelWithdrawal();
            fetchData();
        } else {
            statusEl.style.display = 'block';
            statusEl.style.color = '#dc2626';
            const errMsg = data.error || data.message || 'Withdrawal failed';
            statusEl.innerText = errMsg.includes('OTP') || errMsg.includes('otp') || errMsg.includes('code')
                ? '❌ ' + errMsg
                : '❌ Withdrawal failed: ' + errMsg;
            btn.innerText = originalText;
            btn.disabled = false;
        }
    } catch (e) {
        statusEl.style.display = 'block';
        statusEl.style.color = '#dc2626';
        statusEl.innerText = 'Network error: ' + e.message;
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

let currentAuditLogs = [];
// ─── Email campaigns ───
let campTickTimer = null;

function campaignFields() {
    const v = id => (document.getElementById(id)?.value || '').trim();
    return {
        subject: v('camp-subject'),
        preheader: v('camp-preheader'),
        title: v('camp-title'),
        image_url: v('camp-image-url'),
        body: document.getElementById('camp-body')?.value || '',
        cta_label: v('camp-cta-label'),
        cta_url: v('camp-cta-url'),
        audience_source: v('camp-target-audience') || 'all'
    };
}

let campDebounceTimer = null;
function previewCampaignDebounced() {
    clearTimeout(campDebounceTimer);
    campDebounceTimer = setTimeout(previewCampaign, 400);
}

function onCampaignImageChanged() {
    const url = document.getElementById('camp-image-url').value.trim();
    const previewWrap = document.getElementById('camp-image-preview-wrap');
    const previewImg = document.getElementById('camp-image-preview');
    if (url) {
        previewImg.src = url;
        previewWrap.style.display = 'inline-block';
    } else {
        previewWrap.style.display = 'none';
    }
    previewCampaignDebounced();
}

function removeCampaignHeroImage() {
    document.getElementById('camp-image-url').value = '';
    document.getElementById('camp-image-preview-wrap').style.display = 'none';
    previewCampaign();
}

async function uploadCampaignHeroImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    showToast('Uploading picture…', 'info');
    try {
        const res = await fetch(`${API_BASE}/api/admin/campaigns/upload-image`, {
            method: 'POST',
            headers: { 'Authorization': adminKey },
            body: formData
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Upload failed');
        document.getElementById('camp-image-url').value = data.url;
        onCampaignImageChanged();
        previewCampaign();
        showToast('Picture uploaded!', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        input.value = '';
    }
}

async function uploadCampaignInlineImage(input) {
    const file = input.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    showToast('Uploading picture…', 'info');
    try {
        const res = await fetch(`${API_BASE}/api/admin/campaigns/upload-image`, {
            method: 'POST',
            headers: { 'Authorization': adminKey },
            body: formData
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Upload failed');
        const textarea = document.getElementById('camp-body');
        const tag = `\n\n![Picture](${data.url})\n\n`;
        const start = textarea.selectionStart || textarea.value.length;
        textarea.value = textarea.value.substring(0, start) + tag + textarea.value.substring(start);
        previewCampaign();
        showToast('Picture inserted into message!', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        input.value = '';
    }
}

function toggleUploadListModal() {
    const panel = document.getElementById('camp-import-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (window.lucide) lucide.createIcons();
}

async function importEmailsToList() {
    const fileInput = document.getElementById('camp-import-file');
    const textInput = document.getElementById('camp-import-text');
    const statusEl = document.getElementById('camp-import-status');
    const btn = document.getElementById('btn-import-emails');

    const file = fileInput.files?.[0];
    const text = textInput.value.trim();

    if (!file && !text) {
        showToast('Please select a file or paste email addresses', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerText = 'Importing…';
    statusEl.innerText = '';

    try {
        let res;
        if (file) {
            const formData = new FormData();
            formData.append('file', file);
            res = await fetch(`${API_BASE}/api/admin/campaigns/import-emails`, {
                method: 'POST',
                headers: { 'Authorization': adminKey },
                body: formData
            });
        } else {
            res = await fetch(`${API_BASE}/api/admin/campaigns/import-emails`, {
                method: 'POST',
                headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails: text })
            });
        }
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Import failed');

        statusEl.style.color = 'var(--success)';
        statusEl.innerText = `✓ Added ${data.newly_added} new (${data.already_present} already in list). Total: ${data.total_subscribers}`;
        showToast(`Successfully imported ${data.newly_added} emails!`, 'success');
        fileInput.value = '';
        textInput.value = '';
        if (data.overview) {
            renderCampaigns(data.overview);
        } else {
            fetchCampaigns();
        }
    } catch (e) {
        statusEl.style.color = 'var(--failed)';
        statusEl.innerText = e.message;
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Import to Email List';
    }
}

// Shows whether the server can send email; when it can't, the raw diagnostic (no secrets) is shown.
async function fetchMailStatus() {
    const line = document.getElementById('camp-mail-status');
    const detail = document.getElementById('camp-mail-detail');
    try {
        const res = await fetch(`${API_BASE}/api/admin/mail-status`, { headers: { 'Authorization': adminKey } });
        if (!res.ok) { line.innerText = ''; return; }
        const d = scrub(await res.json());
        const ok = d.mailhive_key_loaded || d.smtp_configured;
        line.innerHTML = ok
            ? `<span style="color: var(--success);">●</span> Email sending via ${d.mailhive_key_loaded ? 'Mailhive (' + d.mailhive_key_hint + ')' : 'SMTP'}`
            : '<span style="color: var(--failed);">●</span> Email is not sending: the server has no Mailhive key loaded. Details below.';
        detail.style.display = ok ? 'none' : 'block';
        detail.textContent = ok ? '' : JSON.stringify(d, null, 2);
    } catch (e) { line.innerText = ''; }
}

async function fetchCampaigns() {
    fetchMailStatus();
    try {
        const res = await fetch(`${API_BASE}/api/admin/campaigns`, { headers: { 'Authorization': adminKey } });
        const data = scrub(await res.json());
        if (!res.ok) throw new Error(data.error || 'Failed to load campaigns');
        renderCampaigns(data);
    } catch (e) { showToast(e.message, 'error'); }
}

function renderCampaigns(data) {
    document.getElementById('camp-audience').innerText = `${(data.audience || 0).toLocaleString()} subscribers · ${(data.unsubscribed || 0).toLocaleString()} unsubscribed`;
    if (document.getElementById('camp-stat-all')) {
        document.getElementById('camp-stat-all').innerText = (data.audience || 0).toLocaleString();
        document.getElementById('camp-stat-tx').innerText = (data.audience_transactions || 0).toLocaleString();
        document.getElementById('camp-stat-uploaded').innerText = (data.audience_uploaded || 0).toLocaleString();
        document.getElementById('camp-stat-unsub').innerText = (data.unsubscribed || 0).toLocaleString();
    }

    document.getElementById('camp-body-rows').innerHTML = data.campaigns.length ? data.campaigns.map(c => {
        const total = Number(c.total) || 0, sent = Number(c.sent) || 0, failed = Number(c.failed) || 0;
        const pct = total ? Math.round(((sent + failed) / total) * 100) : 0;
        return `<tr>
            <td data-label="Started">${new Date(String(c.created_at).replace(' ', 'T')).toLocaleString()}</td>
            <td data-label="Subject">${c.subject}</td>
            <td data-label="Status"><span class="status-pill ${c.status.toLowerCase()}">${statusLabel(c.status)}</span></td>
            <td data-label="Progress"><span>${sent.toLocaleString()} / ${total.toLocaleString()} sent${failed ? ` · <span style="color: var(--failed);">${failed} failed</span>` : ''}${c.status === 'SENDING' ? ` · ${pct}%` : ''}</span></td>
            <td data-label="Action">${c.status === 'SENDING' ? `<button class="btn-secondary" style="width: auto; padding: 6px 12px; font-size: 12px;" onclick="cancelCampaign(${c.id})">Cancel</button>` : '<span style="color: var(--text-secondary);">—</span>'}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-secondary);">No campaigns yet.</td></tr>';

    // While a campaign is sending and this page is open, keep pushing batches out.
    clearTimeout(campTickTimer);
    if (data.campaigns.some(c => c.status === 'SENDING') && document.getElementById('section-email').classList.contains('active')) {
        campTickTimer = setTimeout(async () => {
            try {
                const res = await fetch(`${API_BASE}/api/admin/campaigns/tick`, { method: 'POST', headers: { 'Authorization': adminKey } });
                renderCampaigns(scrub(await res.json()));
            } catch (e) { /* next refresh retries */ }
        }, 2500);
    }
}

async function previewCampaign() {
    try {
        const data = await adminPost('/api/admin/campaigns/preview', campaignFields());
        const frame = document.getElementById('camp-preview-frame');
        frame.srcdoc = data.html;
        frame.style.display = 'block';
        document.getElementById('camp-preview-empty').style.display = 'none';
    } catch (e) { showToast(e.message, 'error'); }
}

async function sendTestCampaign(btn) {
    const to = document.getElementById('camp-test-to').value.trim();
    if (!to) { showToast('Enter a test email address', 'error'); return; }
    btn.disabled = true;
    btn.innerText = 'Sending…';
    try {
        await adminPost('/api/admin/campaigns/test', { ...campaignFields(), to });
        showToast(`Test sent to ${to}`, 'success');
    } catch (e) { showToast(e.message, 'error'); }
    btn.disabled = false;
    btn.innerText = 'Send test';
}

async function startCampaign(btn) {
    const fields = campaignFields();
    let countLabel = document.getElementById('camp-stat-all')?.innerText || 'all';
    let targetLabel = 'All Subscribers';
    if (fields.audience_source === 'uploaded') {
        targetLabel = 'Uploaded Contact List Only';
        countLabel = document.getElementById('camp-stat-uploaded')?.innerText || countLabel;
    } else if (fields.audience_source === 'transactions') {
        targetLabel = 'Platform Transactions Only';
        countLabel = document.getElementById('camp-stat-tx')?.innerText || countLabel;
    }

    if (!confirm(`Send "${fields.subject || '(no subject)'}" to ${targetLabel} (${countLabel} recipients)?\n\nThis cannot be undone once emails are dispatched. We recommend sending a test email first.`)) return;
    btn.disabled = true;
    try {
        const data = await adminPost('/api/admin/campaigns', fields);
        showToast(`Sending to ${data.recipients.toLocaleString()} recipients`, 'success');
        fetchCampaigns();
    } catch (e) { showToast(e.message, 'error'); }
    btn.disabled = false;
}

async function cancelCampaign(id) {
    if (!confirm('Stop this campaign? Emails already sent stay sent.')) return;
    try {
        await adminPost(`/api/admin/campaigns/${id}/cancel`, {});
        showToast('Campaign cancelled', 'success');
        fetchCampaigns();
    } catch (e) { showToast(e.message, 'error'); }
}

// ─── Referrals ───
const usdFmt = v => '$' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortAddr = a => a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-6) : (a || '');

async function adminPost(path, body) {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

// ─── HostFi ───

// ─── Coins & providers ───

let routeRows = [];          // [{side, provider, symbol, enabled}] from the server
const routeEdits = {};       // "side:provider:SYM" → bool, unsaved changes

async function fetchRoutes() {
    try {
        const res = await fetch(`${API_BASE}/api/admin/routes`, { headers: { 'Authorization': adminKey } });
        const data = scrub(await res.json());
        if (!res.ok) throw new Error(data.error || 'Failed to load coins');
        routeRows = data.routes || [];
        Object.keys(routeEdits).forEach(k => delete routeEdits[k]);
        const warn = [];
        if (data.switch_list_missing) warn.push("Switch's coin list hasn't loaded on the server yet. Open the site once, then refresh this page.");
        if (!data.hostfi_configured) warn.push("HostFi isn't connected, so its switches have no effect until it is.");
        const w = document.getElementById('coins-warning');
        w.style.display = warn.length ? 'block' : 'none';
        w.innerText = warn.join(' ');
        renderRoutes();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderRoutes() {
    const q = (document.getElementById('coins-search').value || '').trim().toUpperCase();
    const byCoin = {};
    routeRows.forEach(r => { (byCoin[r.symbol] = byCoin[r.symbol] || {})[`${r.side}:${r.provider}`] = r.enabled; });
    // Coins HostFi handles first, then alphabetical.
    const hostfiFirst = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC'];
    const coins = Object.keys(byCoin).filter(c => !q || c.includes(q)).sort((a, b) => {
        const ia = hostfiFirst.indexOf(a), ib = hostfiFirst.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    const cols = ['buy:switch', 'buy:paj', 'buy:hostfi', 'sell:switch', 'sell:paj', 'sell:hostfi'];
    const labels = { 'buy:switch': 'Buy · Switch', 'buy:paj': 'Buy · PAJ', 'buy:hostfi': 'Buy · HostFi', 'sell:switch': 'Sell · Switch', 'sell:paj': 'Sell · PAJ', 'sell:hostfi': 'Sell · HostFi' };
    document.getElementById('coins-body').innerHTML = coins.length ? coins.map(coin => `
        <tr>
            <td data-label="Coin" class="coin-cell">${coin}</td>
            ${cols.map(col => {
                if (!(col in byCoin[coin])) return `<td data-label="${labels[col]}"><span class="route-none">—</span></td>`;
                const key = `${col}:${coin}`;
                const on = key in routeEdits ? routeEdits[key] : byCoin[coin][col];
                return `<td data-label="${labels[col]}"><span class="route-cell${key in routeEdits ? ' changed' : ''}"><input type="checkbox" class="route-toggle" aria-label="${labels[col]} ${coin}" ${on ? 'checked' : ''} onchange="editRoute('${key}', this.checked)"></span></td>`;
            }).join('')}
        </tr>`).join('') : '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-secondary);">No coins match.</td></tr>';
    const btn = document.getElementById('coins-save-btn');
    const n = Object.keys(routeEdits).length;
    btn.innerText = n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save changes';
    btn.disabled = !n;
}

function editRoute(key, on) {
    const [side, provider, symbol] = key.split(':');
    const row = routeRows.find(r => r.side === side && r.provider === provider && r.symbol === symbol);
    if (row && row.enabled === on) delete routeEdits[key];
    else routeEdits[key] = on;
    renderRoutes();
}

async function saveRoutes() {
    const n = Object.keys(routeEdits).length;
    if (!n) return;
    const btn = document.getElementById('coins-save-btn');
    btn.disabled = true;
    try {
        await adminPost('/api/admin/settings', { routes: { ...routeEdits } });
        showToast(`Saved ${n} change${n === 1 ? '' : 's'}. The site picks them up on its next load.`, 'success');
        await fetchRoutes();
    } catch (e) {
        showToast(e.message, 'error');
        btn.disabled = false;
    }
}

async function fetchHostfi() {
    try {
        const [hRes, sRes] = await Promise.all([
            fetch(`${API_BASE}/api/admin/hostfi`, { headers: { 'Authorization': adminKey } }),
            fetch(`${API_BASE}/api/admin/settings`, { headers: { 'Authorization': adminKey } })
        ]);
        const data = scrub(await hRes.json());
        const settings = await sRes.json();
        if (!hRes.ok) throw new Error(data.error || 'Failed to load HostFi');
        renderHostfi(data, settings);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderHostfi(data, settings) {
    const env = document.getElementById('hostfi-env');
    env.className = 'status-pill ' + (!data.configured ? 'cancelled' : data.environment === 'live' ? 'completed' : 'pending');
    env.innerText = !data.configured ? 'Not connected' : data.environment === 'live' ? 'Live' : 'Sandbox';
    document.getElementById('hostfi-not-configured').style.display = data.configured ? 'none' : 'block';

    const timers = settings.sell_timer_minutes || {};
    document.getElementById('hostfi-fee-input').value = settings.hostfi_fee ?? 0.5;
    document.getElementById('hostfi-timer-btc').value = timers.BTC ?? 120;
    document.getElementById('hostfi-timer-default').value = timers.default ?? 60;

    const fmt = (v, d = 8) => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: d });
    const balances = document.getElementById('hostfi-balances');
    balances.innerHTML = data.balances && data.balances.length
        ? data.balances.map(b => `<div class="hostfi-balance"><div class="hostfi-balance-code">${b.currency}</div><div class="hostfi-balance-value">${b.currency === 'NGN' ? '₦' + fmt(b.balance, 2) : fmt(b.balance)}</div></div>`).join('')
        : `<p style="color: var(--text-secondary); font-size: 13px;">${data.error || (data.configured ? 'No wallets yet.' : 'Connect HostFi to see balances.')}</p>`;

    const deposits = data.deposits || [];
    const needsAction = ['REVIEW', 'PAYOUT_FAILED', 'PAYOUT_UNCERTAIN', 'SWAP_PENDING'];
    const attention = deposits.filter(d => needsAction.includes(d.status)).length;
    const badge = document.getElementById('hostfi-review-count');
    badge.style.display = attention ? 'inline-block' : 'none';
    badge.innerText = `${attention} need attention`;

    document.getElementById('hostfi-deposits-body').innerHTML = deposits.length ? deposits.map(d => {
        const actionable = needsAction.includes(d.status);
        // The swap already happened when ngn_amount is set, so only the payout is retried.
        const primary = d.status === 'SWAP_PENDING' ? 'Check swap'
            : (d.status === 'PAYOUT_FAILED' || d.status === 'PAYOUT_UNCERTAIN' || d.ngn_amount) ? 'Retry payout' : 'Approve &amp; pay';
        const label = `${fmt(d.amount)} ${d.currency}`;
        return `
        <tr>
            <td data-label="Received">${new Date(String(d.created_at).replace(' ', 'T')).toLocaleString()}</td>
            <td data-label="Customer">${d.email || '<span style="color: var(--text-secondary);">—</span>'}<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${d.order_ref || 'No order'}</div></td>
            <td data-label="Deposit"><span><b>${fmt(d.amount)}</b> ${d.currency}</span>${d.tx_hash ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;" title="${d.tx_hash}">tx ${shortAddr(d.tx_hash)}</div>` : ''}</td>
            <td data-label="Payout">${d.payout_amount ? '₦' + fmt(d.payout_amount, 2) : '<span style="color: var(--text-secondary);">—</span>'}</td>
            <td data-label="Status"><span class="status-pill ${String(d.status).toLowerCase()}">${statusLabel(d.status)}</span>${d.note ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px;">${d.note}</div>` : ''}</td>
            <td data-label="Action">${actionable ? `
                <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
                    ${d.order_ref ? `<button class="btn-primary" style="width: auto; padding: 8px 14px; font-size: 12px;" onclick="hostfiDepositAction(${d.id}, 'retry', '${label}', '${primary}')">${primary}</button>` : ''}
                    <button class="btn-secondary" style="width: auto; padding: 7px 14px; font-size: 12px;" onclick="hostfiDepositAction(${d.id}, 'resolve', '${label}')">Mark resolved</button>
                </div>` : '<span style="color: var(--text-secondary);">—</span>'}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-secondary);">No HostFi deposits yet.</td></tr>';
    renderHostfiBuys(data.buys || [], fmt);
    if (window.lucide) lucide.createIcons();
}

function renderHostfiBuys(buys, fmt) {
    const needsAction = ['REVIEW', 'SEND_FAILED', 'SEND_UNCERTAIN', 'SWAP_PENDING'];
    const attention = buys.filter(b => needsAction.includes(b.status)).length;
    const badge = document.getElementById('hostfi-buy-review-count');
    badge.style.display = attention ? 'inline-block' : 'none';
    badge.innerText = `${attention} need attention`;
    document.getElementById('hostfi-buys-body').innerHTML = buys.length ? buys.map(b => {
        const actionable = needsAction.includes(b.status);
        // Once the swap produced a send amount, only the send is retried.
        const primary = b.status === 'SWAP_PENDING' ? 'Check swap'
            : (b.status === 'SEND_FAILED' || b.status === 'SEND_UNCERTAIN' || Number(b.send_amount) > 0) ? 'Retry send' : 'Approve &amp; send';
        const label = `₦${fmt(b.ngn_amount, 2)}`;
        return `
        <tr>
            <td data-label="Paid">${new Date(String(b.created_at).replace(' ', 'T')).toLocaleString()}</td>
            <td data-label="Customer">${b.email || '<span style="color: var(--text-secondary);">—</span>'}<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${b.order_ref || 'No order'}</div></td>
            <td data-label="Payment"><span><b>${label}</b></span>${b.currency ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">for ${b.currency} on ${b.network || '?'}</div>` : ''}</td>
            <td data-label="Sent">${Number(b.send_amount) > 0 ? `<span><b>${fmt(b.send_amount)}</b> ${b.currency}</span>` : '<span style="color: var(--text-secondary);">—</span>'}${b.wallet ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;" title="${b.wallet}">to ${shortAddr(b.wallet)}</div>` : ''}${b.tx_hash ? `<div style="font-size: 11px; color: var(--text-secondary);" title="${b.tx_hash}">tx ${shortAddr(b.tx_hash)}</div>` : ''}</td>
            <td data-label="Status"><span class="status-pill ${String(b.status).toLowerCase()}">${statusLabel(b.status)}</span>${b.note ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px;">${b.note}</div>` : ''}</td>
            <td data-label="Action">${actionable ? `
                <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
                    ${b.order_ref ? `<button class="btn-primary" style="width: auto; padding: 8px 14px; font-size: 12px;" onclick="hostfiBuyAction(${b.id}, 'retry', '${label}', '${primary}')">${primary}</button>` : ''}
                    <button class="btn-secondary" style="width: auto; padding: 7px 14px; font-size: 12px;" onclick="hostfiBuyAction(${b.id}, 'resolve', '${label}')">Mark resolved</button>
                </div>` : '<span style="color: var(--text-secondary);">—</span>'}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-secondary);">No HostFi buys yet.</td></tr>';
}

async function hostfiBuyAction(id, action, label, kind = '') {
    const question = action !== 'retry' ? null
        : kind === 'Check swap' ? `Ask HostFi whether the swap for the ${label} payment has finished? If it has, the coin is sent.`
        : kind === 'Retry send' ? `Retry sending the coin for the ${label} payment? HostFi is checked first; nothing is sent if the last send went through or is still processing.`
        : `Convert the ${label} payment and send the coin to the customer's wallet now? This skips the automatic checks.`;
    if (!confirm(question || `Mark the ${label} payment as resolved? Use this once you've handled it outside Velcro (refund or manual send).`)) return;
    try {
        const body = action === 'resolve' ? { note: prompt('Note for the audit log (optional):') || 'Resolved manually' } : {};
        const data = await adminPost(`/api/admin/hostfi/buys/${id}/${action}`, body);
        const st = data.buy ? data.buy.status : 'RESOLVED';
        const bad = ['REVIEW', 'SEND_FAILED', 'SEND_UNCERTAIN'].includes(st);
        const msg = data.outcome === 'already_paid' ? 'HostFi shows this send already succeeded. Marked sent, nothing re-sent.'
            : data.outcome === 'still_pending' ? 'HostFi is still processing the last send. Nothing re-sent.'
            : st === 'SEND_PENDING' ? 'Coin sent' : `Payment is now ${statusLabel(st)}`;
        showToast(msg, bad ? 'error' : 'success');
    } catch (e) {
        showToast(e.message, 'error');
    }
    fetchHostfi();
}

async function saveHostfiSettings() {
    const fee = parseFloat(document.getElementById('hostfi-fee-input').value);
    const btcTimer = parseInt(document.getElementById('hostfi-timer-btc').value, 10);
    const otherTimer = parseInt(document.getElementById('hostfi-timer-default').value, 10);
    if (Number.isNaN(fee) || fee < 0 || fee > 10) { showToast('Fee must be between 0 and 10%', 'error'); return; }
    if ([btcTimer, otherTimer].some(t => Number.isNaN(t) || t < 15 || t > 360)) { showToast('Timers must be between 15 and 360 minutes', 'error'); return; }
    const btn = document.getElementById('hostfi-save-btn');
    btn.disabled = true;
    try {
        await adminPost('/api/admin/settings', { hostfi_fee: fee, sell_timer_minutes: { BTC: btcTimer, default: otherTimer } });
        showToast('HostFi fee and timers saved', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function hostfiDepositAction(id, action, label, kind = '') {
    const question = action !== 'retry' ? null
        : kind === 'Check swap' ? `Ask HostFi whether the swap for the ${label} deposit has finished? If it has, the payout is sent.`
        : kind === 'Retry payout' ? `Retry the payout for the ${label} deposit? HostFi is checked first; nothing is sent if the last payout went through or is still processing.`
        : `Pay out the ${label} deposit to the customer's bank now? This skips the automatic checks.`;
    if (!confirm(question || `Mark the ${label} deposit as resolved? Use this once you've handled it outside Velcro (refund or manual payout).`)) return;
    try {
        const body = action === 'resolve' ? { note: prompt('Note for the audit log (optional):') || 'Resolved manually' } : {};
        const data = await adminPost(`/api/admin/hostfi/deposits/${id}/${action}`, body);
        const st = data.deposit ? data.deposit.status : 'RESOLVED';
        const bad = ['REVIEW', 'PAYOUT_FAILED', 'PAYOUT_UNCERTAIN'].includes(st);
        const msg = data.outcome === 'already_paid' ? 'HostFi shows this payout already succeeded. Marked paid, nothing re-sent.'
            : data.outcome === 'still_pending' ? 'HostFi is still processing the last payout. Nothing re-sent.'
            : st === 'PAYOUT_PENDING' ? 'Payout sent' : `Deposit is now ${statusLabel(st)}`;
        showToast(msg, bad ? 'error' : 'success');
    } catch (e) {
        showToast(e.message, 'error');
    }
    fetchHostfi();
}

async function fetchReferrals() {
    try {
        const res = await fetch(`${API_BASE}/api/admin/referrals`, { headers: { 'Authorization': adminKey } });
        const data = scrub(await res.json());
        if (!res.ok) throw new Error(data.error || 'Failed to load referrals');
        renderReferrals(data);
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function renderReferrals(data) {
    document.getElementById('ref-default-fee').value = data.default_fee_percent;
    document.getElementById('ref-min-withdrawal').innerText = usdFmt(data.min_withdrawal_usd);

    const pending = data.withdrawals.filter(w => w.status === 'PENDING').length;
    const badge = document.getElementById('ref-pending-count');
    badge.style.display = pending ? 'inline-block' : 'none';
    badge.innerText = `${pending} pending`;

    const wBody = document.getElementById('ref-withdrawals-body');
    wBody.innerHTML = data.withdrawals.length ? data.withdrawals.map(w => `
        <tr>
            <td data-label="Requested">${new Date(String(w.created_at).replace(' ', 'T')).toLocaleString()}</td>
            <td data-label="Referrer">${w.email}</td>
            <td data-label="Amount"><span><b>${usdFmt(w.amount_usd)}</b> USDC</span></td>
            <td data-label="Network">${data.chains[w.chain] || w.chain}</td>
            <td data-label="Address"><code title="${w.address}">${shortAddr(w.address)}</code> <button class="btn-view" style="padding: 2px 8px;" onclick="navigator.clipboard.writeText('${w.address}'); showToast('Address copied', 'success');">Copy</button></td>
            <td data-label="Status"><span class="status-pill ${w.status.toLowerCase()}">${statusLabel(w.status === 'APPROVED' ? 'PAID' : w.status)}</span>${w.payout_hash ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;" title="${w.payout_hash}">tx ${shortAddr(w.payout_hash)}</div>` : ''}${w.note ? `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">${w.note}</div>` : ''}</td>
            <td data-label="Action">${w.status === 'PENDING' ? `
                <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
                    <button class="btn-primary" style="width: auto; padding: 8px 14px; font-size: 12px;" onclick="processReferralWithdrawal(${w.id}, 'approve', '${usdFmt(w.amount_usd)}')">Approve</button>
                    <button class="btn-secondary" style="width: auto; padding: 7px 14px; font-size: 12px;" onclick="processReferralWithdrawal(${w.id}, 'reject', '${usdFmt(w.amount_usd)}')">Reject</button>
                </div>` : '<span style="color: var(--text-secondary);">—</span>'}</td>
        </tr>`).join('') : '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-secondary);">No withdrawal requests yet.</td></tr>';

    const rBody = document.getElementById('ref-referrers-body');
    rBody.innerHTML = data.referrers.length ? data.referrers.map(r => `
        <tr>
            <td data-label="Referrer">${r.email}</td>
            <td data-label="Code"><code>${r.code}</code></td>
            <td data-label="Fee">
                <div style="display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap;">
                    <input type="number" class="ref-fee-input" id="ref-fee-${r.code}" value="${r.fee_percent}" step="0.01" min="0" max="10" aria-label="Fee for ${r.email}">%
                    <button class="btn-view" style="padding: 4px 10px;" onclick="saveReferrerFee('${r.code}')">Save</button>
                    ${r.fee_is_custom ? `<button class="btn-view" style="padding: 4px 10px;" title="Use the default fee" onclick="saveReferrerFee('${r.code}', true)">Reset</button>` : '<span style="font-size: 11px; color: var(--text-secondary);">default</span>'}
                </div>
            </td>
            <td data-label="Orders"><span>${r.completed_orders} <span style="color: var(--text-secondary);">/ ${r.referred_orders}</span></span></td>
            <td data-label="Volume">${usdFmt(r.volume_usd)}</td>
            <td data-label="Earned">${usdFmt(r.earned_usd)}</td>
            <td data-label="Balance"><b>${usdFmt(r.available_usd)}</b>${r.pending_usd > 0 ? `<div style="font-size: 11px; color: var(--text-secondary);">${usdFmt(r.pending_usd)} pending</div>` : ''}</td>
        </tr>`).join('') : '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--text-secondary);">No referrers yet.</td></tr>';
}

async function saveDefaultReferralFee() {
    const fee = parseFloat(document.getElementById('ref-default-fee').value);
    if (Number.isNaN(fee) || fee < 0 || fee > 10) { showToast('Fee must be between 0 and 10%', 'error'); return; }
    try {
        await adminPost('/api/admin/settings', { referral_fee: fee });
        showToast('Default referral fee saved', 'success');
        fetchReferrals();
    } catch (e) { showToast(e.message, 'error'); }
}

async function saveReferrerFee(code, reset = false) {
    const fee = reset ? null : parseFloat(document.getElementById('ref-fee-' + code).value);
    if (!reset && (Number.isNaN(fee) || fee < 0 || fee > 10)) { showToast('Fee must be between 0 and 10%', 'error'); return; }
    try {
        await adminPost('/api/admin/referrals/fee', { code, fee_percent: fee });
        showToast(reset ? 'Fee reset to default' : 'Fee updated for new orders', 'success');
        fetchReferrals();
    } catch (e) { showToast(e.message, 'error'); }
}

// Approving records the payout; send the USDC yourself first, then paste its tx hash.
async function processReferralWithdrawal(id, action, amount) {
    let body = { action };
    if (action === 'approve') {
        const hash = prompt(`Approve ${amount} USDC payout?\n\nSend the USDC first, then paste the payout transaction hash (optional):`);
        if (hash === null) return;
        body.payout_hash = hash.trim();
    } else {
        const note = prompt(`Reject this ${amount} withdrawal? The amount returns to the referrer's balance.\n\nReason (optional, visible to admins):`);
        if (note === null) return;
        body.note = note.trim();
    }
    try {
        await adminPost(`/api/admin/referral-withdrawals/${id}`, body);
        showToast(action === 'approve' ? 'Withdrawal approved' : 'Withdrawal rejected', 'success');
        fetchReferrals();
    } catch (e) { showToast(e.message, 'error'); }
}

async function fetchAuditLog() {
    const body = document.getElementById('audit-log-body');
    if (body) body.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px; color: var(--text-secondary);">Loading audit logs...</td></tr>';
    try {
        const res = await fetch(`${API_BASE}/api/admin/audit`, { headers: { 'Authorization': adminKey } });
        const data = scrub(await res.json());
        const logs = Array.isArray(data) ? data : (data.logs || data.data || []);
        currentAuditLogs = logs;
        renderAuditLogs(currentAuditLogs);
    } catch (e) {
        if (body) body.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px; color: #dc2626;">Failed to load audit log.</td></tr>';
    }
}

function renderAuditLogs(logs) {
    const body = document.getElementById('audit-log-body');
    const label = document.getElementById('audit-count-label');
    if (label) label.innerText = `Showing ${logs.length} security events`;
    if (!body) return;

    if (!logs || !logs.length) {
        body.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 24px; color: var(--text-secondary);">No audit events found.</td></tr>';
        return;
    }

    body.innerHTML = logs.map(log => {
        const dateStr = log.created_at || log.timestamp ? new Date(log.created_at || log.timestamp).toLocaleString() : 'N/A';
        const action = log.action || 'EVENT';
        const ip = log.ip || '-';
        const detailsStr = typeof log.details === 'object' ? JSON.stringify(log.details) : (log.details || '-');
        const isWarning = action.includes('BLOCK') || action.includes('FAIL') || action.includes('REJECT');
        const badgeColor = isWarning ? 'background: rgba(220,38,38,0.1); color: #dc2626;' : 'background: rgba(16,185,129,0.1); color: #059669;';

        return `
            <tr>
                <td data-label="Timestamp" style="font-size: 12px; font-weight: 500;">${dateStr}</td>
                <td data-label="Action"><span style="${badgeColor} padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 700;">${action}</span></td>
                <td data-label="IP Address" style="font-family: monospace; font-size: 12px;">${ip}</td>
                <td data-label="Details" style="font-size: 11px; font-family: monospace; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeAttr(detailsStr)}">${escapeHtml(detailsStr)}</td>
            </tr>
        `;
    }).join('');
}

function filterAuditLogs() {
    const query = (document.getElementById('audit-search-input')?.value || '').trim().toLowerCase();
    if (!query) {
        renderAuditLogs(currentAuditLogs);
        return;
    }
    const filtered = currentAuditLogs.filter(l => {
        const action = (l.action || '').toLowerCase();
        const ip = (l.ip || '').toLowerCase();
        const details = (typeof l.details === 'object' ? JSON.stringify(l.details) : String(l.details || '')).toLowerCase();
        return action.includes(query) || ip.includes(query) || details.includes(query);
    });
    renderAuditLogs(filtered);
}

function exportTransactionsCSV() {
    try {
        const status = (document.getElementById('filter-status')?.value || '').trim();
        const type = (document.getElementById('filter-type')?.value || '').trim();
        const key = encodeURIComponent(adminKey || '');
        const url = `${API_BASE}/api/admin/transactions/export?key=${key}&status=${encodeURIComponent(status)}&type=${encodeURIComponent(type)}`;
        window.open(url, '_blank');
        showToast('Exporting transactions to CSV...', 'info');
    } catch (e) {
        if (!currentTxs || !currentTxs.length) {
            showToast('No transactions to export', 'warning');
            return;
        }
        const headers = ['Reference', 'User Email/Wallet', 'Type', 'Channel', 'Amount', 'Currency', 'Destination Amount', 'Rate', 'Status', 'Created At'];
        const rows = currentTxs.map(t => [
            `"${t.reference || ''}"`,
            `"${t.email || t.wallet_address || ''}"`,
            `"${t.type || ''}"`,
            `"${isPajTx(t) ? 'PAJ' : 'Switch'}"`,
            safeNum(t.amount),
            `"${t.currency || ''}"`,
            safeNum(t.destination_amount),
            safeNum(t.rate),
            `"${t.status || ''}"`,
            `"${t.created_at || ''}"`
        ]);
        const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `velcro_transactions_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Transactions exported to CSV', 'success');
    }
}

async function saveTelegramSettings() {
    const token = (document.getElementById('telegram-bot-token')?.value || '').trim();
    const chatId = (document.getElementById('telegram-chat-id')?.value || '').trim();
    const enabled = document.getElementById('telegram-alerts-toggle')?.checked || false;
    const msgEl = document.getElementById('telegram-message');
    try {
        const res = await fetch(`${API_BASE}/api/admin/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': adminKey },
            body: JSON.stringify({
                telegram_bot_token: token,
                telegram_chat_id: chatId,
                telegram_alerts_enabled: enabled
            })
        });
        const data = await res.json();
        if (data.success) {
            if (msgEl) {
                msgEl.innerText = 'Telegram settings saved successfully!';
                msgEl.style.background = '#ecfdf5'; msgEl.style.color = '#065f46';
                msgEl.classList.remove('hidden');
            }
            showToast('Telegram settings saved', 'success');
        } else {
            if (msgEl) {
                msgEl.innerText = data.error || 'Failed to save';
                msgEl.style.background = '#fef2f2'; msgEl.style.color = '#991b1b';
                msgEl.classList.remove('hidden');
            }
        }
    } catch (e) {
        if (msgEl) {
            msgEl.innerText = 'Error: ' + e.message;
            msgEl.style.background = '#fef2f2'; msgEl.style.color = '#991b1b';
            msgEl.classList.remove('hidden');
        }
    }
}

async function testTelegramAlert() {
    const token = (document.getElementById('telegram-bot-token')?.value || '').trim();
    const chatId = (document.getElementById('telegram-chat-id')?.value || '').trim();
    const msgEl = document.getElementById('telegram-message');
    if (msgEl) {
        msgEl.innerText = 'Sending test alert...';
        msgEl.style.background = '#eff6ff'; msgEl.style.color = '#1e40af';
        msgEl.classList.remove('hidden');
    }
    try {
        const res = await fetch(`${API_BASE}/api/admin/telegram/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': adminKey },
            body: JSON.stringify({ telegram_bot_token: token, telegram_chat_id: chatId })
        });
        const data = await res.json();
        if (data.success) {
            if (msgEl) {
                msgEl.innerText = '✅ Test alert delivered! Check your Telegram.';
                msgEl.style.background = '#ecfdf5'; msgEl.style.color = '#065f46';
            }
            showToast('Test alert sent to Telegram!', 'success');
        } else {
            if (msgEl) {
                msgEl.innerText = '❌ Failed: ' + (data.error || 'Check Bot Token and Chat ID');
                msgEl.style.background = '#fef2f2'; msgEl.style.color = '#991b1b';
            }
        }
    } catch (e) {
        if (msgEl) {
            msgEl.innerText = '❌ Error: ' + e.message;
            msgEl.style.background = '#fef2f2'; msgEl.style.color = '#991b1b';
        }
    }
}

function exportUsersCSV() {
    if (!currentUsers || !currentUsers.length) {
        showToast('No users to export', 'warning');
        return;
    }
    const headers = ['User Email', 'Primary Address', 'All Addresses Used', 'Address Count', 'First Seen', 'Total Volume (USD)', 'Total Volume (NGN)', 'Total TX Count'];
    const rows = currentUsers.map(u => {
        const volUSD = safeNum(u.total_volume_usd !== undefined ? u.total_volume_usd : u.total_volume);
        const volNGN = safeNum(u.total_volume_ngn) || (volUSD * 1500);
        const email = u.email || (u.id && u.id.includes('@') ? u.id : '');
        const wallets = (Array.isArray(u.wallets) && u.wallets.length) ? u.wallets : (u.wallet_address ? [u.wallet_address] : []);
        const primaryWallet = wallets[0] || u.wallet_address || '';
        const allWallets = wallets.join('; ');
        return [
            `"${(email || '').replace(/"/g, '""')}"`,
            `"${(primaryWallet || '').replace(/"/g, '""')}"`,
            `"${allWallets.replace(/"/g, '""')}"`,
            wallets.length,
            `"${u.created_at || ''}"`,
            volUSD.toFixed(2),
            volNGN.toFixed(2),
            safeNum(u.tx_count)
        ];
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `velcro_users_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Users exported to CSV', 'success');
}

function setFilterPreset(preset) {
    const fromEl = document.getElementById('filter-date-from');
    const toEl = document.getElementById('filter-date-to');
    const today = new Date();
    toEl.value = today.toISOString().slice(0, 10);

    if (preset === 'today') {
        fromEl.value = today.toISOString().slice(0, 10);
    } else if (preset === '7days') {
        const past = new Date(today);
        past.setDate(past.getDate() - 7);
        fromEl.value = past.toISOString().slice(0, 10);
    } else if (preset === '30days') {
        const past = new Date(today);
        past.setDate(past.getDate() - 30);
        fromEl.value = past.toISOString().slice(0, 10);
    }
    applyFilters();
}

async function runFixPajChannels() {
    const btn = document.getElementById('btn-fix-paj-channels');
    if (btn) { btn.innerText = 'Fixing...'; btn.disabled = true; }
    try {
        const res = await fetch(`${API_BASE}/api/admin/fix-paj-channels`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Fixed ${data.fixed} PAJ channel labels!`, 'success');
            await fetchData();
        } else {
            showToast(data.error || 'Fix failed', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    } finally {
        if (btn) { btn.innerHTML = '<i data-lucide="tag" style="width: 14px; height: 14px;"></i> Fix PAJ Channels'; btn.disabled = false; if (window.lucide) lucide.createIcons(); }
    }
}

async function runFixPajStatuses() {
    const btn = document.getElementById('btn-fix-paj-statuses');
    if (btn) { btn.innerText = 'Remapping...'; btn.disabled = true; }
    try {
        const res = await fetch(`${API_BASE}/api/admin/fix-paj-statuses`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Remapped ${data.fixed} PAJ status codes!`, 'success');
            await fetchData();
        } else {
            showToast(data.error || 'Remap failed', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    } finally {
        if (btn) { btn.innerHTML = '<i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Remap PAJ Statuses'; btn.disabled = false; if (window.lucide) lucide.createIcons(); }
    }
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function statusLabel(status) {
    const s = String(status || '').replace(/_/g, ' ').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Customer data (emails, wallets, names, references, user agents) is rendered through
// innerHTML and inline onclick='...' all over this page. Entity-escaping doesn't protect
// the onclick JS strings, so strip the characters that can break out, once, at load time.
// ponytail: also mangles legit values like O'Brien; per-sink escaping if that matters.
function scrub(v) {
    if (typeof v === 'string') {
        // Some endpoints return beneficiary/meta as JSON text; scrub inside it, keep it valid JSON.
        if (/^\s*[\[{]/.test(v)) {
            try { return JSON.stringify(scrub(JSON.parse(v))); } catch (e) {}
        }
        return v.replace(/[<>"'`\\]/g, '');
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k in v) out[k] = scrub(v[k]);
        return out;
    }
    return v;
}

function switchSection(id) {
    document.querySelectorAll('.view-content').forEach(v => v.classList.remove('active'));
    const targetSection = document.getElementById(`section-${id}`);
    if (targetSection) targetSection.classList.add('active');
    document.querySelectorAll('nav li').forEach(l => l.classList.remove('active'));
    const navId = id === 'user-detail' ? 'users' : id;
    if (document.getElementById(`nav-${navId}`)) {
        document.getElementById(`nav-${navId}`).classList.add('active');
    }
    if (id === 'audit') {
        fetchAuditLog();
    }
    if (id === 'referrals') {
        fetchReferrals();
    }
    if (id === 'hostfi') {
        fetchHostfi();
    }
    if (id === 'coins') {
        fetchRoutes();
    }
    if (id === 'email') {
        fetchCampaigns();
    }
    if (window.lucide) lucide.createIcons();
    closeSidebar();
}

async function refreshTransactionStatus() {
    if (!currentModalTx) return;
    const btn = document.getElementById('modal-refresh-btn');
    const originalText = btn.innerText;
    btn.innerText = 'Refreshing...';
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/admin/refresh-status/${currentModalTx.reference}`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            if (data.transaction) {
                data.transaction = scrub(data.transaction);
                const idx = currentTxs.findIndex(t => t.reference === currentModalTx.reference);
                if (idx !== -1) currentTxs[idx] = data.transaction;
                currentModalTx = data.transaction;
            }
            document.getElementById('modal-status').innerText = statusLabel(data.status);
            document.getElementById('modal-status').className = `status-pill ${data.status.toLowerCase()}`;
            if (data.status !== data.previousStatus) {
                showToast(`Status updated: ${data.previousStatus} → ${data.status}`, 'success');
                await fetchData();
                if (currentModalTx) viewTransaction(currentModalTx.reference);
            } else {
                showToast('Status verified: ' + data.status, 'info');
            }
        } else {
            showToast(data.error || 'Refresh failed', 'error');
        }
    } catch (e) {
        showToast('Error: ' + e.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// ─── API Tools & Compliance Hub Logic ───

function copyElementText(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text === '-' || text === 'Not provided') return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'success'));
    } else {
        const t = document.createElement('textarea');
        t.value = text;
        document.body.appendChild(t);
        t.select();
        document.execCommand('copy');
        document.body.removeChild(t);
        showToast('Copied to clipboard!', 'success');
    }
}

function openAmlForWallet() {
    const wallet = document.getElementById('modal-wallet-address').innerText.trim();
    if (!wallet || wallet === '-' || wallet === 'Not provided') {
        showToast('No wallet address recorded for this transaction', 'warning');
        return;
    }
    closeTxModal();
    switchSection('api-tools');
    switchApiTool('aml');
    const rad = document.querySelector('input[name="aml_type"][value="CRYPTO_WALLET"]');
    if (rad) rad.checked = true;
    toggleAmlFields();
    document.getElementById('aml-wallet-input').value = wallet;
    runAmlLookup();
}

function switchApiTool(toolId) {
    document.querySelectorAll('.api-tab').forEach(b => {
        b.classList.remove('active');
        b.style.background = 'var(--card-bg)';
        b.style.color = 'var(--text-main)';
    });
    document.querySelectorAll('.api-tool-panel').forEach(p => p.style.display = 'none');

    const activeTab = document.getElementById(`tab-tool-${toolId}`);
    if (activeTab) {
        activeTab.classList.add('active');
        activeTab.style.background = 'var(--velcro-navy)';
        activeTab.style.color = '#fff';
    }
    const activePanel = document.getElementById(`tool-view-${toolId}`);
    if (activePanel) {
        activePanel.style.display = 'block';
    }
    if (window.lucide) lucide.createIcons();
}

function toggleAmlFields() {
    const checkedRad = document.querySelector('input[name="aml_type"]:checked');
    const type = checkedRad ? checkedRad.value : 'CRYPTO_WALLET';
    const walletWrap = document.getElementById('aml-field-wallet');
    const nameWrap = document.getElementById('aml-field-name');
    const countryWrap = document.getElementById('aml-field-country');
    const extraWrap = document.getElementById('aml-field-extra');
    const extraLabel = document.getElementById('aml-extra-label');
    const extraInput = document.getElementById('aml-extra-input');

    if (type === 'CRYPTO_WALLET') {
        walletWrap.style.display = 'block';
        nameWrap.style.display = 'none';
        countryWrap.style.display = 'none';
        extraWrap.style.display = 'none';
    } else if (type === 'INDIVIDUAL') {
        walletWrap.style.display = 'none';
        nameWrap.style.display = 'block';
        countryWrap.style.display = 'block';
        extraWrap.style.display = 'block';
        extraLabel.innerText = 'DATE OF BIRTH (YYYY-MM-DD)';
        extraInput.placeholder = '1990-01-15';
    } else if (type === 'BUSINESS') {
        walletWrap.style.display = 'none';
        nameWrap.style.display = 'block';
        countryWrap.style.display = 'block';
        extraWrap.style.display = 'block';
        extraLabel.innerText = 'REGISTRATION NUMBER (RC/BN)';
        extraInput.placeholder = '12345678';
    }
}

async function runAmlLookup() {
    const btn = document.getElementById('btn-run-aml');
    const originalText = btn.innerHTML;
    const checkedRad = document.querySelector('input[name="aml_type"]:checked');
    const type = checkedRad ? checkedRad.value : 'CRYPTO_WALLET';

    const payload = { type };
    if (type === 'CRYPTO_WALLET') {
        const w = document.getElementById('aml-wallet-input').value.trim();
        if (!w) { showToast('Please enter a wallet address', 'warning'); return; }
        payload.wallet_address = w;
    } else if (type === 'INDIVIDUAL') {
        const name = document.getElementById('aml-name-input').value.trim();
        if (!name) { showToast('Please enter individual name', 'warning'); return; }
        payload.name = name;
        payload.country = document.getElementById('aml-country-input').value;
        const dob = document.getElementById('aml-extra-input').value.trim();
        if (dob) payload.date_of_birth = dob;
    } else if (type === 'BUSINESS') {
        const name = document.getElementById('aml-name-input').value.trim();
        if (!name) { showToast('Please enter business name', 'warning'); return; }
        payload.name = name;
        payload.country = document.getElementById('aml-country-input').value;
        const reg = document.getElementById('aml-extra-input').value.trim();
        if (reg) payload.registration_number = reg;
    }

    btn.innerHTML = 'Screening...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/tools/aml-lookup`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok || (data.success === false && !data.data)) {
            showToast(data.error || 'AML Lookup failed', 'error');
            return;
        }

        document.getElementById('aml-result-empty').style.display = 'none';
        document.getElementById('aml-result-content').style.display = 'block';
        document.getElementById('aml-raw-json').textContent = JSON.stringify(data, null, 2);

        const d = data.data || data;
        const status = (d.status || 'REVIEW').toUpperCase();
        const badge = document.getElementById('aml-badge-status');
        badge.innerText = status;
        if (status === 'APPROVED') {
            badge.style.color = '#16a34a';
        } else if (status === 'REJECTED') {
            badge.style.color = '#dc2626';
        } else {
            badge.style.color = '#d97706';
        }

        const matches = (d.details && d.details.matches) ? d.details.matches : [];
        document.getElementById('aml-matches-count').innerText = `${matches.length} Match Flag(s)`;

        const listEl = document.getElementById('aml-matches-list');
        if (matches.length === 0) {
            listEl.innerHTML = '<div style="padding:10px; background:rgba(22,163,74,0.1); color:#16a34a; border-radius:8px; font-size:12px; font-weight:600;">✅ Clean: No sanctions or PEP matches found.</div>';
        } else {
            listEl.innerHTML = matches.map(m => `
                <div style="padding:10px; background:rgba(220,38,38,0.08); border:1px solid rgba(220,38,38,0.2); border-radius:8px; margin-bottom:8px; font-size:12px;">
                    <div style="display:flex; justify-content:space-between; font-weight:700; color:#dc2626;">
                        <span>${m.name || 'Identified Subject'}</span>
                        <span>${m.certainty || 0}% Certainty</span>
                    </div>
                    <div style="margin-top:4px; font-size:11px; color:var(--text-secondary);">
                        Flags: <b>${(m.flags || []).join(', ') || 'N/A'}</b>
                    </div>
                </div>
            `).join('');
        }
        showToast(`Screening complete: ${status}`, 'success');
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
}

function updateResolverProvider() {
    const provider = document.getElementById('resolve-provider').value;
    const countryWrap = document.getElementById('resolve-country-wrap');
    const bankLabel = document.getElementById('resolve-bank-label');
    const bankInput = document.getElementById('resolve-bank-code');

    if (provider === 'paj') {
        countryWrap.style.display = 'none';
        bankLabel.innerText = 'PAJ BANK ID';
        bankInput.placeholder = 'e.g. 044 or PAJ bank UUID';
    } else {
        countryWrap.style.display = 'block';
        bankLabel.innerText = 'BANK CODE / CBN CODE';
        bankInput.placeholder = 'e.g. 044 (Access), 058 (GTB), 057 (Zenith)';
    }
}

async function runAccountResolve() {
    const btn = document.getElementById('btn-run-resolve');
    const originalText = btn.innerHTML;
    const provider = document.getElementById('resolve-provider').value;
    const country = document.getElementById('resolve-country').value;
    const bankCode = document.getElementById('resolve-bank-code').value.trim();
    const accountNumber = document.getElementById('resolve-account-number').value.trim();

    if (!bankCode || !accountNumber) {
        showToast('Please enter both bank code and account number', 'warning');
        return;
    }

    btn.innerHTML = 'Resolving...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/tools/resolve-bank`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, country, bank_code: bankCode, account_number: accountNumber })
        });
        const data = await res.json();

        if (!res.ok || data.success === false) {
            showToast(data.error || data.message || 'Account resolution failed', 'error');
            return;
        }

        document.getElementById('resolve-result-empty').style.display = 'none';
        document.getElementById('resolve-result-content').style.display = 'block';
        document.getElementById('resolve-raw-json').textContent = JSON.stringify(data, null, 2);

        const d = data.data || data;
        const name = d.account_name || d.accountName || d.name || d.holder_name || (d.beneficiary && d.beneficiary.account_name) || 'Resolved';
        document.getElementById('resolve-res-name').innerText = name;
        document.getElementById('resolve-res-account').innerText = accountNumber;
        document.getElementById('resolve-res-bank').innerText = d.bank_name || d.bankName || bankCode;
        showToast('Account name resolved successfully!', 'success');
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function runLiveStatusCheck() {
    const btn = document.getElementById('btn-run-status');
    const originalText = btn.innerHTML;
    const reference = document.getElementById('lookup-reference').value.trim();
    const provider = document.getElementById('lookup-provider').value;

    if (!reference) {
        showToast('Please enter a transaction reference', 'warning');
        return;
    }

    btn.innerHTML = 'Querying...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/tools/check-status`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reference, provider })
        });
        const data = await res.json();

        if (!res.ok || data.success === false) {
            showToast(data.error || data.message || 'Status check failed', 'error');
            return;
        }

        document.getElementById('status-result-empty').style.display = 'none';
        document.getElementById('status-result-content').style.display = 'block';
        document.getElementById('lookup-raw-json').textContent = JSON.stringify(data, null, 2);

        const d = data.data || data;
        const status = (d.status || d.state || 'UNKNOWN').toUpperCase();
        const badge = document.getElementById('lookup-res-badge');
        badge.innerText = status;
        badge.className = `status-pill ${status.toLowerCase()}`;
        document.getElementById('lookup-res-provider').innerText = data.provider ? data.provider.toUpperCase() : (reference.startsWith('paj_') ? 'PAJ' : 'SWITCH');
        document.getElementById('lookup-res-type').innerText = (d.type || d.transactionType || '-').toUpperCase();
        document.getElementById('lookup-res-hash').innerText = d.signature || d.hash || (d.meta && d.meta.hash) || 'None';
        showToast(`Live status: ${status}`, 'success');
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function runQuoteFetch() {
    const btn = document.getElementById('btn-run-quote');
    const originalText = btn.innerHTML;
    const provider = document.getElementById('quote-provider').value;
    const direction = document.getElementById('quote-direction').value;
    const amount = parseFloat(document.getElementById('quote-amount').value) || 100;
    const asset = document.getElementById('quote-asset').value;
    const currency = document.getElementById('quote-currency').value;

    btn.innerHTML = 'Fetching...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/tools/quote`, {
            method: 'POST',
            headers: { 'Authorization': adminKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, direction, amount, asset, currency })
        });
        const data = await res.json();

        if (!res.ok || data.success === false) {
            showToast(data.error || data.message || 'Quote query failed', 'error');
            return;
        }

        document.getElementById('quote-result-empty').style.display = 'none';
        document.getElementById('quote-result-content').style.display = 'block';
        document.getElementById('quote-raw-json').textContent = JSON.stringify(data, null, 2);

        const d = data.data || data;
        const rate = d.rate?.rate || d.rate || (d.onRampRate && d.onRampRate.rate) || (d.offRampRate && d.offRampRate.rate) || 0;
        document.getElementById('quote-res-rate').innerText = rate ? `1 USD / Token = ${Number(rate).toLocaleString()} ${currency}` : 'Calculated';
        document.getElementById('quote-res-src').innerText = `${amount} ${direction === 'ONRAMP' ? currency : asset}`;
        document.getElementById('quote-res-dst').innerText = d.destination?.amount ? `${Number(d.destination.amount).toLocaleString()} ${currency}` : (rate ? `${Number(amount * rate).toLocaleString()} ${currency}` : '-');
        showToast('Live rate fetched!', 'success');
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function runFixWalletAddresses() {
    const btn = document.getElementById('btn-fix-wallets');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Syncing...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/admin/tools/fix-wallet-addresses`, {
            method: 'POST',
            headers: { 'Authorization': adminKey }
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Successfully synced ${data.fixed} transaction wallet addresses!`, 'success');
            await fetchData();
        } else {
            showToast(data.error || 'Failed to sync wallet addresses', 'error');
        }
    } catch (e) {
        showToast('Network error: ' + e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

function closeTxModal() { document.getElementById('tx-modal').style.display = 'none'; }
function toggleSidebar() { document.getElementById('main-sidebar').classList.toggle('active'); }
function closeSidebar() { document.getElementById('main-sidebar').classList.remove('active'); }
function logout() { localStorage.removeItem('velcro_admin_key'); location.reload(); }

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeTxModal();
        closeSidebar();
    }
});

window.onload = () => {
    // Ensure icons render even before auth
    setTimeout(() => { if (window.lucide) lucide.createIcons(); }, 100);
    const overlay = document.getElementById('auth-overlay');
    if (adminKey) {
        if (overlay) overlay.style.display = 'none';
        fetchData();
        setInterval(fetchData, 60000);
    }
};
