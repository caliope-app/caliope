import os from 'node:os';
import path from 'node:path';

const caseInsensitive = process.platform === 'win32';

/** Resolve a tool path against the session folder; `~` means the user's home folder. */
export function resolvePath(cwd, inputPath) {
  let value = String(inputPath ?? '').trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(1));
  const absolutePath = path.resolve(cwd, value || '.');
  return absolutePath;
}

export function isInside(parent, child) {
  const relative = path.relative(normalizeCase(parent), normalizeCase(child));
  // "..config" is a folder name, not a step up.
  const inside = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return inside;
}

/** Path shown to the model and the user: relative inside the project, absolute outside. */
export function displayPath(cwd, absolutePath) {
  if (!isInside(cwd, absolutePath)) return absolutePath;
  const relative = path.relative(cwd, absolutePath);
  return relative || '.';
}

/** Key for maps of paths; Windows paths compare without case. */
export function pathKey(absolutePath) {
  return normalizeCase(path.resolve(absolutePath));
}

function normalizeCase(value) {
  return caseInsensitive ? value.toLowerCase() : value;
}
