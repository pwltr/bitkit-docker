const express = require('express');
const router = express.Router();

const config = require('../config');
const db = require('../database');
const bitcoinService = require('../services/bitcoin');
const lndService = require('../services/lnd');
const Logger = require('../utils/logger');
const { asyncHandler } = require('../middleware/errorHandler');

// Health check endpoint
router.get('/health', asyncHandler(async (req, res) => {
    const connections = await checkConnections();

    res.json({
        status: connections.bitcoin && connections.lnd ? 'healthy' : 'unhealthy',
        lnurl_server: 'running',
        bitcoin_connected: connections.bitcoin,
        lnd_connected: connections.lnd,
        block_height: connections.blockHeight,
        lnd_info: connections.nodeInfo,
        domain: config.domain
    });
}));

// List all payments endpoint
router.get('/payments', asyncHandler(async (req, res) => {
    const payments = await db.getAllPayments();

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
}));

// List all withdrawals endpoint
router.get('/withdrawals', asyncHandler(async (req, res) => {
    const withdrawals = await db.getAllWithdrawals();

    res.json({
        withdrawals: withdrawals.map(w => ({
            id: w.id,
            k1: w.k1,
            amount_sats: w.amount_sats,
            used: Boolean(w.used),
            created_at: w.created_at
        }))
    });
}));

// List all channel requests endpoint
router.get('/channels', asyncHandler(async (req, res) => {
    const channels = await db.getAllChannelRequests();

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
}));

// Check payment status endpoint
router.get('/payment/:paymentId/status', asyncHandler(async (req, res) => {
    const { paymentId } = req.params;

    // Get payment from database
    const payment = await db.getPayment(paymentId);
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
        const invoice = await lndService.getInvoice(payment.payment_hash);

        if (invoice.settled) {
            await db.updatePaymentPaid(paymentId);

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
        Logger.error('Error checking invoice status', lndError);
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
}));

// Get new LND address for funding
router.get('/address', asyncHandler(async (req, res) => {
    const addressInfo = await lndService.getNewAddress();
    res.json(addressInfo);
}));

// Helper function to check connections
async function checkConnections() {
    const result = { bitcoin: false, lnd: false, error: null, blockHeight: null, nodeInfo: null };

    // Test Bitcoin connection
    try {
        const blockHeight = await bitcoinService.getBlockCount();
        Logger.connection('Bitcoin', 'connected', { blockHeight });
        result.bitcoin = true;
        result.blockHeight = blockHeight;
    } catch (error) {
        Logger.connection('Bitcoin', 'failed', { error: error.message });
        result.error = `Bitcoin: ${error.message}`;
    }

    // Test LND connection
    try {
        const nodeInfo = await lndService.getInfo();
        Logger.connection('LND', 'connected', { identity: nodeInfo.identity_pubkey });
        result.lnd = true;
        result.nodeInfo = nodeInfo;
    } catch (error) {
        Logger.connection('LND', 'failed', { error: error.message });
        if (!result.error) {
            result.error = `LND: ${error.message}`;
        } else {
            result.error += `, LND: ${error.message}`;
        }
    }

    return result;
}

module.exports = router; 