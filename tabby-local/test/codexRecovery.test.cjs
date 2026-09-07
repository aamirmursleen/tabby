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

const { getCodexRecoveryCommand, buildCodexRecoveryOptions, getValidatedCodexRecoveryCommand } = sourceModule.exports

test('restores codex when it is present anywhere in the terminal process tree', () => {
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'node' },
        { pid: 2, ppid: 1, command: '/usr/local/bin/codex' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume')
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'CODEX.EXE' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume')
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'codex-code-mode-host' },
    ]), 'codex --sandbox danger-full-access --ask-for-approval never resume')
})

test('resumes an exact UUID and never treats arbitrary saved text as a command', () => {
    const id = '019f7131-37d8-7763-b3c2-ab47f40276b7'
    const command = getCodexRecoveryCommand([{ command: 'codex' }], id)
    assert.equal(command, `codex --sandbox danger-full-access --ask-for-approval never resume ${id}`)
    assert.equal(getValidatedCodexRecoveryCommand(command), command)
    assert.equal(getValidatedCodexRecoveryCommand(command + '; touch /tmp/unwanted'), null)
    assert.equal(getValidatedCodexRecoveryCommand('rm -rf /'), null)
    assert.equal(getCodexRecoveryCommand([{ command: 'codex-unrelated-helper' }]), null)
})

test('legacy latest-session recovery becomes a picker instead of selecting the wrong same-folder session', () => {
    assert.equal(
        getValidatedCodexRecoveryCommand('codex --sandbox danger-full-access --ask-for-approval never resume --last'),
        'codex --sandbox danger-full-access --ask-for-approval never resume',
    )
})

test('restored zsh runs Codex after shell initialization, without timed input injection', () => {
    const options = { command: '/bin/zsh', args: ['--login'], cwd: '/project' }
    const command = getCodexRecoveryCommand([{ command: 'codex' }])
    const restored = buildCodexRecoveryOptions(options, command)
    assert.deepEqual(restored.args.slice(0, 3), ['--login', '-i', '-c'])
    assert.match(restored.args[3], /^codex .* resume; exec '\/bin\/zsh' '--login'$/)
    assert.equal(restored.cwd, '/project')
    assert.deepEqual(options.args, ['--login'])
    assert.equal(buildCodexRecoveryOptions(options, 'echo unexpected'), null)
    assert.equal(buildCodexRecoveryOptions({ command: 'python', args: [] }, command), null)
    assert.equal(buildCodexRecoveryOptions({ command: 'zsh', args: ['-lc', 'other'] }, command), null)
})

test('does not automatically rerun unrelated terminal commands', () => {
    assert.equal(getCodexRecoveryCommand([
        { pid: 1, ppid: 0, command: 'npm' },
        { pid: 2, ppid: 1, command: 'vim' },
    ]), null)
    assert.equal(getCodexRecoveryCommand([]), null)
})
