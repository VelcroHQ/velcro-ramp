// Use native fetch (Node 18+)
require('dotenv').config();

async function testSwitch() {
  const url = 'https://api.onswitch.xyz/asset';
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-service-key': process.env.SWITCH_SERVICE_KEY
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
