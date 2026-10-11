// Applies committed migrations when they exist; otherwise creates/syncs tables from the schema (first deploy).
const { existsSync } = require('fs');
const { execSync } = require('child_process');
const hasMigrations = existsSync('src/prisma/migrations');
const cmd = hasMigrations ? 'npx prisma migrate deploy' : 'npx prisma db push --skip-generate';
console.log(`[migrate] ${cmd}`);
execSync(cmd, { stdio: 'inherit' });
