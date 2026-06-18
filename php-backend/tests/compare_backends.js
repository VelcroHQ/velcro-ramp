/**
 * Compare Node.js backend (port 3000) vs PHP backend (port 8002).
 *
 * Usage: node tests/compare_backends.js
 *
 * This script hits read-only and validation endpoints on both backends
 * and reports differences. It does NOT create real transactions.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load root .env for ADMIN_PASSWORD without exposing values
const rootEnvPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(rootEnvPath)) {
  const envContent = fs.readFileSync(rootEnvPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const NODE_BASE = 'http://localhost:3000';
const PHP_BASE = 'http://localhost:8002';

let passed = 0;
let failed = 0;

function request(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqHeaders = { ...headers };
    if (body) reqHeaders['Content-Type'] = 'application/json';
    const req = http.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.pathname + opts.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function compareShape(path, node, php, keys) {
  for (const key of keys) {
    const n = node[key];
    const p = php[key];
    const nType = typeof n;
    const pType = typeof p;
    if (nType !== pType) {
      console.log(`  ❌ ${path}: type mismatch for "${key}" (node=${nType}, php=${pType})`);
      return false;
    }
  }
  return true;
}

async function testCase(name, nodeUrl, phpUrl, method = 'GET', body = null, checks = null, headers = {}) {
  try {
    const nodeRes = await request(method, nodeUrl, body, headers);
    const phpRes = await request(method, phpUrl, body, headers);

    const nodeStatus = nodeRes.status;
    const phpStatus = phpRes.status;

    if (nodeStatus !== phpStatus) {
      console.log(`❌ ${name}: status mismatch (node=${nodeStatus}, php=${phpStatus})`);
      console.log(`   node: ${JSON.stringify(nodeRes.body).slice(0, 200)}`);
      console.log(`   php:  ${JSON.stringify(phpRes.body).slice(0, 200)}`);
      failed++;
      return;
    }

    if (checks) {
      const ok = checks(nodeRes.body, phpRes.body);
      if (ok) {
        console.log(`✅ ${name}`);
        passed++;
      } else {
        console.log(`❌ ${name}: custom check failed`);
        console.log(`   node: ${JSON.stringify(nodeRes.body).slice(0, 300)}`);
        console.log(`   php:  ${JSON.stringify(phpRes.body).slice(0, 300)}`);
        failed++;
      }
      return;
    }

    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}: error - ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('Comparing Node vs PHP backends...\n');

  await testCase(
    'GET /api/health',
    `${NODE_BASE}/api/health`,
    `${PHP_BASE}/api/health`,
    'GET',
    null,
    (n, p) => {
      const ok = n.success === true && p.success === true && n.data && p.data;
      if (!ok) return false;
      return compareShape('/api/health', n.data, p.data, ['service', 'db', 'dbConnected']);
    }
  );

  await testCase(
    'GET /api/settings',
    `${NODE_BASE}/api/settings`,
    `${PHP_BASE}/api/settings`,
    'GET',
    null,
    (n, p) => {
      const ok = n.success && p.success && n.data && p.data;
      if (!ok) return false;
      return compareShape('/api/settings', n.data, p.data, [
        'platform_fee', 'buy_max_limit', 'sell_min_limit', 'sell_max_limit',
        'paj_usdt_enabled', 'paj_usdc_enabled'
      ]);
    }
  );

  await testCase(
    'GET /api/assets',
    `${NODE_BASE}/api/assets`,
    `${PHP_BASE}/api/assets`,
    'GET',
    null,
    (n, p) => {
      const ok = n.success && p.success && n.data && p.data;
      if (!ok) return false;
      return compareShape('/api/assets', n.data, p.data, ['offramp', 'onramp', 'blockchains']);
    }
  );

  await testCase(
    'GET /api/rates?country=NG&currency=NGN',
    `${NODE_BASE}/api/rates?country=NG&currency=NGN`,
    `${PHP_BASE}/api/rates?country=NG&currency=NGN`,
    'GET',
    null,
    (n, p) => n.success === p.success
  );

  await testCase(
    'GET /api/institutions?country=NG&currency=NGN&channel=BANK',
    `${NODE_BASE}/api/institutions?country=NG&currency=NGN&channel=BANK`,
    `${PHP_BASE}/api/institutions?country=NG&currency=NGN&channel=BANK`,
    'GET',
    null,
    (n, p) => n.success === p.success
  );

  await testCase(
    'GET /api/requirements?direction=OFFRAMP&country=NG',
    `${NODE_BASE}/api/requirements?direction=OFFRAMP&country=NG`,
    `${PHP_BASE}/api/requirements?direction=OFFRAMP&country=NG`,
    'GET',
    null,
    (n, p) => n.success === p.success
  );

  await testCase(
    'POST /api/rate',
    `${NODE_BASE}/api/rate`,
    `${PHP_BASE}/api/rate`,
    'POST',
    { direction: 'OFFRAMP', country: 'NG', asset: 'USDT' },
    (n, p) => n.success === p.success
  );

  await testCase(
    'POST /api/initiate (validation error)',
    `${NODE_BASE}/api/initiate`,
    `${PHP_BASE}/api/initiate`,
    'POST',
    {},
    (n, p) => n.success === false && p.success === false && n.status === 400 && p.status === 400
  );

  await testCase(
    'POST /api/cancel (validation error)',
    `${NODE_BASE}/api/cancel`,
    `${PHP_BASE}/api/cancel`,
    'POST',
    {},
    (n, p) => n.success === false && p.success === false
  );

  await testCase(
    'GET /api/paj/assets',
    `${NODE_BASE}/api/paj/assets`,
    `${PHP_BASE}/api/paj/assets`,
    'GET',
    null,
    (n, p) => {
      const ok = n.success && p.success && Array.isArray(n.data) && Array.isArray(p.data);
      if (!ok) return false;
      return n.data.length === p.data.length;
    }
  );

  await testCase(
    'GET /api/paj/rate',
    `${NODE_BASE}/api/paj/rate`,
    `${PHP_BASE}/api/paj/rate`,
    'GET',
    null,
    (n, p) => typeof n.success === 'boolean' && typeof p.success === 'boolean'
  );

  await testCase(
    'GET /api/paj/banks',
    `${NODE_BASE}/api/paj/banks`,
    `${PHP_BASE}/api/paj/banks`,
    'GET',
    null,
    (n, p) => typeof n.success === 'boolean' && typeof p.success === 'boolean'
  );

  await testCase(
    'GET /api/admin/config (no auth)',
    `${NODE_BASE}/api/admin/config`,
    `${PHP_BASE}/api/admin/config`,
    'GET',
    null,
    (n, p) => n.error === 'Unauthorized' && p.error === 'Unauthorized'
  );

  // Admin auth test - requires password from env
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    await testCase(
      'GET /api/admin/config (with auth)',
      `${NODE_BASE}/api/admin/config`,
      `${PHP_BASE}/api/admin/config`,
      'GET',
      null,
      (n, p) => {
        return n.developer_recipient && p.developer_recipient &&
               n.developer_fee === p.developer_fee &&
               n.switch_base_url === p.switch_base_url;
      },
      { Authorization: 'Bearer ' + adminPassword }
    );
  } else {
    console.log('⚠️  Skipping admin auth test: ADMIN_PASSWORD not in env');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
