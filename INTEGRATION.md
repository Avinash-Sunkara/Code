# RisingBrain — frontend ↔ backend integration

## What was done
The frontend was built against `docs/API_CONTRACT.md` (base `/api/v1`, plain JSON, `{message, field?}` errors, `{items,total,page,pageSize,nextPage}` lists).
The backend served a different contract (`/api`, `{success,data}` envelope, different field names and routes). Instead of rewriting either side, the backend gained a
**`/api/v1` adapter layer** (`src/v1/*`) that implements the frontend's contract on top of the existing Prisma models and services. The legacy `/api/*` routes are untouched.

| Area | Backend file |
|---|---|
| Auth, profile, password, email verification, OAuth start | `src/v1/auth.ts` |
| DSA sheets/topics/problems, progress, bookmarks, revision | `src/v1/dsa.ts` |
| Core CS + Aptitude (notes, practice, completion) | `src/v1/learn.ts` |
| Notes / cheat sheets + protected viewer (watermarked PDF stream) | `src/v1/content.ts` |
| Roadmaps | `src/v1/roadmaps.ts` |
| Interviews (list, detail, like, comments, submit) | `src/v1/interviews.ts` |
| Payments (checkout, status, UTR proof) | `src/v1/payments.ts` |
| Dashboard, search | `src/v1/home.ts` |
| Activity, purchases, avatar, popups, public landing data | `src/v1/me.ts` |
| Admin CRUD (DSA, Core, Aptitude, notes, cheat sheets, roadmaps, interviews, notifications, testimonials) | `src/v1/adminContent.ts`, `adminExtra.ts`, `adminKit.ts` |
| Admin users, entitlements, payments review, analytics, settings, founder | `src/v1/adminExtra.ts` |

Schema additions (new migration needed): `DSASubtopic.description/tip`, `Problem.tags/hints/images`, `Testimonial.avatarUrl`, `Roadmap/RoadmapSection/RoadmapTopic.icon`,
`Notification.publishedAt/durationSeconds`, and models `Course`, `SiteSetting`, `TopicCompletion`, `UserRoadmapNode`. New dependency: `multer`.

Other fixes: refresh cookie path `/api/auth` → `/api` (the frontend refreshes through `/api/v1/auth/refresh`); frontend now refreshes the session on `/auth/me`;
OAuth callback page, email-verification page, admin Payments page, UTR submission step and Razorpay checkout in `AccessGate`, GeeksforGeeks link on problem rows;
admin forms adjusted where the backend model has no such field (e.g. Aptitude has no patterns, Core CS topics have no price).

## Setup
Backend
```
cd risingbrain-backend
cp .env.example .env     # DATABASE_URL, JWT_SECRET (32+), SESSION_SECRET, FRONTEND_URL, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD (12+), PAYMENT_PROVIDER + UPI_PAYMENT_URL or Razorpay keys, STORAGE_* for note/PDF uploads, SMTP_* for emails
npm install
npx prisma migrate dev --name v1_integration     # commit src/prisma/migrations
npm run seed
npm run typecheck && npm run test:smoke
npm run dev                                       # http://localhost:4000/health
```
Frontend
```
cd risingbrain-web
cp .env.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1   NEXT_PUBLIC_SITE_URL=http://localhost:3000
npm install
npm run typecheck && npm run build && npm run dev
node scripts/check-api.mjs     # optional: checks the running backend against the contract
```
Production: Vercel (frontend) + Render (backend). Use custom domains under one parent (`app.example.com`, `api.example.com`) and set `COOKIE_DOMAIN=.example.com`, otherwise browsers block the auth cookies.
`FRONTEND_URL` must equal the exact frontend origin. For the current Render deployment, set `GOOGLE_CALLBACK_URL=https://backend-yvzq.onrender.com/api/auth/google/callback` and `GITHUB_CALLBACK_URL=https://backend-yvzq.onrender.com/api/auth/github/callback`; register each exact URL in the corresponding provider console.

## Not verified / not built — read before launch
* **Nothing was compiled or run.** The sandbox had no network, so no `npm install`, no Prisma client, no database. New files were only syntax-checked. Expect some type errors on the first `npm run typecheck`; they will be small but real.
* **Never exercised against PostgreSQL** (same as the original backend README says). Walk register → login → solve → bookmark → open a note → admin CRUD → payment approve before launch.
* **Content is not included.** The app shows only what is in the database. The 620 problems, notes, interviews, etc. must be entered through the admin panel or a seed script.
* **Payments:** manual UPI is implemented end to end (link → user submits UTR → admin approves on `/admin/payments`). Razorpay checkout is wired but untested and needs keys + webhook. Individual DSA problems and Core CS topics cannot be sold (only admin-granted / free).
* **Courses and Puzzles are now built** (not yet compiled or run, like everything else here). Courses: new `Course` model (included in the `v1_integration` migration), `GET /api/v1/public/courses`, admin CRUD at `/admin/courses`, a landing-page section that stays hidden until a course is published. It is a showcase; the button goes to the link you set (or to sign-up), there is no in-app course purchase. Puzzles: `src/v1/puzzles.ts`, admin CRUD at `/admin/puzzles`, `/puzzles` and `/puzzles/[slug]` pages and a sidebar entry. Puzzles are always free; any legacy premium-flagged puzzle is hidden from the v1 app.
* **Still not built:** per-page text search inside non-PDF notes.
* Roadmap progress is tracked per topic/section; multi-image note uploads are merged into one PDF; logos/avatars/previews are stored inline as small WebP data URLs.

## Sign-in: what was fixed, and what you must configure
**Fixed**
* The bootstrap admin is created with a temporary password and the API blocks every admin request until it is changed, but the UI had no screen for that, so the panel just failed. The admin layout now shows a one-time "Set a new admin password" form first.
* Admin pages sent signed-out visitors to the user login; they now go to `/admin/login`.
* Register / reset / profile forms now use the backend's password rule (8+ characters, upper + lower case, a number) and username rule (3-30 letters, numbers, `_`); server-side validation errors appear on the right field.
* Two tabs refreshing at once no longer sign you out everywhere (a 15-second grace window replaces the "token theft" revoke-all). Login and reset limits count failed attempts only, so one college network can't lock itself out; register is capped at 100/hour/IP.
* `http://127.0.0.1:3000` is accepted next to `http://localhost:3000` in development (CORS and CSRF check).
* Google / GitHub: error messages now match the codes the backend sends; cancelling at the provider shows "Sign-in was cancelled"; the `?next=` page is restored after sign-in; buttons only appear for providers that have credentials (`GET /api/v1/auth/providers`); an unconfigured provider redirects to the app's error page instead of showing raw JSON; usernames never become `admin`/`support`/etc.; if an unverified, password-registered account is later claimed through Google/GitHub, its password and sessions are wiped (blocks pre-registration takeover).

**Google**: Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application). Authorized redirect URI = `GOOGLE_CALLBACK_URL` exactly (local: `http://localhost:4000/api/auth/google/callback`). Put the client ID/secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Consent screen scopes: openid, email, profile.
**GitHub**: Settings > Developer settings > OAuth Apps > New. Authorization callback URL = `GITHUB_CALLBACK_URL` (local: `http://localhost:4000/api/auth/github/callback`). Put the values in `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. GitHub users with no verified email cannot sign in.
Restart the API after changing `.env`. Neither provider has been exercised against real credentials.

**Cookies in production.** Frontend and API on unrelated domains (e.g. `*.vercel.app` + `*.onrender.com`) means the sign-in cookies are third-party and Safari/Chrome may drop them. Two fixes: (a) custom domains under one parent + `COOKIE_DOMAIN=.example.com` (as above), or (b) same-origin mode: frontend `NEXT_PUBLIC_API_URL=/api/v1` and `API_PROXY_TARGET=https://<api host>`; backend `FRONTEND_URL=https://<frontend host>`, `TRUST_PROXY_HOPS=2`, `COOKIE_SAMESITE=lax`, empty `COOKIE_DOMAIN`, and OAuth callback URLs on the frontend host (`https://<frontend host>/api/auth/google/callback`, `/github/callback`).

**First admin login**: set `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` (12+ characters) before the first start, sign in at `/admin/login`, set the new password when asked. The admin is only created if no admin exists and that email is not already a registered user; if you registered that email first, use a different `ADMIN_EMAIL` (or promote the user in the database).
