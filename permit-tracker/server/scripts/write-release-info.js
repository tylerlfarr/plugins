/**
 * Write non-secret release metadata for /api/health identification.
 * Prefer git SHA when .git is available; else SOURCE_COMMIT / GITHUB_SHA / GIT_SHA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function resolveGitSha() {
  const fromEnv =
    process.env.SOURCE_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.GIT_SHA ||
    process.env.COMMIT_SHA ||
    '';
  if (fromEnv.trim()) return fromEnv.trim().slice(0, 40);
  try {
    return execSync('git rev-parse HEAD', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const gitSha = resolveGitSha();
const info = {
  name: 'permit-ledger',
  version: pkg.version || '0.0.0',
  gitSha,
  gitShaShort: gitSha === 'unknown' ? 'unknown' : gitSha.slice(0, 7),
  builtAt: new Date().toISOString(),
};

const outPath = path.join(root, 'server', 'release-info.json');
fs.writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`);
console.log(`Wrote release-info ${info.gitShaShort} → ${path.relative(root, outPath)}`);
