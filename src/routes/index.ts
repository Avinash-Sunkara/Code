import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, optionalAuth } from '../middleware/auth';
import * as auth from '../controllers/auth.controller';
import * as users from '../controllers/users.controller';
import * as sheets from '../controllers/sheets.controller';
import * as learn from '../controllers/learn.controller';
import * as content from '../controllers/content.controller';
import * as roadmaps from '../controllers/roadmaps.controller';
import * as interviews from '../controllers/interviews.controller';
import * as me from '../controllers/me.controller';
import * as notifications from '../controllers/notifications.controller';
import * as payments from '../controllers/payments.controller';
import * as pub from '../controllers/public.controller';
import admin from './admin.routes';

const r = Router();
const strict = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } } });
const moderate = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down' } } });

// Auth
r.post('/auth/register', strict, auth.register);
r.post('/auth/login', strict, auth.login);
r.post('/auth/logout', auth.logout);
r.post('/auth/refresh', moderate, auth.refresh);
r.post('/auth/forgot-password', strict, auth.forgotPassword);
r.post('/auth/reset-password', strict, auth.resetPassword);
r.post('/auth/change-password', authenticate, strict, auth.changePassword);
r.route('/auth/verify-email').get(moderate, auth.verifyEmail).post(moderate, auth.verifyEmail);
r.post('/auth/resend-verification', authenticate, strict, auth.resendVerification);
r.get('/auth/me', authenticate, auth.me);
r.get('/auth/google', auth.googleStart);
r.get('/auth/google/callback', auth.googleCallback);
r.get('/auth/github', auth.githubStart);
r.get('/auth/github/callback', auth.githubCallback);

// Current user
r.get('/users/me/activity', authenticate, users.activity);
r.get('/users/me/progress', authenticate, users.progress);
r.get('/users/me/payments', authenticate, users.myPayments);
r.patch('/users/me', authenticate, users.updateProfile);
r.post('/users/me/study-sessions', authenticate, users.studySession);

// DSA
r.get('/sheets', optionalAuth, sheets.listSheets);
r.get('/sheets/:slug', optionalAuth, sheets.getSheet);
r.get('/problems/:id', optionalAuth, sheets.getProblem);
r.post('/problems/:id/solve', authenticate, sheets.solve);
r.post('/problems/:id/bookmark', authenticate, sheets.toggleBookmark);
r.post('/problems/:id/revision', authenticate, sheets.toggleRevision);
r.post('/problems/:id/note', authenticate, sheets.saveNote);

// Core CS / Aptitude / Puzzles
r.get('/core/categories', learn.coreCategories);
r.get('/core/categories/:slug', optionalAuth, learn.coreCategory);
r.get('/core/topics/:slug', optionalAuth, learn.coreTopic);
r.get('/aptitude/categories', optionalAuth, learn.aptitudeCategories);
r.get('/aptitude/topics/:slug', optionalAuth, learn.aptitudeTopic);
r.get('/aptitude/topics/:slug/questions', optionalAuth, learn.aptitudeQuestions);
r.post('/aptitude/questions/:id/answer', authenticate, moderate, learn.answerQuestion);
r.get('/puzzles', optionalAuth, learn.listPuzzles);
r.get('/puzzles/:slug', optionalAuth, learn.getPuzzle);

// Notes / cheat sheets / protected files
r.get('/notes', optionalAuth, content.listNotes);
r.get('/notes/:id', optionalAuth, content.noteMeta);
r.post('/notes/:id/access', authenticate, moderate, content.requestAccess('note'));
r.get('/cheatsheets', optionalAuth, content.listCheatSheets);
r.get('/cheatsheets/:id', optionalAuth, content.cheatSheetMeta);
r.post('/cheatsheets/:id/access', authenticate, moderate, content.requestAccess('cheatsheet'));
r.post('/resources/:id/access', authenticate, moderate, content.requestAccess('resource'));
r.get('/files/:kind/:id', moderate, content.streamFile); // short-lived signed token, re-authorised on every request

// Roadmaps
r.get('/roadmaps', optionalAuth, roadmaps.listRoadmaps);
r.get('/roadmaps/:id', optionalAuth, roadmaps.getRoadmap);
r.get('/roadmaps/:id/progress', authenticate, roadmaps.roadmapProgress);
r.post('/roadmaps/:id/resources/:resourceId/complete', authenticate, roadmaps.completeResource);

// Interviews
r.get('/interviews', optionalAuth, interviews.list);
r.post('/interviews', authenticate, strict, interviews.submit);
r.delete('/interviews/comments/:commentId', authenticate, interviews.deleteOwnComment);
r.get('/interviews/:id', optionalAuth, interviews.get);
r.post('/interviews/:id/like', authenticate, moderate, interviews.like);
r.post('/interviews/:id/comments', authenticate, moderate, interviews.comment);

// Bookmarks / revision
r.get('/bookmarks', authenticate, me.listBookmarks);
r.post('/bookmarks/toggle', authenticate, me.toggleBookmark);
r.get('/revision', authenticate, me.revisionList);
r.post('/revision/:problemId/complete', authenticate, me.revisionComplete);

// Notifications
r.get('/notifications/unread', authenticate, notifications.unread);
r.post('/notifications/read', authenticate, notifications.markRead);
r.get('/notifications/stream', authenticate, notifications.stream);

// Payments (webhook is mounted in app.ts with a raw body parser)
r.post('/payments', authenticate, moderate, payments.create);
r.get('/payments/:id', authenticate, payments.status);
r.post('/payments/:id/proof', authenticate, moderate, payments.submitProof);
r.post('/payments/:id/verify', authenticate, moderate, payments.verifyCheckout);

// Public + search
r.get('/public/stats', pub.stats);
r.get('/public/testimonials', pub.testimonials);
r.get('/public/companies', pub.companies);
r.post('/feedback', optionalAuth, moderate, pub.feedback);
r.get('/search', optionalAuth, moderate, pub.search);

// Admin
r.use('/admin', admin);

export default r;
