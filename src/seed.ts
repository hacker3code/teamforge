// 10,000 users and 2,000 teams, built with bulk SQL so it finishes in a few seconds.
import { pool } from "./db";
import { hashPw } from "./auth";

await pool.query("TRUNCATE audit_log,idempotency_keys,join_requests,team_members,teams,users RESTART IDENTITY CASCADE");
await pool.query(
  `INSERT INTO users(name,email,password_hash,skills,utc_offset_minutes)
   SELECT 'Person '||g, 'user'||g||'@seed.dev', $1::text,
     ARRAY(SELECT DISTINCT (ARRAY['frontend','backend','design','ml','devops','mobile','product'])[1+floor(random()*7)::int] FROM generate_series(1,1+(g%3))),
     (floor(random()*25)::int-12)*60
   FROM generate_series(1,10000) g`, [hashPw("password123")]);
await pool.query(
  `INSERT INTO teams(hackathon_id,name,leader_id,max_size,needs,invite_code,invite_expires)
   SELECT 1,'Team '||g, g, 4, ARRAY[(ARRAY['frontend','backend','design','ml','devops','mobile','product'])[1+floor(random()*7)::int]],
     md5(random()::text||g), now()+interval '48 hours' FROM generate_series(1,2000) g`);
await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) SELECT g,g,1 FROM generate_series(1,2000) g");
await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) SELECT g-2000,g,1 FROM generate_series(2001,4000) g");
await pool.query("INSERT INTO team_members(team_id,user_id,hackathon_id) SELECT g-4000,g,1 FROM generate_series(4001,5000) g");
await pool.query("UPDATE teams t SET member_count=(SELECT count(*) FROM team_members m WHERE m.team_id=t.id)");
console.log("seeded: 10000 users (user1@seed.dev … password123), 2000 teams, 5000 people still free");
await pool.end();
