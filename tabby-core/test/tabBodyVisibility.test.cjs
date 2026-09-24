'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const stylesheet = fs.readFileSync(path.resolve(__dirname, '../src/components/appRoot.component.scss'), 'utf8')

test('inactive tab bodies remain measurable while hidden from painting', () => {
    assert.match(stylesheet, /> \.content-tab\s*\{[^}]*visibility:\s*hidden;/)
    assert.match(stylesheet, /> \.content-tab\s*\{[^}]*pointer-events:\s*none;/)
    assert.match(stylesheet, /&\.content-tab-active\s*\{[^}]*visibility:\s*visible;/)
    assert.match(stylesheet, /&\.content-tab-active\s*\{[^}]*pointer-events:\s*auto;/)
    assert.doesNotMatch(stylesheet, /> \.content-tab\s*\{[^}]*display:\s*none;/)
})
