# A remote Claude Code driving the local browser

Claude Code runs on a remote machine over ssh, the frontend app runs there too, and you look at it in the Chrome of
your own machine through a forwarded port. This is how to let that remote Claude work in the same Chrome: read its
console and network, click, type, take screenshots, run scripts in the page.

[`scripts/remote-browser.ps1`](../scripts/remote-browser.ps1) does the local half. It is written for Windows and
PowerShell.

## How it works

One ssh connection carries two tunnels, in opposite directions:

```
 your machine                                   remote machine
 ------------                                   --------------
 Chrome, debug port 127.0.0.1:9222  <--- -R ---  127.0.0.1:9222  <- chrome-devtools-mcp <- Claude Code
 Chrome tab on localhost:3000       ---- -L -->  127.0.0.1:3000  <- the app
```

- `-L` brings the app to your browser, as any port forward does.
- `-R` hands your Chrome's DevTools protocol port to the remote machine. There, the
  [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) server attaches to it and Claude
  Code gets its tools.

Chrome refuses the debug port on its default profile, so the script starts Chrome on a profile of its own, in
`%LOCALAPPDATA%\claude-debug-chrome`. It is kept between runs: a login done in it stays.

## What it needs

- On your machine: Chrome and the OpenSSH client (`ssh`), both found by the script.
- On the remote machine: Claude Code, and Node 20.19 or later for `npx chrome-devtools-mcp` (Node 22 is what was
  tested; the Node 18 that Ubuntu 24.04 ships through apt is too old).
- An ssh access to the remote that allows port forwarding.

## Once: register the MCP server on the remote

```powershell
.\scripts\remote-browser.ps1 -Remote user@host -Install
```

It runs this on the remote, in a bash login shell, and you can run it there by hand instead:

```sh
claude mcp add --scope user my-chrome -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
```

## Each session

```powershell
.\scripts\remote-browser.ps1 -Remote user@host -AppPort 3000
```

1. Chrome starts on the debug profile, and the script waits for its debug port to answer.
2. ssh opens with both tunnels and leaves you in a shell on the remote.
3. Once the tunnel listens, a tab opens on `http://localhost:3000`.
4. Start the app and `claude` in that shell. The tools of `my-chrome` work on the tabs of that Chrome window.

The `runtime` mod reads through the same port, with no MCP server between: why the app's components render and how
its page stands ([how](https://github.com/lienardquentin/theseus/blob/main/runtime/browser/README.md)).

The tunnel lasts as long as the ssh session. Closing it cuts Claude off from the browser; the Chrome window stays.

An app whose page calls its APIs from the browser, or APIs you want to call from your machine, need their ports
too:

```powershell
.\scripts\remote-browser.ps1 -Remote user@host -AppPort 8100 -Forward 8101,8102
```

## Parameters

| Parameter        | Default     | What it is                                                                        |
| ---------------- | ----------- | --------------------------------------------------------------------------------- |
| `-Remote`        | required    | The ssh destination: `user@host`, or a `Host` of your ssh config.                 |
| `-AppPort`       | `3000`      | The port you browse the app on, on your machine.                                  |
| `-RemoteAppPort` | `-AppPort`  | The app's port on the remote, when the same one is not free on your machine.      |
| `-Forward`       | none        | Other ports of the remote brought to your machine, its APIs for instance: `8101,8102`, or `8111:8101` for local:remote. |
| `-DebugPort`     | `9222`      | Chrome's debug port, the same on both ends.                                       |
| `-McpName`       | `my-chrome` | The name the MCP server is registered under by `-Install`.                        |
| `-SshConfig`     | none        | An ssh config file to use in place of `~/.ssh/config`.                            |
| `-TunnelOnly`    | off         | Holds the tunnel without a shell, for when `claude` runs in another ssh session.  |
| `-Install`       | off         | Registers the MCP server on the remote and exits.                                 |

## What to keep in mind

- **The debug port is full control of that Chrome profile.** Anything on the remote machine that can reach its
  `127.0.0.1:9222` can read and drive every tab of the debug window, while the tunnel is open. Both ends are bound
  to the loopback, but other users and processes of the remote share that loopback. Keep personal accounts out of
  the debug profile.
- **It is not your everyday Chrome.** The debug profile has none of your logins, cookies or extensions. Sign in to
  the app there once.
- **`chrome-devtools-mcp` sends usage statistics to Google** unless it is started with `--no-usage-statistics`, and
  its performance tools may send trace URLs to the CrUX API unless `--no-performance-crux` is given. Add them to the
  `claude mcp add` line if that matters.
- **With nvm on the remote, `npx` is only on the PATH of an interactive shell.** Start `claude` from one. Started
  from a non-interactive command (`ssh host claude -p …`), the server fails with `Executable not found in $PATH:
  "npx"` unless nvm is loaded first.
- **If the script says Chrome does not answer**, a debug-profile window from an earlier run, started without the
  port, is still open. Close it and run the script again.
- **If ssh exits at once with a forwarding error**, one of the two ports is taken: `-AppPort` on your machine, or
  `-DebugPort` on the remote (an earlier session there may still hold it).

## Trying it without a remote machine

A WSL2 distro can play the remote: with WSL's default NAT networking it has a loopback of its own, so the Windows
Chrome is only reachable from it through the tunnel. This is how the setup was checked.

1. In the distro: install `openssh-server`, a Node 22, and authorize an ssh key.
2. Serve a page that logs to the console on the distro's `127.0.0.1:3000`.
3. Run the script against the distro's address, with another local port, because WSL already relays the distro's
   listening ports to Windows' localhost and `-L 3000` would find the port taken:

   ```powershell
   .\scripts\remote-browser.ps1 -Remote root@<distro ip> -AppPort 3001 -RemoteAppPort 3000 -TunnelOnly
   ```

4. In the distro, `curl http://127.0.0.1:9222/json/list` lists the Windows Chrome's tabs, the page among them, and
   `chrome-devtools-mcp --browserUrl http://127.0.0.1:9222` returns the page's console messages.

Checked that way: both tunnels, the tab opening, and `chrome-devtools-mcp` 1.10.1 listing the pages, reloading the
tab, reading its console and evaluating a script in it, against Chrome 154, and `-Install` registering the server
for a non-root user, and the `beacons` of this repo run in the distro, with Anor on `-AppPort 8110 -RemoteAppPort
8100` and its two APIs on `-Forward 8111:8101,8112:8102`. Not checked: the mode with a shell (the run used `-TunnelOnly`), and a Claude Code session
calling the tools (the server was spoken to directly).

## The alternatives

- **A headless browser on the remote**, `chrome-devtools-mcp --headless --isolated` with no tunnel. Simpler, and
  enough for Claude to check its own changes, but it is another browser than the one you are looking at.
- **A second Claude Code on your machine with the Claude in Chrome extension.** It drives your everyday Chrome, with
  your logins, but the Claude that sees the browser is then not the one that edits the code.
