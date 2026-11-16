// Reading and writing text files without changing their encoding or line endings.

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode file bytes.
 * - Supports UTF-8 (with or without BOM), UTF-16 LE with BOM, and falls back to Latin-1 for other bytes.
 */
export function decodeText(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  try {
    return { text: strictUtf8.decode(buffer), encoding: 'utf8' };
  } catch {
    return { text: buffer.toString('latin1'), encoding: 'latin1' };
  }
}

export function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'latin1':
      if (/[^\u0000-ÿ]/.test(text)) {
        throw new Error('The file is not UTF-8 (it looks like Windows-1252/Latin-1) and the new text has characters that encoding cannot store.');
      }
      return Buffer.from(text, 'latin1');
    default:
      return Buffer.from(text, 'utf8');
  }
}

/** True when the text uses CRLF line endings for most lines. */
export function usesCrlf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  return crlf > 0 && crlf * 2 >= lf;
}

export function toCrlf(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

export function countOccurrences(text, search) {
  if (!search) return 0;
  let count = 0;
  let index = text.indexOf(search);
  while (index !== -1) {
    count++;
    index = text.indexOf(search, index + search.length);
  }
  return count;
}

/** Replace the first (or every) occurrence without treating `$` in the replacement as a pattern. */
export function replaceLiteral(text, search, replacement, replaceAll) {
  if (replaceAll) return text.split(search).join(replacement);
  const index = text.indexOf(search);
  if (index === -1) return text;
  const replaced = text.slice(0, index) + replacement + text.slice(index + search.length);
  return replaced;
}
