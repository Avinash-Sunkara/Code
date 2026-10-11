import { Router } from 'express';
import { requireAdmin } from '../middleware/auth';
import content from './adminContent';
import extra from './adminExtra';

/** Everything under /api/v1/admin/* (except /admin/auth/login, mounted earlier) needs a signed-in ADMIN, re-verified against the DB. */
const r = Router();
r.use(requireAdmin);
r.use(content);
r.use(extra);
export default r;
