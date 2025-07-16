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
    comment TEXT,
    comment_allowed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payment_configs (
    payment_id TEXT PRIMARY KEY,
    min_sendable INTEGER DEFAULT 1000,
    max_sendable INTEGER DEFAULT 1000000000,
    comment_allowed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS channel_requests (
    id TEXT PRIMARY KEY,
    k1 TEXT UNIQUE,
    remote_id TEXT,
    private BOOLEAN DEFAULT 0,
    cancelled BOOLEAN DEFAULT 0,
    completed BOOLEAN DEFAULT 0,
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

// Get LND node URI for channel requests
async function getNodeURI() {
  try {
    const nodeInfo = await callLND('getinfo');
    const address = nodeInfo.uris && nodeInfo.uris.length > 0 ? nodeInfo.uris[0] : null;

    if (!address) {
      throw new Error('No public URI available for this node');
    }

    return address;
  } catch (error) {
    console.error('Failed to get node URI:', error.message);
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
      [withdrawId, k1, 0] // Amount will be set when client sends invoice
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

// LNURL-channel endpoint
app.get('/channel', async (req, res) => {
  try {
    const k1 = crypto.randomBytes(32).toString('hex');
    const channelId = crypto.randomBytes(16).toString('hex');

    // Store channel request
    db.run(
      'INSERT INTO channel_requests (id, k1) VALUES (?, ?)',
      [channelId, k1]
    );

    // Get node URI
    const uri = await getNodeURI();
    const callbackUrl = `${DOMAIN}/channel/callback?k1=${k1}`;

    res.json({
      tag: 'channelRequest',
      uri: uri,
      callback: callbackUrl,
      k1: k1
    });
  } catch (error) {
    console.error('Channel request error:', error);
    res.status(500).json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-channel callback
app.get('/channel/callback', async (req, res) => {
  try {
    const { k1, remoteid, private: isPrivate, cancel } = req.query;

    // Verify k1 exists and hasn't been used
    db.get('SELECT * FROM channel_requests WHERE k1 = ? AND completed = 0 AND cancelled = 0', [k1], (err, row) => {
      if (err || !row) {
        return res.json({ status: 'ERROR', reason: 'Invalid or used k1' });
      }

      if (cancel === '1') {
        // User cancelled the channel request
        db.run('UPDATE channel_requests SET cancelled = 1 WHERE k1 = ?', [k1]);
        console.log(`Channel request cancelled: k1=${k1}`);
        return res.json({ status: 'OK' });
      }

      if (!remoteid) {
        return res.json({ status: 'ERROR', reason: 'Missing remoteid parameter' });
      }

      // Store the remote node ID and private flag
      const privateFlag = isPrivate === '1' ? 1 : 0;
      db.run('UPDATE channel_requests SET remote_id = ?, private = ? WHERE k1 = ?', [remoteid, privateFlag, k1]);

      console.log(`Channel request initiated: k1=${k1}, remoteid=${remoteid}, private=${privateFlag}`);

      // The wallet should now wait for an incoming OpenChannel message from our node
      res.json({ status: 'OK' });
    });
  } catch (error) {
    console.error('Channel callback error:', error);
    res.json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-withdraw callback
app.get('/withdraw/callback', async (req, res) => {
  try {
    const { k1, pr } = req.query;

    // Verify k1 exists and hasn't been used, and get withdrawal config
    db.get(`
      SELECT w.*, wc.min_withdrawable, wc.max_withdrawable, wc.default_description 
      FROM withdrawals w 
      LEFT JOIN withdrawal_configs wc ON w.k1 = wc.k1 
      WHERE w.k1 = ? AND w.used = 0
    `, [k1], async (err, row) => {
      if (err || !row) {
        return res.json({ status: 'ERROR', reason: 'Invalid or used k1' });
      }

      try {
        // Decode the invoice to get the amount
        const decodedInvoice = await lndREST(`/v1/payreq/${pr}`, 'GET');
        const invoiceAmountSats = decodedInvoice.num_satoshis;

        console.log(`Processing withdrawal: k1=${k1}, amount=${invoiceAmountSats} sats`);

        // Get configuration values (use defaults if not set)
        const minWithdrawable = row.min_withdrawable || 1000;
        const maxWithdrawable = row.max_withdrawable || 100000000;

        // Validate amount is within configured limits
        if (invoiceAmountSats < minWithdrawable || invoiceAmountSats > maxWithdrawable) {
          return res.json({
            status: 'ERROR',
            reason: `Amount out of range (${minWithdrawable} - ${maxWithdrawable} sats)`
          });
        }

        // Pay the invoice using our LND method
        await lndREST('/v1/channels/transactions', 'POST', { payment_request: pr });

        // Update withdrawal with actual amount and mark as used
        db.run('UPDATE withdrawals SET used = 1, amount_sats = ? WHERE k1 = ?', [invoiceAmountSats, k1]);

        console.log(`✅ Withdrawal completed: k1=${k1}, amount=${invoiceAmountSats} sats`);

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

    // Get payment configuration from database
    db.get('SELECT * FROM payment_configs WHERE payment_id = ?', [paymentId], (err, config) => {
      if (err) {
        return res.status(500).json({ status: 'ERROR', reason: 'Database error' });
      }

      if (!config) {
        return res.status(404).json({ status: 'ERROR', reason: 'Payment configuration not found' });
      }

      const metadata = JSON.stringify([
        ['text/plain', `Payment for ${paymentId}`]
      ]);

      res.json({
        tag: 'payRequest',
        callback: `${DOMAIN}/pay/${paymentId}/callback`,
        minSendable: config.min_sendable,
        maxSendable: config.max_sendable,
        metadata: metadata,
        commentAllowed: config.comment_allowed
      });
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', reason: error.message });
  }
});

// LNURL-pay callback
app.get('/pay/:paymentId/callback', async (req, res) => {
  try {
    const { amount, comment } = req.query;
    const { paymentId } = req.params;
    const amountMsat = parseInt(amount);
    const amountSats = Math.floor(amountMsat / 1000);

    // Create invoice using our LND method
    const invoice = await callLND('invoices', {
      value: amountSats,
      memo: comment ? `LNURL Payment ${paymentId} - ${comment}` : `LNURL Payment ${paymentId}`,
      expiry: 3600
    });

    // Extract the payment hash in hex
    let paymentHashHex = '';
    if (invoice.r_hash_str) {
      paymentHashHex = invoice.r_hash_str;
    } else if (invoice.r_hash) {
      // Convert base64 to hex
      paymentHashHex = Buffer.from(invoice.r_hash, 'base64').toString('hex');
    } else if (invoice.payment_hash) {
      paymentHashHex = invoice.payment_hash;
    }

    // Generate unique payment record ID (different from paymentId used in URL)
    const uniquePaymentId = crypto.randomBytes(16).toString('hex');

    // Store payment info
    db.run(
      'INSERT INTO payments (id, amount_sats, payment_hash, description, comment) VALUES (?, ?, ?, ?, ?)',
      [uniquePaymentId, amountSats, paymentHashHex, `LNURL Payment ${paymentId}`, comment || null]
    );

    res.json({
      pr: invoice.payment_request,
      routes: []
    });
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Invoice creation failed: ' + error.message
    });
  }
});

// Generate LNURL endpoint
app.get('/generate/:type', async (req, res) => {
  try {
    const { type } = req.params;
    let url, lnurl, qrCode;

    if (type === 'withdraw') {
      lnurl = encode(`${DOMAIN}/withdraw`);
      qrCode = await QRCode.toDataURL(lnurl);

      res.json({
        url,
        lnurl,
        qrCode,
        type: 'withdraw'
      });
    } else if (type === 'pay') {
      const { minSendable, maxSendable, commentAllowed } = req.query;
      const paymentId = crypto.randomBytes(16).toString('hex');

      // Store payment configuration in database
      const minSendableValue = minSendable ? parseInt(minSendable) : 1000;
      const maxSendableValue = maxSendable ? parseInt(maxSendable) : 1000000000;
      const commentAllowedValue = commentAllowed ? parseInt(commentAllowed) : 255;

      // Use a promise to ensure the database operation completes
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO payment_configs (payment_id, min_sendable, max_sendable, comment_allowed) VALUES (?, ?, ?, ?)',
          [paymentId, minSendableValue, maxSendableValue, commentAllowedValue],
          function (err) {
            if (err) {
              console.error('Database insert error:', err);
              reject(err);
            } else {
              console.log(`Stored payment config for ${paymentId}: commentAllowed=${commentAllowedValue}`);
              resolve();
            }
          }
        );
      });

      // Build URL (no query parameters needed since config is in DB)
      const paymentUrl = `${DOMAIN}/pay/${paymentId}`;

      lnurl = encode(paymentUrl);
      qrCode = await QRCode.toDataURL(lnurl);

      res.json({
        url: paymentUrl,
        lnurl,
        qrCode,
        paymentId,
        type: 'pay',
        minSendable: minSendableValue,
        maxSendable: maxSendableValue,
        commentAllowed: commentAllowedValue
      });
    } else if (type === 'channel') {
      const channelUrl = `${DOMAIN}/channel`;
      lnurl = encode(channelUrl);
      qrCode = await QRCode.toDataURL(lnurl);

      res.json({
        url: channelUrl,
        lnurl,
        qrCode,
        type: 'channel'
      });
    } else {
      res.status(400).json({ error: 'Invalid type. Use "withdraw", "pay", or "channel"' });
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

  // Store or update payment configuration for this Lightning Address
  await new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO payment_configs (payment_id, min_sendable, max_sendable, comment_allowed) VALUES (?, ?, ?, ?)',
      [paymentId, 1000, 1000000000, 100],
      function (err) {
        if (err) {
          console.error('Database insert error:', err);
          reject(err);
        } else {
          console.log(`Stored Lightning Address config for ${username}: commentAllowed=100`);
          resolve();
        }
      }
    );
  });

  res.json({
    tag: 'payRequest',
    callback: `${DOMAIN}/pay/${paymentId}/callback`,
    minSendable: 1000, // 1 sat (in msats)
    maxSendable: 1000000000, // 1M sats (in msats)
    metadata,
    commentAllowed: 255 // Allow comments up to 255 characters
  });
});

// Check payment status endpoint
app.get('/payment/:paymentId/status', async (req, res) => {
  try {
    const { paymentId } = req.params;

    // Get payment from database
    db.get('SELECT * FROM payments WHERE id = ?', [paymentId], async (err, payment) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!payment) {
        return res.status(404).json({ error: 'Payment not found' });
      }

      // If already marked as paid, return status
      if (payment.paid) {
        return res.json({
          paymentId,
          paid: true,
          amount_sats: payment.amount_sats,
          description: payment.description,
          comment: payment.comment,
          created_at: payment.created_at
        });
      }

      // Check with LND if invoice is settled
      try {
        const invoice = await lndREST(`/v1/invoice/${payment.payment_hash}`, 'GET');

        if (invoice.settled) {
          db.run('UPDATE payments SET paid = 1 WHERE id = ?', [paymentId]);

          res.json({
            paymentId,
            paid: true,
            amount_sats: payment.amount_sats,
            description: payment.description,
            comment: payment.comment,
            created_at: payment.created_at,
            settled_at: new Date().toISOString()
          });
        } else {
          res.json({
            paymentId,
            paid: false,
            amount_sats: payment.amount_sats,
            description: payment.description,
            comment: payment.comment,
            created_at: payment.created_at
          });
        }
      } catch (lndError) {
        console.error('Error checking invoice status:', lndError);
        res.json({
          paymentId,
          paid: false,
          amount_sats: payment.amount_sats,
          description: payment.description,
          comment: payment.comment,
          created_at: payment.created_at,
          error: 'Could not verify payment status'
        });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all payments endpoint
app.get('/payments', async (req, res) => {
  try {
    db.all('SELECT * FROM payments ORDER BY created_at DESC', [], (err, payments) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        payments: payments.map(p => ({
          id: p.id,
          amount_sats: p.amount_sats,
          description: p.description,
          comment: p.comment,
          paid: Boolean(p.paid),
          created_at: p.created_at
        }))
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all withdrawals endpoint
app.get('/withdrawals', async (req, res) => {
  try {
    db.all('SELECT * FROM withdrawals ORDER BY created_at DESC', [], (err, withdrawals) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        withdrawals: withdrawals.map(w => ({
          id: w.id,
          k1: w.k1,
          amount_sats: w.amount_sats,
          used: Boolean(w.used),
          created_at: w.created_at
        }))
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all channel requests endpoint
app.get('/channels', async (req, res) => {
  try {
    db.all('SELECT * FROM channel_requests ORDER BY created_at DESC', [], (err, channels) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      res.json({
        channels: channels.map(c => ({
          id: c.id,
          k1: c.k1,
          remote_id: c.remote_id,
          private: Boolean(c.private),
          cancelled: Boolean(c.cancelled),
          completed: Boolean(c.completed),
          created_at: c.created_at
        }))
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

// Background job to check for settled invoices
async function checkSettledInvoices() {
  try {
    // Get all unpaid payments
    db.all('SELECT * FROM payments WHERE paid = 0', [], async (err, payments) => {
      if (err) {
        console.error('Error fetching unpaid payments:', err);
        return;
      }

      for (const payment of payments) {
        try {
          const invoice = await lndREST(`/v1/invoice/${payment.payment_hash}`, 'GET');

          if (invoice.settled) {
            db.run('UPDATE payments SET paid = 1 WHERE id = ?', [payment.id]);
            console.log(`✅ Payment ${payment.id} marked as paid (${payment.amount_sats} sats)`);
          }
        } catch (error) {
          console.error(`Error checking payment ${payment.id}:`, error.message);
        }
      }
    });
  } catch (error) {
    console.error('Error in checkSettledInvoices:', error);
  }
}

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

    // Start background job to check for settled invoices every 30 seconds
    setInterval(checkSettledInvoices, 10000);
    console.log('🔄 Started background payment monitoring (every 30 seconds)');
  }, 5000);
});
