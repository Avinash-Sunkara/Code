# RisingBrain Backend

Node.js · Express · TypeScript · PostgreSQL · Prisma. REST API for the Next.js frontend (Vercel); deploys to Render.

> **Verification status**
> - `tsc --noEmit` passes on all source files against the generated Prisma client.
> - `npm run test:smoke` boots the real Express app and passes 32 checks that need no database: routing, CORS, CSRF origin guard, auth rejection, validation, webhook HMAC verification, signed file tokens, PDF/image watermarking.
> - **Not yet exercised: anything that talks to PostgreSQL** (my sandbox could not download the Prisma query engine or run Postgres). Queries are type-checked and the schema validates, but run through the flows once against a real database (register → login → solve a problem → buy/grant content → open a note) before launch.

## Quick start
```bash
cp .env.example .env            # fill DATABASE_URL, JWT_SECRET (32+ chars), SESSION_SECRET, FRONTEND_URL
npm install
npx prisma migrate dev --name init   # creates src/prisma/migrations; COMMIT this folder (recommended)
npm run seed                          # optional starter categories
npm run dev                           # http://localhost:4000/health
```
`npm start` runs `scripts/migrate.js`: it applies committed migrations (`prisma migrate deploy`) if `src/prisma/migrations` exists, otherwise it creates the tables with `prisma db push` so a first deploy works. Commit real migrations before you have production data, because `db push` refuses destructive changes and is not a migration history.

## Deploy on Render
1. Push the repo; create a Blueprint from `render.yaml` (web service + Postgres), or create them manually.
2. Build: `npm ci --include=dev && npm run build`. Start: `npm start`. Health check: `/health`.
3. Set env vars from `.env.example`. Set `ADMIN_EMAIL` + `ADMIN_INITIAL_PASSWORD` (12+ chars) for the first admin; they are used only if no admin exists, and a password change is forced on first login. Remove the password var afterwards.
   To intentionally reset an existing admin, set `ADMIN_EMAIL` to that existing admin and `ADMIN_RESET_PASSWORD` to a new password (12+ chars), then run `npm run admin:reset-password` once. This revokes that admin's sessions and requires a password change at next sign-in. Remove `ADMIN_RESET_PASSWORD` afterwards. This command does not run during normal startup.
4. **Cookies across domains:** Vercel and Render are different sites, and Safari/Chrome increasingly block third-party cookies. Use custom domains under one parent (e.g. `app.example.com` and `api.example.com`) and set `COOKIE_DOMAIN=.example.com`. Set `FRONTEND_URL` to the exact frontend origin(s), comma-separated.
5. For the current Render deployment, set `GOOGLE_CALLBACK_URL=https://backend-yvzq.onrender.com/api/auth/google/callback` and `GITHUB_CALLBACK_URL=https://backend-yvzq.onrender.com/api/auth/github/callback`. Register each exact URL in its provider console. If callbacks are omitted, the API host comes from `API_URL` or Render's `RENDER_EXTERNAL_URL`; production refuses partially configured provider credentials or an OAuth configuration with no public callback base.

## Frontend integration
- Send every request with `credentials: 'include'`. Auth is HTTP-only cookies (`access_token` 15 min, `refresh_token` rotating, path `/api/auth`). On a 401 call `POST /api/auth/refresh` once, then retry.
- State-changing requests must come from an allowed origin (CSRF guard).
- Responses: `{success:true,data,message}` or `{success:false,error:{code,message,details?}}`.
- Notifications: the access cookie lasts 15 minutes, and `EventSource` does not retry after a 401, so on `error` call `POST /api/auth/refresh` and then reconnect. `EventSource(`${API}/api/notifications/stream`, {withCredentials:true})` and show each `notification` event for ~5 s; poll `GET /api/notifications/unread` as a fallback.
- Heatmap: `GET /api/users/me/activity?year=2026` → `data.days = [{date,count}]` plus `streak`.

## Protected content flow
`POST /api/notes/:id/access` (also `/cheatsheets/:id/access`, `/resources/:id/access`) → checks login, active status, published, entitlement → returns inline content, an external link, or a 5-minute signed stream URL → `GET /api/files/:kind/:id?token=…` re-checks authorisation, watermarks PDFs/images with the viewer's email and streams with `no-store`. Files live in private object storage; the DB stores only keys. Admin uploads: `POST /api/admin/uploads/presign` → PUT the file → save the returned `key` as `fileKey`.
This deters casual copying; it cannot fully prevent screenshots or downloads.

## Payments
- `PAYMENT_PROVIDER=UPI_MANUAL`: server builds a UPI link from `UPI_PAYMENT_URL` with the server-side price; the user submits a UTR (`POST /api/payments/:id/proof`) → `MANUAL_REVIEW` → admin approves/rejects. Opening a UPI link never grants access.
- `PAYMENT_PROVIDER=RAZORPAY`: order created server-side; access is granted only after a verified webhook (`POST /api/payments/webhook`, HMAC over the raw body, amount check) or a verified checkout signature.
- Successful payments create a `ContentEntitlement`. Admin grants by email do too (held as pending until that email is verified).

## Design notes / deviations
- Prisma schema lives at `src/prisma/schema.prisma` (configured in `package.json`).
- Private files use `fileKey` (storage key) instead of a `fileUrl`. Storage supports any S3-compatible provider (S3, R2, B2, MinIO); Cloudinary is not implemented, but `services/storage.ts` is the single place to add it.
- Password hashing is bcrypt (cost 12). Real-time uses in-process SSE; with more than one instance, use polling or add Redis pub/sub.
- Extra models driven by the UI screenshots: `Puzzle`, `AptitudeQuestion/Attempt` (Notes + Practice tabs), `Testimonial`, `Feedback`, problem `gfgUrl`, topic `hint`/`tip`, interview `tags`/`isAnonymous`.
- User-submitted interview experiences are unpublished until an admin approves them.
- The "Courses" section on the landing page has no backend yet.
