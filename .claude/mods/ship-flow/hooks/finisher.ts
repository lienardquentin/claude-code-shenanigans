import type { Settings } from './budget'
import { writeRecord } from './folders'
import type { Host } from './host'
import { fixesOf, kept, reviewOf, specOf } from './run'
import type { RunRecord, UsageReading } from './run'
import { label } from './tickets'
import type { Ticket } from './tickets'
import { discard, git, launch, readUsage, tail, verify } from './work'

/** The agent type that reviews a run's branch, as the mod registers it and as the engine names it. */
export const REVIEWER = 'reviewer'
export const REVIEWER_TYPE = `ship-flow:${REVIEWER}`

/** What the reviewer may call: it reads, and its shell is narrowed to the git commands that read. */
export const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const

export const REVIEWER_PROMPT = [
  'You review one branch against its spec, alone and unattended. Nobody can answer a question. You change nothing: you read, and you report.',
  '',
  'You are given the spec, the folder of tickets the branch was built from, and the branch it will be merged into. Read the spec first, then the diff: `git diff <base>...HEAD`, and `git log <base>..HEAD` for how it was built. Read the files around a change before you judge it.',
  '',
  'Review on two axes, and say which a finding is on:',
  '- Spec: does the code do what the spec and the tickets marked done say, all of it and nothing beyond it?',
  '- Standards: does it follow what this repo writes down for itself (CLAUDE.md, the vocabulary of CONTEXT.md, the decisions under docs/adr), and read like the code around it?',
  '',
  'Report only what is wrong and worth fixing: a defect, a missed criterion, a broken rule. Not taste, not praise, not what you would have done differently. Number each finding and give the file and line, what is wrong, and what would put it right. A ticket marked blocked or too-large was not built: its absence is not a finding.',
  '',
  'Your shell runs only git status, diff, log, show, blame, ls-files, grep and rev-parse. Any other command is refused.',
  '',
  'End your report with one line, exactly: `FINDINGS: <how many>`.',
].join('\n')

// The states of a ticket the run could not build, and what its line in the brief says when no failure was recorded
const UNBUILT: Readonly<Record<string, string>> = {
  blocked: 'hangs off a ticket that was not built',
  'too-large': 'outgrew one context window: split it into smaller tickets',
  ready: 'not reached: the run stopped before it',
  'in-progress': 'not finished',
}

/** How many findings a review reports: the number on its `FINDINGS:` line, or undefined when it has none. */
export const findingsOf = (review: string): number | undefined => {
  const counted = /^\W*FINDINGS:\s*(\d+)\W*$/im.exec(review)?.[1]

  return counted === undefined ? undefined : Number(counted)
}

const windowLine = (name: string, kind: string, from: UsageReading | undefined, to: UsageReading | undefined): string[] => {
  const before = from?.quota.find(window => window.kind === kind)?.percentUsed
  const after = to?.quota.find(window => window.kind === kind)?.percentUsed

  if (after === undefined) return []

  return [`- ${name}: ${before !== undefined ? `${before}% when the run started, ` : ''}${after}% now`]
}

/**
 * The brief: a pull request's body. What each ticket built, what could not be built and why, what the review
 * found and what the fix pass did about it, and what the run spent of the quota.
 */
export const briefOf = (given: {
  record: RunRecord
  tickets: readonly Ticket[]
  review?: string
  fixes?: string
  usage?: UsageReading
}): string => {
  const { record, tickets, review, fixes, usage } = given
  const sorted = [...tickets].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  const isComplete = tickets.every(ticket => ticket.status === 'done')
  const line = (ticket: Ticket): string => {
    const key = label(ticket.number ?? 0)

    if (ticket.status === 'done') {
      return `- [x] **${key} ${ticket.title}**${record.commits?.[key] ? ` (${record.commits[key]})` : ''}`
    }

    const why = record.reasons?.[key] ?? UNBUILT[ticket.status ?? ''] ?? 'not built'

    return `- [ ] **${key} ${ticket.title}** — ${ticket.status}: ${why}`
  }
  const quota = [...windowLine('5-hour window', 'five_hour', record.startUsage, usage), ...windowLine('Weekly window', 'seven_day', record.startUsage, usage)]

  return [
    ...(isComplete && record.issue !== undefined ? [`Closes #${record.issue}`, ''] : []),
    ...(isComplete ? [] : ['**This run is not complete.** Some tickets could not be built; fix or split them, then `/ship resume`.', '']),
    '## Tickets',
    '',
    ...sorted.map(line),
    '',
    '## Review',
    '',
    review?.trim() || 'The branch was not reviewed.',
    '',
    '## Fix pass',
    '',
    record.fixes ?? 'No fix pass was run.',
    ...(fixes?.trim() ? ['', fixes.trim()] : []),
    ...(quota.length > 0 ? ['', '## Quota', '', ...quota] : []),
    '',
    'Built by ship-flow.',
  ].join('\n')
}

// The branch a repo's pull requests are merged into: what its remote calls its head, else `main`
const baseOf = async (host: Host): Promise<string> => {
  const head = await git(host, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')

  return head.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim().replace(/^origin\//, '') : 'main'
}

// The run stops here, for the person: said in the record, in a notification and in the answer
const stop = async (host: Host, record: RunRecord, pause: string): Promise<string> => {
  await writeRecord(host, { ...kept(record), phase: 'paused', pause, usage: await readUsage(host) })
  host.notify(`${record.feature}: ${pause}.`)

  return pause
}

/**
 * The end of a run's building: there is no ticket left to take. The branch is reviewed once, by a fresh agent on
 * the strong model; `finished` takes it from there. Answers what it did, as the end of a sentence. Nothing is
 * reviewed where nothing was built, where the run is on the branch it would be merged into, or where the pull
 * request already holds everything.
 */
export const finish = async (host: Host, settings: Settings, record: RunRecord): Promise<string> => {
  const { feature, branch } = record
  const base = await baseOf(host)
  const head = (await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim()
  const ahead = Number((await git(host, 'rev-list', '--count', `${base}..HEAD`)).stdout.trim())

  if (branch === base) return stop(host, record, `the run is on ${base}, the branch a pull request would be merged into: none is opened`)
  if (!(ahead > 0)) return stop(host, record, 'nothing was built: there is no pull request to open')
  if (record.pr && record.pr.head === head) return stop(host, record, `nothing new since the pull request: ${record.pr.url}`)

  const reviewing: RunRecord = { ...kept(record), base, phase: 'finishing', stage: 'review', usage: await readUsage(host) }

  await writeRecord(host, reviewing)

  const launched = await launch(host, {
    subagentType: REVIEWER_TYPE,
    description: `Review ${feature}`,
    model: settings.strongModel,
    prompt: `Review this branch against the spec ${specOf(feature)}, whose tickets are in the folder beside it. It will be merged into ${base}.`,
  })

  if ('why' in launched) return stop(host, reviewing, `the reviewer could not start: ${launched.why}`)

  await writeRecord(host, { ...reviewing, agentId: launched.agentId })

  return `reviewing the branch on ${launched.model}`
}

// Pushes the branch and opens the run's pull request, or brings the one it has up to date
const publish = async (host: Host, record: RunRecord, tickets: readonly Ticket[]): Promise<string> => {
  const { feature, branch } = record
  const base = record.base ?? 'main'
  const pushed = await git(host, 'push', '-u', 'origin', branch)

  if (pushed.exitCode !== 0) return stop(host, record, `the push failed: ${tail(pushed.stderr || pushed.stdout).trim()}`)

  const usage = await readUsage(host)
  const read = async (path: string) => ((await host.exists(path)) ? host.read(path) : undefined)
  const review = await read(reviewOf(feature))
  const fixes = await read(fixesOf(feature))
  const body = briefOf({ record, tickets, usage, ...(review !== undefined ? { review } : {}), ...(fixes !== undefined ? { fixes } : {}) })
  const isDraft = !tickets.every(ticket => ticket.status === 'done')
  const viewed = await host.run(['gh', 'pr', 'view', branch, '--json', 'url,isDraft'])
  let url: string

  if (viewed.exitCode === 0) {
    const open = JSON.parse(viewed.stdout) as { url: string; isDraft: boolean }
    const edited = await host.run(['gh', 'pr', 'edit', branch, '--body-file', '-'], { stdin: body })

    if (edited.exitCode !== 0) return stop(host, record, `the pull request could not be updated: ${tail(edited.stderr).trim()}`)
    if (open.isDraft !== isDraft) await host.run(['gh', 'pr', 'ready', branch, ...(isDraft ? ['--undo'] : [])])
    url = open.url
  } else {
    const created = await host.run(
      ['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', record.title ?? feature, '--body-file', '-', ...(isDraft ? ['--draft'] : [])],
      { stdin: body },
    )

    if (created.exitCode !== 0) return stop(host, record, `the pull request could not be opened: ${tail(created.stderr).trim()}`)
    url = created.stdout.trim().split('\n').at(-1) ?? ''
  }

  const head = (await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim()
  const said = `${isDraft ? 'a draft pull request' : 'the pull request'} is ${viewed.exitCode === 0 ? 'up to date' : 'open'}: ${url}`

  await writeRecord(host, { ...kept(record), phase: 'ended', pause: said, pr: { url, head }, usage })
  host.notify(`${feature}: ${said}.`)

  return said
}

/**
 * The end of the reviewer's turn, or of the fix pass's. A review with findings gets one fix pass, by a fresh
 * implementer; what that pass leaves is verified by the run and committed, or discarded. Then the branch is
 * pushed and the pull request opened. Answers what happened, as a sentence.
 */
export const finished = async (
  host: Host,
  settings: Settings,
  implementerType: string,
  flight: { record: RunRecord; tickets: readonly Ticket[] },
  turn: { reason: string; answer: string },
): Promise<string> => {
  const { record, tickets } = flight
  const { feature } = record

  if (record.stage === 'review') {
    const isReviewed = turn.reason === 'answer' && turn.answer.trim() !== ''
    const findings = isReviewed ? findingsOf(turn.answer) : 0

    await host.write(reviewOf(feature), isReviewed ? turn.answer : `The review did not finish: the reviewer's turn ended with ${turn.reason}.`)
    await host.write(fixesOf(feature), '')

    if (findings === 0) {
      const fixes = isReviewed ? 'The review found nothing to fix.' : 'No fix pass was run: there was no review to act on.'

      return `the review ${isReviewed ? 'found nothing to fix' : 'did not finish'}; ${await publish(host, { ...record, fixes }, tickets)}`
    }

    const fixing: RunRecord = { ...kept(record), phase: 'finishing', stage: 'fix', usage: await readUsage(host) }

    await writeRecord(host, fixing)

    const launched = await launch(host, {
      subagentType: implementerType,
      description: `Fix the review of ${feature}`,
      model: settings.implementerModel,
      prompt: [
        `Fix what the review of this branch found. The review is ${reviewOf(feature)}; the spec is ${specOf(feature)}.`,
        'Fix each finding you agree with, and build nothing new. There is no ticket file to tick.',
        'End with a report that takes the findings by their numbers: fixed, or declined and why.',
      ].join('\n'),
    })

    if ('why' in launched) {
      const fixes = `No fix pass was run: the implementer could not start (${launched.why}).`

      return `the review has ${findings ?? 'some'} findings and the fix pass could not start; ${await publish(host, { ...fixing, fixes }, tickets)}`
    }

    await writeRecord(host, { ...fixing, agentId: launched.agentId })

    return `the review has ${findings ?? 'some'} findings; fixing them on ${launched.model}`
  }

  // The fix pass: its work is judged as a ticket's is, and is not tried again
  const problem = turn.reason !== 'answer' ? `its turn ended with ${turn.reason}` : (await verify(host, feature))?.reason
  let fixes: string

  if (problem !== undefined) {
    await discard(host)
    fixes = `The fix pass was discarded: ${problem}. The findings above stand.`
  } else if ((await git(host, 'status', '--porcelain')).stdout.trim() === '') {
    fixes = 'The fix pass changed nothing.'
  } else {
    await git(host, 'add', '-A')

    const committed = await git(host, 'commit', '-m', `${feature}: fixes from the review`)

    if (committed.exitCode !== 0) {
      await discard(host)
      fixes = 'The fix pass was discarded: its commit failed. The findings above stand.'
    } else {
      fixes = `The fix pass was committed as ${(await git(host, 'rev-parse', '--short', 'HEAD')).stdout.trim()}.`
    }
  }

  if (turn.reason === 'answer') await host.write(fixesOf(feature), turn.answer)

  return `${fixes.replace(/\.$/, '').replace(/^The/, 'the')}; ${await publish(host, { ...record, fixes }, tickets)}`
}
