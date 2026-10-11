import { describe, expect, test } from 'claude-code/testing'

const PANE = { bodyColumns: 80 } as const

const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({
    plugin: 'mermaid-view',
    surface: 'terminal',
    component: 'Pane',
    props: PANE as never,
    requestId: 'mermaid-view',
  })

// Stands for the engine: a pane the mod opens is placed
const answerOpen = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)

describe('mermaid-view', () => {
  test('says so when no diagram was given', async $ => {
    const pane = await mountPane($)

    expect(await pane.find({ text: /No diagram yet/ })).toBeDefined()
  })

  test('draws a three-node flowchart with its labels and its edges', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A[Start] --> B[Process]; B --> C[End]' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /│ Start │/ })).toBeDefined()
    expect(await pane.find({ text: /│ Process │/ })).toBeDefined()
    expect(await pane.find({ text: /│ End │/ })).toBeDefined()
    // one arrowhead for each of the two edges
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(2)
    expect(await pane.find({ text: /No diagram yet/ })).toBeUndefined()
  })

  test('a node that has two targets is joined to both, and they join again below', async ($, on) => {
    answerOpen(on)
    await $.command.run({
      command: 'mermaid-view',
      args: 'graph TD; A[Start] --> B[Left]; A --> C[Right]; B --> D[End]; C --> D',
    })
    const pane = await mountPane($)

    // the two boxes of one layer sit on the same row, and the line from Start splits above them
    expect(await pane.find({ type: 'Text', text: /│ Left │\s+│ Right │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌────┴─────┐/ })).toBeDefined()
    // Left joins End's column on one row, and Right joins it from the other side on the row below
    expect(await pane.find({ type: 'Text', text: /└────┐/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /├─────┘/ })).toBeDefined()
    // two arrowheads side by side into the second layer, and one into End: two lines in all
    expect(await pane.findAll({ type: 'Text', text: /▼\s+▼/ })).toHaveLength(1)
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(2)
  })

  test('an edge that skips a layer runs beside the nodes, not through them', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> B; B --> C; A --> C' })
    const pane = await mountPane($)

    // B's box is intact, with the lane at its right
    expect(await pane.find({ type: 'Text', text: /│ B │  │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /├────┐/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /├────┘/ })).toBeDefined()
  })

  test('an edge that goes back up is drawn, and the drawing ends', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> B; B --> A' })
    const pane = await mountPane($)

    expect(await pane.find({ type: 'Text', text: /│ A │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /│ B │/ })).toBeDefined()
    // the edge comes back to A from above: an arrowhead over A, besides the one over B
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(2)
  })

  test('an edge from a node to itself is drawn', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> A' })
    const pane = await mountPane($)

    expect(await pane.find({ type: 'Text', text: /│ A │/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(1)
  })

  test('a node named without a label shows its id, and a later label names it', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'flowchart TD\nA --> B\nB[Done]' })
    const pane = await mountPane($)

    expect(await pane.find({ type: 'Text', text: /│ A │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /│ Done │/ })).toBeDefined()
  })

  test('source it cannot read is shown with the line it stopped at, never a wrong picture', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> B; B ==> C' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /Could not read this diagram at: B ==> C/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
  })

  test('a direction that is not drawn yet is reported, not drawn top-down', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph LR; A --> B' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /Could not read this diagram at: graph LR/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
  })

  test('a diagram with a header and no nodes says so', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /This diagram has no nodes/ })).toBeDefined()
  })

  test('a label may hold a semicolon, an arrow and quotes, and an id a hyphen', async ($, on) => {
    answerOpen(on)
    await $.command.run({
      command: 'mermaid-view',
      args: 'graph TD; first-step["Read; then --> write"] --> done[Done]',
    })
    const pane = await mountPane($)

    expect(await pane.find({ type: 'Text', text: /│ Read; then --> write │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /│ Done │/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(1)
  })

  test('nodes of a layer are ordered under their sources so that edges do not cross needlessly', async ($, on) => {
    answerOpen(on)
    // R and S are named in the order that would make P to S and Q to R cross
    await $.command.run({
      command: 'mermaid-view',
      args: 'graph TD; P[P]; Q[Q]; R[R]; S[S]; P --> S; Q --> R',
    })
    const pane = await mountPane($)

    // S stands under P and R under Q, and no line joins the two edges
    expect(await pane.find({ type: 'Text', text: /│ S │\s+│ R │/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /[├┤┬┴┼]/ })).toHaveLength(0)
  })

  test('running the command again replaces the diagram', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A[First] --> B' })
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; X[Second] --> Y' })
    const pane = await mountPane($)

    expect(await pane.find({ type: 'Text', text: /│ Second │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /│ First │/ })).toBeUndefined()
  })
})
