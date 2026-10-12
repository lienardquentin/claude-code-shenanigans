// termaid's color themes, and how a themed drawing is had from it.
//
// termaid's command line paints a theme only on a terminal: piped, as a mod runs it, the colors are gone, and a
// themed render ignores `--width`. So a themed drawing comes from termaid's Python API, through the script below,
// which answers the drawing as data: its lines, each a list of runs with the colors the theme gave them.
//
// The same script draws a diagram whose nodes are linked (`click A href "src/a.ts#L12"`), in a theme or not: only
// there can it be known where termaid put each node, so the runs of a linked node carry the node's target.

/** The pane's own word for termaid's plain drawing, which has no theme */
export const NO_THEME = 'none'

/** termaid's themes, as its `--themes` lists them */
export const THEMES = ['default', 'terra', 'neon', 'mono', 'amber', 'phosphor', 'gruvbox', 'monokai', 'dracula', 'nord', 'solarized'] as const

/**
 * What `python -c` is given: it reads `{ script, source, theme, width, links }` from standard input and runs `script`.
 * The script travels on standard input because a command line cannot be trusted to carry its quotes and newlines.
 */
export const BOOTSTRAP = "import sys,json;d=json.load(sys.stdin);exec(d['script'])"

/**
 * Draws `d['source']` in `d['theme']`, fitted to `d['width']` as termaid's command line fits a plain drawing (less
 * gap, then less padding), and prints `{ "lines": [[{ text, color?, background?, bold?, italic?, dim?, link? }]] }`.
 * The theme `none` draws without colors. `d['links']` gives the target of each linked node, by the node's id: the
 * runs inside the box of such a node (of a flowchart: the one diagram whose nodes termaid places) carry it as `link`.
 * A diagram termaid cannot draw, or draws as nothing, exits 1 with the reason on standard error.
 */
export const THEMED_SCRIPT = String.raw`
import json, sys
import termaid
import termaid.output.rich as out
import termaid.renderer.draw as drawing
from termaid.graph.model import Direction
from termaid.renderer.themes import get_theme
from termaid.utils import display_width
from rich.console import Console
from rich.color import ColorType
from rich.style import Style

FAILED = '[termaid] Failed to render diagram: '
theme, width, source, links = d['theme'], d['width'], d['source'], d.get('links') or {}
is_plain = theme == 'none'
if is_plain:
    theme = 'default'
draw_canvas = out.render_graph_canvas
draw_nodes = drawing._draw_nodes

# Where the last draw put each node, as termaid laid it out (before a bottom-up or right-to-left diagram is
# turned over), and the canvas it was drawn on
boxes = {}
last = {}

def note_nodes(canvas, graph, layout, cs):
    for node, at in layout.placements.items():
        boxes[node] = (at.draw_x, at.draw_y, at.draw_width, at.draw_height)
    return draw_nodes(canvas, graph, layout, cs)

drawing._draw_nodes = note_nodes

def note_canvas(graph, gap, **rest):
    canvas = draw_canvas(graph, gap=gap, **rest)
    last['canvas'], last['direction'] = canvas, graph.direction
    return canvas

def draw(gap, padding_x):
    boxes.clear()
    last.clear()
    # The themed renderer takes no gap: it is given to the canvas it draws on
    out.render_graph_canvas = lambda graph, **rest: note_canvas(graph, gap, **rest)
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

# The target of each cell of a linked node's box, by (row, column) of the drawing
targets = {}
canvas = last.get('canvas')
if canvas is not None:
    for node, target in links.items():
        if node not in boxes or not isinstance(target, str):
            continue
        x, y, w, h = boxes[node]
        if last['direction'] == Direction.RL:
            x = canvas.width - x - w
        if last['direction'] == Direction.BT:
            y = canvas.height - y - h
        for row in range(y, y + h):
            for column in range(x, x + w):
                targets[(row, column)] = target

def run(piece, style, target=None):
    style = Style() if is_plain or style is None else style
    cell = {'text': piece}
    if target is not None: cell['link'] = target
    if paint(style.color): cell['color'] = paint(style.color)
    if paint(style.bgcolor): cell['background'] = paint(style.bgcolor)
    for name in ('bold', 'italic', 'dim'):
        if getattr(style, name): cell[name] = True
    return cell

console = Console(force_terminal=True, color_system='truecolor', width=100000, legacy_windows=False)
lines = []
for row, line in enumerate(text.split('\n')):
    cells = []
    column = 0
    for segment in line.render(console):
        if segment.text == '' or segment.text == '\n':
            continue
        # A canvas cell is one character, so a character's place in its line is its column
        for character in segment.text:
            cell = run(character, segment.style, targets.get((row, column)))
            column += 1
            if cells and {**cells[-1], 'text': ''} == {**cell, 'text': ''}:
                cells[-1]['text'] += cell['text']
            else:
                cells.append(cell)
    lines.append(cells)

# A theme that fills its ground paints every cell of a flowchart, each line as far as its last character:
# the lines are made one width so the ground is a block. (Other diagrams leave their spaces unpainted.)
th = get_theme(theme)
if not is_plain and th.is_solid and th.bg_default and all('background' in cell for cells in lines for cell in cells):
    full = widest(text)
    for cells, line in zip(lines, text.plain.split('\n')):
        if display_width(line) < full:
            cells.append(run(' ' * (full - display_width(line)), Style.parse(th.bg_default)))

sys.stdout.write(json.dumps({'lines': lines}))
`
