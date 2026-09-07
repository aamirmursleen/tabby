'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

test('the superseded local tab-list plugin cannot double-patch builtin session recovery', () => {
    const { PLUGIN_BLACKLIST } = loadDeclarations('app/src/pluginBlacklist.ts', ['PLUGIN_BLACKLIST'])
    assert.ok(PLUGIN_BLACKLIST.includes('tabby-tab-list'))
})
