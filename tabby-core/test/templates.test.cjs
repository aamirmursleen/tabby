'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const pug = require('pug')
const { getExtractedSVG } = require('svg-inline-loader')

// Webpack emits these templates in JIT mode without compiling them with Angular.
// Use the real runtime compiler so a template error cannot first appear at startup.
const angular = import('@angular/compiler').then(() => import('@angular/core'))
const components = path.resolve(__dirname, '../src/components')

for (const filename of fs.readdirSync(components).filter(name => name.endsWith('.component.pug')).sort()) {
    test(`${filename} compiles with Angular's runtime compiler`, async () => {
        const { Component } = await angular
        const template = pug.renderFile(path.join(components, filename), {
            doctype: 'html',
            pretty: true,
            require: resource => {
                assert.equal(path.extname(resource), '.svg', 'Support new template resource types explicitly')
                return getExtractedSVG(fs.readFileSync(path.resolve(components, resource), 'utf8'))
            },
        })
        class TemplateCheck {}
        Component({ template })(TemplateCheck)
        assert.doesNotThrow(() => TemplateCheck.ɵcmp)
    })
}
