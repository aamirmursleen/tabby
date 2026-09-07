'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')

test('concurrent tab scans share one native process-list request and expire promptly', async () => {
    let now = 0
    let calls = 0
    const { createProcessListCache } = loadDeclarations('tabby-electron/src/utils/processListCache.ts', ['createProcessListCache'], {
        Date: { now: () => now },
    })
    const gate = deferred()
    const get = createProcessListCache(async () => { calls++; await gate.promise; return [{ pid: 1 }] })
    const requests = Array.from({ length: 50 }, () => get())
    gate.resolve()
    await Promise.all(requests)
    assert.equal(calls, 1)
    await get()
    assert.equal(calls, 1)
    now = 101
    await get()
    assert.equal(calls, 2)
})

test('failed process discovery is not cached', async () => {
    const { createProcessListCache } = loadDeclarations('tabby-electron/src/utils/processListCache.ts', ['createProcessListCache'])
    let calls = 0
    const get = createProcessListCache(async () => {
        if (++calls === 1) { throw new Error('temporary') }
        return []
    })
    await assert.rejects(get(), /temporary/)
    assert.deepEqual(await get(), [])
    assert.equal(calls, 2)
})
