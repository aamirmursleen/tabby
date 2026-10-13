'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const { buildTerminalSessionStatus } = loadDeclarations(
    'tabby-terminal/src/api/sessionStatus.ts',
    ['formatSessionWorkingDirectory', 'buildTerminalSessionStatus'],
)

test('an open tmux terminal remains visibly running', () => {
    const status = buildTerminalSessionStatus({
        frontendReady: true,
        sessionOpen: true,
        profile: { type: 'local', name: 'Mac shell', options: {} },
        process: 'tmux',
        workingDirectory: '/Users/aamir/tabby',
        resumeContext: { tmuxSession: 'tabby-dev', workingDirectory: '/Users/aamir/tabby' },
        homeDirectory: '/Users/aamir',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(status)), {
        state: 'running',
        detail: 'Local',
        process: 'tmux',
        workingDirectory: '~/tabby',
        tmuxSession: 'tabby-dev',
        resumeContext: { tmuxSession: 'tabby-dev', workingDirectory: '/Users/aamir/tabby' },
    })
})

test('SSH status exposes the connection identity without credentials', () => {
    const status = buildTerminalSessionStatus({
        frontendReady: true,
        sessionOpen: true,
        profile: {
            type: 'ssh',
            name: 'Production',
            options: { user: 'root', host: 'example.com', port: 2202, password: 'secret' },
        },
        workingDirectory: '/root/apps/api',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(status)), {
        state: 'running',
        detail: 'SSH · root@example.com:2202',
        workingDirectory: '~/apps/api',
    })
})

test('working directories outside the session home stay absolute', () => {
    const status = buildTerminalSessionStatus({
        frontendReady: true,
        sessionOpen: true,
        profile: { type: 'ssh', name: 'Production', options: { user: 'deploy', host: 'example.com' } },
        workingDirectory: '/srv/application',
    })
    assert.equal(status.workingDirectory, '/srv/application')
})

test('stopped sessions do not show a stale working directory', () => {
    const status = buildTerminalSessionStatus({
        frontendReady: true,
        sessionOpen: false,
        profile: { type: 'local', name: 'Mac shell', options: {} },
        workingDirectory: '/Users/aamir/tabby',
        homeDirectory: '/Users/aamir',
    })
    assert.equal(status.workingDirectory, undefined)
})

test('terminal lifecycle distinguishes startup from a stopped session', () => {
    const profile = { type: 'ssh', name: 'Server', options: { host: 'server.test' } }
    assert.equal(buildTerminalSessionStatus({ frontendReady: false, sessionOpen: false, profile }).state, 'starting')
    assert.equal(buildTerminalSessionStatus({ frontendReady: true, sessionOpen: false, profile }).state, 'stopped')
})
