'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')

function component (globals = {}) {
    return loadDeclarations('tabby-local/src/components/terminalTab.component.ts', ['TerminalTabComponent'], {
        Component: () => target => target, Input: () => () => {}, Optional: () => () => {},
        require: () => '',
        _: text => text,
        UACService: class {}, BaseTerminalTabComponent: class {},
        ...globals,
    }).TerminalTabComponent
}

test('refreshing a local shell keeps its pane and working directory without restoring the old PTY', async () => {
    const TerminalTabComponent = component()
    const events = []
    const oldSession = {
        open: true,
        getChildProcesses: async () => [],
        getWorkingDirectory: async () => '/working/project',
        destroy: async () => { events.push('destroy') },
    }
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        session: oldSession,
        frontendIsReady: true,
        size: { columns: 132, rows: 42 },
        profile: { options: { cwd: '/original', restoreFromPTYID: 'old-pty' } },
        frontend: { resetTerminalModes: () => events.push('reset-modes') },
        setSession: session => { events.push('detach'); tab.session = session },
        initializeSession: async (...args) => { events.push('start'); assert.deepEqual(args, [132, 42, '/working/project', true]) },
    })

    await tab.refreshSession()

    assert.deepEqual(events, ['detach', 'destroy', 'reset-modes', 'start'])
    assert.equal(tab.profile.options.restoreFromPTYID, 'old-pty')
    assert.equal(tab.refreshing, false)
})

test('refresh asks before stopping a running local command and Cancel leaves it untouched', async () => {
    const TerminalTabComponent = component()
    let destroyed = false
    let started = false
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        session: {
            open: true,
            getChildProcesses: async () => [{ command: 'claude' }],
            destroy: async () => { destroyed = true },
        },
        frontendIsReady: true,
        size: { columns: 80, rows: 30 },
        platform: { showMessageBox: async options => {
            assert.match(options.message, /claude/)
            assert.equal(options.defaultId, 1)
            assert.equal(options.cancelId, 1)
            return { response: 1 }
        } },
        translate: { instant: (text, values) => text.replace('{command}', values?.command ?? '') },
        initializeSession: () => { started = true },
    })

    await tab.refreshSession()

    assert.equal(destroyed, false)
    assert.equal(started, false)
    assert.equal(tab.refreshing, false)
})

test('refresh keeps the current shell when running commands cannot be inspected', async () => {
    const TerminalTabComponent = component()
    const notices = []
    let destroyed = false
    const oldSession = {
        getChildProcesses: async () => { throw new Error('process inspection unavailable') },
        destroy: async () => { destroyed = true },
    }
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        session: oldSession,
        frontendIsReady: true,
        size: { columns: 80, rows: 30 },
        setSession: () => assert.fail('must keep the existing shell attached'),
        initializeSession: () => assert.fail('must not start another shell'),
        logger: { warn: (_message, error) => assert.match(error.message, /inspection unavailable/) },
        notifications: { error: message => notices.push(message) },
        translate: { instant: text => text },
    })

    await tab.refreshSession()

    assert.equal(tab.session, oldSession)
    assert.equal(destroyed, false)
    assert.deepEqual(notices, ['Could not refresh terminal'])
    assert.equal(tab.refreshing, false)
})

test('repeated Refresh clicks share one local shell restart', async () => {
    const TerminalTabComponent = component()
    const finish = deferred()
    let starts = 0
    const oldSession = {
        open: true,
        getChildProcesses: async () => [],
        getWorkingDirectory: async () => null,
        destroy: () => finish.promise,
    }
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        session: oldSession,
        frontendIsReady: true,
        size: { columns: 80, rows: 30 },
        frontend: { resetTerminalModes: () => {} },
        setSession: session => { tab.session = session },
        initializeSession: async () => { starts++ },
    })

    const first = tab.refreshSession()
    const second = tab.refreshSession()
    finish.resolve()
    await Promise.all([first, second])

    assert.equal(starts, 1)
})

test('a failed local shell restart reports the error and allows another attempt', async () => {
    const TerminalTabComponent = component()
    const notices = []
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        session: {
            open: true,
            getChildProcesses: async () => [],
            getWorkingDirectory: async () => null,
            destroy: async () => { throw new Error('PTY unavailable') },
        },
        frontendIsReady: true,
        size: { columns: 80, rows: 30 },
        setSession: () => {},
        initializeSession: () => assert.fail('must not spawn over a terminal that failed to stop'),
        logger: { warn: (_message, error) => assert.match(error.message, /PTY unavailable/) },
        notifications: { error: message => notices.push(message) },
        translate: { instant: text => text },
    })

    await tab.refreshSession()

    assert.deepEqual(notices, ['Could not refresh terminal'])
    assert.equal(tab.refreshing, false)
})

test('fresh local session ignores a stale recovery PTY while keeping the selected working directory', async () => {
    let options
    const TerminalTabComponent = component({
        Session: class { async start (value) { options = value } },
        buildLocalRecoveryOptions: () => null,
    })
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        profile: { options: { command: '/bin/zsh', args: [], cwd: '/original', restoreFromPTYID: 'old-pty' } },
        recoveryCommand: null,
        injector: {},
        setSession: () => {},
        recoveryStateChangedHint: { next: () => {} },
        logger: { warn: () => assert.fail('spawn should succeed') },
    })

    await tab.initializeSession(132, 42, '/working/project', true)

    assert.equal(options.cwd, '/working/project')
    assert.equal(options.restoreFromPTYID, null)
    assert.equal(options.width, 132)
    assert.equal(options.height, 42)
})

test('failed fresh session start is reported to the Refresh caller', async () => {
    const failure = new Error('could not start local PTY')
    const TerminalTabComponent = component({
        Session: class { async start () { throw failure } },
        buildLocalRecoveryOptions: () => null,
    })
    const tab = Object.assign(Object.create(TerminalTabComponent.prototype), {
        profile: { options: { command: '/bin/zsh' } },
        recoveryCommand: null,
        injector: {},
        setSession: () => {},
        recoveryStateChangedHint: { next: () => {} },
        logger: { warn: (_message, error) => assert.equal(error, failure) },
    })

    await assert.rejects(tab.initializeSession(80, 30, null, true), failure)
})

test('local terminal context menu offers Refresh for local panes only', async () => {
    const TerminalTabComponent = class { refreshSession () { this.refreshed = true } }
    const { RefreshLocalTabContextMenu } = loadDeclarations('tabby-local/src/tabContextMenu.ts', ['RefreshLocalTabContextMenu'], {
        Injectable: () => target => target,
        TabContextMenuItemProvider: class {},
        TerminalTabComponent,
    })
    const menu = new RefreshLocalTabContextMenu({ instant: text => text })
    const local = new TerminalTabComponent()
    const items = await menu.getItems(local)
    assert.equal(items.length, 1)
    assert.equal(items[0].label, 'Refresh terminal')
    items[0].click()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(local.refreshed, true)
    assert.equal((await menu.getItems({})).length, 0)
})
