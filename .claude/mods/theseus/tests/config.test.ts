import { describe, expect, test } from 'claude-code/testing'

import { KEYS, projectOf, projectOfLines, projectOfToml, projectToml, proposeProject } from '../core/config'
import { parseToml } from '../core/toml'
import { SCHEMA } from '../core/schema'

const CWD = '/proj'

// The line format as this repository wrote it, every setting a target takes among it
const LINES = [
  '# what the project builds',
  'review=/code-review medium',
  'review=/security-review',
  'standards=docs/agents/standards.md',
  'narsil=cli@narsil',
  'narsil.tests=narsil/tests',
  'narsil.test=cargo test --manifest-path narsil/Cargo.toml -- --exact {tests}',
  'narsil.affected=cargo test --manifest-path narsil/Cargo.toml',
  'narsil.check=cargo clippy -- -D warnings && cargo fmt --check',
  'narsil.check=sh scripts/deslop.sh narsil {against}',
  'gondor=service:gondor.app:app@beacons/gondor',
  'gondor.python=beacons',
  'gondor.env=KAFKA_BROKERS=',
  'gondor.env=ROHAN_URL=http://127.0.0.1:9',
  'gondor.db=postgres:18-alpine',
  'gondor.db.env=DATABASE_URL',
  'gondor.ready=GET /health',
  'gondor.ready.match="lit": \\d',
  'gondor.mask=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?(Z|[+-]\\d\\d:?\\d\\d)?',
  'gondor.live=k3d-beacons/beacons/deployment/gondor',
  'gondor.live.forward=postgres:5432,rohan:8102',
  'gondor.live.env=KAFKA_BROKERS=',
  'gondor.live.db=deployment/postgres',
  'gondor.live.scratch=DATABASE_URL',
  '$ gondor GET /health',
  "$ gondor POST /beacons/eilenach/light '{\"keeper\": \"Hirgon\"}'",
  'anor=frontend@beacons/anor',
  'anor.affected=npm --prefix beacons/anor test --silent',
].join('\n')

describe('the TOML reader', () => {
  test('reads tables, dotted keys, the four strings, numbers, booleans, arrays over lines and inline tables', () => {
    const read = parseToml(
      [
        '# a comment',
        'name = "Theseus" # after a value',
        "path = 'C:\\Users\\no\\escape'",
        'multi = """',
        'two',
        'lines"""',
        "raw = '''a\\b'''",
        'count = 3',
        'ratio = 0.5',
        'on = true',
        'list = [',
        '  "a", # one',
        '  "b",',
        ']',
        'env = { A = "1", "B C" = "2" }',
        '',
        '[targets.gondor]',
        'kind = "service"',
        'db.image = "postgres"',
        '[targets."my app"]',
        'kind = "cli"',
      ].join('\n'),
    )

    expect(read.errors).toEqual([])
    expect(read.value).toEqual({
      name: 'Theseus',
      path: 'C:\\Users\\no\\escape',
      multi: 'two\nlines',
      raw: 'a\\b',
      count: 3,
      ratio: 0.5,
      on: true,
      list: ['a', 'b'],
      env: { A: '1', 'B C': '2' },
      targets: { gondor: { kind: 'service', db: { image: 'postgres' } }, 'my app': { kind: 'cli' } },
    })
    expect(read.lineOf.get('targets.gondor.kind')).toBe(18)
  })

  test('names the line of each error, and reads on past it', () => {
    const read = parseToml(['a = "open', 'b = bare', 'c = 1', 'c = 2', '[t]', '[t]', '[[many]]', 'd = 1979-05-27', 'e = "ok"'].join('\n'))

    expect(read.errors).toEqual([
      'line 1: a string is not closed on its line',
      'line 2: "bare" is not a value: a string is written in quotes',
      'line 4: c is set twice',
      'line 6: the table [t] is made twice',
      'line 7: arrays of tables ([[…]]) are not read here',
      'line 8: dates are not read here: write it as a string',
    ])
    expect(read.value.t).toEqual({ e: 'ok' })
  })
})

describe("the project's file", () => {
  test('in TOML, reads as the line format did: every setting a target takes', () => {
    const lines = projectOfLines(LINES, CWD)
    const toml = projectOfToml(projectToml(lines, CWD), CWD)

    expect(lines.errors).toEqual([])
    expect(toml.errors).toEqual([])
    expect(toml.targets).toEqual(lines.targets)
    expect(toml.reviews).toEqual(lines.reviews)
    expect(toml.standards).toEqual(lines.standards)
  })

  test('in TOML, says by its line each key that is unknown, of the wrong type, or missing', () => {
    const read = projectOfToml(
      [
        'review = "/code-review"',
        '',
        '[targets.narsil]',
        'kind = "binary"',
        'roots = ["narsil"]',
        '',
        '[targets.gondor]',
        'kind = "service"',
        'roots = []',
        'tests = "beacons/tests"',
        'flavour = "salty"',
        '[targets.gondor.db]',
        'env = "DATABASE_URL"',
      ].join('\n'),
      CWD,
    )

    expect(read.errors).toEqual([
      '.claude/theseus.toml:1: review must be a list of strings',
      '.claude/theseus.toml:4: targets.narsil.kind must be one of cli, service, frontend',
      '.claude/theseus.toml:10: targets.gondor.tests must be a list of strings',
      '.claude/theseus.toml:11: targets.gondor.flavour is no key Theseus knows (kind, roots, tests, test, app, python, env, masks, requests, affected, checks, audit, db, ready, live)',
      '.claude/theseus.toml:7: targets.gondor.roots must name at least one folder whose edits are edits of gondor',
      '.claude/theseus.toml:7: targets.gondor.app must name the service\'s app as Python imports it, "module:app"',
      '.claude/theseus.toml:12: targets.gondor.db.image must be set',
    ])
  })

  test('in the line format, says each line that reads as nothing, and each setting of a target it does not name', () => {
    expect(projectOfLines(['narsil=cli@narsil', 'narsil.tset=cargo test', 'gondor.test=pytest', '$ quill GET /', 'review=/code-review'].join('\n'), CWD).errors).toEqual([
      '.claude/verify:2: this line reads as nothing Theseus knows: narsil.tset=cargo test',
      '.claude/verify:3: gondor is no target this file names (narsil)',
      '.claude/verify:4: quill is no target this file names (narsil)',
    ])
  })

  test('is the TOML one where both are there, and the line format with a warning that it goes', () => {
    expect(projectOf({ toml: '[targets.a]\nkind = "cli"\nroots = ["a"]', lines: 'b=cli@b' }, CWD)?.targets.map(one => one.label)).toEqual(['a'])
    expect(projectOf({ lines: 'b=cli@b' }, CWD)?.errors).toEqual(['.claude/verify: the line format goes in the next release: /theseus init writes .claude/theseus.toml from it'])
    expect(projectOf({}, CWD)).toBeUndefined()
  })

  test('has the keys its JSON Schema has, at every level', () => {
    const schema: unknown = SCHEMA
    const defs = (schema as { $defs: Record<string, { properties: Record<string, unknown> }> }).$defs

    expect(Object.keys((schema as { properties: Record<string, unknown> }).properties)).toEqual(Object.keys(KEYS.top))
    expect(Object.keys(defs.target?.properties ?? {})).toEqual(Object.keys(KEYS.target))
    expect(Object.keys(defs.db?.properties ?? {})).toEqual(Object.keys(KEYS.db))
    expect(Object.keys(defs.ready?.properties ?? {})).toEqual(Object.keys(KEYS.ready))
    expect(Object.keys(defs.live?.properties ?? {})).toEqual(Object.keys(KEYS.live))
  })
})

describe('what /theseus init proposes', () => {
  test('is a CLI per Cargo binary, a service per FastAPI app, a frontend per JavaScript app, and the reviews', () => {
    const found = [
      { path: 'narsil/Cargo.toml', text: '[package]\nname = "narsil"' },
      { path: 'Cargo.toml', text: '[workspace]\nmembers = ["narsil"]' },
      { path: 'beacons/pyproject.toml', text: '[project]\nname = "beacons"\n[tool.ruff]' },
      { path: 'beacons/gondor/app.py', text: 'from fastapi import FastAPI\n\napp = FastAPI(title="Gondor")\n' },
      { path: 'beacons/anor/package.json', text: JSON.stringify({ scripts: { test: 'vitest' }, devDependencies: { nuxt: '4' } }) },
      { path: 'tools/package.json', text: JSON.stringify({ dependencies: { lodash: '4' } }) },
    ]
    const has = (path: string) => ['narsil/src/main.rs', 'narsil/tests', 'beacons/uv.lock', 'beacons/tests', 'docs/agents/standards.md'].includes(path)
    const proposed = proposeProject(found, has, CWD, 'proj')

    expect(proposed.targets.map(one => [one.label, one.kind, one.roots])).toEqual([
      ['narsil', 'cli', ['/proj/narsil']],
      ['gondor', 'service', ['/proj/beacons/gondor']],
      ['anor', 'frontend', ['/proj/beacons/anor']],
    ])
    expect(proposed.targets[1]).toMatchObject({ app: 'gondor.app:app', python: 'beacons', test: 'uv run --quiet --project beacons pytest -v -p no:cacheprovider beacons/tests -k "{tests: or }"', checks: ['uv run --quiet --project beacons ruff check beacons/gondor'] })
    expect(proposed.standards).toEqual(['docs/agents/standards.md'])
    expect(projectOfToml(projectToml(proposed, CWD), CWD).errors).toEqual([])
  })
})
