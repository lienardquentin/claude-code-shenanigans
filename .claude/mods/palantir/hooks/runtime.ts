import type { Attachment, EnvVar, Health, RuntimeId } from '../types'
import { redactVar } from './lines'

// Every runtime's command lines and its reading of what they print live here: no `docker` and no `kubectl` is
// written outside this module. palantir only reads: nothing here restarts or changes what it watches, and the one
// thing run inside it is a broker's own command line, asked what the broker holds.

export const RUNTIME_NAME: Record<RuntimeId, string> = {
  local: 'local',
  docker: 'Docker',
  compose: 'Compose',
  kubernetes: 'Kubernetes',
}

/** The files a compose project is known by, in the order `docker compose` looks for them. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const

/** Asks compose for the project as it resolves it: the services, and where each is built from. */
export const COMPOSE_CONFIG_ARGV = ['docker', 'compose', 'config', '--format', 'json'] as const

const UNKNOWN: Health = { state: 'unknown', detail: '', restarts: 0 }

type Workload = { context: string[]; namespace: string; target: string }

/** `[context/]namespace/kind/name`, as the option writes a Kubernetes workload. */
export const workloadOf = (ref: string): Workload | undefined => {
  const parts = ref.split('/').filter(part => part !== '')

  if (parts.length !== 3 && parts.length !== 4) return undefined

  const [name, kind, namespace, context] = [...parts].reverse() as [string, string, string, string | undefined]

  return { context: context === undefined ? [] : ['--context', context], namespace, target: `${kind}/${name}` }
}

/**
 * The command that prints the attachment's log lines, each led by its timestamp: the last `tail` of them on the
 * first read, then only what came since. A file has none: it is read, not asked.
 */
export const logsArgv = ({ runtime, ref }: Attachment, since: string, tail: number, status = ''): readonly string[] | undefined => {
  if (runtime === 'docker') return ['docker', 'logs', '--timestamps', ...(since === '' ? ['--tail', String(tail)] : ['--since', since]), ref]

  if (runtime === 'compose') {
    const window = since === '' ? ['--tail', String(tail)] : ['--since', since]

    return ['docker', 'compose', 'logs', '--no-color', '--no-log-prefix', '--timestamps', ...window, ref]
  }

  if (runtime === 'kubernetes') {
    const workload = workloadOf(ref)

    if (workload === undefined) return undefined

    const window = since === '' ? [`--tail=${tail}`] : [`--since-time=${since}`]
    const labels = selectorOf(status)

    // Asked by its name, a workload answers with one of its pods: asked by what its pods are labelled with, with
    // them all. `kubectl` then hands over ten lines a pod unless told how many
    if (labels !== '') {
      return ['kubectl', ...workload.context, 'logs', '-n', workload.namespace, '-l', labels, '--timestamps', '--all-containers', `--max-log-requests=${MAX_POD_LOGS}`, ...(since === '' ? window : [...window, '--tail=-1'])]
    }

    return ['kubectl', ...workload.context, 'logs', workload.target, '-n', workload.namespace, '--timestamps', '--all-containers', ...window]
  }

  return undefined
}

// How many containers of a workload are read at once: `kubectl` refuses more than it is told to allow
const MAX_POD_LOGS = 20

/** The command that lists a workload's pods, read off what its status command printed; none for a pod, or where nothing selects them. */
export const podsArgv = ({ runtime, ref }: Attachment, status: string): readonly string[] | undefined => {
  const workload = runtime === 'kubernetes' ? workloadOf(ref) : undefined
  const labels = selectorOf(status)

  return workload === undefined || labels === '' ? undefined : ['kubectl', ...workload.context, 'get', 'pods', '-n', workload.namespace, '-l', labels, '-o', 'json']
}

// How many of a dead container's last lines are read where nothing was read of it before
const LAST_WORDS = 50

/**
 * The commands that print what a container wrote before it last died, for each container of the pods listed that
 * died since `since` (or, on a first read, that is not running now): the lines that say why it died are in the
 * container that is gone, not in the one that took its place.
 */
export const previousArgvs = ({ runtime, ref }: Attachment, pods: string, since: string): (readonly string[])[] => {
  const workload = runtime === 'kubernetes' ? workloadOf(ref) : undefined

  if (workload === undefined) return []

  return podsOf(pods)
    .flatMap(pod =>
      list(record(pod.status).containerStatuses)
        .map(record)
        .filter(container => {
          const ended = word(record(record(container.lastState).terminated).finishedAt)

          return count(container.restartCount) > 0 && ended !== '' && (since === '' ? record(container.state).running === undefined : ended >= since.slice(0, 19))
        })
        .map(container => ['kubectl', ...workload.context, 'logs', `pod/${word(record(pod.metadata).name)}`, '-n', workload.namespace, '-c', word(container.name), '--previous', '--timestamps', ...(since === '' ? [`--tail=${LAST_WORDS}`] : [`--since-time=${since}`])]),
    )
    .slice(0, 4)
}

/** The command that says how the attachment stands. */
export const statusArgv = ({ runtime, ref }: Attachment): readonly string[] | undefined => {
  if (runtime === 'docker') return ['docker', 'inspect', ref]
  if (runtime === 'compose') return ['docker', 'compose', 'ps', '--all', '--format', 'json', ref]

  if (runtime === 'kubernetes') {
    const workload = workloadOf(ref)

    return workload === undefined ? undefined : ['kubectl', ...workload.context, 'get', workload.target, '-n', workload.namespace, '-o', 'json']
  }

  return undefined
}

type Json = Record<string, unknown>

const record = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const word = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// `docker inspect` prints a list of one container
const dockerHealth = (stdout: string): Health => {
  const container = record(list(parsed(stdout))[0])
  const state = record(container.State)
  const status = word(state.Status)
  const restarts = count(container.RestartCount)
  const started = word(state.StartedAt)

  if (status === '') return UNKNOWN
  if (state.OOMKilled === true) return { state: 'down', detail: 'OOMKilled', restarts, started }
  if (status === 'restarting') return { state: 'degraded', detail: 'restarting', restarts, started }
  if (status !== 'running') return { state: 'down', detail: `${status} (${count(state.ExitCode)})`, restarts, started }

  const check = word(record(state.Health).Status)

  if (check === 'unhealthy') return { state: 'degraded', detail: 'unhealthy', restarts, started }

  return { state: 'up', detail: check === '' ? 'running' : check, restarts, started }
}

// `docker compose ps --format json` prints a list, or one object per line, by its version
const composeRows = (stdout: string): Json[] => {
  const whole = parsed(stdout)

  return (Array.isArray(whole) ? whole : stdout.split('\n').map(parsed)).map(record).filter(row => word(row.State) !== '')
}

const composeHealth = (stdout: string): Health => {
  const rows = composeRows(stdout)

  if (rows.length === 0) return { state: 'down', detail: 'not created', restarts: 0 }

  const running = rows.filter(row => row.State === 'running')
  const stopped = rows.find(row => row.State !== 'running')

  if (running.length === 0) return { state: 'down', detail: `${word(stopped?.State)} (${count(stopped?.ExitCode)})`, restarts: 0 }
  if (stopped !== undefined) return { state: 'degraded', detail: `${running.length}/${rows.length} running`, restarts: 0 }
  if (rows.some(row => row.Health === 'unhealthy')) return { state: 'degraded', detail: 'unhealthy', restarts: 0 }

  // A service made again has other containers
  return { state: 'up', detail: rows.length === 1 ? 'running' : `${rows.length} running`, restarts: 0, started: rows.map(row => word(row.ID)).sort().join(' ') }
}

const podHealth = (status: Json): Health => {
  const containers = list(status.containerStatuses).map(record)
  const restarts = containers.reduce((sum, container) => sum + count(container.restartCount), 0)
  const waiting = containers.map(container => word(record(record(container.state).waiting).reason)).find(reason => reason !== '')

  if (waiting !== undefined) return { state: waiting === 'ContainerCreating' ? 'degraded' : 'down', detail: waiting, restarts }

  const phase = word(status.phase)

  if (phase !== 'Running') return { state: phase === 'Pending' ? 'degraded' : 'down', detail: phase || 'unknown', restarts }
  if (containers.some(container => container.ready !== true)) return { state: 'degraded', detail: 'not ready', restarts }

  // Up now, and what ended it last time is worth a word: an OOMKilled pod comes back up
  const last = containers.map(container => word(record(record(container.lastState).terminated).reason)).find(reason => reason !== '')

  return { state: 'up', detail: last === undefined ? 'running' : `running, last ${last}`, restarts }
}

// The pods a `kubectl get pods -o json` lists, or the one pod a `kubectl get pod` printed
const podsOf = (stdout: string): Json[] => {
  const object = record(parsed(stdout))

  return object.kind === 'Pod' ? [object] : list(object.items).map(record)
}

// What a workload's pods are labelled with, as `kubectl -l` takes it; empty for a pod, or where nothing says
const selectorOf = (status: string): string => {
  const object = record(parsed(status))

  if (object.kind === 'Pod') return ''

  return Object.entries(record(record(record(object.spec).selector).matchLabels))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',')
}

const kubernetesHealth = (stdout: string, pods = ''): Health => {
  const object = record(parsed(stdout))
  const status = record(object.status)

  if (word(object.kind) === '') return UNKNOWN
  if (object.kind === 'Pod') return podHealth(status)

  // A workload counts its pods; why one is not ready, and how often its containers died, only the pods say
  const own = podsOf(pods).map(pod => podHealth(record(pod.status)))
  const restarts = own.reduce((sum, pod) => sum + pod.restarts, 0)
  const why = [...new Set(own.filter(pod => pod.detail !== 'running').map(pod => pod.detail))].slice(0, 2).join(', ')

  // A Deployment and a StatefulSet count replicas, a DaemonSet the nodes it is scheduled on
  const wanted = count(record(object.spec).replicas ?? status.desiredNumberScheduled)
  const ready = count(status.readyReplicas ?? status.numberReady)
  const detail = `${ready}/${wanted} ready${why === '' ? '' : `, ${why}`}`

  if (wanted === 0) return { state: 'down', detail: 'scaled to 0', restarts: 0 }

  // A rollout is a new revision of a Deployment, a new generation of anything else
  const started = word(record(record(object.metadata).annotations)['deployment.kubernetes.io/revision']) || String(count(record(object.metadata).generation) || '')

  return { state: ready >= wanted ? 'up' : ready === 0 ? 'down' : 'degraded', detail, restarts, started }
}

/** How the attachment stands, read off what its status command printed, and for a workload what lists its pods. */
export const readHealth = (runtime: RuntimeId, stdout: string, pods = ''): Health =>
  runtime === 'docker' ? dockerHealth(stdout) : runtime === 'compose' ? composeHealth(stdout) : runtime === 'kubernetes' ? kubernetesHealth(stdout, pods) : UNKNOWN

/** How a log file stands: nothing says whether the process behind it runs, only when it last wrote. */
export const fileHealth = (mtimeMs: number | undefined, now: number): Health => {
  if (mtimeMs === undefined) return { state: 'down', detail: 'no such file', restarts: 0 }

  const quiet = Math.max(0, Math.round((now - mtimeMs) / 1000))

  return quiet < 120 ? { state: 'up', detail: `wrote ${quiet}s ago`, restarts: 0 } : { state: 'unknown', detail: `quiet for ${Math.round(quiet / 60)}m`, restarts: 0 }
}

const variable = (name: string, value: string, from: string): EnvVar => ({ name, value: redactVar(name, value), from })

// `docker inspect` lists the container's environment as `NAME=value`
const dockerEnv = (stdout: string): EnvVar[] =>
  list(record(record(list(parsed(stdout))[0]).Config).Env)
    .map(word)
    .filter(entry => entry.includes('='))
    .map(entry => variable(entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1), 'container'))

// A pod's own spec, or the one a workload makes its pods from
const podSpec = (object: Json): Json => (object.kind === 'Pod' ? record(object.spec) : record(record(record(object.spec).template).spec))

// Where a variable of a workload's spec takes its value from, when the spec does not write it
const sourceOf = (from: Json): string => {
  const [secret, config, field, resource] = [record(from.secretKeyRef), record(from.configMapKeyRef), record(from.fieldRef), record(from.resourceFieldRef)]

  if (word(secret.name) !== '') return `secret ${word(secret.name)}/${word(secret.key)}`
  if (word(config.name) !== '') return `config map ${word(config.name)}/${word(config.key)}`
  if (word(field.fieldPath) !== '') return `field ${word(field.fieldPath)}`
  if (word(resource.resource) !== '') return `resource ${word(resource.resource)}`

  return 'spec'
}

// A workload's spec names each variable, or where its value comes from: what a secret holds is never asked for
const kubernetesEnv = (stdout: string): EnvVar[] => {
  const containers = list(podSpec(record(parsed(stdout))).containers).map(record)

  return containers.flatMap(container => {
    const where = containers.length > 1 ? `${word(container.name)}: ` : ''
    const named = list(container.env).map(record).map(entry => variable(word(entry.name), word(entry.value), `${where}${sourceOf(record(entry.valueFrom))}`))

    const whole = list(container.envFrom).map(record).map(entry => {
      const secret = word(record(entry.secretRef).name)
      const holder = secret !== '' ? `secret ${secret}` : `config map ${word(record(entry.configMapRef).name)}`

      return { name: `${word(entry.prefix)}*`, value: '', from: `${where}every key of ${holder}` }
    })

    return [...named, ...whole]
  })
}

/**
 * The environment the status command's answer names: a container's own, a workload's as its spec sets it.
 * `undefined` for a runtime whose status says nothing of it.
 */
export const readEnv = (runtime: RuntimeId, stdout: string): EnvVar[] | undefined =>
  runtime === 'docker' ? dockerEnv(stdout) : runtime === 'kubernetes' ? kubernetesEnv(stdout) : undefined

/** A compose service's environment, read off `docker compose config --format json`: its env files resolved. */
export const composeEnv = (stdout: string, service: string): EnvVar[] =>
  Object.entries(record(record(record(record(parsed(stdout)).services)[service]).environment)).map(([name, value]) =>
    variable(name, value === null || value === undefined ? '' : String(value), 'compose'),
  )

/** What each runtime's environment is read from, said with the list. */
export const ENV_NOTE: Record<Exclude<RuntimeId, 'local'>, string> = {
  docker: "The container's own environment, as Docker holds it.",
  compose: "The service's environment as compose resolves it, its env files included.",
  kubernetes: "The workload's spec. What a secret or a config map holds is not read: only that the value comes from it.",
}

/** What a container, a pod or a process consumes; -1 and 0 where the runtime does not say. */
export type Measure = { cpu: number; memory: number; limit: number; processes: number }

const KILO = 1024

const UNIT: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1e3,
  kb: 1e3,
  m: 1e6,
  mb: 1e6,
  g: 1e9,
  gb: 1e9,
  t: 1e12,
  tb: 1e12,
  ki: KILO,
  kib: KILO,
  mi: KILO ** 2,
  mib: KILO ** 2,
  gi: KILO ** 3,
  gib: KILO ** 3,
  ti: KILO ** 4,
  tib: KILO ** 4,
}

/** A size as Docker and Kubernetes write it (`45.3MiB`, `512Mi`, `1.2GB`), in bytes; -1 when it does not read. */
export const bytesOf = (text: string): number => {
  const found = /^\s*([\d.]+)\s*([A-Za-z]*)/.exec(text)
  const unit = UNIT[(found?.[2] ?? '').toLowerCase()]

  return found === null || unit === undefined ? -1 : Math.round(Number(found[1]) * unit)
}

/** Several measures as one: an app of three replicas consumes what the three do. */
export const summed = (measures: readonly Measure[]): Measure | undefined =>
  measures.length === 0
    ? undefined
    : measures.reduce((sum, measure) => ({
        cpu: Math.max(0, sum.cpu) + Math.max(0, measure.cpu),
        memory: Math.max(0, sum.memory) + Math.max(0, measure.memory),
        limit: sum.limit + measure.limit,
        processes: sum.processes + measure.processes,
      }))

/** The containers behind an attachment, by the names `docker stats` knows them by. */
export const containersOf = ({ runtime, ref }: Attachment, stdout: string): string[] => {
  if (runtime === 'docker') return [ref]
  if (runtime !== 'compose') return []

  return composeRows(stdout)
    .filter(row => row.State === 'running')
    .map(row => word(row.Name))
    .filter(name => name !== '')
}

/** Asks Docker what the containers consume right now, one JSON object per line. */
export const statsArgv = (containers: readonly string[]): readonly string[] => ['docker', 'stats', '--no-stream', '--format', '{{json .}}', ...containers]

/** What `docker stats` printed, by container name. A container with no limit is given the machine's memory as one. */
export const readStats = (stdout: string): Record<string, Measure> =>
  Object.fromEntries(
    stdout
      .split('\n')
      .map(line => record(parsed(line)))
      .filter(row => word(row.Name) !== '')
      .map(row => {
        const [held = '', limit = ''] = word(row.MemUsage).split('/')
        const cpu = Number.parseFloat(word(row.CPUPerc))

        return [word(row.Name), { cpu: Number.isFinite(cpu) ? cpu : -1, memory: bytesOf(held), limit: Math.max(0, bytesOf(limit)), processes: 1 }] as const
      }),
  )

/**
 * Asks the cluster's metrics what the workload's pods consume: the pod itself, or the pods its selector matches.
 * Read off what the status command printed; `undefined` when that names neither.
 */
export const topArgv = ({ ref }: Attachment, stdout: string): readonly string[] | undefined => {
  const workload = workloadOf(ref)
  const object = record(parsed(stdout))

  if (workload === undefined || word(object.kind) === '') return undefined

  const base = ['kubectl', ...workload.context, 'top', 'pod', '-n', workload.namespace, '--no-headers']

  if (object.kind === 'Pod') return [...base, workload.target.slice(workload.target.indexOf('/') + 1)]

  const labels = selectorOf(stdout)

  return labels === '' ? undefined : [...base, '-l', labels]
}

const CORES: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1 }

// Processor time as Kubernetes writes it, in percent of one core: `250m` a quarter of a core, `2` two cores
const coresPercent = (text: string): number => {
  const found = /^([\d.]+)([num]?)$/.exec(text)

  return found === null ? -1 : Math.round(Number(found[1]) * (CORES[found[2] ?? ''] ?? 1) * 1000) / 10
}

/**
 * What `kubectl top pod --no-headers` printed, the pods as one, each allowed the memory the status command's
 * answer limits its containers to.
 */
export const readTop = (stdout: string, status: string): Measure | undefined => {
  const limit = list(podSpec(record(parsed(status))).containers)
    .map(container => bytesOf(word(record(record(record(container).resources).limits).memory)))
    .reduce((sum, bytes) => sum + Math.max(0, bytes), 0)

  return summed(
    stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(cells => cells.length >= 3)
      .map(([, cpu = '', memory = '']) => ({ cpu: coresPercent(cpu), memory: bytesOf(memory), limit, processes: 1 })),
  )
}

/**
 * The images an attachment runs, read off what its status command printed: a container's, each container's of a
 * compose service, each container's of a workload's pods. What a thing is (a broker, say) is told by them.
 */
export const imagesOf = (runtime: RuntimeId, stdout: string): string[] => {
  if (runtime === 'docker') return [word(record(record(list(parsed(stdout))[0]).Config).Image)].filter(image => image !== '')
  if (runtime === 'compose') return composeRows(stdout).map(row => word(row.Image)).filter(image => image !== '')
  if (runtime === 'kubernetes') return list(podSpec(record(parsed(stdout))).containers).map(container => word(record(container).image)).filter(image => image !== '')

  return []
}

/**
 * The command that runs `argv` inside the attachment and prints what it printed: only ever a command that reads.
 * `undefined` for what has no inside to run it in: a log file.
 */
export const execArgv = ({ runtime, ref }: Attachment, argv: readonly string[]): readonly string[] | undefined => {
  if (runtime === 'docker') return ['docker', 'exec', ref, ...argv]
  if (runtime === 'compose') return ['docker', 'compose', 'exec', '-T', ref, ...argv]

  if (runtime === 'kubernetes') {
    const workload = workloadOf(ref)

    return workload === undefined ? undefined : ['kubectl', ...workload.context, 'exec', '-n', workload.namespace, workload.target, '--', ...argv]
  }

  return undefined
}
