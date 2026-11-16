// Small syntax highlighter for code blocks: comments, strings, numbers, keywords and a few extras.
import { escapeHtml } from './dom.js';

const MAX_HIGHLIGHT_CHARS = 120000;

const words = (list) => `\\b(?:${list.split(' ').join('|')})\\b`;

const JS_KEYWORDS = words('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined interface type enum implements private public protected readonly as declare namespace abstract keyof satisfies');
const PY_KEYWORDS = words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self');
const SQL_KEYWORDS = words('select from where and or not insert into values update set delete create table view or replace alter drop join left right inner outer full cross on group by order having limit offset as distinct union all case when then else end is null in exists between like with merge using matched partition over row_number cast coalesce primary key foreign references default true false');
const PS_KEYWORDS = words('begin break catch class continue data define do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow');
const SH_KEYWORDS = words('if then else elif fi for while do done case esac in function return local export set unset echo exit source alias cd');
const CS_KEYWORDS = words('abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while');
const GO_KEYWORDS = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil');
const RUST_KEYWORDS = words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while');
const JAVA_KEYWORDS = words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient true false try void volatile while var record');
const C_KEYWORDS = words('auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual new delete nullptr true false bool');

const NUMBER = ['num', '\\b(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b'];
const DQ = ['str', '"(?:\\\\.|[^"\\\\\\n])*"'];
const SQ = ['str', "'(?:\\\\.|[^'\\\\\\n])*'"];
const LINE_SLASH = ['com', '//.*'];
const BLOCK = ['com', '/\\*[\\s\\S]*?\\*/'];
const HASH = ['com', '#.*'];

const RULES = {
  js: [LINE_SLASH, BLOCK, ['str', '`(?:\\\\.|[^`\\\\])*`'], DQ, SQ, NUMBER, ['kw', JS_KEYWORDS], ['fn', '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()']],
  py: [HASH, ['str', '"""[\\s\\S]*?"""'], ['str', "'''[\\s\\S]*?'''"], ['str', '[rbfuRBFU]{0,2}"(?:\\\\.|[^"\\\\\\n])*"'], ['str', "[rbfuRBFU]{0,2}'(?:\\\\.|[^'\\\\\\n])*'"], NUMBER, ['kw', PY_KEYWORDS], ['attr', '@[\\w.]+'], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  json: [['attr', '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'], DQ, NUMBER, ['kw', words('true false null')]],
  sql: [['com', '--.*'], BLOCK, SQ, ['attr', '`[^`]*`'], NUMBER, ['kw', SQL_KEYWORDS, 'i']],
  ps: [['com', '<#[\\s\\S]*?#>'], HASH, ['str', '@"[\\s\\S]*?"@'], ['str', "@'[\\s\\S]*?'@"], DQ, SQ, ['var', '\\$[\\w:?]+'], NUMBER, ['kw', PS_KEYWORDS, 'i'], ['fn', '\\b[A-Z][a-zA-Z]+-[A-Z][a-zA-Z]+\\b'], ['attr', '\\s-[A-Za-z]\\w*']],
  sh: [HASH, DQ, SQ, ['var', '\\$\\{?[\\w@#?*!-]+\\}?'], NUMBER, ['kw', SH_KEYWORDS], ['attr', '\\s--?[A-Za-z][\\w-]*']],
  cs: [LINE_SLASH, BLOCK, ['str', '@"(?:""|[^"])*"'], ['str', '\\$"(?:\\\\.|[^"\\\\\\n])*"'], DQ, SQ, NUMBER, ['kw', CS_KEYWORDS], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  java: [LINE_SLASH, BLOCK, DQ, SQ, NUMBER, ['kw', JAVA_KEYWORDS], ['attr', '@\\w+'], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  go: [LINE_SLASH, BLOCK, ['str', '`[^`]*`'], DQ, SQ, NUMBER, ['kw', GO_KEYWORDS], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  rust: [LINE_SLASH, BLOCK, DQ, NUMBER, ['kw', RUST_KEYWORDS], ['attr', '#!?\\[[^\\]]*\\]'], ['fn', '\\b[a-z_]\\w*!?(?=\\s*\\()']],
  c: [LINE_SLASH, BLOCK, ['attr', '#\\s*\\w+'], DQ, SQ, NUMBER, ['kw', C_KEYWORDS], ['fn', '\\b[A-Za-z_]\\w*(?=\\s*\\()']],
  yaml: [HASH, DQ, SQ, ['attr', '^[ \\t-]*[\\w.-]+(?=\\s*:)', 'm'], NUMBER, ['kw', words('true false null yes no on off')]],
  ini: [['com', '[#;].*'], ['attr', '^\\s*\\[[^\\]]*\\]', 'm'], ['attr', '^\\s*[\\w.-]+(?=\\s*=)', 'm'], DQ, SQ, NUMBER, ['kw', words('true false')]],
  xml: [['com', '<!--[\\s\\S]*?-->'], ['kw', '</?[\\w:.-]+'], ['attr', '\\b[\\w:-]+(?==)'], DQ, SQ],
  css: [BLOCK, DQ, SQ, ['attr', '[\\w-]+(?=\\s*:)'], ['kw', '[.#][\\w-]+'], ['num', '-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|fr)?\\b'], ['var', '--[\\w-]+']],
};

const ALIASES = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
  python: 'py', py3: 'py', jsonc: 'json', json5: 'json',
  powershell: 'ps', pwsh: 'ps', ps1: 'ps', psm1: 'ps',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', bat: 'sh', cmd: 'sh', batch: 'sh',
  csharp: 'cs', 'c#': 'cs', kotlin: 'java', kt: 'java', scala: 'java', golang: 'go', rs: 'rust',
  cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', yml: 'yaml', toml: 'ini', conf: 'ini', properties: 'ini',
  html: 'xml', svg: 'xml', xaml: 'xml', vue: 'xml', scss: 'css', less: 'css', tsql: 'sql', sparksql: 'sql', pgsql: 'sql', hcl: 'ini',
};

const compiled = new Map();

function compile(language) {
  if (compiled.has(language)) return compiled.get(language);
  const rules = (RULES[language] || []).map(([className, source, flags = '']) => ({ className, regex: new RegExp(source, `y${flags}`) }));
  compiled.set(language, rules);
  return rules;
}

export function normalizeLanguage(language) {
  const lower = String(language || '').toLowerCase().trim();
  return RULES[lower] ? lower : ALIASES[lower] || (lower === 'diff' || lower === 'patch' ? 'diff' : null);
}

/** Highlighted HTML for `code` (already-escaped output, safe to insert). */
export function highlight(code, language) {
  const normalized = normalizeLanguage(language);
  if (!normalized || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);
  if (normalized === 'diff') {
    const lines = code.split('\n').map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="hl-add">${escaped}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="hl-del">${escaped}</span>`;
      if (line.startsWith('@@')) return `<span class="hl-meta">${escaped}</span>`;
      return escaped;
    });
    return lines.join('\n');
  }
  const rules = compile(normalized);
  let output = '';
  let plain = '';
  let position = 0;
  while (position < code.length) {
    let matched = false;
    for (const rule of rules) {
      rule.regex.lastIndex = position;
      const match = rule.regex.exec(code);
      if (match && match[0].length > 0) {
        if (plain) {
          output += escapeHtml(plain);
          plain = '';
        }
        output += `<span class="hl-${rule.className}">${escapeHtml(match[0])}</span>`;
        position += match[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Skip a whole word at once so keywords are not matched inside identifiers.
      const word = /[\w$]+/y;
      word.lastIndex = position;
      const wordMatch = word.exec(code);
      if (wordMatch) {
        plain += wordMatch[0];
        position += wordMatch[0].length;
      } else {
        plain += code[position];
        position++;
      }
    }
  }
  output += escapeHtml(plain);
  return output;
}
