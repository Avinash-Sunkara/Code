import { ActivityType, Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { env } from '../config/env';

// Views, refreshes, authentication, bookmarks, hint reveals, and navigation are excluded.
// Keep the user-facing rules in docs/LEARNING_ACTIVITY.md in sync with this list.
const COUNTED = new Set<ActivityType>([
  'PROBLEM_SOLVED', 'PROBLEM_REVISED', 'PERSONAL_NOTE_CREATED', 'STUDY_SESSION',
  'PRACTICE', 'ROADMAP_RESOURCE_COMPLETED', 'COMMENT',
]);
export const CONTRIBUTION_TYPES = [...COUNTED];
const COUNTED_TYPES = CONTRIBUTION_TYPES;
const DAY_MS = 86_400_000;

export function isCountedActivity(type: ActivityType, refType?: string | null) {
  return COUNTED.has(type) && !(type === 'PRACTICE' && refType === 'Puzzle');
}

/** Calendar date in the app timezone, stored as a UTC-midnight Date. */
export function localDate(d = new Date()): Date {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: env.APP_TIMEZONE }).format(d);
  return new Date(`${s}T00:00:00.000Z`);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => dayKey(new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY_MS));

export function calculateStreak(activityDays: Iterable<string>, today: string) {
  const dates = new Set([...activityDays].filter((date) => date <= today));
  let cursor = dates.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (dates.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous: string | undefined;
  for (const date of [...dates].sort()) {
    run = previous && addDays(previous, 1) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return { current, longest };
}

export async function recordActivity(
  tx: Prisma.TransactionClient,
  userId: string,
  type: ActivityType,
  o: { refType?: string; refId?: string } = {},
  date = localDate(),
) {
  await tx.activity.create({ data: { userId, type, date, refType: o.refType, refId: o.refId } });
  if (!isCountedActivity(type, o.refType)) return;

  const solved = type === 'PROBLEM_SOLVED' ? 1 : 0;
  await tx.dailyActivity.upsert({
    where: { userId_date: { userId, date } },
    create: { userId, date, count: 1, solved },
    update: { count: { increment: 1 }, ...(solved ? { solved: { increment: 1 } } : {}) },
  });
}

export async function logActivity(userId: string, type: ActivityType, o: { refType?: string; refId?: string } = {}) {
  const date = localDate();
  await prisma.$transaction((tx) => recordActivity(tx, userId, type, o, date));
}

export async function rebuildDailyActivity(tx: Prisma.TransactionClient, userId: string, date: Date) {
  const where = { userId, date, type: { in: COUNTED_TYPES }, NOT: { type: 'PRACTICE' as const, refType: 'Puzzle' } };
  const [count, solved] = await Promise.all([
    tx.activity.count({ where }),
    tx.activity.count({ where: { ...where, type: 'PROBLEM_SOLVED' } }),
  ]);
  const key = { userId_date: { userId, date } };
  if (!count) {
    await tx.dailyActivity.deleteMany({ where: { userId, date } });
    return;
  }
  await tx.dailyActivity.upsert({
    where: key,
    create: { userId, date, count, solved },
    update: { count, solved },
  });
}

export async function clearProblemSolveActivity(tx: Prisma.TransactionClient, userId: string, problemId: string) {
  const where = { userId, type: 'PROBLEM_SOLVED' as const, refType: 'Problem', refId: problemId };
  const events = await tx.activity.findMany({ where, select: { date: true } });
  if (!events.length) return;
  await tx.activity.deleteMany({ where });
  const dates = new Map(events.map((event) => [dayKey(event.date), event.date]));
  for (const date of dates.values()) await rebuildDailyActivity(tx, userId, date);
}

export async function contributionDays(userId: string, date: Prisma.DateTimeFilter = {}) {
  const rows = await prisma.activity.groupBy({
    by: ['date'],
    where: { userId, type: { in: COUNTED_TYPES }, NOT: { type: 'PRACTICE', refType: 'Puzzle' }, date },
    orderBy: { date: 'asc' },
    _count: { _all: true },
  });
  return rows.map((row) => ({ date: dayKey(row.date), count: row._count._all }));
}

export async function getHeatmap(userId: string, year: number) {
  const today = localDate();
  const days = await contributionDays(userId, {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
    lte: today,
  });
  return { year, totalContributions: days.reduce((s, d) => s + d.count, 0), days };
}

export async function getStreak(userId: string): Promise<{ current: number; longest: number }> {
  const today = dayKey(localDate());
  const days = await contributionDays(userId, { lte: localDate() });
  return calculateStreak(days.map((day) => day.date), today);
}
