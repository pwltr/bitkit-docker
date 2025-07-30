const express = require('express');
const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const QRCode = require('qrcode');
const lnurl = require('lnurl');
const database = require('../database');
const config = require('../config');
const logger = require('../utils/logger');
const { validateHexString } = require('../utils/validation');

const router = express.Router();

// Generate auth challenge or verify signature (GET /auth)
router.get('/', async (req, res) => {
    try {
        const { k1, sig, key, action } = req.query;

        // If k1, sig, and key are ALL provided, verify signature
        if (k1 && sig && key) {
            // Validate hex strings
            if (!validateHexString(k1, 64) || !validateHexString(sig) || !validateHexString(key, 66)) {
                return res.status(400).json({
                    status: 'ERROR',
                    reason: 'Invalid hex format for k1, sig, or key'
                });
            }

            // Get auth challenge from database
            const challenge = await database.getAuthChallenge(k1);
            if (!challenge) {
                return res.status(400).json({
                    status: 'ERROR',
                    reason: 'Invalid or expired k1'
                });
            }

            // Verify signature
            try {
                const k1Bytes = Buffer.from(k1, 'hex');
                const keyBytes = Buffer.from(key, 'hex');
                const sigBytes = Buffer.from(sig, 'hex');

                // Convert DER signature to compact format
                let compactSig;
                try {
                    compactSig = secp256k1.signatureImport(sigBytes);
                } catch (importError) {
                    logger.error('Failed to import DER signature', { error: importError.message });
                    return res.status(400).json({
                        status: 'ERROR',
                        reason: 'Invalid DER signature'
                    });
                }

                // Verify the signature
                const isValid = secp256k1.ecdsaVerify(compactSig, k1Bytes, keyBytes);

                if (!isValid) {
                    logger.warn('Invalid auth signature', { k1, key });
                    return res.status(400).json({
                        status: 'ERROR',
                        reason: 'Invalid signature'
                    });
                }

            } catch (sigError) {
                logger.error('Signature verification error', { error: sigError.message });
                return res.status(400).json({
                    status: 'ERROR',
                    reason: 'Signature verification failed'
                });
            }

            // Mark challenge as used
            await database.useAuthChallenge(k1);

            // Create session
            const sessionId = crypto.randomBytes(16).toString('hex');
            await database.createAuthSession(sessionId, key, challenge.action);

            logger.info('Auth successful', { 
                k1, 
                linkingKey: key, 
                action: challenge.action, 
                sessionId 
            });

            res.json({
                status: 'OK',
                sessionId: sessionId,
                linkingKey: key,
                action: challenge.action
            });
            return;
        }

        // Otherwise, generate new auth challenge (even if k1 is provided but sig/key are missing)
        const challengeAction = action || 'login';

        // Validate action parameter
        const validActions = ['register', 'login', 'link', 'auth'];
        if (!validActions.includes(challengeAction)) {
            return res.status(400).json({
                status: 'ERROR',
                reason: 'Invalid action parameter'
            });
        }

        // Generate random k1 (32 bytes)
        const newK1 = crypto.randomBytes(32).toString('hex');

        // Store challenge in database
        await database.createAuthChallenge(newK1, challengeAction);

        // Create the auth URL
        const authUrl = `${config.domain}/auth?tag=login&k1=${newK1}&action=${challengeAction}`;

        // Encode as LNURL
        const encodedLnurl = lnurl.encode(authUrl);

        logger.info('Auth challenge created', { k1: newK1, action: challengeAction });

        res.json({
            tag: 'login',
            k1: newK1,
            action: challengeAction,
            callback: `${config.domain}/auth`,
            lnurl: encodedLnurl
        });

    } catch (error) {
        logger.error('Error in auth endpoint', { error: error.message });
        res.status(500).json({
            status: 'ERROR',
            reason: 'Internal server error'
        });
    }
});

// Validate session (GET /auth/validate)
router.get('/validate', async (req, res) => {
    try {
        const { sessionId } = req.query;
        
        if (!sessionId) {
            return res.status(400).json({
                status: 'ERROR',
                reason: 'Missing sessionId parameter'
            });
        }

        const session = await database.getAuthSession(sessionId);
        if (!session) {
            return res.status(401).json({
                status: 'ERROR',
                reason: 'Invalid or expired session'
            });
        }

        res.json({
            status: 'OK',
            session: {
                id: session.id,
                linkingKey: session.linking_key,
                action: session.action,
                createdAt: session.created_at
            }
        });

    } catch (error) {
        logger.error('Error validating session', { error: error.message });
        res.status(500).json({
            status: 'ERROR',
            reason: 'Internal server error'
        });
    }
});

// Generate QR code for auth challenge (GET /auth/qr)
router.get('/qr', async (req, res) => {
    try {
        const { action = 'login' } = req.query;

        // Validate action parameter
        const validActions = ['register', 'login', 'link', 'auth'];
        if (!validActions.includes(action)) {
            return res.status(400).json({
                status: 'ERROR',
                reason: 'Invalid action parameter'
            });
        }

        // Generate random k1 (32 bytes)
        const k1 = crypto.randomBytes(32).toString('hex');

        // Store challenge in database
        await database.createAuthChallenge(k1, action);

        // Create the auth URL
        const authUrl = `${config.domain}/auth?tag=login&k1=${k1}&action=${action}`;

        // Encode as LNURL
        const encodedLnurl = lnurl.encode(authUrl);

        // Generate QR code
        const qrCodeDataUrl = await QRCode.toDataURL(encodedLnurl);

        logger.info('Auth QR code generated', { k1, action, lnurl: encodedLnurl });

        res.json({
            status: 'OK',
            k1: k1,
            action: action,
            authUrl: authUrl,
            lnurl: encodedLnurl,
            qrCode: qrCodeDataUrl
        });

    } catch (error) {
        logger.error('Error generating auth QR code', { error: error.message });
        res.status(500).json({
            status: 'ERROR',
            reason: 'Internal server error'
        });
    }
});

// Get auth status (GET /auth/status/:sessionId)
router.get('/status/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;

        const session = await database.getAuthSession(sessionId);
        if (!session) {
            return res.status(404).json({
                status: 'ERROR',
                reason: 'Session not found'
            });
        }

        res.json({
            status: 'OK',
            session: {
                id: session.id,
                linkingKey: session.linking_key,
                action: session.action,
                createdAt: session.created_at
            }
        });

    } catch (error) {
        logger.error('Error getting auth status', { error: error.message });
        res.status(500).json({
            status: 'ERROR',
            reason: 'Internal server error'
        });
    }
});

// Logout (DELETE /auth/logout/:sessionId)
router.delete('/logout/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;

        const session = await database.getAuthSession(sessionId);
        if (!session) {
            return res.status(404).json({
                status: 'ERROR',
                reason: 'Session not found'
            });
        }

        await database.deleteAuthSession(sessionId);

        logger.info('User logged out', { sessionId });

        res.json({
            status: 'OK'
        });

    } catch (error) {
        logger.error('Error logging out', { error: error.message });
        res.status(500).json({
            status: 'ERROR',
            reason: 'Internal server error'
        });
    }
});

module.exports = router; 