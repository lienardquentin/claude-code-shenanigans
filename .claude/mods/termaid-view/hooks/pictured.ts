// A diagram as a picture, for the surfaces that draw one (the desktop app, VS Code, mobile): Mermaid's own drawing.
//
// Mermaid draws in a browser, and a mod has none. So the Mermaid CLI is run on the host, through `npx`, with a
// browser already installed there (Edge, Chrome or Chromium: none is downloaded), and answers the drawing as an
// SVG document. The diagram is written to a file of a folder made for the run and removed after it: nothing of it
// leaves the machine.

/** The one place the Mermaid CLI's version is fixed: the code `npx` fetches and runs changes only when this does */
export const MERMAID_CLI_VERSION = '12.0.0'

/** Mermaid's own themes, the first the one a picture is drawn in until another is picked */
export const PICTURE_THEMES = ['default', 'neutral', 'forest', 'dark'] as const

/** The ground a theme is drawn on: a picture carries its own, whatever the app's is */
export const groundOf = (theme: string): string => (theme === 'dark' ? 'black' : 'white')

/**
 * What `node -e` is given: it reads `{ script, source, version, theme, background, timeoutMs }` from standard input
 * and runs `script`. The script travels on standard input, as the diagram does, so no quote or newline of either
 * is ever on a command line.
 */
export const NODE_BOOTSTRAP =
  "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);new Function('d','require',d.script)(d,require)})"

/** What the script says on standard error, before exiting 1, when it is not the Mermaid CLI's own message */
export const NO_BROWSER = 'NO_BROWSER'
export const NO_NPX = 'NO_NPX'
export const PICTURE_TIMED_OUT = 'TIMED_OUT'

/**
 * Draws `d.source` with the Mermaid CLI at `d.version`, in `d.theme` on `d.background`, and prints `{ "svg" }`: the
 * drawing given its own size, its paths' numbers cut to one decimal (they are most of its length). A diagram
 * Mermaid cannot draw exits 1 with the CLI's message on standard error; so do no browser, no `npx` and a run
 * longer than `d.timeoutMs`, each with its word above.
 */
export const PICTURE_SCRIPT = String.raw`
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const fail = reason => {
  process.stderr.write(reason)
  process.exit(1)
}

// The browser Mermaid draws in: one already installed, so none is downloaded
const env = process.env
const installed =
  process.platform === 'win32'
    ? [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA]
        .filter(Boolean)
        .flatMap(root => [path.join(root, 'Microsoft/Edge/Application/msedge.exe'), path.join(root, 'Google/Chrome/Application/chrome.exe')])
    : process.platform === 'darwin'
      ? ['Google Chrome', 'Microsoft Edge', 'Chromium'].map(name => '/Applications/' + name + '.app/Contents/MacOS/' + name)
      : ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser'].map(name => '/usr/bin/' + name)
const browser = [env.PUPPETEER_EXECUTABLE_PATH, ...installed].find(candidate => candidate && fs.existsSync(candidate))
if (!browser) fail('NO_BROWSER')

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'termaid-view-'))
const leave = () => fs.rmSync(folder, { recursive: true, force: true })

fs.writeFileSync(path.join(folder, 'in.mmd'), d.source)
// Labels as SVG text: a picture drawn as an image shows no HTML inside it
fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ htmlLabels: false, flowchart: { htmlLabels: false }, securityLevel: 'strict' }))

// Every argument is the mod's own word (a version, a theme of its list, a file name of this folder): the diagram
// is read from its file, so nothing of it reaches the command line
const argv = ['-y', '@mermaid-js/mermaid-cli@' + d.version, '-q', '-i', 'in.mmd', '-o', 'out.svg', '-c', 'config.json', '-t', d.theme, '-b', d.background]
const options = { cwd: folder, env: { ...env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_EXECUTABLE_PATH: browser }, windowsHide: true }
// On Windows npx is a command file, which only a shell starts
const child = process.platform === 'win32' ? spawn('npx ' + argv.join(' '), { ...options, shell: true }) : spawn('npx', argv, options)

let said = ''
child.stdout.on('data', piece => (said += piece))
child.stderr.on('data', piece => (said += piece))

// Past its time the whole tree is ended (npx, the CLI, the browser), which ending this process alone would leave
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
  leave()
  fail('TIMED_OUT')
}, d.timeoutMs)

child.on('error', error => {
  clearTimeout(timer)
  leave()
  fail('NO_NPX ' + error.message)
})
child.on('close', code => {
  clearTimeout(timer)
  const out = path.join(folder, 'out.svg')
  const svg = code === 0 && fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : undefined
  leave()
  if (svg === undefined) fail(said.trim() || 'The Mermaid CLI failed (exit code ' + code + ') without a message.')

  // Mermaid sizes its drawing to the page (width 100%, a max-width): as a picture it is given its own size
  const box = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  const size = box ? '<svg width="' + Math.ceil(Number(box[1])) + '" height="' + Math.ceil(Number(box[2])) + '"' : '<svg'
  const sized = box
    ? svg.replace(/<svg\b[^>]*>/, tag =>
        tag.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '').replace(/max-width:[^;"]*;?\s*/, '').replace(/^<svg/, size))
    : svg
  const short = sized.replace(/\sd="[^"]*"/g, drawn => drawn.replace(/(\d+\.\d)\d+/g, '$1'))
  process.stdout.write(JSON.stringify({ svg: short }))
})
`
