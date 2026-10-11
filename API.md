# API Reference

Base: `/api`. Auth = cookie session. `A` = admin only. Lists accept `page`, `limit`, `sort`, `order`, `q` and filters.

## Auth
POST `/auth/register` `{name,username,email,password}` · POST `/auth/login` `{email,password,remember}` · POST `/auth/logout` · POST `/auth/refresh`
POST `/auth/forgot-password` `{email}` · POST `/auth/reset-password` `{token,password}` · POST `/auth/change-password` · GET|POST `/auth/verify-email` · POST `/auth/resend-verification`
GET `/auth/me` · GET `/auth/google` `/auth/google/callback` · GET `/auth/github` `/auth/github/callback` (callbacks redirect to `FRONTEND_URL/auth/callback?status=success|error=…`)

## Me
GET `/users/me/activity?year=` · GET `/users/me/progress` · GET `/users/me/payments` · PATCH `/users/me` · POST `/users/me/study-sessions`
GET `/bookmarks?type=` · POST `/bookmarks/toggle` `{type,id}` · GET `/revision` · POST `/revision/:problemId/complete`
GET `/notifications/unread` · POST `/notifications/read` `{ids|all}` · GET `/notifications/stream` (SSE)

## DSA
GET `/sheets` · GET `/sheets/:slug?q&difficulty&bookmarked&status&topicId` · GET `/problems/:id`
POST `/problems/:id/solve` `{solved?,usedHint?,wrong?}` · `/bookmark` · `/revision` · `/note` `{note}`

## Learning content
GET `/core/categories` · `/core/categories/:slug?q` · `/core/topics/:slug`
GET `/aptitude/categories` · `/aptitude/topics/:slug` · `/aptitude/topics/:slug/questions` · POST `/aptitude/questions/:id/answer` `{choice}`
GET `/puzzles?pattern&difficulty&q` · `/puzzles/:slug`
GET `/notes` · `/notes/:id` · POST `/notes/:id/access` · GET `/cheatsheets` · `/cheatsheets/:id` · POST `/cheatsheets/:id/access` · POST `/resources/:id/access` · GET `/files/:kind/:id?token=`
GET `/roadmaps` · `/roadmaps/:id` · `/roadmaps/:id/progress` · POST `/roadmaps/:id/resources/:resourceId/complete`
GET `/interviews?status&difficulty&company&q&sort=newest|top` · `/interviews/:id` · POST `/interviews` · POST `/interviews/:id/like` · POST `/interviews/:id/comments` · DELETE `/interviews/comments/:commentId`

## Payments, public, search
POST `/payments` `{contentType,contentId}` · GET `/payments/:id` · POST `/payments/:id/proof` `{reference}` · POST `/payments/:id/verify` (Razorpay checkout) · POST `/payments/webhook`
GET `/public/stats` · `/public/testimonials` · `/public/companies` · POST `/feedback` · GET `/search?q=&type=&page=&limit=`
GET `/health` (no prefix)

## Admin (A)
GET `/admin/dashboard` · GET/PATCH/DELETE `/admin/users[/:id]` · POST `/admin/users/:id/block|unblock`
POST/GET `/admin/entitlements` `{emails[],contentType,contentId,expiresAt?}` · DELETE `/admin/entitlements/:id`
GET `/admin/payments?status=` · POST `/admin/payments/:id/approve|reject`
POST `/admin/uploads/presign` · GET/POST/DELETE `/admin/notifications` · GET `/admin/interview-comments` · DELETE `/admin/interview-comments/:id` · GET `/admin/feedback` · GET `/admin/audit-log`
CRUD (`GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`) for:
`/admin/sheets` `/topics` `/subtopics` `/problems` (with `companyIds[]`) `/companies` `/core-categories` `/core-patterns` `/core-topics` `/core-contents` `/aptitude-categories` `/aptitude-topics` `/aptitude-questions` `/puzzles` `/notes` `/cheatsheets` `/roadmaps` `/roadmap-sections` `/roadmap-topics` `/roadmap-resources` `/interviews` `/testimonials`
Publishing notes, cheat sheets, roadmaps or sheets automatically sends an "all users" notification.
