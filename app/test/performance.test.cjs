'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const { configureChromiumPerformance } = loadDeclarations(
    'app/lib/performance.ts',
    ['CHROMIUM_RASTER_THREAD_COUNT', 'configureChromiumPerformance'],
)

test('configures six Chromium raster workers for the terminal UI', () => {
    const switches = []

    configureChromiumPerformance((name, value) => switches.push([name, value]))

    assert.deepEqual(switches, [['num-raster-threads', '6']])
})
