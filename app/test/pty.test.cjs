'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { Subject, debounceTime } = require('rxjs')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup () {
    const listeners = {}
    const handlers = {}
    const events = []
    const native = {
        pid: 123, pause () {}, resume () {}, kill () {},
        on (name, handler) { listeners[name] = handler },
        onData (handler) { listeners.data = handler; return { dispose () {} } },
        onExit (handler) { listeners.exit = handler; return { dispose () {} } },
    }
    const { UTF8Splitter } = loadDeclarations('app/lib/utfSplitter.ts', ['partials', 'UTF8Splitter'])
    const classes = loadDeclarations('app/lib/pty.ts', ['PTYDataQueue', 'PTY', 'PTYManager'], {
        Subject, debounceTime, UTF8Splitter, nodePTY: { spawn: () => native }, uuidv4: () => 'test-pty',
        ipcMain: { on: (name, handler) => { handlers[name] = handler } },
    })
    const manager = new classes.PTYManager()
    manager.init({ broadcast: (event, ...args) => events.push([event, ...args]) })
    handlers['pty:spawn']({}, '/bin/sh')
    return { ...classes, manager, native, listeners, handlers, events }
}

test('process exit waits for pending output to be consumed, then releases its registry entry', async () => {
    const { listeners, handlers, events, manager } = setup()
    listeners.data(Buffer.from('final output'))
    listeners.exit({ exitCode: 0, signal: 0 })
    await tick()
    assert.equal(events.some(([name]) => name.endsWith(':exit')), false)
    handlers['pty:ack-data']({}, 'test-pty', Buffer.byteLength('final output'))
    await tick()
    assert.equal(events.some(([name]) => name.endsWith(':exit')), true)
    assert.equal(manager.ptys.size, 0)
})

test('detached terminal cleanup does not wait forever for an ACK from a closed renderer', async () => {
    const { listeners, handlers, manager } = setup()
    listeners.data(Buffer.from('unread'))
    handlers['pty:release']({}, 'test-pty')
    listeners.exit({ exitCode: 0, signal: 0 })
    await tick()
    assert.equal(manager.ptys.size, 0)
})

test('PTY flow control pauses a fast producer and resumes only after acknowledgements', async () => {
    const { PTYDataQueue } = setup()
    let paused = false
    let bytes = 0
    const queue = new PTYDataQueue({ pause: () => { paused = true }, resume: () => { paused = false } }, data => { bytes += data.length })
    for (let i = 0; i < 30 && !paused; i++) { queue.push(Buffer.alloc(102400, 65)) }
    assert.equal(paused, true)
    assert.ok(bytes <= 614400)
    const sentBeforePartialAck = bytes
    queue.push(Buffer.alloc(102400, 65))
    queue.ack(1)
    assert.equal(bytes, sentBeforePartialAck, 'producer stays blocked above the high watermark')
    queue.ack(bytes)
    await tick()
    assert.equal(paused, false)
    queue.dispose()
})
