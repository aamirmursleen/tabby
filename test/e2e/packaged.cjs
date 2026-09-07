'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')

async function main () {
    if (!process.argv[2]) { throw new Error('Provide the packaged .app path') }
    const artifacts = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-packaged-smoke-')))
    const bundle = path.join(artifacts, 'Tabby Custom.app')
    execFileSync('/usr/bin/ditto', [path.resolve(process.argv[2]), bundle])
    const profile = path.join(bundle, 'Contents/MacOS/data')
    fs.mkdirSync(profile)
    // Tabby's existing portable-data mode isolates config AND Electron storage.
    fs.writeFileSync(path.join(profile, 'config.yaml'), JSON.stringify({
        version: 7, enableWelcomeTab: false, enableAnalytics: false, enableAutomaticUpdates: false,
        recoverTabs: false, hotkeys: { 'toggle-window': [] },
        terminal: { autoOpen: true, profile: 'local:smoke' },
        profiles: [{
            id: 'local:smoke', type: 'local', name: 'Packaged smoke test',
            options: { command: '/bin/sh', args: [path.join(__dirname, 'fixtures/packaged-smoke.sh')], cwd: profile },
        }],
    }))
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime',
        '--entitlements', path.resolve(__dirname, '../../build/mac/entitlements.plist'), bundle])
    const child = spawn(path.join(bundle, 'Contents/MacOS/Tabby Custom'), ['--hidden'], {
        env: { ...process.env, TABBY_PACKAGED_SMOKE_PROFILE: profile, TABBY_CONFIG_DIRECTORY: profile, TABBY_DEV: '', TABBY_PLUGINS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', data => { logs += data })
    child.stderr.on('data', data => { logs += data })
    let spawnError
    child.on('error', error => { spawnError = error })
    try {
        const deadline = Date.now() + 30000
        while (!fs.existsSync(path.join(profile, 'pty-output')) && Date.now() < deadline && child.exitCode === null && !spawnError) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (spawnError) { throw spawnError }
        assert.equal(fs.readFileSync(path.join(profile, 'pty-output'), 'utf8'), 'PACKAGED_ARM64_PTY_OK\n')
        console.log(JSON.stringify({ result: 'PASS', artifacts, check: 'signed ARM64 packaged app launches a real terminal in an isolated portable profile' }))
    } catch (error) {
        console.error(logs)
        throw error
    } finally {
        if (child.exitCode === null && child.pid) {
            const exited = new Promise(resolve => child.once('exit', resolve))
            child.kill('SIGTERM')
            await exited
        }
        fs.writeFileSync(path.join(artifacts, 'main.log'), logs)
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
