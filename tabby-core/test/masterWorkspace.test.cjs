'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const copy = value => JSON.parse(JSON.stringify(value))

const {
    buildMasterWorkspaceProjects,
    buildMasterWorkspaceSearchResults,
    normalizeMasterWorkspaceMetadata,
    organizeFounderProjects,
} = loadDeclarations(
    'tabby-core/src/utils/masterWorkspace.ts',
    [
        'buildMasterWorkspaceProjects',
        'buildMasterWorkspaceSearchResults',
        'normalizeMasterWorkspaceMetadata',
        'organizeFounderProjects',
    ],
)

const connections = [
    {
        id: 'mama', name: 'MamaSign', priority: 1, color: null, icon: null, liveCount: 1,
        connections: [
            {
                key: 'live:mama', kind: 'live', label: 'Production API', active: true,
                status: { state: 'running', detail: 'SSH', workingDirectory: '/var/www/mamasign' },
            },
            {
                key: 'saved:mama-worker', kind: 'saved', label: 'Queue worker', active: false,
                status: { state: 'stopped', detail: 'Saved SSH', tmuxSession: 'mamasign-queue' },
            },
        ],
    },
    {
        id: 'calendar', name: 'CalendarJet', priority: 2, color: '#59a8ff', icon: null, liveCount: 0,
        connections: [{
            key: 'saved:calendar', kind: 'saved', label: 'Calendar staging', active: false,
            status: { state: 'stopped', detail: 'Saved SSH', workingDirectory: '/srv/calendar' },
        }],
    },
]

test('builds founder projects from real profile groups without opening saved connections', () => {
    const projects = buildMasterWorkspaceProjects(connections, {
        mama: {
            description: 'Signing platform',
            work: { total: 10, completed: 6, blocked: 2, overdue: 1 },
            plane: { status: 'live', identifier: 'MS' },
            knowledge: { path: '/aamir', status: 'fresh', updatedAt: '2026-10-22T10:00:00.000Z' },
        },
    }, new Date('2026-10-22T12:00:00.000Z').getTime())

    assert.equal(projects.length, 2)
    assert.equal(projects[0].id, 'mama')
    assert.equal(projects[0].progress, 60)
    assert.equal(projects[0].openWork, 4)
    assert.equal(projects[0].attention.score, 41)
    assert.equal(projects[0].attention.band, 'attention')
    assert.deepEqual(copy(projects[0].attention.reasons.map(reason => reason.kind)), ['blocked', 'overdue', 'tmux', 'priority'])
    assert.equal(projects[1].metadata.knowledge.path, '/aamir')
    assert.equal(projects[1].connections[0].status.state, 'stopped')
})

test('normalizes malformed project metadata without retaining unsafe or unbounded values', () => {
    assert.deepEqual(copy(normalizeMasterWorkspaceMetadata({
        description: '  Calendar booking  ',
        priority: 12,
        work: { total: -1, completed: 999, blocked: '2', overdue: 3.8 },
        knowledge: { path: '/aamir\nrm -rf /', status: 'unknown' },
        links: [
            { label: 'Portal', url: 'https://example.test/app' },
            { label: 'Bad', url: 'javascript:alert(1)' },
        ],
    })), {
        priority: 4,
        description: 'Calendar booking',
        work: { total: 0, completed: 0, blocked: 0, overdue: 0 },
        knowledge: { path: '/aamir', status: 'unknown' },
        links: [{ label: 'Portal', url: 'https://example.test/app' }],
    })
})

test('saved registry priority overrides a derived catalog priority after restart', () => {
    const projects = buildMasterWorkspaceProjects(connections, { mama: { priority: 4 } }, Date.now())
    const mama = projects.find(project => project.id === 'mama')

    assert.equal(mama.priority, 4)
    assert.equal(mama.attention.reasons.some(reason => reason.kind === 'priority'), false)
})

test('command search covers projects, connections, tmux names, folders and actions', () => {
    const projects = buildMasterWorkspaceProjects(connections, {}, Date.now())
    assert.deepEqual(copy(buildMasterWorkspaceSearchResults(projects, 'mamasign-queue').map(result => result.label)), ['Queue worker'])
    assert.deepEqual(copy(buildMasterWorkspaceSearchResults(projects, '/srv/calendar').map(result => result.label)), ['Calendar staging'])
    assert.deepEqual(copy(buildMasterWorkspaceSearchResults(projects, 'knowledge').map(result => result.label)), ['Search project knowledge'])
    assert.equal(buildMasterWorkspaceSearchResults(projects, '').some(result => result.kind === 'project'), true)
})

test('organizes legacy Fleet Accounts and Ungrouped connections into the real founder project catalog', () => {
    const organized = organizeFounderProjects([
        {
            id: 'fleet', name: 'Fleet Accounts', priority: 2, color: null, icon: null, liveCount: 0,
            connections: [
                { key: 'hamza', kind: 'saved', label: 'Hamza — WASecret', active: false, status: { state: 'stopped', detail: 'Saved SSH' } },
                { key: 'azka', kind: 'saved', label: 'Azka — Clarino', active: false, status: { state: 'stopped', detail: 'Saved SSH' } },
            ],
        },
        {
            id: 'ungrouped', name: 'Ungrouped', priority: 3, color: null, icon: null, liveCount: 1,
            connections: [
                { key: 'law', kind: 'saved', label: 'Law project', active: false, status: { state: 'stopped', detail: 'Saved local' } },
                { key: 'xoobo', kind: 'live', label: 'Xoobo CLI Project', active: true, status: { state: 'running', detail: 'Local' } },
                { key: 'other', kind: 'saved', label: 'Proxmox Master', active: false, status: { state: 'stopped', detail: 'Saved SSH' } },
            ],
        },
    ])
    const byId = Object.fromEntries(organized.map(project => [project.id, project]))

    assert.equal(organized.length >= 17, true)
    assert.deepEqual(copy(byId.wasecret.connections.map(item => item.key)), ['hamza'])
    assert.deepEqual(copy(byId.clarino.connections.map(item => item.key)), ['azka'])
    assert.deepEqual(copy(byId.lawtelligent.connections.map(item => item.key)), ['law'])
    assert.deepEqual(copy(byId.xoobo.connections.map(item => item.key)), ['xoobo'])
    assert.deepEqual(copy(byId.ungrouped.connections.map(item => item.key)), ['other'])
    assert.equal(byId.xoobo.liveCount, 1)
    assert.equal(byId.fleet, undefined)
})

test('the Master Workspace is a pinned first surface and offsets real tab numbers', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/appRoot.component.pug'), 'utf8')
    const master = template.indexOf('.master-workspace-tab')
    const terminals = template.indexOf("*ngFor='let tab of app.tabs")
    assert.ok(master >= 0 && master < terminals)
    assert.match(template, /master-workspace\.content-tab/)
    assert.match(template, /\[index\]='idx \+ 1'/)
    assert.match(template, /selectMasterWorkspace\(\)/)
    const service = fs.readFileSync(path.resolve(__dirname, '../src/services/app.service.ts'), 'utf8')
    assert.match(service, /if \(config\.store\.masterWorkspace\)[\s\S]*this\.selectTab\(null, false\)/)
})

test('the dashboard exposes real project navigation and command palette controls', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/masterWorkspace.component.pug'), 'utf8')
    assert.match(template, /Founder command center/)
    assert.match(template, /All projects/)
    assert.match(template, /Open terminal/)
    assert.match(template, /Knowledge · \/aamir/)
    assert.match(template, /aria-label='Search projects, servers, folders and commands'/)
    assert.match(template, /Save project/)
    assert.doesNotMatch(template, /projects\.slice\(/)

    const appService = fs.readFileSync(path.resolve(__dirname, '../src/services/app.service.ts'), 'utf8')
    const workspaceService = fs.readFileSync(path.resolve(__dirname, '../src/services/masterWorkspace.service.ts'), 'utf8')
    const terminalTab = fs.readFileSync(path.resolve(__dirname, '../../tabby-terminal/src/api/baseTerminalTab.component.ts'), 'utf8')
    assert.match(appService, /get tabStateChanged\$ \(\): Observable<void>/)
    assert.match(appService, /recoveryStateChangedHint\.pipe\(debounceTime\(250\)\)/)
    assert.match(workspaceService, /this\.app\.tabStateChanged\$\.subscribe\(\(\) => this\.refresh\(\)\)/)
    assert.doesNotMatch(workspaceService, /this\.app\.tabsChanged\$\.subscribe/)
    assert.match(terminalTab, /this\.sessionChanged\.next\(session\)\s+this\.recoveryStateChangedHint\.next\(\)/)
})
