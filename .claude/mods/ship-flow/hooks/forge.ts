import type { Host } from './host'
import { FORGES, forgeOf, REMOTE_ARGV } from './kit/forge'
import type { Forge } from './kit/forge'
import type { RunRecord } from './run'
import { tail } from './work'

/**
 * Everything a run asks of the repo's forge, GitHub through `gh` or GitLab through `glab`: its issue, its pull
 * request (a merge request on GitLab), and what that request has met. The two command lines print different
 * things, so each has its argv and its reading here, and the rest of the mod is written against what they share.
 */

/** The forge of the repo the session is in: the one the option names, else the one its origin is on. */
export const detect = async (host: Host, asked: string): Promise<Forge> => {
  const origin = await host.run(REMOTE_ARGV).catch(() => undefined)

  return forgeOf({ asked, remote: origin?.exitCode === 0 ? origin.stdout : undefined })
}

/** The forge a run was begun on. A record that does not say is of a run from before GitLab: GitHub. */
export const forgeFor = (record: Pick<RunRecord, 'forge'> | undefined): Forge => FORGES[record?.forge ?? 'github']

/** What the run's forge calls a branch that asks to be merged: `pull request`, or `merge request`. */
export const requestOf = (record: Pick<RunRecord, 'forge'> | undefined): string => forgeFor(record).request

export type Issue = { number: number; title: string; body: string; labels: readonly string[] }

/** An issue of the repo, or why it could not be read. */
export const readIssue = async (host: Host, forge: Forge, number: string): Promise<Issue | { why: string }> => {
  const viewed = await host.run(
    forge.id === 'gitlab' ? ['glab', 'issue', 'view', number, '--output', 'json'] : ['gh', 'issue', 'view', number, '--json', 'number,title,body,labels'],
  )

  if (viewed.exitCode !== 0) return { why: tail(viewed.stderr).trim() }

  try {
    if (forge.id === 'gitlab') {
      const read = JSON.parse(viewed.stdout) as { iid?: number; title?: string; description?: string | null; labels?: readonly string[] }

      return { number: read.iid ?? Number(number), title: read.title ?? '', body: read.description ?? '', labels: read.labels ?? [] }
    }

    const read = JSON.parse(viewed.stdout) as { number: number; title: string; body: string; labels: readonly { name: string }[] }

    return { number: read.number, title: read.title, body: read.body, labels: read.labels.map(label => label.name) }
  } catch {
    return { why: `${forge.cli} answered something that is not an issue` }
  }
}

/** Opens an issue, its body handed over on stdin; answers its number, or why there is none. */
export const openIssue = async (host: Host, forge: Forge, title: string, body: string): Promise<{ number: number } | { why: string }> => {
  const created = await host.run(
    forge.id === 'gitlab'
      ? ['glab', 'issue', 'create', '--title', title, '--description-file', '-', '--yes']
      : ['gh', 'issue', 'create', '--title', title, '--body-file', '-'],
    { stdin: body },
  )
  // Both print the new issue's address, which ends in its number: /issues/12, and /-/issues/12 on GitLab
  const opened = /\/issues\/(\d+)/.exec(`${created.stdout}\n${created.stderr}`)?.[1]

  return created.exitCode !== 0 || opened === undefined ? { why: tail(created.stderr || created.stdout).trim() } : { number: Number(opened) }
}

export type Request = { url: string; isDraft: boolean }

/** The request open for a branch, if there is one. */
export const findRequest = async (host: Host, forge: Forge, branch: string): Promise<Request | undefined> => {
  const viewed = await host.run(
    forge.id === 'gitlab' ? ['glab', 'mr', 'view', branch, '--output', 'json'] : ['gh', 'pr', 'view', branch, '--json', 'url,isDraft'],
  )

  if (viewed.exitCode !== 0) return undefined

  try {
    if (forge.id === 'gitlab') {
      const open = JSON.parse(viewed.stdout) as { web_url?: string; draft?: boolean; work_in_progress?: boolean }

      return open.web_url === undefined ? undefined : { url: open.web_url, isDraft: open.draft ?? open.work_in_progress ?? false }
    }

    return JSON.parse(viewed.stdout) as Request
  } catch {
    return undefined
  }
}

/** Brings a branch's request up to date: a new body, and a draft or not; answers why it could not. */
export const updateRequest = async (
  host: Host,
  forge: Forge,
  branch: string,
  to: { body: string; isDraft: boolean; wasDraft: boolean },
): Promise<string | undefined> => {
  const turns = to.isDraft !== to.wasDraft

  if (forge.id === 'gitlab') {
    const updated = await host.run(
      ['glab', 'mr', 'update', branch, '--description-file', '-', '--yes', ...(turns ? [to.isDraft ? '--draft' : '--ready'] : [])],
      { stdin: to.body },
    )

    return updated.exitCode === 0 ? undefined : tail(updated.stderr || updated.stdout).trim()
  }

  const edited = await host.run(['gh', 'pr', 'edit', branch, '--body-file', '-'], { stdin: to.body })

  if (edited.exitCode !== 0) return tail(edited.stderr).trim()
  if (turns) await host.run(['gh', 'pr', 'ready', branch, ...(to.isDraft ? ['--undo'] : [])])

  return undefined
}

/** Opens a branch's request, its body handed over on stdin; answers its address, or why there is none. */
export const openRequest = async (
  host: Host,
  forge: Forge,
  asked: { base: string; branch: string; title: string; body: string; isDraft: boolean },
): Promise<{ url: string } | { why: string }> => {
  const { base, branch, title, body, isDraft } = asked
  const draft = isDraft ? ['--draft'] : []

  if (forge.id === 'gitlab') {
    const created = await host.run(
      ['glab', 'mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', title, '--description-file', '-', '--yes', ...draft],
      { stdin: body },
    )

    if (created.exitCode !== 0) return { why: tail(created.stderr || created.stdout).trim() }

    // glab prints the address among other lines; a version that prints none is asked for the request it just opened
    const url = /https?:\/\/\S+\/merge_requests\/\d+/.exec(`${created.stdout}\n${created.stderr}`)?.[0] ?? (await findRequest(host, forge, branch))?.url

    return url === undefined ? { why: 'glab opened it and did not say where' } : { url }
  }

  const created = await host.run(['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', '-', ...draft], { stdin: body })

  return created.exitCode !== 0 ? { why: tail(created.stderr).trim() } : { url: created.stdout.trim().split('\n').at(-1) ?? '' }
}

/** A check of a request that failed, and where its log is. */
export type Failing = { name?: string; link?: string }

/** Something a person said on a request: who, where (a review, a comment, a line of the diff), and when. */
export type Said = { who: string; where: string; body: string; at?: string }

// What a command printed, read as JSON; undefined when it printed none
const answered = async <T>(host: Host, argv: readonly string[]): Promise<T | undefined> => {
  try {
    return JSON.parse((await host.run(argv)).stdout) as T
  } catch {
    return undefined
  }
}

const metOnGithub = async (host: Host, branch: string, url: string): Promise<{ failing: Failing[]; said: Said[] }> => {
  const checks = await answered<readonly { name?: string; bucket?: string; link?: string }[]>(host, ['gh', 'pr', 'checks', branch, '--json', 'name,bucket,link'])
  const viewed = await answered<{
    reviews?: readonly { author?: { login?: string }; body?: string; state?: string; submittedAt?: string }[]
    comments?: readonly { author?: { login?: string }; body?: string; createdAt?: string }[]
  }>(host, ['gh', 'pr', 'view', branch, '--json', 'reviews,comments'])
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  const inline =
    number === undefined
      ? undefined
      : await answered<readonly { user?: { login?: string }; path?: string; line?: number | null; body?: string; created_at?: string }[]>(host, [
          'gh',
          'api',
          `repos/{owner}/{repo}/pulls/${number}/comments`,
        ])

  return {
    failing: Array.isArray(checks) ? checks.filter(check => check.bucket === 'fail') : [],
    said: [
      ...(viewed?.reviews ?? []).map(review => ({
        who: review.author?.login ?? 'someone',
        where: `a review (${(review.state ?? 'commented').toLowerCase().replaceAll('_', ' ')})`,
        body: review.body ?? '',
        ...(review.submittedAt !== undefined ? { at: review.submittedAt } : {}),
      })),
      ...(viewed?.comments ?? []).map(comment => ({
        who: comment.author?.login ?? 'someone',
        where: 'a comment',
        body: comment.body ?? '',
        ...(comment.createdAt !== undefined ? { at: comment.createdAt } : {}),
      })),
      ...(Array.isArray(inline) ? inline : []).map(comment => ({
        who: comment.user?.login ?? 'someone',
        where: `${comment.path ?? 'the diff'}${comment.line ? `:${comment.line}` : ''}`,
        body: comment.body ?? '',
        ...(comment.created_at !== undefined ? { at: comment.created_at } : {}),
      })),
    ],
  }
}

// GitLab keeps a request's checks as the jobs of its last pipeline, and all that was said on it as its notes: the
// comments, the threads of a review and the ones on a line of the diff, with what GitLab itself logged among them
const metOnGitlab = async (host: Host, branch: string, url: string): Promise<{ failing: Failing[]; said: Said[] }> => {
  const viewed = await answered<{ iid?: number; head_pipeline?: { id?: number } | null }>(host, ['glab', 'mr', 'view', branch, '--output', 'json'])
  const number = viewed?.iid ?? /\/merge_requests\/(\d+)/.exec(url)?.[1]
  const pipeline = viewed?.head_pipeline?.id
  const jobs =
    pipeline === undefined
      ? undefined
      : await answered<readonly { name?: string; status?: string; allow_failure?: boolean; web_url?: string }[]>(host, [
          'glab',
          'api',
          `projects/:fullpath/pipelines/${pipeline}/jobs?per_page=100`,
        ])
  const notes =
    number === undefined
      ? undefined
      : await answered<
          readonly {
            author?: { username?: string }
            body?: string
            created_at?: string
            system?: boolean
            position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null
          }[]
        >(host, ['glab', 'api', `projects/:fullpath/merge_requests/${number}/notes?per_page=100&sort=asc`])

  return {
    failing: (Array.isArray(jobs) ? jobs : [])
      .filter(job => job.status === 'failed' && job.allow_failure !== true)
      .map(job => ({ ...(job.name !== undefined ? { name: job.name } : {}), ...(job.web_url !== undefined ? { link: job.web_url } : {}) })),
    said: (Array.isArray(notes) ? notes : [])
      .filter(note => note.system !== true)
      .map(note => {
        const path = note.position?.new_path ?? note.position?.old_path
        const line = note.position?.new_line ?? note.position?.old_line

        return {
          who: note.author?.username ?? 'someone',
          where: note.position ? `${path ?? 'the diff'}${line ? `:${line}` : ''}` : 'a comment',
          body: note.body ?? '',
          ...(note.created_at !== undefined ? { at: note.created_at } : {}),
        }
      }),
  }
}

/** What a branch's request has met: its checks that fail, and all that was said on it, oldest first as the forge gives it. */
export const metBy = (host: Host, forge: Forge, branch: string, url: string): Promise<{ failing: Failing[]; said: Said[] }> =>
  forge.id === 'gitlab' ? metOnGitlab(host, branch, url) : metOnGithub(host, branch, url)
