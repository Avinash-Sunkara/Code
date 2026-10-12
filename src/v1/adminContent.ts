import { Router } from 'express';
import { prisma } from '../config/db';
import { ApiError } from '../utils/http';
import { uniqueSlug } from '../utils/slug';
import { logger } from '../config/logger';
import { CheatSheetCategory } from '@prisma/client';
import { diffIn, diffOut } from './util';
import { renderBody } from './content';
import {
  Spec, accessIn, accessOut, allowedEmailsOf, arr, b, crud, filesOf, imageData, n, need, s, sn, storeDocument, syncAllowedEmails, urlOrNull,
} from './adminKit';
import * as storage from '../services/storage';

const r = Router();
const mount = (sp: Spec) => r.use(sp.path, crud(sp));
const fail = (m: string, code = 'INVALID') => new ApiError(422, code, m);

// ───── DSA ─────
const recountSheets = async () => {
  await prisma.$executeRaw`UPDATE "DSASheet" s SET "totalProblems" = (SELECT COUNT(*) FROM "Problem" p JOIN "DSATopic" t ON p."topicId" = t.id WHERE t.id = p."topicId" AND t."sheetId" = s.id AND p."isPublished" = true)`;
};

mount({
  path: '/dsa/sheets', model: 'dSASheet', entity: 'DSASheet', search: ['name'], orderBy: { order: 'asc' }, include: { _count: { select: { topics: true } } },
  publishField: 'isPublished', orderField: 'order',
  row: (x) => ({ id: x.id, title: x.name, slug: x.slug, description: x.description ?? '', order: x.order, published: x.isPublished, topicCount: x._count.topics, problemCount: x.totalProblems }),
  write: async (_q, d, create) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title);
    return { name, description: sn(d.description), order: n(d.order), isPublished: b(d.published), ...(create ? { slug: s(d.slug) || (await uniqueSlug('dSASheet', name!)) } : s(d.slug) ? { slug: s(d.slug) } : {}) };
  },
});

mount({
  path: '/dsa/topics', model: 'dSATopic', entity: 'DSATopic', search: ['name'], orderBy: [{ sheet: { order: 'asc' } }, { order: 'asc' }], include: { sheet: { select: { name: true } }, _count: { select: { problems: true } } },
  orderField: 'order', siblings: (x) => ({ sheetId: x.sheetId }),
  row: (x) => ({ id: x.id, title: x.name, sheetId: x.sheetId, sheetTitle: x.sheet.name, description: x.description ?? '', order: x.order, problemCount: x._count.problems }),
  write: async (_q, d, create, ex) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title);
    const sheetId = create ? need(s(d.sheetId), 'Sheet') : s(d.sheetId);
    return { name, sheetId, description: sn(d.description), order: n(d.order), ...(create ? { slug: await uniqueSlug('dSATopic', name!, { sheetId }) } : {}), ...(ex && !create ? {} : {}) };
  },
});

mount({
  path: '/dsa/subtopics', model: 'dSASubtopic', entity: 'DSASubtopic', search: ['name'], orderBy: [{ topic: { order: 'asc' } }, { order: 'asc' }], include: { topic: { select: { name: true } }, _count: { select: { problems: true } } },
  orderField: 'order', siblings: (x) => ({ topicId: x.topicId }),
  row: (x) => ({ id: x.id, title: x.name, topicId: x.topicId, topicTitle: x.topic.name, description: x.description ?? '', tip: x.tip ?? '', order: x.order, problemCount: x._count.problems }),
  write: async (_q, d, create) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title);
    const topicId = create ? need(s(d.topicId), 'Topic') : s(d.topicId);
    return { name, topicId, description: sn(d.description), tip: sn(d.tip), order: n(d.order), ...(create ? { slug: await uniqueSlug('dSASubtopic', name!, { topicId }) } : {}) };
  },
});

mount({
  path: '/dsa/problems', model: 'problem', entity: 'Problem', search: ['title', 'pattern'], orderBy: [{ topic: { sheet: { order: 'asc' } } }, { topic: { order: 'asc' } }, { order: 'asc' }],
  include: { topic: { select: { name: true } }, companies: { select: { companyId: true } } }, publishField: 'isPublished', orderField: 'order', siblings: (x) => ({ topicId: x.topicId }),
  row: async (x) => ({
    id: x.id, number: x.order + 1, title: x.title, difficulty: diffOut(x.difficulty), order: x.order, topicId: x.topicId, topicTitle: x.topic.name, subtopicId: x.subtopicId ?? '',
    pattern: x.pattern ?? '', tags: x.tags, leetcodeUrl: x.leetcodeUrl ?? '', gfgUrl: x.gfgUrl ?? '', youtubeUrl: x.youtubeUrl ?? '', companyIds: x.companies.map((c: any) => c.companyId),
    description: x.description ?? '', quickNotes: x.quickRevision ?? '', adminNotes: x.adminNotes ?? '', hints: x.hints,
    access: x.isPremium ? 'PRIVATE' : 'FREE', allowedEmails: x.isPremium ? await allowedEmailsOf('PROBLEM', x.id) : [], published: x.isPublished,
  }),
  write: async (req, d, create) => {
    const title = create ? need(s(d.title), 'Title') : s(d.title);
    const diff = d.difficulty === undefined ? (create ? 'MEDIUM' : undefined) : diffIn(d.difficulty);
    if (d.difficulty !== undefined && !diff) throw fail('Difficulty must be Easy, Medium or Hard');
    const imgs = filesOf(req, 'images');
    const access = s(d.access);
    if (access === 'PREMIUM') throw fail('Individual problems cannot be sold; use "Free only for selected email addresses"');
    return {
      title, difficulty: diff, order: n(d.order), topicId: create ? need(s(d.topicId), 'Topic') : s(d.topicId), subtopicId: sn(d.subtopicId), pattern: sn(d.pattern), tags: arr(d.tags),
      leetcodeUrl: urlOrNull(d.leetcodeUrl), gfgUrl: urlOrNull(d.gfgUrl), youtubeUrl: urlOrNull(d.youtubeUrl), description: sn(d.description), quickRevision: sn(d.quickNotes), adminNotes: sn(d.adminNotes), hints: arr(d.hints),
      isPremium: access === undefined ? undefined : access === 'PRIVATE', isPublished: b(d.published),
      ...(imgs.length ? { images: await Promise.all(imgs.map((f) => imageData(f, 1400))) } : {}),
      ...(create ? { slug: await uniqueSlug('problem', title!) } : {}),
      ...(d.companyIds !== undefined ? { companies: { ...(create ? {} : { deleteMany: {} }), create: (arr(d.companyIds) ?? []).map((companyId) => ({ companyId })) } } : {}),
    };
  },
  after: async (item, d, req) => {
    if (d.access === 'PRIVATE') await syncAllowedEmails('PROBLEM', item.id, arr(d.allowedEmails) ?? [], req.user!.id);
    else if (d.access === 'FREE') await syncAllowedEmails('PROBLEM', item.id, [], req.user!.id);
    await recountSheets();
  },
  onDelete: recountSheets,
});

mount({
  path: '/companies', model: 'company', entity: 'Company', search: ['name'], orderBy: { name: 'asc' },
  row: (x) => ({ id: x.id, name: x.name, logoUrl: x.logoUrl ?? '' }),
  write: async (req, d, create) => {
    const name = create ? need(s(d.name), 'Company name') : s(d.name);
    const logo = filesOf(req, 'logo')[0];
    return { name, logoUrl: logo ? await imageData(logo, 160) : undefined, ...(create ? { slug: await uniqueSlug('company', name!) } : {}) };
  },
});

// ───── Core CS ─────
const CORE = '/core-cs';
mount({
  path: `${CORE}/categories`, model: 'coreCategory', entity: 'CoreCategory', search: ['name'], orderBy: { order: 'asc' }, include: { _count: { select: { topics: true } } }, orderField: 'order',
  row: (x) => ({ id: x.id, title: x.name, slug: x.slug, order: x.order, topicCount: x._count.topics }),
  write: async (_q, d, create) => { const name = create ? need(s(d.title), 'Title') : s(d.title); return { name, order: n(d.order), ...(create ? { slug: s(d.slug) || (await uniqueSlug('coreCategory', name!)) } : s(d.slug) ? { slug: s(d.slug) } : {}) }; },
});
mount({
  path: `${CORE}/patterns`, model: 'corePattern', entity: 'CorePattern', search: ['name'], orderBy: [{ category: { order: 'asc' } }, { order: 'asc' }], include: { category: { select: { name: true } }, _count: { select: { topics: true } } },
  orderField: 'order', siblings: (x) => ({ categoryId: x.categoryId }),
  row: (x) => ({ id: x.id, title: x.name, categoryId: x.categoryId, categoryTitle: x.category.name, order: x.order, topicCount: x._count.topics }),
  write: async (_q, d, create) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title); const categoryId = create ? need(s(d.categoryId), 'Category') : s(d.categoryId);
    return { name, categoryId, order: n(d.order), ...(create ? { slug: await uniqueSlug('corePattern', name!, { categoryId }) } : {}) };
  },
});
const coreHtml = (x: any) => x.contents.map((c: any) => (c.title ? `<h2>${c.title}</h2>\n${c.body}` : c.body)).join('\n');
mount({
  path: `${CORE}/topics`, model: 'coreTopic', entity: 'CoreTopic', search: ['name'], orderBy: [{ category: { order: 'asc' } }, { order: 'asc' }],
  include: { pattern: { select: { name: true } }, contents: { orderBy: { order: 'asc' } } }, publishField: 'isPublished', orderField: 'order', siblings: (x) => ({ patternId: x.patternId }),
  row: (x) => ({ id: x.id, title: x.name, patternId: x.patternId ?? '', patternTitle: x.pattern?.name ?? '', summary: x.summary ?? '', html: coreHtml(x), order: x.order, published: x.isPublished }),
  write: async (_q, d, create) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title);
    if (create) need(s(d.html), 'Notes content');
    let categoryId: string | undefined;
    const patternId = create ? need(s(d.patternId), 'Pattern') : s(d.patternId);
    if (patternId) { const p = await prisma.corePattern.findUnique({ where: { id: patternId }, select: { categoryId: true } }); if (!p) throw fail('Pattern not found'); categoryId = p.categoryId; }
    return { name, patternId, categoryId, summary: sn(d.summary), order: n(d.order), isPublished: b(d.published), ...(create ? { slug: await uniqueSlug('coreTopic', name!) } : {}) };
  },
  after: async (item, d) => {
    if (d.html === undefined) return;
    await prisma.coreContent.deleteMany({ where: { topicId: item.id } });
    await prisma.coreContent.create({ data: { topicId: item.id, title: '', body: String(d.html), order: 0, isPublished: true } });
  },
});
mount({
  path: `${CORE}/questions`, model: 'corePracticeQuestion', entity: 'CorePracticeQuestion', search: ['prompt'], orderBy: [{ topic: { name: 'asc' } }, { order: 'asc' }], include: { topic: { select: { name: true } } },
  publishField: 'isPublished', orderField: 'order', siblings: (x) => ({ topicId: x.topicId }),
  row: (x) => ({ id: x.id, topicId: x.topicId, topicTitle: x.topic.name, prompt: x.prompt, options: x.options, answerIndex: x.correctIndex, explanation: x.explanation ?? '', order: x.order, published: x.isPublished }),
  write: async (_q, d, create) => {
    const options = arr(d.options);
    const correct = n(d.answerIndex) ?? (create ? 0 : undefined);
    if (create) { need(s(d.prompt), 'Question'); need(options, 'Options'); }
    if (options && (options.length < 2 || options.length > 8)) throw fail('Provide between 2 and 8 options');
    if (options && correct !== undefined && (correct < 0 || correct >= options.length)) throw fail('The correct option number is out of range');
    if (create && correct === undefined) throw fail('Choose the correct option');
    return { topicId: create ? need(s(d.topicId), 'Topic') : s(d.topicId), prompt: s(d.prompt), options, correctIndex: correct, explanation: sn(d.explanation), order: n(d.order), isPublished: b(d.published) };
  },
});

// ───── Aptitude ─────
const APT = '/aptitude';
mount({
  path: `${APT}/categories`, model: 'aptitudeCategory', entity: 'AptitudeCategory', search: ['name'], orderBy: { order: 'asc' }, include: { _count: { select: { topics: true } } }, orderField: 'order',
  row: (x) => ({ id: x.id, title: x.name, slug: x.slug, order: x.order, topicCount: x._count.topics }),
  write: async (_q, d, create) => { const name = create ? need(s(d.title), 'Title') : s(d.title); return { name, order: n(d.order), ...(create ? { slug: s(d.slug) || (await uniqueSlug('aptitudeCategory', name!)) } : s(d.slug) ? { slug: s(d.slug) } : {}) }; },
});
mount({
  path: `${APT}/topics`, model: 'aptitudeTopic', entity: 'AptitudeTopic', search: ['name'], orderBy: [{ category: { order: 'asc' } }, { order: 'asc' }], include: { category: { select: { name: true } } },
  publishField: 'isPublished', orderField: 'order', siblings: (x) => ({ categoryId: x.categoryId }),
  row: (x) => ({ id: x.id, title: x.name, categoryId: x.categoryId, categoryTitle: x.category.name, html: x.notes ?? '', order: x.order, published: x.isPublished }),
  write: async (_q, d, create) => {
    const name = create ? need(s(d.title), 'Title') : s(d.title);
    return { name, categoryId: create ? need(s(d.categoryId), 'Category') : s(d.categoryId), notes: sn(d.html), order: n(d.order), isPublished: b(d.published), ...(create ? { slug: await uniqueSlug('aptitudeTopic', name!) } : {}) };
  },
});
mount({
  path: `${APT}/questions`, model: 'aptitudeQuestion', entity: 'AptitudeQuestion', search: ['question'], orderBy: [{ topic: { name: 'asc' } }, { order: 'asc' }], include: { topic: { select: { name: true } } },
  row: (x) => ({ id: x.id, topicId: x.topicId, topicTitle: x.topic.name, prompt: x.question, options: x.options, answerIndex: x.correctIndex, explanation: x.explanation ?? '' }),
  write: async (_q, d, create, ex) => {
    const options = arr(d.options) ?? (create ? undefined : (ex.options as string[]));
    const correct = n(d.answerIndex) ?? (create ? 0 : ex.correctIndex);
    if (create) { need(s(d.prompt), 'Question'); need(options, 'Options'); }
    if (options && (options.length < 2 || options.length > 8)) throw fail('Provide between 2 and 8 options');
    if (options && (correct < 0 || correct >= options.length)) throw fail('The correct option number is out of range');
    return { topicId: create ? need(s(d.topicId), 'Topic') : s(d.topicId), question: s(d.prompt), options: arr(d.options), correctIndex: n(d.answerIndex), explanation: sn(d.explanation) };
  },
});

// ───── Notes & cheat sheets ─────
const accessCols = (x: any) => ({ ...accessOut(x), allowedEmails: undefined as unknown });
mount({
  path: '/notes', model: 'note', entity: 'Note', search: ['title', 'description'], orderBy: { createdAt: 'desc' }, publishField: 'isPublished',
  row: async (x) => ({
    id: x.id, title: x.title, category: x.category ?? '', description: x.description ?? '', externalUrl: x.externalUrl ?? '', html: x.contentType === 'HTML' || x.contentType === 'MARKDOWN' ? x.content ?? '' : '',
    ...accessCols(x), allowedEmails: x.accessType === 'SELECTED_USERS' ? await allowedEmailsOf('NOTE', x.id) : [], hasFile: !!x.fileKey, published: x.isPublished,
  }),
  write: async (req, d, create, ex) => {
    const files = filesOf(req, 'file'); const preview = filesOf(req, 'preview')[0];
    const html = sn(d.html); const ext = urlOrNull(d.externalUrl);
    const data: Record<string, unknown> = {
      title: create ? need(s(d.title), 'Title') : s(d.title), category: sn(d.category), description: sn(d.description), isPublished: b(d.published), ...accessIn(d),
      previewImageUrl: preview ? await imageData(preview, 700) : undefined, createdBy: create ? req.user!.id : undefined,
    };
    if (create) data.slug = await uniqueSlug('note', String(data.title));
    if (files.length) { data.fileKey = await storeDocument(files, 'notes'); data.contentType = 'PDF'; data.content = null; data.externalUrl = null; }
    else if (html) { data.content = html; data.contentType = 'HTML'; data.fileKey = null; data.externalUrl = null; }
    else if (ext) { data.externalUrl = ext; data.contentType = 'EXTERNAL'; data.content = null; data.fileKey = null; }
    else if (create) throw fail('Upload a PDF/images, write formatted content, or provide an external URL', 'CONTENT_REQUIRED');
    if (!create && data.fileKey && ex.fileKey) storage.deleteObject(ex.fileKey).catch((err) => logger.warn({ err }, 'old note file cleanup failed'));
    return data;
  },
  after: async (item, d, req) => { if (d.access === 'PRIVATE') await syncAllowedEmails('NOTE', item.id, arr(d.allowedEmails) ?? [], req.user!.id); else if (d.access) await syncAllowedEmails('NOTE', item.id, [], req.user!.id); },
  onDelete: async (x) => { if (x.fileKey) await storage.deleteObject(x.fileKey).catch(() => undefined); },
});

const CS_ENUM: Record<string, CheatSheetCategory> = { DSA: 'DSA', JAVA: 'JAVA', SQL: 'SQL', DBMS: 'DBMS', OS: 'OS', CN: 'CN', APTITUDE: 'APTITUDE', 'GIT & GITHUB': 'GIT_GITHUB', GIT_GITHUB: 'GIT_GITHUB' };
const CS_LABEL: Record<CheatSheetCategory, string> = { DSA: 'DSA', JAVA: 'Java', SQL: 'SQL', DBMS: 'DBMS', OS: 'OS', CN: 'CN', APTITUDE: 'Aptitude', GIT_GITHUB: 'Git & GitHub' };
mount({
  path: '/cheat-sheets', model: 'cheatSheet', entity: 'CheatSheet', search: ['title', 'description'], orderBy: { createdAt: 'desc' }, publishField: 'isPublished',
  row: async (x) => ({
    id: x.id, title: x.title, category: CS_LABEL[x.category as CheatSheetCategory], description: x.description ?? '', html: x.fileKey ? '' : x.content ?? '', ...accessCols(x),
    allowedEmails: x.accessType === 'SELECTED_USERS' ? await allowedEmailsOf('CHEATSHEET', x.id) : [], hasFile: !!x.fileKey, published: x.isPublished,
  }),
  write: async (req, d, create, ex) => {
    const files = filesOf(req, 'file'); const preview = filesOf(req, 'preview')[0];
    let category: CheatSheetCategory | undefined;
    if (d.category !== undefined || create) { category = CS_ENUM[String(need(s(d.category), 'Category')).toUpperCase()]; if (!category) throw fail('Unknown category'); }
    const html = sn(d.html);
    const data: Record<string, unknown> = { title: create ? need(s(d.title), 'Title') : s(d.title), category, description: sn(d.description), isPublished: b(d.published), ...accessIn(d), previewImageUrl: preview ? await imageData(preview, 700) : undefined, createdBy: create ? req.user!.id : undefined };
    if (create) data.slug = await uniqueSlug('cheatSheet', String(data.title));
    if (files.length) { if (files.length > 1) throw fail('Upload a single PDF or image for a cheat sheet'); data.fileKey = await storeDocument(files, 'cheatsheets'); data.content = null; }
    else if (html) { data.content = html; data.fileKey = null; }
    else if (create) throw fail('Upload a file or write formatted content', 'CONTENT_REQUIRED');
    if (!create && data.fileKey && ex.fileKey) storage.deleteObject(ex.fileKey).catch((err) => logger.warn({ err }, 'old file cleanup failed'));
    return data;
  },
  after: async (item, d, req) => { if (d.access === 'PRIVATE') await syncAllowedEmails('CHEATSHEET', item.id, arr(d.allowedEmails) ?? [], req.user!.id); else if (d.access) await syncAllowedEmails('CHEATSHEET', item.id, [], req.user!.id); },
  onDelete: async (x) => { if (x.fileKey) await storage.deleteObject(x.fileKey).catch(() => undefined); },
});

mount({
  path: '/certifications', model: 'certification', entity: 'Certification', search: ['title', 'provider', 'description'], orderBy: [{ order: 'asc' }, { createdAt: 'desc' }], publishField: 'isPublished', orderField: 'order',
  row: (x) => ({ id: x.id, title: x.title, provider: x.provider, description: x.description ?? '', url: x.url, imageUrl: x.imageUrl ?? '', order: x.order, published: x.isPublished }),
  write: async (req, d, create, ex) => {
    const image = filesOf(req, 'image')[0];
    const title = create ? need(s(d.title), 'Title') : s(d.title);
    const provider = create ? need(s(d.provider), 'Provider') : s(d.provider);
    const url = d.url === undefined && !create ? undefined : urlOrNull(d.url);
    if (create && !url) throw fail('A certification link is required');
    if (d.url !== undefined && !url) throw fail('Enter a valid certification URL');
    return { title, provider, description: sn(d.description), url, imageUrl: image ? await imageData(image, 1200) : undefined, order: n(d.order), isPublished: b(d.published) };
  },
});

// ───── Roadmaps (Roadmap → section → topic → resource; the admin "node" tab is the unified section/topic tree) ─────
const rmAccess = (x: any) => (!x.isPremium ? { access: 'FREE' } : Number(x.price) > 0 ? { access: 'PREMIUM', price: Number(x.price) } : { access: 'PRIVATE' });
mount({
  path: '/roadmaps', model: 'roadmap', entity: 'Roadmap', search: ['title'], orderBy: { order: 'asc' }, include: { _count: { select: { sections: true } } }, publishField: 'isPublished', orderField: 'order',
  row: async (x) => ({ id: x.id, title: x.title, icon: x.icon ?? '', description: x.description ?? '', sectionCount: x._count.sections, ...rmAccess(x), allowedEmails: x.isPremium && !(Number(x.price) > 0) ? await allowedEmailsOf('ROADMAP', x.id) : [], published: x.isPublished, order: x.order }),
  write: async (_q, d, create) => {
    const a = s(d.access); const price = a === 'PREMIUM' ? n(d.price) ?? 0 : 0;
    if (a === 'PREMIUM' && price <= 0) throw fail('Premium roadmaps need a price greater than 0', 'PRICE_REQUIRED');
    const title = create ? need(s(d.title), 'Title') : s(d.title);
    return { title, icon: sn(d.icon), description: sn(d.description), isPublished: b(d.published), isPremium: a === undefined ? undefined : a !== 'FREE', price: a === undefined ? undefined : price, order: n(d.order), ...(create ? { slug: await uniqueSlug('roadmap', title!) } : {}) };
  },
  after: async (item, d, req) => { if (d.access === 'PRIVATE') await syncAllowedEmails('ROADMAP', item.id, arr(d.allowedEmails) ?? [], req.user!.id); else if (d.access) await syncAllowedEmails('ROADMAP', item.id, [], req.user!.id); },
});

const nodes = Router();
const nodeRows = async (q: string) => {
  const [secs, tops] = await Promise.all([
    prisma.roadmapSection.findMany({ include: { roadmap: { select: { title: true, order: true } } } }),
    prisma.roadmapTopic.findMany({ include: { section: { select: { id: true, title: true, roadmapId: true, roadmap: { select: { title: true, order: true } } } } } }),
  ]);
  const rows = [
    ...secs.map((x) => ({ id: x.id, title: x.title, icon: x.icon ?? '', roadmapId: x.roadmapId, roadmapTitle: x.roadmap.title, parentId: '', parentTitle: '', level: 'Section', order: x.order, _k: [x.roadmap.order, x.roadmapId, x.order, 0] as (string | number)[] })),
    ...tops.map((x) => ({ id: x.id, title: x.title, icon: x.icon ?? '', roadmapId: x.section.roadmapId, roadmapTitle: x.section.roadmap.title, parentId: x.section.id, parentTitle: x.section.title, level: 'Topic', order: x.order, _k: [x.section.roadmap.order, x.section.roadmapId, x.order, 1] as (string | number)[] })),
  ];
  return rows.filter((x) => !q || x.title.toLowerCase().includes(q.toLowerCase())).sort((a, c) => (a.roadmapTitle + a.parentTitle + String(a.order).padStart(6, '0')).localeCompare(c.roadmapTitle + c.parentTitle + String(c.order).padStart(6, '0')));
};
nodes.get('/', async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page)) || 1), size = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize)) || 20));
  const all = await nodeRows(String(req.query.q ?? '').trim());
  const items = all.slice((page - 1) * size, page * size).map(({ _k, ...x }) => x);
  res.json({ items, total: all.length, page, pageSize: size, nextPage: page * size < all.length ? page + 1 : null });
});
nodes.post('/', async (req, res) => {
  const d = req.body ?? {}; const title = need(s(d.title), 'Title'); const parentId = s(d.parentId);
  if (parentId) {
    const sec = await prisma.roadmapSection.findUnique({ where: { id: parentId } });
    if (!sec) throw fail('The parent must be a top-level section');
    const x = await prisma.roadmapTopic.create({ data: { sectionId: sec.id, title, icon: sn(d.icon) ?? undefined, order: n(d.order) ?? (await prisma.roadmapTopic.count({ where: { sectionId: sec.id } })) } });
    return void res.status(201).json({ id: x.id });
  }
  const roadmapId = need(s(d.roadmapId), 'Roadmap');
  if (!(await prisma.roadmap.findUnique({ where: { id: roadmapId }, select: { id: true } }))) throw fail('Roadmap not found');
  const x = await prisma.roadmapSection.create({ data: { roadmapId, title, icon: sn(d.icon) ?? undefined, order: n(d.order) ?? (await prisma.roadmapSection.count({ where: { roadmapId } })) } });
  res.status(201).json({ id: x.id });
});
nodes.put('/:id', async (req, res) => {
  const d = req.body ?? {}; const id = req.params.id;
  const data = { title: s(d.title), icon: sn(d.icon), order: n(d.order) };
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  if (await prisma.roadmapSection.findUnique({ where: { id }, select: { id: true } })) await prisma.roadmapSection.update({ where: { id }, data: clean });
  else if (await prisma.roadmapTopic.findUnique({ where: { id }, select: { id: true } })) await prisma.roadmapTopic.update({ where: { id }, data: clean });
  else throw new ApiError(404, 'NOT_FOUND', 'Node not found');
  res.json({ id });
});
nodes.delete('/:id', async (req, res) => {
  const id = req.params.id;
  if (await prisma.roadmapSection.findUnique({ where: { id }, select: { id: true } })) await prisma.roadmapSection.delete({ where: { id } });
  else if (await prisma.roadmapTopic.findUnique({ where: { id }, select: { id: true } })) await prisma.roadmapTopic.delete({ where: { id } });
  else throw new ApiError(404, 'NOT_FOUND', 'Node not found');
  res.status(204).end();
});
nodes.patch('/:id/reorder', async (req, res) => {
  const dir = req.body?.direction === 'up' ? -1 : req.body?.direction === 'down' ? 1 : 0;
  if (!dir) throw fail('direction must be up or down');
  const id = req.params.id;
  const sec = await prisma.roadmapSection.findUnique({ where: { id } });
  const top = sec ? null : await prisma.roadmapTopic.findUnique({ where: { id } });
  if (!sec && !top) throw new ApiError(404, 'NOT_FOUND', 'Node not found');
  const db: any = sec ? prisma.roadmapSection : prisma.roadmapTopic;
  const list: { id: string }[] = await db.findMany({ where: sec ? { roadmapId: sec.roadmapId } : { sectionId: top!.sectionId }, orderBy: [{ order: 'asc' }, { id: 'asc' }], select: { id: true } });
  const i = list.findIndex((x) => x.id === id), j = i + dir;
  if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; await prisma.$transaction(list.map((x, k) => db.update({ where: { id: x.id }, data: { order: k } }))); }
  res.json({ moved: j >= 0 && j < list.length });
});
r.use('/roadmaps/nodes', nodes);

const RTYPE: Record<string, 'LINK' | 'VIDEO' | 'PDF' | 'IMAGE' | 'TEXT'> = { link: 'LINK', video: 'VIDEO', pdf: 'PDF', image: 'IMAGE', text: 'TEXT' };
mount({
  path: '/roadmaps/resources', model: 'roadmapResource', entity: 'RoadmapResource', search: ['title'], orderBy: [{ topic: { section: { roadmap: { order: 'asc' } } } }, { order: 'asc' }], include: { topic: { select: { title: true } } },
  orderField: 'order', siblings: (x) => ({ topicId: x.topicId }),
  row: (x) => ({ id: x.id, title: x.title, type: String(x.type).toLowerCase(), nodeId: x.topicId, nodeTitle: x.topic.title, url: x.youtubeUrl ?? x.externalUrl ?? '', content: x.content ?? '', hasFile: !!x.fileKey, order: x.order }),
  write: async (req, d, create, ex) => {
    const type = d.type !== undefined || create ? RTYPE[String(need(s(d.type), 'Type'))] : undefined;
    if ((d.type !== undefined || create) && !type) throw fail('Unknown resource type');
    const topicId = create ? need(s(d.nodeId), 'Node') : s(d.nodeId);
    if (topicId && !(await prisma.roadmapTopic.findUnique({ where: { id: topicId }, select: { id: true } }))) throw fail('Resources attach to a topic. Pick a node that has a parent section.');
    const eff = type ?? ex.type; const url = urlOrNull(d.url);
    const data: Record<string, unknown> = { title: create ? need(s(d.title), 'Title') : s(d.title), type, topicId, order: n(d.order) };
    if (eff === 'VIDEO') { data.youtubeUrl = url; data.externalUrl = null; } else if (eff === 'LINK') { data.externalUrl = url; data.youtubeUrl = null; }
    if ((eff === 'VIDEO' || eff === 'LINK') && create && !url) throw fail('A URL is required for links and videos');
    if (eff === 'TEXT') { data.content = sn(d.content); if (create && !s(d.content)) throw fail('Content is required for text resources'); }
    if (eff === 'PDF' || eff === 'IMAGE') {
      const files = filesOf(req, 'file');
      if (files.length) data.fileKey = await storeDocument(files.slice(0, 1), 'resources'); else if (create) throw fail('Upload a file for PDF and image resources');
    }
    return data;
  },
});

export default r;
