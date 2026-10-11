import { describe, expect, mock, test } from 'claude-code/testing'

const PANE = { bodyColumns: 100 } as const

const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'http-log', surface: 'terminal', component: 'Pane', props: PANE as never, requestId: 'http-log' })

const fetched = (url: string) => ({ tool: 'WebFetch', url, prompt: 'x' }) as never

// Stands for the engine: the WebFetch answer the plugin sees
const answerOk = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK' } }) as never)

// Stands for the file system the plugin reads the taps' logs from: what a test "writes" is a line in the map
const memoryFs = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const files = new Map<string, string>()

  // The engine hands the hook the absolute path a relative one lands on: a file is found by how its path ends
  on('fs.read', (_$, e) => {
    const path = e.path.replace(/\\/g, '/')
    const key = [...files.keys()].find(name => path.endsWith(name.replace(/\\/g, '/')))
    if (key === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: files.get(key) } as never
  })

  return files
}

describe('http-log', () => {
  test('says so when no call was made', async ($, on) => {
    mock.store(on)
    const pane = await mountPane($)

    expect(await pane.find({ text: /No HTTP calls yet/ })).toBeDefined()
    expect(await pane.find({ text: /0 calls/ })).toBeDefined()
  })

  test('has no default limit: calls no rule matches are never held', async ($, on) => {
    mock.store(on)
    answerOk(on)

    for (let n = 0; n < 15; n += 1) {
      expect(JSON.stringify(await $.tool.call(fetched('https://a.test/x')))).not.toMatch(/rate limit of/)
    }
  })

  test('lists a call with its url and response code', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK', url: 'https://example.test/a' } }) as never)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://example.test/a'))

    expect(await pane.find({ text: /1 call/ })).toBeDefined()
    expect(await pane.find({ text: /https:\/\/example\.test\/a/ })).toBeDefined()
    expect(await pane.find({ text: /200 OK/ })).toBeDefined()
  })

  test('a rule limits the calls its regex matches, sharing one counter', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await pane.press({ key: 'add-rule' })
    await pane.input({ key: 'rule-pattern-0', text: '/pokemon/\\d+$', kind: 'change' } as never)
    await pane.input({ key: 'rule-limit-0', text: '1', kind: 'change' } as never)

    const first = await $.tool.call(fetched('https://a.test/pokemon/1'))
    const second = await $.tool.call(fetched('https://a.test/pokemon/2'))
    const other = await $.tool.call(fetched('https://a.test/types/water'))
    const otherAgain = await $.tool.call(fetched('https://a.test/types/water'))

    expect(JSON.stringify(first)).not.toMatch(/rate limit of/)
    expect(JSON.stringify(second)).toMatch(/rate limit of 1 calls per minute for /)
    expect(JSON.stringify(other)).not.toMatch(/rate limit of/)
    expect(JSON.stringify(otherAgain)).not.toMatch(/rate limit of/)
    expect(await pane.find({ text: /limited/ })).toBeDefined()
  })

  test('an invalid regex holds nothing and says so', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await pane.press({ key: 'add-rule' })
    await pane.input({ key: 'rule-pattern-0', text: '([', kind: 'change' } as never)

    expect(await pane.find({ text: /invalid regex/ })).toBeDefined()

    await $.tool.call(fetched('https://a.test/x'))
    const again = await $.tool.call(fetched('https://a.test/x'))
    expect(JSON.stringify(again)).not.toMatch(/rate limit of/)
  })

  test('a row\'s Rate limit button makes a rule for exactly that endpoint', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/1'))
    await pane.press({ key: 'limit-0' })
    await pane.input({ key: 'rule-limit-0', text: '1', kind: 'change' } as never)

    expect(await pane.find({ text: /1\/min/ })).toBeDefined()

    const sameWithQuery = await $.tool.call(fetched('https://a.test/pokemon/1?fields=name'))
    const sibling = await $.tool.call(fetched('https://a.test/pokemon/10'))

    expect(JSON.stringify(sameWithQuery)).toMatch(/rate limit of 1/)
    expect(JSON.stringify(sibling)).not.toMatch(/rate limit of/)
  })

  test('the search filters the table by url, status or time, and counts what it shows', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/charizard'))
    await $.tool.call(fetched('https://a.test/pokemon/pikachu'))
    await $.tool.call(fetched('https://a.test/types/water'))

    expect(await pane.find({ text: /3 calls/ })).toBeDefined()

    await pane.input({ key: 'search', text: 'POKEMON', kind: 'change' } as never)
    expect(await pane.find({ text: /2 of 3 calls/ })).toBeDefined()
    expect(await pane.find({ text: /types\/water/ })).toBeUndefined()

    // Words are all required
    await pane.input({ key: 'search', text: 'pokemon pika', kind: 'change' } as never)
    expect(await pane.find({ text: /1 of 3 calls/ })).toBeDefined()
    expect(await pane.find({ text: /charizard/ })).toBeUndefined()

    await pane.input({ key: 'search', text: 'nothing like this', kind: 'change' } as never)
    expect(await pane.find({ text: /No call matches the search/ })).toBeDefined()

    await pane.input({ key: 'search', text: '', kind: 'change' } as never)
    expect(await pane.find({ text: /3 calls/ })).toBeDefined()
  })

  test('the search finds the calls a rule refused', async ($, on) => {
    mock.store(on, { rules: [{ id: 'r1', pattern: 'charizard', limit: 1 }], calls: [] })
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/charizard'))
    await $.tool.call(fetched('https://a.test/pokemon/charizard'))
    await $.tool.call(fetched('https://a.test/pokemon/pikachu'))

    await pane.input({ key: 'search', text: 'limited', kind: 'change' } as never)
    expect(await pane.find({ text: /1 of 3 calls/ })).toBeDefined()
  })

  test('rules another session stored hold here, before the pane was ever opened', async ($, on) => {
    mock.store(on, {
      rules: [{ id: 'r1', pattern: 'charizard', limit: 1 }],
      calls: [],
    })
    answerOk(on)

    const first = await $.tool.call(fetched('https://a.test/pokemon/charizard'))
    const second = await $.tool.call(fetched('https://a.test/pokemon/charizard'))

    expect(JSON.stringify(first)).not.toMatch(/rate limit of/)
    expect(JSON.stringify(second)).toMatch(/rate limit of 1 calls per minute for charizard/)
  })

  test('calls another session made count here, and the calls made here are written back', async ($, on) => {
    const now = Date.now()
    mock.store(on, {
      rules: [{ id: 'r1', pattern: 'charizard', limit: 2 }],
      // A call another session made a few seconds ago
      calls: [
        { id: 'c1', url: 'https://a.test/pokemon/charizard', code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00', ts: now - 3000, limited: false, pending: false },
      ],
    })
    answerOk(on)

    // Two are allowed in all: the other session's, and this one
    const mine = await $.tool.call(fetched('https://a.test/pokemon/charizard'))
    // Refused only if the call just made was written to the store, where a third session would read it
    const next = await $.tool.call(fetched('https://a.test/pokemon/charizard'))

    expect(JSON.stringify(mine)).not.toMatch(/rate limit of/)
    expect(JSON.stringify(next)).toMatch(/rate limit of 2 calls per minute/)
  })

  test('pressing a row shows that call\'s details under the table, and Close hides them', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK', bytes: 1234, result: 'Eevee is a Normal type' } }) as never)

    const pane = await mountPane($)
    expect(await pane.find({ text: /Press a time in the table/ })).toBeDefined()

    await $.tool.call({ tool: 'WebFetch', url: 'https://a.test/pokemon/eevee', prompt: 'what type' } as never)
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /Call details/ })).toBeDefined()
    expect(await pane.find({ text: /what type/ })).toBeDefined()
    expect(await pane.find({ text: /Eevee is a Normal type/ })).toBeDefined()

    await pane.press({ key: 'detail-close' })
    expect(await pane.find({ text: /Call details/ })).toBeUndefined()
  })

  test('a JSON result is shown formatted', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK', result: '{"name":"eevee","id":133}' } }) as never)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/eevee'))
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /"name": "eevee"/ })).toBeDefined()
  })

  test('JSON followed by WebFetch\'s note is still formatted, the note kept below it', async ($, on) => {
    mock.store(on)
    const answer = '{"id":25,"name":"pikachu","abilities":["static","lightning-rod"]}\n\n[WebFetch note: the final 205062 were not read]'
    on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK', result: answer } }) as never)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/pikachu'))
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /"name": "pikachu"/ })).toBeDefined()
    expect(await pane.find({ text: /WebFetch note/ })).toBeDefined()
  })

  test('a curl POST is logged with its method, and its body is shown formatted', async ($, on) => {
    mock.store(on)
    on(
      'tool.call',
      { tool: 'PowerShell' },
      () => ({ result: { stdout: 'HTTP/1.1 201 Created\r\ncontent-type: application/json\r\n\r\n{"id":7}', stderr: '', interrupted: false } }) as never,
    )

    const pane = await mountPane($)
    await $.tool.call({
      tool: 'PowerShell',
      command: `curl.exe -i -X POST -H "Content-Type: application/json" -d '{"name":"eevee","level":5}' https://a.test/api/pokemon`,
    } as never)

    expect(await pane.find({ text: /^POST$/ })).toBeDefined()
    expect(await pane.find({ text: /https:\/\/a\.test\/api\/pokemon/ })).toBeDefined()
    expect(await pane.find({ text: /201 Created/ })).toBeDefined()

    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /Body/ })).toBeDefined()
    expect(await pane.find({ text: /"name": "eevee"/ })).toBeDefined()
    expect(await pane.find({ text: /"level": 5/ })).toBeDefined()
    expect(await pane.find({ text: /"id": 7/ })).toBeDefined()
  })

  test('a body with PowerShell 5.1 escaped quotes is shown formatted', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: 'HTTP/1.1 200 OK\r\n\r\n{}', stderr: '', interrupted: false } }) as never)

    const pane = await mountPane($)
    await $.tool.call({
      tool: 'PowerShell',
      command: `curl.exe -i -X POST https://a.test/post -H 'Content-Type: application/json' -d '{\\"name\\":\\"eevee\\"}'`,
    } as never)
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /"name": "eevee"/ })).toBeDefined()
  })

  test('query parameters are listed decoded in the details, a repeated name as a list', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/search?q=hello%20world&tag=a&tag=b&limit=5#top'))
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /Query/ })).toBeDefined()
    expect(await pane.find({ text: /q: "hello world"/ })).toBeDefined()
    expect(await pane.find({ text: /limit: 5\b/ })).toBeDefined()
    expect(await pane.find({ text: /- a/ })).toBeDefined()
    expect(await pane.find({ text: /- b/ })).toBeDefined()
  })

  test('the url, query, body and result each have a Copy button that copies them exactly', async ($, on) => {
    mock.store(on)
    on(
      'tool.call',
      { tool: 'PowerShell' },
      () => ({ result: { stdout: 'HTTP/1.1 200 OK\r\n\r\n{"id":7,"ok":true}', stderr: '', interrupted: false } }) as never,
    )

    const copies: string[] = []
    on('ui.copy', ($, e) => {
      copies.push(e.text)

      return { value: { isCopied: true } } as never
    })

    const pane = await mountPane($)
    await $.tool.call({
      tool: 'PowerShell',
      command: `curl.exe -i -X POST 'https://a.test/api?q=hello%20world&n=5#top' -d '{"name":"eevee"}'`,
    } as never)
    await pane.press({ key: 'select-0' })

    // The url is plain text, whole and unquoted
    expect(await pane.find({ text: /^https:\/\/a\.test\/api\?q=hello%20world&n=5#top$/ })).toBeDefined()

    await pane.press({ key: 'copy-url' })
    await pane.press({ key: 'copy-query' })
    await pane.press({ key: 'copy-body' })
    await pane.press({ key: 'copy-result' })

    expect(copies[0]).toBe('https://a.test/api?q=hello%20world&n=5#top')
    expect(copies[1]).toBe('q=hello%20world&n=5')
    expect(JSON.parse(copies[2] ?? '')).toEqual({ name: 'eevee' })
    expect(JSON.parse(copies[3] ?? '')).toEqual({ id: 7, ok: true })
    expect(await pane.find({ text: /Copied/ })).toBeDefined()
  })

  test('on the desktop the result, body and query are drawn as plain lines, indented, with no Code element', async ($, on) => {
    mock.store(on)
    // A Windows command's output: \r\n and a progress meter's escape, around JSON
    on(
      'tool.call',
      { tool: 'PowerShell' },
      () => ({ result: { stdout: 'HTTP/1.1 200 OK\r\n\r\n{"id":7,"tags":["a","b"]}\r\n\u001b[0m', stderr: '', interrupted: false } }) as never,
    )

    const pane = await $.ui.mount({
      plugin: 'http-log',
      surface: 'desktop',
      component: 'Pane',
      props: PANE as never,
      requestId: 'http-log',
    })
    await $.tool.call({
      tool: 'PowerShell',
      command: `curl.exe -i -X POST 'https://a.test/api?q=x' -d '{"name":"eevee"}'`,
    } as never)
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ text: /"id": 7/ })).toBeDefined()
    expect(await pane.find({ text: /"name": "eevee"/ })).toBeDefined()
    expect(await pane.find({ text: /q: x/ })).toBeDefined()
    // Plain lines, not a Code element, which the desktop does not draw here
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
  })

  test('the terminal still draws Code, highlighted', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'WebFetch' }, () => ({ result: { code: 200, codeText: 'OK', result: '{"id":7}' } }) as never)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/7'))
    await pane.press({ key: 'select-0' })

    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('a loop over a list with the url built from variables is logged, one row per address', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: 'pokemon/pikachu -> pikachu (id 25)', stderr: '', interrupted: false } }) as never)

    const pane = await mountPane($)
    await $.tool.call({
      tool: 'PowerShell',
      command: [
        `$base='https://pokeapi.co/api/v2'`,
        `foreach ($p in 'pokemon/pikachu','pokemon/charizard','type/fire','ability/static') {`,
        `  $r = Invoke-RestMethod "$base/$p"`,
        `  "$p -> $($r.name) (id $($r.id))"`,
        `}`,
      ].join('\n'),
    } as never)

    expect(await pane.find({ text: /4 calls/ })).toBeDefined()
    for (const path of ['pokemon/pikachu', 'pokemon/charizard', 'type/fire', 'ability/static']) {
      expect(await pane.find({ text: new RegExp(`https://pokeapi\\.co/api/v2/${path.replace('/', '\\/')}`) })).toBeDefined()
    }
    // The command's own output is each row's result
    await pane.press({ key: 'select-0' })
    expect(await pane.find({ text: /pikachu \(id 25\)/ })).toBeDefined()
  })

  test('a rule that refuses one request of a loop refuses the whole command', async ($, on) => {
    mock.store(on, { rules: [{ id: 'r1', pattern: 'type/fire', limit: 1 }], calls: [
      { id: 'c1', url: 'https://pokeapi.co/api/v2/type/fire', code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00', ts: Date.now() - 1000, limited: false, pending: false },
    ] })
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }) as never)

    const refused = await $.tool.call({
      tool: 'PowerShell',
      command: `foreach ($p in 'pokemon/pikachu','type/fire') { Invoke-RestMethod "https://pokeapi.co/api/v2/$p" }`,
    } as never)

    expect(JSON.stringify(refused)).toMatch(/rate limit of 1 calls per minute for type\/fire/)
  })

  test('a desktop-style one-liner: the url loses its trailing semicolon, the command is shown, the summary is the result', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: '200 POST httpbin.org/post', stderr: '', interrupted: false } }) as never)

    const pane = await $.ui.mount({ plugin: 'http-log', surface: 'desktop', component: 'Pane', props: PANE as never, requestId: 'http-log' })
    await $.tool.call({
      tool: 'PowerShell',
      command: `$r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri https://httpbin.org/post -Body '{"hello":"world"}' -ContentType 'application/json'; "$($r.StatusCode) POST httpbin.org/post"`,
    } as never)
    await $.tool.call({
      tool: 'PowerShell',
      command: `$r = Invoke-WebRequest -UseBasicParsing https://httpbin.org/get; "$($r.StatusCode) GET httpbin.org/get"`,
    } as never)

    // Newest first: the GET, whose address was written against a `;`
    expect(await pane.find({ text: /^https:\/\/httpbin\.org\/get$/ })).toBeDefined()
    expect(await pane.find({ text: /^https:\/\/httpbin\.org\/post$/ })).toBeDefined()

    await pane.press({ key: 'select-1' })
    expect(await pane.find({ text: /Command/ })).toBeDefined()
    expect(await pane.find({ text: /"hello"/ })).toBeDefined()
    expect(await pane.find({ text: /200 POST httpbin\.org\/post/ })).toBeDefined()
  })

  test('a command that may reach the network gets the tap line, and what the wrapper saw replaces what the text said', async ($, on) => {
    mock.store(on)
    mock.env(on, { OS: 'Windows_NT', TEMP: 'tap-test-tmp' })

    const seen: string[] = []
    const files = memoryFs(on)
    on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
      seen.push(e.command)
      // What the wrapper would write for a script that built its address and its body itself
      const file = /HTTPLOG_FILE='([^']+)'/.exec(e.command)?.[1]
      if (file !== undefined) {
        files.set(
          file,
          `${JSON.stringify({ via: 'wrapper', ts: Date.now(), method: 'POST', url: 'https://a.test/api/pokemon', code: 201, codeText: 'Created', durationMs: 12, ok: true, body: '{"name":"eevee"}', result: '{"id":9}' })}\n`,
        )
      }

      return { result: { stdout: 'created', stderr: '', interrupted: false } } as never
    })

    const pane = await mountPane($)
    // Nothing in the text names an address: only the wrapper knows it
    await $.tool.call({ tool: 'PowerShell', command: 'python .\\make-pokemon.py' } as never)

    expect(seen[0]).toMatch(/^\$env:HTTPLOG_FILE='tap-test-tmp\/http-log-tap\/[^']+\.jsonl';Invoke-Expression \(\[System\.IO\.File\]::ReadAllText\('[^']*http-log-tap\.ps1'\)\)\npython \.\\make-pokemon\.py$/)
    expect(await pane.find({ text: /^https:\/\/a\.test\/api\/pokemon$/ })).toBeDefined()
    expect(await pane.find({ text: /^POST$/ })).toBeDefined()
    expect(await pane.find({ text: /201 Created/ })).toBeDefined()

    await pane.press({ key: 'select-0' })
    expect(await pane.find({ text: /seenBy: wrapper/ })).toBeDefined()
    expect(await pane.find({ text: /"name": "eevee"/ })).toBeDefined()
    expect(await pane.find({ text: /"id": 9/ })).toBeDefined()
    // The command shown is the one the model wrote, not the one with the tap line
    expect(await pane.find({ text: /^python \.\\make-pokemon\.py$/ })).toBeDefined()
  })

  test('a command that cannot reach the network runs exactly as written', async ($, on) => {
    mock.store(on)
    mock.env(on, { OS: 'Windows_NT', TEMP: 'tap-test-tmp' })

    const seen: string[] = []
    on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
      seen.push(e.command)

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })

    await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem C:\\Temp | Select-Object -First 3' } as never)
    expect(seen).toEqual(['Get-ChildItem C:\\Temp | Select-Object -First 3'])

    // git is tapped only for the subcommands that go out
    await $.tool.call({ tool: 'PowerShell', command: 'git status --short' } as never)
    expect(seen[1]).toBe('git status --short')
    await $.tool.call({ tool: 'PowerShell', command: 'git fetch origin' } as never)
    expect(seen[2]).toMatch(/^\$env:HTTPLOG_FILE=.*\ngit fetch origin$/)

    // A script that must start with `using` keeps its first line first
    await $.tool.call({ tool: 'PowerShell', command: 'using namespace System.Net\ncurl.exe https://a.test/x' } as never)
    expect(seen[3]).toBe('using namespace System.Net\ncurl.exe https://a.test/x')
  })

  test('off Windows no command is tapped until the proxy has made and reported its private folder', async ($, on) => {
    mock.store(on)
    // A shared temp area, and no OS variable of Windows: the mod trusts no name in it
    mock.env(on, { TMPDIR: '/tmp' })

    const seen: string[] = []
    on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
      seen.push(e.command)

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })

    await $.tool.call({ tool: 'PowerShell', command: 'python .\\fetch.py' } as never)
    await $.tool.call({ tool: 'PowerShell', command: 'curl.exe -s https://a.test/x' } as never)

    // Nothing was put before either command, and nothing was read from, or written to, a predictable folder
    expect(seen).toEqual(['python .\\fetch.py', 'curl.exe -s https://a.test/x'])
  })

  test('the interpreter is looked for from the mod\'s own folder, never the project\'s', async ($, on) => {
    mock.store(on)
    mock.env(on, { OS: 'Windows_NT', TEMP: 'tap-test-tmp' })

    const runs: { argv: readonly string[]; cwd?: string; env?: Record<string, string> }[] = []
    on('process.run', (_$, e) => {
      runs.push({ argv: e.argv, cwd: e.init?.cwd, env: e.init?.env })

      // Not Python 3 at all: the point here is where it is looked for
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

    await $.tool.call({ tool: 'PowerShell', command: 'curl.exe -s https://a.test/x' } as never)
    // Python is looked for in the background: let it
    await new Promise<void>(resolve => setTimeout(resolve, 200))

    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect(run.cwd).toMatch(/http-log$/)
      expect(run.env?.NoDefaultCurrentDirectoryInExePath).toBe('1')
    }
  })
  test('the proxy log is merged: a tunnel adds its size to the row for that host, and an unnamed host is a row', async ($, on) => {
    mock.store(on)
    mock.env(on, { OS: 'Windows_NT', TEMP: 'tap-test-tmp' })

    const files = memoryFs(on)
    on('tool.call', { tool: 'PowerShell' }, (_$, e) => {
      const token = /HTTPLOG_FILE='[^']*\/([^/']+)\.jsonl'/.exec(e.command)?.[1] ?? ''
      const now = Date.now()
      const lines = [
        // curl.exe https://a.test/x: named in the text, so its tunnel only adds bytes
        { via: 'proxy', token, ts: now, method: 'CONNECT', url: 'https://a.test:443', code: 200, codeText: 'tunnel', durationMs: 40, ok: true, tunnel: true, bytes: 5000 },
        // a script's own request, from a client that sent no token: made while the command ran
        { via: 'proxy', token: '', ts: now, method: 'CONNECT', url: 'https://other.test:443', code: 200, codeText: 'tunnel', durationMs: 60, ok: true, tunnel: true, bytes: 900 },
        // a plain HTTP request, in full
        { via: 'proxy', token, ts: now, method: 'GET', url: 'http://plain.test/ping?x=1', code: 200, codeText: 'OK', durationMs: 5, ok: true, result: 'pong' },
        // another command's, long ago: not this one's
        { via: 'proxy', token: 'someone-else', ts: now - 60000, method: 'CONNECT', url: 'https://not-mine.test:443', code: 200, codeText: 'tunnel', durationMs: 1, ok: true, tunnel: true, bytes: 1 },
      ]
      files.set('tap-test-tmp/http-log-tap/proxy.jsonl', `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })

    const pane = await mountPane($)
    await $.tool.call({ tool: 'PowerShell', command: 'curl.exe -s https://a.test/x; python run.py' } as never)

    expect(await pane.find({ text: /^https:\/\/a\.test\/x$/ })).toBeDefined()
    expect(await pane.find({ text: /^https:\/\/other\.test:443$/ })).toBeDefined()
    expect(await pane.find({ text: /^http:\/\/plain\.test\/ping\?x=1$/ })).toBeDefined()
    expect(await pane.find({ text: /not-mine/ })).toBeUndefined()
    // Three rows: the named request, the unnamed host and the plain HTTP one
    expect(await pane.find({ text: /3 calls/ })).toBeDefined()
  })

  test('a command that may reach the network gets the proxy variables in bash, once the proxy is up', async ($, on) => {
    mock.store(on)
    mock.env(on, { OS: 'Windows_NT', TEMP: 'tap-test-tmp' })

    const seen: string[] = []
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      seen.push(e.command)

      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    })

    // No proxy is running in a test: bash has only the proxy to offer, so the command is left as written
    await $.tool.call({ tool: 'Bash', command: 'curl -s https://a.test/x' } as never)
    expect(seen[0]).toBe('curl -s https://a.test/x')
  })

  test('the period chips limit the table to the last 10 minutes, 30 minutes or hour, and All shows every call', { options: { retention: '1d' } }, async ($, on) => {
    const now = Date.now()
    const made = (id: string, minutesAgo: number) => ({
      id, url: `https://a.test/${id}`, code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00',
      ts: now - minutesAgo * 60_000, limited: false, pending: false,
    })
    mock.store(on, { rules: [], calls: [made('five', 5), made('twenty', 20), made('fortyfive', 45), made('threehours', 180)] })
    answerOk(on)

    const pane = await mountPane($)
    // A call made now brings the stored ones into the pane, and is itself the newest
    await $.tool.call(fetched('https://a.test/new'))
    expect(await pane.find({ text: /5 calls/ })).toBeDefined()

    await pane.press({ key: 'range-10m' })
    expect(await pane.find({ text: /2 of 5 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/five/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/twenty/ })).toBeUndefined()

    await pane.press({ key: 'range-30m' })
    expect(await pane.find({ text: /3 of 5 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/twenty/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/fortyfive/ })).toBeUndefined()

    await pane.press({ key: 'range-1h' })
    expect(await pane.find({ text: /4 of 5 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/fortyfive/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/threehours/ })).toBeUndefined()

    // The period and the search together
    await pane.input({ key: 'search', text: 'twenty', kind: 'change' } as never)
    expect(await pane.find({ text: /1 of 5 calls/ })).toBeDefined()

    await pane.input({ key: 'search', text: '', kind: 'change' } as never)
    await pane.press({ key: 'range-all' })
    expect(await pane.find({ text: /5 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/threehours/ })).toBeDefined()
  })
  test('calls older than an hour are cleaned: not shown, not counted, not written back', async ($, on) => {
    const now = Date.now()
    const made = (id: string, minutesAgo: number) => ({
      id, url: `https://a.test/${id}`, code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00',
      ts: now - minutesAgo * 60_000, limited: false, pending: false,
    })
    // 2 hours and 61 minutes are past the retention, 59 and 20 minutes are not
    mock.store(on, { rules: [], calls: [made('twohours', 120), made('sixtyone', 61), made('fiftynine', 59), made('twenty', 20)] })
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/new'))

    // The new call, the 59-minute-old one and the 20-minute-old one
    expect(await pane.find({ text: /3 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/fiftynine/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/twohours/ })).toBeUndefined()
    expect(await pane.find({ text: /a\.test\/sixtyone/ })).toBeUndefined()
  })

  test('the retention setting changes how long calls are kept', { options: { retention: '30m' } }, async ($, on) => {
    const now = Date.now()
    const made = (id: string, minutesAgo: number) => ({
      id, url: `https://a.test/${id}`, code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00',
      ts: now - minutesAgo * 60_000, limited: false, pending: false,
    })
    mock.store(on, { rules: [], calls: [made('fortyfive', 45), made('twenty', 20)] })
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/new'))

    expect(await pane.find({ text: /2 calls/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/twenty/ })).toBeDefined()
    expect(await pane.find({ text: /a\.test\/fortyfive/ })).toBeUndefined()
  })
  test('the periods come from the timeRanges setting: units, minutes by default, bad entries left out', { options: { timeRanges: '5m, 2h,90, 1d, nonsense, 0m' } }, async ($, on) => {
    mock.store(on)
    const pane = await mountPane($)

    for (const key of ['range-5m', 'range-90m', 'range-2h', 'range-1d']) {
      expect(await pane.find({ key })).toBeDefined()
    }
    expect(await pane.find({ key: 'range-10m' })).toBeUndefined()
    expect(await pane.find({ key: 'range-0m' })).toBeUndefined()
    expect(await pane.find({ text: /^2 hours$/ })).toBeDefined()
    expect(await pane.find({ text: /^1 day$/ })).toBeDefined()
  })

  test('a command that makes no request is left alone, and Invoke-RestMethod takes -Method and -Body', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)

    const pane = await mountPane($)
    await $.tool.call({ tool: 'PowerShell', command: 'Get-ChildItem C:\\Temp' } as never)
    expect(await pane.find({ text: /No HTTP calls yet/ })).toBeDefined()

    await $.tool.call({
      tool: 'PowerShell',
      command: `Invoke-RestMethod -Method Put -Uri https://a.test/api/x -Body '{"a":1}'`,
    } as never)
    expect(await pane.find({ text: /^PUT$/ })).toBeDefined()
    expect(await pane.find({ text: /https:\/\/a\.test\/api\/x/ })).toBeDefined()
    expect(await pane.find({ text: /1 call/ })).toBeDefined()
  })

  test('a proxy\'s "Connection Established" line is not taken for the response status', async ($, on) => {
    mock.store(on)
    on(
      'tool.call',
      { tool: 'PowerShell' },
      () => ({ result: { stdout: 'HTTP/1.1 200 Connection Established\r\n\r\nHTTP/2 404 \r\ncontent-type: text/plain\r\n\r\nnope', stderr: '', interrupted: false } }) as never,
    )

    const pane = await mountPane($)
    await $.tool.call({ tool: 'PowerShell', command: 'curl.exe -s -i https://a.test/missing' } as never)

    expect(await pane.find({ text: /404/ })).toBeDefined()
    expect(await pane.find({ text: /Connection Established/ })).toBeUndefined()
  })

  test('the list shows each call\'s method, and the agent that made it (main when the main loop did)', async ($, on) => {
    mock.store(on)
    answerOk(on)

    const pane = await mountPane($)
    await $.tool.call(fetched('https://a.test/pokemon/1'))

    expect(await pane.find({ text: /^GET$/ })).toBeDefined()
    expect(await pane.find({ text: /^main$/ })).toBeDefined()

    // A call from a loop of an agent the engine lists no more is still a subagent's
    await $.tool.call({ tool: 'WebFetch', url: 'https://a.test/pokemon/2', prompt: 'x', agentId: 'sub-1' } as never)
    expect(await pane.find({ text: /^subagent$/ })).toBeDefined()

    await pane.input({ key: 'search', text: 'subagent', kind: 'change' } as never)
    expect(await pane.find({ text: /1 of 2 calls/ })).toBeDefined()
  })

  test('a call older than a minute no longer counts', async ($, on) => {
    mock.store(on, {
      rules: [{ id: 'r1', pattern: 'charizard', limit: 1 }],
      calls: [
        { id: 'c1', url: 'https://a.test/pokemon/charizard', code: 200, codeText: 'OK', durationMs: 5, at: '00:00:00', ts: Date.now() - 61_000, limited: false, pending: false },
      ],
    })
    answerOk(on)

    expect(JSON.stringify(await $.tool.call(fetched('https://a.test/pokemon/charizard')))).not.toMatch(/rate limit of/)
  })
})