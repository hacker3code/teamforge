![tests](https://github.com/hacker3code/teamforge/actions/workflows/ci.yml/badge.svg)

# TeamForge

A team-formation service for a hackathon with 10,000 participants. People create teams, join with invite codes or by asking the leader, and see open seats on a live board. The main requirement is that when many people click "join" on the last seat at the same moment, exactly one of them gets it.

Live demo: https://teamforge-pzl0.onrender.com (free hosting, so the first load can take about 30 seconds)

Test logins, password `password123`: `user1@seed.dev` (leads a team) and `user6000@seed.dev` (no team). There is also a "Try it as a demo user" button on the sign-in page.

Stack: Node, Fastify, PostgreSQL, React 18 loaded from a CDN (no build step), server-sent events for live updates.

## How the race is handled

Every change to a team starts with `SELECT ... FOR UPDATE` on that team's row, so requests for the same team wait for each other inside Postgres. Two database rules sit behind it: one team per person (`UNIQUE (hackathon_id, user_id)`) and a size check on the team row. The lock is always taken on the team first, so transactions can't deadlock.

The Race Arena page in the app runs 50 simultaneous joins at the last seat, once with the lock and once without. With the lock there is always one winner. Without it the team overfills (23 of 4 on my laptop, 15 of 4 on the live server; the number changes with timing).

## Tests and results

- 29 automated tests, including the 50-way race, run by GitHub Actions on every push.
- Load test on `GET /api/board`, 100 concurrent users, 10,000 users and 2,000 teams: p95 49.9 ms locally (`load-report.md`). The deployed result is in `load-report-live.md`.
- Chaos test (`npm run chaos`): the server is killed while joins are in flight, then restarted. Afterwards every seat is filled exactly once and all integrity checks show 0 problems.
- `GET /api/verify` re-counts the database and checks five rules, such as no team over its size and nobody on two teams.

## Rules implemented

- Team size between a minimum and a maximum. A leader can finalize a team only when the size is in range, and a finalized team that drops below the minimum reopens.
- One team per person. Invite codes expire after 48 hours and can be replaced.
- When the leader leaves, the longest-standing member becomes leader. When the last member leaves, the team is deleted.
- Only the leader can accept, decline or remove. Join attempts by code are rate limited, and every input is validated.
- Retried requests are safe: each write carries an `Idempotency-Key`, and a repeat returns the first answer.
- Every team change is written to an audit log in the same transaction.
- `GET /api/teams/:id/suggestions` ranks free people by skills and time zone (0.7 × skills + 0.3 × time zone) and returns the breakdown.

## Run it locally

Needs Node 20 or newer and Docker.

```
docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16
npm install
npm run setup
npm start
```

Then open http://localhost:3000.

- `npm run seed` creates 10,000 users and 2,000 teams.
- `npm test` runs the tests. `npm run chaos` runs the chaos test. Both wipe the database.
- `npm run load` runs the load test. Set `BASE` to test a deployed URL.
- `docker compose up --build` starts the app and a database together. I did not run this in CI.

`DATABASE_URL` and `SECRET` can be set as environment variables. The defaults point at the Docker database above.

## Deployment

A Render web service (Node, free) and a Render PostgreSQL database (free) in the same region. The web service uses the database's internal URL as `DATABASE_URL`. To load data, run `npm run setup` and `npm run seed` from a computer with `DATABASE_URL` set to the database's external URL. Don't run the tests or the chaos test with that variable set, because they wipe the database.

## What's missing

No time-travel view of the audit log, no tracing or metrics, and no optimistic UI. Rate limits and live-update delivery are kept in memory, so they assume a single server. More in `DESIGN.md`.
