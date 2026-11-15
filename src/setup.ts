import { readFileSync } from "node:fs";
import { pool } from "./db";
// "--if-missing" is used by Docker so restarts never wipe data.
const exists = (await pool.query("SELECT to_regclass('public.users') AS t")).rows[0].t;
if (process.argv.includes("--if-missing") && exists) console.log("schema already there, leaving data alone");
else { await pool.query(readFileSync("schema.sql", "utf8")); console.log("schema applied (all tables recreated)"); }
await pool.end();
