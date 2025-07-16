const crypto = require('crypto');
const config = require('../config');

class Validation {
    // Validate k1 parameter (32-byte hex string)
    static isValidK1(k1) {
        if (!k1 || typeof k1 !== 'string') {
            return false;
        }
        return /^[a-fA-F0-9]{64}$/.test(k1);
    }

    // Validate payment request (Lightning invoice)
    static isValidPaymentRequest(pr) {
        if (!pr || typeof pr !== 'string') {
            return false;
        }
        // Basic validation - starts with 'lnbc' for mainnet or 'lntb' for testnet
        return /^ln(bc|tb|rt)[a-zA-Z0-9]+$/.test(pr);
    }

    // Validate amount in millisatoshis
    static isValidAmount(amount) {
        const num = parseInt(amount);
        return !isNaN(num) && num > 0;
    }

    // Validate amount is within limits
    static isAmountInRange(amount, min, max) {
        const num = parseInt(amount);
        return !isNaN(num) && num >= min && num <= max;
    }

    // Validate remote node ID (33-byte hex string starting with 02 or 03)
    static isValidRemoteId(remoteId) {
        if (!remoteId || typeof remoteId !== 'string') {
            return false;
        }
        return /^0[23][a-fA-F0-9]{64}$/.test(remoteId);
    }

    // Validate payment ID (hex string)
    static isValidPaymentId(paymentId) {
        if (!paymentId || typeof paymentId !== 'string') {
            return false;
        }
        return /^[a-fA-F0-9]+$/.test(paymentId);
    }

    // Validate comment length
    static isValidComment(comment, maxLength = config.limits.commentAllowed) {
        if (!comment) {
            return true; // Comments are optional
        }
        return typeof comment === 'string' && comment.length <= maxLength;
    }

    // Validate boolean parameter
    static isValidBoolean(value) {
        if (value === undefined || value === null) {
            return true; // Optional boolean
        }
        return value === '0' || value === '1' || value === true || value === false;
    }

    // Generate random k1
    static generateK1() {
        return crypto.randomBytes(config.limits.k1Length).toString('hex');
    }

    // Generate random ID
    static generateId() {
        return crypto.randomBytes(config.limits.idLength).toString('hex');
    }

    // Validate LNURL channel request parameters
    static validateChannelRequest(params) {
        const errors = [];

        if (params.cancel === '1') {
            // For cancellation, only k1 is required
            if (!this.isValidK1(params.k1)) {
                errors.push('Invalid k1 parameter');
            }
        } else {
            // For channel opening, k1 and remoteid are required
            if (!this.isValidK1(params.k1)) {
                errors.push('Invalid k1 parameter');
            }
            if (!this.isValidRemoteId(params.remoteid)) {
                errors.push('Invalid remoteid parameter');
            }
            if (params.private && !this.isValidBoolean(params.private)) {
                errors.push('Invalid private parameter');
            }
        }

        return errors;
    }

    // Validate LNURL withdraw callback parameters
    static validateWithdrawCallback(params) {
        const errors = [];

        if (!this.isValidK1(params.k1)) {
            errors.push('Invalid k1 parameter');
        }
        if (!this.isValidPaymentRequest(params.pr)) {
            errors.push('Invalid payment request');
        }

        return errors;
    }

    // Validate LNURL pay callback parameters
    static validatePayCallback(params) {
        const errors = [];

        if (!this.isValidAmount(params.amount)) {
            errors.push('Invalid amount parameter');
        }
        if (params.comment && !this.isValidComment(params.comment)) {
            errors.push('Comment too long');
        }

        return errors;
    }
}

module.exports = Validation;
