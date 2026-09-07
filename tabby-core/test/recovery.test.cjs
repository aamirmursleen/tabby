'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { Subject, AsyncSubject } = require('rxjs')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')

function setup () {
    const storage = {}
    const warnings = []
    const { TabRecoveryService } = loadDeclarations('tabby-core/src/services/tabRecovery.service.ts', ['TabRecoveryService'], {
        TabRecoveryProvider: class {}, window: { localStorage: storage },
    })
    const config = { store: { recoverTabs: true }, save: async () => {} }
    const recovery = new TabRecoveryService([], config, { create: () => ({ warn: (...args) => warnings.push(args) }) })
    recovery.enabled = true
    return { storage, recovery, config, warnings }
}
const tab = id => ({ title: id, getRecoveryToken: async () => ({ type: 'test', id }) })
const dialog = { platform: { showMessageBox: async () => ({ response: 0 }) }, translate: { instant: text => text } }

test('window close saves the final workspace before disabling recovery and destroying tabs', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    let closed = false
    const app = {
        ...dialog, config, tabRecovery: recovery, tabs: [tab('final')],
        closeAllTabs: async () => {
            assert.equal(JSON.parse(storage.tabsRecovery)[0].id, 'final')
            assert.equal(recovery.enabled, false)
            return true
        },
        hostWindow: { close: () => { closed = true } },
    }
    await AppService.prototype.closeWindow.call(app)
    assert.equal(closed, true)
})

test('cancelled or failed closure restores the previous recovery setting', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    for (const enabled of [true, false]) {
        for (const fails of [true, false]) {
            const { recovery, config } = setup()
            recovery.enabled = enabled
            const app = { ...dialog, config, tabRecovery: recovery, tabs: [], closeAllTabs: async () => {
                if (fails) { throw new Error('close failed') }
                return false
            }, hostWindow: { close: () => assert.fail('must not close') } }
            const close = AppService.prototype.closeWindow.call(app)
            await close
            assert.equal(recovery.enabled, enabled)
        }
    }
})

test('one save-and-close confirmation replaces every per-tab confirmation', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    let prompts = 0
    let destroyed = 0
    const tabs = Array.from({ length: 10 }, (_, i) => ({
        ...tab(String(i)), canClose: async () => assert.fail('must not ask per tab'), destroy: () => { destroyed++ },
    }))
    const app = {
        ...dialog, config, tabRecovery: recovery, tabs,
        platform: { showMessageBox: async options => {
            prompts++
            assert.match(options.buttons[0], /Save sessions and close all tabs/)
            assert.equal(options.defaultId, 1)
            assert.equal(options.cancelId, 1)
            return { response: 0 }
        } },
        closeAllTabs: AppService.prototype.closeAllTabs,
        hostWindow: { close: () => {} },
    }
    await AppService.prototype.closeWindow.call(app)
    assert.equal(prompts, 1)
    assert.equal(destroyed, 10)
    assert.equal(JSON.parse(storage.tabsRecovery).length, 10)
})

test('cancelling the window dialog saves nothing and closes no tabs', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    await AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [tab('keep')],
        platform: { showMessageBox: async () => ({ response: 1 }) },
        closeAllTabs: () => assert.fail('cancelled'), hostWindow: { close: () => assert.fail('cancelled') },
    })
    assert.equal(storage.tabsRecovery, undefined)
    assert.equal(recovery.enabled, true)
})

test('save-and-close enables startup recovery when it was disabled in settings', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    config.store.recoverTabs = false
    let configSaved = false
    config.save = async () => { configSaved = true }
    await AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [tab('restore')],
        closeAllTabs: async () => true, hostWindow: { close: () => {} },
    })
    assert.equal(configSaved, true)
    assert.equal(config.store.recoverTabs, true)
    assert.equal(JSON.parse(storage.tabsRecovery)[0].id, 'restore')
})

test('overlapping saves are coalesced and the newest requested workspace wins', async () => {
    const { recovery, storage } = setup()
    const gate = deferred()
    let calls = 0
    const slow = tab('old')
    slow.getRecoveryToken = async () => { calls++; await gate.promise; return { id: 'old' } }
    const first = recovery.saveTabs([slow])
    const skipped = recovery.saveTabs([{ getRecoveryToken: () => assert.fail('intermediate save must be coalesced') }])
    const last = recovery.saveTabs([tab('new')])
    gate.resolve()
    await Promise.all([first, skipped, last])
    assert.equal(calls, 1)
    assert.equal(JSON.parse(storage.tabsRecovery)[0].id, 'new')
})

test('one failed tab keeps its last good token without losing healthy tabs', async () => {
    const { recovery, storage, warnings } = setup()
    const broken = tab('retained')
    await recovery.saveTabs([broken])
    broken.getRecoveryToken = async () => { throw new Error('provider unavailable') }
    await recovery.saveTabs([broken, tab('healthy')])
    assert.deepEqual(JSON.parse(storage.tabsRecovery).map(t => t.id), ['retained', 'healthy'])
    assert.equal(warnings.length, 1)
})

test('storage errors propagate and a later save can recover', async () => {
    const { recovery, storage } = setup()
    Object.defineProperty(storage, 'tabsRecovery', { configurable: true, set () { throw new Error('quota') } })
    await assert.rejects(recovery.saveTabs([tab('first')]), /quota/)
    delete storage.tabsRecovery
    await recovery.saveTabs([tab('second')])
    assert.equal(JSON.parse(storage.tabsRecovery)[0].id, 'second')
})

test('disabled recovery performs no token collection or writes', async () => {
    const { recovery, storage, config } = setup()
    config.store.recoverTabs = false
    await recovery.saveTabs([{ getRecoveryToken: () => assert.fail('disabled') }])
    assert.equal(storage.tabsRecovery, undefined)
})

test('a failed final save keeps the window open and shows an error instead of destroying tabs', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    Object.defineProperty(storage, 'tabsRecovery', { set () { throw new Error('disk full') } })
    const dialogs = []
    const app = {
        ...dialog, config, tabRecovery: recovery, tabs: [tab('keep')],
        platform: { showMessageBox: async options => { dialogs.push(options); return { response: 0 } } },
        closeAllTabs: () => assert.fail('must not destroy unsaved tabs'),
        hostWindow: { close: () => assert.fail('must not close') },
    }
    await AppService.prototype.closeWindow.call(app)
    assert.equal(dialogs.length, 2)
    assert.equal(dialogs[1].type, 'error')
    assert.equal(recovery.enabled, true)
    assert.equal(app.closingWindow, false)
})

test('repeated close requests share one confirmation', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, config } = setup()
    const gate = deferred()
    let prompts = 0
    const app = {
        ...dialog, config, tabRecovery: recovery, tabs: [tab('keep')],
        platform: { showMessageBox: () => { prompts++; return gate.promise } },
        closeAllTabs: async () => true, hostWindow: { close () {} },
    }
    const first = AppService.prototype.closeWindow.call(app)
    await AppService.prototype.closeWindow.call(app)
    assert.equal(prompts, 1)
    gate.resolve({ response: 1 })
    await first
    assert.equal(app.closingWindow, false)
})
