const fs = require('fs');

async function testSwitch() {
  const envContent = fs.readFileSync('.env', 'utf8');
  const keyMatch = envContent.match(/SWITCH_SERVICE_KEY=([^\s]+)/);
  if (!keyMatch) {
    console.error('SWITCH_SERVICE_KEY not found in .env');
    return;
  }
  const key = keyMatch[1];
  console.log('Testing key:', key.slice(0, 5) + '...');

  const url = 'https://api.onswitch.xyz/asset';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-service-key': key
  };

  try {
    const res = await fetch(url, { headers });
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testSwitch();
