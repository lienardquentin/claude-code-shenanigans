import { describe, expect, test } from 'claude-code/testing'

import { carriedOf } from '../hooks/stores'

describe('the stores the mods kept before they were one', () => {
  test('give up the plans and quests the plugin does not hold yet, and nothing else', () => {
    const elrond = JSON.stringify({ 'plan:github:o/r#34': { ref: 'github:o/r#34' }, 'plan:github:o/r#35': { ref: 'github:o/r#35' }, other: 1 })

    expect(carriedOf(elrond, 'plan:', ['plan:github:o/r#35'])).toEqual([['plan:github:o/r#34', { ref: 'github:o/r#34' }]])
    expect(carriedOf(JSON.stringify({ 'quest:github:o/r#37': { phase: 'sailed' } }), 'quest:', [])).toEqual([['quest:github:o/r#37', { phase: 'sailed' }]])
  })

  test('give up nothing that is not a store', () => {
    for (const text of ['', 'not json', '[1, 2]', 'null']) expect(carriedOf(text, 'plan:', [])).toEqual([])
  })
})
