import { describe, expect, test } from 'claude-code/testing'

import { carriedOf } from '../hooks/stores'

describe('the stores kept under other plugin ids before', () => {
  test('give up the plans and runs the plugin does not hold yet, and nothing else', () => {
    const elrond = JSON.stringify({ 'plan:github:o/r#34': { ref: 'github:o/r#34' }, 'plan:github:o/r#35': { ref: 'github:o/r#35' }, other: 1 })

    expect(carriedOf(elrond, 'plan:', ['plan:github:o/r#35'])).toEqual([['plan:github:o/r#34', { ref: 'github:o/r#34' }]])
    expect(carriedOf(JSON.stringify({ 'quest:github:o/r#37': { phase: 'submitted' } }), 'quest:', [])).toEqual([['quest:github:o/r#37', { phase: 'submitted' }]])
  })

  test('give up a run kept under quest: as a run:, and none the plugin holds already under its new key', () => {
    const kept = JSON.stringify({ 'quest:github:o/r#37': { phase: 'sailed' }, 'quest:github:o/r#38': { phase: 'arrived' } })

    expect(carriedOf(kept, 'quest:', ['run:github:o/r#38'], 'run:')).toEqual([['run:github:o/r#37', { phase: 'sailed' }]])
  })

  test('give up nothing that is not a store', () => {
    for (const text of ['', 'not json', '[1, 2]', 'null']) expect(carriedOf(text, 'plan:', [])).toEqual([])
  })
})
