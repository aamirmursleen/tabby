'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

class TestEventEmitter {
    constructor () {
        this.listeners = []
    }

    subscribe (listener) {
        this.listeners.push(listener)
    }

    emit () {
        for (const listener of this.listeners) {
            listener()
        }
    }
}

class TestBaseComponent {
    subscribeUntilDestroyed () {}
}

const { ActiveSessionsComponent } = loadDeclarations(
    'tabby-core/src/components/activeSessions.component.ts',
    ['ActiveSessionsComponent'],
    {
        Component: () => target => target,
        HostListener: () => () => {},
        Output: () => () => {},
        EventEmitter: TestEventEmitter,
        BaseComponent: TestBaseComponent,
        deepClone: value => JSON.parse(JSON.stringify(value)),
        normalizeConnectionResumeContext: value => value && typeof value === 'object' ? {
            tmuxSession: typeof value.tmuxSession === 'string' ? value.tmuxSession : undefined,
            workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : undefined,
        } : null,
        normalizeConnectionPriority: value => Number(value),
    },
)

test('the sessions panel exposes its own collapse action', () => {
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null },
        { store: { profiles: [], groups: [] }, changed$: null },
        {},
        {},
        {},
    )
    let collapsed = false
    component.closed.subscribe(() => { collapsed = true })

    component.collapse()

    assert.equal(collapsed, true)
})

test('connection controls stop keyboard events before terminal handlers', () => {
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null },
        { store: { profiles: [], groups: [] }, changed$: null },
        {},
        {},
        {},
    )
    let stopped = false
    let prevented = false

    component.protectEditorKeys({
        stopPropagation () { stopped = true },
        preventDefault () { prevented = true },
    })

    assert.equal(stopped, true)
    assert.equal(prevented, false)
})

test('requested important projects are seeded once and saved as P1', async () => {
    const config = {
        store: {
            profiles: [],
            groups: [{ id: 'calendar', name: 'CalendarJet' }, { id: 'mama', name: 'MamaSign' }],
            connectionProjectsSeeded: false,
        },
        changed$: null,
        saves: 0,
        async save () { this.saves++ },
    }
    const profiles = {
        async newProfileGroup (group) {
            group.id = 'witty'
            config.store.groups.push(group)
        },
    }
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null },
        config,
        profiles,
        {},
        {},
    )

    await component.seedRequestedProjects()

    assert.deepEqual(config.store.groups.map(group => [group.name, group.priority]), [
        ['CalendarJet', 1],
        ['MamaSign', 1],
        ['Wittyform', 1],
    ])
    assert.equal(config.store.connectionProjectsSeeded, true)
    assert.equal(config.saves, 1)
})

test('offline connections launch only when clicked and receive their saved tmux context', async () => {
    const launched = []
    const config = {
        store: {
            profiles: [{ id: 'cj', type: 'ssh', name: 'CJ Main', options: { host: 'example.test' } }],
            groups: [],
            connectionResumeContexts: { cj: { tmuxSession: 'calendar-api', workingDirectory: '/srv/calendar' } },
        },
        changed$: null,
    }
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null, tabs: [], activeTab: null },
        config,
        { async launchProfile (profile) { launched.push(profile) } },
        {},
        {},
    )
    component.refreshItems = async () => {}

    assert.equal(launched.length, 0)
    await component.activate({
        key: 'saved:cj', kind: 'saved', profile: config.store.profiles[0], label: 'CJ Main', color: null, active: false,
        status: { state: 'stopped', detail: 'Saved SSH' },
    })

    assert.equal(launched.length, 1)
    assert.deepEqual(launched[0].options.aamirResumeContext, {
        tmuxSession: 'calendar-api',
        workingDirectory: '/srv/calendar',
    })
    assert.equal(config.store.profiles[0].options.aamirResumeContext, undefined)
})

test('live tmux context is persisted once for the saved connection', () => {
    const config = {
        store: { profiles: [{ id: 'mama' }], groups: [], connectionResumeContexts: {} },
        changed$: null,
    }
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null }, config, {}, {}, {},
    )
    const items = [{
        tab: { profile: { id: 'mama' } },
        status: { resumeContext: { tmuxSession: 'mama-api', workingDirectory: '/srv/mama' } },
    }]

    assert.equal(component.captureResumeContexts(items), true)
    assert.equal(component.captureResumeContexts(items), false)
    assert.deepEqual(config.store.connectionResumeContexts.mama, {
        tmuxSession: 'mama-api',
        workingDirectory: '/srv/mama',
    })
})

test('rendering an unchanged project priority does not write config again', async () => {
    const config = {
        store: { profiles: [], groups: [{ id: 'calendar', name: 'CalendarJet', priority: 1 }] },
        changed$: null,
        saves: 0,
        async save () { this.saves++ },
    }
    const component = new ActiveSessionsComponent(
        { tabsChanged$: null, activeTabChange$: null }, config, {}, {}, {},
    )

    await component.setProjectPriority({ id: 'calendar', name: 'CalendarJet', priority: 1 }, 1)

    assert.equal(config.saves, 0)
})
