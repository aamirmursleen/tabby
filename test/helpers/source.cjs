'use strict'

// Exercise repository declarations without booting Electron or Angular.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const assert = require('node:assert/strict')

exports.loadDeclarations = (relativePath, names, globals = {}) => {
    const filename = path.resolve(__dirname, '../..', relativePath)
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    const selected = source.statements.filter(node => names.includes(node.name?.text)
        || node.declarationList?.declarations.some(declaration => names.includes(declaration.name.text)))
    assert.equal(selected.length, names.length, `Missing declarations in ${relativePath}`)
    const input = selected.map(node => node.getText(source)).join('\n')
        + '\nexports.result = {' + names.join(',') + '}'
    const compiled = ts.transpileModule(input, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
    }, fileName: filename })
    const context = {
        exports: {}, Buffer, console, setTimeout, clearTimeout, setImmediate, clearImmediate,
        queueMicrotask, Date, Promise, Map, WeakMap, Object, Array,
        Injectable: () => target => target, Inject: () => () => {},
        ...globals,
    }
    vm.runInNewContext(compiled.outputText, context, { filename, timeout: 2000 })
    return context.exports.result
}

exports.deferred = () => {
    let resolve
    let reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
