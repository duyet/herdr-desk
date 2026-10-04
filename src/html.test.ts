import { describe, expect, test } from 'bun:test'
import { escapeHtml } from './html'

describe('escapeHtml', () => {
  test('escapes the five markup characters and leaves a word alone', () => {
    // A queue repo or a desk name is untrusted text in the page.
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;')
    expect(escapeHtml('herdr')).toBe('herdr')
  })
})
