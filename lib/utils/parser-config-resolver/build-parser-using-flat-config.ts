import path from 'path'
import { createRequire } from 'module'
import type { Linter } from 'eslint'
import type { Parser } from '.'
import { parseByParser } from './parse-by-parser'

// Previously, this file used `synckit` to spawn a worker that called
// `eslint.calculateConfigForFile(filePath)` once per source file scanned by
// `no-unused-keys`. Loading the user's flat config inside that worker took
// over a second in synthetic tests and several seconds in real
// Nuxt/TypeScript projects on every cold run, even though the resolved
// config was used only to find the parser. See
// https://github.com/intlify/eslint-plugin-vue-i18n/issues/354.
//
// Instead, infer the parser from the file extension. This skips the flat
// config load entirely and is correct for the overwhelming majority of
// projects, which use the standard parser for each extension:
//   - .vue  -> vue-eslint-parser, with @typescript-eslint/parser delegated
//             for `<script lang="ts">` blocks when it is installed.
//   - .ts*  -> @typescript-eslint/parser (resolved from the user's cwd).
//   - .*    -> espree (parse-by-parser's default).

const VUE_RE = /\.vue$/
const TS_RE = /\.(?:ts|tsx|mts|cts)$/
const JSX_RE = /\.(?:jsx|tsx)$/

interface ResolvedTsParser {
  // The required module (used as a parser instance for .ts files).
  module: Linter.Parser
  // The resolved specifier string (passed in parserOptions.parser so that
  // vue-eslint-parser can require it itself for `<script lang="ts">`).
  specifier: string
}

function resolveTypeScriptParser(
  cwd: string,
  cache: Map<string, ResolvedTsParser | null>
): ResolvedTsParser | null {
  const cached = cache.get(cwd)
  if (cached !== undefined) {
    return cached
  }
  try {
    // Resolve from the user's project so we use the same TS parser version
    // they already depend on. `path.join(cwd, '_')` gives createRequire a
    // file-style anchor inside `cwd`.
    const req = createRequire(path.join(cwd, '_'))
    const specifier = req.resolve('@typescript-eslint/parser')
    const resolved: ResolvedTsParser = {
      module: req(specifier) as Linter.Parser,
      specifier
    }
    cache.set(cwd, resolved)
    return resolved
  } catch {
    cache.set(cwd, null)
    return null
  }
}

function buildParserOptions(filePath: string, tsParserSpecifier?: string) {
  const ecmaFeatures: { jsx?: boolean } = {}
  if (JSX_RE.test(filePath)) {
    ecmaFeatures.jsx = true
  }
  const options: Record<string, unknown> = {
    sourceType: 'module',
    ecmaVersion: 'latest',
    ecmaFeatures,
    loc: true,
    range: true,
    raw: true,
    tokens: true,
    comment: true,
    eslintVisitorKeys: true,
    eslintScopeManager: true,
    filePath
  }
  if (tsParserSpecifier) {
    // vue-eslint-parser uses this to parse `<script lang="ts">` blocks.
    options.parser = tsParserSpecifier
  }
  return options
}

export function buildParserUsingFlatConfig(cwd: string): Parser {
  const tsParserCache = new Map<string, ResolvedTsParser | null>()

  return (filePath: string) => {
    let parser: Linter.Parser | undefined
    let tsParserSpecifier: string | undefined
    if (VUE_RE.test(filePath)) {
      const tsParser = resolveTypeScriptParser(cwd, tsParserCache)
      if (tsParser) {
        tsParserSpecifier = tsParser.specifier
      }
      // parse-by-parser falls back to vue-eslint-parser when no parser is
      // provided for a .vue file.
    } else if (TS_RE.test(filePath)) {
      const tsParser = resolveTypeScriptParser(cwd, tsParserCache)
      if (tsParser) {
        parser = tsParser.module
      }
      // If @typescript-eslint/parser isn't installed, fall through to
      // espree. It will reject TS-only syntax and the file is skipped
      // (returns no keys). That matches the previous behaviour when a
      // user's eslint config also didn't supply a TS parser.
    }
    return parseByParser(
      filePath,
      parser,
      buildParserOptions(filePath, tsParserSpecifier)
    )
  }
}
