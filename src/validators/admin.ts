import { z } from 'zod';
import { accessType, difficulty, optUrl, price, safeText, slug } from './common';

const text = (max = 20000) => z.string().max(max).nullish();
const order = z.coerce.number().int().default(0);
const pub = z.boolean().default(false);

export const sheetS = z.object({ name: safeText(2, 120), slug, description: text(2000), isPublished: pub, order });
export const topicS = z.object({ sheetId: z.string(), name: safeText(1, 120), slug, description: text(2000), hint: text(500), tip: text(500), order });
export const subtopicS = z.object({ topicId: z.string(), name: safeText(1, 120), slug, order });
export const problemS = z.object({
  title: safeText(2, 200), slug, description: text(), difficulty,
  leetcodeUrl: optUrl, gfgUrl: optUrl, youtubeUrl: optUrl, imageUrl: optUrl,
  topicId: z.string(), subtopicId: z.string().nullish(), pattern: text(120),
  quickRevision: text(), adminNotes: text(), isPublished: pub, isPremium: z.boolean().default(false), order,
  companyIds: z.array(z.string()).max(50).optional(),
});
export const companyS = z.object({ name: safeText(1, 120), slug, logoUrl: optUrl, websiteUrl: optUrl });

export const coreCategoryS = z.object({ name: safeText(1, 120), slug, description: text(1000), order });
export const corePatternS = z.object({ categoryId: z.string(), name: safeText(1, 160), slug, order });
export const coreTopicS = z.object({ categoryId: z.string(), patternId: z.string().nullish(), name: safeText(1, 160), slug, summary: text(1000), order, isPublished: z.boolean().default(true) });
export const coreContentS = z.object({ topicId: z.string(), title: safeText(1, 200), body: z.string().min(1).max(200000), order, isPublished: z.boolean().default(true) });

export const aptCategoryS = z.object({ name: safeText(1, 120), slug, order });
export const aptTopicS = z.object({ categoryId: z.string(), name: safeText(1, 160), slug, notes: text(200000), order, isPublished: z.boolean().default(true) });
export const aptQuestionS = z.object({
  topicId: z.string(), question: z.string().min(3).max(5000),
  options: z.array(z.string().min(1).max(500)).min(2).max(8), correctIndex: z.number().int().min(0),
  explanation: text(5000), difficulty: difficulty.default('MEDIUM'), order,
}).refine((d) => d.correctIndex < d.options.length, { message: 'correctIndex out of range', path: ['correctIndex'] });
export const puzzleS = z.object({
  title: safeText(2, 200), slug, description: z.string().min(3).max(20000), pattern: text(120),
  difficulty: difficulty.default('MEDIUM'), hints: z.array(z.string().max(2000)).max(10).default([]),
  solution: text(), imageUrl: optUrl, isPublished: pub, isPremium: z.boolean().default(false), order,
});

const gated = {
  accessType: accessType.default('FREE'), price: price.default(0), isPublished: pub,
  fileKey: z.string().max(300).nullish(), previewImageUrl: optUrl,
};
export const noteS = z.object({
  title: safeText(2, 200), slug, description: text(2000), category: text(100),
  contentType: z.enum(['PDF', 'IMAGE', 'HTML', 'MARKDOWN', 'EXTERNAL']),
  content: text(500000), externalUrl: optUrl, ...gated,
}).refine((d) => d.accessType !== 'PREMIUM' || d.price > 0, { message: 'Premium content needs a price', path: ['price'] });
export const cheatSheetS = z.object({
  title: safeText(2, 200), slug, category: z.enum(['DSA', 'JAVA', 'SQL', 'DBMS', 'OS', 'CN', 'APTITUDE', 'GIT_GITHUB']),
  description: text(2000), content: text(500000), ...gated,
});

export const roadmapS = z.object({
  title: safeText(2, 160), slug, description: text(5000), imageUrl: optUrl, isPublished: pub,
  isPremium: z.boolean().default(false), price: price.default(0), order,
});
export const roadmapSectionS = z.object({ roadmapId: z.string(), title: safeText(1, 160), description: text(2000), order });
export const roadmapTopicS = z.object({ sectionId: z.string(), title: safeText(1, 160), description: text(2000), order });
export const roadmapResourceS = z.object({
  topicId: z.string(), type: z.enum(['TEXT', 'PDF', 'IMAGE', 'VIDEO', 'LINK']).default('TEXT'),
  title: safeText(1, 200), description: text(2000), content: text(200000), fileKey: z.string().max(300).nullish(),
  imageUrl: optUrl, youtubeUrl: optUrl, externalUrl: optUrl, order, isPremium: z.boolean().default(false), price: price.default(0),
});

export const testimonialS = z.object({
  name: safeText(1, 100), handle: text(100), location: text(100), message: safeText(5, 1500),
  rating: z.coerce.number().int().min(1).max(5).default(5), isPublished: pub, order,
});

export const interviewInput = z.object({
  title: safeText(5, 200), company: safeText(1, 120), companyId: z.string().nullish(), role: safeText(1, 120),
  experienceLevel: text(60), difficulty: difficulty.default('MEDIUM'),
  status: z.enum(['SELECTED', 'REJECTED', 'PENDING']).default('PENDING'),
  summary: text(1000), background: text(10000), verdict: text(5000),
  tags: z.array(safeText(1, 40)).max(10).default([]), isAnonymous: z.boolean().default(true),
  rounds: z.array(z.object({
    title: safeText(1, 160), description: text(10000), questions: z.array(safeText(1, 1000)).max(30).default([]),
  })).min(1).max(12),
});
export const interviewAdminS = interviewInput.extend({ isPublished: z.boolean().default(true), slug });

export const notificationS = z.object({
  title: safeText(2, 160), message: safeText(2, 1000),
  type: z.enum(['INFO', 'NEW_CONTENT', 'ANNOUNCEMENT']).default('INFO'),
  targetType: z.enum(['ALL_USERS', 'SELECTED_USERS']).default('ALL_USERS'),
  emails: z.array(z.string().email()).max(500).optional(), linkUrl: optUrl,
  expiresAt: z.coerce.date().nullish(),
}).refine((d) => d.targetType === 'ALL_USERS' || (d.emails?.length ?? 0) > 0, { message: 'emails required for SELECTED_USERS', path: ['emails'] });

export const entitlementS = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).min(1).max(500),
  contentType: z.enum(['NOTE', 'CHEATSHEET', 'ROADMAP', 'ROADMAP_RESOURCE', 'PROBLEM']),
  contentId: z.string().min(1), expiresAt: z.coerce.date().nullish(),
});

export const adminUserPatch = z.object({
  name: safeText(2, 80).optional(), username: z.string().regex(/^[a-zA-Z0-9_]{3,30}$/).transform((s) => s.toLowerCase()).optional(),
  email: z.string().email().transform((s) => s.toLowerCase()).optional(),
  role: z.enum(['USER', 'ADMIN']).optional(), status: z.enum(['ACTIVE', 'BLOCKED', 'SUSPENDED']).optional(),
  emailVerified: z.boolean().optional(),
});
