require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { randomUUID, createHash, randomInt } = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx)
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/velcro_ramp';

// ─── PAJ Ramp Integration ───
let pajModule = null;
try { pajModule = require('./paj'); } catch (err) { console.log('⚠️  PAJ module not loaded:', err.message); }
const SWITCH_BASE_URL = process.env.SWITCH_BASE_URL || 'https://api.onswitch.xyz';
const SWITCH_SERVICE_KEY = process.env.SWITCH_SERVICE_KEY;
const DEVELOPER_FEE = parseFloat(process.env.DEVELOPER_FEE) || 0.5;

// SECURITY: No hardcoded fallback for sensitive addresses. Crash if missing.
const DEVELOPER_RECIPIENT = process.env.DEVELOPER_RECIPIENT;
if (!DEVELOPER_RECIPIENT) {
  console.error('FATAL: DEVELOPER_RECIPIENT env var is required.');
  process.exit(1);
}
const DEVELOPER_WITHDRAW_ASSET = process.env.DEVELOPER_WITHDRAW_ASSET || 'solana:usdc';

// SECURITY: Admin password — support plain text OR bcrypt-style hash (sha256)
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD_RAW) {
  console.error('FATAL: ADMIN_PASSWORD env var is required.');
  process.exit(1);
}
const ADMIN_PASSWORD_HASH = ADMIN_PASSWORD_RAW.startsWith('sha256:')
  ? ADMIN_PASSWORD_RAW.slice(7)
  : createHash('sha256').update(ADMIN_PASSWORD_RAW).digest('hex');

const WITHDRAWAL_ALLOWED_RECIPIENTS = (process.env.WITHDRAWAL_ALLOWED_RECIPIENTS || DEVELOPER_RECIPIENT)
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

// ─── Email (Nodemailer) ───
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { console.log('⚠️ Nodemailer not available'); }
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

let mailTransporter = null;
if (nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendMail(subject, html, text) {
  if (!mailTransporter || !ADMIN_EMAIL) return { sent: false, reason: 'SMTP not configured' };
  try {
    const info = await mailTransporter.sendMail({
      from: `"Velcro Admin" <${SMTP_FROM}>`,
      to: ADMIN_EMAIL,
      subject,
      text,
      html
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// ─── OTP Storage ───
const otpStore = new Map(); // key: 'withdraw', value: { code, expiry, attempts }
const OTP_VALID_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 3;

function generateOTP() {
  return String(randomInt(100000, 999999));
}

function storeOTP(key, code) {
  otpStore.set(key, { code, expiry: Date.now() + OTP_VALID_MS, attempts: 0 });
}

function verifyOTP(key, input) {
  const record = otpStore.get(key);
  if (!record) return { valid: false, reason: 'No OTP requested. Click "Get OTP" first.' };
  if (Date.now() > record.expiry) {
    otpStore.delete(key);
    return { valid: false, reason: 'OTP expired. Request a new one.' };
  }
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    otpStore.delete(key);
    return { valid: false, reason: 'Too many failed attempts. Request a new OTP.' };
  }
  if (record.code !== String(input).trim()) {
    record.attempts++;
    return { valid: false, reason: 'Invalid OTP. ' + (OTP_MAX_ATTEMPTS - record.attempts) + ' attempts remaining.' };
  }
  otpStore.delete(key);
  return { valid: true };
}

// ─── Security Audit Logger ───
const AUDIT_LOG_PATH = path.join(__dirname, 'audit.log');
function auditLog(action, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ip: details.ip || 'unknown',
    userAgent: details.userAgent || 'unknown',
    ...details
  };
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (e) { console.error('Audit log failed:', e.message); }
}

// ─── Admin Auth Helpers ───
function verifyAdminPassword(input) {
  const clean = input.replace(/^Bearer\s+/i, '');
  const inputHash = createHash('sha256').update(clean).digest('hex');
  return inputHash === ADMIN_PASSWORD_HASH;
}

// ─── Persistent Settings ───
function loadSettings() {
  const defaults = { 
    platform_fee: DEVELOPER_FEE, 
    buy_max_limit: 50000, 
    sell_min_limit: 1, 
    sell_max_limit: 10000,
    paj_email: process.env.PAJ_EMAIL || 'paj@usevelcro.com'
  };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const content = fs.readFileSync(SETTINGS_PATH, 'utf8');
      if (content) {
        const data = JSON.parse(content);
        return { ...defaults, ...data };
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err.message);
  }
  return defaults;
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err.message);
    return false;
  }
}

function getPlatformFee() {
  const settings = loadSettings();
  const fee = parseFloat(settings.platform_fee);
  return Number.isNaN(fee) ? DEVELOPER_FEE : fee;
}

// ─── MongoDB Schema ───
const transactionSchema = new mongoose.Schema({
  reference: { type: String, unique: true, required: true, index: true },
  switch_reference: { type: String, index: true },
  type: { type: String, required: true, enum: ['OFFRAMP', 'ONRAMP'], index: true },
  status: { type: String, default: 'AWAITING_DEPOSIT', index: true },
  country: { type: String, required: true, index: true },
  currency: { type: String, required: true },
  asset: { type: String, required: true },
  channel: { type: String, default: 'BANK' },
  amount: { type: Number, required: true },
  rate: Number,
  fee_total: Number,
  fee_platform: Number,
  fee_developer: Number,
  source_amount: Number,
  source_currency: String,
  destination_amount: Number,
  destination_currency: String,
  deposit_address: String,
  deposit_bank_name: String,
  deposit_account_number: String,
  deposit_account_name: String,
  deposit_note: String,
  beneficiary: String, // Stringified JSON
  wallet_address: String,
  hash: String,
  explorer_url: String,
  callback_url: String,
  meta: String, // Stringified JSON
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const Transaction = mongoose.model('Transaction', transactionSchema);

// ─── Database Connection ───
let dbConnected = false;
mongoose.set('bufferCommands', false); // Don't buffer ops when disconnected
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000,
})
  .then(() => {
    dbConnected = true;
    console.log('✅ Connected to MongoDB');
  })
  .catch(err => {
    dbConnected = false;
    console.error('❌ MongoDB Connection Error:', err.message);
    console.log('⚠️  Running without database persistence. Core API still works.');
  });

mongoose.connection.on('disconnected', () => {
  dbConnected = false;
  console.log('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  dbConnected = true;
  console.log('✅ MongoDB reconnected');
});

// Prevent unhandled promise rejections from crashing the server
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Safe DB operation wrapper — silently skips writes when DB is down
async function safeDbWrite(operation) {
  if (!dbConnected) {
    console.log('⏭️  DB write skipped (MongoDB unavailable)');
    return null;
  }
  try {
    return await operation();
  } catch (err) {
    console.error('DB write error:', err.message);
    return null;
  }
}

async function safeDbRead(operation) {
  if (!dbConnected) {
    console.log('⏭️  DB read skipped (MongoDB unavailable)');
    return [];
  }
  try {
    return await operation();
  } catch (err) {
    console.error('DB read error:', err.message);
    return [];
  }
}

// ─── Middleware ───
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: corsOrigins.includes('*') ? true : corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Switch API Client ───
// ─── Switch API Client with Retry ───
async function switchApi(endpoint, options = {}, retries = 2) {
  const url = `${SWITCH_BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-service-key': SWITCH_SERVICE_KEY,
    ...(options.headers || {}),
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!res.ok) {
        const err = new Error(data.message || `Switch API error: ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      const isRetryable = !err.status || err.status >= 500 || err.message.includes('fetch failed') || err.message.includes('EAI_AGAIN');
      if (!isRetryable || attempt >= retries) break;
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.log(`[Retry ${attempt + 1}/${retries}] ${endpoint} — waiting ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── Helpers ───
function successResponse(data, message = 'Success') {
  return { success: true, message, timestamp: new Date().toISOString(), data };
}

function errorResponse(message, status = 400) {
  return { success: false, message, timestamp: new Date().toISOString(), status };
}

// ─── Routes ───

app.get('/api/health', (req, res) => {
  res.json(successResponse({
    service: 'velcro-backend',
    version: '1.2.0',
    db: dbConnected ? 'mongodb' : 'offline',
    dbConnected
  }));
});

app.get('/api/assets', async (req, res, next) => {
  try {
    let assets = [];
    let blockchains = {};
    try {
      const data = await switchApi('/asset');
      assets = data.data || [];
    } catch (err) {
      console.error('⚠️  Switch /api/assets failed:', err.message);
    }

    const offramp = {};
    const onramp = {};

    for (const asset of assets) {
      const chainId = asset.blockchain.name.toLowerCase();
      const chainName = asset.blockchain.name;
      const symbol = asset.code;
      const name = asset.name;

      if (!blockchains[chainId]) {
        blockchains[chainId] = { id: chainId, name: chainName, type: asset.blockchain.type };
      }

      if (asset.offramp_supported) {
        if (!offramp[symbol]) offramp[symbol] = { name, chains: [] };
        offramp[symbol].chains.push(chainId);
      }

      if (asset.onramp_supported) {
        if (!onramp[symbol]) onramp[symbol] = { name, chains: [] };
        onramp[symbol].chains.push(chainId);
      }
    }

    // Sort chains consistently
    for (const sym of Object.keys(offramp)) offramp[sym].chains.sort();
    for (const sym of Object.keys(onramp)) onramp[sym].chains.sort();

    res.json(successResponse({ offramp, onramp, blockchains }));
  } catch (err) { next(err); }
});

app.get('/api/rates', async (req, res, next) => {
  try {
    const { country, currency } = req.query;
    let path = '/rates';
    const params = new URLSearchParams();
    if (country) params.append('country', country);
    if (currency) params.append('currency', currency);
    const qs = params.toString();
    if (qs) path += '?' + qs;
    
    try {
      const data = await switchApi(path);
      res.json(data);
    } catch (err) {
      console.error('⚠️  Switch /api/rates failed:', err.message);
      res.json(successResponse([], 'Switch rates unavailable'));
    }
  } catch (err) { next(err); }
});

app.get('/api/institutions', async (req, res, next) => {
  try {
    const { country, currency, channel } = req.query;
    const params = new URLSearchParams();
    if (country) params.append('country', country);
    if (currency) params.append('currency', currency);
    if (channel) params.append('channel', channel);
    let path = '/institution';
    const qs = params.toString();
    if (qs) path += '?' + qs;
    
    try {
      const data = await switchApi(path);
      res.json(data);
    } catch (err) {
      console.error('⚠️  Switch /api/institutions failed:', err.message);
      res.json(successResponse([], 'Switch institutions unavailable'));
    }
  } catch (err) { next(err); }
});

app.post('/api/resolve', async (req, res, next) => {
  try {
    const { country, beneficiary } = req.body;
    if (!country || !beneficiary) {
      return res.status(400).json(errorResponse('country and beneficiary are required'));
    }
    const data = await switchApi('/institution/lookup', {
      method: 'POST',
      body: JSON.stringify({ country, beneficiary }),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/requirements', async (req, res, next) => {
  try {
    const { direction, country, currency, type, channel } = req.query;
    if (!direction || !country) {
      return res.status(400).json(errorResponse('direction and country are required'));
    }
    const params = new URLSearchParams();
    params.append('direction', direction);
    params.append('country', country);
    if (currency) params.append('currency', currency);
    if (type) params.append('type', type);
    if (channel) params.append('channel', channel);
    
    try {
      const data = await switchApi(`/requirement?${params.toString()}`);
      res.json(data);
    } catch (err) {
      console.error('⚠️  Switch /api/requirements failed:', err.message);
      res.json(successResponse([], 'Switch requirements unavailable'));
    }
  } catch (err) { next(err); }
});


app.post('/api/rate', async (req, res, next) => {
  try {
    const { direction, asset, country, currency, channel } = req.body;
    if (!direction || !country) {
      return res.status(400).json(errorResponse('direction and country are required'));
    }
    const endpoint = direction === 'ONRAMP' ? '/onramp/rate' : '/offramp/rate';
    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify({ 
        asset, 
        country, 
        currency, 
        channel,
        developer_fee: getPlatformFee(),
        developer_recipient: DEVELOPER_RECIPIENT
      }),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/initiate', async (req, res, next) => {
  try {
    const {
      direction, amount, country, asset, currency, channel,
      beneficiary, callback_url, reference, reason, exact_output,
      wallet_address
    } = req.body;

    if (!direction || !amount || !country || !asset) {
      return res.status(400).json(errorResponse('direction, amount, country, and asset are required'));
    }

    const txRef = reference || randomUUID();
    const endpoint = direction === 'ONRAMP' ? '/onramp/initiate' : '/offramp/initiate';

    const payload = {
      amount,
      country,
      asset,
      currency,
      channel,
      beneficiary,
      exact_output: exact_output ?? false,
      reference: txRef,
      reason: reason || 'PERSONAL_TRANSFER',
      narration: 'Velcro Settlement',
      ...(DEVELOPER_RECIPIENT ? { developer_fee: getPlatformFee(), developer_recipient: DEVELOPER_RECIPIENT } : {})
    };
    if (callback_url) payload.callback_url = callback_url;

    if (direction === 'OFFRAMP') {
      payload.static = false;
      payload.sender_name = 'Velcro Ramp';
    } else if (direction === 'ONRAMP' && wallet_address) {
      payload.wallet_address = wallet_address;
    }

    const data = await switchApi(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const d = data.data || {};
    const dep = d.deposit || {};
    const fee = d.fee || {};
    const src = d.source || {};
    const dst = d.destination || {};

    await safeDbWrite(() => Transaction.create({
      reference: txRef,
      switch_reference: d.id || d.reference || null,
      type: direction,
      status: d.status || 'AWAITING_DEPOSIT',
      country,
      currency: currency || (direction === 'ONRAMP' ? src.currency : dst.currency) || 'NGN',
      asset,
      channel: channel || 'BANK',
      amount,
      rate: d.rate || null,
      fee_total: fee.total || null,
      fee_platform: fee.platform || null,
      fee_developer: fee.developer || null,
      source_amount: src.amount || null,
      source_currency: src.currency || null,
      destination_amount: dst.amount || null,
      destination_currency: dst.currency || null,
      deposit_address: dep.address || null,
      deposit_bank_name: dep.bank_name || null,
      deposit_account_number: dep.account_number || null,
      deposit_account_name: dep.account_name || null,
      deposit_note: Array.isArray(dep.note) ? dep.note.join('\n') : dep.note || null,
      beneficiary: beneficiary ? JSON.stringify(beneficiary) : null,
      wallet_address: wallet_address || null,
      callback_url: callback_url || null,
      meta: JSON.stringify(d)
    }));

    res.json(data);
  } catch (err) { next(err); }
});

// Update to use /payment/status
app.get('/api/status', async (req, res, next) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    const data = await switchApi(`/payment/status?reference=${encodeURIComponent(reference)}`);
    const d = data.data || {};

    if (d.status) {
      await safeDbWrite(() => Transaction.findOneAndUpdate(
        { reference },
        { 
          status: d.status, 
          hash: (d.meta && d.meta.hash) || d.hash || null, 
          explorer_url: (d.meta && d.meta.explorer_url) || d.explorer_url || null 
        },
        { new: true }
      ));
    }

    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/cancel', async (req, res, next) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    await safeDbWrite(() => Transaction.findOneAndUpdate(
      { reference },
      { status: 'CANCELLED' },
      { new: true }
    ));

    res.json({ success: true, message: 'Transaction cancelled' });
  } catch (err) { next(err); }
});

// Update to use /payment/confirm
app.post('/api/confirm', async (req, res, next) => {
  try {
    const { reference, hash } = req.body;
    if (!reference) return res.status(400).json(errorResponse('reference is required'));

    // Don't require DB record for confirmation — Switch is source of truth

    const payload = { reference };
    if (hash) payload.hash = hash;

    const data = await switchApi('/payment/confirm', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const d = data.data || {};
    await safeDbWrite(() => Transaction.findOneAndUpdate(
      { reference },
      { status: d.status || 'PROCESSING', hash: hash || null }
    ));

    res.json(data);
  } catch (err) { next(err); }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const { type, country, status, limit = 50, offset = 0 } = req.query;
    const query = {};
    if (type) query.type = type;
    if (country) query.country = country;
    if (status) query.status = status;

    const rows = await safeDbRead(() => Transaction.find(query)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset)));
    
    res.json(successResponse(rows));
  } catch (err) {
    res.status(500).json(errorResponse(err.message));
  }
});

app.get('/api/transactions/:reference', async (req, res) => {
  try {
    const row = await safeDbRead(() => Transaction.findOne({ reference: req.params.reference }));
    if (!row) return res.status(404).json(errorResponse('Transaction not found', 404));
    res.json(successResponse(row));
  } catch (err) {
    res.status(500).json(errorResponse(err.message));
  }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const { limit = 20, offset = 0, status, direction } = req.query;
    const params = new URLSearchParams();
    params.append('limit', limit);
    params.append('offset', offset);
    if (status) params.append('status', status);
    if (direction) params.append('direction', direction);
    const data = await switchApi(`/payment/history?${params.toString()}`);
    res.json(data);
  } catch (err) { next(err); }
});

// Improved Webhook
app.post('/webhook/switch', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    console.log('[Webhook Received]', JSON.stringify(payload));
    
    // Switch often sends: { event, reference, status, data: { ... } }
    const reference = payload.reference || (payload.data && payload.data.reference);
    const status = payload.status || (payload.data && payload.data.status);

    if (reference && status) {
      await safeDbWrite(() => Transaction.findOneAndUpdate(
        { reference },
        { 
          status, 
          meta: JSON.stringify(payload),
          hash: (payload.data && payload.data.hash) || null,
          explorer_url: (payload.data && payload.data.explorer_url) || null
        }
      ));
      console.log(`[Webhook] Updated status of ${reference} to ${status}`);
    }

    res.json({ success: true, received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ─── Admin Endpoints ───
const adminRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 requests per 5 min per IP
  message: { error: 'Too many admin requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth && verifyAdminPassword(auth)) {
    req.adminClientIp = req.ip || req.connection.remoteAddress || 'unknown';
    return next();
  }
  auditLog('ADMIN_AUTH_FAIL', { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(401).json({ error: 'Unauthorized' });
};

// Withdrawal cooldown: last withdrawal timestamp
let lastWithdrawalTime = 0;
const WITHDRAWAL_COOLDOWN_MS = 60 * 1000; // 1 minute between withdrawals

app.get('/api/admin/stats', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const allTxs = await safeDbRead(() => Transaction.find({}));
    const totalUsers = new Set(allTxs.map(t => t.wallet_address).filter(Boolean)).size;
    const completedTxs = allTxs.filter(t => t.status === 'COMPLETED');
    
    const volumeUSD = completedTxs.reduce((sum, t) => sum + (t.type === 'OFFRAMP' ? t.amount : (t.destination_amount || 0)), 0);
    const volumeNGN = completedTxs.reduce((sum, t) => sum + (t.type === 'ONRAMP' ? t.amount : (t.destination_amount || 0)), 0);

    // Get current balance from Switch
    const feesData = await switchApi('/developer/fees').catch(() => ({ data: { amount: 0 } }));

    res.json({
      totalUsers,
      allTransactions: allTxs.length,
      completedTransactions: completedTxs.length,
      totalVolumeUSD: volumeUSD,
      totalVolumeNGN: volumeNGN,
      developerFees: feesData.data || { amount: 0, currency: 'USD' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function isWithdrawalAllowed(address) {
  if (!WITHDRAWAL_ALLOWED_RECIPIENTS.length) return true;
  return WITHDRAWAL_ALLOWED_RECIPIENTS.includes((address || '').toLowerCase());
}

app.get('/api/admin/config', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    res.json({
      developer_recipient: DEVELOPER_RECIPIENT,
      developer_asset: DEVELOPER_WITHDRAW_ASSET,
      developer_fee: DEVELOPER_FEE,
      switch_base_url: SWITCH_BASE_URL,
      withdrawal_allowed_recipients: WITHDRAWAL_ALLOWED_RECIPIENTS,
      withdrawal_allowed: isWithdrawalAllowed(DEVELOPER_RECIPIENT)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const rows = await safeDbRead(() => Transaction.find({}).sort({ created_at: -1 }).limit(200));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time fix: retroactively tag old PAJ transactions that were saved with channel: 'BANK'
app.post('/api/admin/fix-paj-channels', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const allTxs = await safeDbRead(() => Transaction.find({}));
    const pajRefs = [];
    for (const tx of allTxs) {
      const isPaj = tx.channel === 'PAJ' ||
                    (tx.reference && tx.reference.startsWith('paj_')) ||
                    (tx.deposit_bank_name && tx.deposit_bank_name.toLowerCase().includes('paj'));
      if (isPaj && tx.channel !== 'PAJ') {
        await safeDbWrite(() => Transaction.updateOne({ _id: tx._id }, { channel: 'PAJ' }));
        pajRefs.push(tx.reference);
      }
    }
    res.json({ success: true, fixed: pajRefs.length, references: pajRefs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/users', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const txs = await safeDbRead(() => Transaction.find({}));
    const userMap = {};
    
    txs.forEach(t => {
      const id = t.wallet_address || 'unknown';
      if (!userMap[id]) {
        userMap[id] = { id, total_volume: 0, total_volume_ngn: 0, tx_count: 0, created_at: t.created_at };
      }
      if (t.status === 'COMPLETED') {
        userMap[id].total_volume += (t.type === 'OFFRAMP' ? t.amount : (t.destination_amount || 0));
        userMap[id].total_volume_ngn += (t.type === 'ONRAMP' ? t.amount : (t.destination_amount || 0));
      }
      userMap[id].tx_count++;
      if (t.created_at < userMap[id].created_at) userMap[id].created_at = t.created_at;
    });

    const users = Object.values(userMap).sort((a, b) => b.total_volume - a.total_volume);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Withdrawal OTP ───
app.post('/api/admin/withdraw/otp', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const otp = generateOTP();
    console.log(`[OTP] Withdrawal code generated: ${otp}`); 
    storeOTP('withdraw', otp);
    const maskedRecipient = DEVELOPER_RECIPIENT.slice(0, 6) + '...' + DEVELOPER_RECIPIENT.slice(-6);

    const emailText = `Velcro Admin — Withdrawal OTP\n\nCode: ${otp}\nRecipient: ${DEVELOPER_RECIPIENT}\nExpires in 5 minutes.\n\nIf you did not request this, change your admin password immediately.`;
    const emailHtml = `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;"><h2 style="color:#0D0D59;margin-bottom:8px;">Velcro Admin</h2><p style="color:#64748b;font-size:14px;">Withdrawal OTP</p><div style="background:#f4f7fe;padding:16px;border-radius:8px;text-align:center;margin:16px 0;"><div style="font-size:32px;font-weight:700;color:#0D0D59;letter-spacing:4px;">${otp}</div><p style="font-size:12px;color:#94a3b8;margin-top:8px;">Expires in 5 minutes</p></div><p style="font-size:13px;color:#64748b;">Recipient: <code>${DEVELOPER_RECIPIENT}</code></p><p style="font-size:12px;color:#dc2626;margin-top:12px;">If you did not request this, change your admin password immediately.</p></div>`;

    const mailResult = await sendMail('Velcro Admin — Withdrawal OTP', emailHtml, emailText);
    auditLog('WITHDRAW_OTP_SENT', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, emailSent: mailResult.sent });

    res.json({
      success: true,
      message: mailResult.sent
        ? 'OTP sent to your admin email. Check your inbox.'
        : 'OTP generated. (Email not configured — check server logs for the code.)',
      emailConfigured: mailResult.sent
    });
  } catch (err) {
    console.error('[WITHDRAW OTP] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/withdraw', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const { asset, otp } = req.body;

    // SECURITY: Verify OTP
    const otpCheck = verifyOTP('withdraw', otp);
    if (!otpCheck.valid) {
      auditLog('WITHDRAW_BLOCKED_OTP', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, reason: otpCheck.reason });
      return res.status(403).json({ success: false, error: otpCheck.reason });
    }

    // SECURITY: Cooldown between withdrawals
    const now = Date.now();
    if (now - lastWithdrawalTime < WITHDRAWAL_COOLDOWN_MS) {
      const waitSec = Math.ceil((WITHDRAWAL_COOLDOWN_MS - (now - lastWithdrawalTime)) / 1000);
      auditLog('WITHDRAW_BLOCKED_COOLDOWN', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT });
      return res.status(429).json({ success: false, error: `Please wait ${waitSec}s before another withdrawal.` });
    }

    // SECURITY: Block withdrawal if recipient is not whitelisted
    if (!isWithdrawalAllowed(DEVELOPER_RECIPIENT)) {
      console.error('[WITHDRAW] BLOCKED — Recipient not in whitelist:', DEVELOPER_RECIPIENT);
      auditLog('WITHDRAW_BLOCKED_WHITELIST', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT });
      return res.status(403).json({
        success: false,
        error: 'Withdrawal blocked — recipient address is not in the allowed whitelist.',
        recipient: DEVELOPER_RECIPIENT,
        allowed: WITHDRAWAL_ALLOWED_RECIPIENTS
      });
    }

    const payload = {
      asset: asset || DEVELOPER_WITHDRAW_ASSET,
      beneficiary: { wallet_address: DEVELOPER_RECIPIENT }
    };
    console.log('[WITHDRAW] Request payload:', JSON.stringify(payload));
    auditLog('WITHDRAW_INITIATED', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, asset: payload.asset });

    // Email notification: withdrawal initiated
    await sendMail(
      'Velcro — Withdrawal Initiated',
      `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;"><h2 style="color:#0D0D59;">Withdrawal Initiated</h2><p>A fee withdrawal has been initiated to:</p><code>${DEVELOPER_RECIPIENT}</code><p style="color:#64748b;font-size:12px;margin-top:12px;">Time: ${new Date().toISOString()}</p></div>`,
      `Velcro Admin — Withdrawal Initiated\n\nRecipient: ${DEVELOPER_RECIPIENT}\nTime: ${new Date().toISOString()}\n\nIf this was not you, change your password immediately.`
    );

    const data = await switchApi('/developer/withdraw', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    console.log('[WITHDRAW] Switch response:', JSON.stringify(data));

    if (data.success) {
      lastWithdrawalTime = Date.now();
      auditLog('WITHDRAW_SUCCESS', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, hash: data.data?.hash });

      // Email notification: withdrawal success
      await sendMail(
        'Velcro — Withdrawal Successful',
        `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #bbf7d0;border-radius:12px;background:#f0fdf4;"><h2 style="color:#166534;">Withdrawal Successful</h2><p>Your fees have been withdrawn.</p><p><b>Hash:</b> <code>${data.data?.hash || 'N/A'}</code></p><p><b>Recipient:</b> <code>${DEVELOPER_RECIPIENT}</code></p></div>`,
        `Velcro Admin — Withdrawal Successful\n\nHash: ${data.data?.hash || 'N/A'}\nRecipient: ${DEVELOPER_RECIPIENT}\nTime: ${new Date().toISOString()}`
      );

      res.json({ success: true, data: data.data });
    } else {
      auditLog('WITHDRAW_FAILED', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, error: data.message });

      // Email notification: withdrawal failed
      await sendMail(
        'Velcro — Withdrawal Failed',
        `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;"><h2 style="color:#dc2626;">Withdrawal Failed</h2><p>Error: ${data.message || 'Unknown error'}</p><p><b>Recipient:</b> <code>${DEVELOPER_RECIPIENT}</code></p></div>`,
        `Velcro Admin — Withdrawal Failed\n\nError: ${data.message || 'Unknown error'}\nRecipient: ${DEVELOPER_RECIPIENT}\nTime: ${new Date().toISOString()}`
      );

      res.status(400).json({ success: false, error: data.message, raw: data });
    }
  } catch (err) {
    console.error('[WITHDRAW] Error:', err.message);
    auditLog('WITHDRAW_ERROR', { ip: req.adminClientIp, recipient: DEVELOPER_RECIPIENT, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Public settings (fee only)
app.get('/api/settings', async (req, res) => {
  const settings = loadSettings();
  res.json(successResponse({
    platform_fee: settings.platform_fee,
    buy_max_limit: settings.buy_max_limit,
    sell_min_limit: settings.sell_min_limit,
    sell_max_limit: settings.sell_max_limit
  }));
});

app.get('/api/admin/settings', adminAuth, async (req, res) => {
  const settings = loadSettings();
  res.json(settings);
});

app.get('/api/admin/debug/last-payload', adminAuth, async (req, res) => {
  try {
    const last = await Transaction.findOne().sort({ created_at: -1 });
    if (!last) return res.status(404).json({ error: 'No transactions found' });
    res.json(last);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', adminRateLimiter, adminAuth, async (req, res) => {
  try {
    const { platform_fee, buy_max_limit, sell_min_limit, sell_max_limit, paj_email } = req.body;
    const settings = loadSettings();
    if (buy_max_limit !== undefined) {
      const limit = parseInt(buy_max_limit, 10);
      if (Number.isNaN(limit) || limit < 1000 || limit > 10000000) {
        return res.status(400).json({ success: false, error: 'Buy max limit must be between 1,000 and 10,000,000' });
      }
      settings.buy_max_limit = limit;
    }
    if (sell_min_limit !== undefined) {
      const min = parseFloat(sell_min_limit);
      if (Number.isNaN(min) || min < 1 || min > 100000) {
        return res.status(400).json({ success: false, error: 'Sell min limit must be between 1 and 100,000' });
      }
      settings.sell_min_limit = min;
    }
    if (sell_max_limit !== undefined) {
      const max = parseFloat(sell_max_limit);
      if (Number.isNaN(max) || max < 10 || max > 1000000) {
        return res.status(400).json({ success: false, error: 'Sell max limit must be between 10 and 1,000,000' });
      }
      settings.sell_max_limit = max;
    }
    if (platform_fee !== undefined) {
      const fee = parseFloat(platform_fee);
      if (Number.isNaN(fee) || fee < 0 || fee > 10) {
        return res.status(400).json({ success: false, error: 'Fee must be between 0 and 10' });
      }
      settings.platform_fee = fee;
    }
    if (paj_email !== undefined) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(paj_email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
      }
      settings.paj_email = paj_email;
    }
    if (saveSettings(settings)) {
      console.log('✅ Settings updated:', JSON.stringify(settings));
      auditLog('SETTINGS_UPDATED', { ip: req.adminClientIp, changes: { platform_fee, buy_max_limit, sell_min_limit, sell_max_limit, paj_email } });
      res.json({ success: true, ...settings });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save settings' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PAJ Ramp Routes ───

app.get('/api/paj/assets', (req, res) => {
  if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
  res.json(successResponse(pajModule.getAssets()));
});

app.get('/api/paj/rate', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const rate = await pajModule.getPajRate();
    res.json(successResponse(rate));
  } catch (err) { next(err); }
});

app.post('/api/paj/value', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const { fiatAmount, mint } = req.body;
    if (!fiatAmount || !mint) return res.status(400).json(errorResponse('fiatAmount and mint are required'));
    const value = await pajModule.getTokenValue(fiatAmount, mint);
    res.json(successResponse(value));
  } catch (err) { next(err); }
});

app.post('/api/paj/initiate', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const { fiatAmount, recipient, mint } = req.body;
    if (!fiatAmount || !recipient || !mint) {
      return res.status(400).json(errorResponse('fiatAmount, recipient, and mint are required'));
    }
    const order = await pajModule.createOnrampOrder({ 
      fiatAmount, 
      recipient, 
      mint
    });
    const d = order || {};
    const assetInfo = pajModule.PAJ_ASSETS.find(a => a.mint === mint);
    await safeDbWrite(() => Transaction.create({
      reference: d.id || `paj_${Date.now()}`,
      type: 'ONRAMP',
      status: d.status || 'AWAITING_DEPOSIT',
      country: 'NG',
      currency: 'NGN',
      asset: assetInfo ? assetInfo.symbol : 'SOL',
      channel: 'PAJ',
      amount: fiatAmount,
      deposit_bank_name: d.bank || 'PAJ Partner Bank',
      deposit_account_number: d.accountNumber || null,
      deposit_account_name: d.accountName || null,
      wallet_address: recipient,
      meta: JSON.stringify(d)
    }));
    res.json(successResponse(order));
  } catch (err) { next(err); }
});

app.post('/api/paj/sell', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const { fiatAmount, mint, bank, accountNumber } = req.body;
    if (!fiatAmount || !mint || !bank || !accountNumber) {
      return res.status(400).json(errorResponse('fiatAmount, mint, bank, and accountNumber are required'));
    }
    const order = await pajModule.createOfframpOrder({ 
      fiatAmount, 
      mint, 
      bank, 
      accountNumber
    });
    const d = order || {};
    const assetInfo = pajModule.PAJ_ASSETS.find(a => a.mint === mint);
    await safeDbWrite(() => Transaction.create({
      reference: d.id || `paj_${Date.now()}`,
      type: 'OFFRAMP',
      status: d.status || 'AWAITING_DEPOSIT',
      country: 'NG',
      currency: 'NGN',
      asset: assetInfo ? assetInfo.symbol : 'SOL',
      channel: 'PAJ',
      amount: fiatAmount,
      deposit_address: d.address || null,
      beneficiary: JSON.stringify({ bank, accountNumber, holder_name: d.accountName || 'Customer' }),
      meta: JSON.stringify(d)
    }));
    res.json(successResponse(order));
  } catch (err) { next(err); }
});

app.get('/api/paj/banks', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const banks = await pajModule.getBanks();
    res.json(successResponse(banks));
  } catch (err) { next(err); }
});

app.post('/api/paj/resolve', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const { bank, accountNumber } = req.body;
    if (!bank || !accountNumber) return res.status(400).json(errorResponse('bank and accountNumber are required'));
    const resolved = await pajModule.resolveBankAccount(bank, accountNumber);
    res.json(successResponse(resolved));
  } catch (err) { next(err); }
});

app.get('/api/paj/status', async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
    const { id } = req.query;
    if (!id) return res.status(400).json(errorResponse('id is required'));
    const tx = await pajModule.getTransactionStatus(id);

    // Sync PAJ status back to local DB so admin dashboard shows correct status
    try {
      const d = tx || {};
      const update = { status: d.status || 'AWAITING_DEPOSIT', meta: JSON.stringify(d) };
      if (d.signature || d.hash) update.hash = d.signature || d.hash;
      if (d.recipient) update.wallet_address = d.recipient;
      await safeDbWrite(() => Transaction.findOneAndUpdate(
        { $or: [{ reference: id }, { switch_reference: id }] },
        update
      ));
    } catch (dbErr) {
      console.log('PAJ status DB sync failed (non-critical):', dbErr.message);
    }

    res.json(successResponse(tx));
  } catch (err) { next(err); }
});

app.get('/api/paj/session', (req, res) => {
  if (!pajModule) return res.status(503).json(errorResponse('PAJ module not available'));
  res.json(successResponse(pajModule.getSessionStatus()));
});

// PAJ Webhook handler
app.post('/webhook/paj', async (req, res) => {
  try {
    const payload = req.body;
    console.log('[PAJ Webhook]', JSON.stringify(payload));
    const txId = payload.id || (payload.data && payload.data.id) || payload.reference || payload.orderId;
    const status = payload.status || (payload.data && payload.data.status) || payload.state;
    const hash = payload.signature || payload.hash || (payload.data && (payload.data.signature || payload.data.hash));
    const recipient = payload.recipient || (payload.data && payload.data.recipient);
    if (txId && status) {
      const update = { status: status.toUpperCase(), meta: JSON.stringify(payload) };
      if (hash) update.hash = hash;
      if (recipient) update.wallet_address = recipient;
      const result = await safeDbWrite(() => Transaction.findOneAndUpdate(
        { $or: [{ reference: txId }, { switch_reference: txId }] },
        update,
        { new: true }
      ));
      if (result) {
        console.log(`✅ PAJ webhook updated tx ${txId} → ${status}`);
      } else {
        console.log(`⚠️ PAJ webhook: no tx found for ${txId}`);
      }
    } else {
      console.log('⚠️ PAJ webhook: missing id or status', { txId, status });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('PAJ webhook error:', err.message);
    res.json({ received: true }); // Always acknowledge
  }
});

// ─── Admin PAJ Session Routes ───
app.post('/api/admin/paj/initiate', adminRateLimiter, adminAuth, async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json({ error: 'PAJ module not available' });
    auditLog('PAJ_INITIATE', { ip: req.adminClientIp });
    const result = await pajModule.initiateSession();
    res.json(result);
  } catch (err) { next(err); }
});

app.post('/api/admin/paj/verify', adminRateLimiter, adminAuth, async (req, res, next) => {
  try {
    if (!pajModule) return res.status(503).json({ error: 'PAJ module not available' });
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ error: 'OTP is required' });
    const result = await pajModule.verifySession(otp);
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Static Files ───
const adminPath = path.join(__dirname, 'admin');
if (fs.existsSync(adminPath)) {
  app.use('/admin', express.static(adminPath));
}

const staticPath = path.join(__dirname, 'public');
if (fs.existsSync(staticPath)) {
  app.use(express.static(staticPath));
  app.get('*', (req, res) => {
    // If it starts with /admin, don't redirect to public index
    if (req.path.startsWith('/admin')) {
      return res.sendFile(path.join(adminPath, 'index.html'));
    }
    res.sendFile(path.join(staticPath, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  const status = err.response?.status || err.status || 500;
  const message = err.response?.data?.message || err.message || 'Internal Server Error';
  console.error(`[${req.method}] ${req.path} Error (${status}):`, message);
  res.status(status).json({
    status: 'ERROR',
    message: message
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Velcro Backend v1.2.0 running at: http://localhost:${PORT}`);
  console.log(`🔌 Switch Base URL: ${SWITCH_BASE_URL}`);
  console.log(`💰 Developer Fee: ${getPlatformFee()}%`);
  console.log(`🌍 Supported: NG (NGN) only`);
  console.log(`🍃 Database: MongoDB\n`);
});

module.exports = app;
