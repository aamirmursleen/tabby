'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')
const load = () => loadDeclarations('tabby-local/src/utils/outputAcknowledgements.ts', ['OutputAcknowledgements']).OutputAcknowledgements
const tick = () => new Promise(resolve => setImmediate(resolve))

test('acknowledges bytes only after the downstream consumer drains', async () => {
    const Queue = load()
    const gate = deferred()
    const acks = []
    const queue = new Queue(bytes => acks.push(bytes), () => gate.promise, assert.fail)
    queue.push(100)
    await tick()
    assert.deepEqual(acks, [])
    gate.resolve()
    await tick()
    assert.deepEqual(acks, [100])
})

test('coalesces incoming chunks while a drain is pending without losing bytes', async () => {
    const Queue = load()
    const gates = [deferred(), deferred()]
    const acks = []
    let drains = 0
    const queue = new Queue(bytes => acks.push(bytes), () => gates[drains++].promise, assert.fail)
    queue.push(10)
    for (let i = 0; i < 1000; i++) { queue.push(20) }
    assert.equal(drains, 1)
    gates[0].resolve()
    await tick()
    assert.deepEqual(acks, [10])
    assert.equal(drains, 2)
    gates[1].resolve()
    await tick()
    assert.deepEqual(acks, [10, 20000])
})

test('closing or failing a consumer never acknowledges unconsumed output', async () => {
    const Queue = load()
    for (const fail of [false, true]) {
        const gate = deferred()
        let errors = 0
        const queue = new Queue(() => assert.fail('not consumed'), () => gate.promise, () => { errors++ })
        queue.push(10)
        if (fail) { gate.reject(new Error('consumer failed')) } else { queue.close(); gate.resolve() }
        await tick()
        queue.push(10)
        await tick()
        assert.equal(errors, fail ? 1 : 0)
    }
})
