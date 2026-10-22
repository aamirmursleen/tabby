'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const {
    applyFounderBriefingSchedule,
    buildFallbackFounderBriefing,
    buildFounderBriefingRequest,
    nextFounderBriefingRun,
    shouldRunFounderBriefing,
} = loadDeclarations(
    'tabby-core/src/utils/founderBriefing.ts',
    [
        'applyFounderBriefingSchedule',
        'buildFallbackFounderBriefing',
        'buildFounderBriefingRequest',
        'nextFounderBriefingRun',
        'shouldRunFounderBriefing',
    ],
)

test('updates a ConfigProxy structural briefing through its writable leaf fields', () => {
    const schedule = { enabled: true, hour: 9, minute: 0, lastRunAt: '', lastRunDate: '' }
    const structuralConfig = {}
    Object.defineProperty(structuralConfig, 'briefing', { get: () => schedule })

    applyFounderBriefingSchedule(structuralConfig.briefing, {
        enabled: true,
        hour: 9,
        minute: 0,
        lastRunAt: '2026-10-23T04:00:00.000Z',
        lastRunDate: '2026-10-23',
    })

    assert.equal(structuralConfig.briefing.lastRunAt, '2026-10-23T04:00:00.000Z')
    assert.equal(structuralConfig.briefing.lastRunDate, '2026-10-23')
})

const project = {
    id: 'calendarjet',
    name: 'CalendarJet',
    priority: 1,
    metadata: {
        description: 'Scheduling platform',
        notes: 'Ship paid team calendars',
        work: {
            total: 12, completed: 7, blocked: 1, overdue: 1,
            items: [
                { id: 'CAL-8', title: 'Fix checkout', state: 'blocked', priority: 'urgent', assignee: 'Sana', dueDate: '2026-10-22' },
                { id: 'CAL-9', title: 'Publish pricing page', state: 'in_progress', priority: 'high', assignee: 'Sana' },
                { id: 'CAL-7', title: 'Old completed item', state: 'done', priority: 'low' },
            ],
        },
        revenue: {
            currency: 'USD', currentMonthly: 1200, status: 'live', source: 'Nafran OS API',
            history: [{ month: '2026-09', amount: 1500 }, { month: '2026-10', amount: 1200 }],
        },
        plane: { status: 'live', workspaceSlug: 'calendarjet', identifier: 'CAL', updatedAt: '2026-10-23T03:00:00Z' },
        repository: { localPath: '/Users/m.aamirmursleen/calendarjet', githubURL: 'https://github.com/example/calendarjet' },
        owner: { name: 'Sana', channel: 'WhatsApp' },
        knowledge: { path: '/aamir', status: 'fresh' },
        links: [], health: 'healthy',
    },
}

test('daily founder briefing runs once after 9 AM and catches up after restart', () => {
    const before = new Date('2026-10-23T08:59:00+05:00')
    const after = new Date('2026-10-23T09:01:00+05:00')
    assert.equal(shouldRunFounderBriefing({ enabled: true, hour: 9, minute: 0, lastRunDate: '2026-10-22' }, before), false)
    assert.equal(shouldRunFounderBriefing({ enabled: true, hour: 9, minute: 0, lastRunDate: '2026-10-22' }, after), true)
    assert.equal(shouldRunFounderBriefing({ enabled: true, hour: 9, minute: 0, lastRunDate: '2026-10-23' }, after), false)
    assert.equal(nextFounderBriefingRun(after, 9, 0).toISOString(), '2026-10-24T04:00:00.000Z')
    assert.equal(nextFounderBriefingRun(before, 9, 0, '2026-10-23').toISOString(), '2026-10-24T04:00:00.000Z')
})

test('builds a bounded evidence request without terminal or credential data', () => {
    const request = buildFounderBriefingRequest([project], new Date('2026-10-23T09:00:00+05:00'))
    assert.equal(request.schemaVersion, 1)
    assert.equal(request.projects.length, 1)
    assert.equal(request.projects[0].owner.name, 'Sana')
    assert.equal(request.projects[0].workItems.length, 2)
    assert.equal(request.projects[0].repository.localPath, '/Users/m.aamirmursleen/calendarjet')
    const serialized = JSON.stringify(request)
    assert.equal(serialized.includes('plane_api_'), false)
    assert.equal(serialized.includes('connections'), false)
    assert.equal(serialized.includes('privateKey'), false)
})

test('fallback briefing creates a simple copy-ready manager message grounded in pending work', () => {
    const briefing = buildFallbackFounderBriefing(project, new Date('2026-10-23T09:00:00+05:00'))
    assert.equal(briefing.source, 'local')
    assert.equal(briefing.pending[0].includes('CAL-8'), true)
    assert.equal(briefing.message.recipient, 'Sana')
    assert.match(briefing.message.text, /Fix checkout/)
    assert.match(briefing.message.text, /delivery date/)
    assert.equal(briefing.growth.length > 0, true)
})

test('dashboard exposes daily briefing, project messages and a copy action', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/masterWorkspace.component.pug'), 'utf8')
    const component = fs.readFileSync(path.resolve(__dirname, '../src/components/masterWorkspace.component.ts'), 'utf8')
    assert.match(template, /Daily briefing/)
    assert.match(template, /Run now/)
    assert.match(template, /Messages/)
    assert.match(template, /Copy message/)
    assert.match(component, /runFounderBriefing/)
    assert.match(component, /copyManagerMessage/)
})
