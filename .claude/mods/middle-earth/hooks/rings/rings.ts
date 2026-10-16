import type { RingsIssue } from '../../types'
import type { Origin } from '../elrond/council'
import { refText } from '../elrond/council'

// How many open issues are listed at most, the most recently updated first
export const LIMIT = 50
// How much of an issue's body the pane shows of the one it opens
const BODY_CHARS = 600

export const HOW_TO = 'The Rings list the open issues of the repository the origin remote names: /rings reads them again.'

/** The forge's CLI that lists the origin's open issues, the most recently updated first, as JSON. */
export const listArgv = ({ forge, server, repo }: Origin): string[] =>
  forge === 'github'
    ? ['gh', 'issue', 'list', '--repo', server === 'github.com' ? repo : `${server}/${repo}`, '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,url,labels,author,updatedAt,body']
    : ['glab', 'issue', 'list', '--repo', server === 'gitlab.com' ? repo : `https://${server}/${repo}`, '--per-page', String(LIMIT), '--output', 'json']

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A label as either forge writes it: GitHub an object with its name, GitLab the name alone. */
const labelOf = (value: unknown): string => (typeof value === 'string' ? value : text((value as { name?: unknown } | null)?.name))

/** The open issues the forge listed, each with the ref Elrond and the Fellowship know it by; why not, when it listed none that reads. */
export const parseIssues = (answer: string, origin: Origin): RingsIssue[] | string => {
  let listed: unknown

  try {
    listed = JSON.parse(answer)
  } catch {
    return `${origin.forge === 'github' ? 'gh' : 'glab'} answered no list of issues that reads.`
  }

  if (!Array.isArray(listed)) return `${origin.forge === 'github' ? 'gh' : 'glab'} answered no list of issues that reads.`

  return listed.flatMap(raw => {
    const one = raw as Record<string, unknown>
    const number = Number(one.number ?? one.iid)

    if (!Number.isInteger(number) || number <= 0) return []

    const author = one.author as { login?: unknown; username?: unknown } | null | undefined
    const body = text(one.body ?? one.description).trim()

    return [
      {
        ref: refText({ ...origin, number }),
        number,
        title: text(one.title),
        url: text(one.url ?? one.web_url),
        labels: (Array.isArray(one.labels) ? one.labels : []).map(labelOf).filter(label => label !== ''),
        author: text(author?.login ?? author?.username),
        updatedAt: text(one.updatedAt ?? one.updated_at),
        body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS)}…` : body,
      },
    ]
  })
}

/** Where an issue stands with the other parts, in a few words: its quest, else its plan, else nothing yet. */
export const standingOf = (quest: { kind: string; phase: string } | undefined, plan: string): string =>
  quest !== undefined ? `${quest.kind} · ${quest.phase}` : plan
