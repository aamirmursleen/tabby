'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const sourcePath = path.resolve(__dirname, '../src/utils/codexRecovery.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2021,
    },
    fileName: sourcePath,
})
const sourceModule = new Module(sourcePath, module)
sourceModule.filename = sourcePath
sourceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath))
sourceModule._compile(compiled.outputText, sourcePath)

const { getCodexRecoveryCommand } = sourceModule.exports

test('restores codex when it is present anywhere in the terminal process tree', () => {
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'node' },
        { pid: 2, ppid: 1, command: '/usr/local/bin/codex' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume --last')
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'CODEX.EXE' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume --last')
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'codex-code-mode-host' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume --last')
})

test('does not automatically rerun unrelated terminal commands', () => {
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'npm' },
        { pid: 2, ppid: 1, command: 'vim' },
    ]), null)
    assert.equal(getCodexRecoveryCommand([]), null)
})
