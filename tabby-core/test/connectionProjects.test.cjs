'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const {
    buildConnectionProjects,
    filterConnectionProjects,
    getConnectionPriorityLabel,
    normalizeConnectionResumeContext,
    normalizeConnectionPriority,
} = loadDeclarations(
    'tabby-core/src/utils/connectionProjects.ts',
    [
        'importantProjectNames',
        'normalizeConnectionPriority',
        'getConnectionPriorityLabel',
        'isSavedConnection',
        'normalizeConnectionResumeContext',
        'stoppedStatus',
        'cleanOptional',
        'connectionSort',
        'buildConnectionProjects',
        'filterConnectionProjects',
    ],
)
const copy = value => JSON.parse(JSON.stringify(value))

test('groups every saved connection and retains projects with no live sessions', () => {
    const calendar = { id: 'calendar', name: 'CalendarJet', priority: 1 }
    const mama = { id: 'mama', name: 'MamaSign', priority: 2 }
    const witty = { id: 'witty', name: 'Wittyform', priority: 1 }
    const profiles = [
        { id: 'cj-main', type: 'ssh', name: 'CJ Main', group: 'calendar', options: { cwd: '/srv/calendar' } },
        { id: 'cj-worker', type: 'ssh', name: 'CJ Worker', group: 'calendar', options: {} },
        { id: 'mama-admin', type: 'ssh', name: 'Admin', group: 'mama', options: {} },
        { id: 'layout', type: 'split-layout', name: 'Saved layout', group: 'calendar', options: {} },
    ]

    const projects = buildConnectionProjects([calendar, mama, witty], profiles, [])

    assert.deepEqual(copy(projects.map(project => [project.name, project.priority, project.connections.length])), [
        ['CalendarJet', 1, 2],
        ['Wittyform', 1, 0],
        ['MamaSign', 2, 1],
    ])
    assert.equal(projects[0].connections[0].status.state, 'stopped')
    assert.equal(projects[0].connections[0].status.workingDirectory, '/srv/calendar')
    assert.equal(projects.flatMap(project => project.connections).some(item => item.label === 'Saved layout'), false)
})

test('keeps multiple live connections for one project and suppresses their offline duplicates', () => {
    const profile = { id: 'server', type: 'ssh', name: 'Production', group: 'project', options: {} }
    const firstTab = { profile }
    const secondTab = { profile }
    const live = [firstTab, secondTab].map((tab, index) => ({
        tab,
        topLevelTab: tab,
        tabIndex: index,
        paneIndex: 0,
        label: `Production ${index + 1}`,
        color: null,
        active: index === 1,
        status: { state: 'running', detail: 'SSH' },
    }))

    const [project] = buildConnectionProjects(
        [{ id: 'project', name: 'Product', priority: 3 }],
        [profile],
        live,
    )

    assert.equal(project.connections.length, 2)
    assert.equal(project.liveCount, 2)
    assert.equal(project.connections.filter(item => item.kind === 'saved').length, 0)
    assert.equal(project.connections[0].active, true)
})

test('search matches projects and connections while priority labels stay explicit', () => {
    const projects = buildConnectionProjects(
        [{ id: 'calendar', name: 'CalendarJet', priority: 1 }, { id: 'mama', name: 'MamaSign', priority: 4 }],
        [
            { id: 'cj', type: 'ssh', name: 'API server', group: 'calendar', options: {} },
            { id: 'mama', type: 'ssh', name: 'Customer portal', group: 'mama', options: {} },
        ],
        [],
    )

    assert.deepEqual(copy(filterConnectionProjects(projects, 'calendar').map(project => project.name)), ['CalendarJet'])
    assert.deepEqual(copy(filterConnectionProjects(projects, 'customer').map(project => project.name)), ['MamaSign'])
    assert.equal(getConnectionPriorityLabel(1), 'P1 Critical')
    assert.equal(getConnectionPriorityLabel(4), 'P4 Low')
    assert.equal(normalizeConnectionPriority(undefined, 'CalendarJet'), 1)
    assert.equal(normalizeConnectionPriority(undefined, 'Mama Sign'), 1)
    assert.equal(normalizeConnectionPriority(undefined, 'Another project'), 3)
})

test('offline connections retain safe tmux and directory context without opening anything', () => {
    const launches = []
    const [project] = buildConnectionProjects(
        [{ id: 'calendar', name: 'CalendarJet', priority: 1 }],
        [{ id: 'cj', type: 'ssh', name: 'CJ Main', group: 'calendar', options: {} }],
        launches,
        { cj: { tmuxSession: 'calendar-api', workingDirectory: '/srv/calendar' } },
    )

    assert.equal(launches.length, 0)
    assert.equal(project.connections[0].status.state, 'stopped')
    assert.equal(project.connections[0].status.tmuxSession, 'calendar-api')
    assert.equal(project.connections[0].status.workingDirectory, '/srv/calendar')
    assert.deepEqual(JSON.parse(JSON.stringify(normalizeConnectionResumeContext({ tmuxSession: 'bad\nname', workingDirectory: '/srv/safe' }))), {
        workingDirectory: '/srv/safe',
    })
    assert.deepEqual(filterConnectionProjects([project], 'calendar-api').map(value => value.name), ['CalendarJet'])
})

test('the connection panel exposes project creation, search, priority and add-connection actions', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/activeSessions.component.pug'), 'utf8')
    assert.match(template, /aria-label='Add project'/)
    assert.match(template, /placeholder='Search projects and connections'/)
    assert.match(template, /setProjectPriority/)
    assert.match(template, /addConnection/)
})

test('priority sections retain their DOM controls through a complete mouse click', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/activeSessions.component.pug'), 'utf8')
    assert.match(template, /\*ngFor='let bucket of priorityBuckets; trackBy: trackByPriority'/)
})
