import type { Target } from '../types'
import { forgeOfUrl } from './forge'

// What Theseus needs on this machine and in this project, each checked only when the project's setup needs it, and
// what fixes each miss. Theseus never runs an installer itself: it names the one command that fixes the miss.

/** How a check came out: `warn` is said and blocks nothing; `missing` and `broken` stop a run that needs them. */
export type CheckState = 'ok' | 'warn' | 'missing' | 'broken'

/** One thing checked: what, how it came out, what was found, and the command or step that fixes it. */
export type Check = { name: string; state: CheckState; found: string; fix: string }

/** What a check runs a command with, and what it reads. */
export type DoctorPorts = {
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  exists: (path: string) => Promise<boolean>
}

/** What the doctor is told of the project. */
export type Project = {
  /** The project's folder. */
  root: string
  /** Whether .claude/verify is there, and what it names. */
  hasConfig: boolean
  targets: readonly Target[]
  /** What could not be read of the project's config, a line each. */
  configErrors: readonly string[]
  /** The plugins installed, by id (`recorder@theseus`). */
  installed: readonly string[]
  /** What the lag check says of the installed copies, a line each; none when they are what the folder holds. */
  lags: readonly string[]
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

/** The program a shell command starts, past the `NAME=value` words that set its environment; empty for none. */
export const programOf = (command: string): string => {
  const words = command.trim().split(/\s+/)
  const word = words.find(one => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(one)) ?? ''

  return word.replace(/^['"]|['"]$/g, '')
}

/** Each program the project's targets start, with the settings that name it, `narsil.test`. */
export const programsOf = (targets: readonly Target[]): Map<string, string[]> => {
  const programs = new Map<string, string[]>()
  const add = (command: string, where: string): void => {
    // Each part of `a && b` starts a program of its own
    for (const part of command.split(/&&|\|\||;/)) {
      const program = programOf(part)

      if (program === '') continue
      programs.set(program, [...new Set([...(programs.get(program) ?? []), where])])
    }
  }

  for (const target of targets) {
    if (target.test !== '') add(target.test, `${target.label}.test`)
    if (target.affected !== '') add(target.affected, `${target.label}.affected`)
    if (target.audit !== '') add(target.audit, `${target.label}.audit`)
    target.checks.forEach(check => add(check, `${target.label}.check`))
  }

  return programs
}

/** Whether a program can be started: found on the PATH, or a path that is there. */
async function isThere(p: DoctorPorts, program: string): Promise<boolean> {
  return (await p.run(['sh', '-c', 'command -v "$1"', 'sh', program])).exitCode === 0
}

/** The forge's checks: its CLI there, and signed in to the origin's host. */
async function forgeChecks(p: DoctorPorts, root: string): Promise<Check[]> {
  const origin = await p.run(['git', '-C', root, 'remote', 'get-url', 'origin'])
  const url = origin.stdout.trim()

  if (origin.exitCode !== 0 || url === '')
    return [{ name: 'origin remote', state: 'warn', found: 'none', fix: 'Theseus reads issues and opens pull requests through the origin remote: git remote add origin <url>' }]

  const host = /^[\w+.-]+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url)?.[1] ?? /^[^@]+@([^:]+):/.exec(url)?.[1] ?? ''
  const kind = forgeOfUrl(url)
  const cli = kind === 'gitlab' ? 'glab' : 'gh'
  const checks: Check[] = [{ name: 'origin remote', state: 'ok', found: url, fix: '' }]

  if (!(await isThere(p, cli))) return [...checks, { name: cli, state: 'missing', found: 'not on the PATH', fix: kind === 'gitlab' ? 'Install the GitLab CLI: https://gitlab.com/gitlab-org/cli' : 'Install the GitHub CLI: https://cli.github.com' }]

  const signed = await p.run([cli, 'auth', 'status', '--hostname', host])

  return [
    ...checks,
    signed.exitCode === 0
      ? { name: `${cli} sign-in`, state: 'ok', found: host, fix: '' }
      : { name: `${cli} sign-in`, state: 'broken', found: firstLine(signed.stderr || signed.stdout) || `not signed in to ${host}`, fix: `${cli} auth login --hostname ${host}` },
  ]
}

/** Everything Theseus needs here, each checked only when the project needs it. */
export async function examine(p: DoctorPorts, project: Project): Promise<Check[]> {
  const checks: Check[] = []
  const git = await p.run(['git', '--version'])

  if (git.exitCode !== 0) return [{ name: 'git', state: 'missing', found: 'not on the PATH', fix: 'Install git: https://git-scm.com/downloads' }]
  checks.push({ name: 'git', state: 'ok', found: firstLine(git.stdout), fix: '' })

  const top = await p.run(['git', '-C', project.root, 'rev-parse', '--show-toplevel'])

  if (top.exitCode !== 0) return [...checks, { name: 'git repository', state: 'broken', found: `${project.root} is not in one`, fix: 'Start Claude Code inside the git repository Theseus works on' }]
  checks.push({ name: 'git repository', state: 'ok', found: top.stdout.trim(), fix: '' }, ...(await forgeChecks(p, project.root)))

  checks.push(
    !project.hasConfig
      ? { name: '.claude/verify', state: 'warn', found: 'none', fix: "Without it a change is proved by its plan's verification commands alone: /theseus init writes one from the project" }
      : project.configErrors.length > 0
        ? { name: '.claude/verify', state: 'broken', found: project.configErrors.join('; '), fix: 'Fix each line named, as docs/config.md describes it' }
        : { name: '.claude/verify', state: 'ok', found: `${project.targets.length} ${project.targets.length === 1 ? 'target' : 'targets'}`, fix: '' },
  )

  if (project.targets.length > 0) {
    const python = await p.run(['python3', '--version'])

    checks.push(python.exitCode === 0 ? { name: 'python3', state: 'ok', found: firstLine(python.stdout || python.stderr), fix: '' } : { name: 'python3', state: 'missing', found: 'not on the PATH', fix: 'Install Python 3: the proof runs its handlers with python3' })
  }

  for (const [program, where] of programsOf(project.targets)) {
    const isBuiltIn = ['sh', 'bash', 'cd', 'test', '[', 'true', 'false', 'exec', 'env'].includes(program)

    if (isBuiltIn) continue
    checks.push((await isThere(p, program)) ? { name: program, state: 'ok', found: `for ${where.join(', ')}`, fix: '' } : { name: program, state: 'missing', found: `not on the PATH, needed by ${where.join(', ')}`, fix: `Install ${program}, or name another command in .claude/verify` })
  }

  if (project.targets.some(target => target.db !== null)) {
    const docker = await p.run(['docker', 'info', '--format', '{{.ServerVersion}}'])

    checks.push(
      docker.exitCode === 0
        ? { name: 'docker', state: 'ok', found: `server ${docker.stdout.trim()}`, fix: '' }
        : (await isThere(p, 'docker'))
          ? { name: 'docker', state: 'broken', found: firstLine(docker.stderr) || 'its daemon does not answer', fix: 'Start Docker: a service with a database is played against a Postgres container' }
          : { name: 'docker', state: 'missing', found: 'not on the PATH', fix: 'Install Docker: https://docs.docker.com/get-docker/' },
    )
  }

  for (const target of project.targets.filter(one => one.live !== null)) {
    const context = target.live?.workload.split('/')[0] ?? ''

    if (!(await isThere(p, 'kubectl'))) {
      checks.push({ name: 'kubectl', state: 'missing', found: `needed by ${target.label}.live`, fix: 'Install kubectl: https://kubernetes.io/docs/tasks/tools/' })
      continue
    }

    const known = await p.run(['kubectl', 'config', 'get-contexts', context, '-o', 'name'])

    checks.push(known.exitCode === 0 ? { name: `kube context ${context}`, state: 'ok', found: `for ${target.label}.live`, fix: '' } : { name: `kube context ${context}`, state: 'broken', found: `kubectl knows no context ${context}`, fix: `Add the context ${context} to your kubeconfig, or drop ${target.label}.live` })
  }

  if (project.targets.some(target => target.kind === 'cli')) {
    const hasRecorder = project.installed.some(id => id.startsWith('recorder@'))
    const isNamed = await p.exists(`${project.root}/.claude/recorder`)

    checks.push(
      !hasRecorder
        ? { name: 'recorder', state: 'missing', found: 'not installed', fix: 'claude plugin install recorder@theseus: a command-line target is proved by the runs it keeps' }
        : !isNamed
          ? { name: 'recorder', state: 'broken', found: 'no .claude/recorder', fix: 'Name each command-line tool in .claude/recorder: <name>=<built binary>@<source folder>' }
          : { name: 'recorder', state: 'ok', found: 'installed, .claude/recorder there', fix: '' },
    )
  }

  for (const lag of project.lags) checks.push({ name: 'installed copy', state: 'warn', found: lag, fix: 'claude plugin update theseus@theseus, then restart Claude Code' })

  return checks
}

/** The checks that stop a run: a miss of something it needs. */
export const blocking = (checks: readonly Check[]): Check[] => checks.filter(check => check.state === 'missing' || check.state === 'broken')

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', missing: '✗', broken: '✗' }

/** What /theseus doctor answers: a line a check, its fix under it. */
export const doctorText = (checks: readonly Check[]): string => {
  const stopped = blocking(checks)

  return [
    stopped.length === 0 ? 'Theseus has what it needs here.' : `Theseus is missing ${stopped.length === 1 ? 'one thing' : `${stopped.length} things`} it needs here: a run will not start until ${stopped.length === 1 ? 'it is' : 'they are'} fixed.`,
    '',
    ...checks.flatMap(check => [`${MARK[check.state]} ${check.name}: ${check.found}`, ...(check.state === 'ok' ? [] : [`    ${check.fix}`])]),
  ].join('\n')
}
