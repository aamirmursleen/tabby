'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const copy = value => JSON.parse(JSON.stringify(value))

const {
    buildNafranOSWorkspaceSnapshot,
    buildMasterWorkspaceProjects,
    buildMasterWorkspaceSearchResults,
    mergeMasterWorkspaceRemoteSnapshot,
    normalizeMasterWorkspaceMetadata,
    organizeFounderProjects,
} = loadDeclarations(
    'tabby-core/src/utils/masterWorkspace.ts',
    [
        'buildNafranOSWorkspaceSnapshot',
        'buildMasterWorkspaceProjects',
        'buildMasterWorkspaceSearchResults',
        'mergeMasterWorkspaceRemoteSnapshot',
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

test('normalizes bounded work items and twelve months of revenue without trusting malformed values', () => {
    const metadata = normalizeMasterWorkspaceMetadata({
        work: {
            total: 3, completed: 1, blocked: 1, overdue: 0,
            items: [
                { id: 'MS-21', title: 'Fix onboarding', state: 'in_progress', priority: 'high', assignee: 'Aamir' },
                { id: '', title: 'Missing identifier', state: 'done' },
                { id: 'MS-22', title: 'Bad state', state: 'not-a-state' },
            ],
        },
        revenue: {
            currency: 'usd', currentMonthly: 8420.75, status: 'live', source: 'Stripe',
            history: Array.from({ length: 14 }, (_, index) => ({ month: `2026-${index + 1}`, amount: index * 100 })),
        },
    })

    assert.equal(metadata.work.items.length, 2)
    assert.deepEqual(copy(metadata.work.items[0]), {
        id: 'MS-21', title: 'Fix onboarding', state: 'in_progress', priority: 'high', assignee: 'Aamir',
    })
    assert.equal(metadata.work.items[1].state, 'todo')
    assert.equal(metadata.revenue.currency, 'USD')
    assert.equal(metadata.revenue.currentMonthly, 8420.75)
    assert.equal(metadata.revenue.history.length, 12)
})

test('merges a bounded live Nafran OS snapshot while preserving founder registry fields', () => {
    const merged = mergeMasterWorkspaceRemoteSnapshot(connections, {
        mama: {
            priority: 1,
            description: 'Founder description stays local',
            notes: 'Private notes stay local',
            revenue: { currency: 'USD', currentMonthly: 100, history: [], status: 'manual' },
        },
    }, {
        schemaVersion: 1,
        generatedAt: '2026-10-22T16:44:20.569Z',
        source: 'Nafran OS API',
        projects: [
            {
                id: 'mamasign', name: 'MamaSign', aliases: ['MamaSign Dev'],
                work: { total: 24, completed: 18, blocked: 1, overdue: 2 },
                revenue: {
                    currency: 'USD', currentMonthly: 537.04, status: 'live',
                    source: 'Nafran OS API · Shopify owner share (30%)',
                    updatedAt: '2026-10-22T16:43:00.000Z',
                    history: [
                        { month: '2026-09', amount: 1200 },
                        { month: '2026-10', amount: 537.04 },
                    ],
                },
                plane: { status: 'live', identifier: 'MAMA', updatedAt: '2026-10-22T16:44:20.569Z' },
                health: 'healthy',
                links: [{ label: 'Plane', url: 'https://portal.whitelabel.com.pk/mamasign/' }],
            },
            { id: 'unknown', name: 'Unknown project', revenue: { currentMonthly: 999999 } },
        ],
    })

    assert.equal(merged.mama.description, 'Founder description stays local')
    assert.equal(merged.mama.notes, 'Private notes stay local')
    assert.equal(merged.mama.priority, 1)
    assert.equal(merged.mama.work.total, 24)
    assert.equal(merged.mama.revenue.currentMonthly, 537.04)
    assert.equal(merged.mama.revenue.status, 'live')
    assert.equal(merged.mama.plane.identifier, 'MAMA')
    assert.equal(merged.mama.health, 'healthy')
    assert.deepEqual(copy(merged.mama.links), [{ label: 'Plane', url: 'https://portal.whitelabel.com.pk/mamasign/' }])
    assert.equal(merged.unknown, undefined)
})

test('rejects malformed or oversized remote workspace snapshots', () => {
    const saved = { mama: { description: 'Keep me' } }
    assert.deepEqual(copy(mergeMasterWorkspaceRemoteSnapshot(connections, saved, {
        schemaVersion: 2,
        generatedAt: 'not-a-date',
        projects: [{ id: 'mama', revenue: { currentMonthly: Number.POSITIVE_INFINITY } }],
    })), saved)
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
    assert.match(template, /Summary/)
    assert.match(template, /Work items/)
    assert.match(template, /Revenue/)
    assert.match(template, /syncRemoteData\(\)/)
    assert.match(template, /workspace\.syncSource/)
    assert.match(template, /Sync & API/)
    assert.match(template, /Open as tab/)
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

test('builds Plane work and owner-share revenue from sanitized Nafran OS API responses', () => {
    const snapshot = buildNafranOSWorkspaceSnapshot({
        generated_at: '2026-10-22T16:56:00.000Z',
        plane: { workspaces: [{
            label: 'CalendarJet', slug: 'calendarjet', state: 'connected',
            work_items_total: 256, work_items_open: 12,
            work_items_completed_or_cancelled: 244,
            latest_update: '2026-10-21T21:35:27.000Z',
            projects: [{ work_items_sampled: 256, work_items_total: 256, by_state_group: { completed: 244 } }],
        }] },
        project_signals: [{
            workspace: 'CalendarJet', slug: 'calendarjet', deployment_warnings: 0,
            public_checks: [{ label: 'CalendarJet', status: 'ok', checked_at: '2026-10-22T16:50:00.000Z' }],
        }],
    }, {
        state: 'connected', generated_at: '2026-10-22T16:54:55.000Z',
        stores: [{
            store: 'calendarjet', project: 'CalendarJet', ok: true, state: 'connected',
            generated_at: '2026-10-22T16:54:55.000Z', currency: 'USD',
            monthly: [
                { month: '2026-09', amounts_by_currency: { USD: { received_less_refunds: '3608.39' } } },
                { month: '2026-10', amounts_by_currency: { USD: { received_less_refunds: '2569.42' } } },
            ],
        }],
    }, {
        business_scope: [{ project: 'CalendarJet', equity_pct: 50, relationship: 'part-owned' }],
        project_aliases: {},
    }, new Date('2026-10-22T17:00:00.000Z'))

    assert.equal(snapshot.schemaVersion, 1)
    assert.equal(snapshot.source, 'Nafran OS API')
    assert.equal(snapshot.projects.length, 1)
    assert.deepEqual(copy(snapshot.projects[0].work), { total: 256, completed: 244, blocked: 0, overdue: 0 })
    assert.equal(snapshot.projects[0].plane.status, 'live')
    assert.equal(snapshot.projects[0].health, 'healthy')
    assert.equal(snapshot.projects[0].revenue.currentMonthly, 1284.71)
    assert.deepEqual(copy(snapshot.projects[0].revenue.history), [
        { month: '2026-09', amount: 1804.2 },
        { month: '2026-10', amount: 1284.71 },
    ])
    assert.match(snapshot.projects[0].revenue.source, /owner share \(50%\)/)
})

test('the Nafran OS API provider is HTTPS-only, bounded, and keeps credentials in main-process Keychain access', () => {
    const provider = fs.readFileSync(path.resolve(__dirname, '../../tabby-electron/src/services/nafranOSWorkspaceSyncProvider.service.ts'), 'utf8')
    const mainAPI = fs.readFileSync(path.resolve(__dirname, '../../app/lib/nafranOSWorkspace.ts'), 'utf8')
    const electronModule = fs.readFileSync(path.resolve(__dirname, '../../tabby-electron/src/index.ts'), 'utf8')

    assert.match(provider, /ipcRenderer\.invoke\('app:load-nafran-os-workspace-feeds', force\)/)
    assert.match(mainAPI, /https:\/\/os\.nafran\.com/)
    assert.match(mainAPI, /CF-Access-Client-Id/)
    assert.match(mainAPI, /CF-Access-Client-Secret/)
    assert.match(mainAPI, /keytar\.getPassword/)
    assert.match(mainAPI, /MAX_RESPONSE_BYTES/)
    assert.match(mainAPI, /redirect:\s*'error'/)
    assert.doesNotMatch(provider + mainAPI, /plane_api_|clientSecret\s*=\s*['"][^'"]+|clientId\s*=\s*['"][^'"]+/i)
    assert.match(electronModule, /MasterWorkspaceSyncProvider[\s\S]*multi:\s*true/)
})
