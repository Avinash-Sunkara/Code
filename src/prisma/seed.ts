/* Idempotent starter data. The app does not depend on any of it; admins can edit or delete everything. */
import { PrismaClient } from '@prisma/client';
import { slugify } from '../utils/slug';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The development seed is disabled in production.');
}

const prisma = new PrismaClient();

async function main() {
  // DSA sheets (unpublished until an admin adds problems)
  const sheets = [
    { name: 'Pattern Wise Sheet', description: 'Pattern-first DSA sheet, sequenced pattern by pattern.' },
    { name: 'Last Minute 100', description: 'The short version for when the interview is close.' },
    { name: 'SBC', description: 'Service Based Company sheet: DSA problems most asked by service-based / IT-consulting firms, organised by pattern.' },
  ];
  for (const [i, s] of sheets.entries()) {
    const sheet = await prisma.dSASheet.upsert({ where: { slug: slugify(s.name) }, update: {}, create: { ...s, slug: slugify(s.name), order: i } });
    const topics = ['Arrays', 'Strings', 'Linked List', 'Stack', 'Queue', 'Trees', 'Graphs', 'Dynamic Programming', 'Greedy', 'Hashing', 'Two-Pointer', 'Sliding Window'];
    for (const [j, t] of topics.entries()) {
      await prisma.dSATopic.upsert({ where: { sheetId_slug: { sheetId: sheet.id, slug: slugify(t) } }, update: {}, create: { sheetId: sheet.id, name: t, slug: slugify(t), order: j } });
    }
  }

  // Core CS
  const core = ['OOP', 'SQL', 'DBMS', 'Operating Systems', 'Computer Networks'];
  const cats: Record<string, string> = {};
  for (const [i, n] of core.entries()) {
    const c = await prisma.coreCategory.upsert({ where: { slug: slugify(n) }, update: {}, create: { name: n, slug: slugify(n), order: i } });
    cats[n] = c.id;
  }
  const sqlPatterns: Record<string, string[]> = {
    'Pattern 1 — Basic Data Retrieval': ['SELECT', 'SELECT Specific Columns', 'DISTINCT', 'Aliases (AS)', 'Arithmetic Expressions', 'LIMIT / TOP / FETCH FIRST', 'ORDER BY'],
    'Pattern 2 — Filtering Data': ['WHERE', 'Comparison Operators', 'Logical Operators (AND, OR, NOT)', 'BETWEEN', 'IN', 'LIKE', 'IS NULL'],
    'Pattern 3 — Aggregation': ['GROUP BY', 'HAVING'],
    'Pattern 4 — Joins & Subqueries': ['JOINs', 'Subqueries', 'EXISTS', 'NOT EXISTS', 'ANY', 'ALL'],
    'Pattern 5 — Set Operations & Constraints': ['UNION', 'INTERSECT', 'Constraints'],
  };
  let order = 0;
  for (const [pi, [pname, topics]] of Object.entries(sqlPatterns).entries()) {
    const pat = await prisma.corePattern.upsert({ where: { categoryId_slug: { categoryId: cats['SQL'], slug: slugify(pname) } }, update: {}, create: { categoryId: cats['SQL'], name: pname, slug: slugify(pname), order: pi } });
    for (const t of topics) {
      await prisma.coreTopic.upsert({ where: { slug: `sql-${slugify(t)}` }, update: {}, create: { categoryId: cats['SQL'], patternId: pat.id, name: t, slug: `sql-${slugify(t)}`, order: order++ } });
    }
  }

  // Aptitude
  const apt: Record<string, string[]> = {
    'Quantitative Aptitude': ['Number System', 'Percentage', 'Profit and Loss', 'Ratio and Proportion', 'Probability and Combinatorics', 'Time and Work', 'Time, Speed and Distance', 'Progressions (AP, GP)', 'Ages'],
    'Logical Reasoning': ['Series', 'Coding-Decoding', 'Blood Relations', 'Direction Sense', 'Seating Arrangement', 'Syllogisms', 'Puzzles'],
  };
  for (const [ci, [cn, topics]] of Object.entries(apt).entries()) {
    const c = await prisma.aptitudeCategory.upsert({ where: { slug: slugify(cn) }, update: {}, create: { name: cn, slug: slugify(cn), order: ci } });
    for (const [ti, t] of topics.entries()) {
      await prisma.aptitudeTopic.upsert({ where: { slug: `${slugify(cn).slice(0, 5)}-${slugify(t)}` }, update: {}, create: { categoryId: c.id, name: t, slug: `${slugify(cn).slice(0, 5)}-${slugify(t)}`, order: ti } });
    }
  }

  // Roadmaps (unpublished shells)
  for (const [i, t] of ['Java Developer', 'Backend Developer', 'Data Analyst', 'Full Stack Developer', 'AI/ML Engineer', 'Data Scientist', 'Frontend Developer', 'SQL Developer'].entries()) {
    await prisma.roadmap.upsert({ where: { slug: slugify(t) }, update: {}, create: { title: t, slug: slugify(t), order: i } });
  }

  // Companies (logos are added by admins; no scraping)
  for (const n of ['Google', 'Amazon', 'Microsoft', 'TCS', 'Infosys', 'Wipro', 'Accenture', 'Capgemini', 'HCLTech', 'Cognizant', 'EY']) {
    await prisma.company.upsert({ where: { slug: slugify(n) }, update: {}, create: { name: n, slug: slugify(n) } });
  }
  console.log('Seed complete');
}
main().finally(() => prisma.$disconnect());
