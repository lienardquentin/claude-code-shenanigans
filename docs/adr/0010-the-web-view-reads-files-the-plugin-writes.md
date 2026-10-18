# The web view reads files the plugin writes

`/theseus ui` shows runs in a browser. A hooks module has no network server of its own: it runs with no Node and no
DOM, reaching the machine through `$`. So the page is served by a small Node server the plugin starts with
`$.process.spawn`, whose life is the session's.

The server computes nothing. After every change it keeps of a run, the plugin writes the run's view model (#160) as
a line of `.theseus/views/<run>.jsonl`; the server serves those files and the runs' logs, and streams them as they
change. The one model is computed in one place, by the plugin, and the page draws it as the terminal does. The
snapshots, kept a line each, are also what the page plays a run again from.

An action pressed on the page is written by the server to `.theseus/requests.jsonl`; the plugin's clock takes it on
its next tick and does it through the same dispatcher as a press in the terminal (`dispatch`, a verb of
`/theseus build`). What would send an agent waits for a hook, as a press in a pane does.

## Consequences

- The server listens on 127.0.0.1 alone and answers no API call without a token the session makes; it reads nothing
  outside the project's `.theseus/` folder, and accepts only the six actions, on a run that has a view.
- The page is one self-contained file, so a run's report is the same page with the run written into it, opened from
  disk with no server.
- The page's source lives beside the plugin (`.claude/mods/theseus-web`), not in it: an install copies the built page,
  not its dependencies.
- The web view needs Node 18 or later; the rest of Theseus does not.
