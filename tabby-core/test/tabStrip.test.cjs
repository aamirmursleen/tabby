'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

test('the horizontal tab strip exposes left and right scrolling controls', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/appRoot.component.pug'), 'utf8')
    const styles = fs.readFileSync(path.resolve(__dirname, '../src/components/appRoot.component.scss'), 'utf8')
    assert.match(template, /aria-label='Scroll tabs left'/)
    assert.match(template, /aria-label='Scroll tabs right'/)
    assert.match(template, /#tabsScroller/)
    assert.match(template, /\(wheel\)='onTabsWheel\(\$event\)'/)
    assert.match(styles, /scrollbar-width:\s*thin/)
    assert.match(styles, /width:\s*38px/)
})

test('vertical mouse-wheel movement becomes fast horizontal tab movement', () => {
    const { getTabStripPageStep, getTabStripWheelDelta } = loadDeclarations(
        'tabby-core/src/components/appRoot.component.ts',
        ['getTabStripPageStep', 'getTabStripWheelDelta'],
    )

    assert.equal(getTabStripWheelDelta(4, 40, 0, 800), 100)
    assert.equal(getTabStripWheelDelta(-25, 5, 0, 800), -62.5)
    assert.equal(getTabStripWheelDelta(0, 3, 1, 800), 180)
    assert.equal(getTabStripWheelDelta(0, -1, 2, 800), -800)
    assert.equal(getTabStripPageStep(300), 600)
    assert.equal(getTabStripPageStep(1000), 900)
})

test('tab headers use stable saved and profile names instead of changing shell titles', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/components/tabHeader.component.pug'), 'utf8')
    const component = fs.readFileSync(path.resolve(__dirname, '../src/components/tabHeader.component.ts'), 'utf8')
    assert.match(template, /\{\{displayName\}\}/)
    assert.match(component, /getOpenTabLabel\(this\.tab, this\.index\)/)
})

test('active tabs are revealed again after their width animation finishes', () => {
    const { getTabRevealDelays } = loadDeclarations(
        'tabby-core/src/components/appRoot.component.ts',
        ['getTabRevealDelays'],
    )

    assert.deepEqual(JSON.parse(JSON.stringify(getTabRevealDelays(true))), [0, 300])
    assert.deepEqual(JSON.parse(JSON.stringify(getTabRevealDelays(false))), [0])
})
