const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

class Database {
    constructor() {
        this.db = new sqlite3.Database(config.database.path);
        this.init();
    }

    init() {
        this.db.serialize(() => {
            // Withdrawals table
            this.db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
                id TEXT PRIMARY KEY,
                k1 TEXT UNIQUE,
                amount_sats INTEGER,
                used BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Payments table
            this.db.run(`CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY,
                amount_sats INTEGER,
                description TEXT,
                payment_hash TEXT,
                paid BOOLEAN DEFAULT 0,
                comment TEXT,
                comment_allowed INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Payment configs table
            this.db.run(`CREATE TABLE IF NOT EXISTS payment_configs (
                payment_id TEXT PRIMARY KEY,
                min_sendable INTEGER DEFAULT 1000,
                max_sendable INTEGER DEFAULT 1000000000,
                comment_allowed INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Channel requests table
            this.db.run(`CREATE TABLE IF NOT EXISTS channel_requests (
                id TEXT PRIMARY KEY,
                k1 TEXT UNIQUE,
                remote_id TEXT,
                private BOOLEAN DEFAULT 0,
                cancelled BOOLEAN DEFAULT 0,
                completed BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Auth challenges table
            this.db.run(`CREATE TABLE IF NOT EXISTS auth_challenges (
                k1 TEXT PRIMARY KEY,
                action TEXT DEFAULT 'login',
                used BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // Auth sessions table
            this.db.run(`CREATE TABLE IF NOT EXISTS auth_sessions (
                id TEXT PRIMARY KEY,
                linking_key TEXT,
                action TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
        });
    }

    // Promise-based database operations
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Withdrawal operations
    async createWithdrawal(id, k1, amountSats = 0) {
        return this.run(
            'INSERT INTO withdrawals (id, k1, amount_sats) VALUES (?, ?, ?)',
            [id, k1, amountSats]
        );
    }

    async getWithdrawal(k1) {
        return this.get(
            'SELECT * FROM withdrawals WHERE k1 = ? AND used = 0',
            [k1]
        );
    }

    async updateWithdrawal(k1, amountSats) {
        return this.run(
            'UPDATE withdrawals SET used = 1, amount_sats = ? WHERE k1 = ?',
            [amountSats, k1]
        );
    }

    async getAllWithdrawals() {
        return this.all('SELECT * FROM withdrawals ORDER BY created_at DESC');
    }

    // Payment operations
    async createPayment(id, amountSats, description, paymentHash, comment = null) {
        return this.run(
            'INSERT INTO payments (id, amount_sats, description, payment_hash, comment) VALUES (?, ?, ?, ?, ?)',
            [id, amountSats, description, paymentHash, comment]
        );
    }

    async getPayment(id) {
        return this.get('SELECT * FROM payments WHERE id = ?', [id]);
    }

    async updatePaymentPaid(id) {
        return this.run('UPDATE payments SET paid = 1 WHERE id = ?', [id]);
    }

    async getAllPayments() {
        return this.all('SELECT * FROM payments ORDER BY created_at DESC');
    }

    async getUnpaidPayments() {
        return this.all('SELECT * FROM payments WHERE paid = 0');
    }

    // Payment config operations
    async createPaymentConfig(paymentId, minSendable, maxSendable, commentAllowed) {
        return this.run(
            'INSERT OR REPLACE INTO payment_configs (payment_id, min_sendable, max_sendable, comment_allowed) VALUES (?, ?, ?, ?)',
            [paymentId, minSendable, maxSendable, commentAllowed]
        );
    }

    async getPaymentConfig(paymentId) {
        return this.get('SELECT * FROM payment_configs WHERE payment_id = ?', [paymentId]);
    }

    // Channel operations
    async createChannelRequest(id, k1) {
        return this.run(
            'INSERT INTO channel_requests (id, k1) VALUES (?, ?)',
            [id, k1]
        );
    }

    async getChannelRequest(k1) {
        return this.get(
            'SELECT * FROM channel_requests WHERE k1 = ? AND completed = 0 AND cancelled = 0',
            [k1]
        );
    }

    async updateChannelRequest(k1, remoteId, isPrivate) {
        return this.run(
            'UPDATE channel_requests SET remote_id = ?, private = ? WHERE k1 = ?',
            [remoteId, isPrivate ? 1 : 0, k1]
        );
    }

    async cancelChannelRequest(k1) {
        return this.run(
            'UPDATE channel_requests SET cancelled = 1 WHERE k1 = ?',
            [k1]
        );
    }

    async completeChannelRequest(k1) {
        return this.run(
            'UPDATE channel_requests SET completed = 1 WHERE k1 = ?',
            [k1]
        );
    }

    async getAllChannelRequests() {
        return this.all('SELECT * FROM channel_requests ORDER BY created_at DESC');
    }

    // Auth operations
    async createAuthChallenge(k1, action = 'login') {
        return this.run(
            'INSERT INTO auth_challenges (k1, action) VALUES (?, ?)',
            [k1, action]
        );
    }

    async getAuthChallenge(k1) {
        return this.get(
            'SELECT * FROM auth_challenges WHERE k1 = ? AND used = 0',
            [k1]
        );
    }

    async useAuthChallenge(k1) {
        return this.run(
            'UPDATE auth_challenges SET used = 1 WHERE k1 = ?',
            [k1]
        );
    }

    async createAuthSession(id, linkingKey, action) {
        return this.run(
            'INSERT INTO auth_sessions (id, linking_key, action) VALUES (?, ?, ?)',
            [id, linkingKey, action]
        );
    }

    async getAuthSession(id) {
        return this.get('SELECT * FROM auth_sessions WHERE id = ?', [id]);
    }

    async getAuthSessionByLinkingKey(linkingKey) {
        return this.get('SELECT * FROM auth_sessions WHERE linking_key = ?', [linkingKey]);
    }

    async deleteAuthSession(id) {
        return this.run('DELETE FROM auth_sessions WHERE id = ?', [id]);
    }

    async cleanupExpiredAuthChallenges() {
        const expiryTime = new Date(Date.now() - config.auth.k1Expiry).toISOString();
        return this.run(
            'DELETE FROM auth_challenges WHERE created_at < ?',
            [expiryTime]
        );
    }

    async cleanupExpiredAuthSessions() {
        const expiryTime = new Date(Date.now() - config.auth.sessionExpiry).toISOString();
        return this.run(
            'DELETE FROM auth_sessions WHERE created_at < ?',
            [expiryTime]
        );
    }

    close() {
        this.db.close();
    }
}

module.exports = new Database();
