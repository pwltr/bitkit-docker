const db = require('../database');
const lndService = require('./lnd');
const Logger = require('../utils/logger');
const config = require('../config');

class BackgroundJobs {
    constructor() {
        this.paymentCheckInterval = null;
        this.authCleanupInterval = null;
    }

    // Start all background jobs
    start() {
        this.startPaymentCheck();
        this.startAuthCleanup();
        Logger.info('Background jobs started');
    }

    // Stop all background jobs
    stop() {
        if (this.paymentCheckInterval) {
            clearInterval(this.paymentCheckInterval);
            this.paymentCheckInterval = null;
        }
        if (this.authCleanupInterval) {
            clearInterval(this.authCleanupInterval);
            this.authCleanupInterval = null;
        }
        Logger.info('Background jobs stopped');
    }

    // Start payment checking job
    startPaymentCheck() {
        this.paymentCheckInterval = setInterval(async () => {
            await this.checkSettledInvoices();
        }, config.intervals.paymentCheck);

        Logger.info('Payment check job started', { interval: config.intervals.paymentCheck });
    }

    // Start auth cleanup job
    startAuthCleanup() {
        this.authCleanupInterval = setInterval(async () => {
            await this.cleanupExpiredAuth();
        }, config.auth.cleanupInterval);

        Logger.info('Auth cleanup job started', { interval: config.auth.cleanupInterval });
    }

    // Check for settled invoices and update payment status
    async checkSettledInvoices() {
        try {
            // Get all unpaid payments
            const payments = await db.getUnpaidPayments();

            for (const payment of payments) {
                try {
                    const invoice = await lndService.getInvoice(payment.payment_hash);

                    if (invoice.settled) {
                        await db.updatePaymentPaid(payment.id);
                        Logger.payment('marked as paid', {
                            id: payment.id,
                            amount: payment.amount_sats
                        });
                    }
                } catch (error) {
                    Logger.error(`Error checking payment ${payment.id}`, error);
                }
            }
        } catch (error) {
            Logger.error('Error in checkSettledInvoices', error);
        }
    }

    // Cleanup expired auth challenges and sessions
    async cleanupExpiredAuth() {
        try {
            const challengesResult = await db.cleanupExpiredAuthChallenges();
            const sessionsResult = await db.cleanupExpiredAuthSessions();

            if (challengesResult.changes > 0 || sessionsResult.changes > 0) {
                Logger.info('Auth cleanup completed', {
                    challengesRemoved: challengesResult.changes,
                    sessionsRemoved: sessionsResult.changes
                });
            }
        } catch (error) {
            Logger.error('Error in cleanupExpiredAuth', error);
        }
    }
}

module.exports = new BackgroundJobs();
