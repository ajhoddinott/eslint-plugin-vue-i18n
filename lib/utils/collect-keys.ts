/**
 * @fileoverview Collect localization keys
 * @author kazuya kawaguchi (a.k.a. kazupon)
 */
import { AST as VAST } from 'vue-eslint-parser'
import { readFileSync } from 'fs'
import { resolve, extname } from 'path'
import { listFilesToProcess } from './glob-utils'
import { ResourceLoader } from './resource-loader'
import { CacheLoader } from './cache-loader'
import { defineCacheFunction } from './cache-function'
import debugBuilder from 'debug'
import type { RuleContext, VisitorKeys } from '../types'
import { getCwd } from './get-cwd'
import { isStaticLiteral, getStaticLiteralValue } from './index'
import type { Parser } from './parser-config-resolver'
import { buildParserFromConfig } from './parser-config-resolver'
import { extractKeysFromText } from './extract-keys-from-text'
const debug = debugBuilder('eslint-plugin-vue-i18n:collect-keys')

// Prefilter used by the AST extraction path: if a file contains none of
// these patterns it can't contribute any keys, so we skip the parse. The
// patterns mirror the shapes the AST extractor reports keys from — a call
// to $t/t/$tc/tc, a `v-t=` directive, or an opening `<i18n>` /
// `<i18n-t>` / `<I18nT>` tag. Loose substrings like a bare `i18n` in an
// `import { useI18n } from 'vue-i18n'` would have us parse the entire
// file only to find nothing, so they're deliberately excluded.
// Conservative — false positives are fine (we fall through to parse).
const I18N_REFERENCE_RE =
  /(?:^|[^A-Za-z0-9_$])\$?tc?\s*\(|v-t\s*=|<(?:i18n(?:-t)?|I18nT)\b/

function fileHasI18nReference(filename: string): boolean {
  try {
    return I18N_REFERENCE_RE.test(readFileSync(filename, 'utf8'))
  } catch {
    return true
  }
}

/**
 *
 * @param {CallExpression} node
 */
function getKeyFromCallExpression(node: VAST.ESLintCallExpression) {
  const funcName =
    (node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name) ||
    (node.callee.type === 'Identifier' && node.callee.name) ||
    ''

  if (
    !/^(\$t|t|\$tc|tc)$/.test(funcName) ||
    !node.arguments ||
    !node.arguments.length
  ) {
    return null
  }

  const [keyNode] = node.arguments
  if (!isStaticLiteral(keyNode)) {
    return null
  }

  return getStaticLiteralValue(keyNode)
}

/**
 * @param {VDirective} node
 */
function getKeyFromVDirective(node: VAST.VDirective) {
  if (
    node.value &&
    node.value.type === 'VExpressionContainer' &&
    isStaticLiteral(node.value.expression)
  ) {
    return getStaticLiteralValue(node.value.expression)
  } else {
    return null
  }
}

/**
 * @param {VAttribute} node
 */
function getKeyFromI18nComponent(node: VAST.VAttribute) {
  if (node.value && node.value.type === 'VLiteral') {
    return node.value.value
  } else {
    return null
  }
}

/**
 * Default extractor: parse the file and walk the AST. Matches upstream
 * behaviour exactly. Slower because every source file must be parsed (with
 * @typescript-eslint/parser for .ts*, vue-eslint-parser for .vue, etc.) but
 * tolerant of unusual call shapes.
 */
function collectKeysFromTextUsingAST(filename: string, parser: Parser) {
  const effectiveFilename = filename || '<text>'
  debug(`collectKeysFromFile (ast) ${effectiveFilename}`)
  try {
    if (filename && !fileHasI18nReference(filename)) {
      return []
    }
    const parseResult = parser(filename)
    if (!parseResult) {
      return []
    }
    return collectKeysFromAST(parseResult.ast, parseResult.visitorKeys)
  } catch (_e) {
    return []
  }
}

/**
 * Opt-in fast extractor: read the file and run regex passes over the raw
 * text. Avoids parsing entirely. See `extract-keys-from-text.ts` for the
 * extractor and its edge cases (string concatenation, very long type-arg
 * lists, multi-line `<i18n>` bodies > 1KB).
 */
function collectKeysFromTextUsingRegex(filename: string) {
  debug(`collectKeysFromFile (regex) ${filename || '<text>'}`)
  try {
    return extractKeysFromText(readFileSync(filename, 'utf8'))
  } catch (_e) {
    return []
  }
}

function collectKeyResourcesFromFilesUsingAST(
  fileNames: string[],
  cwd: string
) {
  debug('collectKeysFromFiles (ast)', fileNames)
  const parser = buildParserFromConfig(cwd)
  const results = []
  for (const filename of fileNames) {
    debug(`Processing file ... ${filename}`)
    results.push(
      new ResourceLoader(resolve(filename), () => {
        return collectKeysFromTextUsingAST(filename, parser)
      })
    )
  }
  return results
}

function collectKeyResourcesFromFilesUsingRegex(fileNames: string[]) {
  debug('collectKeysFromFiles (regex)', fileNames)
  const results = []
  for (const filename of fileNames) {
    debug(`Processing file ... ${filename}`)
    results.push(
      new ResourceLoader(resolve(filename), () => {
        return collectKeysFromTextUsingRegex(filename)
      })
    )
  }
  return results
}

/**
 * Collect the used keys from Program node.
 * @returns {string[]}
 */
export function collectKeysFromAST(
  node: VAST.ESLintProgram,
  visitorKeys?: VisitorKeys
): string[] {
  debug('collectKeysFromAST')

  const results = new Set<string>()
  /**
   * @param {Node} node
   */
  function enterNode(node: VAST.Node) {
    if (node.type === 'VAttribute') {
      if (node.directive) {
        if (
          node.key.name.name === 't' ||
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          node.key.name === 't' /* vue-eslint-parser v5 */
        ) {
          debug(
            "call VAttribute[directive=true][key.name.name='t'] handling ..."
          )
          const key = getKeyFromVDirective(node)
          if (key) {
            results.add(String(key))
          }
        }
      } else {
        if (
          (node.key.name === 'path' &&
            (node.parent.parent.name === 'i18n' ||
              node.parent.parent.name === 'i18n-t' ||
              node.parent.parent.rawName === 'I18nT')) ||
          (node.key.name === 'keypath' &&
            (node.parent.parent.name === 'i18n-t' ||
              node.parent.parent.rawName === 'I18nT'))
        ) {
          debug(
            "call VElement:matches([name=i18n], [name=i18n-t], [name=I18nT]) > VStartTag > VAttribute[key.name='path'] handling ..."
          )

          const key = getKeyFromI18nComponent(node)
          if (key) {
            results.add(key)
          }
        }
      }
    } else if (node.type === 'CallExpression') {
      debug('CallExpression handling ...')
      const key = getKeyFromCallExpression(node)
      if (key) {
        results.add(String(key))
      }
    }
  }

  if (node.templateBody) {
    VAST.traverseNodes(node.templateBody, {
      enterNode,
      leaveNode() {
        // noop
      }
    })
  }
  VAST.traverseNodes(node, {
    visitorKeys,
    enterNode,
    leaveNode() {
      // noop
    }
  })

  return [...results]
}

export interface CollectKeysOptions {
  /**
   * Use regex-based extraction instead of parsing each source file. Much
   * faster on TypeScript-heavy projects but doesn't recognise translation
   * keys that are built by string concatenation, or `<i18n>` attribute
   * bodies longer than 1KB. Default: false.
   */
  useRegexExtraction?: boolean
}

class UsedKeysCache {
  private _targetFilesLoader: CacheLoader<
    [string, string[], string[], string],
    string[]
  >
  private _astResources: (
    fileNames: string[],
    cwd: string
  ) => ResourceLoader<string[]>[]
  private _regexResources: (fileNames: string[]) => ResourceLoader<string[]>[]
  constructor() {
    this._targetFilesLoader = new CacheLoader((cwd, files, extensions) => {
      return listFilesToProcess(files, { cwd, extensions })
        .filter(f => !f.ignored && extensions.includes(extname(f.filename)))
        .map(f => f.filename)
    })
    this._astResources = defineCacheFunction((fileNames, cwd) => {
      return collectKeyResourcesFromFilesUsingAST(fileNames, cwd)
    })
    this._regexResources = defineCacheFunction(fileNames => {
      return collectKeyResourcesFromFilesUsingRegex(fileNames)
    })
  }
  /**
   * Collect the used keys from files.
   * @param {string[]} files
   * @param {string[]} extensions
   * @returns {string[]}
   */
  collectKeysFromFiles(
    files: string[],
    extensions: string[],
    context: RuleContext,
    options: CollectKeysOptions = {}
  ) {
    const result = new Set<string>()
    for (const resource of this._getKeyResources(
      context,
      files,
      extensions,
      options
    )) {
      for (const key of resource.getResource()) {
        result.add(key)
      }
    }
    return [...result]
  }

  /**
   * @returns {ResourceLoader[]}
   */
  _getKeyResources(
    context: RuleContext,
    files: string[],
    extensions: string[],
    options: CollectKeysOptions
  ) {
    const cwd = getCwd(context)
    const fileNames = this._targetFilesLoader.get(cwd, files, extensions, cwd)
    return options.useRegexExtraction
      ? this._regexResources(fileNames)
      : this._astResources(fileNames, cwd)
  }
}

export const usedKeysCache = new UsedKeysCache() // used locale message keys
