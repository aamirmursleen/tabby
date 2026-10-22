'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const encoder = new TextEncoder()

test('Plane work items are sanitized before crossing into the renderer', () => {
    const { sanitizePlaneWorkItems } = loadDeclarations(
        'app/lib/planeWorkspace.ts',
        [
            'MAX_WORK_ITEMS', 'record', 'records', 'text', 'normalizeState',
            'normalizePriority', 'assigneeName', 'sanitizePlaneWorkItems',
        ],
    )
    const items = sanitizePlaneWorkItems(
        { name: 'HiringCat Roadmap', identifier: 'HIRE' },
        { results: [{
            id: 'item-id', sequence_id: 95, name: 'QA Test', priority: 'high',
            state: { name: 'In Progress', group: 'started' },
            assignees: [{ first_name: 'Sana', last_name: 'Mursleen', email: 'private@example.test' }],
            created_at: '2026-10-02T08:30:00Z', updated_at: '2026-10-20T10:45:00Z',
            target_date: '2026-10-21', description_html: '<p>not returned</p>',
        }] },
    )

    assert.deepEqual(JSON.parse(JSON.stringify(items)), [{
        id: 'HIRE-95', title: 'QA Test', state: 'in_progress', priority: 'high',
        assignee: 'Sana Mursleen', module: 'HiringCat Roadmap', dueDate: '2026-10-21',
        createdAt: '2026-10-02T08:30:00Z', updatedAt: '2026-10-20T10:45:00Z',
    }])
    assert.equal(JSON.stringify(items).includes('private@example.test'), false)
    assert.equal(JSON.stringify(items).includes('description_html'), false)
})

test('Plane API reader is HTTPS-only, route-bounded, size-bounded, and sends the key only as a header', async () => {
    let request
    const { readPlaneJSON } = loadDeclarations(
        'app/lib/planeWorkspace.ts',
        ['PLANE_ORIGIN', 'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT_MS', 'readPlaneJSON'],
        {
            URL,
            AbortController,
            fetch: async (url, options) => {
                request = { url, options }
                return {
                    ok: true,
                    status: 200,
                    url,
                    headers: { get: () => null },
                    arrayBuffer: async () => encoder.encode('{"results":[]}').buffer,
                }
            },
        },
    )
    const credential = 'plane_api_test_key_long_enough'
    await readPlaneJSON('/api/v1/workspaces/hiringcat/projects/?per_page=100', credential)
    assert.equal(request.url, 'https://portal.whitelabel.com.pk/api/v1/workspaces/hiringcat/projects/?per_page=100')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.options.headers['X-API-Key'], credential)
    assert.equal(request.url.includes(credential), false)
    await assert.rejects(() => readPlaneJSON('/api/v1/admin/users/', credential), /unexpected Plane API path/)
})

test('Plane work-item pagination stops after a short page even when the server sends a cursor', async () => {
    const calls = []
    const projectID = '12345678-1234-1234-1234-123456789abc'
    const response = value => ({
        ok: true,
        status: 200,
        url: calls.at(-1),
        headers: { get: () => null },
        arrayBuffer: async () => encoder.encode(JSON.stringify(value)).buffer,
    })
    const { fetchPlaneWorkspaceWorkItems } = loadDeclarations(
        'app/lib/planeWorkspace.ts',
        [
            'PLANE_ORIGIN', 'PLANE_KEYCHAIN_SERVICE', 'PLANE_KEYCHAIN_ACCOUNT',
            'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT_MS', 'MAX_PROJECTS',
            'MAX_WORK_ITEMS', 'WORK_ITEMS_PER_PAGE', 'MAX_PAGES_PER_PROJECT', 'REQUEST_CONCURRENCY',
            'record', 'records', 'text', 'normalizeState', 'normalizePriority', 'assigneeName',
            'sanitizePlaneWorkItems', 'loadPlaneCredential', 'readPlaneJSON', 'fetchPlaneWorkspaceWorkItems',
        ],
        {
            URL,
            AbortController,
            readKeychainCredential: async () => 'plane_api_test_key_long_enough',
            fetch: async url => {
                calls.push(url)
                if (calls.length === 1) {
                    return response({ results: [{ id: projectID, name: 'HiringCat', identifier: 'HIRE' }] })
                }
                return response({
                    results: Array.from({ length: 87 }, (_, index) => ({
                        id: `item-${index + 1}`, sequence_id: index + 1, name: `Work item ${index + 1}`,
                        state: { group: 'completed', name: 'Done' },
                    })),
                    next_cursor: 'cursor-that-must-not-be-followed',
                })
            },
        },
    )

    const items = await fetchPlaneWorkspaceWorkItems('hiringcat')
    assert.equal(items.length, 87)
    assert.equal(calls.length, 2)
})

test('Plane sync can restrict results to the project UUID found in a pasted URL', async () => {
    const calls = []
    const selectedID = '12345678-1234-1234-1234-123456789abc'
    const otherID = '87654321-4321-4321-4321-cba987654321'
    const response = value => ({
        ok: true,
        status: 200,
        url: calls.at(-1),
        headers: { get: () => null },
        arrayBuffer: async () => encoder.encode(JSON.stringify(value)).buffer,
    })
    const { fetchPlaneWorkspaceWorkItems } = loadDeclarations(
        'app/lib/planeWorkspace.ts',
        [
            'PLANE_ORIGIN', 'PLANE_KEYCHAIN_SERVICE', 'PLANE_KEYCHAIN_ACCOUNT',
            'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT_MS', 'MAX_PROJECTS',
            'MAX_WORK_ITEMS', 'WORK_ITEMS_PER_PAGE', 'MAX_PAGES_PER_PROJECT', 'REQUEST_CONCURRENCY',
            'record', 'records', 'text', 'normalizeState', 'normalizePriority', 'assigneeName',
            'sanitizePlaneWorkItems', 'loadPlaneCredential', 'readPlaneJSON', 'fetchPlaneWorkspaceWorkItems',
        ],
        {
            URL,
            AbortController,
            readKeychainCredential: async () => 'plane_api_test_key_long_enough',
            fetch: async url => {
                calls.push(url)
                if (calls.length === 1) {
                    return response({ results: [
                        { id: otherID, name: 'Other', identifier: 'OTHER' },
                        { id: selectedID, name: 'Selected', identifier: 'SEL' },
                    ] })
                }
                return response({ results: [{ id: 'task-1', sequence_id: 7, name: 'Selected task', state: { group: 'started' } }] })
            },
        },
    )

    const items = await fetchPlaneWorkspaceWorkItems('hiringcat', selectedID)
    assert.deepEqual(JSON.parse(JSON.stringify(items.map(item => item.id))), ['SEL-7'])
    assert.equal(calls.length, 2)
    assert.match(calls[1], new RegExp(`/projects/${selectedID}/work-items/`))
})

test('Plane rate limits return an actionable retry message', async () => {
    const { readPlaneJSON } = loadDeclarations(
        'app/lib/planeWorkspace.ts',
        ['PLANE_ORIGIN', 'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT_MS', 'readPlaneJSON'],
        {
            URL,
            AbortController,
            fetch: async url => ({
                ok: false,
                status: 429,
                url,
                headers: { get: name => name === 'retry-after' ? '18' : null },
            }),
        },
    )

    await assert.rejects(
        () => readPlaneJSON('/api/v1/workspaces/hiringcat/projects/?per_page=100', 'plane_api_test_key_long_enough'),
        /Try syncing again in 18 seconds/,
    )
})
