require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/velcro_ramp';

const transactionSchema = new mongoose.Schema({
  reference: String,
  type: String,
  status: String,
  amount: Number,
  asset: String,
  meta: String,
  created_at: { type: Date, default: Date.now }
});

const Transaction = mongoose.model('Transaction', transactionSchema);

async function checkLast() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected.');
    const last = await Transaction.findOne().sort({ created_at: -1 });
    if (last) {
      console.log('--- Last Transaction ---');
      console.log('Reference:', last.reference);
      console.log('Type:', last.type);
      console.log('Status:', last.status);
      console.log('Amount:', last.amount);
      console.log('Asset:', last.asset);
      console.log('Meta Payload:');
      try {
        console.log(JSON.stringify(JSON.parse(last.meta), null, 2));
      } catch (e) {
        console.log(last.meta);
      }
    } else {
      console.log('No transactions found.');
    }
    await mongoose.connection.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

checkLast();
