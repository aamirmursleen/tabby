'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

function component () {
    return loadDeclarations('tabby-local/src/components/terminalTab.component.ts', ['TerminalTabComponent'], {
        Component: () => target => target, Input: () => () => {}, Optional: () => () => {},
        UACService: class {},
        BaseTerminalTabComponent: class {
            ngOnInit () {}
            onFrontendReady () {}
            subscribeUntilDestroyed () {}
        },
        isWindowsBuild: () => false, WIN_BUILD_CONPTY_SUPPORTED: 0,
    }).TerminalTabComponent
}

test('restored local sessions start even before their background tab is focused', () => {
    const Component = component()
    const instance = Object.assign(Object.create(Component.prototype), {
        recovered: true, profile: { options: {} }, hotkeys: {},
        log: { create: () => ({}) }, config: { store: { terminal: {} } },
    })
    let starts = 0
    instance.initializeSession = () => { starts++ }
    instance.ngOnInit()
    assert.equal(starts, 1)
})

test('showing an already-started restored tab resizes it without restarting Codex', () => {
    const Component = component()
    let resizes = 0
    const instance = Object.assign(Object.create(Component.prototype), {
        profile: { options: {} }, size: { columns: 100, rows: 30 },
        session: { getID: () => 'existing', resize: () => { resizes++ } },
        initializeSession: () => assert.fail('already started'),
    })
    instance.onFrontendReady()
    assert.equal(resizes, 1)
})
