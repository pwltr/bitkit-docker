const express = require('express');
const { encode } = require('lnurl');
const QRCode = require('qrcode');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

// Connection configuration
const BITCOIN_RPC_HOST = process.env.BITCOIN_RPC_HOST || 'host.docker.internal';
const BITCOIN_RPC_PORT = process.env.BITCOIN_RPC_PORT || '18443';
const BITCOIN_RPC_USER = process.env.BITCOIN_RPC_USER || 'polaruser';
const BITCOIN_RPC_PASS = process.env.BITCOIN_RPC_PASS || 'polarpass';

const LND_REST_HOST = process.env.LND_REST_HOST || 'host.docker.internal';
const LND_REST_PORT = process.env.LND_REST_PORT || '8080';
const LND_MACAROON_PATH = process.env.LND_MACAROON_PATH;
const LND_TLS_CERT_PATH = process.env.LND_TLS_CERT_PATH;

// Initialize SQLite database
const db = new sqlite3.Database('/data/lnurl.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    k1 TEXT UNIQUE,
    amount_sats INTEGER,
    used BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    amount_sats INTEGER,
    description TEXT,
    payment_hash TEXT,
    paid BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Bitcoin RPC helper
async function bitcoinRPC(method, params = []) {
  const response = await fetch(`http://${BITCOIN_RPC_HOST}:${BITCOIN_RPC_PORT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${BITCOIN_RPC_USER}:${BITCOIN_RPC_PASS}`).toString('base64')
    },
    body: JSON.stringify({
      jsonrpc: '1.0',
      id: 'lnurl',
      method,
      params
    })
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`Bitcoin RPC error: ${data.error.message}`);
  }
  return data.result;
}

// LND REST API helper with Macaroon authentication
async function lndREST(endpoint, method = 'POST', body = null) {
  const url = `https://${LND_REST_HOST}:${LND_REST_PORT}${endpoint}`;

  // Read macaroon for authentication
  let macaroon = '';
  try {
    if (LND_MACAROON_PATH && fs.existsSync(LND_MACAROON_PATH)) {
      macaroon = fs.readFileSync(LND_MACAROON_PATH).toString('hex');
    }
  } catch (error) {
    console.warn('Could not read macaroon:', error.message);
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = (method === 'POST' && body) ? JSON.stringify(body) : '';

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false
    };

    // Add Content-Length header only for POST requests with body
    if (method === 'POST' && postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    // Add macaroon authentication if available
    if (macaroon) {
      options.headers['Grpc-Metadata-macaroon'] = macaroon;
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (!data || data.trim() === '') {
            reject(new Error(`Empty response from LND REST API`));
            return;
          }

          const jsonData = JSON.parse(data);

          if (res.statusCode >= 400) {
            reject(new Error(`LND REST error: ${jsonData.message || res.statusMessage}`));
          } else {
            resolve(jsonData);
          }
        } catch (error) {
          reject(new Error(`Failed to parse LND response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`LND REST request failed: ${error.message}`));
    });

    if (method === 'POST' && postData) {
      req.write(postData);
    }

    req.end();
  });
}

// LND connection method
async function callLND(method, params = {}) {
  try {
    const endpoint = `/v1/${method}`;
    // Use GET for getinfo, POST for other methods
    const httpMethod = method === 'getinfo' ? 'GET' : 'POST';
    return await lndREST(endpoint, httpMethod, params);
  } catch (error) {
    console.log(`LND REST API failed for ${method}:`, error.message);
    throw error;
  }
}



// Health check to verify connections
async function checkConnections() {
  const result = { bitcoin: false, lnd: false, error: null, blockHeight: null, nodeInfo: null };

  // Test Bitcoin connection
  try {
    const blockHeight = await bitcoinRPC('getblockcount');
    console.log(`✅ Connected to Bitcoin node at block ${blockHeight}`);
    result.bitcoin = true;
    result.blockHeight = blockHeight;
  } catch (error) {
    console.error('❌ Bitcoin connection failed:', error.message);
    result.error = `Bitcoin: ${error.message}`;
  }

  // Test LND connection
  try {
    console.log(`Attempting LND connection...`);
    console.log(`REST: ${LND_REST_HOST}:${LND_REST_PORT}`);

    // Try getinfo using our LND method
    const nodeInfo = await callLND('getinfo');
    console.log(`✅ Connected to LND node: ${nodeInfo.identity_pubkey}`);
    result.lnd = true;
    result.nodeInfo = nodeInfo;

  } catch (error) {
    console.error('❌ LND connection failed:', error.message);

    // Additional debugging
    console.log('🔍 Debug info:');
    console.log(`- REST URL: https://${LND_REST_HOST}:${LND_REST_PORT}/v1/getinfo`);
    console.log(`- Macaroon path: ${LND_MACAROON_PATH}`);
    console.log(`- Macaroon exists: ${LND_MACAROON_PATH ? fs.existsSync(LND_MACAROON_PATH) : 'N/A'}`);
    console.log(`- TLS cert path: ${LND_TLS_CERT_PATH}`);
    console.log(`- TLS cert exists: ${LND_TLS_CERT_PATH ? fs.existsSync(LND_TLS_CERT_PATH) : 'N/A'}`);

    if (!result.error) {
      result.error = `LND: ${error.message}`;
    } else {
      result.error += `, LND: ${error.message}`;
    }
  }

  return result;
}

// LNURL-withdraw endpoint
app.get('/withdraw', async (req, res) => {
  try {
    const k1 = crypto.randomBytes(32).toString('hex');
    const withdrawId = crypto.randomBytes(16).toString('hex');

    // Store withdrawal request
    db.run(
      'INSERT INTO withdrawals (id, k1, amount_sats) VALUES (?, ?, ?)',
      [withdrawId, k1, 10000] // Default 10,000 sats
    );

    const withdrawUrl = `${DOMAIN}/withdraw/callback?k1=${k1}`;

    res.json({
      tag: 'withdrawRequest',
      callback: withdrawUrl,
      k1: k1,
      defaultDescription: 'LNURL Withdraw Test',
      minWithdrawable: 1000, // 1 sat minimum
      maxWithdrawable: 100000000 // 100,000 sats maximum (in millisats)
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-withdraw callback
app.get('/withdraw/callback', async (req, res) => {
  try {
    const { k1, pr } = req.query;

    // Verify k1 exists and hasn't been used
    db.get('SELECT * FROM withdrawals WHERE k1 = ? AND used = 0', [k1], async (err, row) => {
      if (err || !row) {
        return res.json({ status: 'ERROR', reason: 'Invalid or used k1' });
      }

      try {
        // Pay the invoice using our LND method
        const payResult = await callLND('channels/transactions', { payment_request: pr });

        // Mark as used
        db.run('UPDATE withdrawals SET used = 1 WHERE k1 = ?', [k1]);

        res.json({ status: 'OK' });
      } catch (error) {
        console.error('Payment error:', error);
        res.json({ status: 'ERROR', reason: 'Payment failed: ' + error.message });
      }
    });
  } catch (error) {
    res.json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-pay endpoint
app.get('/pay/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    const metadata = JSON.stringify([
      ['text/plain', `Payment for ${paymentId}`]
    ]);

    res.json({
      tag: 'payRequest',
      callback: `${DOMAIN}/pay/${paymentId}/callback`,
      minSendable: 1000, // 1 sat minimum (in millisats)
      maxSendable: 1000000000, // 1,000,000 sats maximum (in millisats)
      metadata: metadata
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-pay callback
app.get('/pay/:paymentId/callback', async (req, res) => {
  try {
    const { amount } = req.query;
    const { paymentId } = req.params;
    const amountMsat = parseInt(amount);
    const amountSats = Math.floor(amountMsat / 1000);

    // Create invoice using our LND method
    const invoice = await callLND('invoices', {
      value_msat: amountMsat,
      memo: `LNURL Payment ${paymentId}`,
      expiry: '3600'
    });

    // Generate unique payment record ID (different from paymentId used in URL)
    const uniquePaymentId = crypto.randomBytes(16).toString('hex');

    // Store payment info
    db.run(
      'INSERT INTO payments (id, amount_sats, payment_hash, description) VALUES (?, ?, ?, ?)',
      [uniquePaymentId, amountSats, invoice.payment_hash, `LNURL Payment ${paymentId}`]
    );

    res.json({
      pr: invoice.bolt11,
      routes: []
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.json({ status: 'ERROR', reason: 'Invoice creation failed: ' + error.message });
  }
});

// Generate LNURL endpoint
app.get('/generate/:type', async (req, res) => {
  try {
    const { type } = req.params;
    let url, lnurl, qrCode;

    if (type === 'withdraw') {
      url = `${DOMAIN}/withdraw`;
      lnurl = encode(url);
      qrCode = await QRCode.toDataURL(lnurl);

      res.json({
        url,
        lnurl,
        qrCode,
        type: 'withdraw'
      });
    } else if (type === 'pay') {
      const paymentId = crypto.randomBytes(16).toString('hex');
      url = `${DOMAIN}/pay/${paymentId}`;
      lnurl = encode(url);
      qrCode = await QRCode.toDataURL(lnurl);

      res.json({
        url,
        lnurl,
        qrCode,
        paymentId,
        type: 'pay'
      });
    } else {
      res.status(400).json({ error: 'Invalid type. Use "withdraw" or "pay"' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// LNURL-address resolution (well-known)
app.get('/.well-known/lnurlp/:username', async (req, res) => {
  const { username } = req.params;

  const domain = DOMAIN.replace(/^https?:\/\//, '');
  const lightningAddress = `${username}@${domain}`;

  // LUD-16 compliant metadata
  const metadata = JSON.stringify([
    ["text/plain", `Payment to ${lightningAddress}`],
    ["text/identifier", lightningAddress]
  ]);

  const paymentId = crypto.createHash('sha256').update(username).digest('hex');

  res.json({
    tag: 'payRequest',
    callback: `${DOMAIN}/pay/${paymentId}/callback`,
    minSendable: 1000, // 1 sat (in msats)
    maxSendable: 1000000000, // 1M sats (in msats)
    metadata
  });
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const connections = await checkConnections();
    res.json({
      status: connections.bitcoin && connections.lnd ? 'healthy' : 'unhealthy',
      lnurl_server: 'running',
      bitcoin_connected: connections.bitcoin,
      lnd_connected: connections.lnd,
      block_height: connections.blockHeight,
      lnd_info: connections.nodeInfo,
      domain: DOMAIN
    });
  } catch (error) {
    res.json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 LNURL server starting on port ${PORT}`);
  console.log(`📡 Domain: ${DOMAIN}`);
  console.log(`🔧 Configuration:`);
  console.log(`   Bitcoin RPC: ${BITCOIN_RPC_HOST}:${BITCOIN_RPC_PORT}`);
  console.log(`   LND REST: ${LND_REST_HOST}:${LND_REST_PORT}`);
  console.log(`   LND Macaroon: ${LND_MACAROON_PATH}`);
  console.log(`   LND TLS Cert: ${LND_TLS_CERT_PATH}`);

  console.log('⏳ Waiting 5 seconds for services to be ready...');

  // Wait a bit for services to be ready
  setTimeout(async () => {
    console.log('🔍 Checking connections...');
    await checkConnections();
  }, 5000);
});
