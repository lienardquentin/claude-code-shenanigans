import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { composeAttachments, parseList, routed } from '../hooks/attach'
import { absorb, EMPTY_WATCH, fresh, read, redact, signatureOf } from '../hooks/lines'
import { localUsage, readEnvFile, readWindowsProbe } from '../hooks/local'
import { readHealth } from '../hooks/runtime'

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
  const world: World = { files: {}, services: {}, logs: {}, stderr: {}, status: {}, env: {}, stats: {}, top: '', listening: '', processes: '', ...(JSON.parse(JSON.stringify(given)) as Partial<World>) }
  const runs: string[] = []
  const toasts: string[] = []

  mock.clock(on, { now: NOW })
  on('session.cwd', () => ({ value: CWD }) as never)
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))

    return { value: undefined } as never
  })
  on('fs.exists', (_, e) => ({ value: plain(e.path) in world.files }) as never)
  on('fs.read', (_, e) => ({ value: world.files[plain(e.path)] }) as never)
  on('fs.stat', (_, e) => ({ value: { kind: plain(e.path) in world.files ? 'file' : 'other', size: 0, mtimeMs: NOW - 2000, isLink: false } }) as never)
  on('process.run', (_, e) => {
    const argv = e.argv
    const line = argv.join(' ')
    const name = argv[argv.length - 1] ?? ''

    runs.push(line)

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
    if (argv[0] === 'ps') return exited(0, world.processes)
    if (argv[0] === 'kubectl' && argv.includes('top')) return world.top === '' ? exited(1, '', 'error: Metrics API not available') : exited(0, world.top)

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

const mount = ($: Engine) => $.ui.mount({ plugin: 'palantir', surface: 'terminal', component: 'Pane', props: PANE as never, requestId: 'palantir' })

const ask = async ($: Engine, tool: string, input: Record<string, unknown> = {}) =>
  String((await $.tool.call({ tool: `mcp__palantir__${tool}`, ...input } as never)).result)

const edit = ($: Engine, path: string) => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' } as never)

// The Edit tool itself, beneath the mod: every edit goes through
const letEditsThrough = (on: On) => on('tool.call', { tool: 'Edit' }, (_, e) => ({ result: { filePath: e.file_path } }) as never)

describe('palantir', () => {
  test('says how to attach where nothing is, and asks Docker nothing without a compose file', async ($, on) => {
    const { runs } = machine(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /nothing attached/ })).toBeDefined()
    expect(await pane.find({ text: /name anything else in \.claude\/palantir/ })).toBeDefined()
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

  test('tells the errors an edit brought from the ones that were there', async ($, on) => {
    const { world, toasts } = machine(on, SHOP)

    letEditsThrough(on)

    const edited = await edit($, `${CWD}/api/src/auth.ts`)

    // Said to the model once, with the first edit of a watched app
    expect(String(edited.context)).toMatch(/palantir watches the running api, kafka/)

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

      expect(status).toMatch(/^api \(Docker shop-api\): down, OOMKilled; 3 restarts; 0 errors/m)
      expect(status).toMatch(/^kafka \(Kubernetes prod-eu\/staging\/statefulset\/kafka\): degraded, 2\/3 ready/m)
      expect(status).toMatch(/^web \(local \/home\/dev\/app\/logs\/web\.log\): up, wrote 2s ago; 1 errors in 1 kinds/m)

      expect(runs).toContain('docker logs --timestamps --tail 200 shop-api')
      expect(runs).toContain('kubectl --context prod-eu logs statefulset/kafka -n staging --timestamps --all-containers --tail=200')
      expect(runs).toContain('kubectl --context prod-eu get statefulset/kafka -n staging -o json')

      const logs = await ask($, 'logs')

      expect(logs.indexOf('no config file')).toBeLessThan(logs.indexOf('[api] INFO  started'))
      expect(logs).toMatch(/\[web\] ERROR \[error\] Failed to resolve import/)
      // A line still being written waits for its end
      expect(logs).not.toMatch(/half a li/)

      expect(toasts.filter(toast => toast === 'palantir: api is down (OOMKilled)')).toHaveLength(1)
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
    expect(text).toMatch(/^cron: no port named: end its line in \.claude\/palantir with #<port>$/m)

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
    const render = (component: string, chain: string[], count: number) => JSON.stringify({ level: 20, time: NOW - 1000, msg: 'render', palantir: 'render', component, chain, count })
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
    const render = (chain: string[], values: (string | null)[]) => JSON.stringify({ level: 20, time: NOW - 1000, palantir: 'render', component: 'Lamp', chain, values, count: 1 })
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
      palantir: 'render',
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
    const page = (elements: unknown[], left = 0) => JSON.stringify({ level: 20, time: NOW - 1000, msg: 'page / drawn', palantir: 'dom', url: '/', title: 'Anor', elements, left })
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
    expect(await ask($, 'logs')).not.toMatch(/drawn|palantir/)

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    expect(await ask($, 'pane')).toMatch(/\[Tree\]\* {2}\[DOM\]\n\s*No render has been reported\./)

    await pane.press({ key: 'renders-dom' })

    // The last page said: an element that only holds the next is on its row, a component's outermost element named
    const shown = await ask($, 'pane')

    expect(shown).toMatch(/\[Tree\] {2}\[DOM\]\*\n.*\n\s*Anor at \/, 8 elements, as it stood at \S+\n\s*body › div#__nuxt › main\.grid\n\s*├─ section\.card {2}<BeaconChain>\n\s*│  ├─ h2 {2}"The beacons"\n\s*│  └─ button\.lit {2}aria-label="Light Amon Dîn" aria-pressed="true" type="button" {2}"Amon Dîn"\n\s*└─ form {2}<MusterForm>\n\s*└─ input {2}name="apiToken" type="password"\n\s*12 more elements than a report holds are left out\./)
    expect(shown).not.toMatch(/Loading/)

    // The page changes: the next read shows it as it stands then
    world.files[`${CWD}/logs/web.log`] += `${page([[0, 'body', '', '', ''], [1, 'p', '', 'Gondor does not answer', '']])}\n`
    await pane.press({ key: 'refresh' })
    expect(await ask($, 'pane')).toMatch(/Anor at \/, 2 elements, as it stood at \S+\n\s*body › p {2}"Gondor does not answer"/)

    await pane.press({ key: 'renders-tree' })
    expect(await ask($, 'pane')).toMatch(/\[Tree\]\* {2}\[DOM\]/)
  })

  test('says how a frontend reports its page where none has', { options: { attachments: 'web=local:logs/web.log@web' } }, async ($, on) => {
    machine(on, { files: { [`${CWD}/logs/web.log`]: 'vite ready in 310 ms\n' } })

    await ask($, 'logs')

    const pane = await mount($)

    await pane.press({ key: 'view-renders' })
    await pane.press({ key: 'renders-dom' })
    expect(await ask($, 'pane')).toMatch(/\[Tree\] {2}\[DOM\]\*\n\s*No page has been reported\. A frontend reports its page by writing a JSON line/)
  })
  test('says how a frontend reports its renders where none has', async ($, on) => {
    machine(on, SHOP)

    expect(await ask($, 'renders')).toMatch(/^No render has been reported\. A frontend reports one by writing a JSON line/)
  })

  test('hands the model what the pane shows, as text', async ($, on) => {
    machine(on, SHOP)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    const text = await ask($, 'pane')

    expect(text).toMatch(/palantir {2}read \d\d:\d\d:\d\d/)
    expect(text).toMatch(/api\s+Compose\s+up · running\s+1/)
    expect(text).toMatch(/\[api\] connect ECONNREFUSED/)
    expect(text).toMatch(/\[Refresh\]/)
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

    expect(crashed.lines).toEqual([{ at: 1000, level: 'error', message: 'Process SpawnProcess-2: SyntaxError: invalid syntax', more: 3 }])
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
