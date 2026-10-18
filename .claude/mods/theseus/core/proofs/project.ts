import type { Target, TargetKind } from '../../types'
import { text } from './answers'

// What the project builds: its targets, the folder each edit is of, its reviews and standards.

/** Where the checkouts a look plays and proves in are kept, under the working directory: per machine, never committed. */
export const HOME = '.theseus/verify'

/** What a comment above a test says to mark it on a kept run: `pins: narsil show 999`. */
export const MARK = 'pins:'

/** A path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

export const under = (cwd: string, path: string): string => (/^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${tidy(cwd)}/${tidy(path).replace(/^\.\//, '')}`)

export const KINDS: readonly TargetKind[] = ['cli', 'service', 'frontend']

/**
 * What a project's file says, a line each and a `#` line a comment:
 *
 * - `label=kind@root,root`: a target, `cli`, `service:module:app` (a service's app as Python imports it) or
 *   `frontend`, and the folders whose edits are edits of it;
 * - `label.tests=path,path` and `label.test=command`: its integration tests, and how they are run from the project's
 *   folder, each test named as it ends;
 * - `label.python=folder`: a service's Python folder, put on the path and its uv project when it has one;
 * - `label.env=NAME=value`: what a service is played with, the same on both builds;
 * - `label.mask=regex`: what to leave out of its answers when two builds are compared;
 * - `label.db=image`, `label.db.env=NAME`, `label.db.setup=command`: a service's database, each build played against
 *   one of its own in a warm container of that Postgres image, its address in NAME, made ready by the command;
 * - `label.ready=METHOD /path` and `label.ready.match=regex`: asked before a service is played, until it answers;
 * - `label.affected=command`: the tests a change of the target can break, run when its folders changed;
 * - `label.check=command`: its lint, type and format checks, run when its folders changed: the change may not newly
 *   fail it. `{against}` in it is the commit the change is compared with. Named again, each is a check of its own, run
 *   and judged apart (`label.check #1`, `#2`), so that one failing before the change hides none the change fails;
 * - `label.audit=command`: what audits its dependencies, run when the change touches a dependency manifest in its
 *   folders: the change may not newly fail it;
 * - `$ label …`: a service's request kept to be played, `$ gondor GET /health`, with a JSON body as one quoted word
 *   after its path, `$ gondor POST /beacons/eilenach/light '{"keeper": "Hirgon"}'`. A CLI's runs are the recorder's to keep.
 *
 * What does not read is left out, and a setting of a target the file does not name is dropped.
 */
export const parseProject = (text: string, cwd: string): Target[] => {
  const targets = new Map<string, Target>()
  const settings: [string, string, string][] = []
  const requests: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const kept = /^\$\s+(.+)$/.exec(line)
    // The shortest label that reads: `gondor.live.env` is gondor's `live.env`, not a `gondor.live`'s `env`
    const set = /^([\w.-]+?)\.(tests|test|python|env|mask|affected|check|audit|ready|ready\.match|db|db\.env|db\.setup|live|live\.forward|live\.env|live\.db|live\.before|live\.cleanup|live\.restore|live\.scratch)\s*=\s*(.*)$/.exec(line)
    const named = /^([\w.-]+)\s*=\s*(cli|service|frontend)(?::([^@]*))?\s*@\s*(.+)$/.exec(line)

    if (line === '' || line.startsWith('#')) continue

    if (kept !== null) requests.push(kept[1] ?? '')
    else if (set !== null) settings.push([set[1] ?? '', set[2] ?? '', (set[3] ?? '').trim()])
    else if (named !== null) {
      const [, label = '', kind = 'cli', app = '', roots = ''] = named

      targets.set(label, {
        label,
        kind: KINDS.find(one => one === kind) ?? 'cli',
        roots: roots.split(',').map(root => root.trim()).filter(root => root !== '').map(root => under(cwd, root)),
        tests: [],
        test: '',
        app: kind === 'service' ? app.trim() : '',
        python: '',
        env: {},
        masks: [],
        requests: [],
        live: null,
        db: null,
        ready: null,
        affected: '',
        checks: [],
        audit: '',
      })
    }
  }

  for (const [label, what, value] of settings) {
    const target = targets.get(label)

    if (target === undefined) continue
    if (what.startsWith('live')) {
      // The workload makes a live stage; what goes with it is kept for it, the order of the lines aside
      target.live ??= { workload: '', forward: [], env: {}, db: '', before: '', cleanup: [], restore: '', scratch: '' }
      const live = target.live
      const cut = value.indexOf('=')

      if (what === 'live') live.workload = value
      else if (what === 'live.forward') live.forward.push(...value.split(',').map(one => one.trim()).filter(one => one !== ''))
      else if (what === 'live.env' && cut > 0) live.env[value.slice(0, cut)] = value.slice(cut + 1)
      else if (what === 'live.db') live.db = value
      else if (what === 'live.before') live.before = value
      else if (what === 'live.cleanup') live.cleanup.push(value)
      else if (what === 'live.restore') live.restore = value
      else if (what === 'live.scratch') live.scratch = value
    } else if (what.startsWith('db')) {
      target.db ??= { image: '', env: 'DATABASE_URL', setup: '' }
      if (what === 'db') target.db.image = value
      else if (what === 'db.env') target.db.env = value
      else target.db.setup = value
    } else if (what.startsWith('ready')) {
      target.ready ??= { request: '', match: '' }
      if (what === 'ready') target.ready.request = value
      else target.ready.match = value
    } else if (what === 'affected') target.affected = value
    else if (what === 'check') target.checks.push(value)
    else if (what === 'audit') target.audit = value
    else if (what === 'tests') target.tests = value.split(',').map(path => path.trim()).filter(path => path !== '').map(path => under(cwd, path))
    else if (what === 'test') target.test = value
    else if (what === 'python') target.python = value.replace(/^\.\//, '')
    else if (what === 'mask') target.masks.push(value)
    else {
      const cut = value.indexOf('=')
      if (cut > 0) target.env[value.slice(0, cut)] = value.slice(cut + 1)
    }
  }

  for (const line of requests) targets.get(line.split(/\s+/)[0] ?? '')?.requests.push(line)

  // A live stage with no workload named is none, as is a database with no image, or a readiness with no request
  return [...targets.values()].map(target => ({
    ...target,
    live: target.live !== null && target.live.workload === '' ? null : target.live,
    db: target.db !== null && target.db.image === '' ? null : target.db,
    ready: target.ready !== null && target.ready.request === '' ? null : target.ready,
  }))
}

/** A review a settled change is owed: a slash command and what follows its name, `/code-review medium`. */
export type Review = { command: string; args: string }

/** The reviews the project's file names, a `review=/command args` line each, in the order they are run. */
export const parseReviews = (text: string): Review[] =>
  text
    .split('\n')
    .map(line => /^review\s*=\s*\/?([\w:-]+)\s*(.*)$/.exec(line.trim()))
    .filter((found): found is RegExpExecArray => found !== null)
    .map(([, command = '', args = '']) => ({ command, args: args.trim() }))

/** The files of written standards the reviewers judge a change by, a `standards=path` line each, from the project's folder. */
export const parseStandards = (text: string): string[] =>
  text
    .split('\n')
    .map(line => /^standards\s*=\s*(.+)$/.exec(line.trim())?.[1]?.trim() ?? '')
    .filter(path => path !== '')

/** The targets an edited file is of: those with a root that holds it. */
export const targetsOf = (path: string, targets: readonly Target[]): Target[] =>
  targets.filter(({ roots }) => roots.some(root => tidy(path) === root || tidy(path).startsWith(`${root}/`)))

/** Whether a target can be proved: its tests and the command that runs them are named. */
export const isTested = (target: Target): boolean => target.tests.length > 0 && target.test !== ''

/** Whether a live workload's context, the first part of `context/namespace/kind/name`, names prod: such a one is never touched. */
export const isProd = (workload: string): boolean => (workload.split('/')[0] ?? '').toLowerCase().includes('prod')
