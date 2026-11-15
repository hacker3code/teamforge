import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET = process.env.SECRET ?? "dev-secret-change-me";

export const hashPw = (pw: string) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
};
export const checkPw = (pw: string, stored: string) => {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  return timingSafeEqual(scryptSync(pw, salt, 32), Buffer.from(key, "hex"));
};

export const sign = (uid: number) => {
  const body = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 7 * 864e5 })).toString("base64url");
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
};
export const verifyToken = (token?: string): number | null => {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = createHmac("sha256", SECRET).update(body).digest("base64url");
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? (p.uid as number) : null;
  } catch { return null; }
};

// Fixed-window rate limiter, in memory. Fine for one server; with several you'd move it into Postgres.
const hits = new Map<string, { n: number; reset: number }>();
export const limited = (key: string, max: number, windowMs: number) => {
  if (process.env.DISABLE_RATE_LIMIT) return false; // only the chaos test sets this
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
};
export const resetLimits = () => hits.clear();
