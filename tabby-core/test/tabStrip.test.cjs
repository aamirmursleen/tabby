'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

test('the horizontal tab strip exposes left and right scrolling controls', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/appRoot.component.pug'), 'utf8')
    assert.match(template, /aria-label='Scroll tabs left'/)
    assert.match(template, /aria-label='Scroll tabs right'/)
    assert.match(template, /#tabsScroller/)
    assert.match(template, /\(wheel\)='onTabsWheel\(\$event\)'/)
})

test('vertical mouse-wheel movement becomes practical horizontal tab movement', () => {
    const { getTabStripWheelDelta } = loadDeclarations(
        'tabby-core/src/components/appRoot.component.ts',
        ['getTabStripWheelDelta'],
    )

    assert.equal(getTabStripWheelDelta(4, 40, 0, 800), 40)
    assert.equal(getTabStripWheelDelta(-25, 5, 0, 800), -25)
    assert.equal(getTabStripWheelDelta(0, 3, 1, 800), 72)
    assert.equal(getTabStripWheelDelta(0, -1, 2, 800), -800)
})

test('active tabs are revealed again after their width animation finishes', () => {
    const { getTabRevealDelays } = loadDeclarations(
        'tabby-core/src/components/appRoot.component.ts',
        ['getTabRevealDelays'],
    )

    assert.deepEqual(JSON.parse(JSON.stringify(getTabRevealDelays(true))), [0, 300])
    assert.deepEqual(JSON.parse(JSON.stringify(getTabRevealDelays(false))), [0])
})
