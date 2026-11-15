import pg from "pg";
import { EventEmitter } from "node:events";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:pw@localhost:5432/postgres",
  max: 20,
});

// Live updates: services emit after COMMIT, the SSE route forwards to browsers.
export const bus = new EventEmitter();
bus.setMaxListeners(0);
export const notify = (teamId: number) => {
  bus.emit("msg", { topic: "board" });
  bus.emit("msg", { topic: `team:${teamId}` });
};

// One transaction on ONE connection. Never call pool.query inside: with 50 waiters
// holding all connections, a nested pool.query could starve and deadlock the pool.
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Audit rows are written inside the same transaction as the change they describe.
export const audit = (c: pg.PoolClient, teamId: number, actor: number, action: string, detail: object = {}) =>
  c.query("INSERT INTO audit_log(team_id,actor_id,action,detail) VALUES($1,$2,$3,$4)", [teamId, actor, action, detail]);
