'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

function setup () {
    const callbacks = []
    let focuses = 0
    const document = { activeElement: null, querySelector: () => null }
    const { XTermFrontend } = loadDeclarations('tabby-terminal/src/frontends/xtermFrontend.ts', ['XTermFrontend'], {
        Frontend: class {}, document, setTimeout: callback => callbacks.push(callback),
    })
    const frontend = Object.assign(Object.create(XTermFrontend.prototype), {
        disposed: false, opened: true, enableResizing: true,
        element: { getClientRects: () => [{}] }, xterm: { focus: () => { focuses++ } },
    })
    return { frontend, document, flush: () => callbacks.splice(0).forEach(callback => callback()), focuses: () => focuses }
}

test('a pending focus request must not redirect typing out of a password dialog', () => {
    const h = setup()
    h.frontend.focus()
    h.document.querySelector = () => ({ role: 'dialog' })
    h.flush()
    assert.equal(h.focuses(), 0)
})

test('returning to a window preserves focus in an editor but restores terminal input otherwise', () => {
    const h = setup()
    h.document.activeElement = { matches: () => true, classList: { contains: () => false } }
    h.frontend.focus()
    h.flush()
    assert.equal(h.focuses(), 0)
    h.document.activeElement = null
    h.frontend.focus()
    h.flush()
    assert.equal(h.focuses(), 1)
    h.document.activeElement = { matches: () => true, classList: { contains: () => true } }
    h.frontend.focus()
    h.flush()
    assert.equal(h.focuses(), 2, 'the xterm helper textarea is still a terminal input target')
})

test('queued requests from hidden, inactive, detached or destroyed panes cannot steal keyboard input', () => {
    for (const deactivate of [
        h => { h.frontend.disposed = true },
        h => { h.frontend.opened = false },
        h => { h.frontend.enableResizing = false },
        h => { h.frontend.element = null },
        h => { h.frontend.element.getClientRects = () => [] },
    ]) {
        const h = setup()
        h.frontend.focus()
        deactivate(h)
        h.flush()
        assert.equal(h.focuses(), 0)
    }
})
