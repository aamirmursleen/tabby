'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const { buildTerminalSessionStatus } = loadDeclarations(
    'tabby-terminal/src/api/sessionStatus.ts',
    ['buildTerminalSessionStatus'],
)

test('an open tmux terminal remains visibly running', () => {
    const status = buildTerminalSessionStatus({
        frontendReady: true,
        sessionOpen: true,
        profile: { type: 'local', name: 'Mac shell', options: {} },
        process: 'tmux',
    })
    assert.deepEqual(JSON.parse(JSON.stringify(status)), {
        state: 'running',
        detail: 'Local',
        process: 'tmux',
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
    })
    assert.deepEqual(JSON.parse(JSON.stringify(status)), {
        state: 'running',
        detail: 'SSH · root@example.com:2202',
    })
})

test('terminal lifecycle distinguishes startup from a stopped session', () => {
    const profile = { type: 'ssh', name: 'Server', options: { host: 'server.test' } }
    assert.equal(buildTerminalSessionStatus({ frontendReady: false, sessionOpen: false, profile }).state, 'starting')
    assert.equal(buildTerminalSessionStatus({ frontendReady: true, sessionOpen: false, profile }).state, 'stopped')
})
