import type { EngineInterface, Register } from 'claude-code'

// Two moments get a sound:
//   done    - the main turn has ended (answered, refused or stopped by an
//             API error); not when the person interrupted it themselves
//   waiting - Claude stopped to wait for the person: a permission dialog,
//             a question (AskUserQuestion), plan approval (ExitPlanMode),
//             an MCP form or URL request, a background agent needing input
type Kind = 'done' | 'waiting'

const SOUND_FILE: Record<Kind, string> = {
  done: 'sounds/done.wav',
  waiting: 'sounds/waiting.wav',
}

// One waiting moment can raise several events (a question's tool call and
// its permission dialog): sounds closer together than this play once.
const WAITING_DEDUP_MS = 1500

// Notification types that mean "Claude is waiting for you". Left out on
// purpose: permission_prompt (the same dialog PermissionRequest already rang
// for, raised again ~6 s later) and idle_prompt (a reminder ~60 s after the
// done sound).
const WAITING_NOTIFICATIONS = new Set([
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
])

// How a sound is played: a Windows player, a Linux one, or (WSL) Windows'
// player reached from Linux.
type Player = 'powershell' | 'paplay' | 'pw-play' | 'aplay' | 'wsl-powershell'

const PLAYER_NAME: Record<Player, string> = {
  powershell: 'PowerShell (System.Media.SoundPlayer)',
  paplay: 'paplay',
  'pw-play': 'pw-play',
  aplay: 'aplay',
  'wsl-powershell': 'PowerShell via WSL',
}

const LINUX_PLAYERS: readonly Player[] = ['paplay', 'pw-play', 'aplay']

// Module variables start over on a reload, which is what these want.
let working: Player | undefined
let hasWarned = false
let lastWaitingAt = Number.NEGATIVE_INFINITY

function quotePs(text: string): string {
  return `'${text.replaceAll("'", "''")}'`
}

function powershellArgv(windowsPath: string): readonly string[] {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(New-Object System.Media.SoundPlayer ${quotePs(windowsPath)}).PlaySync()`,
  ]
}

async function playersHere($: EngineInterface): Promise<readonly Player[]> {
  if ((await $.env.get('OS')) === 'Windows_NT') return ['powershell']
  const isWsl = (await $.env.get('WSL_DISTRO_NAME')) !== undefined

  return isWsl ? [...LINUX_PLAYERS, 'wsl-powershell'] : LINUX_PLAYERS
}

async function argvFor(
  $: EngineInterface,
  player: Player,
  file: string,
): Promise<readonly string[]> {
  switch (player) {
    case 'powershell':
      return powershellArgv(file.replaceAll('/', '\\'))
    case 'paplay':
      return ['paplay', file]
    case 'pw-play':
      return ['pw-play', file]
    case 'aplay':
      return ['aplay', '-q', file]
    case 'wsl-powershell': {
      const { exitCode, stdout } = await $.process.run(['wslpath', '-w', file])
      if (exitCode !== 0) throw new Error('wslpath failed')

      return powershellArgv(stdout.trim())
    }
  }
}

// Plays one sound; resolves the player's name, or undefined when none could.
async function play($: EngineInterface, kind: Kind): Promise<string | undefined> {
  const file = `${$.plugin.root}/${SOUND_FILE[kind]}`
  const here = await playersHere($)
  const last = working
  const ordered =
    last !== undefined && here.includes(last)
      ? [last, ...here.filter(one => one !== last)]
      : here

  for (const player of ordered) {
    try {
      const argv = await argvFor($, player, file)
      const { exitCode } = await $.process.run(argv, { timeoutMs: 10_000 })
      if (exitCode === 0) {
        working = player

        return PLAYER_NAME[player]
      }
    } catch {
      // not installed, or it could not start: try the next one
    }
  }
  working = undefined
  if (!hasWarned) {
    hasWarned = true
    $.ui.toast(
      'sound-notify: no sound player worked here. ' +
        'Linux needs paplay, pw-play or aplay; Windows needs powershell.exe.',
      { timeoutMs: 8000 },
    )
  }

  return undefined
}

// Starts a sound without holding up the hook that asked for it.
async function ring($: EngineInterface, kind: Kind): Promise<void> {
  if (kind === 'waiting') {
    const now = await $.clock.now()
    if (now - lastWaitingAt < WAITING_DEDUP_MS) return
    lastWaitingAt = now
  }
  $.clock.after(0, () => {
    play($, kind).catch(() => undefined)
  })
}

function said(name: string | undefined): string {
  return name ?? 'could not play'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sound-notify-test',
      description: 'Play the done and waiting sounds of sound-notify once',
    })

    return next(e)
  })

  on('command.run', { command: 'sound-notify-test' }, async $ => {
    const done = await play($, 'done')
    const waiting = await play($, 'waiting')

    return {
      text: `sound-notify: done sound: ${said(done)}; waiting sound: ${said(waiting)}`,
    }
  })

  // done: the main loop's turn ended, unless the person interrupted it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason !== 'aborted') await ring($, 'done')

    return result
  })

  // waiting: a permission dialog is about to be shown.
  on('classic.PermissionRequest', async ($, e, next) => {
    await ring($, 'waiting')

    return next(e)
  }).catch(($, e, next) => next(e))

  // waiting: a question or a plan approval, before its dialog opens.
  on('tool.call', { tool: ['AskUserQuestion', 'ExitPlanMode'] }, async ($, e, next) => {
    await ring($, 'waiting')

    return next(e)
  }).catch(($, e, next) => next(e))

  // waiting: an MCP form or URL request, or a background agent asking.
  on('classic.Notification', async ($, e, next) => {
    if (WAITING_NOTIFICATIONS.has(e.notification_type)) await ring($, 'waiting')

    return next(e)
  }).catch(($, e, next) => next(e))
}
