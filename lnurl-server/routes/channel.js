const express = require('express');
const router = express.Router();

const config = require('../config');
const db = require('../database');
const lndService = require('../services/lnd');
const Validation = require('../utils/validation');
const Logger = require('../utils/logger');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

// LNURL-channel endpoint
router.get('/', asyncHandler(async (req, res) => {
    const k1 = Validation.generateK1();
    const channelId = Validation.generateId();

    // Store channel request
    await db.createChannelRequest(channelId, k1);

    // Get node URI
    const uri = await lndService.getNodeURI();
    const callbackUrl = `${config.domain}/channel/callback?k1=${k1}`;

    Logger.channel('request created', { k1, channelId, uri });

    res.json({
        tag: 'channelRequest',
        uri: uri,
        callback: callbackUrl,
        k1: k1
    });
}));

// LNURL-channel callback
router.get('/callback', asyncHandler(async (req, res) => {
    const { k1, remoteid, private: isPrivate, cancel } = req.query;

    // Validate input parameters
    const validationErrors = Validation.validateChannelRequest({ k1, remoteid, private: isPrivate, cancel });
    if (validationErrors.length > 0) {
        throw new ValidationError(validationErrors.join(', '));
    }

    // Get channel request from database
    const channelRequest = await db.getChannelRequest(k1);
    if (!channelRequest) {
        throw new ValidationError('Invalid or used k1');
    }

    if (cancel === '1') {
        // User cancelled the channel request
        await db.cancelChannelRequest(k1);
        Logger.channel('cancelled', { k1 });
        return res.json({ status: 'OK' });
    }

    // Store the remote node ID and private flag
    const privateFlag = isPrivate === '1';
    await db.updateChannelRequest(k1, remoteid, privateFlag);

    Logger.channel('initiated', { k1, remoteid, private: privateFlag });

    // The wallet should now wait for an incoming OpenChannel message from our node
    res.json({ status: 'OK' });
}));

module.exports = router;
