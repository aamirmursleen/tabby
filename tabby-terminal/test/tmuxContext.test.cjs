'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const {
    buildTmuxResumeCommand,
    buildShellTmuxResumeOptions,
    buildSessionResumeCommand,
    parseTmuxClientContexts,
    sanitizeSessionResumeContext,
    selectTmuxClientContext,
} = loadDeclarations(
    'tabby-terminal/src/utils/tmuxContext.ts',
    [
        'cleanValue',
        'sanitizeSessionResumeContext',
        'parseTmuxClientContexts',
        'selectTmuxClientContext',
        'quoteShellArgument',
        'buildTmuxResumeCommand',
        'buildShellTmuxResumeOptions',
        'buildSessionResumeCommand',
    ],
)

test('tmux clients select the exact terminal client before recent or same-directory clients', () => {
    const contexts = parseTmuxClientContexts([
        '710\t200\twitty-worker\t/srv/witty',
        '412\t100\tcalendar-api\t/srv/calendar',
        '999\t300\tother\t/srv/calendar',
    ].join('\n'))

    assert.deepEqual(JSON.parse(JSON.stringify(selectTmuxClientContext(contexts, new Set([412]), '/srv/calendar'))), {
        tmuxSession: 'calendar-api',
        workingDirectory: '/srv/calendar',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(selectTmuxClientContext(contexts, new Set(), '/srv/witty'))), {
        tmuxSession: 'witty-worker',
        workingDirectory: '/srv/witty',
    })
})

test('tmux resume commands safely preserve session names and working directories', () => {
    assert.equal(
        buildTmuxResumeCommand({ tmuxSession: "Mama's API", workingDirectory: "/srv/mama's api" }),
        "tmux new-session -A -s 'Mama'\\''s API' -c '/srv/mama'\\''s api'",
    )
    assert.equal(buildTmuxResumeCommand({ tmuxSession: 'bad\nname', workingDirectory: '/srv/app' }), null)
    assert.equal(sanitizeSessionResumeContext({ workingDirectory: '/srv/app' }).workingDirectory, '/srv/app')
    assert.equal(buildSessionResumeCommand({ workingDirectory: "/srv/Mama's App" }), "cd -- '/srv/Mama'\\''s App'")
})

test('local tmux resumes only through supported interactive shells', () => {
    const original = { command: '/bin/zsh', args: ['--login'], cwd: null }
    const resumed = buildShellTmuxResumeOptions(original, { tmuxSession: 'calendar', workingDirectory: '/srv/calendar' })
    assert.equal(resumed.cwd, '/srv/calendar')
    assert.deepEqual(Array.from(resumed.args.slice(0, 3)), ['--login', '-i', '-c'])
    assert.equal(resumed.args[3], "tmux new-session -A -s 'calendar' -c '/srv/calendar'; exec '/bin/zsh' '--login'")
    assert.deepEqual(original, { command: '/bin/zsh', args: ['--login'], cwd: null })
    assert.equal(buildShellTmuxResumeOptions({ command: 'python', args: [], cwd: null }, { tmuxSession: 'x' }), null)
    assert.equal(buildShellTmuxResumeOptions({ command: 'zsh', args: ['-lc'], cwd: null }, { tmuxSession: 'x' }), null)
})
