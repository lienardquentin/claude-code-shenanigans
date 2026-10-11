import { describe, expect, test } from 'claude-code/testing'

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

const mountPane = (
  $: Parameters<Parameters<typeof test>[1]>[0],
  surface: Surface = 'terminal',
  bodyColumns = 80,
) =>
  $.ui.mount({
    plugin: 'mermaid-view',
    surface,
    component: 'Pane',
    props: { bodyColumns } as never,
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

    expect(await pane.find({ text: /Line 1: invisible links/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
  })

  test('a direction that does not exist is reported, not drawn top-down', async ($, on) => {
    answerOpen(on)
    await $.command.run({ command: 'mermaid-view', args: 'graph XY; A --> B' })
    const pane = await mountPane($)

    expect(await pane.find({ text: /Could not read this diagram at line 1: graph XY/ })).toBeDefined()
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

      expect(await pane.find({ text: /Could not read this diagram at line 1: A\[Open\)/ })).toBeDefined()
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

    // The element of the drawn tree that has a child with this key: the row a node's button is in
    const rowHolding = (tree: unknown, key: string): unknown => {
      const children = (tree as { children?: unknown[] } | null)?.children ?? []

      if (children.some(child => (child as { props?: { key?: string } })?.props?.key === key)) return tree

      for (const child of children) {
        const found = typeof child === 'object' && child !== null ? rowHolding(child, key) : undefined
        if (found !== undefined) return found
      }

      return undefined
    }

    describe('subgraphs', () => {
      test('a subgraph is a titled box around its nodes, and not around the others', async ($, on) => {
        const pane = await draw($, on, 'graph TD; subgraph one [Build]; A[Compile] --> B[Link]; end; B --> C[Ship]')

        expect(await pane.find({ type: 'Text', text: /╔═ Build ═+╗/ })).toBeDefined()
        // an edge leaves the box through its bottom edge, so the edge is not one unbroken bar
        expect(await pane.find({ type: 'Text', text: /╚═+│═+╝/ })).toBeDefined()
        expect(await pane.find({ text: /║\s*│ Compile │\s*║/ })).toBeDefined()
        expect(await pane.find({ text: /║\s*│ Link │\s*║/ })).toBeDefined()
        // Ship is outside the box: the row it is on holds no box edge
        const rowOfShip = rowHolding(await pane.drawn(), 'node-C')
        expect(rowOfShip).toBeDefined()
        expect(JSON.stringify(rowOfShip)).not.toContain('║')
      })

      test('a subgraph named by its title alone is drawn with that title', async ($, on) => {
        const pane = await draw($, on, 'graph TD; subgraph Backend services; A --> B; end')

        expect(await pane.find({ type: 'Text', text: /╔═ Backend services ═*╗/ })).toBeDefined()
      })

      test('a subgraph inside another is drawn inside its box, both titled', async ($, on) => {
        const pane = await draw(
          $,
          on,
          'graph TD; subgraph outer [Outer]; subgraph inner [Inner]; A --> B; end; end',
        )

        expect(await pane.find({ type: 'Text', text: /╔═ Outer ═+╗/ })).toBeDefined()
        expect(await pane.find({ type: 'Text', text: /║╔═ Inner ═+╗\s*║/ })).toBeDefined()
        expect(await pane.find({ type: 'Text', text: /║╚═+╝\s*║/ })).toBeDefined()
      })

      test('the nodes of a subgraph stand together in their layer', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A --> B; A --> C; A --> D; subgraph s [S]; B; D; end')

        expect(await pane.find({ text: /│ B │.*│ D │.*│ C │/ })).toBeDefined()
      })

      test('an end with no subgraph, or a subgraph never closed, is reported', async ($, on) => {
        const stray = await draw($, on, 'graph TD; A --> B; end')

        expect(await stray.find({ text: /Could not read this diagram at line 1: end/ })).toBeDefined()
      })

      test('a subgraph that is never closed is reported', async ($, on) => {
        const pane = await draw($, on, 'graph TD; subgraph s [S]; A --> B')

        expect(await pane.find({ text: /Could not read this diagram at line 1: subgraph s \[S\]/ })).toBeDefined()
      })
    })

    describe('classes and styles', () => {
      const colorOf = async (pane: Awaited<ReturnType<typeof mountPane>>, text: RegExp) =>
        (await pane.findAll({ type: 'Text', text })).map(found => found.props.color)

      test('a class named for a tone draws its nodes in that theme color', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A[Safe] --> B[Risky]; classDef success fill:#0f0; class A success; class B danger')

        expect(await colorOf(pane, /Safe/)).toContain('success')
        expect(await colorOf(pane, /Risky/)).toContain('error')
      })

      test('::: gives a node a class', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A[Careful]:::warning --> B')

        expect(await colorOf(pane, /Careful/)).toContain('warning')
      })

      test('any other class, and a style, mark a node out in the accent color', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A[One] --> B[Two]; classDef big stroke-width:4px; class A big; style B fill:#f9f,stroke:#333')

        expect(await colorOf(pane, /One/)).toContain('claude')
        expect(await colorOf(pane, /Two/)).toContain('claude')
      })

      test('the colors a source names never reach the drawing', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A --> B; classDef big fill:#ff0000,stroke:#00ff00; class A big; style B fill:#abcdef')
        const tree = JSON.stringify(await pane.drawn())

        expect(tree).not.toMatch(/#[0-9a-fA-F]{3,6}/)
      })

      test('the selection still shows over a node\'s own color', async ($, on) => {
        const pane = await draw($, on, 'graph TD; A[Safe]:::success --> B')

        await pane.press({ key: 'node-A' })

        expect(await colorOf(pane, /Safe/)).toContain('claude')
      })
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

  describe('a drawing wider than the pane', () => {
    // Four nodes of width 7 under a root: 37 cells across, or 31 closed up; the pane's room is its columns less 4
    const WIDE = 'graph TD; R[Root] --> A[abc]; R --> B[def]; R --> C[ghi]; R --> D[jkl]'
    const NARROW_PANE = 36 + 4

    const open = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      on: Parameters<Parameters<typeof test>[1]>[1],
      args: string,
      columns: number,
    ) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($, 'terminal', columns)
    }

    // The longest line the pane draws, in cells: what has to fit in its room
    const longest = async (pane: Awaited<ReturnType<typeof mountPane>>): Promise<number> => {
      const tree = (await pane.drawn()) as { children?: unknown[] }
      let widest = 0

      const walk = (element: unknown): void => {
        const node = element as { type?: string; props?: { key?: string }; children?: unknown[] }
        if (node?.type === 'Box' && /^row-\d+$/.test(node.props?.key ?? '')) {
          const text = (node.children ?? []).map(function flatten(child: unknown): string {
            const c = child as { children?: unknown[] }
            return typeof child === 'string' ? child : (c.children ?? []).map(flatten).join('')
          })
          widest = Math.max(widest, Array.from(text.join('')).length)
        }
        for (const child of (node?.children ?? []) as unknown[]) if (typeof child === 'object' && child !== null) walk(child)
      }
      walk(tree)

      return widest
    }

    test('fits: no controls, and nothing is cut', async ($, on) => {
      const pane = await open($, on, WIDE, 80)

      expect(await pane.find({ type: 'Button', key: 'scroll-right' })).toBeUndefined()
      expect(await pane.find({ type: 'Button', key: 'fit-width' })).toBeUndefined()
      expect(await pane.find({ text: /│ abc │.*│ jkl │/ })).toBeDefined()
    })

    test('is cut to the pane, and a button moves what shows to the right and back', async ($, on) => {
      const pane = await open($, on, WIDE, NARROW_PANE - 2)

      expect(await longest(pane)).toBeLessThanOrEqual(NARROW_PANE - 2 - 4)
      expect(await pane.find({ type: 'Button', key: 'scroll-left' })).toBeUndefined()
      expect(await pane.find({ type: 'Button', key: 'scroll-right' })).toBeDefined()
      expect(await pane.find({ text: /│ jkl │/ })).toBeUndefined()

      await pane.press({ key: 'scroll-right' })

      expect(await pane.find({ text: /│ jkl │/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'scroll-left' })).toBeDefined()

      await pane.press({ key: 'scroll-left' })

      expect(await pane.find({ text: /│ jkl │/ })).toBeUndefined()
      expect(await pane.find({ text: /│ abc │/ })).toBeDefined()
    })

    test('fit width closes the nodes up so that it fits, and the toggle undoes it', async ($, on) => {
      const pane = await open($, on, WIDE, NARROW_PANE)

      expect(await pane.find({ text: /│ jkl │/ })).toBeUndefined()
      expect(await pane.find({ type: 'Button', key: 'fit-width', text: /Fit width: off/ })).toBeDefined()

      await pane.press({ key: 'fit-width' })

      expect(await pane.find({ type: 'Button', key: 'fit-width', text: /Fit width: on/ })).toBeDefined()
      expect(await pane.find({ text: /│ abc │.*│ jkl │/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'scroll-right' })).toBeUndefined()

      await pane.press({ key: 'fit-width' })

      expect(await pane.find({ text: /│ jkl │/ })).toBeUndefined()
    })

    test('pressing a node cut by the edge of the pane selects it and brings the whole box into view', async ($, on) => {
      const pane = await open($, on, WIDE, NARROW_PANE - 2)

      // jkl is not in view at all; def, ghi are. ghi is the last box that shows, cut at its right edge
      await pane.press({ key: 'node-C' })

      expect(await pane.find({ text: /Selected: ghi/ })).toBeDefined()
      expect(await pane.find({ text: /│ ghi │/ })).toBeDefined()
    })

    test('a new width redraws within it: a window that no longer fits returns to the start', async ($, on) => {
      const pane = await open($, on, WIDE, NARROW_PANE - 2)

      await pane.press({ key: 'scroll-right' })
      expect(await pane.find({ text: /│ jkl │/ })).toBeDefined()

      // The pane is laid out again at a new width: the same state, mounted afresh
      await pane.unmount()
      const wider = await mountPane($, 'terminal', 80)

      expect(await wider.find({ text: /│ abc │.*│ jkl │/ })).toBeDefined()
      expect(await wider.find({ type: 'Button', key: 'scroll-left' })).toBeUndefined()
    })

    test('a different diagram starts from the left again', async ($, on) => {
      const pane = await open($, on, WIDE, NARROW_PANE - 2)

      await pane.press({ key: 'scroll-right' })
      await $.command.run({ command: 'mermaid-view', args: WIDE.replace('Root', 'Base') })

      expect(await pane.find({ text: /│ Base │/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'scroll-left' })).toBeUndefined()
    })
  })

  describe('walking along the edges', () => {
    const open = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      on: Parameters<Parameters<typeof test>[1]>[1],
      args: string,
      surface: Surface = 'terminal',
      columns = 80,
    ) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($, surface, columns)
    }

    test('buttons lead to the nodes the selected one points to, and to those that point to it', async ($, on) => {
      const pane = await open($, on, 'graph TD; A[Start] --> B[Process]; B --> C[End]')

      expect(await pane.find({ type: 'Button', key: 'go-C' })).toBeUndefined()

      await pane.press({ key: 'node-B' })

      const forward = await pane.find({ type: 'Button', key: 'go-C' })
      const backward = await pane.find({ type: 'Button', key: 'back-A' })
      expect(forward?.text).toBe('End')
      expect(backward?.text).toBe('Start')
    })

    test('a key moves the selection forward along an edge, and back along one', async ($, on) => {
      const pane = await open($, on, 'graph TD; A[Start] --> B[Process]; B --> C[End]')

      await pane.press({ key: 'node-A' })
      await pane.press({ key: 'go-B' })
      expect(await pane.find({ text: /Selected: Process/ })).toBeDefined()

      await pane.press({ key: 'go-C' })
      expect(await pane.find({ text: /Selected: End/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'go-A' })).toBeUndefined()

      await pane.press({ key: 'back-B' })
      expect(await pane.find({ text: /Selected: Process/ })).toBeDefined()
    })

    test('walking never clears the selection, and a leaf has nowhere to go', async ($, on) => {
      const pane = await open($, on, 'graph TD; A[Start] --> B[End]')

      await pane.press({ key: 'node-A' })
      await pane.press({ key: 'go-B' })

      expect(await pane.find({ text: /Selected: End/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'go-A' })).toBeUndefined()
      expect(await pane.find({ text: /Go to/ })).toBeUndefined()
    })

    test('several targets are numbered in the order their edges are written, and the sources are lettered', async ($, on) => {
      const pane = await open($, on, 'graph TD; P[Pa] --> T; Q[Qa] --> T; T --> X[Xa]; T --> Y[Ya]; T --> Z[Za]')

      await pane.press({ key: 'node-T' })

      const keys = async (prefix: string, ids: string[]) =>
        Promise.all(ids.map(async id => (await pane.find({ type: 'Button', key: `${prefix}-${id}` }))?.props.hotkey))

      expect(await keys('go', ['X', 'Y', 'Z'])).toEqual(['1', '2', '3'])
      expect(await keys('back', ['P', 'Q'])).toEqual(['a', 'b'])
    })

    test('a node reached twice from one node is offered once', async ($, on) => {
      const pane = await open($, on, 'graph TD; A --> B; A -.-> B')

      await pane.press({ key: 'node-A' })

      expect(await pane.findAll({ type: 'Button', key: 'go-B' })).toHaveLength(1)
    })

    test('a node out of view is brought into view when the walk reaches it', async ($, on) => {
      const WIDE = 'graph TD; R[Root] --> A[abc]; R --> B[def]; R --> C[ghi]; R --> D[jkl]'
      const pane = await open($, on, WIDE, 'terminal', 36)

      await pane.press({ key: 'node-R' })
      expect(await pane.find({ text: /│ jkl │/ })).toBeUndefined()

      await pane.press({ key: 'go-D' })

      expect(await pane.find({ text: /Selected: jkl/ })).toBeDefined()
      expect(await pane.find({ text: /│ jkl │/ })).toBeDefined()
    })

    test('the walk is there on the surfaces with the fallback view too', async ($, on) => {
      const pane = await open($, on, 'graph TD; A[Start] --> B[End]', 'desktop')

      await pane.press({ key: 'node-A' })
      await pane.press({ key: 'go-B' })

      expect(await pane.find({ text: /Selected: End/ })).toBeDefined()
    })
  })

  describe('click directives and the actions on a node', () => {
    type TestOn = Parameters<Parameters<typeof test>[1]>[1]

    const memoryFs = (on: TestOn) => {
      const files = new Map<string, string>()

      on('fs.read', (_$, e) => {
        const path = e.path.replace(/\\/g, '/')
        const key = [...files.keys()].find(name => path.endsWith(name))
        if (key === undefined) throw new Error(`ENOENT: ${e.path}`)

        return { value: files.get(key) } as never
      })

      return files
    }

    const show = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      args: string,
    ) => {
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($)
    }

    test('a node with a link is marked, and the link is shown when it is pressed', async ($, on) => {
      answerOpen(on)
      const pane = await show($, 'graph TD; A[Docs] --> B; click A "https://example.com/docs"')

      expect(await pane.find({ text: /│ Docs ↗ │/ })).toBeDefined()
      expect(await pane.find({ type: 'Link' })).toBeUndefined()

      await pane.press({ key: 'node-A' })

      const link = await pane.find({ type: 'Link' })
      expect(link?.props.href).toBe('https://example.com/docs')
    })

    test('href, a tooltip and a window name are read, and not shown', async ($, on) => {
      answerOpen(on)
      const pane = await show($, 'graph TD; A[Docs]; click A href "https://example.com/x" "Open the docs" _blank')

      await pane.press({ key: 'node-A' })

      expect((await pane.find({ type: 'Link' }))?.props.href).toBe('https://example.com/x')
      expect(await pane.find({ text: /Open the docs/ })).toBeUndefined()
    })

    test('a file of the project is marked and its first lines are shown when the node is pressed', async ($, on) => {
      answerOpen(on)
      memoryFs(on).set('src/parse.ts', 'export const parse = () => 1\nexport const other = 2\n')
      const pane = await show($, 'graph TD; A[Parser] --> B; click A "src/parse.ts"')

      expect(await pane.find({ text: /│ Parser ▤ │/ })).toBeDefined()

      await pane.press({ key: 'node-A' })

      expect(await pane.find({ text: /File: src\/parse\.ts/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /export const parse = \(\) => 1/ })).toBeDefined()
    })

    test('a file that cannot be read is said so', async ($, on) => {
      answerOpen(on)
      memoryFs(on)
      const pane = await show($, 'graph TD; A[Gone]; click A "src/missing.ts"')

      await pane.press({ key: 'node-A' })

      expect(await pane.find({ text: /Could not read src\/missing\.ts/ })).toBeDefined()
    })

    test('an address of another kind, an absolute path or a way out of the project is never followed', async ($, on) => {
      answerOpen(on)
      memoryFs(on)

      for (const [index, target] of ['javascript:alert(1)', 'file:///etc/passwd', '/etc/passwd', '../secrets.txt'].entries()) {
        await $.command.run({ command: 'mermaid-view', args: `graph TD; N${index}[Bad]; click N${index} "${target}"` })
      }

      const pane = await mountPane($)
      // the last one shown is the way out of the project
      expect(await pane.find({ text: /│ Bad ⊘ │/ })).toBeDefined()

      await pane.press({ key: 'node-N3' })

      expect(await pane.find({ text: /Not followed: \.\.\/secrets\.txt/ })).toBeDefined()
      expect(await pane.find({ type: 'Link' })).toBeUndefined()
    })

    test('a callback is reported as not drawn yet, with its line', async ($, on) => {
      answerOpen(on)
      const pane = await show($, 'graph TD\nA --> B\nclick A call doIt()')

      expect(await pane.find({ text: /Line 3: click callbacks .* is not drawn yet/ })).toBeDefined()
    })

    test('the fallback view marks and follows a node too', async ($, on) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args: 'graph TD; A[Docs]; click A "https://example.com/d"' })
      const pane = await mountPane($, 'desktop')

      expect(await pane.find({ type: 'Button', key: 'node-A', text: /Docs ↗/ })).toBeDefined()

      await pane.press({ key: 'node-A' })

      expect((await pane.find({ type: 'Link' }))?.props.href).toBe('https://example.com/d')
    })

    test('Send to Claude fills the prompt with a line about the selected node', async ($, on) => {
      answerOpen(on)
      let filled = ''
      on('prompt.fill', (_$, e) => {
        filled = (e as { text: string }).text

        return { isFilled: true } as never
      })

      const pane = await show($, 'graph TD; A[Start] --> B[Process]; B --> C[End]')
      await pane.press({ key: 'node-B' })
      await pane.press({ key: 'send-to-claude' })

      expect(filled).toContain('"Process"')
      expect(filled).toMatch(/leads to: end/)
      expect(filled).toMatch(/reached from: start/)
      expect(filled.endsWith(': ')).toBe(true)
    })

    test('Copy label copies exactly the label, without the mark of a link', async ($, on) => {
      answerOpen(on)
      let copied = ''
      on('ui.copy', (_$, e) => {
        copied = (e as { text: string }).text

        return { value: { isCopied: true } } as never
      })

      const pane = await show($, 'graph TD; A[Docs] --> B; click A "https://example.com"')
      await pane.press({ key: 'node-A' })
      await pane.press({ key: 'copy-label' })

      expect(copied).toBe('Docs')
    })
  })

  describe('sources and history', () => {
    type TestOn = Parameters<Parameters<typeof test>[1]>[1]

    // Stands for the file system the mod reads files from: what a test "writes" is an entry in the map
    const memoryFs = (on: TestOn) => {
      const files = new Map<string, string>()

      on('fs.read', (_$, e) => {
        const path = e.path.replace(/\\/g, '/')
        const key = [...files.keys()].find(name => path.endsWith(name))
        if (key === undefined) throw new Error(`ENOENT: ${e.path}`)

        return { value: files.get(key) } as never
      })

      return files
    }

    const run = ($: Parameters<Parameters<typeof test>[1]>[0], args: string) =>
      $.command.run({ command: 'mermaid-view', args })

    test('a file path as the argument shows that file\'s diagram', async ($, on) => {
      answerOpen(on)
      memoryFs(on).set('flow.mmd', 'graph TD; A[One] --> B[Two]')

      await run($, 'flow.mmd')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ One │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Two │/ })).toBeDefined()
    })

    test('a markdown file gives each of its mermaid blocks, the first one shown', async ($, on) => {
      answerOpen(on)
      memoryFs(on).set(
        'notes.md',
        'Intro\n```mermaid\ngraph TD; A[First] --> B\n```\ntext\n```mermaid\ngraph TD; X[Second] --> Y\n```\n',
      )

      await run($, 'notes.md')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ First │/ })).toBeDefined()
      expect(await pane.find({ text: /Diagrams this session/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-0' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-1' })).toBeDefined()
    })

    test('a file that cannot be read is said so, and the pane keeps what it had', async ($, on) => {
      answerOpen(on)
      memoryFs(on)
      await run($, 'graph TD; K[Kept] --> L')

      const result = await run($, 'missing.mmd')
      const pane = await mountPane($)

      expect(result.text).toMatch(/Could not read missing\.mmd/)
      expect(await pane.find({ text: /│ Kept │/ })).toBeDefined()
    })

    // Stands for the engine: what answers a turn that ends. Registered first, before the test uses `$`.
    const engineEnds = (on: TestOn) => on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }) as never)

    const answerWith = ($: Parameters<Parameters<typeof test>[1]>[0], answer: string, agentId?: string) =>
      $.turn.complete({ reason: 'answer', answer, ...(agentId !== undefined ? { agentId } : {}) } as never)

    test('a mermaid block in a reply is shown, and added to the list', async ($, on) => {
      answerOpen(on)
      engineEnds(on)
      await run($, 'graph TD; K[Kept] --> L')

      await answerWith($, 'Here it is:\n```mermaid\ngraph TD; R[Reply] --> S\n```\nHope it helps.')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ Reply │/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-0', text: /Kept, L/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-1', text: /Reply, S/ })).toBeDefined()
    })

    test('a reply with no diagram changes nothing', async ($, on) => {
      answerOpen(on)
      engineEnds(on)
      await run($, 'graph TD; K[Kept] --> L')

      await answerWith($, 'No diagram here.')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ Kept │/ })).toBeDefined()
    })

    test('what a subagent hands back is not taken as a diagram of its own', async ($, on) => {
      answerOpen(on)
      engineEnds(on)
      await run($, 'graph TD; K[Kept] --> L')

      await answerWith($, '```mermaid\ngraph TD; S[Sub] --> T\n```', 'agent-1')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ Kept │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Sub │/ })).toBeUndefined()
    })

    test('the newest diagram is the one shown, and a list lets the others be chosen', async ($, on) => {
      answerOpen(on)
      await run($, 'graph TD; A[Alpha] --> B')
      await run($, 'graph TD; C[Beta] --> D')
      await run($, 'graph TD; E[Gamma] --> F')
      const pane = await mountPane($)

      expect(await pane.find({ text: /│ Gamma │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Alpha │/ })).toBeUndefined()

      await pane.press({ key: 'history-0' })

      expect(await pane.find({ text: /│ Alpha │/ })).toBeDefined()
      expect(await pane.find({ text: /│ Gamma │/ })).toBeUndefined()
    })

    test('each entry of the list is told apart by its first node labels', async ($, on) => {
      answerOpen(on)
      await run($, 'graph TD; A[Alpha] --> B[Bravo]; B --> C[Charlie]; C --> D[Delta]')
      await run($, 'graph TD; X[Xray] --> Y')
      const pane = await mountPane($)

      expect(await pane.find({ type: 'Button', key: 'history-0', text: /Alpha, Bravo, Charlie \+1/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-1', text: /Xray, Y/ })).toBeDefined()
    })

    test('choosing another diagram clears the selection', async ($, on) => {
      answerOpen(on)
      await run($, 'graph TD; A[Alpha] --> B')
      await run($, 'graph TD; C[Beta] --> D')
      const pane = await mountPane($)

      await pane.press({ key: 'node-C' })
      expect(await pane.find({ text: /Selected: Beta/ })).toBeDefined()

      await pane.press({ key: 'history-0' })

      expect(await pane.find({ text: /Selected:/ })).toBeUndefined()
    })

    test('one diagram has no list, and the same diagram twice is one entry', async ($, on) => {
      answerOpen(on)
      await run($, 'graph TD; A --> B')
      await run($, 'graph TD; A --> B')
      const pane = await mountPane($)

      expect(await pane.find({ text: /Diagrams this session/ })).toBeUndefined()
    })

    test('the list keeps the most recent twenty', async ($, on) => {
      answerOpen(on)
      for (let index = 0; index < 25; index += 1) await run($, `graph TD; N${index} --> M${index}`)
      const pane = await mountPane($)

      expect(await pane.find({ type: 'Button', key: 'history-19' })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-20' })).toBeUndefined()
      // the five oldest were dropped: the list begins at the sixth diagram, and ends at the last
      expect(await pane.find({ type: 'Button', key: 'history-0', text: /N5, M5/ })).toBeDefined()
      expect(await pane.find({ type: 'Button', key: 'history-19', text: /N24, M24/ })).toBeDefined()
    })
  })

  describe('what it cannot draw', () => {
    const show = async (
      $: Parameters<Parameters<typeof test>[1]>[0],
      on: Parameters<Parameters<typeof test>[1]>[1],
      args: string,
    ) => {
      answerOpen(on)
      await $.command.run({ command: 'mermaid-view', args })

      return mountPane($)
    }

    test('another kind of diagram is named, and its source shown', async ($, on) => {
      const pane = await show($, on, 'sequenceDiagram\nA->>B: hello')

      expect(await pane.find({ text: /sequenceDiagram diagrams are not drawn yet: only flowcharts are/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /A->>B: hello/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /┌/ })).toBeUndefined()
    })

    test('a class diagram is named too', async ($, on) => {
      const classes = await show($, on, 'classDiagram\nAnimal <|-- Duck')

      expect(await classes.find({ text: /classDiagram diagrams are not drawn yet/ })).toBeDefined()
    })

    test('flowchart syntax that is not drawn yet is named, with its line', async ($, on) => {
      const pane = await show($, on, 'graph TD\nA --> B\nlinkStyle 0 stroke:red')

      expect(await pane.find({ text: /Line 3: `linkStyle` is not drawn yet/ })).toBeDefined()
      expect(await pane.find({ text: /At: linkStyle 0 stroke:red/ })).toBeDefined()
    })

    test('two-way arrows are named', async ($, on) => {
      const pane = await show($, on, 'graph TD\nA <--> B')

      expect(await pane.find({ text: /Line 2: arrows with a head at both ends is not drawn yet/ })).toBeDefined()
    })

    test('a syntax error is reported with the line it is on, blank lines counted', async ($, on) => {
      const pane = await show($, on, 'graph TD\nA --> B\n\nC --> --> D')

      expect(await pane.find({ text: /Could not read this diagram at line 4: C --> --> D/ })).toBeDefined()
    })

    test('statements on one line are all on that line', async ($, on) => {
      const pane = await show($, on, 'graph TD; A --> B; C --> --> D')

      expect(await pane.find({ text: /Could not read this diagram at line 1:/ })).toBeDefined()
    })

    test('a diagram of exactly 200 nodes is drawn', async ($, on) => {
      const edges = Array.from({ length: 199 }, (_, index) => `N${index} --> N${index + 1}`).join('; ')
      const pane = await show($, on, `graph TD; ${edges}`)

      expect(await pane.find({ text: /not drawn/ })).toBeUndefined()
      expect(await pane.find({ text: /│ N199 │/ })).toBeDefined()
    })

    test('a diagram of more than 200 nodes shows its source with a message', async ($, on) => {
      const edges = Array.from({ length: 200 }, (_, index) => `N${index} --> N${index + 1}`).join('; ')
      const pane = await show($, on, `graph TD; ${edges}`)

      expect(await pane.find({ text: /This diagram has 201 nodes; more than 200 are not drawn/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /N200/ })).toBeDefined()
      expect(await pane.find({ type: 'Button' })).toBeUndefined()
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
