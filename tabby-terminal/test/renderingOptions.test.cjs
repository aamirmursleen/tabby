'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const { terminalAllowsTransparency } = loadDeclarations(
    'tabby-terminal/src/frontends/renderingOptions.ts',
    ['terminalAllowsTransparency'],
)

test('terminal transparency is enabled only when macOS vibrancy needs it', () => {
    assert.equal(terminalAllowsTransparency({ appearance: { vibrancy: true } }), true)
    assert.equal(terminalAllowsTransparency({ appearance: { vibrancy: false } }), false)
    assert.equal(terminalAllowsTransparency({}), false)
})
