'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const { BehaviorSubject, filter, firstValueFrom } = require('rxjs')

function frontendClass () {
    return loadDeclarations('tabby-terminal/src/frontends/xtermFrontend.ts', ['XTermFrontend'], {
        Frontend: class { destroy () {} },
    }).XTermFrontend
}

test('frontend flush waits for the xterm parsing callback and settles on destruction', async () => {
    const Frontend = frontendClass()
    for (const destroy of [false, true]) {
        let callback
        const instance = Object.assign(Object.create(Frontend.prototype), {
            pendingFlushes: new Set(), disposed: false,
            flowControl: { dispose () {} },
            xterm: { write: (data, done) => { assert.equal(data, ''); callback = done }, dispose () {} },
        })
        let drained = false
        const flush = instance.flush().then(() => { drained = true })
        await Promise.resolve()
        assert.equal(drained, false)
        if (destroy) { instance.destroy() } else { callback() }
        await flush
        assert.equal(drained, true)
        assert.equal(instance.pendingFlushes.size, 0)
    }
})

test('flow-control destruction releases blocked writers without writing into a disposed terminal', async () => {
    const { FlowControl } = loadDeclarations('tabby-terminal/src/frontends/xtermFrontend.ts', ['FlowControl'], {
        BehaviorSubject, filter, firstValueFrom,
    })
    let writes = 0
    const flow = new FlowControl({ write: () => { writes++ } })
    for (let i = 0; i < 11; i++) { await flow.write('x'.repeat(131073)) }
    const blocked = flow.write('never written')
    flow.dispose()
    await blocked
    assert.equal(writes, 11)
})

test('unchanged font configuration does not schedule another terminal reflow', () => {
    const Frontend = frontendClass()
    let reflows = 0
    const instance = Object.assign(Object.create(Frontend.prototype), {
        zoom: 0, configuredFontSize: 14, configuredLinePadding: 0,
        xterm: { options: {} }, resizeHandler: () => { reflows++ },
    })
    instance.setFontSize()
    instance.setFontSize()
    assert.equal(reflows, 1)
    instance.zoom = 1
    instance.setFontSize()
    assert.equal(reflows, 2)
})
