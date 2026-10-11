import type { Settings } from './budget'
import { readFolders, writeRecord } from './folders'
import type { Host } from './host'
import { blockLines } from './radius'
import type { reader } from './reading'
import { problemsOf } from './tickets'
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
}): string => {
  const { feature, root, settings, source, issue, note } = given
  const steps = `${root.replaceAll('\\', '/')}/prompts/spec.md`
  const grill = issue?.isAgreed
    ? `1. **Skip the grilling.** Issue #${issue.number} is labelled \`${AGREED}\`: it is already agreed. Read it below and go to step 2.`
    : [
        '1. **Grill.** Call the Skill tool twice, for `mattpocock-skills:grilling` and `mattpocock-skills:domain-modeling`, and grill the person about this feature. Done when the frontier is empty and the person has confirmed the shared understanding.',
        `   Two findings end the run here instead: a question only something runnable can settle, and a feature too large or foggy for one session. Tell the person which it is, name the skill for it (\`/prototype\`, \`/wayfinder\`), tell them to delete \`${folderOf(feature)}/\` before starting another run, and stop.`,
      ].join('\n')

  return [
    `A ship-flow run has started for the feature \`${feature}\`. You take it from its source to a checkpoint, with the person; from there the run builds it unattended.`,
    '',
    `- Source: ${issue ? `GitHub issue #${issue.number}, "${issue.title}"` : 'an idea the person typed'}, below.`,
    `- Working folder: \`${folderOf(feature)}/\`, ignored by git. The spec goes to \`${specOf(feature)}\`, the tickets to \`${issuesOf(feature)}/\`.`,
    `- Exploring the codebase: through an Explore agent on the \`${settings.exploreModel}\` model.`,
    `- The strong model, for a ticket that needs it: \`${settings.strongModel}\`.`,
    '- Publish nothing to GitHub: the run opens the issue and the pull request itself.',
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
export const begin = async (host: Host, settings: Settings, asked: string): Promise<string> => {
  const folders = await readFolders(host)
  const active = folders.find(folder => isActive(folder.record))

  if (active) {
    return `A run is already under way here: ${active.feature}. Finish it (/ship resume ${active.feature}) or delete ${folderOf(active.feature)}/ first.`
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
  })
  host.prompt(attendedPrompt({ feature, root: host.root, settings, source, ...(issue ? { issue } : {}) }))

  return issue
    ? `${feature}: started from issue #${issue.number}${issue.isAgreed ? ', which is already agreed: the spec comes next' : ': the grilling begins'}.`
    : `${feature}: started from your idea: the grilling begins.`
}

/**
 * `/ship resume` on a run still before its checkpoint, with its spec or its tickets not written yet: there is
 * nothing to approve. The conversation that was writing them is gone (a new session, a cleared one), so the
 * attended phase is handed to this one, told to start from what reached the disk.
 */
export const reattend = async (host: Host, settings: Settings, record: RunRecord): Promise<string> => {
  const { feature } = record
  const source = (await host.exists(sourceOf(feature))) ? (await host.read(sourceOf(feature))).trim() : '(the source was not kept)'

  host.prompt(
    attendedPrompt({
      feature,
      root: host.root,
      settings,
      source,
      ...(record.source === 'issue' && record.issue !== undefined
        ? { issue: { number: record.issue, title: record.title ?? `#${record.issue}`, isAgreed: false } }
        : {}),
      note: [
        'This run was begun in an earlier conversation, which is gone, and this one takes it up.',
        `Start from what is on disk: \`${specOf(feature)}\` and \`${issuesOf(feature)}/\` if they exist, and \`CONTEXT.md\` and \`docs/adr/\` for what the grilling had settled.`,
        'Go on from the first step that is not done. What was agreed but never written down is lost: ask the person again, and say that you are asking again.',
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
const printRadius = async (host: Host, repo?: Pick<ReturnType<typeof reader>, 'read'>): Promise<void> => {
  const attended = (await readFolders(host)).filter(({ record }) => record?.phase === 'attended')

  // Every run before its checkpoint is looked at: one that does not qualify never hides another's block
  for (const folder of attended) {
    const record = folder.record

    if (!record || folder.tickets.length === 0 || problemsOf(folder.tickets).length > 0) continue

    const reading =
      repo && folder.tickets.some(ticket => ticket.touches !== undefined) ? await repo.read(host).catch(() => undefined) : undefined
    const text = blockLines(folder.tickets, reading).join('\n')

    if (record.radiusShown === text) continue

    await writeRecord(host, { ...record, radiusShown: text })
    // Named only when more than one run is waiting, so the person knows whose block it is
    host.log(attended.length > 1 ? `${record.feature}:\n${text}` : text)
  }
}

/**
 * The end of a turn of the main conversation. A run in its attended phase keeps to its context budget here: once
 * the window is past the budget, it is compacted at the first pause after a step boundary, and once a boundary.
 * Never during the grilling, whose thread the spec is written from.
 */
export const afterTurn = async (host: Host, settings: Settings, repo?: Pick<ReturnType<typeof reader>, 'read'>): Promise<void> => {
  if (!(await host.exists(SCRATCH))) return

  // The checkpoint's blast radius is informing only: whatever goes wrong with it never holds the turn back
  await printRadius(host, repo).catch(() => undefined)

  const record = await attendedOf(host)

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
    ].join(' '),
  )
  host.log(`${feature}: the conversation is past its context budget and is being compacted, now that ${step === 'spec' ? 'the grilling is over' : 'the spec is written'}.`)
}

/**
 * What a session is told as it starts in a repo with a run that is not building: one line naming each such run
 * and the command that takes it up. It reminds and does nothing else: a run goes on only when the person says so.
 */
export const reminder = async (host: Host): Promise<string | undefined> => {
  if (!(await host.exists(SCRATCH))) return undefined

  const running = new Set((await host.agents()).filter(agent => agent.isRunning).map(agent => agent.id))
  const lines = (await readFolders(host)).flatMap(({ feature, record }) => {
    if (!record || record.phase === 'ended') return []
    if (record.phase === 'attended') return [`${feature} is before its checkpoint`]
    if (record.phase === 'paused') return record.pr ? [] : [`${feature} is paused (${record.pause ?? 'no reason kept'})`]
    if (record.agentId !== undefined && running.has(record.agentId)) return []

    return [`${feature} was cut off while ${record.phase === 'finishing' ? 'being reviewed' : `building ticket ${String(record.ticket ?? '?').padStart(2, '0')}`}`]
  })

  return lines.length === 0 ? undefined : `${lines.join('; ')}. /ship status shows it; /ship resume takes it up.`
}
