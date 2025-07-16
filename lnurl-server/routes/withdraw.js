const express = require('express');
const router = express.Router();

const config = require('../config');
const db = require('../database');
const lndService = require('../services/lnd');
const Validation = require('../utils/validation');
const Logger = require('../utils/logger');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

// LNURL-withdraw endpoint
router.get('/', asyncHandler(async (req, res) => {
    const k1 = Validation.generateK1();
    const withdrawId = Validation.generateId();

    // Store withdrawal request
    await db.createWithdrawal(withdrawId, k1, 0);

    const withdrawUrl = `${config.domain}/withdraw/callback?k1=${k1}`;

    Logger.withdrawal('request created', { k1, withdrawId });

    res.json({
        tag: 'withdrawRequest',
        callback: withdrawUrl,
        k1: k1,
        defaultDescription: 'LNURL Withdraw Test',
        minWithdrawable: config.limits.minWithdrawable,
        maxWithdrawable: config.limits.maxWithdrawable
    });
}));

// LNURL-withdraw callback
router.get('/callback', asyncHandler(async (req, res) => {
    const { k1, pr } = req.query;

    // Validate input parameters
    const validationErrors = Validation.validateWithdrawCallback({ k1, pr });
    if (validationErrors.length > 0) {
        throw new ValidationError(validationErrors.join(', '));
    }

    // Get withdrawal from database
    const withdrawal = await db.getWithdrawal(k1);
    if (!withdrawal) {
        throw new ValidationError('Invalid or used k1');
    }

    try {
        // Decode the invoice to get the amount
        const decodedInvoice = await lndService.decodePayReq(pr);
        const invoiceAmountSats = decodedInvoice.num_satoshis;

        Logger.withdrawal('processing', { k1, amount: invoiceAmountSats });

        // Validate amount is within configured limits
        if (!Validation.isAmountInRange(invoiceAmountSats, config.limits.minWithdrawable, config.limits.maxWithdrawable)) {
            throw new ValidationError(`Amount out of range (${config.limits.minWithdrawable} - ${config.limits.maxWithdrawable} sats)`);
        }

        // Pay the invoice
        await lndService.payInvoice(pr);

        // Update withdrawal with actual amount and mark as used
        await db.updateWithdrawal(k1, invoiceAmountSats);

        Logger.withdrawal('completed', { k1, amount: invoiceAmountSats });

        res.json({ status: 'OK' });
    } catch (error) {
        Logger.error('Payment error', error);
        throw new Error('Payment failed: ' + error.message);
    }
}));

module.exports = router;
