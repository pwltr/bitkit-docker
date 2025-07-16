const db = require('../database');
const lndService = require('./lnd');
const Logger = require('../utils/logger');
const config = require('../config');

class BackgroundJobs {
    constructor() {
        this.paymentCheckInterval = null;
    }

    // Start all background jobs
    start() {
        this.startPaymentCheck();
        Logger.info('Background jobs started');
    }

    // Stop all background jobs
    stop() {
        if (this.paymentCheckInterval) {
            clearInterval(this.paymentCheckInterval);
            this.paymentCheckInterval = null;
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
}

module.exports = new BackgroundJobs();
