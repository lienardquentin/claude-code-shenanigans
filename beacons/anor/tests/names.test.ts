import { describe, expect, it } from 'vitest'
import { named, reasonOf } from '../app/utils/names'

describe('named', () => {
  it('writes a beacon as it is in the annals', () => {
    expect(named('amon-din')).toBe('Amon Dîn')
    expect(named('min-rimmon')).toBe('Min-Rimmon')
  })

  it('writes a stone too', () => {
    expect(named('ithil')).toBe('Ithil')
  })

  it('leaves a name it does not know as it was given', () => {
    expect(named('mount-doom')).toBe('mount-doom')
  })
})

describe('reasonOf', () => {
  it("takes the realm's own words where it gave some", () => {
    expect(reasonOf({ data: { detail: 'Rohan has 6000 spears, not 9000' } })).toBe('Rohan has 6000 spears, not 9000')
  })

  it.each([
    ['no data', {}],
    ['a detail that is not text', { data: { detail: [{ msg: 'x' }] } }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
  ])('falls back when there is %s', (_, failure) => {
    expect(reasonOf(failure)).toBe('no word came back')
  })
})
