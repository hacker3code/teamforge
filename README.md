![tests](https://github.com/hacker3code/teamforge/actions/workflows/ci.yml/badge.svg)
# TeamForge

Race-proof team formation for a 10,000-person hackathon. When 50 people click "join" on the last seat, exactly one gets it.

**Stack:** Node 20+, Fastify, PostgreSQL, plain HTML/CSS/JS (no build step), Server-Sent Events.

## Run it locally (4 commands)

```
docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
npm install
npm run setup      # creates the tables (re-running wipes the data)
npm start          # http://localhost:3000
```

Optional: `npm run seed` (10,000 users, 2,000 teams; logins `user1@seed.dev` … password `password123`), `npm test`, `npm run load` (writes `load-report.md`).

## How the race is prevented

1. Every change starts with `SELECT … FROM teams WHERE … FOR UPDATE`. Requests for the same team queue up inside Postgres.
2. Behind that lock sit database rules: `UNIQUE (hackathon_id, user_id)` (one team per person) and `CHECK (member_count <= max_size)`.
3. Every function locks the team row first, so lock order never differs and deadlocks cannot form.
4. Transactions use one connection each, so waiting requests can't starve the pool.
5. Audit rows are written in the same transaction as the change.

Try it: open **Race Arena** in the app. The locked join gives 1 winner. The unlocked join overfills the team.

## Other rules

- **Idempotency:** every POST/DELETE from the UI sends an `Idempotency-Key`. Same key from the same user returns the saved response (`Idempotent-Replay: true`).
- **Invite codes:** 72 bits from `crypto.randomBytes`, expire after 48 h, rotatable; join attempts limited to 10/min per user and 40/min per IP.
- **Leader leaves:** the longest-standing member becomes leader. The last member leaving deletes the team.
- **Live updates:** `GET /api/stream` (SSE). Board and team pages refresh on their own.
- **Suggestions:** `GET /api/teams/:id/suggestions`, score = 0.7 × skills + 0.3 × time zone, breakdown and a plain-language reason returned.
- **Integrity checker:** `GET /api/verify` (5 invariants, all must be 0).

## Deploy free (Render + Neon)

1. Create a free Postgres at neon.tech and copy its connection string.
2. Push this repo to GitHub. On render.com create a **Web Service** from it: build `npm install`, start `npm start`.
3. Environment variables: `DATABASE_URL` (Neon string), `SECRET` (any long random text).
4. Once, from your computer: `DATABASE_URL="<neon string>" npm run setup` (and `npm run seed` for the load test).

Free tiers sleep when idle, so the first request can take about 30 seconds.

## Design notes and honest gaps

See `DESIGN.md`. Not done: chaos test, audit-log time travel, Docker Compose for the app itself, tracing. Rate limits and SSE are in memory, so they assume one server instance.

## More commands

- `docker compose up --build`: the whole app plus database in one command (http://localhost:3000).
- `npm run chaos`: starts the server, fires 400 joins at 20 teams, kills it with SIGKILL mid-flight, restarts it, then runs the integrity checker. Wipes the database.
- **Minimum team size:** a team can be *finalized* (closed to newcomers) only when `min_size <= size <= max_size`. If a finalized team drops below the minimum it reopens automatically.
