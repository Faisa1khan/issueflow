# IssueFlow

[![ci](https://github.com/Faisa1khan/issueflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Faisa1khan/issueflow/actions/workflows/ci.yml)

A multi-tenant issue tracker API: Apollo Server 4 on Express, GraphQL, Prisma over PostgreSQL,
JWT access tokens with rotating refresh tokens, membership-based authorization, DataLoader
batching, cursor pagination, rate limiting and a query-depth guard. React + Apollo Client on top,
Vitest against a real database, Docker for the run.

It exists to answer one interview question with code rather than adjectives: *show me a Node.js
service you wrote, end to end.*

![IssueFlow board](docs/screenshots/board.png)

## Architecture

```mermaid
flowchart LR
  subgraph client [React client]
    UI[App.tsx]
    AC[Apollo Client<br/>auth + refresh links]
  end

  subgraph api [Node.js API]
    RL[rate limiter<br/>Redis or memory]
    GQL[Apollo Server 4]
    DL[depth limit<br/>max 8]
    CTX[context<br/>JWT to userId]
    RES[resolvers]
    AUTHZ[requireMembership]
    LOAD[DataLoader<br/>authors, comment counts]
  end

  DB[(PostgreSQL 16)]
  REDIS[(Redis)]

  UI --> AC -->|POST /graphql| RL --> GQL --> DL --> CTX --> RES
  RES --> AUTHZ --> DB
  RES --> LOAD --> DB
  RL -. counters .-> REDIS
```

### One request, end to end

Priya files an issue:

1. Apollo Client attaches the access token (`client/src/client.ts`).
2. The rate limiter consumes one point keyed by user id, falling back to IP (`src/rateLimit.ts`).
3. Apollo parses the document; the depth plugin rejects anything deeper than 8 before execution
   (`src/depthLimit.ts`).
4. The context resolves the JWT to a `userId` (`src/auth.ts`, `src/app.ts`).
5. The resolver calls `requireMembership(ctx, workspaceId)` — the single authorization gate.
6. Prisma writes the row. On reads, DataLoader collapses author and comment-count lookups so a
   20-issue page costs 3 queries instead of 41.

## Security model

**Authentication.** Passwords are bcrypt-hashed. Access tokens are HS256 JWTs with a 15-minute
life. Refresh tokens are 32 random bytes, stored **only as a SHA-256 hash**, and rotate on every
use.

**Reuse detection.** If a refresh token that was already rotated is presented again, the entire
token family is revoked — the signature of a stolen token being replayed. The client sends one
refresh at a time for the same reason (`client/src/client.ts`).

**Authorization.** Roles live on `Membership(userId, workspaceId, role)`, never on `User`. Every
workspace-scoped resolver calls `requireMembership`; there is no second read path. A test asserts
that a non-member receives `FORBIDDEN`.

**Abuse controls.** 120 requests/minute per caller with `X-RateLimit-*` headers and `429` +
`Retry-After`. Redis makes the counter hold across replicas; the in-memory limiter is the fallback.
Queries deeper than 8 fields are rejected with `QUERY_TOO_DEEP` before any database work.

**Error contract.** `UNAUTHENTICATED`, `FORBIDDEN`, `BAD_USER_INPUT`, `CONFLICT`, `NOT_FOUND`,
`REFRESH_EXPIRED`, `REFRESH_REUSED`, `TOO_MANY_REQUESTS`, `QUERY_TOO_DEEP`. Clients branch on the
code; messages are for humans.

## API

| Query | Returns |
|---|---|
| `me` | the current user, or `null` |
| `workspaces` | workspaces the caller belongs to, with role and issue count |
| `workspace(slug)` | one workspace, only if the caller is a member |
| `issues(workspaceId, first, after, status)` | cursor-paginated connection |
| `issue(id)` | one issue, membership-checked |

| Mutation | Notes |
|---|---|
| `signUp`, `signIn` | return `token`, `refreshToken`, `user` |
| `refreshSession(token)` | rotates; reuse revokes the family |
| `signOut(token)` | revokes the family |
| `createWorkspace(name)` | caller becomes `OWNER` |
| `addMember(workspaceId, email, role)` | `OWNER`/`ADMIN` only |
| `createIssue`, `setIssueStatus`, `addComment` | membership required |

Full SDL: [`src/schema.graphql`](src/schema.graphql). Playground at `/graphql` when running locally.

## Data model

```
User ──< Membership >── Workspace ──< Issue ──< Comment
  └──< RefreshToken (hash, family, expiry, revokedAt)
```

Every issue belongs to one workspace. Access is a membership row, so removing it closes every
read path at once.

## Run it

```bash
cp .env.example .env          # set JWT_SECRET
docker compose up --build     # postgres + redis + api on :4000
```

Client:

```bash
cd client && npm install && npm run dev    # :5173, proxies /graphql to :4000
```

Tests need a database:

```bash
docker run -d --name issueflow-test-db \
  -e POSTGRES_USER=issueflow -e POSTGRES_PASSWORD=issueflow -e POSTGRES_DB=issueflow_test \
  -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgresql://issueflow:issueflow@localhost:5433/issueflow_test npx prisma db push
npm test
```

## Tests

15 integration tests against real PostgreSQL:

- auth boundary: unauthenticated query, duplicate email, sign-up/sign-in/me
- tenancy: pagination across two pages, non-member `FORBIDDEN`, membership grant
- comments: counts and authors through DataLoader
- depth: fragment-aware counting, `__typename` ignored, over-limit rejected
- rate limit: budget honoured, then `429` with `Retry-After`
- refresh: rotation, replay kills the family, sign-out revokes, only hashes stored

## Architecture decisions

**ADR-1. Membership is the authorization primitive.** Roles are per workspace, so a global role
column would break the moment someone belongs to two teams. One gate, six call sites.

**ADR-2. Cursor pagination on `(createdAt, id)`.** Offset pagination duplicates or skips rows when
new issues arrive between pages. `take: first + 1` computes `hasNextPage` without a count query.

**ADR-3. DataLoader in context, not resolvers.** GraphQL's default failure mode is N+1. Batching
per request turns a 20-issue page into 3 queries.

**ADR-4. SDL-first.** The schema is the contract a client team reads; one `.graphql` file keeps the
diff reviewable. The tradeoff is hand-written resolver types, guarded by `tsc --noEmit`.

**ADR-5. Refresh rotation with reuse detection.** Stateless refresh tokens cannot be revoked.
Storing hashes with a family id makes revocation and theft detection possible, at the cost of one
write per refresh.

**ADR-6. Depth limit at validation time.** A resolver-level guard still pays for parsing and can be
bypassed by fragments. The plugin runs after document resolution and before execution.

**ADR-7. Rate limit keyed by user, not IP.** A shared NAT should not be one bucket, and one noisy
tenant should not spend another's budget.

**ADR-8. Errors carry codes.** A client should branch on `FORBIDDEN`, not on prose.

**ADR-9. Redis optional.** The limiter degrades to in-memory when `REDIS_URL` is absent, so local
development needs no extra service while production stays correct across replicas.

**ADR-10. Tests hit a real database.** Cross-tenant reads, cursor edges and unique membership are
relational failures; mocking Prisma would hide exactly those.

## Deployment

Live: **https://issueflow-kohl.vercel.app** (client, Vercel) → **https://issueflow-api-um3l.onrender.com**
(API + Postgres, Render).

The image is published to GHCR on every push to `main` (`publish.yml`) and runs as a non-root user.
`render.yaml` describes the Render web service plus managed PostgreSQL; the client deploys to Vercel.
The step-by-step runbook, including env vars and smoke tests, is in `docs/DEPLOY.md`.

Note: both services are on free tiers — the API sleeps after ~15 minutes idle, and the free
Postgres instance expires after 30 days.

## Limits

- No email verification or password reset yet.
- Rate limiting is per instance unless `REDIS_URL` is set.
- The React client is a proof of the API, not a product surface.
- No subscriptions or file uploads.
