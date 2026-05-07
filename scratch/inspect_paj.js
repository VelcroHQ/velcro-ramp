const pajSdk = require('paj_ramp');
console.log('PAJ SDK Keys:', Object.keys(pajSdk));
if (pajSdk.createOfframpOrder) console.log('Found createOfframpOrder');
if (pajSdk.createSellOrder) console.log('Found createSellOrder');
if (pajSdk.offramp) console.log('Found offramp');
