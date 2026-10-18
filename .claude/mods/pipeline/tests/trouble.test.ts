import { describe, expect } from 'claude-code/testing'
import { test } from './hook-test'

import { forgetTroubles, inBackground, kept, troublesText } from '../hooks/trouble'

describe('what a part fails at', () => {
  test('is kept and counted, and said again only when it fails otherwise', () => {
    forgetTroubles()

    expect(troublesText()).toBe('No part of the pipeline has failed since the session started.')
    expect(kept('verify', new Error('the proof timed out'), 1_000)).toBe(true)
    expect(kept('verify', new Error('the proof timed out'), 2_000)).toBe(false)
    expect(kept('verify', new Error('git knows no commit'), 3_000)).toBe(true)
    expect(troublesText()).toBe(`verify: failed 3 times, last at ${new Date(3_000).toISOString()}: git knows no commit`)
  })

  test('in a clock\'s callback is said in a toast and kept, where it was once dropped', async () => {
    forgetTroubles()
    const toasts: string[] = []
    const $ = { ui: { toast: (text: string) => void toasts.push(text) } }

    const tick = inBackground($ as never, 'the build', () => Promise.reject(new Error('the store could not be written\nat line 2')))

    tick()
    tick()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(toasts).toEqual(['Pipeline: the build failed: the store could not be written'])
    expect(troublesText()).toMatch(/^the build: failed 2 times, last at .*: the store could not be written/)
  })
})
