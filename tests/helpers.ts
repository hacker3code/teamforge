import { pool } from "../src/db";

export const reset = () =>
  pool.query("TRUNCATE audit_log,idempotency_keys,join_requests,team_members,teams,users RESTART IDENTITY CASCADE");

let n = 0;
export async function mkUser(skills: string[] = [], offset = 0): Promise<number> {
  n++;
  return (await pool.query(
    "INSERT INTO users(name,email,password_hash,skills,utc_offset_minutes) VALUES($1,$2,'x',$3,$4) RETURNING id",
    [`User ${n}`, `u${n}-${Math.random().toString(36).slice(2)}@t.dev`, skills, offset])).rows[0].id;
}
export async function mkUsers(count: number): Promise<number[]> {
  return (await pool.query(
    "INSERT INTO users(name,email,password_hash) SELECT 'Bulk '||g,'bulk'||g||'-'||$1||'@t.dev','x' FROM generate_series(1,$2) g RETURNING id",
    [Math.random().toString(36).slice(2), count])).rows.map((r) => r.id);
}
// Team with the leader plus `extra` members already inside.
export async function mkTeam(leader: number, extra: number[] = [], max = 4, needs: string[] = []) {
  const code = "code-" + Math.random().toString(36).slice(2, 12);
  const t = (await pool.query(
    `INSERT INTO teams(hackathon_id,name,leader_id,max_size,member_count,needs,invite_code,invite_expires)
     VALUES(1,'Team',$1,$2,$3,$4,$5,now()+interval '1 hour') RETURNING id`, [leader, max, 1 + extra.length, needs, code])).rows[0];
  for (const u of [leader, ...extra]) {
    await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) VALUES($1,$2,1)", [t.id, u]);
    await new Promise((r) => setTimeout(r, 3)); // distinct joined_at so "oldest member" is well defined
  }
  return { id: t.id as number, code };
}
export const size = async (teamId: number) =>
  (await pool.query("SELECT count(*)::int n FROM team_members WHERE team_id=$1", [teamId])).rows[0].n as number;
