/**
 * @author claude (golter fork)
 *
 * Covers shapes that `no-unused-keys` cares about, plus shapes that look
 * superficially similar but must NOT contribute keys.
 */
import { deepStrictEqual } from 'assert'
import { extractKeysFromText } from '../../../lib/utils/extract-keys-from-text'

function extract(text: string): string[] {
  return extractKeysFromText(text).sort()
}

describe('extractKeysFromText', () => {
  describe('call expressions', () => {
    it('matches $t with a single-quoted literal', () => {
      deepStrictEqual(extract(`$t('hello.world')`), ['hello.world'])
    })

    it('matches t() preceded by a non-identifier character', () => {
      deepStrictEqual(extract(`const k = t('plain')`), ['plain'])
    })

    it('matches member-call this.$i18n.t(...)', () => {
      deepStrictEqual(
        extract(`this.$i18n.t('hello {name}', { name: 'DIO' })`),
        ['hello {name}']
      )
    })

    it('matches all four function names: t, tc, $t, $tc', () => {
      deepStrictEqual(
        extract(`t('a'); tc('b'); $t('c'); $tc('d');`),
        ['a', 'b', 'c', 'd'].sort()
      )
    })

    it('matches double-quoted, single-quoted, and backtick literals', () => {
      deepStrictEqual(
        extract('t(\'a\'); t("b"); t(`c`)'),
        ['a', 'b', 'c'].sort()
      )
    })

    it('skips template literals that contain interpolation', () => {
      deepStrictEqual(extract('t(`hello ${name}`)'), [])
    })

    it('does not match identifiers ending in t( like setTimeout(', () => {
      deepStrictEqual(
        extract(`setTimeout(() => {}, 100); at('x'); et('y')`),
        []
      )
    })

    it('does not match it( or test(', () => {
      deepStrictEqual(extract(`it('does the thing', () => {})`), [])
      deepStrictEqual(extract(`test('does the thing', () => {})`), [])
    })

    it('does not match expect(', () => {
      deepStrictEqual(extract(`expect(x).toBe(true)`), [])
    })

    it('unescapes backslash escapes', () => {
      deepStrictEqual(extract(`t('it\\'s here')`), ["it's here"])
      deepStrictEqual(extract(`t("line\\nbreak")`), ['line\nbreak'])
    })

    it('handles whitespace and newlines around the literal', () => {
      deepStrictEqual(extract(`t(\n  'multi'\n)`), ['multi'])
    })

    it('matches calls with generic type arguments', () => {
      deepStrictEqual(extract(`t<MyType>('foo.bar')`), ['foo.bar'])
      deepStrictEqual(extract(`$t<string>('plain')`), ['plain'])
      deepStrictEqual(extract(`tc<number, string>('plural.example', 2)`), [
        'plural.example'
      ])
    })

    it('matches calls with nested generic type arguments', () => {
      deepStrictEqual(extract(`t<Array<string>>('nested')`), ['nested'])
      deepStrictEqual(extract(`t<Record<string, number>>('record.key')`), [
        'record.key'
      ])
    })

    it('matches generics that span lines', () => {
      deepStrictEqual(
        extract(`t<{\n  a: number;\n  b: string;\n}>('shape.key')`),
        ['shape.key']
      )
    })

    it('does not get confused by an unrelated < comparison', () => {
      // `<` here is a less-than, not a type-arg opener. We should still
      // find `t('after')` further on without false-matching across the
      // intervening code.
      deepStrictEqual(extract(`if (a < b) {} ; t('after')`), ['after'])
    })
  })

  describe('v-t directive', () => {
    it('matches v-t="\'foo\'" (double outside, single inside)', () => {
      deepStrictEqual(extract(`<p v-t="'foo'">x</p>`), ['foo'])
    })

    it('matches v-t=\'"foo"\' (single outside, double inside)', () => {
      deepStrictEqual(extract(`<p v-t='"foo"'>x</p>`), ['foo'])
    })
  })

  describe('<i18n*> components', () => {
    it('matches <i18n path="...">', () => {
      deepStrictEqual(
        extract(`<i18n path="term" tag="label" for="tos">x</i18n>`),
        ['term']
      )
    })

    it('matches <i18n-t keypath="...">', () => {
      deepStrictEqual(extract(`<i18n-t keypath="foo.bar"></i18n-t>`), [
        'foo.bar'
      ])
    })

    it('matches <I18nT keypath="...">', () => {
      deepStrictEqual(extract(`<I18nT keypath="cap.foo" />`), ['cap.foo'])
    })

    it('matches unquoted attribute value', () => {
      deepStrictEqual(extract(`<i18n-t keypath=hello_dio></i18n-t>`), [
        'hello_dio'
      ])
    })

    it('matches attributes on subsequent lines', () => {
      deepStrictEqual(
        extract(`<i18n-t\n  keypath="multi.line"\n  tag="span">\n</i18n-t>`),
        ['multi.line']
      )
    })

    it('does NOT match dynamic :keypath binding (Vue expression)', () => {
      deepStrictEqual(extract(`<i18n-t :keypath="someVar" />`), [])
    })

    it('does NOT match v-bind:keypath binding', () => {
      deepStrictEqual(extract(`<i18n-t v-bind:keypath="someVar" />`), [])
    })
  })

  describe('mixed content', () => {
    it('extracts every key shape from a representative Vue SFC', () => {
      const sfc = `
        <template>
          <p v-t="'hello_dio'">{{ $t('messages.link') }}</p>
          <i18n-t keypath="multi.line" />
        </template>
        <script>
        export default {
          created() {
            this.$i18n.t('hello {name}', { name: 'DIO' })
            tc('plural.example')
          }
        }
        </script>
      `
      deepStrictEqual(
        extract(sfc),
        [
          'hello_dio',
          'messages.link',
          'multi.line',
          'hello {name}',
          'plural.example'
        ].sort()
      )
    })

    it('returns [] for a typical test file with vue-i18n import but no calls', () => {
      const test = `
        import { describe, it, expect } from 'vitest'
        import { mount } from '@vue/test-utils'
        import { useI18n } from 'vue-i18n'
        import MyComponent from './MyComponent.vue'

        describe('MyComponent', () => {
          it('renders translated text', () => {
            const wrapper = mount(MyComponent, {
              global: { plugins: [i18n] }
            })
            expect(wrapper.text()).toContain('Hello')
            expect(useI18n).toHaveBeenCalled()
            setTimeout(() => {}, 0)
          })
        })
      `
      deepStrictEqual(extract(test), [])
    })

    it('deduplicates the same key reported multiple times', () => {
      deepStrictEqual(extract(`t('foo'); $t('foo'); tc('foo')`), ['foo'])
    })
  })
})
