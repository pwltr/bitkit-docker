const express = require('express');
const router = express.Router();
const { encode } = require('lnurl');
const QRCode = require('qrcode');

const config = require('../config');
const db = require('../database');
const Validation = require('../utils/validation');
const Logger = require('../utils/logger');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

// Generate LNURL endpoint
router.get('/:type', asyncHandler(async (req, res) => {
    const { type } = req.params;
    let lnurl, qrCode;

    if (type === 'withdraw') {
        lnurl = encode(`${config.domain}/withdraw`);
        qrCode = await QRCode.toDataURL(lnurl);

        res.json({
            url: `${config.domain}/withdraw`,
            lnurl,
            qrCode,
            type: 'withdraw'
        });
    } else if (type === 'pay') {
        const { minSendable, maxSendable, commentAllowed } = req.query;
        const paymentId = Validation.generateId();

        // Store payment configuration in database
        const minSendableValue = minSendable ? parseInt(minSendable) : config.limits.minSendable;
        const maxSendableValue = maxSendable ? parseInt(maxSendable) : config.limits.maxSendable;
        const commentAllowedValue = commentAllowed ? parseInt(commentAllowed) : config.limits.commentAllowed;

        await db.createPaymentConfig(paymentId, minSendableValue, maxSendableValue, commentAllowedValue);

        // Build URL (no query parameters needed since config is in DB)
        const paymentUrl = `${config.domain}/pay/${paymentId}`;

        lnurl = encode(paymentUrl);
        qrCode = await QRCode.toDataURL(lnurl);

        Logger.info('Payment config created', { paymentId, minSendable: minSendableValue, maxSendable: maxSendableValue });

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
        const channelUrl = `${config.domain}/channel`;
        lnurl = encode(channelUrl);
        qrCode = await QRCode.toDataURL(lnurl);

        res.json({
            url: channelUrl,
            lnurl,
            qrCode,
            type: 'channel'
        });
    } else {
        throw new ValidationError('Invalid type. Use "withdraw", "pay", or "channel"');
    }
}));

module.exports = router;
