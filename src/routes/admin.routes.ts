import { Router } from 'express';
import { prisma } from '../config/db';
import { ok, page, E } from '../utils/http';
import { pageParams } from '../utils/pagination';
import { requireAdmin } from '../middleware/auth';
import { crudRouter } from '../repositories/crud';
import * as v from '../validators/admin';
import * as a from '../controllers/admin.controller';
import { buildRounds } from '../controllers/interviews.controller';
import { audit } from '../services/audit';

const r = Router();
r.use(requireAdmin); // every /api/admin/* route: authenticated + ADMIN role verified from the DB

// Overview, users, access, payments, uploads, moderation
r.get('/dashboard', a.dashboard);
r.get('/users', a.listUsers);
r.get('/users/:id', a.getUser);
r.patch('/users/:id', a.patchUser);
r.post('/users/:id/block', a.blockUser);
r.post('/users/:id/unblock', a.unblockUser);
r.delete('/users/:id', a.deleteUser);

r.post('/entitlements', a.grant);
r.get('/entitlements', a.listEntitlements);
r.delete('/entitlements/:id', a.revoke);

r.get('/payments', a.listPayments);
r.post('/payments/:id/approve', a.approvePayment);
r.post('/payments/:id/reject', a.rejectPaymentH);

r.post('/uploads/presign', a.presign);

r.get('/notifications', async (req, res) => {
  const p = pageParams(req.query);
  const [items, total] = await Promise.all([prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }), prisma.notification.count()]);
  page(res, items, total, p.page, p.limit);
});
r.post('/notifications', a.createNotificationH);
r.delete('/notifications/:id', async (req, res) => {
  await prisma.notification.delete({ where: { id: req.params.id } });
  await audit(req, 'notification.delete', 'Notification', req.params.id);
  ok(res, {}, 'Deleted');
});

r.get('/interview-comments', a.listComments);
r.delete('/interview-comments/:id', a.deleteComment);
r.get('/feedback', a.listFeedback);
r.get('/audit-log', a.listAudit);

// ───── DSA CMS ─────
const recountSheets = async () => {
  await prisma.$executeRaw`UPDATE "DSASheet" s SET "totalProblems" = (SELECT COUNT(*) FROM "Problem" p JOIN "DSATopic" t ON p."topicId" = t.id WHERE t."sheetId" = s.id AND p."isPublished" = true)`;
};
r.use('/sheets', crudRouter({ model: 'dSASheet', entity: 'DSASheet', create: v.sheetS, slugFrom: 'name', searchFields: ['name'], filterFields: ['isPublished'], defaultSort: 'order', defaultDir: 'asc',
  notify: (s) => ({ title: 'New DSA Sheet Added', message: `${s.name} is now available` }) }));
r.use('/topics', crudRouter({ model: 'dSATopic', entity: 'DSATopic', create: v.topicS, slugFrom: 'name', slugScope: (d) => ({ sheetId: d.sheetId }), searchFields: ['name'], filterFields: ['sheetId'], defaultSort: 'order', defaultDir: 'asc', afterWrite: recountSheets }));
r.use('/subtopics', crudRouter({ model: 'dSASubtopic', entity: 'DSASubtopic', create: v.subtopicS, slugFrom: 'name', slugScope: (d) => ({ topicId: d.topicId }), searchFields: ['name'], filterFields: ['topicId'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/problems', crudRouter({
  model: 'problem', entity: 'Problem', create: v.problemS, slugFrom: 'title', searchFields: ['title', 'pattern'],
  filterFields: ['topicId', 'subtopicId', 'difficulty', 'isPublished', 'isPremium'], sortable: ['title', 'difficulty'], defaultSort: 'order', defaultDir: 'asc',
  include: { companies: { include: { company: true } } },
  mapData: (d, _req, create) => {
    const { companyIds, ...rest } = d;
    if (companyIds === undefined) return rest;
    const links = companyIds.map((companyId: string) => ({ companyId }));
    return { ...rest, companies: create ? { create: links } : { deleteMany: {}, create: links } };
  },
  afterWrite: recountSheets,
}));
r.use('/companies', crudRouter({ model: 'company', entity: 'Company', create: v.companyS, slugFrom: 'name', searchFields: ['name'], sortable: ['name'], defaultSort: 'name', defaultDir: 'asc' }));

// ───── Core CS / Aptitude / Puzzles ─────
r.use('/core-categories', crudRouter({ model: 'coreCategory', entity: 'CoreCategory', create: v.coreCategoryS, slugFrom: 'name', searchFields: ['name'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/core-patterns', crudRouter({ model: 'corePattern', entity: 'CorePattern', create: v.corePatternS, slugFrom: 'name', slugScope: (d) => ({ categoryId: d.categoryId }), searchFields: ['name'], filterFields: ['categoryId'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/core-topics', crudRouter({ model: 'coreTopic', entity: 'CoreTopic', create: v.coreTopicS, slugFrom: 'name', searchFields: ['name'], filterFields: ['categoryId', 'patternId', 'isPublished'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/core-contents', crudRouter({ model: 'coreContent', entity: 'CoreContent', create: v.coreContentS, searchFields: ['title'], filterFields: ['topicId', 'isPublished'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/aptitude-categories', crudRouter({ model: 'aptitudeCategory', entity: 'AptitudeCategory', create: v.aptCategoryS, slugFrom: 'name', defaultSort: 'order', defaultDir: 'asc' }));
r.use('/aptitude-topics', crudRouter({ model: 'aptitudeTopic', entity: 'AptitudeTopic', create: v.aptTopicS, slugFrom: 'name', searchFields: ['name'], filterFields: ['categoryId', 'isPublished'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/aptitude-questions', crudRouter({ model: 'aptitudeQuestion', entity: 'AptitudeQuestion', create: v.aptQuestionS, searchFields: ['question'], filterFields: ['topicId', 'difficulty'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/puzzles', crudRouter({ model: 'puzzle', entity: 'Puzzle', create: v.puzzleS, slugFrom: 'title', searchFields: ['title', 'pattern'], filterFields: ['pattern', 'difficulty', 'isPublished'], defaultSort: 'order', defaultDir: 'asc' }));

// ───── Notes / Cheat sheets ─────
r.use('/notes', crudRouter({
  model: 'note', entity: 'Note', create: v.noteS, slugFrom: 'title', searchFields: ['title', 'description'], filterFields: ['category', 'accessType', 'isPublished', 'contentType'], sortable: ['title', 'price'],
  mapData: (d, req, create) => (create ? { ...d, createdBy: req.user!.id } : d),
  notify: (n) => ({ title: 'New Notes Added', message: `${n.title} is now available` }),
}));
r.use('/cheatsheets', crudRouter({
  model: 'cheatSheet', entity: 'CheatSheet', create: v.cheatSheetS, slugFrom: 'title', searchFields: ['title', 'description'], filterFields: ['category', 'accessType', 'isPublished'], sortable: ['title', 'price'],
  mapData: (d, req, create) => (create ? { ...d, createdBy: req.user!.id } : d),
  notify: (n) => ({ title: 'New Cheat Sheet Available', message: `${n.title} is now available` }),
}));

// ───── Roadmaps ─────
r.use('/roadmaps', crudRouter({ model: 'roadmap', entity: 'Roadmap', create: v.roadmapS, slugFrom: 'title', searchFields: ['title'], filterFields: ['isPublished', 'isPremium'], defaultSort: 'order', defaultDir: 'asc',
  notify: (x) => ({ title: 'New Roadmap Added', message: `${x.title} roadmap is now available` }) }));
r.use('/roadmap-sections', crudRouter({ model: 'roadmapSection', entity: 'RoadmapSection', create: v.roadmapSectionS, searchFields: ['title'], filterFields: ['roadmapId'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/roadmap-topics', crudRouter({ model: 'roadmapTopic', entity: 'RoadmapTopic', create: v.roadmapTopicS, searchFields: ['title'], filterFields: ['sectionId'], defaultSort: 'order', defaultDir: 'asc' }));
r.use('/roadmap-resources', crudRouter({ model: 'roadmapResource', entity: 'RoadmapResource', create: v.roadmapResourceS, searchFields: ['title'], filterFields: ['topicId', 'type', 'isPremium'], defaultSort: 'order', defaultDir: 'asc' }));

// ───── Interviews / testimonials ─────
r.use('/interviews', crudRouter({
  model: 'interviewExperience', entity: 'InterviewExperience', create: v.interviewAdminS, slugFrom: 'title', searchFields: ['title', 'company', 'role'],
  filterFields: ['isPublished', 'status', 'difficulty', 'company'], include: { rounds: { orderBy: { roundNumber: 'asc' }, include: { questions: { orderBy: { order: 'asc' } } } }, _count: { select: { likes: true, comments: true } } },
  mapData: (d, req, create) => {
    const { rounds, ...rest } = d;
    if (!rounds) return rest;
    return { ...rest, ...(create ? { createdBy: req.user!.id } : {}), roundCount: rounds.length, rounds: create ? { create: buildRounds(rounds) } : { deleteMany: {}, create: buildRounds(rounds) } };
  },
}));
r.use('/testimonials', crudRouter({ model: 'testimonial', entity: 'Testimonial', create: v.testimonialS, searchFields: ['name', 'message'], filterFields: ['isPublished'], defaultSort: 'order', defaultDir: 'asc' }));

export default r;
