# Deployment runbook

Two targets, deployed in this order because each one needs the other's URL:

```
Render (API + Postgres)  ->  Vercel (client)  ->  Render (CLIENT_ORIGIN backfill)
```

Status markers: anything not executed yet is marked **pending**. Do not change a step to "done"
until the command next to it has actually returned the expected output. The live deployment was
verified on 2026-11-13 — evidence in §7.

## 0. What exists already

- API image builds and publishes to `ghcr.io/faisa1khan/issueflow` on every push to `main`
  (tags `main` and `sha-<short>`; there is no `latest`). The GHCR package is **private** by
  default, so pulling it elsewhere needs a token or a visibility change.
- `render.yaml` is a blueprint for one Docker web service plus one free Postgres.
- `client/vercel.json` carries the SPA rewrite and asset caching.
- The client reads `VITE_API_URL` at build time and appends `/graphql`. Unset, it falls back to a
  relative path that only works behind the Vite dev proxy.

## 1. Render — API and database  (**done 2026-11-13** — `issueflow-api-um3l.onrender.com`)

1. Sign in at <https://dashboard.render.com> with GitHub.
2. **New → Blueprint**, pick `Faisa1khan/issueflow`, branch `main`. Render reads `render.yaml`.
3. Apply. This creates `issueflow-api` (Docker) and `issueflow-db` (free Postgres), and wires
   `DATABASE_URL` from the database; `JWT_SECRET` is generated.
4. Wait for the first deploy. The service starts with:
   `npx prisma db push --skip-generate && node --import tsx src/index.ts`
   so the schema is created on boot — no separate migration step.
5. Verify:
   ```bash
   curl -s https://<service>.onrender.com/healthz          # {"ok":true}
   curl -s -X POST https://<service>.onrender.com/graphql \
     -H 'content-type: application/json' \
     -d '{"query":"{ __typename }"}'                        # {"data":{"__typename":"Query"}}
   ```
6. Copy the service URL — the Vercel build needs it in step 2.

Caveats: the free web service sleeps after ~15 minutes idle (first request afterwards takes
30–60 s), and a free Postgres instance is deleted after 30 days unless upgraded. For an interview
demo, open the URL once beforehand so the API is warm.

## 2. Vercel — client  (**done 2026-11-13** — `issueflow-kohl.vercel.app`)

1. <https://vercel.com/new> → Import Git Repository → `Faisa1khan/issueflow`.
2. Framework preset: **Vite**. **Root Directory: `client`** (this is the setting people miss; the
   repo root has no Vite project).
3. Build command `npm run build`, output directory `dist` — both come from `client/vercel.json`,
   but confirm they are shown.
4. Environment variable, Production **and** Preview:
   `VITE_API_URL = https://<service>.onrender.com` (no trailing slash).
5. Deploy. Vite inlines the variable at build time, so changing it later requires a redeploy.
6. Verify: open the deployment, sign up, create a workspace, create an issue, reload the page.
   A blank page with CORS errors in the console means step 3 below has not been done yet.

## 3. Backfill CORS on Render  (**done 2026-11-13**)

1. Render → `issueflow-api` → Environment → `CLIENT_ORIGIN`.
2. Value: the Vercel production origin, plus any preview origin you demo from, comma-separated:
   `https://issueflow.vercel.app,https://issueflow-git-main-faisa1khan.vercel.app`
3. Save — Render redeploys. Without this the browser blocks every call from Vercel.

## 4. Smoke test the live pair  (**done 2026-11-13**)

```bash
API=https://<service>.onrender.com

# health
curl -s $API/healthz

# sign up
curl -s -X POST $API/graphql -H 'content-type: application/json' -d '{
  "query":"mutation($i:SignUpInput!){signUp(input:$i){token user{id email}}}",
  "variables":{"i":{"email":"smoke@example.com","name":"Smoke","password":"correct-horse"}}}'

# sign in, then reuse the token below
curl -s -X POST $API/graphql -H 'content-type: application/json' -d '{
  "query":"mutation($i:SignInInput!){signIn(input:$i){token refreshToken}}",
  "variables":{"i":{"email":"smoke@example.com","password":"correct-horse"}}}'

# authenticated workspace + issue (paste TOKEN)
curl -s -X POST $API/graphql -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"query":"mutation{createWorkspace(name:\"smoke\"){id}}"}'
```

Then in the browser: sign in on the Vercel URL, create an issue, refresh — the session must
survive the reload (refresh-token rotation) and the list must still render.

## 5. Rollback

- Vercel: Deployments → previous deployment → **Promote to Production**. Instant, no rebuild.
- Render: Deploys → pick a previous deploy → **Rollback**. The database is untouched.
- Image: re-deploy any earlier `sha-` tag from GHCR; the schema is additive.

## 6. Known gaps

- Free Postgres expires after 30 days — a long-lived demo needs a paid plan or an external
  Postgres (Neon free tier works; set `DATABASE_URL` and remove the blueprint database).
- Rate limiting is per instance unless `REDIS_URL` is set; the free plan runs one instance, so the
  in-memory limiter is correct there but does not survive a restart.
- No email verification or password reset, so a demo account is created by signing up.

## 7. Verification record — 2026-11-13

Measured against the live pair, not inferred from the dashboard:

| Check | Result |
|---|---|
| `GET /healthz` | `200 {"ok":true}` in 0.25s |
| `POST /graphql` `{__typename}` | `200 {"data":{"__typename":"Query"}}` |
| CORS preflight from the Vercel origin | `204` + `access-control-allow-origin: https://issueflow-kohl.vercel.app` |
| Deployed bundle contains the API URL | `index-C5FSauWv.js` carries `https://issueflow-api-um3l.onrender.com` |
| Vercel SPA deep link | `GET /nonexistent-route` → `200` (rewrite works) |
| API flow | signUp → createWorkspace → createIssue → issues query, all `200` |
| Refresh rotation | `refreshSession` returns a new pair; replaying the old refresh token returns `REFRESH_REUSE` |
| Browser: sign up | account created, shell renders with the user's name |
| Browser: file an issue | issue created and listed (`OPEN`) |
| Browser: reload | issue still listed, session intact |
| Browser: expired access token | request 401s → interceptor refreshes → refresh token rotates → workspace and issue re-render |

Known gap found during this pass: **the UI has no workspace creation** — a new sign-up lands on
"No workspace yet. Create one through the API, then reload." A demo visitor hits a dead end until
that exists.
