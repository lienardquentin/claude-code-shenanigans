// termaid's color themes, and how a themed drawing is had from it.
//
// termaid's command line paints a theme only on a terminal: piped, as a mod runs it, the colors are gone, and a
// themed render ignores `--width`. So a themed drawing comes from termaid's Python API, through the script below,
// which answers the drawing as data: its lines, each a list of runs with the colors the theme gave them.

/** The pane's own word for termaid's plain drawing, which has no theme */
export const NO_THEME = 'none'

/** termaid's themes, as its `--themes` lists them */
export const THEMES = ['default', 'terra', 'neon', 'mono', 'amber', 'phosphor', 'gruvbox', 'monokai', 'dracula', 'nord', 'solarized'] as const

/**
 * What `python -c` is given: it reads `{ script, source, theme, width }` from standard input and runs `script`.
 * The script travels on standard input because a command line cannot be trusted to carry its quotes and newlines.
 */
export const BOOTSTRAP = "import sys,json;d=json.load(sys.stdin);exec(d['script'])"

/**
 * Draws `d['source']` in `d['theme']`, fitted to `d['width']` as termaid's command line fits a plain drawing (less
 * gap, then less padding), and prints `{ "lines": [[{ text, color?, background?, bold?, italic?, dim? }]] }`.
 * A diagram termaid cannot draw, or draws as nothing, exits 1 with the reason on standard error.
 */
export const THEMED_SCRIPT = String.raw`
import json, sys
import termaid
import termaid.output.rich as out
from termaid.renderer.themes import get_theme
from termaid.utils import display_width
from rich.console import Console
from rich.color import ColorType
from rich.style import Style

FAILED = '[termaid] Failed to render diagram: '
theme, width, source = d['theme'], d['width'], d['source']
draw_canvas = out.render_graph_canvas

def draw(gap, padding_x):
    # The themed renderer takes no gap: it is given to the canvas it draws on
    out.render_graph_canvas = lambda graph, **rest: draw_canvas(graph, gap=gap, **rest)
    return termaid.render_rich(source, padding_x=padding_x, theme=theme)

def widest(text):
    return max((display_width(line) for line in text.plain.split('\n')), default=0)

text = draw(4, 4)
for gap, padding_x in ((2, 4), (1, 4), (1, 2), (1, 0)):
    if widest(text) <= width:
        break
    text = draw(gap, padding_x)

if text.plain.startswith(FAILED):
    sys.stderr.write(text.plain[len(FAILED):])
    sys.exit(1)
if text.plain.strip() == '':
    sys.stderr.write('termaid drew nothing for this diagram.')
    sys.exit(1)

def paint(color):
    if color is None or color.type == ColorType.DEFAULT:
        return None
    # One of the terminal's own sixteen stays a name, so it follows the terminal's palette
    if color.type == ColorType.STANDARD:
        return color.name
    return color.get_truecolor().hex

def run(piece, style):
    style = style or Style()
    cell = {'text': piece}
    if paint(style.color): cell['color'] = paint(style.color)
    if paint(style.bgcolor): cell['background'] = paint(style.bgcolor)
    for name in ('bold', 'italic', 'dim'):
        if getattr(style, name): cell[name] = True
    return cell

console = Console(force_terminal=True, color_system='truecolor', width=100000, legacy_windows=False)
lines = []
for line in text.split('\n'):
    cells = []
    for segment in line.render(console):
        if segment.text == '' or segment.text == '\n':
            continue
        cell = run(segment.text, segment.style)
        if cells and {**cells[-1], 'text': ''} == {**cell, 'text': ''}:
            cells[-1]['text'] += cell['text']
        else:
            cells.append(cell)
    lines.append(cells)

# A theme that fills its ground paints every cell of a flowchart, each line as far as its last character:
# the lines are made one width so the ground is a block. (Other diagrams leave their spaces unpainted.)
th = get_theme(theme)
if th.is_solid and th.bg_default and all('background' in cell for cells in lines for cell in cells):
    full = widest(text)
    for cells, line in zip(lines, text.plain.split('\n')):
        if display_width(line) < full:
            cells.append(run(' ' * (full - display_width(line)), Style.parse(th.bg_default)))

sys.stdout.write(json.dumps({'lines': lines}))
`
