// Protected files (Settings → Permissions): secrets such as .env files and private keys, so they are not
// sent to Copilot by accident. The agent's file tools may not read or change them, and searches skip them.
// Commands go through the normal approvals.
import os from 'node:os';
import path from 'node:path';
import { createGlobMatcher } from './tools/glob.js';

export const DEFAULT_PROTECTED_FILES = [
  '.env', '.env.local', '.env.*.local', '.env.production', '.env.staging', '.env.development', '.env.test',
  '*.pem', '*.pfx', '*.p12', 'id_rsa', 'id_ecdsa', 'id_ed25519', '.git-credentials', '.netrc', '_netrc',
  // Sign-ins other tools keep in the home folder.
  '~/.npmrc', '~/.pypirc', '~/.aws/credentials', '~/.azure/*', '~/.docker/config.json', '~/.kube/config',
  '~/.codex/auth.json', '~/.claude/.credentials.json', '~/AppData/Roaming/GitHub CLI/hosts.yml',
];

/**
 * The pattern that protects `absolutePath`, or null.
 * - A pattern without a slash matches the file name anywhere. One with a slash matches the path relative
 *   to the project folder `root` (so it does not apply outside it). One starting with ~/ matches the path
 *   relative to the user's home folder.
 */
export function protectedPattern(absolutePath, root, patterns) {
  const relativeTo = (folder) => path.relative(folder, absolutePath).replace(/\\/g, '/');
  const isOutside = (relative) => relative.startsWith('../') || relative === '..' || path.isAbsolute(relative);
  const relative = relativeTo(root);
  const outside = isOutside(relative);
  const inHome = relativeTo(os.homedir());
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\\/g, '/');
    if (normalized.startsWith('~/')) {
      if (!isOutside(inHome) && createGlobMatcher(normalized.slice(2))(inHome)) return pattern;
      continue;
    }
    if (outside && normalized.includes('/')) continue;
    if (createGlobMatcher(pattern)(outside ? path.basename(absolutePath) : relative)) return pattern;
  }
  return null;
}
