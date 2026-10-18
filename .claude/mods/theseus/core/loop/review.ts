import { UNMODDED } from '../change'
import { errorText } from '../kit'
import { BUILDERS, afterVerdict, isTidyAsked, ownMinor, parseJudgement, tidyPrompt } from '../run'
import type { Judged } from '../run'
import { gitAt } from './ports'
import type { Ports } from './ports'
import { again, stop } from './send'
import { commitNow } from './commit'

// A proved change judged: the reviewers sent, their verdict read, and what it leads to.

/**
 * The minor findings of a judgement that are about what the change in a tree wrote. Where git cannot say what it wrote,
 * every one is, as none can be told apart.
 */
export async function ownMinorIn(p: Ports, tree: string, judged: Judged): Promise<string[]> {
  const tracked = await gitAt(p, ['diff', 'HEAD', '--name-only', ...UNMODDED], tree)
  const fresh = await gitAt(p, ['ls-files', '-o', '--exclude-standard', ...UNMODDED], tree)

  if (!tracked.ok || !fresh.ok) return judged.minor

  return ownMinor(judged.minorAt, tree, `${tracked.out}\n${fresh.out}`.split('\n').map(one => one.trim()).filter(one => one !== ''))
}

/** Looks at the reviewers' judgement of a run's change, while they review. */
export async function judge(p: Ports, ref: string): Promise<void> {
  const held = await p.runs.at(ref)

  if (held === null || held.phase !== 'reviewing') return

  await settle(p, ref, parseJudgement(await p.parts.judgementFor(held.tree).catch((error: unknown) => errorText(error))))
}

/** What the reviewers' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
export async function settle(p: Ports, ref: string, judged: ReturnType<typeof parseJudgement>): Promise<void> {
  const held = await p.runs.keep(ref, was => (was.phase === 'reviewing' ? { ...was, verdictLine: judged.line } : was))

  if (held === null || held.phase !== 'reviewing' || held.current === null) return

  const out = held.current

  // Minor findings of a pass about what the change wrote send its builder back once to tidy them; those of the judgement
  // after, and those about files it left alone, are committed as they are, and a builder that cannot be reached spends no
  // try on them
  const step = afterVerdict(judged, out, isTidyAsked(judged, out) ? await ownMinorIn(p, held.tree, judged) : [])

  if (step.kind === 'wait') return
  if (step.kind === 'tidy') {
    if (await p.agents.sendBack(out.agentId, out.builder, tidyPrompt(step.minor))) {
      await p.runs.keep(ref, was => ({ ...was, phase: 'building', current: { ...out, isTidied: true, answer: '' } }))
      await p.board.say(ref, `${BUILDERS[out.builder].title} is sent back to task ${out.taskId} to tidy the minor findings: ${judged.line}`)

      return
    }

    return void (await commitNow(p, ref, step.otherwise.minor))
  }
  if (step.kind === 'commit') return void (await commitNow(p, ref, step.minor))
  if (step.kind === 'again') return again(p, ref, step.why, step.line)

  // The change moved while they sat, or they never reviewed it: it is proved and judged afresh
  if (step.kind === 'prove') {
    await p.runs.keep(ref, was => ({ ...was, phase: 'proving' }))
    await p.board.want(ref, 'prove')

    return
  }

  if (step.kind === 'stop') await stop(p, held, step.why)
}
