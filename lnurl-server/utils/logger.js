const config = require('../config');

class Logger {
    static info(message, data = {}) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] INFO: ${message}`, Object.keys(data).length > 0 ? data : '');
    }

    static error(message, error = null) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ERROR: ${message}`, error ? error.message : '');
        if (error && error.stack && config.nodeEnv === 'development') {
            console.error(error.stack);
        }
    }

    static warn(message, data = {}) {
        const timestamp = new Date().toISOString();
        console.warn(`[${timestamp}] WARN: ${message}`, Object.keys(data).length > 0 ? data : '');
    }

    static debug(message, data = {}) {
        if (config.nodeEnv === 'development') {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] DEBUG: ${message}`, Object.keys(data).length > 0 ? data : '');
        }
    }

    // Specific logging methods for different operations
    static payment(operation, data = {}) {
        this.info(`Payment ${operation}`, data);
    }

    static withdrawal(operation, data = {}) {
        this.info(`Withdrawal ${operation}`, data);
    }

    static channel(operation, data = {}) {
        this.info(`Channel ${operation}`, data);
    }

    static connection(service, status, data = {}) {
        this.info(`${service} connection ${status}`, data);
    }

    static api(endpoint, method, status, data = {}) {
        this.info(`API ${method} ${endpoint} - ${status}`, data);
    }
}

module.exports = Logger;
