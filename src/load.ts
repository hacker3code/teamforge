// Load test: 100 concurrent users hammer GET /api/board. Writes load-report.md with p50/p95/p99.
import { writeFileSync } from "node:fs";
const BASE = process.env.BASE ?? "http://localhost:3000";
const SECONDS = Number(process.env.SECONDS ?? 20), CONC = Number(process.env.CONC ?? 100);

const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "user5000@seed.dev", password: "password123" }) });
const { token } = await login.json();
const lat: number[] = []; let errors = 0;
const end = Date.now() + SECONDS * 1000;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (Date.now() < end) {
    const s = performance.now();
    try {
      const r = await fetch(`${BASE}/api/board?limit=30&offset=${Math.floor(Math.random() * 300)}`, { headers: { authorization: `Bearer ${token}` } });
      await r.arrayBuffer();
      if (r.status !== 200) errors++;
    } catch { errors++; }
    lat.push(performance.now() - s);
  }
}));
lat.sort((a, b) => a - b);
const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1);
const secs = (Date.now() - t0) / 1000;
const report = `# Load test: GET /api/board\n\n- Target: ${BASE}\n- Concurrent users: ${CONC}\n- Duration: ${secs.toFixed(0)} s\n- Requests: ${lat.length} (${(lat.length / secs).toFixed(0)} req/s)\n- Errors: ${errors}\n- p50: ${p(0.5)} ms\n- p95: ${p(0.95)} ms  (target: under 200 ms)\n- p99: ${p(0.99)} ms\n`;
writeFileSync("load-report.md", report);
console.log(report);
