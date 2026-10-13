'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const sourcePath = path.resolve(__dirname, '../src/utils/openTabs.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
    },
    fileName: sourcePath,
})
const sourceModule = new Module(sourcePath, module)
sourceModule.filename = sourcePath
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
sourceModule._compile(compiled.outputText, sourcePath)

const {
    buildActiveSessionItems,
    buildCloseTabConfirmation,
    buildOpenTabItems,
    filterOpenTabItems,
    getOpenTabLabel,
} = sourceModule.exports

test('uses a custom title before profile and live titles', () => {
    const tab = {
        customTitle: '  Production shell  ',
        profile: { name: 'Production' },
        title: 'root@server',
    }

    assert.equal(getOpenTabLabel(tab, 0), 'Production shell')
})

test('uses the configured profile name for a normal terminal tab', () => {
    const tab = {
        profile: { name: '  Pakistan Server  ' },
        title: 'root@10.0.0.1',
    }

    assert.equal(getOpenTabLabel(tab, 0), 'Pakistan Server')
})

test('combines unique configured profile names for a split tab', () => {
    const tab = {
        title: 'Split tab',
        getAllTabs: () => [
            { profile: { name: 'Server A' } },
            { customTitle: 'Logs', profile: { name: 'Server B' } },
            { profile: { name: 'Server A' } },
        ],
    }

    assert.equal(getOpenTabLabel(tab, 2), 'Server A | Logs')
})

test('falls back to a live tab title and then a numbered label', () => {
    assert.equal(getOpenTabLabel({ title: '  npm watch  ' }, 3), 'npm watch')
    assert.equal(getOpenTabLabel({}, 4), 'Tab 5')
})

test('builds indexed items with active and color state', () => {
    const first = { profile: { name: 'Development' }, color: '#123456' }
    const second = { profile: { name: 'Production' }, color: '' }

    assert.deepEqual(buildOpenTabItems([first, second], second), [
        {
            tab: first,
            index: 0,
            label: 'Development',
            color: '#123456',
            active: false,
        },
        {
            tab: second,
            index: 1,
            label: 'Production',
            color: null,
            active: true,
        },
    ])
})

test('filters case-insensitively and requires every search term', () => {
    const items = buildOpenTabItems([
        { profile: { name: 'Production Web Server' } },
        { profile: { name: 'Production Database' } },
        { profile: { name: 'Development Web Server' } },
    ], null)

    assert.deepEqual(
        filterOpenTabItems(items, ' WEB   prod ' ).map(item => item.label),
        ['Production Web Server'],
    )
    assert.equal(filterOpenTabItems(items, 'missing').length, 0)
    assert.strictEqual(filterOpenTabItems(items, '   '), items)
})

test('builds one live session item for every terminal pane across open tabs', async () => {
    const local = {
        customTitle: 'Build agent',
        profile: { name: 'Mac', type: 'local' },
        hasFocus: false,
        getSessionStatus: async () => ({ state: 'running', detail: 'Local', process: 'tmux' }),
    }
    const ssh = {
        profile: { name: 'Production', type: 'ssh' },
        hasFocus: true,
        getSessionStatus: async () => ({ state: 'running', detail: 'SSH · root@example.com', process: 'tmux' }),
    }
    const nonTerminal = { title: 'Settings', getSessionStatus: async () => null }
    const split = { getAllTabs: () => [local, ssh, nonTerminal] }
    const stopped = {
        profile: { name: 'Old server', type: 'ssh' },
        getSessionStatus: async () => ({ state: 'stopped', detail: 'SSH · root@old.example.com' }),
    }

    const items = await buildActiveSessionItems([split, stopped], split)

    assert.equal(items.length, 3)
    assert.deepEqual(items.map(item => ({
        tab: item.tab,
        topLevelTab: item.topLevelTab,
        label: item.label,
        tabIndex: item.tabIndex,
        paneIndex: item.paneIndex,
        active: item.active,
        state: item.status.state,
        process: item.status.process,
    })), [
        { tab: local, topLevelTab: split, label: 'Build agent', tabIndex: 0, paneIndex: 0, active: false, state: 'running', process: 'tmux' },
        { tab: ssh, topLevelTab: split, label: 'Production', tabIndex: 0, paneIndex: 1, active: true, state: 'running', process: 'tmux' },
        { tab: stopped, topLevelTab: stopped, label: 'Old server', tabIndex: 1, paneIndex: 0, active: false, state: 'stopped', process: undefined },
    ])
})

test('keeps the session list usable when one status probe fails', async () => {
    const broken = {
        title: 'Unreachable',
        getSessionStatus: async () => { throw new Error('process probe failed') },
    }

    const [item] = await buildActiveSessionItems([broken], null)

    assert.equal(item.label, 'Unreachable')
    assert.deepEqual(item.status, { state: 'unknown', detail: 'Status unavailable' })
})

test('makes Cancel the default and escape action in the close confirmation', () => {
    const options = buildCloseTabConfirmation(
        { profile: { name: 'Production' } },
        0,
        {
            closeTab: 'Close tab',
            cancel: 'Cancel',
            areYouSure: 'Are you sure?',
        },
    )

    assert.deepEqual(options, {
        type: 'warning',
        message: 'Close tab “Production”?',
        detail: 'Are you sure?',
        buttons: ['Close tab', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    })
})
