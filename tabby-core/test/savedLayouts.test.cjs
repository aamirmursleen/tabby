'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')
const { configMerge } = loadDeclarations('tabby-core/src/services/config.service.ts', ['configMerge'], { deepmerge: require('deepmerge') })
let nextID = 0
const { SplitLayoutProfilesService } = loadDeclarations('tabby-core/src/profiles.ts', ['SplitLayoutProfilesService'], {
    ProfileProvider: class {}, _: value => value, slugify: value => value,
    uuidv4: () => `layout-${++nextID}`, Error, configMerge,
})
const copy = value => JSON.parse(JSON.stringify(value))
function leaf (name, type = 'ssh') {
    return { type: `app:${type}-tab`, tabTitle: name, tabCustomTitle: name, tabColor: '#abcdef',
        profile: { id: `${type}:${name}`, type, name, options: { host: 'test.invalid', cwd: '/tmp/layout-test', privateKeys: ['/tmp/test-key'] } } }
}
function grid () {
    return { type: 'app:split-tab', orientation: 'v', ratios: [0.4, 0.6], focusedTabIndex: 2,
        tabTitle: 'Work', tabCustomTitle: 'My work', tabPinned: true,
        children: [
            { type: 'app:split-tab', orientation: 'h', ratios: [0.3, 0.7], children: [leaf('API'), leaf('Logs')] },
            { type: 'app:split-tab', orientation: 'h', ratios: [0.55, 0.45], children: [leaf('Local', 'local'), leaf('Database')] },
        ] }
}
function setup (token = grid()) {
    const config = { store: { profiles: [] }, save: async () => {} }
    const recovered = []
    const recovery = {
        getFullRecoveryToken: async (_tab, options) => { assert.equal(options.includeState, false); return token },
        recoverTab: async value => { recovered.push(copy(value)); return { type: 'split-component', inputs: { _recoveredState: value, customTitle: value.tabCustomTitle } } },
    }
    const service = new SplitLayoutProfilesService(config, recovery)
    return { config, recovery, recovered, service, tab: { getRecoveryToken: async () => token } }
}

test('saves and reloads the exact nested layout, titles, folders and focused pane', async () => {
    const token = grid()
    const { service, tab, config } = setup(token)
    const saved = await service.createProfile(tab, ' Daily work ')
    assert.equal(saved.name, 'Daily work')
    assert.deepEqual(copy(saved.options.recoveryToken), token)
    assert.equal(service.savedLayouts.length, 1)
    token.ratios[0] = 0.9
    assert.equal(saved.options.recoveryToken.ratios[0], 0.4, 'saved ratios cannot follow later live resizes')
    assert.equal(config.store.profiles[0].type, 'split-layout')
    assert.equal(service.getPaneCount(saved), 4)
    const prepared = await service.getNewTabParameters(saved)
    assert.equal(prepared.inputs.customTitle, 'My work')
    prepared.inputs._recoveredState.children[0].ratios[0] = 0.8
    assert.equal(saved.options.recoveryToken.children[0].ratios[0], 0.3, 'opening must not mutate the saved layout')
})

test('saving a single terminal produces a reusable one-pane layout', async () => {
    const { service, tab } = setup(leaf('Single', 'local'))
    const saved = await service.createProfile(tab, 'Single pane')
    assert.equal(saved.options.recoveryToken.type, 'app:split-tab')
    assert.equal(service.getPaneCount(saved), 1)
    assert.equal(saved.options.recoveryToken.children[0].profile.options.cwd, '/tmp/layout-test')
})

test('saving, renaming, replacing and deleting preserve unrelated profiles', async () => {
    const { service, tab, config } = setup()
    const server = { id: 'server', type: 'ssh', name: 'Server' }
    config.store.profiles.push(server)
    const saved = await service.createProfile(tab, 'Work')
    await service.renameLayout(saved.id, 'Renamed')
    assert.equal(service.savedLayouts[0].name, 'Renamed')
    await service.createProfile(tab, 'Updated', saved.id)
    assert.equal(service.savedLayouts.length, 1)
    assert.equal(service.savedLayouts[0].id, saved.id)
    await service.deleteLayout(saved.id)
    assert.deepEqual(copy(config.store.profiles), [server])
})

test('failed saves and deletes retain the last saved layout', async () => {
    const { service, tab, config } = setup()
    const saved = await service.createProfile(tab, 'Work')
    const before = JSON.stringify(config.store.profiles)
    config.save = async () => { throw Error('disk full') }
    for (const operation of [
        () => service.createProfile(tab, 'Another'),
        () => service.createProfile(tab, 'Changed', saved.id),
        () => service.renameLayout(saved.id, 'Changed'),
        () => service.deleteLayout(saved.id),
    ]) {
        await assert.rejects(operation())
        assert.equal(JSON.stringify(config.store.profiles), before)
    }
})

test('serializes concurrent layout writes without losing either save', async () => {
    const { service, tab, config } = setup()
    const gate = deferred()
    let calls = 0
    config.save = async () => { if (++calls === 1) await gate.promise }
    const first = service.createProfile(tab, 'First')
    const second = service.createProfile(tab, 'Second')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(copy(service.savedLayouts.map(x => x.name)), ['First', 'Second'])
})

test('rejects duplicate names, missing panes and invalid ratios without changing saved data', async () => {
    const { service, tab, config, recovery } = setup()
    await service.createProfile(tab, 'Work')
    for (const name of ['', ' ', 'work']) await assert.rejects(service.createProfile(tab, name))
    for (const invalid of [null, { ...grid(), children: [null] }, { ...grid(), ratios: [1] },
        { ...grid(), ratios: [0, 1] }, { ...grid(), ratios: [NaN, 1] }]) {
        recovery.getFullRecoveryToken = async () => invalid
        await assert.rejects(service.createProfile(tab, 'Invalid'))
    }
    assert.equal(config.store.profiles.length, 1)
})

test('preserves malformed imported layouts and provides repair feedback', async () => {
    const { service, config, tab } = setup()
    const broken = { id: 'broken', type: 'split-layout', name: 'Broken', options: { recoveryToken: null } }
    config.store.profiles.push(broken)
    assert.equal(service.savedLayouts.length, 0)
    assert.ok(service.validationError)
    await assert.rejects(service.createProfile(tab, 'Work'))
    assert.equal(config.store.profiles[0], broken)
})

test('opening validates all pane providers before any tab is created', async () => {
    const { service, tab, recovery } = setup()
    const saved = await service.createProfile(tab, 'Work')
    recovery.recoverTab = async token => token.tabCustomTitle === 'Database' ? null : { type: 'component' }
    await assert.rejects(service.getNewTabParameters(saved), /pane|profile|available/i)
})

test('layout snapshots exclude terminal history, live PTY IDs and credential values', async () => {
    const token = grid()
    const pane = token.children[0].children[0]
    pane.savedState = 'test-only-output-secret'
    pane.recoveryCommand = 'test-only-live-command'
    pane.profile.options.password = 'test-only-password'
    pane.profile.options.passphrase = 'test-only-passphrase'
    pane.profile.options.env = { PASSWORD: 'test-only-environment-password', LANG: 'en_US.UTF-8' }
    pane.profile.options.restoreFromPTYID = 'test-only-live-pty'
    const { service, tab, config, recovered } = setup(token)
    config.store.profiles.push(copy(pane.profile))
    const saved = await service.createProfile(tab, 'Work')
    assert.doesNotMatch(JSON.stringify(saved), /test-only-/)
    assert.equal(saved.options.recoveryToken.children[0].children[0].profile.options.privateKeys[0], '/tmp/test-key')
    await service.getNewTabParameters(saved)
    const restored = recovered.find(value => value.type === 'app:ssh-tab' && value.profile.name === 'API')
    assert.equal(restored.profile.options.password, 'test-only-password', 'credentials come from the current connection profile')
    assert.equal(restored.profile.options.env.PASSWORD, 'test-only-environment-password')
    assert.equal(restored.profile.options.restoreFromPTYID, undefined, 'opening a layout must not adopt another live terminal')
})

test('opening an old layout uses the current SSH profile key and connection settings', async () => {
    const oldLayout = grid()
    oldLayout.children[0].children[0].profile.options.user = 'old-user'
    const { service, tab, config, recovered } = setup(oldLayout)
    const saved = await service.createProfile(tab, 'Work')
    const current = copy(grid().children[0].children[0].profile)
    current.options.host = 'new-server.test'
    current.options.port = 2222
    current.options.privateKeys = ['ssh-key://11111111-1111-4111-8111-111111111111']
    config.store.profiles.push(current)

    await service.getNewTabParameters(saved)

    const restored = recovered.find(value => value.type === 'app:ssh-tab' && value.profile.id === current.id)
    assert.equal(restored.profile.options.host, 'new-server.test')
    assert.equal(restored.profile.options.port, 2222)
    assert.deepEqual(Array.from(restored.profile.options.privateKeys), current.options.privateKeys)
    assert.equal(restored.profile.options.user, undefined)
    assert.equal(saved.options.recoveryToken.children[0].children[0].profile.options.host, 'test.invalid')
})

test('split snapshots record and restore the focused pane after initializing every pane', async () => {
    const timers = []
    const { SplitTabComponent } = loadDeclarations('tabby-core/src/components/splitTab.component.ts', ['SplitTabComponent'], {
        BaseTabComponent: class {}, Component: () => value => value, ViewChild: () => () => {}, ViewContainerRef: class {},
        setTimeout: callback => timers.push(callback),
    })
    const tabs = [0, 1, 2, 3].map(id => ({ id }))
    const focused = []
    const tab = Object.assign(Object.create(SplitTabComponent.prototype), {
        root: { serialize: async () => { const token = grid(); delete token.focusedTabIndex; return token }, getAllTabs: () => tabs }, focusedTab: tabs[2],
        recoverContainer: async () => {}, updateTitle () {}, layout () {},
        focus: pane => focused.push(pane.id), hasFocus: true, visibility: { value: true },
        emitVisibility () {}, initialized: { next () {}, complete () {} },
    })
    const token = await tab.getRecoveryToken({ includeState: false })
    assert.equal(token.focusedTabIndex, 2)
    tab._recoveredState = token
    await tab.ngAfterViewInit()
    timers.forEach(callback => callback())
    assert.deepEqual(focused.slice(0, 4), [0, 1, 2, 3], 'every restored pane initializes')
    assert.equal(focused.at(-1), 2, 'the saved pane regains focus')
})

test('the actual split recovery engine recreates all four pane positions and sizes', async () => {
    class BaseTabComponent {}
    const { SplitContainer, SplitTabComponent } = loadDeclarations('tabby-core/src/components/splitTab.component.ts', ['SplitContainer', 'SplitTabComponent'], {
        BaseTabComponent, Component: () => value => value, ViewChild: () => () => {}, ViewContainerRef: class {},
    })
    const component = Object.assign(Object.create(SplitTabComponent.prototype), {
        root: new SplitContainer(), attachTabView () {},
        tabRecovery: { recoverTab: async token => ({ token }) },
        tabsService: { create: ({ token }) => Object.assign(new BaseTabComponent(), { name: token.tabCustomTitle }) },
    })
    await component.recoverContainer(component.root, grid())
    const positions = []
    const walk = (container, x, y, width, height) => {
        container.children.forEach((child, index) => {
            const ratio = container.ratios[index]
            const offset = container.getOffsetRatio(index)
            const bounds = container.orientation === 'h'
                ? [x + width * offset, y, width * ratio, height]
                : [x, y + height * offset, width, height * ratio]
            if (child instanceof SplitContainer) walk(child, ...bounds)
            else positions.push([child.name, ...bounds.map(value => Math.round(value * 100))])
        })
    }
    walk(component.root, 0, 0, 1, 1)
    assert.deepEqual(positions, [['API', 0, 0, 30, 40], ['Logs', 30, 0, 70, 40], ['Local', 0, 40, 55, 60], ['Database', 55, 40, 45, 60]])
})
