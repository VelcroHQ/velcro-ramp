const fs = require('fs');
const path = require('path');

// Try to load paj_ramp SDK
let pajSdk = null;
try {
  pajSdk = require('paj_ramp');
} catch (err) {
  console.error('⚠️  paj_ramp SDK not available:', err.message);
}

const PAJ_API_KEY = process.env.PAJ_API_KEY;
const PAJ_ENV = process.env.PAJ_ENV || 'production';
const SESSION_PATH = path.join(__dirname, 'paj-session.json');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function getPajEmail() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (settings.paj_email) return settings.paj_email;
    }
  } catch (err) {}
  return process.env.PAJ_EMAIL || 'paj@usevelcro.com';
}

// Initialize PAJ SDK environment
if (pajSdk) {
  try {
    const env = PAJ_ENV === 'production' ? pajSdk.Environment.Production : pajSdk.Environment.Staging;
    pajSdk.initializeSDK(env);
    console.log(`✅ PAJ SDK initialized (${PAJ_ENV})`);
  } catch (err) {
    console.error('⚠️  PAJ SDK init failed:', err.message);
  }
}

// Token mint addresses on Solana
const PAJ_ASSETS = [
  {
    id: 'sol',
    symbol: 'SOL',
    name: 'Solana',
    mint: 'So11111111111111111111111111111111111111112',
    chain: 'SOLANA',
    logo: '/logos/solana.png'
  },
  {
    id: 'jup',
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    chain: 'SOLANA',
    logo: '/logos/jup.png'
  },
  {
    id: 'bonk',
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/28600/small/bonk.jpg'
  },
  {
    id: 'wif',
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg'
  },
  {
    id: 'pyth',
    symbol: 'PYTH',
    name: 'Pyth Network',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/31924/small/pyth.png'
  },
  {
    id: 'render',
    symbol: 'RENDER',
    name: 'Render',
    mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/11636/small/rndr.png'
  },
  {
    id: 'ray',
    symbol: 'RAY',
    name: 'Raydium',
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/13928/small/PSigc4ie_400x400.jpg'
  },
  {
    id: 'w',
    symbol: 'W',
    name: 'Wormhole',
    mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/35087/small/womrhole_logo_full_color_rgb_2000px_72ppi_fb766ac85a.png'
  },
  {
    id: 'popcat',
    symbol: 'POPCAT',
    name: 'POPCAT',
    mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/33760/small/image.jpg'
  },
  {
    id: 'mew',
    symbol: 'MEW',
    name: 'cat in a dogs world',
    mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/34658/small/MEW.png'
  },
  {
    id: 'michi',
    symbol: 'MICHI',
    name: 'michi',
    mint: '5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/36791/small/michi.png'
  },
  {
    id: 'shdw',
    symbol: 'SHDW',
    name: 'Shadow Token',
    mint: 'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/22271/small/Property_1_Color.png'
  },
  {
    id: 'orca',
    symbol: 'ORCA',
    name: 'Orca',
    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/17547/small/Orca_Logo.png'
  },
  {
    id: 'samo',
    symbol: 'SAMO',
    name: 'Samoyedcoin',
    mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    chain: 'SOLANA',
    logo: 'https://assets.coingecko.com/coins/images/15051/small/IXeEj5e.png'
  },
  {
    id: 'usdg',
    symbol: 'USDG',
    name: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    chain: 'SOLANA',
    logo: '/logos/usdg.png'
  }
];

function loadSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load PAJ session:', err.message);
  }
  return null;
}

function saveSession(session) {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
    return true;
  } catch (err) {
    console.error('Failed to save PAJ session:', err.message);
    return false;
  }
}

function isSessionValid(session) {
  if (!session || !session.token) return false;
  if (session.expiresAt) {
    return new Date(session.expiresAt) > new Date();
  }
  return true;
}

// Initiate PAJ session (sends OTP)
async function initiateSession() {
  if (!pajSdk || !PAJ_API_KEY) {
    throw new Error('PAJ SDK not available or API key missing');
  }
  try {
    const email = getPajEmail();
    const result = await pajSdk.initiate(email, PAJ_API_KEY);
    return { success: true, email, message: 'OTP sent to email' };
  } catch (err) {
    throw new Error('PAJ initiate failed: ' + err.message);
  }
}

// Verify PAJ session with OTP
async function verifySession(otp) {
  if (!pajSdk || !PAJ_API_KEY) {
    throw new Error('PAJ SDK not available or API key missing');
  }
  try {
    const device = {
      uuid: 'velcro-server-' + Date.now(),
      device: 'Server',
      os: 'Linux',
      browser: 'Node.js',
      ip: '127.0.0.1'
    };
    const result = await pajSdk.verify(getPajEmail(), otp, device, PAJ_API_KEY);
    const session = {
      token: result.token,
      recipient: result.recipient,
      isActive: result.isActive,
      expiresAt: result.expiresAt,
      createdAt: new Date().toISOString()
    };
    saveSession(session);
    return { success: true, session };
  } catch (err) {
    throw new Error('PAJ verification failed: ' + err.message);
  }
}

// Get valid session token (initiates if needed)
async function getSessionToken() {
  const session = loadSession();
  if (isSessionValid(session)) {
    return session.token;
  }
  throw new Error('PAJ session expired. Please initiate and verify OTP via admin dashboard.');
}

// Get PAJ rates (public endpoint, no API key needed)
async function getPajRate() {
  if (!pajSdk) {
    throw new Error('PAJ SDK not available');
  }
  try {
    const result = await pajSdk.getAllRate();
    return {
      onramp: result?.onRampRate || null,
      offramp: result?.offRampRate || null
    };
  } catch (err) {
    throw new Error('PAJ rate fetch failed: ' + err.message);
  }
}

// Get token value (fiat → token)
async function getTokenValue(fiatAmount, mint) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getTokenValue(
      { amount: fiatAmount, mint, currency: pajSdk.Currency.NGN },
      token
    );
    return result;
  } catch (err) {
    throw new Error('PAJ token value fetch failed: ' + err.message);
  }
}

// Get fiat value (token amount → fiat)
async function getFiatValue(amount, mint) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getFiatValue(
      { amount, mint, currency: pajSdk.Currency.NGN },
      token
    );
    return result;
  } catch (err) {
    throw new Error('PAJ fiat value fetch failed: ' + err.message);
  }
}

// Get banks list
async function getBanks() {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getBanks(token);
    return result;
  } catch (err) {
    throw new Error('PAJ fetch banks failed: ' + err.message);
  }
}

// Resolve bank account
async function resolveBankAccount(bankId, accountNumber) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.resolveBankAccount(token, bankId, accountNumber);
    return result;
  } catch (err) {
    throw new Error('PAJ resolve account failed: ' + err.message);
  }
}

// Create onramp order
async function createOnrampOrder({ fiatAmount, recipient, mint, webhookURL }) {
  const token = await getSessionToken();
  try {
    const payload = {
      fiatAmount: Number(fiatAmount),
      currency: pajSdk.Currency.NGN,
      recipient: recipient,
      mint: mint,
      chain: pajSdk.Chain.SOLANA,
      webhookURL: webhookURL || `${process.env.CALLBACK_URL || ''}/webhook/paj`
    };

    // LOG THE PAYLOAD (Debug)
    console.log('[PAJ Onramp] Creating order with payload:', JSON.stringify(payload));

    const result = await pajSdk.createOnrampOrder(payload, token);
    return result;
  } catch (err) {
    throw new Error('PAJ onramp order failed: ' + err.message);
  }
}

// Create offramp order
async function createOfframpOrder({ bank, accountNumber, mint, fiatAmount, webhookURL }) {
  const token = await getSessionToken();
  try {
    const payload = {
      bank: bank,
      accountNumber: String(accountNumber),
      currency: pajSdk.Currency.NGN,
      fiatAmount: Number(fiatAmount),
      mint: mint,
      chain: pajSdk.Chain.SOLANA,
      webhookURL: webhookURL || `${process.env.CALLBACK_URL || ''}/webhook/paj`
    };

    console.log('[PAJ Offramp] Creating order with payload:', JSON.stringify(payload));

    const result = await pajSdk.createOfframpOrder(payload, token);
    return result;
  } catch (err) {
    throw new Error('PAJ offramp order failed: ' + err.message);
  }
}

// Get transaction status
async function getTransactionStatus(txId) {
  const token = await getSessionToken();
  try {
    const result = await pajSdk.getTransaction(token, txId);
    return result;
  } catch (err) {
    throw new Error('PAJ transaction fetch failed: ' + err.message);
  }
}

// Get PAJ assets list
function getAssets() {
  return PAJ_ASSETS;
}

// Get session status
function getSessionStatus() {
  const session = loadSession();
  return {
    hasSession: !!session,
    isValid: isSessionValid(session),
    email: getPajEmail(),
    expiresAt: session?.expiresAt || null
  };
}

module.exports = {
  initiateSession,
  verifySession,
  getSessionToken,
  getPajRate,
  getTokenValue,
  getFiatValue,
  getBanks,
  resolveBankAccount,
  createOnrampOrder,
  createOfframpOrder,
  getTransactionStatus,
  getAssets,
  getSessionStatus,
  PAJ_ASSETS
};
