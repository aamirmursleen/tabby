'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { Subject } = require('rxjs')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

function setup () {
    const { SessionMiddleware } = loadDeclarations('tabby-terminal/src/api/middleware.ts', ['SessionMiddleware'], { Subject })
    const { OSCProcessor } = loadDeclarations('tabby-terminal/src/middleware/oscProcessing.ts', ['OSCProcessor'], {
        SessionMiddleware, Subject, os: require('node:os'),
        OSCPrefix: Buffer.from('\x1b]'), OSCSuffixes: [Buffer.from('\x07'), Buffer.from('\x1b\\')],
        MAX_OSC_BYTES: 1024 * 1024,
    })
    const processor = new OSCProcessor()
    const output = []
    const cwd = []
    const clipboard = []
    processor.outputToTerminal$.subscribe(data => output.push(data))
    processor.cwdReported$.subscribe(value => cwd.push(value))
    processor.copyRequested$.subscribe(value => clipboard.push(value))
    return { processor, output, cwd, clipboard }
}

test('CWD recognition works at every possible chunk boundary including ESC and ST', () => {
    const text = 'before\x1b]1337;CurrentDir=/project=a\x1b\\after'
    for (let i = 1; i < text.length; i++) {
        const { processor, output, cwd } = setup()
        processor.feedFromSession(Buffer.from(text.slice(0, i)))
        processor.feedFromSession(Buffer.from(text.slice(i)))
        assert.deepEqual(cwd, ['/project=a'], `split ${i}`)
        assert.equal(Buffer.concat(output).toString(), 'beforeafter')
    }
})

test('ordinary output, CSI, and unsupported OSC pass through byte-for-byte', () => {
    const text = 'α\x1b[32mgreen\x1b[0m\x1b]0;title\x07done'
    const { processor, output } = setup()
    for (const byte of Buffer.from(text)) { processor.feedFromSession(Buffer.from([byte])) }
    assert.equal(Buffer.concat(output).toString(), text)
})

test('clipboard sequences work and malformed clipboard requests do not throw', () => {
    const { processor, clipboard } = setup()
    processor.feedFromSession(Buffer.from('\x1b]52;c;aGVsbG8=\x07'))
    assert.deepEqual(clipboard, ['hello'])
    assert.doesNotThrow(() => processor.feedFromSession(Buffer.from('\x1b]52;c\x07')))
    assert.equal(clipboard.length, 1)
})

test('oversized unterminated OSC cannot indefinitely swallow later terminal output', () => {
    const { processor, output, clipboard } = setup()
    processor.feedFromSession(Buffer.from('\x1b]52;c;'))
    for (let i = 0; i < 20; i++) { processor.feedFromSession(Buffer.alloc(65536, 65)) }
    processor.feedFromSession(Buffer.from('\r\nvisible again'))
    assert.ok(Buffer.concat(output).toString().endsWith('visible again'))
    assert.equal(clipboard.length, 0)
})

test('close releases parser state and completes observers', () => {
    const { processor } = setup()
    let complete = false
    processor.cwdReported$.subscribe({ complete: () => { complete = true } })
    processor.feedFromSession(Buffer.from('\x1b]unfinished'))
    processor.close()
    assert.equal(complete, true)
    assert.equal(processor.chunks.length, 0)
    assert.equal(processor.bufferedBytes, 0)
})
