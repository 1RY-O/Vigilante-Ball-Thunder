import { expect, it } from 'vitest'
import appCss from './App.css?raw'
import indexCss from './index.css?raw'

/**
 * Every animation and transition ships behind
 * `@media (prefers-reduced-motion: no-preference)` — including the score
 * fade, the panel entrances, the button hovers, the indeterminate shimmer,
 * the engraving pulse and the note-highlight fill. jsdom never evaluates
 * media queries, so this guards the stylesheet source directly: after
 * removing every reduced-motion gate, no animation/transition may remain.
 */

/** Remove every @media (prefers-reduced-motion …){…} block, brace-balanced. */
function stripMotionGates(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const at = source.indexOf('@media', i)
    if (at < 0) {
      out += source.slice(i)
      break
    }
    const headEnd = source.indexOf('{', at)
    const head = source.slice(at, headEnd)
    let depth = 0
    let j = headEnd
    for (; j < source.length; j++) {
      if (source[j] === '{') depth++
      else if (source[j] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    if (head.includes('prefers-reduced-motion')) {
      i = j + 1
      continue
    }
    out += source.slice(i, j + 1)
    i = j + 1
  }
  return out
}

it('keeps every animation and transition behind prefers-reduced-motion: no-preference', () => {
  const css = `${appCss}\n${indexCss}`
  expect(css).toContain('prefers-reduced-motion')
  const ungated = stripMotionGates(css)
  expect(ungated).not.toMatch(/@keyframes/)
  expect(ungated).not.toMatch(/animation\s*:/)
  expect(ungated).not.toMatch(/transition\s*:/)
})
