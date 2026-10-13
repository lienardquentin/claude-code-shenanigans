import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StingRadius, StingState, StingSuite } from '../types'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import { HOME, HOW_TO, MARK, PROJECT_FILE, isQuiet, marksOf, owed, parseDiffText, parseProject, parseProof, proved, radiusLine, radiusOf, radiusText, tidy } from './radius'

type $ = EngineInterface

const PANE = 'sting'
const TITLE = 'Sting'
// The tool of anduril's that plays the kept runs on two builds: the radius is read from what it says
const ANDURIL_DIFF = 'mcp__anduril__diff'
// A proof builds the tool on two sides and runs its tests on each: as long as a host command may run
const PROVE_TIMEOUT_MS = 600_000
// How many test files are read for marks
const READ_FILES = 300

const suites = atom({ plugin: 'sting', key: 'suites' } as const, [] as StingSuite[])
const radius = atom({ plugin: 'sting', key: 'radius' } as const, null as StingRadius | null)
const working = atom({ plugin: 'sting', key: 'working' } as const, '')
const note = atom({ plugin: 'sting', key: 'note' } as const, '')
const selected = atom({ plugin: 'sting', key: 'selected' } as const, '')
const isHidden = atom({ plugin: 'sting', key: 'isHidden' } as const, false)
const glow = atom({ plugin: 'sting', key: 'glow' } as const, 0)
const home = atom({ plugin: 'sting', key: 'home' } as const, '')

/** The folder the session started in: a `cd` Claude runs does not move the project from under the mod. */
const homeOf = async ($: $): Promise<string> => {
  const held = await read($, home)

  if (held !== '') return held

  const cwd = tidy(await $.session.cwd())

  await update($, home, () => cwd)

  return cwd
}

// What the pane last drew, for the model to read
const view = paneView({ id: PANE, title: TITLE, command: '/sting' })

const ASKED = {
  target: { type: 'string', description: 'The tool, by the name it is run by; the first the project names tests for when left out.' },
  against: { type: 'string', description: 'The commit the working tree is compared with, by any name git resolves (a tag, a branch). HEAD when left out.' },
} as const

const TOOLS = [
  {
    name: 'radius',
    description:
      "What the uncommitted change reached in what the command-line tool being written does, and what of it an integration test covers. Has anduril play the kept runs on the working tree and on HEAD: each run that changed is in the radius, and is `bare` (no test marked on it) or `marked` (a test has a comment `sting: <the run>` above it); a run that did not change is outside it and owed no test. Call it after changing the tool's source and before saying the change is done, and write a test for each bare run and for no other. `prove` then says whether each test sees the change.",
    inputSchema: { type: 'object', properties: ASKED },
  },
  {
    name: 'prove',
    description:
      "Makes the radius afresh and runs the tool's integration tests on two sides: HEAD's source with the working tree's tests laid over it, and the working tree. A changed run is `pinned` when a test marked on it fails on the first and passes on the second, `loose` when its tests pass on both and so do not see the change, `broken` when one fails on the working tree. Also names every test that passes on HEAD's source and fails on the working tree: it pins what was changed, or shows a regression. Call it after writing the tests `radius` asked for; a change is covered when every changed run is pinned. The first proof of a commit builds it, which can take minutes. Runs no test when no kept run changed.",
    inputSchema: { type: 'object', properties: ASKED },
  },
] as const

// The suites the project names, as the system prompt's section reads them: a module's own copy, set again at each load
let known: readonly StingSuite[] = []

const sectionText = (list: readonly StingSuite[], cwd: string): string => {
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return [
    `The sting mod says which changes in what ${list.map(({ label }) => `\`${label}\``).join(', ')} does are covered by an integration test (${list.map(({ label, tests }) => `${label}: ${tests.map(within).join(', ')}`).join('; ')}).`,
    'After changing its source, mcp__sting__radius lists the kept runs whose behaviour changed since HEAD, each bare or marked by a test.',
    `For each bare run, write one integration test that makes that run and asserts what it now does, with a comment \`${MARK} <the run as listed>\` on the line above the test; write none for a run that did not change.`,
    'Then mcp__sting__prove runs the tests on HEAD\'s source and on the working tree: a test that covers the change fails on the first and passes on the second, and the change is covered when every changed run is pinned.',
  ].join(' ')
}

const setUp = async ($: $): Promise<StingSuite[]> => {
  const cwd = await homeOf($)
  const list = parseProject(await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => ''), cwd)

  known = list
  await update($, suites, () => list)

  return list
}

const suiteOf = (list: readonly StingSuite[], target: string | undefined): StingSuite | string =>
  list.length === 0
    ? HOW_TO
    : ((target === undefined ? list[0] : list.find(({ label }) => label === target)) ?? `sting knows no tests of a tool named ${target ?? ''}. It knows those of ${list.map(({ label }) => label).join(', ')}.`)

/** Every mark in the files the project names as tests: what git tracks there, and what it neither tracks nor ignores. */
const marksIn = async ($: $, cwd: string, suite: StingSuite): Promise<{ line: string; test: string }[]> => {
  const listed = await $.process.run(['git', 'ls-files', '-co', '--exclude-standard', '--', ...suite.tests], { cwd }).catch(() => undefined)
  const paths = (listed?.exitCode === 0 ? listed.stdout.split('\n') : []).map(path => path.trim()).filter(path => path !== '')
  const marks: { line: string; test: string }[] = []

  for (const path of paths.slice(0, READ_FILES)) marks.push(...marksOf(await $.fs.read(`${cwd}/${path}`).catch(() => '')))

  return marks
}

type Asked = { target?: string; against: string }

/** Makes the radius: what anduril says changed, and the tests marked on each run. Answers it, or a sentence saying why none was made. */
const survey = async ($: $, asked: Asked): Promise<StingRadius | string> => {
  const suite = suiteOf(await setUp($), asked.target)

  if (typeof suite === 'string') return suite

  const cwd = await homeOf($)

  await update($, working, () => `Playing the kept runs of ${suite.label} on the working tree and on ${asked.against}…`)

  try {
    const answered = (await $.tool.call({ tool: ANDURIL_DIFF, target: suite.label, from: asked.against, to: 'work' } as never)) as unknown as { result?: unknown; text?: unknown }
    const said = typeof answered.result === 'string' ? answered.result : typeof answered.text === 'string' ? answered.text : ''
    const diff = parseDiffText(said)

    // What anduril says in place of a comparison is why there is no radius
    if (diff === undefined) return said !== '' ? said : 'anduril answered nothing to read.'

    const made = radiusOf({ label: suite.label, at: await $.clock.now(), diff, marks: await marksIn($, cwd, suite) })

    await update($, radius, () => made)
    await update($, isHidden, () => false)

    return made
  } catch (error) {
    return `sting reads the radius from anduril's diff, which could not be called: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await update($, working, () => '')
  }
}

/** Makes the radius afresh, and where a kept run changed runs the tests on both sides. */
const prove = async ($: $, asked: Asked): Promise<StingRadius | string> => {
  const made = await survey($, asked)

  // No kept run changed: nothing is in the radius, and no test is run
  if (typeof made === 'string' || made.seams.length === 0) return made

  const suite = (await read($, suites)).find(({ label }) => label === made.label)

  if (suite === undefined) return made

  const cwd = await homeOf($)
  // Nothing under the folder is the repo's: it says so itself, and the project's own ignore file is left alone
  const ignore = `${cwd}/${HOME}/.gitignore`
  if (!(await $.fs.exists(ignore).catch(() => false))) await $.fs.write(ignore, '*\n').catch(() => undefined)

  await update($, working, () => `Running the tests of ${suite.label} on ${asked.against}'s source and on the working tree…`)

  try {
    const job = { home: cwd, label: suite.label, tests: suite.tests, test: suite.test, from: asked.against }
    const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/prove/sting_prove.py`], { stdin: JSON.stringify(job), timeoutMs: PROVE_TIMEOUT_MS })
    const proof = parseProof(ran.stdout)

    if (proof === undefined) return `The proof could not be made: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the prove script exited with ${ran.exitCode} and said nothing`}`

    const done = proved(made, proof)

    await update($, radius, () => done)

    return done
  } catch (error) {
    return `The proof was not finished: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await update($, working, () => '')
  }
}

const askedOf = (e: unknown): Asked => {
  const given = e as { target?: unknown; against?: unknown }

  return { target: typeof given.target === 'string' && given.target !== '' ? given.target : undefined, against: typeof given.against === 'string' && given.against.trim() !== '' ? given.against.trim() : 'HEAD' }
}

const TONE: Record<StingState, Tone> = { bare: 'danger', marked: 'warning', pinned: 'success', loose: 'warning', broken: 'danger' }

// Sting glows blue, whatever is near: the counts say what
const GLOW = 'suggestion'
// The sword: a hilt that stays as it is, and a blade whose glow swells and fades, drawn anew each beat
const HILT = 'o=['
const BEATS = ['-------->', '=------->', '====---->', '========>', '========>', '====---->'] as const
const BEAT_MS = 300

/** Whether the band is lit: a changed run is not pinned, and the person has not hidden it. */
const isLit = async ($: $): Promise<boolean> => {
  const held = await read($, radius)

  return held !== null && held.seams.length > 0 && !isQuiet(held) && !(await read($, isHidden))
}

/** One beat of the glow, while the band is lit: a dark band redraws nothing. */
const beat = async ($: $): Promise<void> => {
  if (await isLit($)) await update($, glow, was => (was + 1) % BEATS.length)
}

const toneOf = (held: StingRadius): Tone => (held.seams.some(seam => seam.state === 'bare' || seam.state === 'broken') || held.turned.length > 0 ? 'danger' : isQuiet(held) ? 'success' : 'warning')

/** Marks the radius as one of an earlier working tree. */
const aged = ($: $) => update($, radius, held => (held === null || held.isStale ? held : { ...held, isStale: true }))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sting', description: 'Open the pane of what the uncommitted change reached in what the tool does, and which of it an integration test pins' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    await setUp($).catch(() => [])
    $.clock.every(BEAT_MS, () => void beat($).catch(() => undefined))

    return next(e)
  })

  // Claude is told which tests are owed: one for each run that changed, and none beyond
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return known.length === 0 ? composed : { sections: [...composed.sections, { id: 'sting:radius', text: sectionText(known, await homeOf($)), scope: 'session' as const }] }
  })

  // An edit makes the radius one of an earlier working tree
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const done = await next(e)
    await aged($)

    return done
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const done = await next(e)
    await aged($)

    return done
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__sting__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__sting__radius' }, async ($, e) => {
    const made = await survey($, askedOf(e))

    return { result: typeof made === 'string' ? made : radiusText(made) }
  })

  on('tool.call', { tool: 'mcp__sting__prove' }, async ($, e) => {
    const made = await prove($, askedOf(e))

    return { result: typeof made === 'string' ? made : radiusText(made) }
  })

  on('command.run', { command: 'sting' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await setUp($)
    const held = await read($, radius)

    return { text: list.length === 0 ? HOW_TO : held === null ? `sting knows the tests of ${list.map(({ label }) => label).join(', ')}. No radius is made yet: Radius in the pane makes one.` : `${radiusLine(held)}.` }
  })

  // The blade glows while a run that changed is not pinned, and is dark otherwise
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, radius)

    if (e.props.hasSurvey || held === null || !(await isLit($))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const at = await read($, glow)
    // The blade is faint before the glow runs up it, and bright once it has reached the point
    const isFaint = at === 0
    const isBright = at === 3 || at === 4

    return (
      <Box>
        <Text dimColor>{HILT}</Text>
        <Text color={GLOW} dimColor={isFaint} bold={isBright}>{BEATS[at] ?? BEATS[3]}</Text>
        <Text color={GLOW} bold>{' sting'}</Text>
        <Text color={GLOW}>{` · ${radiusLine(held)}${held.isStale ? ' · before the last edit' : ''}  `}</Text>
        <Button key="sting-open" label="Open" onPress={() => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined)} />
        <Text> </Text>
        <Button key="sting-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await read($, suites)
    const held = await read($, radius)
    const doing = await read($, working)
    const problem = await read($, note)
    const openLine = await read($, selected)

    // What a button asked for and did not get is said in the pane
    const run = (made: Promise<StingRadius | string>) => made.then(answered => update($, note, () => (typeof answered === 'string' ? answered : ''))).then(() => undefined)

    if (list.length === 0) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            {badge({ label: 'no tests known', tone: 'neutral' })}
            <Button key="refresh" hotkey="r" onPress={() => setUp($).then(() => undefined)}>
              Refresh
            </Button>
          </Box>
          <Text>{HOW_TO}</Text>
        </Box>,
      )
    }

    const rows = (held?.seams ?? []).map((seam): TableCell[] => [
      { text: seam.state, tone: TONE[seam.state] },
      <Button key={`seam-${seam.line}`} plain onPress={() => update($, selected, was => (was === seam.line ? '' : seam.line))}>
        {seam.line === openLine ? '▸ ' : ''}
        {seam.line}
      </Button>,
      seam.tests.length === 0 ? '' : seam.tests.map(test => (held?.isProved === true ? `${test.name} (${test.from} → ${test.to})` : test.name)).join(', '),
    ])
    const open = held?.seams.find(seam => seam.line === openLine)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {held === null ? badge({ label: 'no radius yet', tone: 'neutral' }) : badge({ label: radiusLine(held), tone: held.seams.length === 0 ? 'success' : toneOf(held) })}
          <Button key="radius" hotkey="r" variant="primary" onPress={() => run(survey($, { against: 'HEAD' }))}>
            Radius
          </Button>
          <Button key="prove" hotkey="p" onPress={() => run(prove($, { against: 'HEAD' }))}>
            Prove
          </Button>
        </Box>
        <Box flexDirection="column">
          {list.map(({ label, test }) => (
            <Text dimColor>
              {label} is tested by {test}
            </Text>
          ))}
          {held !== null && <Text dimColor>{held.summary}</Text>}
          {held?.isStale === true && <Text color="warning">A file was edited since: this is of an earlier working tree.</Text>}
          {doing !== '' && <Text color="suggestion">{doing}</Text>}
          {problem !== '' && <Text color="warning">{problem}</Text>}
        </Box>
        {held !== null &&
          table({
            columns: [{ header: 'STATE', width: 7 }, { header: 'RUN' }, { header: 'TEST', wrap: true }],
            rows,
            empty: 'No kept run changed: nothing is in the radius, and no test is owed.',
          })}
        {open !== undefined && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{open.line}</Text>
            <Text color={open.state === 'pinned' ? 'success' : 'warning'}>{owed(open)}</Text>
            {open.evidence !== '' && <Code source={open.evidence} format="diff" />}
          </Box>
        )}
        {held !== null && held.turned.length > 0 && <Text color="error">{`Passing on the commit's source and failing on the working tree: ${held.turned.join(', ')}`}</Text>}
        {held !== null && held.unproved !== '' && <Text color="warning">{held.unproved}</Text>}
        {held !== null && held.unchanged.length > 0 && <Text dimColor>{`outside the radius: ${held.unchanged.join(' · ')}`}</Text>}
      </Box>,
    )
  })
}
