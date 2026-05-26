/**
 * @fileoverview Extract used translation keys from raw source text.
 * @author claude (golter fork)
 *
 * `no-unused-keys` previously parsed every source file in the project to walk
 * the AST for `t()` / `$t()` / `v-t` / `<i18n>` references. For TypeScript-
 * heavy codebases that was the dominant cost: full parsing of dozens of
 * files (often via @typescript-eslint/parser) on every cold lint run.
 *
 * The shapes the rule actually cares about are local — they fit on one line
 * and never depend on type information — so they can be lifted out of the
 * raw text with regex. This file implements that fast path; AST extraction
 * is still used for the Vue `<i18n>` custom block path where ESLint has
 * already parsed the file for us.
 *
 * Edge cases this approach gives up vs full AST extraction:
 *   - Translation key strings split across concatenation, e.g.
 *     `t('foo.' + 'bar')`, are not recognised. The AST extractor also
 *     skipped these (only static literals are reported).
 *   - Multi-line attribute values on `<i18n>` components are matched only
 *     within a 1KB window from the opening `<` to keep the regex bounded.
 *   - Generic type arguments are recognised up to 512 characters between
 *     the `<` and the matching `>`; longer type arg lists fall back to
 *     not matching that call. Type arg lists that long don't occur in
 *     real code.
 */

// Optional TypeScript generic type arguments between the call name and `(`,
// e.g. `t<MyType>('key')`. Non-greedy so it doesn't accidentally swallow
// content past the closing `>`, and bounded so a stray `<` elsewhere in
// the file can't make the engine scan arbitrarily forward. Nested generics
// like `t<Array<string>>(...)` work because the inner `<` and `>` are
// inside the [\s\S] class.
const TYPE_ARGS = /(?:\s*<[\s\S]{0,512}?>)?/.source

const T_CALL_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_$])\\$?tc?${TYPE_ARGS}\\s*\\(\\s*(['"\`])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*)\\1`,
  'g'
)

const V_T_DOUBLE_RE = /v-t\s*=\s*"\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*"/g
const V_T_SINGLE_RE = /v-t\s*=\s*'\s*(["`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*'/g

// Capture attributes on `<i18n>`, `<i18n-t>`, `<I18nT>`. The body match is
// bounded ([\s\S]{0,1024}) so a stray unterminated tag elsewhere in the
// document can't make the regex backtrack forever.
const COMPONENT_TAG_RE = /<(?:i18n(?:-t)?|I18nT)\b([\s\S]{0,1024}?)(?:\/?>|<)/g
const COMPONENT_ATTR_RE =
  /(?:^|[\s/])(path|keypath)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=<]+))/g

function unescapeStringLiteral(raw: string): string {
  return raw.replace(/\\([\s\S])/g, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'v':
        return '\v'
      case '0':
        return '\0'
      default:
        return c
    }
  })
}

function templateLiteralHasInterpolation(raw: string): boolean {
  // True only when `${` appears unescaped. Walk the string and track whether
  // the preceding backslash count is even (escape cancels itself).
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\\') {
      i += 2
      continue
    }
    if (raw[i] === '$' && raw[i + 1] === '{') {
      return true
    }
    i++
  }
  return false
}

function collectCallKeys(text: string, out: Set<string>): void {
  T_CALL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = T_CALL_RE.exec(text)) !== null) {
    const quote = m[1]
    const raw = m[2]
    if (quote === '`' && templateLiteralHasInterpolation(raw)) {
      continue
    }
    out.add(unescapeStringLiteral(raw))
  }
}

function collectVTKeys(text: string, out: Set<string>): void {
  for (const re of [V_T_DOUBLE_RE, V_T_SINGLE_RE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const quote = m[1]
      const raw = m[2]
      if (quote === '`' && templateLiteralHasInterpolation(raw)) {
        continue
      }
      out.add(unescapeStringLiteral(raw))
    }
  }
}

function collectComponentKeys(text: string, out: Set<string>): void {
  COMPONENT_TAG_RE.lastIndex = 0
  let tag: RegExpExecArray | null
  while ((tag = COMPONENT_TAG_RE.exec(text)) !== null) {
    const body = tag[1]
    COMPONENT_ATTR_RE.lastIndex = 0
    let attr: RegExpExecArray | null
    while ((attr = COMPONENT_ATTR_RE.exec(body)) !== null) {
      const value = attr[2] ?? attr[3] ?? attr[4]
      if (value !== undefined && value !== '') {
        out.add(value)
      }
    }
  }
}

export function extractKeysFromText(text: string): string[] {
  const keys = new Set<string>()
  collectCallKeys(text, keys)
  collectVTKeys(text, keys)
  collectComponentKeys(text, keys)
  return [...keys]
}
