import type { Target, TargetKind } from '../types'
import { parseProject, parseReviews, parseStandards } from './proof'
import type { Review } from './proof'
import { parseToml, tomlLiteral, tomlString } from './toml'
import type { TomlTable, TomlValue } from './toml'

// The project's file: what it builds, how each is tested and checked, and who reviews a change. It is
// .claude/theseus.toml, specified in docs/config.md with a JSON Schema beside the plugin; the line format of
// .claude/verify is still read, with a warning, for one release. Text in, text out.

/** The project's file, and the one it was before. */
export const CONFIG_FILE = '.claude/theseus.toml'
export const LINES_FILE = '.claude/verify'

/** What the project's file says, and what of it does not read, a `file:line: why` each. */
export type Project = { targets: Target[]; reviews: Review[]; standards: string[]; errors: string[]; file: string }

const KINDS: readonly TargetKind[] = ['cli', 'service', 'frontend']

/** Each key a target takes, and the type of its value. */
const TARGET_KEYS = {
  kind: 'string',
  roots: 'strings',
  tests: 'strings',
  test: 'string',
  app: 'string',
  python: 'string',
  env: 'strings by name',
  masks: 'strings',
  requests: 'strings',
  affected: 'string',
  checks: 'strings',
  audit: 'string',
  db: 'table',
  ready: 'table',
  live: 'table',
} as const
const DB_KEYS = { image: 'string', env: 'string', setup: 'string' } as const
const READY_KEYS = { request: 'string', match: 'string' } as const
const LIVE_KEYS = { workload: 'string', forward: 'strings', env: 'strings by name', db: 'string', before: 'string', cleanup: 'strings', restore: 'string', scratch: 'string' } as const
const TOP_KEYS = { review: 'strings', standards: 'strings', targets: 'table' } as const

/** The keys of the file, at each level, as the JSON Schema has them: a test holds the two the same. */
export const KEYS = { top: TOP_KEYS, target: TARGET_KEYS, db: DB_KEYS, ready: READY_KEYS, live: LIVE_KEYS } as const

type Kind = 'string' | 'strings' | 'strings by name' | 'table'

const isTable = (value: unknown): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value)
const fits = (value: TomlValue, kind: Kind): boolean =>
  kind === 'string'
    ? typeof value === 'string'
    : kind === 'strings'
      ? Array.isArray(value) && value.every(one => typeof one === 'string')
      : kind === 'strings by name'
        ? isTable(value) && Object.values(value).every(one => typeof one === 'string')
        : isTable(value)
const KIND_SAID: Record<Kind, string> = { string: 'a string', strings: 'a list of strings', 'strings by name': 'a table of strings', table: 'a table' }

const under = (cwd: string, path: string): string => (/^([A-Za-z]:)?\//.test(path) ? path.replace(/\/+$/, '') : `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '').replace(/\/+$/, '')}`)

/** Reads .claude/theseus.toml. */
export const projectOfToml = (text: string, cwd: string): Project => {
  const read = parseToml(text)
  const errors = read.errors.map(error => `${CONFIG_FILE}:${error.replace(/^line /, '')}`)
  const where = (path: string): string => `${CONFIG_FILE}:${read.lineOf.get(path) ?? 1}`
  /** The keys of a table its kind knows, each that does not said. */
  const known = (table: TomlTable, keys: Record<string, Kind>, path: string): void => {
    for (const [name, given] of Object.entries(table)) {
      const kind = keys[name]
      const full = path === '' ? name : `${path}.${name}`

      if (kind === undefined) errors.push(`${where(full)}: ${full} is no key Theseus knows (${Object.keys(keys).join(', ')})`)
      else if (!fits(given, kind)) errors.push(`${where(full)}: ${full} must be ${KIND_SAID[kind]}`)
    }
  }
  const strings = (table: TomlTable, name: string): string[] => (Array.isArray(table[name]) ? (table[name] as TomlValue[]).filter((one): one is string => typeof one === 'string') : [])
  const text_ = (table: TomlTable, name: string): string => (typeof table[name] === 'string' ? (table[name] as string) : '')
  const byName = (table: TomlTable, name: string): Record<string, string> => (isTable(table[name]) ? Object.fromEntries(Object.entries(table[name] as TomlTable).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {})

  known(read.value, TOP_KEYS, '')

  const targets: Target[] = []
  const given = isTable(read.value.targets) ? read.value.targets : {}

  for (const [label, raw] of Object.entries(given)) {
    const path = `targets.${label}`

    if (!isTable(raw)) {
      errors.push(`${where(path)}: ${path} must be a table: [targets.${label}]`)
      continue
    }
    known(raw, TARGET_KEYS, path)

    const kind = KINDS.find(one => one === raw.kind)

    if (kind === undefined) {
      errors.push(`${where(raw.kind === undefined ? path : `${path}.kind`)}: ${path}.kind must be one of ${KINDS.join(', ')}`)
      continue
    }
    if (strings(raw, 'roots').length === 0) errors.push(`${where(path)}: ${path}.roots must name at least one folder whose edits are edits of ${label}`)
    if (kind === 'service' && text_(raw, 'app') === '') errors.push(`${where(path)}: ${path}.app must name the service's app as Python imports it, "module:app"`)

    const table = (name: 'db' | 'ready' | 'live', keys: Record<string, Kind>, needs: string): TomlTable | null => {
      const held = raw[name]

      if (!isTable(held)) return null
      known(held, keys, `${path}.${name}`)
      if (typeof held[needs] !== 'string' || held[needs] === '') {
        errors.push(`${where(`${path}.${name}`)}: ${path}.${name}.${needs} must be set`)
        return null
      }
      return held
    }
    const db = table('db', DB_KEYS, 'image')
    const ready = table('ready', READY_KEYS, 'request')
    const live = table('live', LIVE_KEYS, 'workload')

    targets.push({
      label,
      kind,
      roots: strings(raw, 'roots').map(root => under(cwd, root)),
      tests: strings(raw, 'tests').map(test => under(cwd, test)),
      test: text_(raw, 'test'),
      app: kind === 'service' ? text_(raw, 'app') : '',
      python: text_(raw, 'python').replace(/^\.\//, ''),
      env: byName(raw, 'env'),
      masks: strings(raw, 'masks'),
      requests: strings(raw, 'requests').map(request => `${label} ${request}`),
      affected: text_(raw, 'affected'),
      checks: strings(raw, 'checks'),
      audit: text_(raw, 'audit'),
      db: db === null ? null : { image: text_(db, 'image'), env: text_(db, 'env') || 'DATABASE_URL', setup: text_(db, 'setup') },
      ready: ready === null ? null : { request: text_(ready, 'request'), match: text_(ready, 'match') },
      live:
        live === null
          ? null
          : { workload: text_(live, 'workload'), forward: strings(live, 'forward'), env: byName(live, 'env'), db: text_(live, 'db'), before: text_(live, 'before'), cleanup: strings(live, 'cleanup'), restore: text_(live, 'restore'), scratch: text_(live, 'scratch') },
    })
  }

  const reviews = strings(read.value, 'review').flatMap(line => {
    const found = /^\/?([\w:-]+)\s*(.*)$/.exec(line.trim())

    if (found === null) {
      errors.push(`${where('review')}: review names a slash command and what follows it, "/code-review medium": not ${JSON.stringify(line)}`)
      return []
    }
    return [{ command: found[1] ?? '', args: (found[2] ?? '').trim() }]
  })

  return { targets, reviews, standards: strings(read.value, 'standards'), errors, file: CONFIG_FILE }
}

// A line of the old format: a comment, a target, a setting of one, a kept request, a review or a standards file
const LINE_PATTERNS = [/^#/, /^[\w.-]+\s*=\s*(cli|service|frontend)(:[^@]*)?\s*@\s*.+$/, /^[\w.-]+?\.(tests|test|python|env|mask|affected|check|audit|ready|ready\.match|db|db\.env|db\.setup|live|live\.forward|live\.env|live\.db|live\.before|live\.cleanup|live\.restore|live\.scratch)\s*=/, /^\$\s+\S+/, /^review\s*=/, /^standards\s*=/]

/** Reads .claude/verify, the line format: each line that reads as nothing, and each setting of a target it does not name, is an error. */
export const projectOfLines = (text: string, cwd: string): Project => {
  const targets = parseProject(text, cwd)
  const labels = new Set(targets.map(target => target.label))
  const errors = text.split('\n').flatMap((raw, index) => {
    const line = raw.trim()
    const at = `${LINES_FILE}:${index + 1}`

    if (line === '') return []
    if (!LINE_PATTERNS.some(pattern => pattern.test(line))) return [`${at}: this line reads as nothing Theseus knows: ${line}`]

    const setting = /^([\w.-]+?)\.(tests|test|python|env|mask|affected|check|audit|ready|db|live)\b/.exec(line)?.[1]
    const kept = /^\$\s+(\S+)/.exec(line)?.[1]
    const label = setting ?? kept

    return label !== undefined && !labels.has(label) && !/^(review|standards)\s*=/.test(line) ? [`${at}: ${label} is no target this file names (${[...labels].join(', ') || 'none'})`] : []
  })

  return { targets, reviews: parseReviews(text), standards: parseStandards(text), errors, file: LINES_FILE }
}

/** The project's file as Theseus reads it: the TOML one where it is there, else the line format, which is warned of. */
export const projectOf = (files: { toml?: string | undefined; lines?: string | undefined }, cwd: string): Project | undefined => {
  if (files.toml !== undefined) return projectOfToml(files.toml, cwd)
  if (files.lines === undefined) return undefined

  const read = projectOfLines(files.lines, cwd)

  return { ...read, errors: [...read.errors, `${LINES_FILE}: the line format goes in the next release: /theseus init writes ${CONFIG_FILE} from it`] }
}

/** Whether an error of the project's file is only the warning that the line format goes. */
export const isMigrationWarning = (error: string): boolean => error.startsWith(`${LINES_FILE}: the line format goes`)

const within = (cwd: string, path: string): string => (path.startsWith(`${cwd.replace(/\/+$/, '')}/`) ? path.slice(cwd.replace(/\/+$/, '').length + 1) : path)
const list = (items: readonly string[], quote: (text: string) => string = tomlString): string => (items.length <= 1 ? `[${items.map(quote).join(', ')}]` : `[\n${items.map(item => `  ${quote(item)},`).join('\n')}\n]`)
const table = (entries: Record<string, string>): string => `{ ${Object.entries(entries).map(([name, value]) => `${/^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name)} = ${tomlString(value)}`).join(', ')} }`

/** A project as .claude/theseus.toml says it: what `/theseus init` writes. */
export const projectToml = (project: Pick<Project, 'targets' | 'reviews' | 'standards'>, cwd: string): string => {
  const lines = ['#:schema https://raw.githubusercontent.com/lienardquentin/theseus/main/theseus/schema/theseus.schema.json', '# What Theseus proves and reviews a change by: docs/config.md says what each key does.', '']

  if (project.reviews.length > 0) lines.push(`review = ${list(project.reviews.map(one => `/${one.command}${one.args === '' ? '' : ` ${one.args}`}`))}`)
  if (project.standards.length > 0) lines.push(`standards = ${list(project.standards)}`)

  for (const target of project.targets) {
    const label = /^[A-Za-z0-9_-]+$/.test(target.label) ? target.label : tomlString(target.label)

    lines.push('', `[targets.${label}]`, `kind = ${tomlString(target.kind)}`)
    if (target.kind === 'service') lines.push(`app = ${tomlString(target.app)}`)
    lines.push(`roots = ${list(target.roots.map(root => within(cwd, root)))}`)
    if (target.python !== '') lines.push(`python = ${tomlString(target.python)}`)
    if (target.tests.length > 0) lines.push(`tests = ${list(target.tests.map(test => within(cwd, test)))}`)
    if (target.test !== '') lines.push(`test = ${tomlString(target.test)}`)
    if (target.affected !== '') lines.push(`affected = ${tomlString(target.affected)}`)
    if (target.checks.length > 0) lines.push(`checks = ${list(target.checks)}`)
    if (target.audit !== '') lines.push(`audit = ${tomlString(target.audit)}`)
    if (Object.keys(target.env).length > 0) lines.push(`env = ${table(target.env)}`)
    if (target.masks.length > 0) lines.push(`masks = ${list(target.masks, tomlLiteral)}`)
    if (target.requests.length > 0) lines.push(`requests = ${list(target.requests.map(request => request.slice(target.label.length + 1)), tomlLiteral)}`)
    if (target.db !== null) lines.push('', `[targets.${label}.db]`, `image = ${tomlString(target.db.image)}`, `env = ${tomlString(target.db.env)}`, ...(target.db.setup !== '' ? [`setup = ${tomlString(target.db.setup)}`] : []))
    if (target.ready !== null) lines.push('', `[targets.${label}.ready]`, `request = ${tomlString(target.ready.request)}`, ...(target.ready.match !== '' ? [`match = ${tomlLiteral(target.ready.match)}`] : []))
    if (target.live !== null) {
      const live = target.live

      lines.push('', `[targets.${label}.live]`, `workload = ${tomlString(live.workload)}`)
      if (live.forward.length > 0) lines.push(`forward = ${list(live.forward)}`)
      if (Object.keys(live.env).length > 0) lines.push(`env = ${table(live.env)}`)
      if (live.db !== '') lines.push(`db = ${tomlString(live.db)}`)
      if (live.before !== '') lines.push(`before = ${tomlString(live.before)}`)
      if (live.cleanup.length > 0) lines.push(`cleanup = ${list(live.cleanup)}`)
      if (live.restore !== '') lines.push(`restore = ${tomlString(live.restore)}`)
      if (live.scratch !== '') lines.push(`scratch = ${tomlString(live.scratch)}`)
    }
  }

  return `${lines.join('\n')}\n`
}

/** A file of the project init reads, by its path from the project's folder. */
export type Found = { path: string; text: string }

/** A blank target, to be filled in. */
const blank = (label: string, kind: TargetKind, root: string, cwd: string): Target => ({ label, kind, roots: [under(cwd, root)], tests: [], test: '', app: '', python: '', env: {}, masks: [], requests: [], live: null, db: null, ready: null, affected: '', checks: [], audit: '' })

const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')
const labelOf = (folder: string, fallback: string): string => (folder === '.' ? fallback : (folder.split('/').at(-1) ?? fallback)).replace(/[^\w-]/g, '-')

/**
 * What /theseus init proposes for a project, read from its manifests: a CLI for each Cargo package with a binary, a
 * service for each Python project serving a FastAPI app, a frontend for each JavaScript app; and the reviews.
 * `has` says whether a path from the project's folder is there.
 */
export const proposeProject = (found: readonly Found[], has: (path: string) => boolean, cwd: string, name: string): Pick<Project, 'targets' | 'reviews' | 'standards'> => {
  const targets: Target[] = []

  for (const { path, text } of found) {
    const folder = folderOf(path)
    const at = (rest: string): string => (folder === '.' ? rest : `${folder}/${rest}`)

    if (path.endsWith('Cargo.toml') && !/^\[workspace\]/m.test(text) && (has(at('src/main.rs')) || /^\[\[bin\]\]/m.test(text))) {
      const target = blank(labelOf(folder, name), 'cli', folder, cwd)
      const manifest = `--manifest-path ${at('Cargo.toml')}`

      targets.push({
        ...target,
        tests: has(at('tests')) ? [under(cwd, at('tests'))] : [],
        test: `cargo test ${manifest} -- --exact {tests}`,
        affected: `cargo test ${manifest}`,
        checks: [`cargo clippy ${manifest} --all-targets --quiet -- -D warnings && cargo fmt ${manifest} --check`],
      })
    }

    if (path.endsWith('pyproject.toml')) {
      const app = found.find(one => one.path.endsWith('.py') && one.path.startsWith(folder === '.' ? '' : `${folder}/`) && /^\s*(\w+)\s*=\s*FastAPI\(/m.test(one.text))

      if (app === undefined) continue
      const variable = /^\s*(\w+)\s*=\s*FastAPI\(/m.exec(app.text)?.[1] ?? 'app'
      const module = app.path
        .slice(folder === '.' ? 0 : folder.length + 1)
        .replace(/\.py$/, '')
        .replace(/^src\//, '')
        .replaceAll('/', '.')
      const root = folderOf(app.path)
      const run = has(at('uv.lock')) ? `uv run --quiet --project ${folder} ` : ''
      const tests = has(at('tests')) ? at('tests') : ''
      const target = blank(labelOf(root, name), 'service', root, cwd)

      targets.push({
        ...target,
        app: `${module}:${variable}`,
        python: folder === '.' ? '' : folder,
        tests: tests === '' ? [] : [under(cwd, tests)],
        test: tests === '' ? '' : `${run}pytest -v -p no:cacheprovider ${tests} -k "{tests: or }"`,
        affected: tests === '' ? '' : `${run}pytest -q -rfE -p no:cacheprovider ${tests}`,
        checks: /\bruff\b/.test(text) ? [`${run}ruff check ${root}`] : [],
        // Every FastAPI app answers its schema: a first kept request that shows what the routes are
        requests: [`${labelOf(root, name)} GET /openapi.json`],
      })
    }

    if (path.endsWith('package.json')) {
      let manifest: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

      try {
        manifest = JSON.parse(text) as typeof manifest
      } catch {
        continue
      }
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
      const isApp = ['nuxt', 'next', 'vite', 'react-scripts', '@angular/core', 'svelte', '@sveltejs/kit', 'astro'].some(one => one in dependencies)

      if (!isApp || manifest.scripts?.test === undefined) continue
      const prefix = folder === '.' ? '' : ` --prefix ${folder}`

      targets.push({ ...blank(labelOf(folder, name), 'frontend', folder, cwd), tests: has(at('tests')) ? [under(cwd, at('tests'))] : [], affected: `npm${prefix} test --silent` })
    }
  }

  return {
    targets,
    reviews: [
      { command: 'code-review', args: 'medium' },
      { command: 'security-review', args: '' },
    ],
    standards: ['docs/agents/standards.md', 'STANDARDS.md', 'CONTRIBUTING.md'].filter(path => has(path)).slice(0, 1),
  }
}
