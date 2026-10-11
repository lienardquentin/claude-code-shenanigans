import { describe, expect, test } from 'claude-code/testing'

import { WHEEL_STEP, clipDrawing, drawingWidth, spanOfNode, wheelOffset, windowFor } from '../hooks/window'

const seg = (text: string, node?: string) => ({ text, hot: false, ...(node !== undefined ? { node } : {}) })

describe('the window across a drawing', () => {
  test('knows how wide a drawing is', () => {
    expect(drawingWidth([[seg('ab'), seg('cde')], [seg('x')]])).toBe(5)
    expect(drawingWidth([])).toBe(0)
  })

  test('cuts a drawing to the cells of the window, and keeps a node on a box that is cut', () => {
    const rows = [[seg('..'), seg('[node]', 'N'), seg('..')]]

    expect(clipDrawing(rows, 0, 4)).toEqual([[seg('..'), seg('[n', 'N')]])
    expect(clipDrawing(rows, 4, 6)).toEqual([[seg('ode]', 'N'), seg('..')]])
  })

  test('finds where a node stands, and where a window has to start for it to show', () => {
    const rows = [[seg('....'), seg('[ab]', 'N')]]

    expect(spanOfNode(rows, 'N')).toEqual({ start: 4, end: 8 })
    expect(spanOfNode(rows, 'M')).toBeUndefined()
    // already in: where it is; beyond the right edge: moved just far enough; before the left edge: its start
    expect(windowFor(2, 10, { start: 4, end: 8 })).toBe(2)
    expect(windowFor(0, 6, { start: 4, end: 8 })).toBe(2)
    expect(windowFor(6, 6, { start: 4, end: 8 })).toBe(4)
  })
})

describe('the wheel moving a drawing across', () => {
  test('moves by a fixed step a tick, right for a positive tick and left for a negative one', () => {
    expect(wheelOffset(0, 1, 100)).toBe(WHEEL_STEP)
    expect(wheelOffset(12, -1, 100)).toBe(12 - WHEEL_STEP)
    expect(wheelOffset(0, 3, 100)).toBe(3 * WHEEL_STEP)
  })

  test('never goes left of the start or right of the end of the drawing', () => {
    expect(wheelOffset(2, -5, 100)).toBe(0)
    expect(wheelOffset(98, 5, 100)).toBe(100)
    expect(wheelOffset(0, 5, 0)).toBe(0)
  })
})