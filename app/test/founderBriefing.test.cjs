'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const {
    sanitizeFounderBriefingRequest,
    sanitizeFounderBriefingResponse,
} = loadDeclarations(
    'app/lib/founderBriefing.ts',
    ['sanitizeFounderBriefingRequest', 'sanitizeFounderBriefingResponse'],
)

test('founder briefing IPC input and output are bounded and stripped to known fields', () => {
    const request = sanitizeFounderBriefingRequest({
        schemaVersion: 1,
        projects: [{
            id: 'mamasign', name: 'MamaSign', description: 'Signing', notes: 'Focus', priority: 1,
            owner: { name: 'Ali', channel: 'WhatsApp', secret: 'no' },
            repository: { localPath: '/Users/m.aamirmursleen/mamasign', githubURL: 'https://github.com/example/mamasign' },
            workItems: Array.from({ length: 80 }, (_, index) => ({
                id: `MS-${index}`, title: `Task ${index}`, state: 'todo', priority: 'high', private: 'no',
            })),
            revenue: { currency: 'USD', currentMonthly: 100, previousMonthly: 80, status: 'live' },
            injected: 'no',
        }],
    })
    assert.equal(request.projects.length, 1)
    assert.equal(request.projects[0].workItems.length, 24)
    assert.equal('injected' in request.projects[0], false)
    assert.equal('secret' in request.projects[0].owner, false)

    const response = sanitizeFounderBriefingResponse({
        projects: [{
            id: 'mamasign', headline: 'Ready to sell',
            progress: Array(20).fill('Shipped work'), pending: ['Finish onboarding'], risks: ['Late task'],
            growth: ['Ask five customers'],
            message: { recipient: 'Ali', channel: 'WhatsApp', text: 'Hi Ali, please finish onboarding and share the delivery date.' },
            evidence: { planeTaskCount: 4, gitCommitCount: 2, repository: 'example/mamasign', latestCommitAt: '2026-10-22T12:00:00Z' },
            extra: 'no',
        }],
    }, ['mamasign'], '2026-10-23T04:00:00.000Z')
    assert.equal(response.projects[0].progress.length, 6)
    assert.equal(response.projects[0].message.recipient, 'Ali')
    assert.equal('extra' in response.projects[0], false)
})

test('scheduled Codex analysis is read-only, ephemeral, structured and timeout-bounded', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../lib/founderBriefing.ts'), 'utf8')
    const appSource = fs.readFileSync(path.resolve(__dirname, '../lib/app.ts'), 'utf8')
    const providerSource = fs.readFileSync(path.resolve(__dirname, '../../tabby-electron/src/services/nafranOSWorkspaceSyncProvider.service.ts'), 'utf8')
    assert.match(source, /--sandbox[\s\S]*read-only/)
    assert.match(source, /--ephemeral/)
    assert.match(source, /--output-schema/)
    assert.match(source, /CODEX_TIMEOUT_MS/)
    assert.match(source, /execFile\([^)]*git/)
    assert.match(source, /\/opt\/homebrew\/bin\/gh/)
    assert.match(source, /repos\/\$\{owner\}\/\$\{repositoryName\}\/commits\?per_page=12/)
    assert.match(appSource, /app:run-founder-briefing/)
    assert.match(appSource, /requestBytes > 512 \* 1024/)
    assert.match(providerSource, /app:run-founder-briefing/)
    assert.doesNotMatch(source + providerSource, /plane_api_[A-Za-z0-9_-]{16,}/)
})
