'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const sourcePath = path.resolve(__dirname, '../src/utils/processTree.ts')
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

const { getDescendantProcesses, getTerminalProcessTree } = sourceModule.exports

test('returns every descendant in parent-before-child order', () => {
    const unrelated = { pid: 99, ppid: 0, command: 'other' }
    const child = { pid: 2, ppid: 1, command: 'node' }
    const grandchild = { pid: 3, ppid: 2, command: 'codex' }
    const sibling = { pid: 4, ppid: 1, command: 'watcher' }

    assert.deepEqual(
        getDescendantProcesses([grandchild, unrelated, sibling, child], 1),
        [sibling, child, grandchild],
    )
})

test('does not loop forever when the process list contains a cycle', () => {
    const first = { pid: 1, ppid: 2, command: 'first' }
    const second = { pid: 2, ppid: 1, command: 'second' }

    assert.deepEqual(getDescendantProcesses([first, second], 1), [second])
})

test('includes a foreground root process but excludes the terminal shell itself', () => {
    const shell = { pid: 1, ppid: 0, command: 'zsh' }
    const codex = { pid: 2, ppid: 1, command: 'codex' }
    const helper = { pid: 3, ppid: 2, command: 'codex-helper' }
    const processes = [shell, codex, helper]

    assert.deepEqual(getTerminalProcessTree(processes, 1, 1), [codex, helper])
    assert.deepEqual(getTerminalProcessTree(processes, 1, 2), [codex, helper])
})
