import type { Attachment, Database, DbSession, DbTable, Facts } from '../types'
import { clockTime, redact } from './lines'

// What a database holds, read off what its own command line prints: who is connected and what each session does,
// its tables and how much each holds, the last rows of a table. Text in, values and text out. Only PostgreSQL's
// `psql` is asked: it stands in the database's own image, where it is let in with no password. Every command here
// runs with writing turned off; none changes a row.

const IMAGE = /^(postgres(ql)?|postgis|timescaledb|pgvector)$/

/** Whether these images run a PostgreSQL, whose `psql` can be asked. */
export const isPostgres = (images: readonly string[]): boolean => images.some(image => IMAGE.test((image.split('/').pop() ?? '').split(/[:@]/)[0] ?? ''))

// The user and the database the image was started with are in its own environment; the statements are handed over
// as arguments, so nothing of them is read by the shell
const PSQL = 'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" -c "$0" -c "$1"'
const READ_ONLY = 'SET default_transaction_read_only = on'

// A statement somebody wrote is given this long, and no longer
const BOUNDED = `${READ_ONLY}; SET statement_timeout = '5s'`

/** The command that has the database answer one statement, run inside it, with writing turned off; `isBounded`, cut short where it runs long. */
export const psqlArgv = (sql: string, isBounded = false): readonly string[] => ['sh', '-c', PSQL, isBounded ? BOUNDED : READ_ONLY, sql]

const MAX_QUERY = 300

/**
 * Everything said of a database, as one JSON object on one line: the sessions of its clients (palantir's own left
 * out) and its tables, with what the database counted of each. Only the database the image was started with.
 */
export const HOLDS_SQL = `SELECT json_build_object(
  'name', current_database(),
  'version', current_setting('server_version'),
  'bytes', pg_database_size(current_database()),
  'max', current_setting('max_connections')::int,
  'sessions', (SELECT coalesce(json_agg(s ORDER BY s.pid), '[]'::json) FROM (
    SELECT pid, coalesce(usename, '') AS "user", coalesce(application_name, '') AS app, coalesce(state, '') AS state,
      coalesce(wait_event_type, '') AS wait, pg_blocking_pids(pid) AS blockers,
      coalesce(extract(epoch FROM now() - state_change), 0)::int AS seconds, left(coalesce(query, ''), ${MAX_QUERY}) AS query
    FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()) s),
  'tables', (SELECT coalesce(json_agg(t ORDER BY t.schema, t.name), '[]'::json) FROM (
    SELECT schemaname AS schema, relname AS name, n_live_tup AS rows, n_dead_tup AS dead, pg_total_relation_size(relid) AS bytes,
      coalesce(seq_scan, 0) AS scans, coalesce(idx_scan, 0) AS lookups, n_tup_ins + n_tup_upd + n_tup_del AS written
    FROM pg_stat_user_tables) t))`

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

type Read = Pick<Database, 'name' | 'version' | 'bytes' | 'max' | 'sessions' | 'tables'>

/** What `psql` printed for `HOLDS_SQL`, the secrets out of each statement; `undefined` for what is not its answer. */
export const readHolds = (stdout: string): Read | undefined => {
  const found = record(parsed(stdout.trim()))

  if (word(found.name) === '') return undefined

  return {
    name: word(found.name),
    version: word(found.version),
    bytes: count(found.bytes),
    max: count(found.max),
    sessions: list(found.sessions)
      .map(record)
      .map((session): DbSession => ({
        pid: count(session.pid),
        user: word(session.user),
        app: word(session.app),
        state: word(session.state),
        wait: word(session.wait),
        blockers: list(session.blockers).map(count),
        seconds: Math.max(0, count(session.seconds)),
        query: redact(word(session.query).replace(/\s+/g, ' ').trim()),
      })),
    tables: list(found.tables)
      .map(record)
      .map((table): DbTable => ({
        // A table of the schema every database has is called by its own name alone
        name: word(table.schema) === 'public' || word(table.schema) === '' ? word(table.name) : `${word(table.schema)}.${word(table.name)}`,
        rows: count(table.rows),
        dead: count(table.dead),
        bytes: count(table.bytes),
        scans: count(table.scans),
        lookups: count(table.lookups),
        written: count(table.written),
      })),
  }
}

const EMPTY: Read = { name: '', version: '', bytes: 0, max: 0, sessions: [], tables: [] }

/** A database that is known for one and cannot be asked: it keeps what it last said. */
export const unreadDatabase = (note: string, now: number, was?: Database): Database => ({ ...EMPTY, ...was, engine: 'postgresql', at: now, note })

// A session that has held a transaction open and idle for this long is said so: what it locked, others wait for
const IDLE_S = 30
// A query that has run for this long is said long
const LONG_S = 10
// How full the database is before it is said nearly full, of the sessions it lets in
const NEARLY = 0.9

/** Whether a session waits for a lock another holds. */
export const isBlocked = ({ blockers }: DbSession): boolean => blockers.length > 0

/** Whether a session holds a transaction open and does nothing in it, and has for a while. */
export const isIdling = ({ state, seconds }: DbSession): boolean => state.startsWith('idle in transaction') && seconds >= IDLE_S

/** Whether a session's statement has run for a while. */
export const isLong = ({ state, seconds }: DbSession): boolean => state === 'active' && seconds >= LONG_S

/** The sessions there is something to say of: one that waits for a lock, sits in an open transaction, or runs long. */
export const troubled = ({ sessions }: Pick<Database, 'sessions'>): DbSession[] => sessions.filter(session => isBlocked(session) || isIdling(session) || isLong(session))

const who = ({ pid, app, user }: DbSession): string => `pid ${pid}${app === '' ? (user === '' ? '' : ` (${user})`) : ` (${app})`}`

/** How a session stands, in a few words: what it does, for how long, and whom it waits for. */
export const sessionStanding = (session: DbSession): string =>
  [`${session.state || 'unknown'} for ${session.seconds}s`, isBlocked(session) ? `waits for a lock held by pid ${session.blockers.join(', ')}` : session.wait === 'Lock' ? 'waits for a lock' : ''].filter(part => part !== '').join(', ')

/**
 * The database once a read is taken in, and what there is to tell the person: a session that starts waiting for
 * a lock, one that has sat in an open transaction for a while, and a database nearly full of sessions; each once.
 */
export const settleDatabase = (was: Database | undefined, read: Read, label: string, now: number): { database: Database; said: string[] } => {
  const before = new Map((was?.sessions ?? []).map(session => [session.pid, session]))
  const wasNearly = was !== undefined && was.max > 0 && was.sessions.length >= was.max * NEARLY

  const said = [
    ...read.sessions.filter(session => isBlocked(session) && !isBlocked(before.get(session.pid) ?? { ...session, blockers: [] })).map(session => `palantir: ${label}: ${who(session)} waits for a lock held by pid ${session.blockers.join(', ')}`),
    ...read.sessions
      .filter(session => isIdling(session) && !isIdling(before.get(session.pid) ?? { ...session, seconds: 0 }))
      .map(session => `palantir: ${label}: ${who(session)} has held a transaction open and idle for ${session.seconds}s`),
    ...(read.max > 0 && read.sessions.length >= read.max * NEARLY && !wasNearly ? [`palantir: ${label}: ${read.sessions.length} of the ${read.max} sessions it lets in are taken`] : []),
  ]

  return { database: { ...read, engine: 'postgresql', at: now, note: '' }, said }
}

/** A size on disk, in the unit that says it in a few figures: a table of a few rows is kilobytes. */
export const sizeText = (bytes: number): string =>
  bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`

const plural = (many: number, one: string, several = `${one}s`): string => `${many} ${many === 1 ? one : several}`

/** The sessions counted by what they do (`3 idle, 1 active`), the most first. */
export const byState = ({ sessions }: Pick<Database, 'sessions'>): string => tally(sessions.map(({ state }) => state || 'unknown'))

/** The sessions counted by the app that opened them (`gondor 4, psql 1`), the most first; one that names none is `unnamed`. */
export const byApp = ({ sessions }: Pick<Database, 'sessions'>): string => tally(sessions.map(({ app }) => app || 'unnamed'), true)

const tally = (names: readonly string[], isNameFirst = false): string => {
  const counts = new Map<string, number>()

  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, many]) => (isNameFirst ? `${name} ${many}` : `${many} ${name}`))
    .join(', ')
}

/** A database in a line, for the answer that says how every app stands; empty for one with nothing to say. */
export const databaseLine = (database: Database | undefined): string => {
  if (database === undefined) return ''
  if (database.name === '') return `  a PostgreSQL database: ${database.note}`

  const blocked = database.sessions.filter(isBlocked).length
  const idling = database.sessions.filter(isIdling).length

  return [
    `  a PostgreSQL database: ${database.name}, ${plural(database.tables.length, 'table')}, ${database.sessions.length} of ${database.max} sessions taken`,
    blocked > 0 ? `${blocked} waiting for a lock` : '',
    idling > 0 ? `${idling} idle in an open transaction` : '',
    blocked + idling === 0 ? 'none waiting' : '',
    'mcp__palantir__database says more',
  ]
    .filter(part => part !== '')
    .join('; ')
}

const describeDatabase = (label: string, database: Database): string => {
  const { name, version, bytes, max, sessions, tables, note, at } = database
  const told = troubled(database)

  if (name === '') return `${label} (PostgreSQL), asked at ${clockTime(at)}: ${note}`

  return [
    `${label} (PostgreSQL ${version}), database ${name}, ${sizeText(bytes)}, asked at ${clockTime(at)}:${note === '' ? '' : ` ${note}`}`,
    `  Sessions: ${sessions.length} of the ${max} it lets in${sessions.length === 0 ? '' : ` (${byState(database)}); by app: ${byApp(database)}`}`,
    ...(told.length === 0 ? [] : ['  Waiting, idle in a transaction or long:']),
    ...told.map(session => `    ${who(session)}: ${sessionStanding(session)}: ${session.query || 'no statement'}`),
    tables.length === 0 ? '  No table.' : '  Tables:',
    ...tables.map(
      ({ name: table, rows, dead, bytes: size, scans, lookups, written }) =>
        `    ${table}: about ${plural(rows, 'row')}, ${sizeText(size)}${dead > 0 ? `, ${dead} dead` : ''}, ${plural(written, 'row')} written, read ${plural(scans, 'time')} whole and ${plural(lookups, 'time')} by an index`,
    ),
  ].join('\n')
}

export const NO_DATABASE =
  "No watched app is a database palantir reads. A PostgreSQL container, compose service or Kubernetes workload is told by its image and asked through its own psql, with nothing to set: watch it like any other app, in the compose file or as a line of .claude/palantir."

type Known = Record<string, Facts>

/** The databases among the attachments, or the one asked for: each with its sessions and its tables. */
export const databaseText = (attachments: readonly Attachment[], known: Known, ask: { target?: unknown }): string => {
  const target = typeof ask.target === 'string' ? ask.target.trim() : ''
  const databases = attachments.flatMap(({ label }) => (known[label]?.database === undefined || (target !== '' && label !== target) ? [] : [{ label, database: known[label].database }]))

  if (databases.length > 0) return databases.map(({ label, database }) => describeDatabase(label, database)).join('\n')
  if (target !== '' && attachments.some(({ label }) => label === target)) return `${target} is not a database palantir reads. ${NO_DATABASE}`

  return NO_DATABASE
}

const MAX_ROWS = 20
const MAX_ROW = 300

/** How many of a table's last rows are asked for: 5 when none is said, 20 at most. */
export const rowsLimit = (limit: unknown): number => (typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(MAX_ROWS, Math.round(limit))) : 5)

const quoted = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * The statement that prints a table's last rows, each as one JSON object on a line: the last as they lie in the
 * table, which is the last written where none was since rewritten. `undefined` for a name that is not a table the
 * database said it has: nothing a caller wrote is put in a statement.
 */
export const rowsSql = ({ tables }: Pick<Database, 'tables'>, table: string, limit: number): string | undefined => {
  const held = tables.find(({ name }) => name === table)

  if (held === undefined) return undefined

  // Its schema and its name as the database gave them: a name with a dot of its own is not one read here
  const parts = held.name.includes('.') ? held.name.split('.') : ['public', held.name]

  return parts.length === 2 ? `SELECT row_to_json(t) FROM (SELECT * FROM ${parts.map(quoted).join('.')} ORDER BY ctid DESC LIMIT ${Math.round(limit)}) t` : undefined
}

/**
 * The rows `psql` printed, one JSON object a line, the secrets out of each and none longer than a line. Those of
 * `rowsSql` come last first and are turned oldest first; those of a statement somebody wrote stay as it ordered them.
 */
export const readRows = (stdout: string, isLastFirst = true): string[] => {
  const rows = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => redact(line).slice(0, MAX_ROW))

  return isLastFirst ? rows.reverse() : rows
}

/** The rows that hold the text, whatever its case; all of them for none. */
export const matchingRows = (rows: readonly string[], grep: unknown): string[] => {
  const needle = typeof grep === 'string' ? grep.trim().toLowerCase() : ''

  return rows.filter(row => needle === '' || row.toLowerCase().includes(needle))
}

/** A table's last rows as text, under a line that says what they are. */
export const rowsText = (label: string, table: string, rows: readonly string[], grep = ''): string =>
  [`The last ${plural(rows.length, 'row')} of ${table} on ${label}${grep === '' ? '' : ` that hold ${grep}`}, as they lie in the table, oldest first, secrets taken out:`, ...rows.map(row => `  ${row}`)].join('\n')

const MAX_ANSWER = 50

/** How many rows of a statement's answer are asked for: 20 when none is said, 50 at most. */
export const answerLimit = (limit: unknown): number => (typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(MAX_ANSWER, Math.round(limit))) : 20)

/**
 * A statement somebody wrote, as it is handed to the database: set inside a SELECT of its rows, each as one JSON
 * object, so that only something that reads can stand there, and no more rows than asked for come back. One
 * statement alone: a second one after a `;` would run outside that SELECT, so a statement that holds one is
 * refused, as is one that does not start as a read. Writing is turned off besides, by `psqlArgv`.
 */
export const querySql = (written: unknown, limit: number): { sql: string } | { refused: string } => {
  const statement = (typeof written === 'string' ? written : '').trim().replace(/;\s*$/, '').trim()

  if (statement === '') return { refused: 'No statement was given.' }
  if (statement.includes(';')) return { refused: 'Only one statement is run, and it may hold no `;`: write it as a single SELECT.' }
  if (!/^(select|with|table|values)\b/i.test(statement)) return { refused: 'Only a statement that reads is run: a SELECT (or WITH, TABLE, VALUES). palantir changes nothing in a database.' }

  // Closed on a line of its own: a comment that ends the statement does not take the rest with it
  return { sql: `SELECT row_to_json(t) FROM (${statement}\n) t LIMIT ${Math.round(limit)}` }
}

/** What a statement answered, as text, under a line that says what it is. */
export const answerRowsText = (label: string, limit: number, rows: readonly string[]): string =>
  [`${label} answered ${plural(rows.length, 'row')}${rows.length >= limit ? ` (no more than ${limit} are read: \`limit\` asks for up to ${MAX_ANSWER})` : ''}, each as JSON, secrets taken out:`, ...rows.map(row => `  ${row}`)].join('\n')

/**
 * What is handed to Claude when the person asks something of the databases in the pane: their question, the
 * databases it is asked of with their tables, and how to answer it.
 */
export const askPrompt = (databases: readonly { label: string; database: Database }[], question: string): string =>
  [
    `About ${databases.length === 1 ? 'the database' : 'the databases'} palantir watches (${databases
      .map(({ label, database }) => `${label}: PostgreSQL${database.name === '' ? '' : `, database ${database.name}, ${database.tables.length === 0 ? 'no table' : `tables ${database.tables.map(({ name }) => name).join(', ')}`}`}`)
      .join('; ')}):`,
    '',
    question.trim(),
    '',
    `Answer it by querying ${databases.length === 1 ? 'it' : 'them'} with mcp__palantir__database${databases.length === 1 ? ` (target ${databases[0]?.label ?? ''})` : ''}: \`sql\` takes one SELECT, run with writing turned off, and \`table\` shows the last rows of a table, which is how to see its columns. Say the statement you ran along with the answer. If it cannot be answered by reading, say so: nothing is to be changed in the database.`,
  ].join('\n')

/** What is handed to Claude when the person asks why sessions of a database wait: the ones that do, as they stand. */
export const diagnoseSessionsPrompt = (label: string, database: Database): string => {
  const waiting = troubled(database)

  return [
    `Find why ${waiting.length === 1 ? 'this session' : 'these sessions'} of the database ${label}, which palantir watches, ${waiting.length === 1 ? 'is' : 'are'} held up:`,
    '',
    ...waiting.map(session => `  pid ${session.pid} (${session.app || session.user}): ${sessionStanding(session)}; ${session.query}`),
    '',
    `mcp__palantir__database (target ${label}) reads the sessions afresh, each with the session that holds the lock it waits for, and \`sql\` runs one SELECT. Find in the code of the app that opened them which transaction is left open or which statement holds the lock (mcp__palantir__logs says what the apps wrote), and fix it there. Nothing is to be changed in the database, and no session ended.`,
  ].join('\n')
}
