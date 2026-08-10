import { Pool } from 'pg';
export class Database {
    #pool;
    constructor(config) {
        this.#pool = new Pool(typeof config === 'string' ? { connectionString: config } : config);
    }
    query(text, values = []) {
        return this.#pool.query(text, [...values]);
    }
    async transaction(operation) {
        const client = await this.#pool.connect();
        try {
            await client.query('BEGIN');
            const result = await operation(client);
            await client.query('COMMIT');
            return result;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    async ping() {
        await this.#pool.query('SELECT 1');
    }
    async close() {
        await this.#pool.end();
    }
}
//# sourceMappingURL=client.js.map