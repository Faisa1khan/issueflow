# IssueFlow

A multi-tenant issue tracker API built to answer one interview question honestly: *show me a
Node.js service you wrote, end to end.* Apollo Server 4 for the graph, Prisma over PostgreSQL for
the data, JWT for identity, membership rows for authorization, DataLoader for the N+1 shape that
GraphQL invites, Vitest + Supertest for the boundary tests, Docker for the run.

**Status: local and verified. Not yet publicly deployed** — the deployment config ships in the repo
(`Dockerfile`, `docker-compose.yml`) and the public URL is the remaining step.

## Stack

| Layer | Choice |
|---|---|
| API | Apollo Server 4 on Express 4, TypeScript |
| Graph | SDL-first schema (`src/schema.graphql`), explicit field resolvers |
| Data | PostgreSQL 16 via Prisma 6 |
| Auth | bcrypt password hashes, HS256 JWT (7-day) |
| Authz | `Membership(userId, workspaceId, role)` — every workspace read goes through it |
| Batching | DataLoader for authors, comment counts and comment lists |
| Client | React 18 + Apollo Client 3 (Vite) |
| Tests | Vitest + Supertest against a real PostgreSQL instance |
| Runtime | Docker (node:22-alpine, non-root, multi-stage) |

## Run it

```bash
cp .env.example .env          # set JWT_SECRET
docker compose up --build     # postgres + api on :4000
open http://localhost:4000/graphql
```

Client:

```bash
cd client && npm install && npm run dev   # :5173, proxies /graphql to :4000
```

Tests need a database:

```bash
docker run -d --name issueflow-test-db \
  -e POSTGRES_USER=issueflow -e POSTGRES_PASSWORD=issueflow -e POSTGRES_DB=issueflow_test \
  -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgresql://issueflow:issueflow@localhost:5433/issueflow_test npx prisma db push
npm test
```

## Data model

```
User ──< Membership >── Workspace ──< Issue ──< Comment
                                          └── author: User
```

Every issue belongs to exactly one workspace. A user sees a workspace only through a membership
row; removing the row removes every read path at once, because there is no second way in.

## Architecture decisions

**ADR-1. Membership is the authorization primitive, not a role check on the user.**
Roles are per workspace, so a global `role` column on `User` would be wrong the moment somebody
belongs to two teams. `requireMembership(ctx, workspaceId)` is the only gate; `MEMBER` can read and
write issues, `OWNER`/`ADMIN` can add members. Cost: one extra query per entry point. Benefit: no
resolver can accidentally authorize on "is logged in".

**ADR-2. Cursor pagination on `(createdAt, id)`, not offset.**
Offset pagination duplicates and skips rows when new issues arrive between pages, which is exactly
what a busy tracker does. The cursor is the row id, ordered by `createdAt desc, id desc`; the query
fetches `first + 1` rows to compute `hasNextPage` without a second count query.

**ADR-3. DataLoader for authors and comment counts.**
`issues(first: 20)` would otherwise issue 20 user queries and 20 comment counts. The loaders batch
by request, so a page costs three queries regardless of page size. This is GraphQL's default
failure mode and the reason the batching lives in context, not in resolvers.

**ADR-4. SDL-first, not code-first.**
The schema is the contract that a client team reads; keeping it in one `.graphql` file makes the
diff reviewable and the generated docs honest. The tradeoff is resolver type-safety by hand — the
`tsc --noEmit` step is the guard.

**ADR-5. Errors carry codes, not prose.**
`UNAUTHENTICATED`, `FORBIDDEN`, `BAD_USER_INPUT`, `CONFLICT`, `NOT_FOUND`. A client should branch on
the code; the message is for humans. Plain thrown errors are mapped in `formatError` so an
authorization failure never arrives as an opaque 500.

**ADR-6. Tests hit a real database.**
The interesting failures here are relational (cross-tenant reads, cursor edges, unique membership),
and mocking Prisma would hide exactly those. The suite truncates and rebuilds state, so it is
deterministic without a transaction wrapper.

## Verified

- `npm test` — 7 tests passing (auth boundary, duplicate email, pagination across two pages,
  cross-tenant denial, comment counts, membership grant).
- `npx tsc -p tsconfig.json --noEmit` — clean.
- `docker build` — image builds; `docker compose up` — api and postgres healthy, `/healthz` 200.

## Limits, stated up front

- No refresh-token rotation; a 7-day JWT is the whole session story.
- No rate limiting or query-depth limit yet. Both are on the roadmap, and a public GraphQL endpoint
  wants them before it wants users.
- The client is a thin proof of the API, not a product surface.
