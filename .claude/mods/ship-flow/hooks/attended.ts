import type { Settings } from './budget'
import { readFolders, writeRecord } from './folders'
import type { Host } from './host'
import { SCRATCH, folderOf, issueOf, issuesOf, kept, sourceOf, specOf } from './run'
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
}): string => {
  const { feature, root, settings, source, issue } = given
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
 * The checkpoint is approved: the person typed `/ship resume` on a run still in its attended phase. The run opens
 * its issue if it started from an idea, moves to a branch of its own, commits there what the grilling changed
 * (the glossary, ADRs), and has the main conversation compacted to pointers. Answers the record the building
 * starts from, or why the run cannot start.
 */
export const approve = async (host: Host, record: RunRecord): Promise<RunRecord | { refusal: string }> => {
  const { feature } = record
  let { issue, title } = record

  if (issue === undefined) {
    if (!(await host.exists(issueOf(feature)))) {
      return { refusal: `there is no ${issueOf(feature)}: the text of the issue this run opens (\`# <title>\`, then the body)` }
    }

    const text = await host.read(issueOf(feature))
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()

    if (!heading) return { refusal: `${issueOf(feature)} has no \`# <title>\` line` }

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
