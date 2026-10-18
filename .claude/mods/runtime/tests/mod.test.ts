import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { composeAttachments, editedBetween, parseList, routed } from '../hooks/attach'
import { brokerKind, kindOf, matching, peekArgv, readGroups, readRecords, readTopics, settleBroker, standing, stuckFor } from '../hooks/broker'
import { askPrompt, byApp, byState, isPostgres, querySql, psqlArgv, readHolds, readRows, rowsSql, settleDatabase, sizeText } from '../hooks/database'
import { fixPrompt, planned, verdictOf } from '../hooks/e2e'
import { absorb, EMPTY_WATCH, fresh, read, redact, signatureOf } from '../hooks/lines'
import { localUsage, readEnvFile, readWindowsProbe } from '../hooks/local'
import { rendersSinceText } from '../hooks/report'
import { previousArgvs, readHealth } from '../hooks/runtime'
import { casesOf, endedSuite, plannedSuites, suitesOf, suiteTree, unitText } from '../hooks/unit'
import { isClimbing, quieted, recorded, spark, traceOf, traceSummary } from '../hooks/trace'
import { causesOf } from '../hooks/errors'
import { statusText, timeline } from '../hooks/report'
import { marked, settle, takePrinted } from '../hooks/watch'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PANE = { bodyColumns: 120 } as const
const CWD = '/home/dev/app'
const NOW = Date.parse('2026-10-13T10:00:30Z')

const at = (second: number) => `2026-10-13T10:00:${String(second).padStart(2, '0')}.000000000Z`

type World = {
  /** Files by absolute path: a compose file, the project's list, a log file. */
  files: Record<string, string>
  /** What `docker compose config` names: each service and the folder it is built from. */
  services: Record<string, string>
  /** The stamped lines each thing has written, by compose service, container or Kubernetes workload. */
  logs: Record<string, string[]>
  /** What a container writes to its standard error. */
  stderr: Record<string, string[]>
  /** What each status command prints, by the same names; a compose service is running when it has none. */
  status: Record<string, string>
  /** What compose resolves each service's environment to. */
  env: Record<string, Record<string, string>>
  /** What `docker stats` says of each container, by its name. */
  stats: Record<string, { CPUPerc: string; MemUsage: string }>
  /** What `kubectl top pod` prints; the cluster has no metrics when it is empty. */
  top: string
  /** What `lsof` and `ps` print: who listens, and every process. */
  listening: string
  processes: string
  /** What the script that asks the browser's tabs prints; node is not found when it is empty. */
  browser: string
  /** What a broker's `rpk` prints inside it, by the two words after `rpk`: `topic describe`, `group describe`, `topic consume`. */
  rpk: Record<string, string>
  /** What a database's `psql` prints inside it: `holds` for what it holds, `rows` for the rows of a table. */
  psql: Record<string, string>
  /** The folder the session says it is in: it follows the shell. */
  cwd: string
  /** What git lists as differing from what is committed; the project is no repository when there is none. */
  dirty?: string[]
  /** The commit the working tree stands on, and the files the last move to another one touched. */
  head: string
  moved: string[]
  /** When each file was last written, by absolute path; two seconds ago where none is said. */
  mtimes: Record<string, number>
}

const exited = (exitCode: number, stdout = '', stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never

// The lines a runtime hands over for a window: the last `--tail` of them, or those from `--since` on
const windowed = (lines: string[], argv: readonly string[]) => {
  const since = argv[argv.indexOf('--since') + 1] ?? argv.find(arg => arg.startsWith('--since-time='))?.slice('--since-time='.length)
  const isSince = argv.includes('--since') || argv.some(arg => arg.startsWith('--since-time='))

  return (isSince ? lines.filter(line => line.slice(0, 30) >= (since ?? '')) : lines).join('\n')
}

// A path as the tests write it, however the host spells it
const plain = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

/** Stands for the machine beneath the mod: its files, and what `docker` and `kubectl` answer. */
const machine = (on: On, given: Partial<World> = {}) => {
  // A copy: a test that has an app write more leaves the next test's world as given
  const world: World = { files: {}, services: {}, logs: {}, stderr: {}, status: {}, env: {}, stats: {}, top: '', listening: '', processes: '', browser: '', rpk: {}, psql: {}, cwd: CWD, head: 'c0ffee', moved: [], mtimes: {}, ...(JSON.parse(JSON.stringify(given)) as Partial<World>) }
  const runs: string[] = []
  const toasts: string[] = []

  mock.clock(on, { now: NOW })
  on('session.cwd', () => ({ value: world.cwd }) as never)
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))

    return { value: undefined } as never
  })
  on('fs.exists', (_, e) => ({ value: plain(e.path) in world.files }) as never)
  // The engine itself refuses a file over four mebibytes, whatever stands beneath it
  on('fs.read', (_, e) => ({ value: world.files[plain(e.path)] }) as never)
  on('fs.stat', (_, e) => ({ value: { kind: plain(e.path) in world.files || plain(e.path) in world.mtimes ? 'file' : 'other', size: 0, mtimeMs: world.mtimes[plain(e.path)] ?? NOW - 2000, isLink: false } }) as never)
  on('process.run', (_, e) => {
    const argv = e.argv
    const line = argv.join(' ')
    const name = argv[argv.length - 1] ?? ''

    runs.push(line)

    if (argv.includes('rpk')) {
      const asked = argv.slice(argv.indexOf('rpk') + 1, argv.indexOf('rpk') + 3).join(' ')

      return asked in world.rpk ? exited(0, world.rpk[asked]) : exited(1, '', 'unable to dial: connection refused')
    }

    if (argv.some(arg => arg.startsWith('exec psql '))) {
      const asked = name.startsWith('SELECT row_to_json') ? 'rows' : 'holds'

      return asked in world.psql ? exited(0, world.psql[asked]) : exited(2, '', 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed')
    }

    if (line.startsWith('docker compose config')) {
      const services = Object.fromEntries(
        Object.entries(world.services).map(([service, context]) => [service, { ...(context === '' ? { image: service } : { build: { context } }), environment: world.env[service] ?? {} }]),
      )

      return exited(0, JSON.stringify({ name: 'app', services }))
    }

    if (line.startsWith('docker compose logs')) return exited(0, windowed(world.logs[name] ?? [], argv))
    if (line.startsWith('docker compose ps')) return exited(0, world.status[name] ?? JSON.stringify({ Service: name, Name: `app-${name}-1`, State: 'running', Health: '', ExitCode: 0 }))
    if (line.startsWith('docker logs')) return exited(0, windowed(world.logs[name] ?? [], argv), windowed(world.stderr[name] ?? [], argv))
    if (line.startsWith('docker inspect')) return name in world.status ? exited(0, world.status[name]) : exited(1, '', `Error: No such object: ${name}`)

    if (line.startsWith('docker stats')) {
      return exited(0, argv.filter(container => container in world.stats).map(container => JSON.stringify({ Name: container, ...world.stats[container] })).join('\n'))
    }

    if (argv[0] === 'lsof') return exited(0, world.listening)
    if (argv[0] === 'tail') return exited(0, (world.files[plain(name)] ?? '').slice(-Number(argv[2])))
    if (argv[0] === 'node' && world.browser !== '') return exited(0, world.browser)
    if (argv[0] === 'ps') return exited(0, world.processes)
    if (argv[0] === 'kubectl' && argv.includes('top')) return world.top === '' ? exited(1, '', 'error: Metrics API not available') : exited(0, world.top)

    if (argv[0] === 'git') {
      if (world.dirty === undefined) return exited(128, '', 'fatal: not a git repository')

      return exited(0, argv[1] === 'ls-files' ? world.dirty.join('\0') : argv[1] === 'rev-parse' ? world.head : world.moved.join('\0'))
    }

    // A workload's pods, asked by what they are labelled with: their listing, and what they all wrote
    if (argv[0] === 'kubectl' && argv.includes('-l')) {
      const selected = `-l ${argv[argv.indexOf('-l') + 1]}`

      return argv.includes('logs') ? exited(0, windowed(world.logs[selected] ?? [], argv)) : exited(0, world.status[selected] ?? '{"items":[]}')
    }

    if (argv[0] === 'kubectl' && argv.includes('--previous')) return exited(0, windowed(world.logs[`previous ${argv.find(arg => arg.startsWith('pod/'))}`] ?? [], argv))

    if (argv[0] === 'kubectl') {
      const workload = argv.find(arg => /^\w+\/[\w-]+$/.test(arg)) ?? ''

      return argv.includes('logs') ? exited(0, windowed(world.logs[workload] ?? [], argv)) : exited(0, world.status[workload] ?? '{}')
    }

    return exited(127, '', `${argv[0]}: not found`)
  })

  return { world, runs, toasts }
}

const SHOP: Partial<World> = {
  files: { [`${CWD}/compose.yaml`]: 'services: {}' },
  services: { api: `${CWD}/api`, web: `${CWD}/web`, kafka: '' },
  logs: {
    api: [`${at(1)} {"level":"info","msg":"listening on 8080"}`, `${at(3)} {"level":"error","msg":"connect ECONNREFUSED 10.0.0.7:5432"}`],
    web: [`${at(2)} GET /cart 200 in 14ms`, `${at(4)} level=warn msg="slow render" route=/cart ms=912`],
    kafka: [`${at(5)} [2026-10-13 10:00:05,000] INFO [GroupCoordinator 1]: Stabilized group cart`],
  },
}

const mount = ($: Engine) => $.ui.mount({ plugin: 'runtime', surface: 'terminal', component: 'Pane', props: PANE as never, requestId: 'runtime' })

const ask = async ($: Engine, tool: string, input: Record<string, unknown> = {}) =>
  String((await $.tool.call({ tool: `mcp__runtime__${tool}`, ...input } as never)).result)

const edit = ($: Engine, path: string) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } as never)

// The Edit tool itself, beneath the mod: every edit goes through
const letEditsThrough = (on: On) => on('tool.call', { tool: 'Edit' }, (_, e) => ({ result: { filePath: e.file_path } }) as never)

describe('runtime', () => {
  test('says how to attach where nothing is, and asks Docker nothing without a compose file', async ($, on) => {
    const { runs } = machine(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /nothing attached/ })).toBeDefined()
    expect(await pane.find({ text: /name anything else in \.claude\/runtime/ })).toBeDefined()
    expect(runs).toHaveLength(0)
  })

  test("watches a compose project's services as one timeline", async ($, on) => {
    machine(on, SHOP)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /3 watched · 0 down · 0 new errors/ })).toBeDefined()
    expect(await pane.find({ text: /\[api\] listening on 8080/ })).toBeDefined()
    expect(await pane.find({ text: /\[web\] slow render route=\/cart ms=912/ })).toBeDefined()
    expect(await pane.find({ text: /\[kafka\] .*Stabilized group cart/ })).toBeDefined()

    // The lines of every service in the order they were written, whichever service was read first
    const text = await ask($, 'logs')
    const order = ['listening on 8080', 'GET /cart', 'ECONNREFUSED', 'slow render', 'Stabilized'].map(part => text.indexOf(part))

    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(place => place >= 0)).toBe(true)
  })

  test('shows one attachment, or the errors alone, when asked', async ($, on) => {
    machine(on, SHOP)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'show-web' })

    expect(await pane.find({ text: /GET \/cart 200/ })).toBeDefined()
    expect(await pane.find({ text: /listening on 8080/ })).toBeUndefined()

    await pane.press({ key: 'show-all' })
    await pane.press({ key: 'errors-only' })

    expect(await pane.find({ text: /ECONNREFUSED/ })).toBeDefined()
    expect(await pane.find({ text: /GET \/cart 200/ })).toBeUndefined()
  })

  test('takes only what was written since the last read', async ($, on) => {
    const { world, runs } = machine(on, SHOP)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    world.logs.api?.push(`${at(9)} {"level":"info","msg":"reconnected"}`)

    const text = await ask($, 'logs', { target: 'api' })

    expect(runs.filter(run => run.startsWith('docker compose logs') && run.endsWith(' api'))).toEqual([
      'docker compose logs --no-color --no-log-prefix --timestamps --tail 200 api',
      `docker compose logs --no-color --no-log-prefix --timestamps --since ${at(3)} api`,
    ])
    expect(text.match(/ECONNREFUSED/g)).toHaveLength(1)
    expect(text).toMatch(/reconnected/)
    expect(text).not.toMatch(/GET \/cart/)
  })

  test('reads a log that is cut back as it grows, or too large to read whole, no line twice and none missed', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const log = `${CWD}/logs/web.log`
    const { world } = machine(on, { files: { [log]: 'one\ntwo\nthree\n' } })

    expect(await ask($, 'logs')).toMatch(/one\n.*two\n.*three$/)

    // What writes it kept its last lines and wrote one more
    world.files[log] = 'two\nthree\nfour\n'
    expect((await ask($, 'logs')).match(/one|two|three|four/g)).toEqual(['one', 'two', 'three', 'four'])

    // Grown past what is read whole: its end is asked for, and holds the last line read
    world.files[log] = `${'filler\n'.repeat(700_000)}three\nfour\nfive\n`
    expect((await ask($, 'logs', { grep: 'f' })).match(/filler|four|five/g)).toEqual(['four', 'five'])

    // Cut back again, to where it is read whole
    world.files[log] = 'five\nsix\n'
    expect((await ask($, 'logs', { grep: 'i' })).match(/filler|five|six/g)).toEqual(['five', 'six'])
    expect(await ask($, 'status')).not.toMatch(/could not be read/)
  })

  test('tells the errors an edit brought from the ones that were there', async ($, on) => {
    const { world, toasts } = machine(on, SHOP)

    letEditsThrough(on)

    const edited = await edit($, `${CWD}/api/src/auth.ts`)

    // Said to the model once, with the first edit of a watched app
    expect(String(edited.context)).toMatch(/The runtime mod watches the running api, kafka/)

    world.logs.api?.push(`${at(12)} {"level":"error","msg":"TypeError: verify is not a function"}`, `${at(13)} {"level":"error","msg":"TypeError: verify is not a function"}`)

    const text = await ask($, 'errors_since_edit')

    expect(text).toMatch(/api: 1 new error since the edit to api\/src\/auth\.ts\./)
    expect(text).toMatch(/x2 TypeError: verify is not a function/)
    // What was already wrong before the edit is not its doing
    expect(text).not.toMatch(/ECONNREFUSED/)
    // An edit under api/ is none of web's; kafka has no folder of its own, so every edit of the project counts
    expect(text).toMatch(/web: no edit has been routed to it/)
    expect(text).toMatch(/kafka: no new error since the edit to api\/src\/auth\.ts\./)

    expect(toasts.filter(toast => /api has 1 new error since the edit to api\/src\/auth\.ts/.test(toast))).toHaveLength(1)

    // A second read says nothing twice
    await ask($, 'errors_since_edit')

    expect(toasts.filter(toast => /new error/.test(toast))).toHaveLength(1)
    expect((await edit($, `${CWD}/api/src/auth.ts`)).context).toBeUndefined()
  })

  test('counts nothing against the app for an edit outside the project', async ($, on) => {
    machine(on, SHOP)
    letEditsThrough(on)

    await edit($, '/home/dev/other-worktree/api/src/auth.ts')

    expect(await ask($, 'errors_since_edit', { target: 'kafka' })).toMatch(/kafka: no edit has been routed to it/)
  })

  test('answers the logs by level, by word and by attachment, secrets taken out', async ($, on) => {
    const { world } = machine(on, SHOP)

    world.logs.api?.push(`${at(6)} {"level":"info","msg":"calling billing with Authorization: Bearer abcdef0123456789 and password=hunter2"}`)

    expect(await ask($, 'logs', { level: 'warn' })).toMatch(/^\S+ \[api\] ERROR connect ECONNREFUSED.*\n\S+ \[web\] WARN {2}slow render/)
    expect(await ask($, 'logs', { grep: 'CART' })).not.toMatch(/listening/)
    expect(await ask($, 'logs', { target: 'db' })).toBe('No attachment is named db. They are: api, web, kafka.')

    const billing = await ask($, 'logs', { grep: 'billing' })

    expect(billing).toMatch(/calling billing/)
    expect(billing).not.toMatch(/abcdef0123456789|hunter2/)
  })

  test(
    'reads a container, a Kubernetes workload and a log file, each its own way',
    { options: { attachments: 'api=docker:shop-api@api; kafka=k8s:prod-eu/staging/statefulset/kafka; web=local:logs/web.log@web' } },
    async ($, on) => {
      const { runs, toasts } = machine(on, {
        files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n[error] Failed to resolve import "./Cart"\nhalf a li' },
        logs: { 'shop-api': [`${at(1)} started`], 'statefulset/kafka': [`${at(2)} [KafkaServer id=1] started`] },
        // A container hands its standard error over apart: both are its lines, put back in order
        stderr: { 'shop-api': [`${at(0)} WARNING: no config file, using defaults`] },
        status: {
          'shop-api': JSON.stringify([{ RestartCount: 3, State: { Status: 'exited', ExitCode: 137, OOMKilled: true } }]),
          'statefulset/kafka': JSON.stringify({ kind: 'StatefulSet', spec: { replicas: 3 }, status: { readyReplicas: 2 } }),
        },
      })

      const status = await ask($, 'status')

      expect(status).toMatch(/^api \(Docker shop-api\): down, OOMKilled; 3 restarts; no error/m)
      expect(status).toMatch(/^kafka \(Kubernetes prod-eu\/staging\/statefulset\/kafka\): degraded, 2\/3 ready/m)
      expect(status).toMatch(/^web \(local \/home\/dev\/app\/logs\/web\.log\): up, wrote 2s ago; 1 error of 1 kind/m)

      expect(runs).toContain('docker logs --timestamps --tail 200 shop-api')
      expect(runs).toContain('kubectl --context prod-eu logs statefulset/kafka -n staging --timestamps --all-containers --tail=200')
      expect(runs).toContain('kubectl --context prod-eu get statefulset/kafka -n staging -o json')

      const logs = await ask($, 'logs')

      expect(logs.indexOf('no config file')).toBeLessThan(logs.indexOf('[api] INFO  started'))
      expect(logs).toMatch(/\[web\] ERROR \[error\] Failed to resolve import/)
      // A line still being written waits for its end
      expect(logs).not.toMatch(/half a li/)

      expect(toasts.filter(toast => toast === 'runtime: api is down (OOMKilled)')).toHaveLength(1)
    },
  )

  const KAFKA = {
    kind: 'StatefulSet',
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'kafka' } },
      template: {
        spec: {
          containers: [
            {
              name: 'kafka',
              resources: { limits: { memory: '1Gi' } },
              env: [{ name: 'KAFKA_HEAP_OPTS', value: '-Xmx512m' }, { name: 'SASL_PASSWORD', valueFrom: { secretKeyRef: { name: 'kafka', key: 'password' } } }],
              envFrom: [{ configMapRef: { name: 'kafka-config' } }],
            },
          ],
        },
      },
    },
    status: { readyReplicas: 2 },
  }

  const THREE_WAYS = {
    options: { attachments: 'api=docker:shop-api@api; kafka=k8s:prod-eu/staging/statefulset/kafka; web=local:logs/web.log@web#3000; cron=local:logs/cron.log' },
  }

  const threeWays = (): Partial<World> => ({
    files: {
      [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n',
      [`${CWD}/logs/cron.log`]: 'tick\n',
      [`${CWD}/web/.env`]: '# the shop\nVITE_API_URL=http://localhost:8080\nexport SESSION_SECRET="abc def"\n',
      [`${CWD}/web/.env.local`]: 'VITE_API_URL=http://localhost:9090 # mine\n',
    },
    status: {
      'shop-api': JSON.stringify([
        { RestartCount: 0, State: { Status: 'running' }, Config: { Env: ['NODE_ENV=production', 'DATABASE_URL=postgres://shop:s3cr3t@db:5432/shop', 'STRIPE_SECRET_KEY=sk_live_123'] } },
      ]),
      'statefulset/kafka': JSON.stringify(KAFKA),
    },
    stats: { 'shop-api': { CPUPerc: '12.34%', MemUsage: '256MiB / 1GiB' } },
    top: 'kafka-0   250m   512Mi\nkafka-1   150m   256Mi\n',
    // The dev server listens from one process and answers from a child of it
    listening: 'p4100\nf21\nn127.0.0.1:3000\np77\nf3\nn*:5432\n',
    processes: ' 4100     1  51200   0:01.50\n 4101  4100 102400   0:03.00\n   77     1 999999   9:00.00\n',
  })

  test('says what each app consumes, measured the way its runtime allows', THREE_WAYS, async ($, on) => {
    const { runs } = machine(on, threeWays())
    const text = await ask($, 'resources')

    expect(text).toMatch(/^api: cpu 12% of one core, memory 256 MB \/ 1\.0 GB$/m)
    // Two pods as one, each allowed what the spec limits its container to
    expect(text).toMatch(/^kafka: cpu 40% of one core, memory 768 MB \/ 2\.0 GB, across 2 processes$/m)
    // The listener and the process it started; a processor share takes two reads
    expect(text).toMatch(/^web: cpu not measured yet .*, memory 150 MB, across 2 processes$/m)
    expect(text).toMatch(/^cron: no port named: end its line in \.claude\/runtime with #<port>$/m)

    expect(runs).toContain('docker stats --no-stream --format {{json .}} shop-api')
    expect(runs).toContain('kubectl --context prod-eu top pod -n staging --no-headers -l app=kafka')

    expect(await ask($, 'status')).toMatch(/^api \(Docker shop-api\): up, running; .*; cpu 12% of one core, memory 256 MB \/ 1\.0 GB$/m)

    const pane = await mount($)

    expect(await pane.find({ text: /256 MB \/ 1\.0 GB/ })).toBeDefined()
  })

  test('says why what an app consumes is not known', { options: { attachments: 'kafka=k8s:staging/statefulset/kafka; web=local:logs/web.log#3000' } }, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: 'ready\n' }, status: { 'statefulset/kafka': JSON.stringify(KAFKA) } })

    const text = await ask($, 'resources')

    expect(text).toMatch(/^kafka: error: Metrics API not available$/m)
    expect(text).toMatch(/^web: nothing listens on 3000$/m)
  })

  test('shows each environment with where it is set, secrets taken out', THREE_WAYS, async ($, on) => {
    machine(on, threeWays())

    const text = await ask($, 'env')

    expect(text).toMatch(/^api: 3 variables\. The container's own environment/m)
    expect(text).toMatch(/^ {2}NODE_ENV=production \(container\)$/m)
    expect(text).toMatch(/^ {2}DATABASE_URL=postgres:\/\/shop:\*\*\*@db:5432\/shop \(container\)$/m)
    expect(text).toMatch(/^ {2}STRIPE_SECRET_KEY=\*\*\* \(container\)$/m)
    // A value kept in a secret is never asked of the cluster: only where it comes from is said
    expect(text).toMatch(/^ {2}KAFKA_HEAP_OPTS=-Xmx512m \(spec\)$/m)
    expect(text).toMatch(/^ {2}SASL_PASSWORD= \(secret kafka\/password\)$/m)
    expect(text).toMatch(/^ {2}\*= \(every key of config map kafka-config\)$/m)
    // A later env file's value takes the place of an earlier one's
    expect(text).toMatch(/^ {2}VITE_API_URL=http:\/\/localhost:9090 \(web\/\.env\.local\)$/m)
    expect(text).toMatch(/^ {2}SESSION_SECRET=\*\*\* \(web\/\.env\)$/m)
    expect(text).toMatch(/^cron: 0 variables\. .*cannot be read from outside it\. No env file under the working directory\.$/m)
    expect(text).not.toMatch(/s3cr3t|sk_live|abc def/)

    expect(await ask($, 'env', { target: 'api', grep: 'node' })).toMatch(/^api: 1 variable of 3 named like node\..*\n {2}NODE_ENV=production \(container\)$/)

    const pane = await mount($)

    await pane.press({ key: 'view-env' })
    await pane.press({ key: 'show-web' })

    expect(await pane.find({ text: /VITE_API_URL/ })).toBeDefined()
    expect(await pane.find({ text: /web\/\.env\.local/ })).toBeDefined()
    expect(await pane.find({ text: /NODE_ENV/ })).toBeUndefined()
  })

  test("reads a compose service's environment as compose resolves it", async ($, on) => {
    machine(on, { ...SHOP, env: { api: { PORT: '8080', API_TOKEN: 'tok-1234' } }, stats: { 'app-api-1': { CPUPerc: '1.50%', MemUsage: '64MiB / 8GiB' } } })

    expect(await ask($, 'env', { target: 'api' })).toMatch(/^api: 2 variables\. The service's environment as compose resolves it.*\n {2}PORT=8080 \(compose\)\n {2}API_TOKEN=\*\*\* \(compose\)$/)
    expect(await ask($, 'resources', { target: 'api' })).toBe('api: cpu 1.5% of one core, memory 64 MB / 8.0 GB')
  })

  test('counts why the components of a frontend rendered, chain by chain', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const render = (component: string, chain: string[], count: number) => JSON.stringify({ level: 20, time: NOW - 1000, msg: 'render', runtime: 'render', component, chain, count })
    const lit = ['beacons (ref) set', 'litCount (computed)', 'BeaconChain']
    const { world } = machine(on, {
      files: { [`${CWD}/logs/web.log`]: `vite ready in 310 ms\n${render('BeaconChain', lit, 3)}\n${render('Lamp', [...lit, 'prop lit', 'Lamp'], 1)}\n` },
    })

    expect(await ask($, 'renders')).toMatch(/^web: 4 renders in 2 chains\.\n {2}x3 last \S+ beacons \(ref\) set -> litCount \(computed\) -> BeaconChain\n {2}x1 last \S+ beacons .* -> BeaconChain -> prop lit -> Lamp$/)

    world.files[`${CWD}/logs/web.log`] += `${render('BeaconChain', lit, 2)}\n`

    expect(await ask($, 'renders', { component: 'chain' })).toMatch(/^web: 5 renders in 1 chain\.\n {2}x5 /)
    expect(await ask($, 'renders', { component: 'cart' })).toBe('No render of a component named like cart has been reported.')
    // A render is no line of the timeline
    expect(await ask($, 'logs')).not.toMatch(/litCount|render/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })

    // A tree under each component of the app: what changed, a step a row, down to the component that rendered
    const drawn = await ask($, 'pane')

    expect(drawn).toMatch(/BeaconChain {2}×5\n\s*└─ beacons \(ref\) set\n\s*└─ litCount \(computed\)\n\s*└─ BeaconChain {2}×5\n\s*Lamp {2}×1\n\s*└─ beacons \(ref\) set\n\s*└─ litCount \(computed\)\n\s*└─ BeaconChain\n\s*└─ prop lit\n\s*└─ Lamp {2}×1/)
    expect(drawn).not.toMatch(/vite ready/)
  })

  test('says the value each state and prop of a chain held, the last one said', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const render = (chain: string[], values: (string | null)[]) => JSON.stringify({ level: 20, time: NOW - 1000, runtime: 'render', component: 'Lamp', chain, values, count: 1 })
    const chain = ['beacons (ref) set', 'litCount (computed)', 'apiToken (ref) set', 'prop lit', 'Lamp']
    const { world } = machine(on, { files: { [`${CWD}/logs/web.log`]: `${render(chain, ['[7] (was [6])', '2', '"tok-1234"', 'false (was true)', null])}\n` } })

    expect(await ask($, 'renders')).toMatch(/beacons \(ref\) set: \[7\] \(was \[6\]\) -> litCount \(computed\): 2 -> apiToken \(ref\) set: \*\*\* -> prop lit: false \(was true\) -> Lamp$/)

    // A later line says the count anew and no value for the ref: the one held stays
    world.files[`${CWD}/logs/web.log`] += `${render(chain, [null, '3', null, 'true (was false)', null])}\n`

    expect(await ask($, 'renders')).toMatch(/x2 last \S+ beacons \(ref\) set: \[7\] \(was \[6\]\) -> litCount \(computed\): 3 /)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })

    // The value a step held is last on its row; a count is said where it is not the one of the row above
    expect(await ask($, 'pane')).toMatch(
      /Lamp {2}×2\n\s*└─ beacons \(ref\) set {2}= \[7\] \(was \[6\]\)\n\s*└─ litCount \(computed\) {2}= 3\n\s*└─ apiToken \(ref\) set {2}= \*\*\*\n\s*└─ prop lit {2}= true \(was false\)\n\s*└─ Lamp {2}×2/,
    )
  })

  test('opens a row on the whole of a value its line cuts short, as formatted JSON', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const whole = JSON.stringify([{ beacon: 'amon-din', lit: true }, { beacon: 'eilenach', lit: false, apiToken: 'tok-1234' }])
    const line = JSON.stringify({
      runtime: 'render',
      component: 'BeaconChain',
      chain: ['beacons (computed)', 'litCount (computed)', 'BeaconChain'],
      values: ['[{beacon: "amon-din", lit: true}, {…}]', '1', null],
      whole: [whole, null, null],
      count: 1,
    })

    machine(on, { files: { [`${CWD}/logs/web.log`]: `${line}\n` } })

    // The tool says the short value alone
    expect(await ask($, 'renders')).toMatch(/beacons \(computed\): \[\{beacon: "amon-din", lit: true\}, \{…\}\] -> litCount \(computed\): 1 -> BeaconChain$/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })

    // The one row that holds more than it shows is marked, and closed
    const closed = await ask($, 'pane')

    expect(closed).toMatch(/BeaconChain {2}×1\n\s*\[└─ ▸ beacons \(computed\) {2}= \[\{beacon: "amon-din", lit: true\}, \{…\}\]\]\n\s*└─ litCount \(computed\) {2}= 1\n\s*└─ BeaconChain {2}×1/)
    expect(closed).not.toMatch(/eilenach/)

    await pane.press({ key: 'value-0' })

    // Open, the value is under its row, indented as JSON, a secret in it taken out
    const open = await ask($, 'pane')

    expect(open).toMatch(/▾ beacons \(computed\) {2}= .*\]\n[│\s]*\[\n[│\s]*\{\n[│\s]*"beacon": "amon-din",\n[│\s]*"lit": true\n[│\s]*\},/)
    expect(open).toMatch(/"apiToken": "\*\*\*"/)
    expect(open).toMatch(/\]\n\s*└─ litCount \(computed\) {2}= 1/)

    await pane.press({ key: 'value-0' })

    expect(await ask($, 'pane')).not.toMatch(/eilenach/)
  })

  test("shows the page a frontend last reported, its elements nested, in place of the tree", { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const page = (elements: unknown[], left = 0) => JSON.stringify({ level: 20, time: NOW - 1000, msg: 'page / drawn', runtime: 'dom', url: '/', title: 'Anor', elements, left })
    const drawn = [
      [0, 'body', '', '', ''],
      [1, 'div#__nuxt', '', '', ''],
      [2, 'main.grid', '', '', ''],
      [3, 'section.card', '', '', 'BeaconChain'],
      [4, 'h2', '', 'The beacons', ''],
      [4, 'button.lit', 'aria-label="Light Amon Dîn" aria-pressed="true" type="button"', 'Amon Dîn', ''],
      [3, 'form', '', '', 'MusterForm'],
      [4, 'input', 'name="apiToken" type="password"', '', ''],
    ]
    const { world } = machine(on, { files: { [`${CWD}/logs/web.log`]: `vite ready in 310 ms\n${page([[0, 'body', '', 'Loading', '']])}\n${page(drawn, 12)}\n` } })

    // A page is no line of the timeline
    expect(await ask($, 'logs')).not.toMatch(/drawn|runtime mod/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    expect(await ask($, 'pane')).toMatch(/\[t Renders\]\* {2}\[d DOM\] {2}\[a Actions\] {2}\[n Network\]\n\s*No render has been reported\./)

    await pane.press({ key: 'renders-dom' })

    // The last page said: an element that only holds the next is on its row, a component's outermost element named
    const shown = await ask($, 'pane')

    expect(shown).toMatch(/\[t Renders\] {2}\[d DOM\]\* {2}\[a Actions\] {2}\[n Network\]\n\s*Anor at \/, 8 elements, as it stood at \S+\n\s*body › div#__nuxt › main\.grid\n\s*├─ section\.card {2}<BeaconChain>\n\s*│  ├─ h2 {2}"The beacons"\n\s*│  └─ button\.lit {2}aria-label="Light Amon Dîn" aria-pressed="true" type="button" {2}"Amon Dîn"\n\s*└─ form {2}<MusterForm>\n\s*└─ input {2}name="apiToken" type="password"\n\s*12 more elements than a report holds are left out\./)
    expect(shown).not.toMatch(/Loading/)

    // The page changes: the next read shows it as it stands then
    world.files[`${CWD}/logs/web.log`] += `${page([[0, 'body', '', '', ''], [1, 'p', '', 'Gondor does not answer', '']])}\n`
    await pane.press({ key: 'refresh' })
    expect(await ask($, 'pane')).toMatch(/Anor at \/, 2 elements, as it stood at \S+\n\s*body › p {2}"Gondor does not answer"/)

    await pane.press({ key: 'renders-tree' })
    expect(await ask($, 'pane')).toMatch(/\[t Renders\]\* {2}\[d DOM\]/)
  })

  test('says how a frontend reports its page where none has', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n' } })

    await ask($, 'logs')

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    await pane.press({ key: 'renders-dom' })
    expect(await ask($, 'pane')).toMatch(/\[t Renders\] {2}\[d DOM\]\* {2}\[a Actions\] {2}\[n Network\]\n\s*No page has been reported\.\n/)
  })
  test('says how a frontend reports its renders where none has', async ($, on) => {
    machine(on, SHOP)

    expect(await ask($, 'renders')).toMatch(/^No render has been reported\. Renders are read from the browser itself.*\nnode was not found/)
  })

  test("reads the renders and the page from the browser's own tabs, with nothing in the app's log", { options: { attachments: 'web=local:logs/web.log@web#3000; api=local:logs/api.log@api' } }, async ($, on) => {
    const page = (address: string, isVisible: boolean, count: number, heading: string) => ({
      label: 'web',
      address,
      isVisible,
      vue: '3.5.43',
      isDev: true,
      files: [`${CWD}/web/app.vue`],
      renders: [{ component: 'BeaconChain', chain: ['beacons (ref) set', 'apiToken (ref) set', 'BeaconChain'], values: ['[7] (was [6])', '"tok-1234"', null], whole: [null, null, null], count }],
      dom: { url: '/', title: 'Anor', elements: [[0, 'body', '', '', ''], [1, 'h1', '', heading, 'BeaconChain']], left: 0 },
    })
    const { world, runs } = machine(on, {
      files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n', [`${CWD}/logs/api.log`]: 'listening on 8080\n' },
      // Two tabs show the app, and one of a site that is none of the apps said nothing
      browser: JSON.stringify({ tabs: 3, pages: [page('http://localhost:3000/', true, 2, 'The stone'), page('http://localhost:3010/', false, 1, 'Behind')] }),
    })

    // The secret a step holds is taken out as it is from a log
    expect(await ask($, 'renders')).toMatch(/^web: 3 renders in 1 chain\.\n {2}x3 last \S+ beacons \(ref\) set: \[7\] \(was \[6\]\) -> apiToken \(ref\) set: \*\*\* -> BeaconChain$/)

    // The script is the mod's own, told the port and what each app is known by
    const asked = runs.find(run => run.startsWith('node ')) ?? ''

    expect(asked).toMatch(/\/browser\/ask\.mjs 9222 \[\{"label":"web","roots":\["\/home\/dev\/app\/web"\],"port":3000\}/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    expect(await ask($, 'pane')).toMatch(/web: read from the tab "Anor" at http:\/\/localhost:3010\/\n\s*web: read from the tab "Anor" at http:\/\/localhost:3000\//)
    expect(await pane.find({ text: /^beacons \(ref\) set/ })).toBeDefined()

    // The page kept is the one the person looks at
    await pane.press({ key: 'renders-dom' })
    expect(await pane.find({ text: /"The stone"/ })).toBeDefined()
    expect(await pane.find({ text: /"Behind"/ })).toBeUndefined()

    // An app none of whose tabs is open says so
    await pane.press({ key: 'show-api' })
    expect(await pane.find({ text: /No tab of the browser shows this app\./ })).toBeDefined()

    world.browser = JSON.stringify({ error: 'no-browser' })
    expect(await ask($, 'renders', { target: 'api' })).toMatch(/\nNo Chrome answers on 127\.0\.0\.1:9222\./)
  })

  test("says what rendered inside a library's component beside its own renders, not as chains of their own", { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const render = (chain: string[], count: number, inside: number) => JSON.stringify({ runtime: 'render', component: 'MusterForm', chain, count, inside })
    const { world } = machine(on, { files: { [`${CWD}/logs/web.log`]: `${render(['isAsking (ref) set', 'UCard', 'prop loading', 'UButton'], 1, 9)}\n${render(['a reactive object.$slots changed', 'UButton'], 0, 4)}\n` } })

    expect(await ask($, 'renders')).toMatch(/^web: 1 render in 2 chains\.\n {2}x1 \(\+9 inside\) last \S+ isAsking \(ref\) set -> UCard -> prop loading -> UButton\n {2}x0 \(\+4 inside\) last \S+ a reactive object\.\$slots changed -> UButton$/)

    world.files[`${CWD}/logs/web.log`] += `${render(['isAsking (ref) set', 'UCard', 'prop loading', 'UButton'], 1, 6)}\n`
    expect(await ask($, 'renders')).toMatch(/x2 \(\+15 inside\) last/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    expect(await ask($, 'pane')).toMatch(/UButton {2}×2 \+15 inside/)
    expect(await ask($, 'pane')).toMatch(/UButton {2}\+4 inside/)
  })

  test('asks no browser where the option says none', { options: { attachments: 'web=local:logs/web.log@web', browserPort: 0 } }, async ($, on) => {
    const { runs } = machine(on, { files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n' } })

    expect(await ask($, 'renders')).toMatch(/^No render has been reported\.[^\n]*$/)
    expect(runs.filter(run => run.startsWith('node '))).toHaveLength(0)
  })

  test('hands the model what the pane shows, as text', async ($, on) => {
    machine(on, SHOP)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    const text = await ask($, 'pane')

    expect(text).toMatch(/runtime {2}read \d\d:\d\d:\d\d/)
    expect(text).toMatch(/Apps on Compose\n[\s\S]*\[api\]\s+up · running\s+1/)
    expect(text).toMatch(/\[api\] connect ECONNREFUSED/)
    expect(text).toMatch(/\[r Refresh\]/)
  })

  test('says which renders came with nothing changed, and where each component is written', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const render = (count: number, held: string) => JSON.stringify({ runtime: 'render', component: 'Cart', file: `${CWD}/web/components/Cart.vue`, chain: ['useFetch data (ref) changed', 'Cart'], values: [held, null], count })
    const log = `${CWD}/logs/web.log`
    const { world } = machine(on, { files: { [log]: `${render(3, '[7]')}\n` } })

    // The first report has nothing to be held against
    expect(await ask($, 'renders')).toMatch(/^web: 3 renders in 1 chain\.\n {2}x3 last \S+ useFetch data \(ref\) changed: \[7\] -> Cart\n {2}written in:\n {4}Cart web\/components\/Cart\.vue$/)

    // Fetched again and the same: every render of that report could have been spared
    world.files[log] += `${render(4, '[7]')}\n`
    expect(await ask($, 'renders')).toMatch(/^web: 7 renders in 1 chain, 4 of them with nothing changed: .*\.\n {2}x7 \(4 with nothing changed\) last/)

    world.files[log] += `${render(2, '[8]')}\n`
    expect(await ask($, 'renders')).toMatch(/x9 \(4 with nothing changed\) last/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    expect(await ask($, 'pane')).toMatch(/Cart {2}×9 4 unchanged/)
  })

  test('says what an edit did to the renders: the chains it brought, the ones it ended, the ones that go on', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const render = (chain: string[], count: number) => JSON.stringify({ runtime: 'render', component: 'Cart', chain, count })
    const log = `${CWD}/logs/web.log`
    const { world } = machine(on, { files: { [log]: `${render(['items (ref) set', 'Cart'], 5)}\n${render(['total (computed)', 'Cart'], 2)}\n` } })

    letEditsThrough(on)
    expect(await ask($, 'renders_since_edit')).toMatch(/^web: no edit has been routed to it in this session\.$/)

    await edit($, `${CWD}/web/Cart.vue`)
    world.files[log] += `${render(['items (ref) set', 'Cart'], 1)}\n${render(['coupon (ref) set', 'Cart'], 3)}\n`

    const text = await ask($, 'renders_since_edit')

    expect(text).toMatch(/^web: 4 renders since the edit to web\/Cart\.vue, 0s ago; 7 before it\. Too soon after the edit for a rate/)
    expect(text).toMatch(/\n {2}new {3}x3 coupon \(ref\) set -> Cart\n {2}gone {2}x0 \(x2 before\) total \(computed\) -> Cart\n {2}still x1 items \(ref\) set -> Cart$/)
  })

  test('says how often a chain renders since an edit against before it', () => {
    const minute = 60_000
    const chain = (step: string, count: number) => ({ component: 'Cart', chain: [step, 'Cart'], count, lastAt: NOW, firstAt: NOW - 10 * minute, edit: 0, countAtEdit: 0 })
    const before = { ...EMPTY_WATCH, renders: [chain('items (ref) set', 100), chain('total (computed)', 20)] }
    // The edit came five minutes ago; since then one chain rendered a tenth as often, the other as often as before
    const { web } = marked({ web: before }, ['web'], 'web/Cart.vue', NOW - 5 * minute)
    const held = { web: { ...EMPTY_WATCH, ...web, renders: (web?.renders ?? []).map(render => ({ ...render, count: render.count + (render.chain[0] === 'items (ref) set' ? 10 : 20) })) } }
    const text = rendersSinceText([{ label: 'web', runtime: 'local', ref: 'logs/web.log', roots: [], port: 0 }], held, {}, NOW)

    expect(text).toMatch(/^web: 30 renders since the edit to web\/Cart\.vue, 5m ago; 120 before it\.\n {2}less {2}x10, 2\.0\/min \(was 20\/min\) items \(ref\) set -> Cart\n {2}same {2}x20, 4\.0\/min \(was 4\.0\/min\) total \(computed\) -> Cart$/)
  })

  test("follows what was done on a page to what rendered, what was asked and what every app wrote, and reads the page's console, requests and elements", { options: { attachments: 'web=local:logs/web.log@web#3000; api=local:logs/api.log@api' } }, async ($, on) => {
    const page = {
      label: 'web',
      address: 'http://localhost:3000/',
      isVisible: true,
      vue: '3.5.43',
      isDev: true,
      renders: [],
      // Done three seconds ago: what followed it is over
      actions: [{ at: NOW - 3000, kind: 'click', what: 'button "Light Halifirien"', component: 'BeaconChain', renders: { MusterForm: 1, BeaconChain: 8 }, requests: ['200 /api/realm/beacons 41ms'] }],
      requests: [
        { url: '/api/realm/beacons', status: 200, ms: 41, at: NOW - 2900 },
        { url: '/api/realm/beacons', status: 500, ms: 300, at: NOW - 2000 },
        { url: '/api/muster?rider', status: 0, ms: 12, at: NOW - 1000 },
      ],
      vitals: { loadedAt: NOW - 60_000, ttfb: 40, lcp: 310, load: 420, cls: 0.021, inp: 80, longTasks: 3, longMs: 240 },
      said: [
        { level: 'error', text: 'Uncaught TypeError: lamp is undefined', at: NOW - 2800, where: '/components/BeaconChain.vue:12' },
        { level: 'warn', text: '[Vue warn]: Hydration node mismatch', at: NOW - 20_000, where: '' },
      ],
      dom: {
        url: '/',
        title: 'Anor',
        elements: [[0, 'body', '', '', ''], [1, 'main', '', '', 'App'], [2, 'button.lamp', 'aria-pressed="true"', '', 'BeaconChain'], [1, 'footer', '', 'The stone', '']],
        left: 0,
        issues: [['a button with no name', 'button.lamp', 'BeaconChain']],
        files: { BeaconChain: `${CWD}/web/components/BeaconChain.vue` },
      },
    }
    const { world } = machine(on, {
      files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n', [`${CWD}/logs/api.log`]: '2026-10-13T10:00:27.500Z {"level":"error","msg":"beacon store unreachable"}\n' },
      browser: JSON.stringify({ tabs: 1, pages: [page] }),
    })

    const done = await ask($, 'interactions')

    // A page hands over what it counted once: the next asking finds it emptied
    world.browser = JSON.stringify({ tabs: 1, pages: [{ ...page, actions: [], requests: [], said: [] }] })

    expect(done).toMatch(/^web: the last 1 of 1 thing done on its page\.\n {2}\S+ click button "Light Halifirien" in BeaconChain\n {4}rendered: BeaconChain ×8, MusterForm ×1\n {4}asked: 200 \/api\/realm\/beacons 41ms\n {4}logged:\n/)
    // What the page's console held and what the backend wrote, in the order they came
    expect(done).toMatch(/\[web\] ERROR in the page: Uncaught TypeError: lamp is undefined at=\/components\/BeaconChain\.vue:12\n {6}\S+ \[api\] ERROR beacon store unreachable$/)
    expect(await ask($, 'interactions', { target: 'api' })).toMatch(/^Nothing done on a page has been seen yet\./)

    // The console's errors are the app's errors, its warnings lines of its timeline
    expect(await ask($, 'status')).toMatch(/^web \(.*; 1 error of 1 kind/)
    expect(await ask($, 'logs', { target: 'web', level: 'warn' })).toMatch(/WARN {2}in the page: \[Vue warn\]: Hydration node mismatch\n.*ERROR in the page: Uncaught TypeError/)

    expect(await ask($, 'network')).toMatch(
      /^web: 3 requests to 2 addresses\.\n {2}the page: loaded at \S+, first byte 40ms, largest paint 310ms, loaded in 420ms, layout shift 0\.021, slowest answer to a click or a key 80ms, 3 tasks over 50ms \(240ms in all\)\n {2}x2 avg 171ms max 300ms, 1 failed, last 500 at \S+ \/api\/realm\/beacons\n {2}x1 avg 12ms max 12ms, 1 failed, last no answer at \S+ \/api\/muster\?rider$/,
    )
    expect(await ask($, 'network', { grep: 'muster' })).toMatch(/^web: 1 request to 1 address like muster\.\n.*\n {2}x1 avg 12ms/)

    expect(await ask($, 'dom')).toMatch(
      /^web: "Anor" at \/, as it stood at \S+: 4 elements\.\n {2}1 thing a reader who does not see the page cannot use:\n {4}a button with no name: button\.lamp in BeaconChain\n {2}written in:\n {4}BeaconChain web\/components\/BeaconChain\.vue\n {2}body\n {4}main <App>\n {6}button\.lamp <BeaconChain> aria-pressed="true"\n {4}footer "The stone"$/,
    )

    const found = await ask($, 'dom', { grep: 'LAMP' })

    expect(found).toMatch(/1 of 4 elements like lamp\./)
    expect(found).toMatch(/\n {2}body\n {4}main <App>\n {6}button\.lamp/)
    expect(found).not.toMatch(/footer/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    await pane.press({ key: 'renders-actions' })
    expect(await ask($, 'pane')).toMatch(/click {2}<BeaconChain> {2}button "Light Halifirien"\n.*rendered {2}BeaconChain ×8, MusterForm ×1\n.*asked {2}200 \/api\/realm\/beacons 41ms\n.*logged {2}.*in the page: Uncaught TypeError/)

    await pane.press({ key: 'renders-network' })
    expect(await ask($, 'pane')).toMatch(/The page loaded at \S+, first byte 40ms/)
    expect(await pane.find({ text: /^\/api\/realm\/beacons$/ })).toBeDefined()

    await pane.press({ key: 'renders-dom' })
    expect(await pane.find({ text: /a button with no name: button\.lamp in BeaconChain/ })).toBeDefined()
  })
  test('goes on watching the project when the shell moves to another folder', { options: { attachments: '' } }, async ($, on) => {
    const { world } = machine(on, { files: { [`${CWD}/.claude/runtime`]: 'web=local:logs/web.log@web\n', [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n' } })

    expect(await ask($, 'status')).toMatch(/^web \(local \/home\/dev\/app\/logs\/web\.log\): up/)

    // Claude ran `cd web`: the session's folder is the shell's
    world.cwd = `${CWD}/web`
    expect(await ask($, 'status')).toMatch(/^web \(local \/home\/dev\/app\/logs\/web\.log\): up/)
    expect(await ask($, 'logs')).toMatch(/vite ready/)
  })

  test('says the lines of what an action asked for, by their request id, and counts what other requests wrote', { options: { attachments: 'web=local:logs/web.log@web#3000; api=local:logs/api.log@api' } }, async ($, on) => {
    const said = (ms: number, level: string, msg: string, rid: string) => `2026-10-13T10:00:27.${ms}Z ${JSON.stringify({ level, msg, rid })}`
    const page = {
      label: 'web',
      address: 'http://localhost:3000/',
      isVisible: true,
      vue: '3.5.43',
      isDev: true,
      renders: [],
      actions: [{ at: NOW - 3000, kind: 'click', what: 'button "Light Eilenach"', component: 'BeaconChain', renders: {}, requests: ['200 /api/realm/beacons/eilenach/light 16ms'] }],
      dom: { url: '/', title: 'Anor', elements: [[0, 'body', '', '', '']], left: 0 },
    }

    machine(on, {
      files: {
        [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n',
        // The server knows the path without the prefix the page asks it under, and a rider asks for something else meanwhile
        [`${CWD}/logs/api.log`]: `${[said(100, 'info', 'POST /beacons/eilenach/light -> 200 in 1ms', 'aa11'), said(150, 'info', 'lamp lit', 'aa11'), said(200, 'error', 'muster refused', 'zz99')].join('\n')}\n`,
      },
      browser: JSON.stringify({ tabs: 1, pages: [page] }),
    })

    const done = await ask($, 'interactions')

    expect(done).toMatch(/logged:\n {6}\S+ \[api\] INFO {2}POST \/beacons\/eilenach\/light -> 200 in 1ms rid=aa11\n {6}\S+ \[api\] INFO {2}lamp lit rid=aa11\n {6}and 1 line of other requests in that time$/)
    expect(done).not.toMatch(/muster refused/)
  })

  test('says when a page is no longer read from the browser, and leaves out the chains of a load that is gone', { options: { attachments: 'web=local:logs/web.log@web#3000' } }, async ($, on) => {
    const page = (loadedAt: number, renders: unknown[]) => ({
      label: 'web',
      address: 'http://localhost:3000/',
      isVisible: true,
      vue: '3.5.43',
      isDev: true,
      renders,
      vitals: { loadedAt, ttfb: 40, lcp: 310, load: 420, cls: 0, inp: 0, longTasks: 0, longMs: 0 },
      dom: { url: '/', title: 'Anor', elements: [[0, 'body', '', '', '']], left: 0 },
    })
    const chain = (state: string) => ({ component: 'BeaconChain', chain: [`${state} (ref) set`, 'BeaconChain'], values: ['7 (was 6)', null], whole: [null, null], count: 2 })
    const { world } = machine(on, { files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n' }, browser: JSON.stringify({ tabs: 1, pages: [page(NOW - 60_000, [chain('beacons')])] }) })

    expect(await ask($, 'renders')).toMatch(/^web: 2 renders in 1 chain\.\n {2}x2 last \S+ beacons \(ref\) set/)
    expect(await ask($, 'status')).toMatch(/; its page is read from the browser, at http:\/\/localhost:3000\/$/)

    // The page is loaded again, and renders for another reason
    world.browser = JSON.stringify({ tabs: 1, pages: [page(NOW + 1000, [])] })
    expect(await ask($, 'renders')).toMatch(/^web: no render since the page was loaded\.\n {2}1 chain last seen before the page was loaded, at \S+, is left out\.$/)

    // Chrome is closed: what is said is what was last read, and that is said
    world.browser = JSON.stringify({ error: 'no-browser' })

    const network = await ask($, 'network')

    expect(network).toMatch(/^web: 0 requests to 0 addresses\.\n {2}its page is not read from the browser now: what is said of it is what was last read\. No Chrome answers on 127\.0\.0\.1:9222\./)
    expect(await ask($, 'status')).toMatch(/\n {2}its page is not read from the browser now/)
    expect(await ask($, 'dom')).toMatch(/1 element\.\n {2}its page is not read from the browser now/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    await pane.press({ key: 'renders-dom' })
    expect(await pane.find({ text: /^No Chrome answers on 127\.0\.0\.1:9222\./ })).toBeDefined()
  })
})

describe('the end-to-end checklist', () => {
  const WEB = { options: { attachments: 'web=local:logs/web.log@web', browserPort: 0 } }
  const PLAN = {
    scenarios: [
      { name: 'Add a book to the cart', steps: ['Open /books', 'Click "Add to cart" on the first book'], expect: 'The cart badge says 1' },
      { name: 'Check out', steps: ['Open /cart', 'Click "Pay"'], expect: 'A page titled "Thank you"' },
      { name: 'Nothing to do', steps: [] },
    ],
  }

  // The engine beneath: every spawn starts a subagent, and a turn's end is answered
  const agents = (on: On) => {
    const spawned: { subagentType?: string; prompt: string; description?: string }[] = []

    // A plugin's spawn reaches the bottom as the Agent tool's call, and is answered as that tool answers
    on('agent.spawn', (_, e) => {
      const { subagent_type: subagentType, prompt, description } = e as unknown as { subagent_type?: string; prompt: string; description?: string }

      spawned.push({ subagentType, prompt, description })

      return { result: { status: 'async_launched', agentId: `agent-${spawned.length}` }, model: 'haiku' } as never
    })
    on('turn.complete', () => ({ text: '' }) as never)

    return spawned
  }

  const answered = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 4200, isAborted: false, turnId: `turn-${agentId}`, agentId, reason: 'answer' } as never)

  test('is written by the model, the scenarios that do not read left out, and nothing is run by it', WEB, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: '' } })

    const spawned = agents(on)
    const text = await ask($, 'e2e_plan', PLAN)

    expect(text).toMatch(/Left out: scenario 3 has no step\./)
    expect(text).toMatch(/1\. \[to run\] Add a book to the cart \(web\)/)
    expect(text).toMatch(/ {3}2\. Click "Add to cart" on the first book/)
    expect(text).toMatch(/passes when: A page titled "Thank you"/)
    expect(spawned.length).toBe(0)
  })

  test('runs each scenario by a subagent of its own, one after another, and keeps what each answered', WEB, async ($, on) => {
    const { toasts } = machine(on, { files: { [`${CWD}/logs/web.log`]: '' } })
    const spawned = agents(on)

    await ask($, 'e2e_plan', PLAN)

    expect(await ask($, 'e2e_run')).toMatch(/2 scenarios are under way/)
    // They share one page: the second waits for the first
    expect(spawned.length).toBe(1)
    expect(spawned[0]?.subagentType).toBe('runtime:e2e')
    expect(spawned[0]?.prompt).toMatch(/Scenario: Add a book to the cart[\s\S]*1\. Open \/books[\s\S]*It passes when: The cart badge says 1/)
    expect(await ask($, 'e2e')).toMatch(/1\. \[running\][\s\S]*2\. \[queued\]/)

    // Another subagent's answer is none of the checklist's
    await answered($, 'someone-else', 'VERDICT: pass')
    expect(spawned.length).toBe(1)

    await answered($, 'agent-1', 'The badge still said 0 after the click.\n**VERDICT: fail: the cart badge says 0, not 1**')
    expect(spawned.length).toBe(2)
    expect(toasts.filter(toast => toast.includes('e2e')).length).toBe(0)

    await answered($, 'agent-2', 'Paid.\nVERDICT: pass')

    const text = await ask($, 'e2e')

    expect(text).toMatch(/^1 passed · 1 failed\./)
    expect(text).toMatch(/1\. \[failed\] Add a book to the cart \(web\) in 4s/)
    expect(text).toMatch(/failed: the cart badge says 0, not 1/)
    expect(text).toMatch(/\| The badge still said 0 after the click\./)
    expect(text).toMatch(/2\. \[passed\] Check out/)
    expect(toasts).toContain('runtime e2e: 1 passed · 1 failed')
  })

  test('shows the checklist in the pane, where one scenario or all are run, planned and stopped', WEB, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: '' } })

    const spawned = agents(on)
    const prompts: string[] = []

    on('prompt.submit', (_, e) => {
      prompts.push(e.text)

      return { text: e.text } as never
    })

    const pane = await mount($)

    await pane.press({ key: 'view-tests' })
    expect(await ask($, 'pane')).toMatch(/No scenario yet/)

    await pane.press({ key: 'e2e-plan' })
    expect(prompts[0]).toMatch(/mcp__runtime__e2e_plan/)

    await ask($, 'e2e_plan', PLAN)
    await pane.press({ key: 'refresh' })
    expect(await ask($, 'pane')).toMatch(/0 passed · 0 failed · 2 to run[\s\S]*○  2 {2}Check out {2}to run/)

    // A row opens on its steps
    await pane.press({ key: 'e2e-row-2-0' })
    expect(await ask($, 'pane')).toMatch(/2\. Click "Pay"\n\s+Passes when: A page titled "Thank you"/)

    await pane.press({ key: 'e2e-run' })
    expect(spawned.length).toBe(1)
    expect(spawned[0]?.prompt).toMatch(/Scenario: Add a book to the cart/)
    expect(await ask($, 'pane')).toMatch(/\[s Stop\]\*[\s\S]*▶  1 {2}Add a book to the cart {2}running/)

    await answered($, 'agent-1', 'VERDICT: fail: the badge says 0')
    await answered($, 'agent-2', 'VERDICT: pass')
    await pane.press({ key: 'refresh' })
    expect(await ask($, 'pane')).toMatch(/\[f Run the 1 not passed\]\*[\s\S]*✗  1 {2}Add a book to the cart {2}failed · 4s\]?\n\s*└─ the badge says 0\n[\s\S]*✓  2 {2}Check out {2}passed · 4s/)

    // What failed is handed to Claude, with what its subagent saw: one scenario, or all that failed
    expect(await ask($, 'pane')).toMatch(/└─ the badge says 0\n\s+\[Fix with Claude\]/)
    await pane.press({ key: 'e2e-fix-1' })
    expect(prompts[1]).toMatch(/^Fix what makes this end-to-end scenario[\s\S]*mcp__runtime__e2e_run, ids 1,[\s\S]*1\. \[failed\] Add a book to the cart[\s\S]*failed: the badge says 0[\s\S]*\| VERDICT: fail: the badge says 0/)
    expect(prompts[1]).not.toMatch(/Check out/)

    // Only what did not pass is run again
    await pane.press({ key: 'e2e-rerun' })
    expect(spawned.length).toBe(3)
    expect(spawned[2]?.prompt).toMatch(/Scenario: Add a book to the cart/)
    await pane.press({ key: 'e2e-stop' })

    const text = await ask($, 'e2e')

    expect(text).toMatch(/1\. \[blocked\][\s\S]*stopped before its subagent answered[\s\S]*2\. \[passed\]/)

    // The subagent that was stopped answers at last: its scenario is no longer its own
    await answered($, 'agent-3', 'VERDICT: pass')
    expect(await ask($, 'e2e')).toMatch(/1\. \[blocked\]/)
  })

  test('says a scenario blocked when its subagent does not start or gives no verdict', WEB, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: '' } })
    on('agent.spawn', () => ({ deny: 'no agent of that type' }) as never)

    await ask($, 'e2e_plan', PLAN)

    expect(await ask($, 'e2e_run')).toMatch(/1\. \[blocked\][\s\S]*its subagent did not start: no agent of that type/)
    expect(verdictOf('I clicked around.', 'answer')).toEqual({ state: 'blocked', note: 'its subagent gave no verdict: I clicked around.' })
    expect(verdictOf('', 'aborted')).toEqual({ state: 'blocked', note: 'its subagent was interrupted' })
    expect(verdictOf('VERDICT: fail: first\nlater\nVERDICT: PASS', 'answer')).toEqual({ state: 'passed', note: '' })
    // Said first, and after other words on its line
    expect(verdictOf('Scenario 7, "Gaze": VERDICT: pass\n\nStep 1: opened the page.', 'answer')).toEqual({ state: 'passed', note: '' })
  })

  test('starts no subagent where no Chrome answers, and stops a run when asked', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    const { world } = machine(on, { files: { [`${CWD}/logs/web.log`]: '' }, browser: JSON.stringify({ error: 'no-browser' }) })
    const spawned = agents(on)

    await ask($, 'e2e_plan', PLAN)

    expect(await ask($, 'e2e_run')).toMatch(/2 blocked[\s\S]*blocked: No Chrome answers on 127\.0\.0\.1:9222/)
    expect(spawned.length).toBe(0)

    world.browser = JSON.stringify({ tabs: 1, pages: [{ label: 'web', address: 'http://127.0.0.1:3000/', isVisible: true, dom: { title: 'Shop' } }] })

    expect(await ask($, 'e2e_run')).toMatch(/2 scenarios are under way/)
    expect(spawned[0]?.prompt).toMatch(/The app is open in a tab of the browser at http:\/\/127\.0\.0\.1:3000\//)

    const text = await ask($, 'e2e_stop')

    expect(text).toMatch(/1\. \[blocked\][\s\S]*stopped before its subagent answered[\s\S]*2\. \[to run\]/)
    expect(spawned.length).toBe(1)
  })

  test('finds the project from a folder inside it, and says where the app answers when no tab is known to show it', { options: { attachments: '', browserPort: 0 } }, async ($, on) => {
    // The mod was loaded while the shell stood deep in the project
    machine(on, { cwd: `${CWD}/web/src`, files: { [`${CWD}/.claude/runtime`]: 'web=local:logs/web.log@web#3000\n', [`${CWD}/logs/web.log`]: '' } })

    const spawned = agents(on)

    expect(await ask($, 'status')).toMatch(/^web \(local \/home\/dev\/app\/logs\/web\.log\)/)

    await ask($, 'e2e_plan', PLAN)
    await ask($, 'e2e_run')
    expect(spawned[0]?.prompt).toMatch(/The app answers at http:\/\/localhost:3000\/: use the tab that shows it, or open that address in a new one\./)
  })

  test('names the unit test suites, runs them from the pane by how each command exits, and hands what failed to Claude', WEB, async ($, on) => {
    const { runs, toasts } = machine(on, { files: { [`${CWD}/logs/web.log`]: '' } })
    const prompts: string[] = []

    on('prompt.submit', (_, e) => {
      prompts.push(e.text)

      return { text: e.text } as never
    })
    // The machine beneath answers `ps` and knows no `pytest`: one suite passes, one fails, one cannot start
    const text = await ask($, 'unit_plan', {
      suites: [
        { name: 'web components', command: ['ps', '-A'], cwd: 'web', target: 'web' },
        { name: 'api', command: ['kubectl', 'top'] },
        { name: 'as a line', command: 'npm test' },
      ],
    })

    expect(text).toMatch(/Left out: suite 3 has no command written as a list of arguments\./)
    expect(text).toMatch(/1\. \[to run\] web components \(web\)\n {3}\$ ps -A {2}\(in web\)/)
    expect(runs.filter(line => line === 'ps -A').length).toBe(0)

    const pane = await mount($)

    // The plan showed the suites: the Tests view, on its unit tests
    expect(await ask($, 'pane')).toMatch(/\[4 Tests\]\*[\s\S]*\[e E2E\] {2}\[u Unit tests 0\/2\]\*[\s\S]*○  1 {2}web components {2}to run · web/)

    await pane.press({ key: 'unit-run' })

    const shown = await ask($, 'pane')

    expect(shown).toMatch(/\[u Unit tests 1\/2\]\*[\s\S]*● 1 passed · 1 failed[\s\S]*✓  1 {2}web components {2}passed/)
    expect(shown).toMatch(/✗  2 {2}api {2}failed[^\n]*\n\s*└─ exit 1: error: Metrics API not available\n\s+\[Fix with Claude\]/)
    expect(toasts).toContain('runtime unit tests: 1 passed · 1 failed')
    expect(await ask($, 'unit')).toMatch(/2\. \[failed\] api[\s\S]*\$ kubectl top[\s\S]*\| error: Metrics API not available/)

    await pane.press({ key: 'unit-fix-2' })
    expect(prompts[0]).toMatch(/^Fix what makes this unit test suite[\s\S]*\$ kubectl top[\s\S]*Metrics API not available/)

    // The other view is one press away
    await pane.press({ key: 'tests-e2e' })
    expect(await ask($, 'pane')).toMatch(/\[e E2E\]\*[\s\S]*No scenario yet/)
  })

  test('reads the tests of a suite off what its command printed, a line a test', () => {
    const pytest = ['collecting ... collected 3 items', '', 'tests/test_rohan.py::test_health PASSED                                  [ 33%]', 'tests/test_rohan.py::test_one_spear_too_many_is_refused FAILED [ 66%]', 'tests/test_rohan.py::TestKing::test_doubt SKIPPED (no king) [100%]', 'FAILED tests/test_rohan.py::test_one_spear_too_many_is_refused - assert 200 == 409'].join('\n')

    expect(casesOf(pytest)).toEqual([
      { name: 'test_rohan.py > test_health', state: 'passed', ms: 0 },
      { name: 'test_rohan.py > test_one_spear_too_many_is_refused', state: 'failed', ms: 0 },
      { name: 'test_rohan.py > TestKing > test_doubt', state: 'skipped', ms: 0 },
    ])

    const vitest = [' RUN  v3.2.7 /app', '', ' \u001B[32m✓\u001B[39m tests/names.test.ts > named > writes a stone too 9ms', ' × tests/names.test.ts > reasonOf > falls back 12ms', '   → expected 1 to be 2', ' ↓ tests/realm.test.ts > useRide > is shared', ' ✓ tests/herald.test.ts (6 tests) 22ms', ' Test Files  1 failed (3)'].join('\n')

    expect(casesOf(vitest)).toEqual([
      { name: 'names.test.ts > named > writes a stone too', state: 'passed', ms: 9 },
      { name: 'names.test.ts > reasonOf > falls back', state: 'failed', ms: 12 },
      { name: 'realm.test.ts > useRide > is shared', state: 'skipped', ms: 0 },
    ])

    expect(casesOf('--- PASS: TestMuster (0.02s)\n--- FAIL: TestArrow (1.50s)\nnot ok 3 - rides\nok 4 - waits # SKIP no horse').map(({ name, state, ms }) => `${name} ${state} ${ms}`)).toEqual(['TestMuster passed 20', 'TestArrow failed 1500', 'rides failed 0', 'waits skipped 0'])
    expect(casesOf('2 passed in 0.31s')).toEqual([])
  })

  test('lists the tests under their suite, and shows the suites of the app that is picked', () => {
    const { suites: planned } = plannedSuites(
      {
        suites: [
          { name: 'api', command: ['pytest', '-v'], target: 'api' },
          { name: 'web', command: ['npm', 'test'], target: 'web' },
        ],
      },
      ['api', 'web'],
    )
    const [api, web] = planned
    const ran = [endedSuite(api!, { exitCode: 1, stdout: 't/test_a.py::test_one PASSED [ 50%]\nt/test_a.py::test_two FAILED [100%]', stderr: '' }, 1200), web!]

    expect(suitesOf(ran, 'web').map(({ name }) => name)).toEqual(['web'])
    expect(suitesOf(ran, '').length).toBe(2)

    const [row] = suiteTree(suitesOf(ran, 'api'), [])

    expect(row?.meta).toBe('failed · 1/2 tests, 1 failed · 1s · api')
    expect(row?.children?.map(({ label }) => label)).toEqual(['exit 1: t/test_a.py::test_two FAILED [100%]', '✓ test_a.py > test_one', '✗ test_a.py > test_two'])
    // Claude is told which failed; every test of a suite when it asks for that one
    expect(unitText(ran)).toMatch(/1\/2 tests, 1 failed\n {3}✗ test_a\.py > test_two\n/)
    expect(unitText(ran, { id: '1' })).toMatch(/✓ test_a\.py > test_one\n {3}✗ test_a\.py > test_two/)
  })

  test('adds scenarios after the ones held, which keep what came of them', () => {
    const first = planned([], PLAN, ['web']).scenarios.map(scenario => ({ ...scenario, state: 'passed' as const }))
    const { scenarios } = planned(first, { add: true, scenarios: [{ name: 'Log out', steps: 'Click "Log out"; Open /account', target: 'nowhere' }] }, ['web'])

    expect(scenarios.map(({ id, state, target }) => `${id} ${state} ${target}`)).toEqual(['1 passed web', '2 passed web', '3 todo web'])
    expect(scenarios[2]?.steps).toEqual(['Click "Log out"', 'Open /account'])

    // All that failed are handed over as one ask
    expect(fixPrompt(scenarios.slice(0, 2).map(scenario => ({ ...scenario, state: 'failed' as const })))).toMatch(/^Fix what makes these 2 end-to-end scenarios[\s\S]*ids 1, 2,[\s\S]*1\. \[failed\][\s\S]*2\. \[failed\] Check out/)
  })
})

describe('reading a line', () => {
  test('takes its level and message from JSON, logfmt and plain words', () => {
    expect(read('{"level":50,"time":1760349600000,"msg":"boom","rid":"ab12","pid":7}')).toEqual({ at: 1760349600000, level: 'error', message: 'boom', fields: 'rid=ab12' })
    expect(read('level=warning msg="disk at 91%" host=a1')).toMatchObject({ level: 'warn', message: 'disk at 91%', fields: 'host=a1' })
    expect(read('2026-10-13 10:00:00 ERROR db: timeout').level).toBe('error')
    expect(read('Error: listen EADDRINUSE :::3000').level).toBe('error')
    expect(read('compiled with 0 errors').level).toBe('info')
  })

  test('folds a stack trace under its first line and counts the same error once', () => {
    const watch = absorb(
      EMPTY_WATCH,
      ['TypeError: x is not a function', '    at verify (auth.ts:12:3)', '    at handle (server.ts:40:9)', 'request 4411 failed after 120ms', 'ERROR request 4412 failed after 98ms', 'ERROR request 4413 failed after 7ms'],
      1000,
    )

    expect(watch.lines.map(line => [line.level, line.more])).toEqual([['error', 2], ['info', 0], ['error', 0], ['error', 0]])
    expect(watch.signatures.map(signature => [signature.key, signature.count])).toEqual([['TypeError: x is not a function', 1], ['request <n> failed after <n>ms', 2]])
    expect(fresh(watch)).toHaveLength(0)
    expect(fresh(absorb({ ...watch, edits: 1 }, ['ERROR cache miss storm'], 2000)).map(signature => signature.sample)).toEqual(['cache miss storm'])
  })

  test('reads a line that leads with its level as a line of its own, however far it is set in', () => {
    // Nuxt, through consola, sets the level in by a space, and Node lists what required a missing module
    const watch = absorb(
      EMPTY_WATCH,
      ['● Starting Nuxt... (2.56s)', ' ERROR  Cannot find native binding. Please try npm i again.', '    at node_modules/rolldown/dist/shared/binding.mjs:603:34', "  [cause]: Cannot find module '@rolldown/binding-wasm32-wasi'", 'Require stack:', '- /app/node_modules/rolldown/dist/shared/binding.mjs', ' WARN  Slow dependency'],
      1000,
    )

    expect(watch.lines.map(({ level, message, more }) => [level, message, more])).toEqual([
      ['info', '● Starting Nuxt... (2.56s)', 0],
      ['error', 'Cannot find native binding. Please try npm i again.', 4],
      ['warn', 'Slow dependency', 0],
    ])
    expect(watch.signatures).toHaveLength(1)
  })

  test('says a Python traceback with the line it hangs under, as one error whatever the request', () => {
    const failed = (rid: string) => [
      `{"level":"error","msg":"POST /beacons/halifirien/light failed","rid":"${rid}"}`,
      'Traceback (most recent call last):',
      '  File "gondor/realm.py", line 32, in light',
      '    return RELAY[name]',
      '           ~~~~~^^^^^^',
      "KeyError: 'halifirien'",
    ]
    const watch = absorb(EMPTY_WATCH, [...failed('bf3beffd'), ...failed('52b2aea5'), '{"level":"info","msg":"GET /beacons -> 200","rid":"0a0a0a0a"}'], 1000)

    expect(watch.lines.map(line => [line.level, line.message, line.more])).toEqual([
      ['error', "POST /beacons/halifirien/light failed: KeyError: 'halifirien' rid=bf3beffd", 5],
      ['error', "POST /beacons/halifirien/light failed: KeyError: 'halifirien' rid=52b2aea5", 5],
      ['info', 'GET /beacons -> 200 rid=0a0a0a0a', 0],
    ])
    expect(watch.signatures.map(signature => [signature.sample, signature.count])).toEqual([["POST /beacons/halifirien/light failed: KeyError: 'halifirien'", 2]])

    // A crash at import says nothing of an error on its first line: the trace under it does
    const crashed = absorb(EMPTY_WATCH, ['Process SpawnProcess-2:', 'Traceback (most recent call last):', '  File "gondor/app.py", line 9', 'SyntaxError: invalid syntax'], 1000)

    expect(crashed.lines).toEqual([
      { at: 1000, level: 'error', message: 'Process SpawnProcess-2: SyntaxError: invalid syntax', more: 3, trace: ['Traceback (most recent call last):', '  File "gondor/app.py", line 9', 'SyntaxError: invalid syntax'] },
    ])
  })

  test('keeps the trace under an error: its first lines and its last, secrets taken out', () => {
    const watch = absorb(EMPTY_WATCH, ['TypeError: x is not a function', '    at verify (auth.ts:12:3) token=hunter2hunter2', ...Array.from({ length: 60 }, (_, index) => `    at frame${index} (lib.ts:${index}:1)`)], 1000)
    const [{ trace = [], more } = { more: 0 }] = watch.lines

    expect(more).toBe(61)
    expect(trace).toHaveLength(37)
    expect(trace[0]).toBe('    at verify (auth.ts:12:3) token=***')
    expect(trace[12]).toBe('… 25 more lines …')
    expect(trace[36]).toBe('    at frame59 (lib.ts:59:1)')
    // The kind keeps the trace of the last time it was written
    expect(watch.signatures[0]?.trace).toEqual(trace)
  })

  test('takes the secrets out', () => {
    expect(redact('Authorization: Bearer abc.def-0123456789')).not.toMatch(/abc\.def/)
    expect(redact('postgres://shop:s3cr3t@db:5432/shop')).toBe('postgres://shop:***@db:5432/shop')
    expect(redact('{"api_key":"k-123456","user":"ada"}')).toBe('{"api_key":"***","user":"ada"}')
    expect(redact('DB_PASSWORD=hunter2 retries=3')).toBe('DB_PASSWORD=*** retries=3')
    expect(signatureOf('order 7f3c2a10-9b1d-4c7e-8a55-0123456789ab took 31ms')).toBe('order <id> took <n>ms')
  })
})

describe('attachments', () => {
  test('are read from a list, the ones that do not read left out', () => {
    const list = parseList('# the shop\napi=docker:shop-api@api,libs/auth\nweb = local:C:\\logs\\web.log\nbad line\nx=k8s:only/two\nbroker=kubernetes:staging/deploy/kafka\nadmin=local:logs/admin.log@admin#5173', CWD)

    expect(list).toEqual([
      { label: 'api', runtime: 'docker', ref: 'shop-api', roots: [`${CWD}/api`, `${CWD}/libs/auth`], port: 0 },
      { label: 'web', runtime: 'local', ref: 'C:/logs/web.log', roots: [], port: 0 },
      { label: 'broker', runtime: 'kubernetes', ref: 'staging/deploy/kafka', roots: [], port: 0 },
      // The port a local app listens on, which is how its process is found
      { label: 'admin', runtime: 'local', ref: `${CWD}/logs/admin.log`, roots: [`${CWD}/admin`], port: 5173 },
    ])
  })

  test('count an edit against the app whose folder holds the file', () => {
    const list = composeAttachments(JSON.stringify({ services: { api: { build: { context: 'C:\\dev\\app\\api' } }, web: { build: { context: 'C:\\dev\\app' } }, db: { image: 'postgres' } } }), 'C:\\dev\\app')
    const labels = (path: string) => routed(list, path, 'C:\\dev\\app').map(({ label }) => label)

    expect(labels('c:/dev/app/api/src/auth.ts')).toEqual(['api', 'web', 'db'])
    expect(labels('web/src/Cart.tsx')).toEqual(['web', 'db'])
    expect(labels('C:\\dev\\app-two\\api\\src\\auth.ts')).toEqual([])
  })
})

describe('a local process', () => {
  // What Windows prints: processor time in tenths of a microsecond, one object where there is one listener
  const windows = (userTime: number) =>
    JSON.stringify({
      listeners: { LocalPort: 8101, OwningProcess: 3044 },
      processes: [
        { ProcessId: 3044, ParentProcessId: 900, KernelModeTime: 10_000_000, UserModeTime: userTime, WorkingSetSize: 50 * 1024 ** 2 },
        { ProcessId: 3050, ParentProcessId: 3044, KernelModeTime: 0, UserModeTime: 0, WorkingSetSize: 14 * 1024 ** 2 },
        { ProcessId: 900, ParentProcessId: 4, KernelModeTime: 0, UserModeTime: 990_000_000, WorkingSetSize: 1024 ** 3 },
      ],
    })

  test('is found by its port and added up with the processes it started', () => {
    const first = localUsage(readWindowsProbe(windows(20_000_000)), 8101, undefined, 10_000)

    expect(first).toMatchObject({ cpu: -1, memory: 64 * 1024 ** 2, processes: 2, cpuSeconds: 3, note: '' })
    // Two more processor seconds over ten of the clock: a fifth of a core
    expect(localUsage(readWindowsProbe(windows(40_000_000)), 8101, first, 20_000).cpu).toBe(20)
    // Started again since: less processor time than before is nothing to measure from
    expect(localUsage(readWindowsProbe(windows(0)), 8101, first, 20_000).cpu).toBe(-1)
    expect(localUsage(readWindowsProbe('not json'), 8101, first, 20_000).note).toBe('nothing listens on 8101')
  })

  test('has its env files read, quoted or not', () => {
    expect(readEnvFile('A=1\n  export B = "two words" # said\nC=\'x#y\'\n# D=4\nnot a line\nDB_PASSWORD=hunter2\r\n', '.env')).toEqual([
      { name: 'A', value: '1', from: '.env' },
      { name: 'B', value: 'two words', from: '.env' },
      { name: 'C', value: 'x#y', from: '.env' },
      { name: 'DB_PASSWORD', value: '***', from: '.env' },
    ])
  })
})

describe('health', () => {
  test('is read off what each runtime prints', () => {
    expect(readHealth('docker', JSON.stringify([{ RestartCount: 0, State: { Status: 'running', Health: { Status: 'unhealthy' } } }]))).toMatchObject({ state: 'degraded', detail: 'unhealthy' })
    // One object per line, as newer versions of compose print them
    expect(readHealth('compose', '{"State":"running","Health":""}\n{"State":"exited","ExitCode":1}\n')).toMatchObject({ state: 'degraded', detail: '1/2 running' })
    expect(readHealth('compose', '[]')).toMatchObject({ state: 'down', detail: 'not created' })
    expect(
      readHealth('kubernetes', JSON.stringify({ kind: 'Pod', status: { phase: 'Running', containerStatuses: [{ restartCount: 7, ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })),
    ).toEqual({ state: 'down', detail: 'CrashLoopBackOff', restarts: 7 })
    expect(readHealth('kubernetes', JSON.stringify({ kind: 'Deployment', spec: { replicas: 2 }, status: { readyReplicas: 2 } }))).toMatchObject({ state: 'up', detail: '2/2 ready' })
  })
})

// What rpk prints of one topic of one partition, and of the one group that reads it
const described = (end: number) => JSON.stringify([
  { summary: { name: '__consumer_offsets', internal: true }, partitions: [{ partition: 0, log_start_offset: 0, high_watermark: 40 }] },
  { summary: { name: 'orders', internal: false }, configs: [], partitions: [{ partition: 0, log_start_offset: 2, high_watermark: end }] },
])

const grouped = (offset: number, end: number, members = 1) =>
  JSON.stringify([{ group_name: 'billing', state: members > 0 ? 'Stable' : 'Empty', members, total_lag: end - offset, partitions: [{ partition: 0, current_offset: offset, log_start_offset: 2, log_end_offset: end, lag: end - offset, topic: 'orders' }] }])

const BROKERED: Partial<World> = {
  files: { [`${CWD}/compose.yaml`]: 'services: {}' },
  services: { api: `${CWD}/api`, redpanda: '' },
  status: { redpanda: JSON.stringify({ Service: 'redpanda', Name: 'app-redpanda-1', Image: 'redpandadata/redpanda:v26.2.4', State: 'running', Health: 'healthy', ExitCode: 0 }) },
  rpk: { 'topic describe': described(12), 'group describe': grouped(12, 12) },
}

describe('a broker', () => {
  test('is told by its image and asked what it holds: its topics, its groups and how far behind each is', async ($, on) => {
    const { world, runs, toasts } = machine(on, BROKERED)

    letEditsThrough(on)

    const text = await ask($, 'broker')

    expect(runs).toContain('docker compose exec -T redpanda rpk group describe -r .* --format json')
    // Nothing is run inside what is no broker
    expect(runs.some(run => run.includes('exec -T api'))).toBe(false)
    expect(text).toMatch(/redpanda \(Redpanda\)/)
    expect(text).toMatch(/orders: 1 partition, 10 records held, 12 written in all/)
    expect(text).not.toMatch(/__consumer_offsets/)
    expect(text).toMatch(/billing: Stable, 1 member, reads orders, lag 0$/m)
    expect(await ask($, 'broker', { target: 'api' })).toMatch(/api is not a broker the runtime mod reads/)

    // An edit to the app that produces, then the group falls behind: said against how it stood, on the broker
    await edit($, `${CWD}/api/src/orders.ts`)

    world.rpk['topic describe'] = described(20)
    world.rpk['group describe'] = grouped(12, 20)

    const after = await ask($, 'broker')

    expect(after).toMatch(/billing: Stable, 1 member, reads orders, lag 8 \(lag was 0 before the edit to api\/src\/orders\.ts\)/)
    expect(after).toMatch(/orders\/0: read up to 12 of 20, 8 records waiting/)
    expect(await ask($, 'status')).toMatch(/a Redpanda broker: 1 topic, 1 consumer group; behind: billing by 8; mcp__runtime__broker says more/)

    // The consumer goes: told once
    world.rpk['group describe'] = grouped(12, 20, 0)

    expect(await ask($, 'broker')).toMatch(/billing: Empty, 0 members, reads orders, lag 8 \(nobody reads, lag was 0/)
    await ask($, 'broker')
    expect(toasts.filter(toast => toast === 'runtime: redpanda: the group billing has no member left, 8 records wait')).toHaveLength(1)
  })

  test('has the last records of a topic read as no group, the secrets out of them', async ($, on) => {
    const { world, runs } = machine(on, BROKERED)
    const sent = (offset: number, value: string) => JSON.stringify({ topic: 'orders', key: `o${offset}`, value, headers: [{ key: 'rid', value: `r${offset}` }], timestamp: NOW - 1000 * (12 - offset), partition: 0, offset }, null, 2)

    world.rpk['topic consume'] = [sent(10, '{"total":40}'), sent(11, '{"total":7,"token":"Bearer abcdef123456"}')].join('\n')

    const text = await ask($, 'broker', { topic: 'orders', limit: 2 })

    // Asked for as many as there are, so that it ends by itself
    expect(runs).toContain('docker compose exec -T redpanda rpk topic consume orders -o -2 -n 2')
    expect(text).toMatch(/orders\/0@10 key=o10 \[rid=r10\] \{"total":40\}/)
    expect(text).toMatch(/orders\/0@11 key=o11 \[rid=r11\]/)
    expect(text).not.toMatch(/abcdef123456/)
    expect(await ask($, 'broker', { topic: 'nope' })).toMatch(/redpanda has no topic nope/)

    // Searched by what a record holds: a request id in its headers
    const found = await ask($, 'broker', { topic: 'orders', grep: 'R11' })

    expect(found).toMatch(/The last 1 record of orders on redpanda that hold R11/)
    expect(found).not.toMatch(/key=o10/)
  })

  test('is shown in the pane, in a view of its own, where there is one', async ($, on) => {
    const { world } = machine(on, BROKERED)

    world.rpk['group describe'] = grouped(5, 12, 0)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-broker' })

    expect(await pane.find({ text: /redpanda: Redpanda, asked at/ })).toBeDefined()
    expect(await pane.find({ text: /billing/ })).toBeDefined()
    expect(await pane.find({ text: /nobody reads/ })).toBeDefined()
  })

  test('hands a question typed in the pane to Claude, with the topics, the groups and how to answer it', async ($, on) => {
    machine(on, BROKERED)

    const prompts: string[] = []

    on('prompt.submit', (_, e) => {
      prompts.push(e.text)

      return { text: e.text } as never
    })

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-broker' })
    await pane.input({ key: 'broker-ask', text: ' ' })
    await pane.input({ key: 'broker-ask', text: 'what was the last order sent?' })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/^About the broker the runtime mod watches \(redpanda: Redpanda, topics orders, consumer groups billing\):\n\nwhat was the last order sent\?\n\nAnswer it by asking it with mcp__runtime__broker \(target redpanda\)/)
  })

  test('opens a topic on its last messages in the pane, and closes it', async ($, on) => {
    const { world, runs } = machine(on, BROKERED)

    world.rpk['topic consume'] = JSON.stringify({ topic: 'orders', key: 'o11', value: '{"total":7,"password":"hunter2"}', headers: [{ key: 'rid', value: 'r11' }], timestamp: NOW - 1000, partition: 0, offset: 11 }, null, 2)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-broker' })

    expect(await pane.find({ text: /A topic opens on its last messages/ })).toBeDefined()

    await pane.press({ key: 'topic-redpanda-orders' })

    expect(runs).toContain('docker compose exec -T redpanda rpk topic consume orders -o -10 -n 10')
    expect(await pane.find({ text: /orders: its last 1 message, oldest first/ })).toBeDefined()
    expect(await pane.find({ text: /0@11/ })).toBeDefined()
    expect(await pane.find({ text: /rid=r11/ })).toBeDefined()
    expect(await pane.find({ text: /hunter2/ })).toBeUndefined()

    // Read again with its broker, while the view is on it
    const before = runs.filter(run => run.includes('topic consume')).length

    await pane.press({ key: 'refresh' })

    expect(runs.filter(run => run.includes('topic consume')).length).toBe(before + 1)

    await pane.press({ key: 'topic-redpanda-orders' })

    expect(await pane.find({ text: /its last 1 message/ })).toBeUndefined()
  })

  test('is shown apart from the apps and the databases, each kind under its name', async ($, on) => {
    machine(on, {
      ...BROKERED,
      services: { api: `${CWD}/api`, redpanda: '', db: '' },
      status: { ...BROKERED.status, db: JSON.stringify({ Service: 'db', Name: 'app-db-1', Image: 'postgres:17-alpine', State: 'running', Health: 'healthy', ExitCode: 0 }) },
    })

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /1 app · 1 broker · 1 database · 0 down/ })).toBeDefined()
    expect(await pane.find({ text: /^Apps$/ })).toBeDefined()
    expect(await pane.find({ text: /^Brokers$/ })).toBeDefined()
    expect(await pane.find({ text: /^Databases$/ })).toBeDefined()
    expect(await pane.find({ text: /^PostgreSQL$/ })).toBeDefined()

    const text = await ask($, 'status')

    expect(text).toMatch(/^Apps:\napi \(Compose api\)/)
    expect(text).toMatch(/\n\nBrokers:\nredpanda \(Compose redpanda\).*it runs Redpanda\n  a Redpanda broker: 1 topic/)
    expect(text).toMatch(/\n\nDatabases:\ndb \(Compose db\).*it runs PostgreSQL/)
  })

  test('keeps what it last said, with why, when it does not answer', async ($, on) => {
    const { world } = machine(on, BROKERED)

    await ask($, 'broker')

    world.rpk = {}

    const text = await ask($, 'broker')

    expect(text).toMatch(/It could not be asked \(unable to dial: connection refused\): what follows is what it last said\./)
    expect(text).toMatch(/billing: Stable/)
  })

  test('is read off what its command line prints', () => {
    expect(brokerKind(['docker.redpanda.com/redpandadata/redpanda:v26.2.4'])).toBe('redpanda')
    expect(brokerKind(['redpandadata/console:latest'])).toBeUndefined()
    expect(brokerKind(['apache/kafka:4.1.0'])).toBe('kafka')
    expect(brokerKind(['beacons-gondor:latest'])).toBeUndefined()
    expect(kindOf(['beacons-gondor:latest'])).toEqual({ kind: 'app', engine: '' })
    expect(kindOf(['docker.io/library/postgres:17'])).toEqual({ kind: 'database', engine: 'PostgreSQL' })
    expect(kindOf(['redpandadata/redpanda:v26.2.4'])).toEqual({ kind: 'broker', engine: 'Redpanda' })
    // Nothing known of what it runs: it stays what it was
    expect(kindOf([])).toBeUndefined()
    expect(matching([{ partition: 0, offset: 1, at: 1, key: 'k', headers: 'rid=AB12', value: 'v' }], 'ab1')).toHaveLength(1)

    expect(readTopics(described(12))).toEqual([{ name: 'orders', sizes: [10], end: 12 }])
    expect(readGroups(grouped(-1, 3))[0]).toMatchObject({ name: 'billing', taken: 0, lag: 4, partitions: [{ topic: 'orders', partition: 0, offset: -1, end: 3, lag: 4 }] })
    expect(readTopics('not json')).toEqual([])

    // As many records as the partitions hold of the last ones, and no command for a topic that holds none
    expect(peekArgv({ name: 'orders', sizes: [9, 0, 2], end: 11 }, 5)).toEqual(['rpk', 'topic', 'consume', 'orders', '-o', '-5', '-n', '7'])
    expect(peekArgv({ name: 'orders', sizes: [0], end: 4 }, 5)).toBeUndefined()
    expect(readRecords('{\n  "partition": 1,\n  "offset": 4,\n  "timestamp": 2,\n  "value": "b"\n}\n{\n  "partition": 0,\n  "offset": 9,\n  "timestamp": 1,\n  "value": "a"\n}\n').map(({ value }) => value)).toEqual(['a', 'b'])
  })

  test('says a group stuck when it has records waiting and has taken none for a while', () => {
    const read = { topics: readTopics(described(20)), groups: readGroups(grouped(12, 20)) }
    const first = settleBroker(undefined, read, 'redpanda', NOW).broker
    // Nothing more marked as read half a minute later: the time it last took one is kept
    const second = settleBroker(first, read, 'redpanda', NOW + 40_000).broker
    const [group] = second.groups

    expect(group?.movedAt).toBe(NOW)
    expect(group === undefined ? 0 : stuckFor(group, NOW + 40_000)).toBe(40)
    expect(group === undefined ? '' : standing(group, second, NOW + 40_000)).toBe('nothing taken for 40s')

    // It takes one: it is slow, not stuck
    const third = settleBroker(second, { ...read, groups: readGroups(grouped(13, 20)) }, 'redpanda', NOW + 45_000).broker

    expect(third.groups[0] === undefined ? -1 : stuckFor(third.groups[0], NOW + 45_000)).toBe(0)
  })
})

type SessionGiven = { pid: number; app?: string; state?: string; wait?: string; blockers?: number[]; seconds?: number; query?: string }

// What psql prints of one database of two tables, and of the sessions given
const holding = (sessions: SessionGiven[] = [{ pid: 40, app: 'api' }], max = 100) =>
  JSON.stringify({
    name: 'shop',
    version: '18.0',
    bytes: 8_388_608,
    max,
    sessions: sessions.map(({ pid, app = 'api', state = 'idle', wait = 'Client', blockers = [], seconds = 1, query = 'SELECT 1' }) => ({ pid, user: 'shop', app, state, wait, blockers, seconds, query })),
    tables: [
      { schema: 'audit', name: 'events', rows: 3, dead: 0, bytes: 16_384, scans: 1, lookups: 0, written: 3 },
      { schema: 'public', name: 'orders', rows: 120, dead: 4, bytes: 65_536, scans: 9, lookups: 240, written: 131 },
    ],
  })

const STORED: Partial<World> = {
  files: { [`${CWD}/compose.yaml`]: 'services: {}' },
  services: { api: `${CWD}/api`, db: '' },
  status: { db: JSON.stringify({ Service: 'db', Name: 'app-db-1', Image: 'postgres:18-alpine', State: 'running', Health: 'healthy', ExitCode: 0 }) },
  psql: { holds: holding() },
}

describe('a database', () => {
  test('is told by its image and asked what it holds: its sessions and its tables', async ($, on) => {
    const { world, runs, toasts } = machine(on, STORED)

    const text = await ask($, 'database')

    // Asked inside it, with writing turned off, and nothing run inside what is no database
    expect(runs.some(run => run.startsWith('docker compose exec -T db sh -c exec psql ') && run.includes(' SET default_transaction_read_only = on SELECT json_build_object('))).toBe(true)
    expect(runs.some(run => run.includes('exec -T api'))).toBe(false)
    expect(text).toMatch(/^db \(PostgreSQL 18\.0\), database shop, 8\.0 MB, asked at/)
    expect(text).toMatch(/Sessions: 1 of the 100 it lets in \(1 idle\); by app: api 1/)
    expect(text).toMatch(/orders: about 120 rows, 64 kB, 4 dead, 131 rows written, read 9 times whole and 240 times by an index/)
    expect(text).toMatch(/audit\.events: about 3 rows/)
    expect(text).not.toMatch(/Waiting, idle/)
    expect(await ask($, 'database', { target: 'api' })).toMatch(/api is not a database the runtime mod reads/)
    expect(await ask($, 'status')).toMatch(/a PostgreSQL database: shop, 2 tables, 1 of 100 sessions taken; none waiting; mcp__runtime__database says more/)

    // One session holds a transaction open, and another waits for what it locked: each told once
    world.psql.holds = holding([
      { pid: 40, app: 'psql', state: 'idle in transaction', seconds: 45, query: 'LOCK TABLE orders' },
      { pid: 41, state: 'active', wait: 'Lock', blockers: [40], seconds: 12, query: "UPDATE orders SET token = 'x' WHERE password = 'hunter2'" },
    ])

    const after = await ask($, 'database')

    expect(after).toMatch(/pid 40 \(psql\): idle in transaction for 45s: LOCK TABLE orders/)
    expect(after).toMatch(/pid 41 \(api\): active for 12s, waits for a lock held by pid 40: UPDATE orders/)
    expect(after).not.toMatch(/hunter2/)
    expect(await ask($, 'status')).toMatch(/1 waiting for a lock; 1 idle in an open transaction/)
    await ask($, 'database')
    expect(toasts.filter(toast => toast === 'runtime: db: pid 41 (api) waits for a lock held by pid 40')).toHaveLength(1)
    expect(toasts.filter(toast => toast === 'runtime: db: pid 40 (psql) has held a transaction open and idle for 45s')).toHaveLength(1)
  })

  test('has the last rows of a table read, the secrets out of them, and only of a table it has', async ($, on) => {
    const { world, runs } = machine(on, STORED)

    // As psql prints them, the last first
    world.psql.rows = ['{"id":12,"rid":"r12","total":7,"token":"Bearer abcdef123456"}', '{"id":11,"rid":"r11","total":40}'].join('\n')

    const text = await ask($, 'database', { table: 'orders', limit: 2 })

    expect(runs.some(run => run.endsWith('SELECT row_to_json(t) FROM (SELECT * FROM "public"."orders" ORDER BY ctid DESC LIMIT 2) t'))).toBe(true)
    expect(text).toMatch(/The last 2 rows of orders on db, as they lie in the table, oldest first, secrets taken out:\n  \{"id":11.*\n  \{"id":12/)
    expect(text).not.toMatch(/abcdef123456/)

    // A name the database did not give is put in no statement
    const before = runs.length

    expect(await ask($, 'database', { table: 'orders"; DROP TABLE orders; --' })).toMatch(/db has no table orders"; DROP TABLE orders; --\./)
    expect(runs.slice(before).some(run => run.includes('DROP'))).toBe(false)

    const found = await ask($, 'database', { table: 'orders', grep: 'R11' })

    expect(found).toMatch(/The last 1 row of orders on db that hold R11/)
    expect(found).not.toMatch(/"id":12/)
  })

  test('is shown in the pane, in a view of its own, where a table opens on its last rows', async ($, on) => {
    const { world, runs } = machine(on, STORED)

    world.psql.holds = holding([{ pid: 41, state: 'active', wait: 'Lock', blockers: [40], seconds: 12, query: 'UPDATE orders SET total = 1' }])
    world.psql.rows = '{"id":12,"rid":"r12","password":"hunter2"}'

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /1 app · 1 database · 0 down/ })).toBeDefined()
    expect(await pane.find({ text: /^1\/100$/ })).toBeDefined()

    await pane.press({ key: 'view-database' })

    expect(await pane.find({ text: /db: PostgreSQL 18\.0, database shop, 8\.0 MB, asked at/ })).toBeDefined()
    expect(await pane.find({ text: /waits for a lock held by pid 40/ })).toBeDefined()
    expect(await pane.find({ text: /A table opens on its last rows/ })).toBeDefined()

    await pane.press({ key: 'table-db-orders' })

    expect(await pane.find({ text: /orders: its last 1 row, oldest first/ })).toBeDefined()
    expect(await pane.find({ text: /"rid":"r12"/ })).toBeDefined()
    expect(await pane.find({ text: /hunter2/ })).toBeUndefined()

    // Read again with its database, while the view is on it
    const before = runs.filter(run => run.includes('row_to_json')).length

    await pane.press({ key: 'refresh' })

    expect(runs.filter(run => run.includes('row_to_json')).length).toBe(before + 1)

    await pane.press({ key: 'table-db-orders' })

    expect(await pane.find({ text: /its last 1 row/ })).toBeUndefined()
  })

  test('runs one statement that reads for the model, and refuses anything else', async ($, on) => {
    const { world, runs } = machine(on, STORED)

    world.psql.rows = ['{"beacon":"nardol","times":4}', '{"beacon":"erelas","times":2,"token":"Bearer abcdef123456"}'].join('\n')

    const text = await ask($, 'database', { sql: 'SELECT beacon, count(*) AS times FROM lightings GROUP BY 1 ORDER BY 2 DESC;' })

    // Set inside a read of its rows, bounded, and in the order it gave them
    expect(runs.some(run => run.endsWith("SET default_transaction_read_only = on; SET statement_timeout = '5s' SELECT row_to_json(t) FROM (SELECT beacon, count(*) AS times FROM lightings GROUP BY 1 ORDER BY 2 DESC\n) t LIMIT 20"))).toBe(true)
    expect(text).toMatch(/^db answered 2 rows, each as JSON, secrets taken out:\n  \{"beacon":"nardol","times":4\}\n  \{"beacon":"erelas"/)
    expect(text).not.toMatch(/abcdef123456/)

    const before = runs.length

    expect(await ask($, 'database', { sql: 'SELECT 1; DELETE FROM orders' })).toMatch(/Only one statement is run/)
    expect(await ask($, 'database', { sql: 'DELETE FROM orders' })).toMatch(/Only a statement that reads is run/)
    expect(runs.slice(before).some(run => run.includes('DELETE'))).toBe(false)

    // What the database says of a statement it cannot run is handed back whole
    world.psql = { holds: holding() }
    expect(await ask($, 'database', { sql: 'SELECT nope FROM orders' })).toMatch(/db did not answer it: psql: error/)
  })

  test('hands a question typed in the pane to Claude, with the tables and how to answer it', async ($, on) => {
    machine(on, STORED)

    const prompts: string[] = []

    on('prompt.submit', (_, e) => {
      prompts.push(e.text)

      return { text: e.text } as never
    })

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-database' })
    await pane.input({ key: 'database-ask', text: '  ' })
    await pane.input({ key: 'database-ask', text: 'which order is the largest?' })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatch(/^About the database the runtime mod watches \(db: PostgreSQL, database shop, tables audit\.events, orders\):\n\nwhich order is the largest\?\n\nAnswer it by querying it with mcp__runtime__database \(target db\)/)
  })

  test('keeps what it last said, with why, when it does not answer', async ($, on) => {
    const { world } = machine(on, STORED)

    await ask($, 'database')

    world.psql = {}

    const text = await ask($, 'database')

    expect(text).toMatch(/It could not be asked \(psql: error: connection to server on socket.*\): what follows is what it last said\./)
    expect(text).toMatch(/orders: about 120 rows/)
  })

  test('is read off what its command line prints', () => {
    expect(isPostgres(['docker.io/library/postgres:18-alpine'])).toBe(true)
    expect(isPostgres(['pgvector/pgvector:pg17'])).toBe(true)
    expect(isPostgres(['prometheuscommunity/postgres-exporter:latest', 'redis:8'])).toBe(false)

    // The statement is an argument of its own: the shell reads none of it
    expect(psqlArgv('SELECT 1').slice(-2)).toEqual(['SET default_transaction_read_only = on', 'SELECT 1'])
    expect(readHolds('psql: error')).toBeUndefined()
    expect(readHolds(holding())?.tables.map(({ name }) => name)).toEqual(['audit.events', 'orders'])
    expect(rowsSql({ tables: readHolds(holding())?.tables ?? [] }, 'audit.events', 3)).toBe('SELECT row_to_json(t) FROM (SELECT * FROM "audit"."events" ORDER BY ctid DESC LIMIT 3) t')
    expect(rowsSql({ tables: [] }, 'orders', 3)).toBeUndefined()
    expect(readRows('{"id":2}\n{"id":1}\n')).toEqual(['{"id":1}', '{"id":2}'])
    expect(sizeText(16_384)).toBe('16 kB')
    expect(querySql('  TABLE orders -- all of it', 5)).toEqual({ sql: 'SELECT row_to_json(t) FROM (TABLE orders -- all of it\n) t LIMIT 5' })
    expect(askPrompt([], 'x')).toMatch(/^About the databases the runtime mod watches/)

    const sessions = readHolds(holding([{ pid: 1 }, { pid: 2, app: '' }, { pid: 3, state: 'active' }]))?.sessions ?? []

    expect(byState({ sessions })).toBe('2 idle, 1 active')
    expect(byApp({ sessions })).toBe('api 2, unnamed 1')
  })

  test('says once that the sessions it lets in are nearly all taken', () => {
    const full = readHolds(holding([{ pid: 1 }, { pid: 2 }, { pid: 3 }], 3))

    if (full === undefined) throw new Error('not read')

    const first = settleDatabase(undefined, full, 'db', NOW)

    expect(first.said).toEqual(['runtime: db: 3 of the 3 sessions it lets in are taken'])
    expect(settleDatabase(first.database, full, 'db', NOW + 5000).said).toEqual([])
  })
})

describe('a companion', () => {
  // A request that goes through the page's server and the one behind it, between two health checks
  const TRACED: Partial<World> = {
    files: { [`${CWD}/compose.yaml`]: 'services: {}' },
    services: { api: `${CWD}/api`, web: `${CWD}/web` },
    logs: {
      web: [`${at(1)} GET /health -> 200 in 1ms`, `${at(2)} GET /cart -> 200 in 40ms rid=r7a41`, `${at(6)} GET /health -> 200 in 1ms`],
      api: ['2026-10-13T10:00:02.010000000Z 2026-10-13T10:00:02.010Z loading the cart rid=r7a41', '2026-10-13T10:00:02.030000000Z {"level":"error","msg":"cart 12 has no owner","rid":"r7a41"}', `${at(3)} tick 1`, `${at(4)} tick 2`, `${at(5)} tick 3`],
    },
  }

  const prompted = (on: On) => {
    const prompts: { text: string; context: string }[] = []

    on('prompt.submit', (_, e) => {
      prompts.push({ text: e.text, context: (e.context ?? []).join('\n') })

      return { text: e.text } as never
    })

    return prompts
  }

  test('hands Claude the errors its edit brought, unasked and once: beside its next tool result, or with the next prompt', async ($, on) => {
    const { world } = machine(on, SHOP)
    const prompts = prompted(on)

    letEditsThrough(on)
    on('tool.call', { tool: 'Read' }, () => ({ result: { file: {} } }) as never)

    const pane = await mount($)
    const read = () => $.tool.call({ tool: 'Read', file_path: `${CWD}/api/src/auth.ts` } as never)

    await edit($, `${CWD}/api/src/auth.ts`)

    // Nothing new yet: nothing is said
    expect((await read()).context ?? []).toHaveLength(0)

    world.logs.api?.push(`${at(12)} {"level":"error","msg":"TypeError: verify is not a function"}`)
    await pane.press({ key: 'refresh' })

    const told = String((await read()).context)

    expect(told).toMatch(/api, since the edit to api\/src\/auth\.ts: 1 new kind of error\n.*x1 TypeError: verify is not a function/)
    expect(told).toMatch(/mcp__runtime__errors_since_edit/)
    expect((await read()).context ?? []).toHaveLength(0)

    // Between two turns, it goes with what the person says next
    world.logs.api?.push(`${at(14)} {"level":"error","msg":"RangeError: bad token length"}`)
    await pane.press({ key: 'refresh' })
    await $.prompt.submit({ text: 'does it work?' } as never)

    expect(prompts[0]?.context).toMatch(/x1 RangeError: bad token length/)
    expect(prompts[0]?.context).not.toMatch(/verify is not a function/)
    expect(prompts).toHaveLength(1)
  })

  test('asks Claude to look at once, where it guards the edits and no turn runs', { options: { guard: true } }, async ($, on) => {
    const { world } = machine(on, SHOP)
    const prompts = prompted(on)

    letEditsThrough(on)

    const pane = await mount($)

    await edit($, `${CWD}/api/src/auth.ts`)
    world.logs.api?.push(`${at(12)} {"level":"error","msg":"TypeError: verify is not a function"}`)
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'refresh' })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toMatch(/saw errors that first showed after an edit[\s\S]*TypeError: verify is not a function[\s\S]*Look into it: where the edit is the cause, fix it/)
  })

  test('shows every kind of error once, the new ones first, and hands one to Claude with what led to it', async ($, on) => {
    const { world } = machine(on, TRACED)
    const prompts = prompted(on)

    letEditsThrough(on)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-errors' })

    expect(await pane.find({ text: /1 kind of error · 0 new since the last edit/ })).toBeDefined()

    await edit($, `${CWD}/api/src/cart.ts`)
    world.logs.api?.push(`${at(20)} {"level":"error","msg":"TypeError: owner is undefined"}`)
    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /2 kinds of error · 1 new since the last edit/ })).toBeDefined()
    expect(await pane.find({ text: /2 Errors · 1 new/ })).toBeDefined()
    expect(await ask($, 'pane')).toMatch(/new · TypeError: owner is undefined[^\n]*\n[^\n]*cart 12 has no owner/)

    // The older one opens on its request, through both apps
    await pane.press({ key: 'error-1' })

    expect(await pane.find({ text: /The last time, with every line of its request/ })).toBeDefined()

    await pane.press({ key: 'error-diagnose' })

    expect(prompts[0]?.text).toMatch(/^Find why the running api, which the runtime mod watches, writes this error/)
    expect(prompts[0]?.text).toMatch(/\[web\] INFO  GET \/cart -> 200 in 40ms rid=r7a41\n.*\[api\] INFO  loading the cart rid=r7a41\n.*\[api\] ERROR cart 12 has no owner rid=r7a41/)
  })

  test('follows one request across the apps, and leaves out of the timeline what nobody reads', async ($, on) => {
    machine(on, TRACED)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    const shown = await ask($, 'pane')

    // The time an app wrote at the head of its own line is said once
    expect(shown).toMatch(/12:00:02 {2}INFO {3}\[api\] loading the cart rid=r7a41/)
    expect(shown).not.toMatch(/\/health/)
    expect(shown).toMatch(/\[api\] tick 3 ×3/)
    expect(shown).toMatch(/2 health checks left out/)

    await pane.press({ key: 'noise' })
    expect(await pane.find({ text: /GET \/health/ })).toBeDefined()
    await pane.press({ key: 'noise' })

    await pane.press({ key: 'line-0-follow' })

    expect(await pane.find({ text: /request r7a41: 3 lines through web \+0ms → api \+10ms for 20ms, 30ms from the first to the last, 1 of them an error/ })).toBeDefined()
    expect(await pane.find({ text: /tick/ })).toBeUndefined()

    await pane.press({ key: 'unfollow' })
    await pane.input({ key: 'logs-grep', text: 'TICK' })

    expect(await pane.find({ text: /3 lines hold "TICK"/ })).toBeDefined()
    expect(await pane.find({ text: /loading the cart/ })).toBeUndefined()

    expect(await ask($, 'logs', { request: 'r7a41' })).toMatch(/^request r7a41: 3 lines through web \+0ms → api[^\n]*\n {2}\+0ms .*\[web\] INFO  GET \/cart[^\n]*\n {2}\+10ms .*\[api\] INFO  loading the cart[^\n]*\n {2}\+30ms .*\[api\] ERROR cart 12 has no owner/)
    expect(await ask($, 'logs', { request: 'nope' })).toMatch(/No line held names the request nope/)
  })

  test('holds the timeline still while it is read', async ($, on) => {
    const { world } = machine(on, SHOP)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'pause' })

    world.logs.api?.push(`${at(40)} {"level":"info","msg":"written while paused"}`)
    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /written while paused/ })).toBeUndefined()
    expect(await pane.find({ text: /paused at/ })).toBeDefined()

    await pane.press({ key: 'pause' })
    expect(await pane.find({ text: /written while paused/ })).toBeDefined()
  })

  test('shows one app alone when its row is pressed, and all when it is pressed again', async ($, on) => {
    machine(on, SHOP)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'show-web' })

    expect(await pane.find({ text: /listening on 8080/ })).toBeUndefined()
    expect(await pane.find({ text: /All, not web alone/ })).toBeDefined()

    await pane.press({ key: 'show-web' })
    expect(await pane.find({ text: /listening on 8080/ })).toBeDefined()
  })

  test('counts the errors from a mark, and from when an app started over', { options: { attachments: 'api=docker:shop-api@api' } }, async ($, on) => {
    const { world } = machine(on, { status: { 'shop-api': JSON.stringify([{ State: { Status: 'running', StartedAt: '2026-10-13T09:00:00Z' }, RestartCount: 0 }]) }, logs: { 'shop-api': [`${at(1)} ERROR old trouble`] } })

    letEditsThrough(on)

    expect(await ask($, 'errors_since_edit', { since: 'mark' })).toMatch(/api: no mark is set on it\./)
    expect(await ask($, 'mark')).toMatch(/A mark is set on api at/)

    world.logs['shop-api']?.push('2026-10-13T10:00:31.000000000Z ERROR new trouble')

    const sinceMark = await ask($, 'errors_since_edit', { since: 'mark' })

    expect(sinceMark).toMatch(/api: 1 new error since the mark set at .*\n.*new trouble/)
    expect(sinceMark).not.toMatch(/old trouble/)

    // An edit is not what runs until the container takes it in
    await edit($, `${CWD}/api/main.py`)
    expect(await ask($, 'errors_since_edit')).toMatch(/no new error since the edit to api\/main\.py\. It has not started over since: unless it reloads its source by itself/)

    world.status['shop-api'] = JSON.stringify([{ State: { Status: 'running', StartedAt: '2026-10-13T10:00:32Z' }, RestartCount: 0 }])
    expect(await ask($, 'errors_since_edit')).toMatch(/no new error since the edit to api\/main\.py\. It started over at \S+, after the edit\./)
    expect(await ask($, 'errors_since_edit', { since: 'start' })).toMatch(/api: 1 new error since it started over at/)
  })

  test('keeps what was planned for the next session in the project', async ($, on) => {
    machine(on, SHOP)

    const stored: Record<string, unknown> = {}

    on('store.set', (_, e) => {
      stored[e.key] = e.value

      return { value: undefined } as never
    })

    await ask($, 'unit_plan', { suites: [{ name: 'api', command: ['npm', 'test'] }] })

    expect((stored[`plans:${CWD}`] as { suites: { name: string }[] }).suites.map(({ name }) => name)).toEqual(['api'])
  })

  test('draws the last figures as a line, and tells what only climbs', () => {
    expect(spark([])).toBe('')
    expect(spark([50, 50, 50, 50])).toBe('▁▁▁▁')
    expect(spark([10, 20, 40, 80])).toBe('▁▂▄█')
    expect(spark([10, -1, 80])).toBe('▁ █')

    const grown = Array.from({ length: 8 }, (_, index) => 100 + index * 10)

    expect(isClimbing(grown)).toBe(true)
    expect(isClimbing([...grown.slice(0, 7), 90])).toBe(false)
    expect(isClimbing([100, 100, 100, 100, 100, 100, 100, 100])).toBe(false)

    const usage = { cpu: 2, memory: 100, limit: 0, processes: 1, cpuSeconds: 0, at: 0, note: '' }

    expect(recorded(undefined, usage, 4)).toEqual({ cpu: [2], memory: [100], lag: [4] })
    expect(recorded({ cpu: [2], memory: [100], lag: [] }, { ...usage, note: 'not running' }, -1)).toEqual({ cpu: [2, -1], memory: [100, -1], lag: [] })
  })

  test('folds a line written several times running, never an error nor a request', () => {
    const line = (message: string, level: 'info' | 'error' = 'info') => ({ label: 'api', line: { at: 0, level, message, more: 0 } })
    const { rows, hidden } = quieted([line('tick 1'), line('tick 2'), line('GET /healthz 200'), line('tick 3'), line('GET /x rid=aaaa1'), line('GET /x rid=bbbb2'), line('boom 1', 'error'), line('GET /health 500', 'error')], false)

    expect(rows.map(({ line: { message }, times }) => `${message} x${times}`)).toEqual(['tick 3 x3', 'GET /x rid=aaaa1 x1', 'GET /x rid=bbbb2 x1', 'boom 1 x1', 'GET /health 500 x1'])
    expect(hidden).toBe(1)
    expect(traceSummary('aaaa1', traceOf([line('GET /x rid=aaaa1')], 'aaaa1'))).toMatch(/request aaaa1: 1 line through api \+0ms, 0ms from the first to the last$/)
  })

  test('sees an app start over: a restart, or a new revision rolled out', () => {
    const read = (started: string, restarts = 0) => ({ label: 'api', raws: [], cursor: EMPTY_WATCH.cursor, error: '', health: { state: 'up' as const, detail: '', restarts, started } })
    const first = settle({}, [read('1')], 100).watches

    expect(first.api?.rolledAt).toBeUndefined()
    expect(settle(first, [read('1')], 200).watches.api?.rolledAt).toBeUndefined()
    expect(settle(first, [read('2')], 300).watches.api?.rolledAt).toBe(300)
    expect(settle(first, [read('1', 1)], 400).watches.api?.rolledAt).toBe(400)
  })

  test("takes no line twice where the runtime hands back the cursor's whole second", () => {
    const stamp = (nanos: string) => `2026-10-13T10:00:05.${nanos}Z`
    const first = takePrinted('kubernetes', { stdout: [`${stamp('100000000')} one`, `${stamp('200000000')} two`].join('\n'), stderr: '' }, EMPTY_WATCH.cursor)

    expect(first.raws).toHaveLength(2)

    // `kubectl --since-time` counts in whole seconds: asked from the last line, it answers from the second's start
    const again = takePrinted('kubernetes', { stdout: [`${stamp('100000000')} one`, `${stamp('200000000')} two`, `${stamp('300000000')} three`].join('\n'), stderr: '' }, first.cursor)

    expect(again.raws).toEqual([`${stamp('300000000')} three`])
  })

  test('says where an error was raised, to Claude and in the logs when asked', async ($, on) => {
    const { world } = machine(on, SHOP)

    world.logs.api?.push(`${at(6)} TypeError: verify is not a function`, `${at(6)}     at verify (auth.ts:12:3)`, `${at(6)}     at handle (server.ts:40:9)`)

    expect(await ask($, 'errors_since_edit', { since: 'all', target: 'api' })).toMatch(/x1 TypeError: verify is not a function\n\s+at verify \(auth\.ts:12:3\)\n\s+at handle \(server\.ts:40:9\)/)
    expect(await ask($, 'logs', { level: 'error' })).toMatch(/TypeError: verify is not a function \(\+2 lines\)/)
    expect(await ask($, 'logs', { level: 'error', traces: true })).toMatch(/TypeError: verify is not a function\n\s+at verify \(auth\.ts:12:3\)/)
  })

  test('names the kinds of error in the status, and says them all before any edit', async ($, on) => {
    machine(on, SHOP)

    expect(await ask($, 'status')).toMatch(/^api .*1 error of 1 kind.*\n {2}x1, last at \S+: connect ECONNREFUSED/m)
    expect(await ask($, 'errors_since_edit', { target: 'api' })).toMatch(/no edit has been routed to it in this session\. It holds 1 kind of error from before: since "all" says it\./)
    expect(await ask($, 'errors_since_edit', { since: 'all' })).toMatch(/api: 1 kind of error, the ones the others follow first\.\n {2}\S+ x1 connect ECONNREFUSED[^\n]*\nweb: no error\./)
  })

  test('says which error another only follows, by the request they share', () => {
    const attachments = [{ label: 'api', runtime: 'compose' as const, ref: 'api', roots: [], port: 0 }, { label: 'web', runtime: 'compose' as const, ref: 'web', roots: [], port: 0 }]
    const failed = (rid: string) => [`{"level":"error","msg":"GET /stone failed: StoneIsWatched","rid":"${rid}"}`, `{"level":"error","msg":"GET /stone -> 500 in 3ms","rid":"${rid}"}`]
    const held = {
      api: absorb(EMPTY_WATCH, [...failed('aaaa1111'), ...failed('bbbb2222'), '{"level":"error","msg":"disk is full"}'], 1000),
      web: absorb(EMPTY_WATCH, ['{"level":"error","msg":"upstream answered 500","rid":"aaaa1111"}'], 2000),
    }
    const causes = causesOf(attachments, held, timeline(attachments, held))

    expect(Object.keys(causes).sort()).toEqual(['api\nGET /stone -> <n> in <n>ms', 'web\nupstream answered <n>'])
    expect(causes['web\nupstream answered <n>']).toEqual({ label: 'api', sample: 'GET /stone failed: StoneIsWatched' })
  })

  test(
    "reads a workload through its pods: why one is not ready, every replica's lines, and what a dead container wrote last",
    { options: { attachments: 'api=k8s:shop/deployment/api@api' } },
    async ($, on) => {
      const pod = (name: string, container: Record<string, unknown>) => ({ metadata: { name }, status: { phase: 'Running', containerStatuses: [{ name: 'api', ...container }] } })
      const { runs } = machine(on, {
        status: {
          'deployment/api': JSON.stringify({ kind: 'Deployment', spec: { replicas: 2, selector: { matchLabels: { app: 'api' } } }, status: { readyReplicas: 1 } }),
          '-l app=api': JSON.stringify({
            items: [
              pod('api-1', { ready: true, restartCount: 0, state: { running: {} } }),
              pod('api-2', { ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error', finishedAt: '2026-10-13T10:00:07Z' } } }),
            ],
          }),
        },
        logs: { '-l app=api': [`${at(4)} api-2 starting`, `${at(2)} api-1 listening`], 'previous pod/api-2': [`${at(6)} ERROR api-2 cannot reach the database`] },
      })

      expect(await ask($, 'status')).toMatch(/^api \(Kubernetes shop\/deployment\/api\): degraded, 1\/2 ready, CrashLoopBackOff; 4 restarts; 1 error of 1 kind/m)
      expect(runs).toContain('kubectl get pods -n shop -l app=api -o json')
      expect(runs).toContain('kubectl logs -n shop -l app=api --timestamps --all-containers --max-log-requests=20 --tail=200')
      expect(runs).toContain('kubectl logs pod/api-2 -n shop -c api --previous --timestamps --tail=50')
      // The pods' lines as one, in the order they were written
      expect((await ask($, 'logs')).match(/api-\d \w+/g)).toEqual(['api-1 listening', 'api-2 starting', 'api-2 cannot'])
    },
  )

  test('asks a dead container for its last words only when it died since the last read', () => {
    const api = { label: 'api', runtime: 'kubernetes' as const, ref: 'shop/deployment/api', roots: [], port: 0 }
    const pods = JSON.stringify({ items: [{ metadata: { name: 'api-2' }, status: { containerStatuses: [{ name: 'api', restartCount: 4, state: { running: {} }, lastState: { terminated: { finishedAt: '2026-10-13T10:00:07Z' } } }] } }] })

    // Running again on a first read: what it wrote before is of another time
    expect(previousArgvs(api, pods, '')).toEqual([])
    expect(previousArgvs(api, pods, at(9))).toEqual([])
    expect(previousArgvs(api, pods, at(5))).toEqual([['kubectl', 'logs', 'pod/api-2', '-n', 'shop', '-c', 'api', '--previous', '--timestamps', `--since-time=${at(5)}`]])
  })

  test('tells the files written between two looks from the ones only committed', () => {
    const before = { 'api/a.ts': 100, 'api/b.ts': 100, 'api/c.ts': 100 }

    // a written again, b committed (it left the list, its time unchanged), c reverted, d new, e deleted, f only now seen
    expect(editedBetween(before, { 'api/a.ts': 300, 'api/b.ts': 100, 'api/c.ts': 250, 'api/d.ts': 260, 'api/e.ts': -1, 'api/f.ts': 150 }, 200).sort()).toEqual(['api/a.ts', 'api/c.ts', 'api/d.ts', 'api/e.ts'])
  })

  test('counts an edit made by a shell command, and the errors it had already brought', async ($, on) => {
    const { world } = machine(on, { ...SHOP, dirty: [] })

    on('tool.call', { tool: 'Bash' }, () => {
      // The command writes a file of the api, which crashes on it before anything is read
      world.dirty = ['api/src/auth.ts']
      world.mtimes[`${CWD}/api/src/auth.ts`] = NOW + 1000
      world.logs.api?.push(`2026-10-13T10:00:32.000000000Z {"level":"error","msg":"SyntaxError: unexpected token"}`)

      return { result: 'done' } as never
    })

    await ask($, 'status')

    const ran = await $.tool.call({ tool: 'Bash', command: "sed -i s/a/b/ api/src/auth.ts" } as never)

    expect(String(ran.context)).toMatch(/The runtime mod watches the running api, kafka/)

    const text = await ask($, 'errors_since_edit', { target: 'api' })

    expect(text).toMatch(/api: 1 new error since the edit to api\/src\/auth\.ts\./)
    expect(text).toMatch(/SyntaxError: unexpected token/)
    expect(text).not.toMatch(/ECONNREFUSED/)
    expect(await ask($, 'errors_since_edit', { target: 'web' })).toMatch(/web: no edit has been routed to it/)
  })

  test('counts an edit once, whether the Edit tool or the look at the working tree finds it', async ($, on) => {
    const { world } = machine(on, { ...SHOP, dirty: [] })

    on('tool.call', { tool: 'Edit' }, (_, e) => {
      world.dirty = ['api/src/auth.ts']
      world.mtimes[`${CWD}/api/src/auth.ts`] = NOW + 1000

      return { result: { filePath: e.file_path } } as never
    })
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'done' }) as never)

    await $.tool.call({ tool: 'Bash', command: 'true' } as never)
    await edit($, `${CWD}/api/src/auth.ts`)
    world.logs.api?.push(`${at(40)} {"level":"error","msg":"TypeError: verify is not a function"}`)
    // Read as new since the edit: counted again by the look, the edit would make it an old one
    await ask($, 'status')
    await $.tool.call({ tool: 'Bash', command: 'git commit -am wip' } as never)

    expect(await ask($, 'errors_since_edit', { target: 'api' })).toMatch(/api: 1 new error since the edit to api\/src\/auth\.ts\./)
  })

  test('takes nothing of a trace a first read starts in the middle of', () => {
    const filler = Array.from({ length: 200 }, (_, index) => `${at(10)} GET /beacons -> 200 in ${index}ms`)
    const cut = [`${at(9)}   File "gondor/realm.py", line 32, in light`, `${at(9)}     return RELAY[name]`, `${at(9)} KeyError: 'halifirien'`]
    const { raws } = takePrinted('kubernetes', { stdout: [...cut, ...filler].join('\n'), stderr: '' }, EMPTY_WATCH.cursor)

    expect(raws).toHaveLength(200)
    expect(absorb(EMPTY_WATCH, raws, NOW).signatures).toHaveLength(0)

    // A log shorter than what was asked for starts where it starts: its first lines are whole
    const whole = takePrinted('kubernetes', { stdout: ['Traceback (most recent call last):', '  File "gondor/app.py", line 9', 'SyntaxError: invalid syntax'].map(text => `${at(9)} ${text}`).join('\n'), stderr: '' }, EMPTY_WATCH.cursor)

    expect(absorb(EMPTY_WATCH, whole.raws, NOW).signatures.map(({ sample }) => sample)).toEqual(['Traceback (most recent call last): SyntaxError: invalid syntax'])
  })

  test('names in the status the error the others follow before them', () => {
    const api = { label: 'api', runtime: 'compose' as const, ref: 'api', roots: [], port: 0 }
    const failed = (rid: string) => [`{"level":"error","msg":"GET /stone failed: StoneIsWatched","rid":"${rid}"}`, `{"level":"error","msg":"GET /stone -> 500 in 3ms","rid":"${rid}"}`]
    const text = statusText([api], { api: absorb(EMPTY_WATCH, [...failed('aaaa1111'), ...failed('bbbb2222')], 1000) })

    expect(text.indexOf('GET /stone failed')).toBeGreaterThan(0)
    expect(text.indexOf('GET /stone failed')).toBeLessThan(text.indexOf('GET /stone -> 500'))
  })

  test('tells which of two apps wrote first within one millisecond', () => {
    const attachments = [{ label: 'anor', runtime: 'compose' as const, ref: 'anor', roots: [], port: 0 }, { label: 'gondor', runtime: 'compose' as const, ref: 'gondor', roots: [], port: 0 }]
    const held = {
      anor: absorb(EMPTY_WATCH, ['2026-10-13T10:00:09.845987528Z {"level":"error","msg":"POST /light -> 500 in 5ms","rid":"8ec3bcac"}'], NOW),
      gondor: absorb(EMPTY_WATCH, ['2026-10-13T10:00:09.845282117Z {"level":"error","msg":"POST /light failed: KeyError","rid":"8ec3bcac"}'], NOW),
    }

    expect(timeline(attachments, held).map(({ label }) => label)).toEqual(['gondor', 'anor'])
    expect(causesOf(attachments, held, timeline(attachments, held))).toEqual({ 'anor\nPOST /light -> <n> in <n>ms': { label: 'gondor', sample: 'POST /light failed: KeyError' } })

    // Where the times kept tie, the error with a trace under it is the one the other follows
    const tied = {
      anor: absorb(EMPTY_WATCH, ['2026-10-13T10:00:09.845Z {"level":"error","msg":"POST /light -> 500 in 5ms","rid":"8ec3bcac"}'], NOW),
      gondor: absorb(EMPTY_WATCH, ['2026-10-13T10:00:09.845Z {"level":"error","msg":"POST /light failed: KeyError","rid":"8ec3bcac"}', '2026-10-13T10:00:09.845Z   File "gondor/realm.py", line 32, in light'], NOW),
    }

    expect(Object.keys(causesOf(attachments, tied, timeline(attachments, tied)))).toEqual(['anor\nPOST /light -> <n> in <n>ms'])
  })
})
