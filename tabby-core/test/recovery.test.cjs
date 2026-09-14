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
            assert.deepEqual(Array.from(options.buttons), [
                'Close program (restore sessions)', 'Close all terminals (no restore)', 'Cancel',
            ])
            assert.equal(options.defaultId, 0)
            assert.equal(options.cancelId, 2)
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
        platform: { showMessageBox: async () => ({ response: 2 }) },
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
    gate.resolve({ response: 2 })
    await first
    assert.equal(app.closingWindow, false)
})

test('close all terminals removes saved sessions even when startup recovery is disabled', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    for (const recoverTabs of [true, false]) {
        const { recovery, storage, config } = setup()
        storage.tabsRecovery = JSON.stringify([{ id: 'old' }])
        config.store.recoverTabs = recoverTabs
        config.save = () => assert.fail('discarding does not change the startup preference')
        let closed = false
        await AppService.prototype.closeWindow.call({
            ...dialog, config, tabRecovery: recovery, tabs: [tab('discard')],
            platform: { showMessageBox: async () => ({ response: 1 }) },
            closeAllTabs: async check => {
                assert.equal(check, false)
                assert.equal(storage.tabsRecovery, '[]')
                assert.equal(recovery.enabled, false)
                return true
            },
            hostWindow: { close: () => { closed = true } },
        })
        assert.equal(closed, true)
        assert.equal(storage.tabsRecovery, '[]')
        assert.equal(config.store.recoverTabs, recoverTabs)
    }
})

test('discard waits for an in-flight autosave and prevents later writes from resurrecting tabs', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    const gate = deferred()
    const slow = tab('autosave')
    slow.getRecoveryToken = async () => { await gate.promise; return { id: 'autosave' } }
    const saving = recovery.saveTabs([slow])
    let destroyed = false
    const closing = AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [slow],
        platform: { showMessageBox: async () => ({ response: 1 }) },
        closeAllTabs: async () => { destroyed = true; return true }, hostWindow: { close () {} },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(destroyed, false)
    assert.equal(recovery.enabled, false)
    await recovery.saveTabs([tab('too-late')])
    gate.resolve()
    await Promise.all([saving, closing])
    assert.equal(destroyed, true)
    assert.equal(storage.tabsRecovery, '[]')
})

test('failed discard closure restores the exact previous snapshot without collecting replacement tokens', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    for (const failure of ['blocked', 'destroy', 'window']) {
        const { recovery, storage, config } = setup()
        const previous = '[{"id":"irreplaceable-session","state":"history"}]'
        storage.tabsRecovery = previous
        let attempted = false
        const app = {
            ...dialog, config, tabRecovery: recovery,
            tabs: [{ getRecoveryToken: () => assert.fail('discard must not collect replacement tokens') }],
            platform: { showMessageBox: async () => ({ response: 1 }) },
            closeAllTabs: async () => {
                attempted = true
                assert.equal(storage.tabsRecovery, '[]')
                if (failure === 'destroy') { throw new Error('destroy failed') }
                return failure !== 'blocked'
            },
            hostWindow: { close () { throw new Error('window close failed') } },
        }
        await AppService.prototype.closeWindow.call(app)
        assert.equal(attempted, true)
        assert.equal(storage.tabsRecovery, previous)
        assert.equal(recovery.enabled, true)
        assert.equal(app.closingWindow, false)
    }
})

test('a failed discard storage write leaves all terminals and their snapshot intact', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    const previous = '[{"id":"keep"}]'
    Object.defineProperty(storage, 'tabsRecovery', { get: () => previous, set () { throw new Error('storage unavailable') } })
    const dialogs = []
    await AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [tab('keep')],
        platform: { showMessageBox: async options => { dialogs.push(options); return { response: 1 } } },
        closeAllTabs: () => assert.fail('must not destroy tabs'), hostWindow: { close: () => assert.fail('must not close') },
    })
    assert.equal(storage.tabsRecovery, previous)
    assert.equal(recovery.enabled, true)
    assert.equal(dialogs.length, 2)
    assert.equal(dialogs[1].type, 'error')
})

test('discard rollback preserves the absence of an earlier snapshot', async () => {
    const { recovery, storage } = setup()
    const rollback = await recovery.clearSavedTabs()
    assert.equal(storage.tabsRecovery, '[]')
    rollback()
    assert.equal(storage.tabsRecovery, undefined)
    assert.equal(recovery.enabled, true)
})

test('discarding a secondary window cannot clear the main window saved workspace', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    recovery.enabled = false // Only the main window owns the shared recovery store.
    const previous = '[{"id":"main-window-session"}]'
    storage.tabsRecovery = previous
    let closed = false
    await AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [tab('secondary-window')],
        platform: { showMessageBox: async () => ({ response: 1 }) },
        closeAllTabs: async () => true, hostWindow: { close: () => { closed = true } },
    })
    assert.equal(closed, true)
    assert.equal(storage.tabsRecovery, previous)
    assert.equal(recovery.enabled, false)
})

test('discard aborts when an earlier autosave fails, preserving sessions and recovery settings', async () => {
    const { recovery, storage } = setup()
    const gate = deferred()
    const previous = '[{"id":"last-good"}]'
    Object.defineProperty(storage, 'tabsRecovery', { get: () => previous, set () { throw new Error('quota') } })
    const slow = tab('pending')
    slow.getRecoveryToken = async () => { await gate.promise; return { id: 'pending' } }
    const saveFailed = assert.rejects(recovery.saveTabs([slow]), /quota/)
    const clearFailed = assert.rejects(recovery.clearSavedTabs(), /quota/)
    gate.resolve()
    await Promise.all([saveFailed, clearFailed])
    assert.equal(storage.tabsRecovery, previous)
    assert.equal(recovery.enabled, true)
})

test('save-and-close freezes autosaves until the final snapshot is safely stored', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    const gate = deferred()
    const slow = tab('final')
    slow.getRecoveryToken = async () => { await gate.promise; return { id: 'final' } }
    let closed = false
    const closing = AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [slow],
        closeAllTabs: async () => true, hostWindow: { close: () => { closed = true } },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(recovery.enabled, false)
    await recovery.saveTabs([tab('too-late')])
    gate.resolve()
    await closing
    assert.equal(closed, true)
    assert.equal(JSON.parse(storage.tabsRecovery)[0].id, 'final')
})

test('failure to enable startup recovery leaves the saved workspace and terminals untouched', async () => {
    const { AppService } = loadDeclarations('tabby-core/src/services/app.service.ts', ['AppService'], {
        Subject, AsyncSubject, BOOTSTRAP_DATA: Symbol('bootstrap'),
    })
    const { recovery, storage, config } = setup()
    const previous = '[{"id":"saved"}]'
    storage.tabsRecovery = previous
    config.store.recoverTabs = false
    config.save = async () => { throw new Error('config unavailable') }
    const dialogs = []
    await AppService.prototype.closeWindow.call({
        ...dialog, config, tabRecovery: recovery, tabs: [tab('keep')],
        platform: { showMessageBox: async options => { dialogs.push(options); return { response: 0 } } },
        closeAllTabs: () => assert.fail('must not destroy tabs'), hostWindow: { close: () => assert.fail('must not close') },
    })
    assert.equal(config.store.recoverTabs, false)
    assert.equal(storage.tabsRecovery, previous)
    assert.equal(recovery.enabled, true)
    assert.equal(dialogs.length, 2)
    assert.equal(dialogs[1].type, 'error')
})
