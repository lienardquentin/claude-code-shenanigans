import { describe, expect, test } from 'claude-code/testing'

const PANE = { bodyColumns: 80 } as const

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0], surface: Surface = 'terminal') =>
  $.ui.mount({
    plugin: 'mermaid-view',
    surface,
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
    expect(await pane.find({ text: /│ Left │\s+│ Right │/ })).toBeDefined()
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
    expect(await pane.find({ text: /│ B │  │/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /├────┐/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /├────┘/ })).toBeDefined()
  })

  test('an edge that goes back up is drawn, and the drawing ends', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> B; B --> A' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /│ A │/ })).toBeDefined()
    expect(await pane.find({ text: /│ B │/ })).toBeDefined()
    // the edge comes back to A from above: an arrowhead over A, besides the one over B
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(2)
  })

  test('an edge from a node to itself is drawn', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> A' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /│ A │/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /▼/ })).toHaveLength(1)
  })

  test('a node named without a label shows its id, and a later label names it', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'flowchart TD\nA --> B\nB[Done]' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /│ A │/ })).toBeDefined()
    expect(await pane.find({ text: /│ Done │/ })).toBeDefined()
  })

  test('source it cannot read is shown with the line it stopped at, never a wrong picture', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A --> B; B ~~~ C' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /Could not read this diagram at: B ~~~ C/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
  })

  test('a direction that does not exist is reported, not drawn top-down', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph XY; A --> B' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /Could not read this diagram at: graph XY/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
  })

  describe('syntax', () => {
    const draw = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      on: Parameters<Parameters<typeof test>[1]>[1],
      args: string,
    ) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($)
    }

    // Where a node's label first appears in the drawn tree, which is top to bottom: a smaller number is higher up
    const rowOf = async (pane: Awaited<ReturnType<typeof mountPane>>, label: string): Promise<number> =>
      JSON.stringify(await pane.drawn()).indexOf(label)

    test('top-down is the default, and TB and TD mean the same', async ($, on) => {
      const pane = await draw($, on, 'flowchart TB; A --> B')

      expect(await pane.find({ text: /▼/ })).toBeDefined()
    })

    test('bottom-up draws the first node at the bottom, with arrowheads pointing up', async ($, on) => {
      const pane = await draw($, on, 'graph BT; A[First] --> B[Second]')
      const first = await rowOf(pane, '│ First │')
      const second = await rowOf(pane, '│ Second │')

      expect(await pane.find({ text: /▲/ })).toBeDefined()
      expect(await pane.find({ text: /▼/ })).toBeUndefined()
      expect(first).toBeGreaterThan(second)
    })

    test('left to right puts the nodes on one row with the arrowhead pointing right', async ($, on) => {
      const pane = await draw($, on, 'graph LR; A[Start] --> B[End]')

      expect(await pane.find({ text: /│ Start │.*│ End │/ })).toBeDefined()
      expect(await pane.find({ text: /▶/ })).toBeDefined()
    })

    test('right to left puts the first node on the right with the arrowhead pointing left', async ($, on) => {
      const pane = await draw($, on, 'graph RL; A[Start] --> B[End]')

      expect(await pane.find({ text: /│ End │.*│ Start │/ })).toBeDefined()
      expect(await pane.find({ text: /◀/ })).toBeDefined()
    })

    test('a flow left to right stacks the nodes of a layer and keeps their boxes whole', async ($, on) => {
      const pane = await draw($, on, 'graph LR; A[Start] --> B[Yes]; A --> C[No]')

      expect(await pane.find({ text: /│ Start │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Yes │/ })).toBeDefined()
      expect(await pane.find({ text: /│ No │/ })).toBeDefined()
      expect(await pane.findAll({ type: 'Text', text: /▶/ })).toHaveLength(2)
    })

    test('a node of each shape is drawn with its own outline', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A[Plain]; B(Round); C([Pill]); D{Choose}; E((Dot))')

      expect(await pane.find({ text: /│ Plain │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Round │/ })).toBeDefined()
      expect(await pane.find({ text: /╭/ })).toBeDefined()
      expect(await pane.find({ text: /\( Pill \)/ })).toBeDefined()
      expect(await pane.find({ text: /< Choose >/ })).toBeDefined()
      expect(await pane.find({ text: /\(\( Dot \)\)/ })).toBeDefined()
    })

    test('a shape that is not closed as it was opened is reported', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A[Open)')

      expect(await pane.find({ text: /Could not read this diagram at: A\[Open\)/ })).toBeDefined()
    })

    test('an open line has no arrowhead', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A --- B')

      expect(await pane.find({ text: /▼/ })).toBeUndefined()
      // the line between the boxes is still drawn
      expect(await pane.find({ type: 'Text', text: /^\s*│$/ })).toBeDefined()
    })

    test('a dotted arrow is drawn dotted, with its arrowhead', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A -.-> B')

      expect(await pane.find({ text: /┆/ })).toBeDefined()
      expect(await pane.find({ text: /▼/ })).toBeDefined()
    })

    test('a thick arrow is drawn thick, with its arrowhead', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A ==> B')

      expect(await pane.find({ text: /┃/ })).toBeDefined()
      expect(await pane.find({ text: /▼/ })).toBeDefined()
    })

    test('an edge label sits by its arrowhead', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A --> |yes| B')

      expect(await pane.find({ type: 'Text', text: /▼ ?$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /yes/ })).toBeDefined()
    })

    test('a label on an edge flowing sideways is drawn on the line before the arrowhead', async ($, on) => {
      const pane = await draw($, on, 'graph LR; A -->|go| B')

      expect(await pane.find({ type: 'Text', text: /go/ })).toBeDefined()
      expect(await pane.find({ text: /│ A │/ })).toBeDefined()
      expect(await pane.find({ text: /│ B │/ })).toBeDefined()
    })

    test('a & fans an edge out to every node, and in from every node', async ($, on) => {
      const pane = await draw($, on, 'graph TD; A & B --> C & D')

      // four edges, two arrowheads each side by side on one row
      expect(await pane.findAll({ type: 'Text', text: /▼\s+▼/ })).toHaveLength(1)
      expect(await pane.find({ text: /│ C │\s+│ D │/ })).toBeDefined()
    })

    test('a comment line is ignored', async ($, on) => {
      const pane = await draw($, on, 'graph TD\n%% a note\nA --> B')

      expect(await pane.find({ text: /│ A │/ })).toBeDefined()
      expect(await pane.find({ text: /a note/ })).toBeUndefined()
    })
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

    expect(await pane.find({ text: /│ Read; then --> write │/ })).toBeDefined()
    expect(await pane.find({ text: /│ Done │/ })).toBeDefined()
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
    expect(await pane.find({ text: /│ S │\s+│ R │/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /[├┤┬┴┼]/ })).toHaveLength(0)
  })

  describe('selecting a node', () => {
    const CHAIN = 'graph TD; A[Start] --> B[Process]; B --> C[End]'

    const open = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      on: Parameters<Parameters<typeof test>[1]>[1],
      args: string,
    ) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($)
    }

    const colored = async (pane: Awaited<ReturnType<typeof mountPane>>, text: RegExp) =>
      (await pane.findAll({ type: 'Text', text })).some(found => found.props.color === 'claude')

    test('pressing a node selects it and lists what it leads to and where it is reached from', async ($, on) => {
      const pane = await open($, on, CHAIN)

      expect(await pane.find({ text: /Selected:/ })).toBeUndefined()

      await pane.press({ key: 'node-B' })

      expect(await pane.find({ text: /Selected: Process/ })).toBeDefined()
      expect(await pane.find({ text: /Leads to: End/ })).toBeDefined()
      expect(await pane.find({ text: /Reached from: Start/ })).toBeDefined()
    })

    test('any row of a node\'s box selects it', async ($, on) => {
      const pane = await open($, on, CHAIN)

      await pane.press({ key: 'node-C-top' })
      expect(await pane.find({ text: /Selected: End/ })).toBeDefined()

      await pane.press({ key: 'node-A-bottom' })
      expect(await pane.find({ text: /Selected: Start/ })).toBeDefined()
    })

    test('the selected node and the edges that touch it are drawn in the accent color, no others', async ($, on) => {
      const pane = await open($, on, CHAIN)

      expect(await colored(pane, /Process/)).toBe(false)

      await pane.press({ key: 'node-A' })

      expect(await colored(pane, /Start/)).toBe(true)
      expect(await colored(pane, /Process/)).toBe(false)
      // A leads to B: the arrowhead above Process is accented, the one above End is not
      const arrows = await pane.findAll({ type: 'Text', text: /▼/ })
      expect(arrows.filter(arrow => arrow.props.color === 'claude')).toHaveLength(1)
    })

    test('a node with no edges says none', async ($, on) => {
      const pane = await open($, on, 'graph TD; A[Start] --> B[Process]; Z[Alone]')

      await pane.press({ key: 'node-Z' })

      expect(await pane.find({ text: /Leads to: none/ })).toBeDefined()
      expect(await pane.find({ text: /Reached from: none/ })).toBeDefined()
    })

    test('pressing another node moves the selection', async ($, on) => {
      const pane = await open($, on, CHAIN)

      await pane.press({ key: 'node-A' })
      await pane.press({ key: 'node-C' })

      expect(await pane.find({ text: /Selected: End/ })).toBeDefined()
      expect(await pane.find({ text: /Selected: Start/ })).toBeUndefined()
    })

    test('pressing the selected node again, or Clear, clears the selection', async ($, on) => {
      const pane = await open($, on, CHAIN)

      await pane.press({ key: 'node-B' })
      await pane.press({ key: 'node-B' })
      expect(await pane.find({ text: /Selected:/ })).toBeUndefined()

      await pane.press({ key: 'node-B' })
      await pane.press({ key: 'clear-selection' })
      expect(await pane.find({ text: /Selected:/ })).toBeUndefined()
      expect(await colored(pane, /Process/)).toBe(false)
    })

    test('a new diagram clears the selection', async ($, on) => {
      const pane = await open($, on, CHAIN)

      await pane.press({ key: 'node-B' })
      await $.command.run({ command: 'mermaid-view', args: 'graph TD; B --> X' })

      expect(await pane.find({ text: /Selected:/ })).toBeUndefined()
    })
  })

  describe('on the surfaces that cannot draw a box as buttons', () => {
    const CHAIN = 'graph TD; A[Start] --> B[Process]; B --> C[End]'

    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      test(`${surface}: a picture and a button per node, and the pane says it is the fallback view`, async ($, on) => {
        answerOpen(on)
        await $.command.run({ command: 'mermaid-view', args: CHAIN })
        const pane = await mountPane($, surface)

        expect(await pane.find({ text: /Fallback view/ })).toBeDefined()
        expect(await pane.find({ type: 'Svg' })).toBeDefined()
        expect(await pane.find({ type: 'Button', key: 'node-A' })).toBeDefined()
        expect(await pane.find({ type: 'Button', key: 'node-B' })).toBeDefined()
        expect(await pane.find({ type: 'Button', key: 'node-C' })).toBeDefined()
        // the terminal's drawing is not repeated beside the picture
        expect(await pane.find({ text: /┌/ })).toBeUndefined()
      })

      test(`${surface}: pressing a node's button selects it, and a second press clears it`, async ($, on) => {
        answerOpen(on)
        await $.command.run({ command: 'mermaid-view', args: CHAIN })
        const pane = await mountPane($, surface)

        await pane.press({ key: 'node-B' })

        expect(await pane.find({ text: /Selected: Process/ })).toBeDefined()
        expect(await pane.find({ text: /Leads to: End/ })).toBeDefined()

        await pane.press({ key: 'node-B' })

        expect(await pane.find({ text: /Selected:/ })).toBeUndefined()
      })
    }

    test('the picture names the diagram for a reader that cannot see it', async ($, on) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args: CHAIN })
      const pane = await mountPane($, 'desktop')

      const svg = await pane.find({ type: 'Svg' })

      expect(String(svg?.props.alt)).toMatch(/Start/)
      expect(String(svg?.props.alt)).toMatch(/3 nodes/)
      expect(String(svg?.props.source)).toMatch(/^<svg /)
    })

    test('markup in a label is escaped in the picture', async ($, on) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args: 'graph TD; A["<b>&x</b>"] --> B' })
      const pane = await mountPane($, 'desktop')

      const source = String((await pane.find({ type: 'Svg' }))?.props.source)

      expect(source).toContain('&lt;b&gt;&amp;x&lt;/b&gt;')
      expect(source).not.toContain('<b>')
    })
  })

  test('running the command again replaces the diagram', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; A[First] --> B' })
    await $.command.run({ command: 'mermaid-view', args: 'graph TD; X[Second] --> Y' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /│ Second │/ })).toBeDefined()
    expect(await pane.find({ text: /│ First │/ })).toBeUndefined()
  })
})
