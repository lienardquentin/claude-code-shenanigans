import type { Settings } from './budget'
import { readFolder, readFolders, readRecord, writeRecord } from './folders'
import { historyOf } from './history'
import type { Host } from './host'
import { blockLines } from './radius'
import type { reader } from './reading'
import { problemText } from './status'
import { lintOf, problemsOf, scheduleLines } from './tickets'
import { SCRATCH, folderOf, issuesOf, kept, sourceOf, specOf } from './run'
import type { RunRecord } from './run'
import { git, tail } from './work'

/** The branch a run builds on: its own, named for its feature. */
export const branchOf = (feature: string): string => `ship/${feature}`

// The label that says an issue is already agreed, in the vocabulary of the triage skill
const AGREED = 'ready-for-agent'

// How many words of a title name a feature's folder, and how long that name may be
const SLUG_WORDS = 8
const SLUG_LENGTH = 40

/** A title as a folder's name: its first words, lower-case, joined by hyphens. */
export const slugOf = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, SLUG_WORDS)
    .join('-')
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/, '') || 'feature'

/** `/ship resume` as the checkpoint of an auto run calls it: approves the run and answers what it did. */
export type Approve = (feature: string) => Promise<string>

// What an auto run asks of the model, whichever way it became one: said as it begins, and again when it is switched to
const AUTO_RULES = [
  'Wherever the steps, a skill or a step file tell you to ask the person, to wait for their answer or to have them confirm, do not: state the question in a line, take the option you would recommend, and go on.',
  '- The grilling: work the frontier as the skill says, and answer each question yourself with your recommended answer, from the code wherever the code can settle it.',
  '- The seams: choose them yourself.',
  '- Every decision taken this way goes in the spec, under `## Further Notes`, as a list headed "Decided without the person", each with its reason in a line: the pull request then shows what to check.',
  '- The checkpoint: show it as written, ask for no approval and name no command to type. The run approves itself as that turn ends, so end no turn before every ticket is written.',
  'The two findings that end a run at the grilling still end it.',
]

/**
 * What the model is told as the attended phase begins: what the run is, the steps to the checkpoint, and where
 * the text of the later steps is. The spec and ticket steps are behind a pointer so that the grilling is not
 * rushed towards them.
 */
export const attendedPrompt = (given: {
  feature: string
  root: string
  settings: Settings
  source: string
  issue?: { number: number; title: string; isAgreed: boolean }
  /** Said before the source, when the phase is taken up in a conversation that did not begin it. */
  note?: string
  /** What the runs this repo has had say about the size of a ticket, when it has had any. */
  history?: string
  /** True for an auto run: the person is asked nothing, and the checkpoint approves itself. */
  isAuto?: boolean
}): string => {
  const { feature, root, settings, source, issue, note, history, isAuto = false } = given
  const steps = `${root.replaceAll('\\', '/')}/prompts/spec.md`
  const grill = issue?.isAgreed
    ? `1. **Skip the grilling.** Issue #${issue.number} is labelled \`${AGREED}\`: it is already agreed. Read it below and go to step 2.`
    : [
        '1. **Grill.** Call the Skill tool twice, for `mattpocock-skills:grilling` and `mattpocock-skills:domain-modeling`, and grill the person about this feature. Done when the frontier is empty and the person has confirmed the shared understanding.',
        `   Two findings end the run here instead: a question only something runnable can settle, and a feature too large or foggy for one session. Tell the person which it is, name the skill for it (\`/prototype\`, \`/wayfinder\`), tell them to type \`/ship clean ${feature}\` before starting another run, and stop.`,
      ].join('\n')

  return [
    isAuto
      ? `A ship-flow run has started for the feature \`${feature}\`, as an auto run. You take it from its source to a checkpoint, without the person; from there the run builds it unattended.`
      : `A ship-flow run has started for the feature \`${feature}\`. You take it from its source to a checkpoint, with the person; from there the run builds it unattended.`,
    '',
    `- Source: ${issue ? `GitHub issue #${issue.number}, "${issue.title}"` : 'an idea the person typed'}, below.`,
    `- Working folder: \`${folderOf(feature)}/\`, ignored by git. The spec goes to \`${specOf(feature)}\`, the tickets to \`${issuesOf(feature)}/\`.`,
    `- Exploring the codebase: through an Explore agent on the \`${settings.exploreModel}\` model.`,
    `- The strong model, for a ticket that needs it: \`${settings.strongModel}\`.`,
    '- Publish nothing to GitHub: the run opens the issue and the pull request itself.',
    ...(history !== undefined ? [`- Sizing the tickets, from the runs this repo has had: ${history}.`] : []),
    ...(isAuto ? ['', '## Auto run', '', 'The person opted to be asked nothing. This stands over the steps below and the files they point to.', ...AUTO_RULES] : []),
    '',
    '## Steps',
    '',
    grill,
    `2. **Write the spec and the tickets.** Read \`${steps}\` and follow it.`,
    ...(note !== undefined ? ['', '## Taken up again', '', note] : []),
    '',
    '## Source',
    '',
    source,
  ].join('\n')
}

// A run that is under way: one more in the same repo would share its working tree
const isActive = (record: RunRecord | undefined): record is RunRecord =>
  record !== undefined && record.phase !== 'ended' && !(record.phase === 'paused' && record.pr !== undefined)

/**
 * `/ship <idea>` or `/ship #<issue>`: begins a run. Its working folder and record are made, the folder is ignored
 * by git, and the model is handed the attended phase. Answers what it did, or why it began nothing.
 */
export const begin = async (host: Host, settings: Settings, asked: string, { isAuto = false } = {}): Promise<string> => {
  const folders = await readFolders(host)
  const active = folders.find(folder => isActive(folder.record))

  if (active) {
    return `A run is already under way here: ${active.feature}. Finish it (/ship resume ${active.feature}) or remove it (/ship clean ${active.feature}) first.`
  }
  if ((await git(host, 'status', '--porcelain')).stdout.trim() !== '') {
    return 'The working tree has uncommitted changes. Commit or stash them, then start the run: what the grilling changes is committed with it.'
  }

  const number = /^#?(\d+)$/.exec(asked)?.[1]
  let issue: { number: number; title: string; isAgreed: boolean } | undefined
  let source = asked

  if (number !== undefined) {
    const viewed = await host.run(['gh', 'issue', 'view', number, '--json', 'number,title,body,labels'])

    if (viewed.exitCode !== 0) return `Issue #${number} could not be read: ${tail(viewed.stderr).trim()}`

    const read = JSON.parse(viewed.stdout) as { number: number; title: string; body: string; labels: readonly { name: string }[] }

    issue = { number: read.number, title: read.title, isAgreed: read.labels.some(label => label.name === AGREED) }
    source = `# ${read.title}\n\n${read.body}`
  }

  const taken = new Set(folders.map(folder => folder.feature))
  const slug = slugOf(issue?.title ?? asked)
  let feature = slug

  for (let n = 2; taken.has(feature) || (await host.exists(folderOf(feature))); n += 1) feature = `${slug}-${n}`

  // The run's working files never reach a commit, and a discarded ticket must not take them with it
  if ((await git(host, 'check-ignore', '-q', folderOf(feature))).exitCode !== 0) {
    const ignored = (await host.exists('.gitignore')) ? await host.read('.gitignore') : ''

    await host.write(
      '.gitignore',
      `${ignored}${ignored === '' || ignored.endsWith('\n') ? '' : '\n'}\n# Working files of a ship-flow run (spec, tickets, run record)\n${SCRATCH}/\n`,
    )
  }

  await host.write(sourceOf(feature), `${source}\n`)
  await writeRecord(host, {
    feature,
    branch: (await git(host, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(),
    phase: 'attended',
    step: 'grilling',
    attempts: {},
    source: issue ? 'issue' : 'idea',
    ...(issue ? { issue: issue.number, title: issue.title } : {}),
    ...(isAuto ? { isAuto } : {}),
  })
  const history = historyOf(folders)

  host.prompt(
    attendedPrompt({ feature, root: host.root, settings, source, isAuto, ...(issue ? { issue } : {}), ...(history !== undefined ? { history } : {}) }),
  )

  const begun = issue
    ? `${feature}: started from issue #${issue.number}${issue.isAgreed ? ', which is already agreed: the spec comes next' : ': the grilling begins'}.`
    : `${feature}: started from your idea: the grilling begins.`

  return isAuto ? `${begun} An auto run: you are asked nothing, and it builds once its tickets are written. /ship auto off hands it back to you.` : begun
}

/**
 * `/ship resume` on a run still before its checkpoint, with its spec or its tickets not written yet: there is
 * nothing to approve. The conversation that was writing them is gone (a new session, a cleared one), so the
 * attended phase is handed to this one, told to start from what reached the disk.
 */
export const reattend = async (host: Host, settings: Settings, record: RunRecord): Promise<string> => {
  const { feature } = record
  const source = (await host.exists(sourceOf(feature))) ? (await host.read(sourceOf(feature))).trim() : '(the source was not kept)'
  const history = historyOf(await readFolders(host))

  host.prompt(
    attendedPrompt({
      feature,
      root: host.root,
      settings,
      source,
      isAuto: record.isAuto === true,
      ...(history !== undefined ? { history } : {}),
      ...(record.source === 'issue' && record.issue !== undefined
        ? { issue: { number: record.issue, title: record.title ?? `#${record.issue}`, isAgreed: false } }
        : {}),
      note: [
        'This run was begun in an earlier conversation, which is gone, and this one takes it up.',
        `Start from what is on disk: \`${specOf(feature)}\` and \`${issuesOf(feature)}/\` if they exist, and \`CONTEXT.md\` and \`docs/adr/\` for what the grilling had settled.`,
        record.isAuto
          ? 'Go on from the first step that is not done. What was decided but never written down is lost: decide it again.'
          : 'Go on from the first step that is not done. What was agreed but never written down is lost: ask the person again, and say that you are asking again.',
      ].join(' '),
    }),
  )

  return `${feature}: still before its checkpoint, with ${(await host.exists(specOf(feature))) ? 'no tickets' : 'no spec'} yet: the attended phase goes on in this conversation.`
}

/**
 * The checkpoint is approved: the person typed `/ship resume` on a run still in its attended phase. The run opens
 * its issue from its spec if it started from an idea, moves to a branch of its own, commits there what the grilling changed
 * (the glossary, ADRs), and has the main conversation compacted to pointers. Answers the record the building
 * starts from, or why the run cannot start.
 */
export const approve = async (host: Host, record: RunRecord): Promise<RunRecord | { refusal: string }> => {
  const { feature } = record
  let { issue, title } = record

  if (issue === undefined) {
    // The issue is the spec itself: its heading's title, less the word that says it is a spec, and the rest as body
    const text = await host.read(specOf(feature))
    const heading = /^#[ \t]+(?:Spec\b[ \t]*:?[ \t]*)?(.*)$/m.exec(text)?.[1]?.trim()

    if (!heading) return { refusal: `${specOf(feature)} has no \`# Spec: <title>\` line, which names the issue this run opens` }

    const body = text.replace(/^#\s+.+$/m, '').trim()
    const created = await host.run(['gh', 'issue', 'create', '--title', heading, '--body-file', '-'], { stdin: `${body}\n` })
    const opened = /\/issues\/(\d+)/.exec(created.stdout)?.[1]

    if (created.exitCode !== 0 || opened === undefined) {
      return { refusal: `the issue could not be opened: ${tail(created.stderr || created.stdout).trim()}` }
    }

    issue = Number(opened)
    title = heading
    // Kept at once: whatever happens next, this run has its issue and opens no second one
    await writeRecord(host, { ...record, issue, title })
  }

  const branch = branchOf(feature)
  const made = await git(host, 'checkout', '-b', branch)

  if (made.exitCode !== 0 && (await git(host, 'checkout', branch)).exitCode !== 0) {
    return { refusal: `the branch ${branch} could not be made: ${tail(made.stderr).trim()}` }
  }

  // What the attended phase changed outside the run's own folder is the feature's, and is its first commit
  if ((await git(host, 'status', '--porcelain')).stdout.trim() !== '') {
    await git(host, 'add', '-A')
    await git(host, 'commit', '-m', `${feature}: the glossary and decisions of the grilling`)
  }

  host.compact(
    [
      `The ship-flow run \`${feature}\` has passed its checkpoint and now builds unattended; it reports in the transcript and needs nothing from this conversation.`,
      `Keep only these pointers: the spec ${specOf(feature)}, the tickets in ${issuesOf(feature)}/, the branch ${branch}, the issue #${issue}, and that \`/ship status\` shows how the run stands.`,
    ].join(' '),
  )

  return { ...kept(record), feature, branch, phase: 'unattended', attempts: {}, issue, ...(title !== undefined ? { title } : {}) }
}

// The texts the model reads as it passes from one step of the attended phase to the next, and the step each opens
const STEPS = [
  { file: 'prompts/spec.md', step: 'spec' },
  { file: 'prompts/tickets.md', step: 'tickets' },
] as const

// The run still with the person, if the repo has one
const attendedOf = async (host: Host): Promise<RunRecord | undefined> =>
  (await readFolders(host)).map(folder => folder.record).find(record => record?.phase === 'attended')

/**
 * The model has read a file. When it is one of the mod's own step texts, the attended run has passed a boundary:
 * the grilling is over, or the spec is written. Noted in the record, for `afterTurn` to act on.
 */
export const noteRead = async (host: Host, path: string): Promise<void> => {
  const read = path.replaceAll('\\', '/')
  const root = host.root.replaceAll('\\', '/')
  const reached = STEPS.find(({ file }) => read === `${root}/${file}`)?.step

  if (reached === undefined) return

  const record = await attendedOf(host)

  if (record && record.step !== reached && !(record.step === 'tickets' && reached === 'spec')) {
    await writeRecord(host, { ...record, step: reached })
  }
}

/**
 * A run at its checkpoint, its tickets written and its folder free of problems: its blast radius is printed in the
 * transcript, under the tickets table. Once, and again only when the block has changed since the record last said
 * what it printed.
 */
const printRadius = async (host: Host, settings: Settings, repo?: Pick<ReturnType<typeof reader>, 'read'>): Promise<void> => {
  const attended = (await readFolders(host)).filter(({ record }) => record?.phase === 'attended')

  // Every run before its checkpoint is looked at: one that does not qualify never hides another's block
  for (const folder of attended) {
    const record = folder.record

    if (!record || folder.tickets.length === 0 || problemsOf(folder.tickets).length > 0) continue

    const reading =
      repo && folder.tickets.some(ticket => ticket.touches !== undefined) ? await repo.read(host).catch(() => undefined) : undefined
    // Under the radius, how the run would build the tickets: what their Touches and their blockers let go side by side
    const text = [...blockLines(folder.tickets, reading), ...scheduleLines(folder.tickets, settings.parallelTickets)].join('\n')

    if (record.radiusShown === text) continue

    await writeRecord(host, { ...record, radiusShown: text })
    // Named only when more than one run is waiting, so the person knows whose block it is
    host.log(attended.length > 1 ? `${record.feature}:\n${text}` : text)
  }
}

/**
 * A run whose tickets are written: what is wrong with them is handed back to the model that wrote them, as a turn
 * of its own, before the person approves. What makes the folder unfit to run, which `/ship resume` would refuse,
 * and what is worth putting right in tickets that can run. Once, and again only when what is wrong has changed.
 */
const lint = async (host: Host): Promise<boolean> => {
  const record = await attendedOf(host)

  if (!record || record.step !== 'tickets') return false

  const tickets = (await readFolder(host, record.feature))?.tickets ?? []
  const broken = problemsOf(tickets).map(problemText)
  const weak = lintOf(tickets)
  const text = [...broken, ...weak].join('\n')

  if (tickets.length === 0 || (record.lintShown ?? '') === text) return false

  await writeRecord(host, { ...record, lintShown: text })

  if (text === '') return false

  host.log(`${record.feature}: the tickets have ${broken.length + weak.length} things to put right, and the model is told.`)
  host.prompt(
    [
      `The ship-flow run \`${record.feature}\` read the tickets in \`${issuesOf(record.feature)}/\` and found this to put right before the person approves.`,
      ...(broken.length > 0 ? ['', 'The run cannot start until these are fixed:', ...broken.map(line => `- ${line}`)] : []),
      ...(weak.length > 0
        ? ['', 'These let the run start, and cost it: fix each, or tell the person why it stands as it is.', ...weak.map(line => `- ${line}`)]
        : []),
      '',
      record.isAuto
        ? 'Change the ticket files, then say in a line what changed. This is an auto run: the run approves itself as that turn ends. Build nothing.'
        : 'Change the ticket files, then show the person the checkpoint again, as short as the changes allow. Build nothing.',
    ].join('\n'),
  )

  return true
}

/**
 * `/ship auto [feature]`, `/ship auto off [feature]` and the pane's button: a run before its checkpoint becomes an
 * auto run, or is handed back to the person. The model is told as soon as the session is idle; an auto run whose
 * tickets are already written approves itself as that short turn ends, never under a turn still writing them.
 */
export const setAuto = async (host: Host, wanted: string, isAuto: boolean): Promise<string> => {
  const folder = (await readFolders(host)).find(({ feature, record }) => record?.phase === 'attended' && (wanted === '' || feature === wanted))
  const record = folder?.record

  if (!record) {
    return `${wanted === '' ? 'No run here is' : `No run named ${wanted} is`} before its checkpoint, the one place a run is switched to or from auto. /ship auto <idea | #issue> starts an auto run.`
  }

  const { feature } = record

  if ((record.isAuto === true) === isAuto) return `${feature}: is ${isAuto ? 'already an auto run' : 'no auto run'}.`

  await writeRecord(host, { ...record, isAuto })
  host.prompt(
    isAuto
      ? [
          `The person switched the ship-flow run \`${feature}\` to an auto run: from here they are asked nothing.`,
          ...AUTO_RULES,
          'Go on from where the run stands, deciding yourself whatever you were waiting on the person for. If the checkpoint was already shown, say in a line that the run now approves itself, and end your turn.',
        ].join('\n')
      : `The person took the ship-flow run \`${feature}\` back from auto: from here ask them again as the steps say, and hold the checkpoint for their \`/ship resume ${feature}\`.`,
  )

  return isAuto
    ? `${feature}: now an auto run: you are asked nothing more, and it builds once its tickets are written. /ship auto off hands it back to you.`
    : `${feature}: no auto run any more: you are asked again, and /ship resume ${feature} approves its checkpoint.`
}

/**
 * The checkpoint of an auto run, its spec and its tickets written: it is approved as `/ship resume` would approve
 * it. A run that cannot start stops being an auto run and waits for the person, so that no turn tries it again.
 */
const selfApprove = async (host: Host, record: RunRecord, approval: Approve): Promise<boolean> => {
  const { feature } = record

  if (record.isAuto !== true || record.step !== 'tickets' || !(await host.exists(specOf(feature)))) return false
  if (((await readFolder(host, feature))?.tickets ?? []).length === 0) return false

  host.log(`${feature}: an auto run, its tickets written: the checkpoint approves itself.`)
  host.log(await approval(feature))

  const after = await readRecord(host, feature)

  if (after?.phase === 'attended') {
    await writeRecord(host, { ...after, isAuto: false })
    host.log(`${feature}: it could not start, so it is no auto run any more and waits for you. /ship resume ${feature}, once that is put right.`)
    host.notify(`${feature}: the auto run could not start and waits for you.`)
  }

  return true
}

/**
 * The end of a turn of the main conversation. A run in its attended phase keeps to its context budget here: once
 * the window is past the budget, it is compacted at the first pause after a step boundary, and once a boundary.
 * Never during the grilling, whose thread the spec is written from. An auto run at its checkpoint is approved
 * here, when `approval` is given: the turn ended by the model's own answer, not cut short.
 */
export const afterTurn = async (
  host: Host,
  settings: Settings,
  repo?: Pick<ReturnType<typeof reader>, 'read'>,
  approval?: Approve,
): Promise<void> => {
  if (!(await host.exists(SCRATCH))) return

  // The checkpoint's blast radius is informing only: whatever goes wrong with it never holds the turn back
  await printRadius(host, settings, repo).catch(() => undefined)
  // The model is about to be given a turn on the tickets: the conversation is not compacted under it
  if (await lint(host).catch(() => false)) return

  const record = await attendedOf(host)

  // Past its checkpoint the run compacts the conversation itself
  if (record && approval && (await selfApprove(host, record, approval))) return
  if (!record || record.step === undefined || record.step === 'grilling' || record.compactedAt === record.step) return
  if (((await host.usage()).contextPercent ?? 0) < settings.contextPercent) return

  const { feature, step } = record

  await writeRecord(host, { ...record, compactedAt: step })
  host.compact(
    [
      `This conversation is the attended phase of the ship-flow run \`${feature}\`, now ${step === 'spec' ? 'writing its spec' : 'writing its tickets'}.`,
      'Keep, whole: every decision the person made in the grilling and the reason for it; the vocabulary agreed; the seams and the verification commands, if settled; every question still open.',
      `Keep these pointers: the steps being followed are in ${host.root.replaceAll('\\', '/')}/prompts/${step}.md; the spec is ${specOf(feature)}; the tickets go in ${issuesOf(feature)}/.`,
      'Drop what was read to get there: file contents, search results, the output of commands.',
      ...(record.isAuto
        ? ['Keep that this is an auto run: the person is asked nothing, each question takes the recommended option, noted in the spec, and the checkpoint approves itself.']
        : []),
    ].join(' '),
  )
  host.log(`${feature}: the conversation is past its context budget and is being compacted, now that ${step === 'spec' ? 'the grilling is over' : 'the spec is written'}.`)
}

/**
 * What a session is told as it starts in a repo with a run that is not building: one line naming each such run
 * and the command that takes it up. It reminds and does nothing else: a run goes on only when the person says so,
 * but for one paused for quota, which said it would go on by itself and whose timer `rearm` sets again.
 */
export const reminder = async (host: Host): Promise<string | undefined> => {
  if (!(await host.exists(SCRATCH))) return undefined

  const running = new Set((await host.agents()).filter(agent => agent.isRunning).map(agent => agent.id))
  const lines = (await readFolders(host)).flatMap(({ feature, record }) => {
    if (!record || record.phase === 'ended') return []
    if (record.phase === 'attended') return [`${feature} is ${record.isAuto ? 'an auto run cut off ' : ''}before its checkpoint`]
    if (record.phase === 'paused') return record.pr ? [] : [`${feature} is paused (${record.pause ?? 'no reason kept'})`]
    if (record.agentId !== undefined && running.has(record.agentId)) return []

    const flights = record.flights ?? []

    if (flights.some(flight => flight.agentId !== undefined && running.has(flight.agentId))) return []

    const cut = `ticket${flights.length > 1 ? 's' : ''} ${flights.map(flight => String(flight.ticket).padStart(2, '0')).join(', ') || '?'}`

    return [`${feature} was cut off while ${record.phase === 'finishing' ? 'being reviewed' : `building ${cut}`}`]
  })

  return lines.length === 0 ? undefined : `${lines.join('; ')}. /ship status shows it; /ship resume takes it up.`
}
