// Glob patterns to regular expressions. Supports **, *, ?, [abc], [!abc] and {a,b}.
// Paths are matched with forward slashes, and without case on Windows.

export function globToRegExp(pattern) {
  let source = '';
  const glob = String(pattern).replace(/\\/g, '/');
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const character = glob[i];
    if (character === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          if (glob[i + 2] === '/') {
            // "**/" matches zero or more folders.
            source += '(?:[^/]*/)*';
            i += 2;
          } else {
            source += '.*';
            i += 1;
          }
          continue;
        }
        source += '[^/]*';
        i += 1;
        continue;
      }
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        source += '\\[';
        continue;
      }
      let set = glob.slice(i + 1, close);
      if (set.startsWith('!')) set = `^${set.slice(1)}`;
      source += `[${set.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else if (character === '{') {
      braceDepth++;
      source += '(?:';
    } else if (character === '}' && braceDepth > 0) {
      braceDepth--;
      source += ')';
    } else if (character === ',' && braceDepth > 0) {
      source += '|';
    } else {
      source += character.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  const expression = new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
  return expression;
}

/**
 * Match a relative path against a glob.
 * - A pattern without a slash matches the file name in any folder, like `*.js`.
 */
export function createGlobMatcher(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  const expression = globToRegExp(normalized);
  const matchNameOnly = !normalized.includes('/');
  return (relativePath) => {
    const value = relativePath.replace(/\\/g, '/');
    if (matchNameOnly) return expression.test(value.slice(value.lastIndexOf('/') + 1));
    return expression.test(value);
  };
}
