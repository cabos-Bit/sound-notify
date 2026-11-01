import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Run = { argv: readonly string[] }

const EXITED = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

// Stands for the host beneath the plugin: records every command the plugin
// runs; `missing` lists executables that cannot start, `failing` ones that
// start and exit 1.
function host(
  on: On,
  { missing = [], failing = [] }: { missing?: string[]; failing?: string[] } = {},
) {
  const runs: Run[] = []
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    const exe = e.argv[0] ?? ''
    runs.push({ argv: e.argv })
    if (missing.includes(exe)) return { deny: `${exe}: not found` }
    if (exe === 'wslpath') {
      return { value: { ...EXITED, stdout: 'C:\\mods\\sounds\\x.wav\n' } }
    }

    return { value: { ...EXITED, exitCode: failing.includes(exe) ? 1 : 0 } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.Notification', () => ({}))

  return { runs, toasts }
}

const TURN = {
  answer: 'done',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
} as const

const sound = (run: Run | undefined) => run?.argv.at(-1) ?? ''

test('a finished main turn plays done.wav with paplay on Linux', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.turn.complete(TURN)
  await clock.settle()

  expect(runs.length).toBe(1)
  expect(runs[0]?.argv[0]).toBe('paplay')
  expect(sound(runs[0]).endsWith('/sound-notify/sounds/done.wav')).toBe(true)
})

test('an error or a refusal ending the turn plays done too', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.turn.complete({ ...TURN, reason: 'error' })
  await $.turn.complete({
    ...TURN,
    reason: 'refusal',
    refusal: { category: null, explanation: null },
  })
  await clock.settle()

  expect(runs.length).toBe(2)
})

test('an interrupted turn and a subagent turn play nothing', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.turn.complete({ ...TURN, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...TURN, agentId: 'a1' })
  await clock.settle()

  expect(runs.length).toBe(0)
})

test('on Windows the sound goes through PowerShell with a Windows path', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.turn.complete(TURN)
  await clock.settle()

  const argv = runs[0]?.argv ?? []
  expect(argv[0]).toBe('powershell.exe')
  expect(argv.includes('-NoProfile')).toBe(true)
  const script = argv.at(-1) ?? ''
  expect(script.startsWith("(New-Object System.Media.SoundPlayer '")).toBe(true)
  expect(script.endsWith("\\sounds\\done.wav').PlaySync()")).toBe(true)
  expect(script.includes('/')).toBe(false)
})

test('a missing or failing player falls through to the next, then is skipped', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on, { missing: ['paplay'], failing: ['pw-play'] })

  await $.turn.complete(TURN)
  await clock.settle()
  expect(runs.map(r => r.argv[0])).toEqual(['paplay', 'pw-play', 'aplay'])
  expect(runs[2]?.argv).toEqual(['aplay', '-q', sound(runs[2])])

  // The player that worked is tried first from then on.
  await $.turn.complete(TURN)
  await clock.settle()
  expect(runs.map(r => r.argv[0])).toEqual(['paplay', 'pw-play', 'aplay', 'aplay'])
})

test('WSL falls back to PowerShell with the path wslpath gives', async ($, on) => {
  mock.env(on, { WSL_DISTRO_NAME: 'Ubuntu' })
  const clock = mock.clock(on)
  const { runs } = host(on, { missing: ['paplay', 'pw-play', 'aplay'] })

  await $.turn.complete(TURN)
  await clock.settle()

  const exes = runs.map(r => r.argv[0])
  expect(exes).toEqual(['paplay', 'pw-play', 'aplay', 'wslpath', 'powershell.exe'])
  expect(runs[3]?.argv[2]?.endsWith('/sounds/done.wav')).toBe(true)
  expect(sound(runs[4])).toBe(
    "(New-Object System.Media.SoundPlayer 'C:\\mods\\sounds\\x.wav').PlaySync()",
  )
})

test('no player at all: one toast, once', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { toasts } = host(on, { missing: ['paplay', 'pw-play', 'aplay'] })

  await $.turn.complete(TURN)
  await clock.settle()
  await $.turn.complete(TURN)
  await clock.settle()

  expect(toasts.length).toBe(1)
  expect(toasts[0]?.startsWith('sound-notify: no sound player worked here.')).toBe(true)
})

test('a question plays waiting.wav, once even with its permission dialog', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which one?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
  })
  await $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: {} })
  await clock.settle()

  expect(runs.length).toBe(1)
  expect(sound(runs[0]).endsWith('/sounds/waiting.wav')).toBe(true)

  // 1.5 s later the next wait rings again.
  await clock.advance(1500)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await clock.settle()
  expect(runs.length).toBe(2)
})

test('plan approval rings waiting; other tools do not', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(runs.length).toBe(0)

  await $.tool.call({ tool: 'ExitPlanMode' })
  await clock.settle()
  expect(runs.length).toBe(1)
  expect(sound(runs[0]).endsWith('/sounds/waiting.wav')).toBe(true)
})

test('only the waiting notification types ring', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  const { runs } = host(on)

  for (const type of ['permission_prompt', 'idle_prompt', 'auth_success']) {
    await $.classic.Notification({ message: 'm', notification_type: type })
  }
  await clock.settle()
  expect(runs.length).toBe(0)

  for (const type of ['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    await clock.advance(2000)
    await $.classic.Notification({ message: 'm', notification_type: type })
  }
  await clock.settle()
  expect(runs.length).toBe(3)
})

test('/sound-notify-test plays both and says which player did', async ($, on) => {
  mock.env(on, {})
  mock.clock(on)
  const { runs } = host(on)
  on('command.register', () => ({ value: { command: 'sound-notify-test' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { text } = await $.command.run({
    command: 'sound-notify-test',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  expect(runs.map(r => sound(r).split('/').at(-1))).toEqual(['done.wav', 'waiting.wav'])
  expect(text).toBe('sound-notify: done sound: paplay; waiting sound: paplay')
})
