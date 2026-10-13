import type { Attachment, Broker, BrokerRecord, Facts, Group, GroupPartition, Kind as AttachmentKind, Topic } from '../types'
import { clockTime, redact } from './lines'

// What a broker holds, read off what its own command line prints: its topics, its consumer groups and how far
// behind each is, the last records of a topic. Text in, values and text out. Only Redpanda's `rpk` is asked: it
// stands in the broker's own image and prints JSON. The commands here read; none writes a record or moves a group.

type Kind = Broker['kind']

/** What kind of broker runs these images; `undefined` for anything else. Redpanda's console is no broker. */
export const brokerKind = (images: readonly string[]): Kind | undefined => {
  const names = images.map(image => (image.split('/').pop() ?? '').split(/[:@]/)[0] ?? '')

  return names.includes('redpanda') ? 'redpanda' : names.some(name => /^(cp-)?kafka$/.test(name)) ? 'kafka' : undefined
}

export const KIND_NAME: Record<Kind, string> = { redpanda: 'Redpanda', kafka: 'Kafka' }

const DATABASE: [RegExp, string][] = [[/^(postgres(ql)?|postgis|timescaledb|pgvector)$/, 'PostgreSQL']]

/**
 * What an attachment is, told by the images it runs: a broker, a database, or an app, which is anything else. The
 * engine is what a broker or a database runs, by its name. `undefined` where no image is known: it is what it was.
 */
export const kindOf = (images: readonly string[]): { kind: AttachmentKind; engine: string } | undefined => {
  if (images.length === 0) return undefined

  const names = images.map(image => (image.split('/').pop() ?? '').split(/[:@]/)[0] ?? '')
  const broker = brokerKind(images)
  const database = DATABASE.find(([looks]) => names.some(name => looks.test(name)))

  return broker !== undefined ? { kind: 'broker', engine: KIND_NAME[broker] } : database !== undefined ? { kind: 'database', engine: database[1] } : { kind: 'app', engine: '' }
}

/** The kinds in the order they are shown, each with what one and several of it are called. */
export const KINDS: { kind: AttachmentKind; one: string; many: string }[] = [
  { kind: 'app', one: 'app', many: 'apps' },
  { kind: 'broker', one: 'broker', many: 'brokers' },
  { kind: 'database', one: 'database', many: 'databases' },
]

const UNREAD = "A Kafka broker, told by its image, and not read: palantir asks a broker through Redpanda's own rpk, which this image does not hold. Its log is read as any other."

/** Every topic with its partitions' offsets, and every consumer group with where it stands: run inside the broker. */
export const TOPICS_ARGV = ['rpk', 'topic', 'describe', '-r', '.*', '-p', '--format', 'json'] as const
export const GROUPS_ARGV = ['rpk', 'group', 'describe', '-r', '.*', '--format', 'json'] as const

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

/** The topics `rpk topic describe` printed, the broker's own (`__consumer_offsets`, `_schemas`) left out. */
export const readTopics = (stdout: string): Topic[] =>
  list(parsed(stdout))
    .map(record)
    .filter(topic => record(topic.summary).internal !== true && !word(record(topic.summary).name).startsWith('_') && word(record(topic.summary).name) !== '')
    .map(topic => {
      const partitions = list(topic.partitions).map(record)

      return {
        name: word(record(topic.summary).name),
        sizes: partitions.map(partition => Math.max(0, count(partition.high_watermark) - count(partition.log_start_offset))),
        end: partitions.reduce((sum, partition) => sum + count(partition.high_watermark), 0),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1))

/** The consumer groups `rpk group describe` printed; when each last took a record is known only from one read to the next. */
export const readGroups = (stdout: string): Omit<Group, 'movedAt'>[] =>
  list(parsed(stdout))
    .map(record)
    .filter(group => word(group.group_name) !== '')
    .map(group => {
      const partitions = list(group.partitions)
        .map(record)
        .map((partition): GroupPartition => ({
          topic: word(partition.topic),
          partition: count(partition.partition),
          offset: typeof partition.current_offset === 'number' ? partition.current_offset : -1,
          end: count(partition.log_end_offset),
          lag: Math.max(0, count(partition.lag)),
        }))

      return {
        name: word(group.group_name),
        state: word(group.state) || 'unknown',
        members: count(group.members),
        lag: Math.max(0, count(group.total_lag)),
        partitions,
        taken: partitions.reduce((sum, { offset }) => sum + Math.max(0, offset), 0),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1))

/** A broker that is known for one and cannot be asked. */
export const unreadBroker = (kind: Kind, note: string, now: number, was?: Broker): Broker => ({ ...was, kind, at: now, note, topics: was?.topics ?? [], groups: was?.groups ?? [] })

/** What is said of a Kafka broker, which has no rpk to ask. */
export const kafkaBroker = (now: number): Broker => unreadBroker('kafka', UNREAD, now)

/**
 * The broker once a read is taken in, and what there is to tell the person: a group whose last member left, told
 * once. A group that marked nothing more as read keeps the time it last did.
 */
export const settleBroker = (was: Broker | undefined, read: { topics: Topic[]; groups: Omit<Group, 'movedAt'>[] }, label: string, now: number): { broker: Broker; said: string[] } => {
  const before = new Map((was?.groups ?? []).map(group => [group.name, group]))

  const groups = read.groups.map((group): Group => {
    const held = before.get(group.name)

    return { ...group, movedAt: held !== undefined && held.taken === group.taken ? held.movedAt : now }
  })

  const said = groups
    .filter(group => group.members === 0 && (before.get(group.name)?.members ?? 0) > 0)
    .map(({ name, lag }) => `palantir: ${label}: the group ${name} has no member left${lag > 0 ? `, ${lag} record${lag === 1 ? '' : 's'} wait${lag === 1 ? 's' : ''}` : ''}`)

  return { broker: { ...was, kind: 'redpanda', at: now, note: '', topics: read.topics, groups }, said }
}

/** The broker once an edit is counted: each group's lag as it stands is kept, to say what the edit did to it. */
export const markedBroker = (broker: Broker, path: string, now: number): Broker => ({
  ...broker,
  lagAtEdit: Object.fromEntries(broker.groups.map(({ name, lag }) => [name, lag])),
  editedPath: path,
  editedAt: now,
})

// A group with records waiting that has marked none as read for this long is said stuck, not slow
const STUCK_MS = 30_000

const records = (many: number): string => `${many} record${many === 1 ? '' : 's'}`

/** How long a group that has records waiting has taken none, in seconds; 0 for one that keeps up or still takes. */
export const stuckFor = ({ lag, movedAt }: Group, now: number): number => (lag > 0 && now - movedAt >= STUCK_MS ? Math.round((now - movedAt) / 1000) : 0)

/** How a group stands, in a few words: what its lag was before the last edit, and whether it still takes records. */
export const standing = (group: Group, { lagAtEdit, editedPath }: Broker, now: number): string => {
  const before = lagAtEdit?.[group.name]
  const stuck = stuckFor(group, now)

  return [
    group.members === 0 ? 'nobody reads' : '',
    stuck > 0 ? `nothing taken for ${stuck}s` : '',
    before === undefined || before === group.lag ? '' : `lag was ${before} before the edit to ${editedPath ?? ''}`,
    before === undefined && group.lag > 0 && lagAtEdit !== undefined ? `new since the edit to ${editedPath ?? ''}` : '',
  ]
    .filter(part => part !== '')
    .join(', ')
}

/** The topics a group reads, each once. */
export const topicsOf = ({ partitions }: Group): string[] => [...new Set(partitions.map(({ topic }) => topic))]

/** A broker in a line, for the answer that says how every app stands; empty for one with nothing to say. */
export const brokerLine = (broker: Broker | undefined, now: number): string => {
  if (broker === undefined) return ''
  if (broker.note !== '' && broker.groups.length === 0 && broker.topics.length === 0) return `  a ${KIND_NAME[broker.kind]} broker: ${broker.note}`

  const behind = broker.groups.filter(({ lag }) => lag > 0)

  return [
    `  a ${KIND_NAME[broker.kind]} broker: ${broker.topics.length} topic${broker.topics.length === 1 ? '' : 's'}, ${broker.groups.length} consumer group${broker.groups.length === 1 ? '' : 's'}`,
    behind.length === 0 ? 'none behind' : `behind: ${behind.map(group => `${group.name} by ${group.lag}${stuckFor(group, now) > 0 ? ' and taking nothing' : ''}`).join(', ')}`,
    'mcp__palantir__broker says more',
  ].join('; ')
}

const describeBroker = (label: string, broker: Broker, now: number): string => {
  const { kind, topics, groups, note, at } = broker

  return [
    `${label} (${KIND_NAME[kind]}), asked at ${clockTime(at)}:${note === '' ? '' : ` ${note}`}`,
    ...(kind === 'kafka'
      ? []
      : [
          topics.length === 0 ? '  No topic.' : '  Topics:',
          ...topics.map(({ name, sizes, end }) => `    ${name}: ${sizes.length} partition${sizes.length === 1 ? '' : 's'}, ${records(sizes.reduce((sum, size) => sum + size, 0))} held, ${end} written in all`),
          groups.length === 0 ? '  No consumer group: nothing reads these topics as a group.' : '  Consumer groups:',
          ...groups.flatMap(group => {
            const how = standing(group, broker, now)

            return [
              `    ${group.name}: ${group.state}, ${group.members} member${group.members === 1 ? '' : 's'}, reads ${topicsOf(group).join(', ') || 'no topic'}, lag ${group.lag}${how === '' ? '' : ` (${how})`}`,
              ...group.partitions.filter(({ lag }) => lag > 0).map(({ topic, partition, offset, end, lag }) => `      ${topic}/${partition}: ${offset < 0 ? 'nothing marked as read' : `read up to ${offset}`} of ${end}, ${records(lag)} waiting`),
            ]
          }),
        ]),
  ].join('\n')
}

export const NO_BROKER =
  "No watched app is a broker palantir reads. A Redpanda container, compose service or Kubernetes workload is told by its image and asked through its own rpk, with nothing to set: watch it like any other app, in the compose file or as a line of .claude/palantir."

type Known = Record<string, Facts>

/** The brokers among the attachments, or the one asked for: each with its topics and its consumer groups. */
export const brokerText = (attachments: readonly Attachment[], known: Known, ask: { target?: unknown }, now: number): string => {
  const target = typeof ask.target === 'string' ? ask.target.trim() : ''
  const brokers = attachments.flatMap(({ label }) => (known[label]?.broker === undefined || (target !== '' && label !== target) ? [] : [{ label, broker: known[label].broker }]))

  if (brokers.length > 0) return brokers.map(({ label, broker }) => describeBroker(label, broker, now)).join('\n')
  if (target !== '' && attachments.some(({ label }) => label === target)) return `${target} is not a broker palantir reads. ${NO_BROKER}`

  return NO_BROKER
}

const MAX_PEEK = 20
const MAX_VALUE = 300

/** How many of a topic's last records are asked for, from each partition: 5 when none is said, 20 at most. */
export const peekEach = (limit: unknown): number => (typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(MAX_PEEK, Math.round(limit))) : 5)

/**
 * The command that prints a topic's last records, `each` from every partition, run inside the broker. It reads as
 * no group, so nothing is marked as read. It is told how many records to wait for, which is how many there are:
 * asked for more, it would wait for them to be written. `undefined` for a topic that holds none.
 */
export const peekArgv = ({ name, sizes }: Topic, each: number): readonly string[] | undefined => {
  const there = sizes.reduce((sum, size) => sum + Math.min(each, size), 0)

  return there === 0 ? undefined : ['rpk', 'topic', 'consume', name, '-o', `-${each}`, '-n', String(there)]
}

export type Peeked = BrokerRecord

/** The records `rpk topic consume` printed, one JSON object after another, oldest first, the secrets out of each. */
export const readRecords = (stdout: string): Peeked[] =>
  stdout
    // Each object ends on a line of its own brace: what it holds is set in
    .split(/^\}$/m)
    .map(text => record(parsed(`${text}}`)))
    .filter(found => typeof found.offset === 'number')
    .map(found => ({
      partition: count(found.partition),
      offset: count(found.offset),
      at: count(found.timestamp),
      key: redact(word(found.key)),
      headers: redact(list(found.headers).map(record).map(header => `${word(header.key)}=${word(header.value)}`).join(' ')),
      value: redact(word(found.value)).slice(0, MAX_VALUE),
    }))
    .sort((a, b) => a.at - b.at || a.partition - b.partition || a.offset - b.offset)

/** The records that hold the text in their key, their headers or their value, whatever its case; all of them for none. */
export const matching = (peeked: readonly Peeked[], grep: unknown): Peeked[] => {
  const needle = typeof grep === 'string' ? grep.trim().toLowerCase() : ''

  return peeked.filter(({ key, headers, value }) => needle === '' || `${key} ${headers} ${value}`.toLowerCase().includes(needle))
}

/** A topic's last records as text, under a line that says what they are. */
export const peekText = (label: string, topic: string, peeked: readonly Peeked[], grep = ''): string =>
  [
    `The last ${records(peeked.length)} of ${topic} on ${label}${grep === '' ? '' : ` that hold ${grep}`}, oldest first, read as no group (nothing is marked as read), secrets taken out:`,
    ...peeked.map(({ partition, offset, at, key, headers, value }) => `  ${clockTime(at)} ${topic}/${partition}@${offset}${key === '' ? '' : ` key=${key}`}${headers === '' ? '' : ` [${headers}]`} ${value}`),
  ].join('\n')

/**
 * What is handed to Claude when the person asks something of the brokers in the pane: their question, the brokers
 * it is asked of with their topics and their groups, and how to answer it.
 */
export const askBrokerPrompt = (brokers: readonly { label: string; broker: Broker }[], question: string): string =>
  [
    `About ${brokers.length === 1 ? 'the broker' : 'the brokers'} palantir watches (${brokers
      .map(
        ({ label, broker }) =>
          `${label}: ${KIND_NAME[broker.kind]}, ${broker.topics.length === 0 ? 'no topic' : `topics ${broker.topics.map(({ name }) => name).join(', ')}`}, ${broker.groups.length === 0 ? 'no consumer group' : `consumer groups ${broker.groups.map(({ name }) => name).join(', ')}`}`,
      )
      .join('; ')}):`,
    '',
    question.trim(),
    '',
    `Answer it by asking ${brokers.length === 1 ? 'it' : 'them'} with mcp__palantir__broker${brokers.length === 1 ? ` (target ${brokers[0]?.label ?? ''})` : ''}: alone it says the topics, the consumer groups and how far behind each is; with \`topic\` it reads the last records of that topic too, up to 20 from each partition with \`limit\`, and \`grep\` keeps those that hold a text. Say what you read along with the answer. If it cannot be answered by reading, say so: no record is to be written and no group moved.`,
  ].join('\n')

/** What is handed to Claude when the person asks why a consumer group does not keep up: the groups behind, as they stand. */
export const diagnoseGroupsPrompt = (label: string, broker: Broker, now: number): string => {
  const behind = broker.groups.filter(group => group.lag > 0 || (group.members === 0 && group.partitions.length > 0))

  return [
    `Find why ${behind.length === 1 ? 'this consumer group' : 'these consumer groups'} of the broker ${label}, which palantir watches, ${behind.length === 1 ? 'does' : 'do'} not keep up:`,
    '',
    ...behind.map(group => `  ${group.name} (reads ${topicsOf(group).join(', ') || 'no topic'}): ${group.state}, ${group.members} member${group.members === 1 ? '' : 's'}, ${group.lag} behind; ${standing(group, broker, now)}`),
    '',
    `mcp__palantir__broker (target ${label}) says the lag partition by partition, and with \`topic\` reads the last records of a topic: the record a group is stuck on is the one after the offset it has marked. mcp__palantir__logs says what the app that consumes wrote, and mcp__palantir__status whether it runs. Fix the cause in the consumer's code where it is there; say so where it is not (a consumer that is down, a record that cannot be read). No record is to be written and no group moved.`,
  ].join('\n')
}
