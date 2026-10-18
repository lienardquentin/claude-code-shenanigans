import type { EngineInterface } from 'claude-code'

import { blocking, examine } from '../core/doctor'
import type { Check } from '../core/doctor'
import { rootOf } from './flow'
import { installedOf, lagging } from './lag'
import { CONFIG_FILE, LINES_FILE } from '../core/config'
import { projectErrors, targetsRead } from './verify/register'

// The doctor, through the engine: what it runs, and what it is told of the project.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

/** Every check of this machine and project, as /theseus doctor answers them. */
export async function doctorOf($: $): Promise<Check[]> {
  const root = await rootOf($)
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  // An install record that is not there names no plugin: Theseus was loaded from its folder
  const record = await $.fs.read(`${config.replace(/\/+$/, '')}/plugins/installed_plugins.json`).catch(() => '')

  return examine(
    {
      run: argv => $.process.run([...argv], { cwd: root, timeoutMs: 20_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: String(error) })),
      exists: path => $.fs.exists(path),
    },
    {
      root,
      configFile: (await $.fs.exists(`${root}/${CONFIG_FILE}`)) ? CONFIG_FILE : (await $.fs.exists(`${root}/${LINES_FILE}`)) ? LINES_FILE : '',
      targets: await targetsRead($),
      ...(({ errors, warnings }) => ({ configErrors: errors, configWarnings: warnings }))(projectErrors()),
      installed: installedOf(String(record)).map(one => one.id),
      lags: (await lagging($)).map(lag => `${lag.plugin} ${lag.why === 'gone' ? `is installed but gone from ${lag.source ?? 'its folder'}` : `differs from ${lag.source ?? 'its folder'}`}`),
    },
  )
}

/** What stops a run from starting here, as one sentence; nothing when nothing does. */
export async function startRefusal($: $): Promise<string | undefined> {
  const stopped = blocking(await doctorOf($))

  return stopped.length === 0 ? undefined : `Theseus cannot start a run here: ${stopped.map(check => `${check.name} (${check.fix})`).join('; ')}. /theseus doctor lists every check.`
}
