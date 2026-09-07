'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-regression-')))
const root = path.resolve(__dirname, '../..')
const sessionID = '01234567-89ab-cdef-0123-456789abcdef'
const folders = ['project-a', 'project-b'].map(name => path.join(profile, name))
folders.forEach(folder => fs.mkdirSync(folder))

async function launch () {
    const electron = await _electron.launch({
        executablePath: require('electron'),
        args: [path.join(__dirname, 'bootstrap.cjs')],
        cwd: root,
        env: { ...process.env, TABBY_E2E_PROFILE: profile, TABBY_DEV: '1', TABBY_PLUGINS: '' },
        timeout: 30000,
    })
    try {
        electron.process().stderr.on('data', data => process.stderr.write(data))
        const page = await electron.firstWindow()
        page.on('console', message => {
            if (message.type() === 'error') { console.error('Renderer:', message.text()) }
        })
        page.on('pageerror', error => console.error('Renderer error:', error.message))
        console.log('Test profile:', profile)
        await page.waitForSelector('app-root', { state: 'attached', timeout: 30000 })
        await page.waitForFunction(() => !!window.ng?.getComponent?.(document.querySelector('app-root')), { timeout: 30000 })
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).ready)
        const details = await page.evaluate(() => {
            const root = window.ng.getComponent(document.querySelector('app-root'))
            return { title: document.title, keys: Object.keys(root), safeMode: !!window.safeModeReason }
        })
        assert.equal(details.safeMode, false)
        return { electron, page }
    } catch (error) {
        const page = electron.windows()[0]
        if (page) {
            console.log('Failed page:', await page.evaluate(() => ({ url: location.href, text: document.body.innerText, safeMode: window.safeModeReason, angular: !!window.ng })))
            await page.screenshot({ path: path.join(profile, 'failed.png') }).catch(() => {})
        }
        await electron.evaluate(({ app }) => app.exit(0)).catch(() => {})
        await electron.close().catch(() => {})
        throw error
    }
}

async function stop (electron) {
    await electron.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await electron.close().catch(() => {})
}

async function main () {
    let { electron, page } = await launch()
    try {
        await page.evaluate(async ({ folders, fixturePath, sessionID }) => {
            const root = window.ng.getComponent(document.querySelector('app-root'))
            const { TerminalService } = require('tabby-local')
            const terminal = window.ng.getInjector(document.querySelector('app-root')).get(TerminalService)
            const { NgZone } = require('@angular/core')
            const zone = window.ng.getInjector(document.querySelector('app-root')).get(NgZone)
            await zone.run(async () => {
                await root.app.closeAllTabs(false)
                for (const [i, cwd] of folders.entries()) {
                    const tab = await terminal.openTab({
                        type: 'local', name: `Project ${i + 1}`, options: {
                            command: '/bin/zsh', args: ['-f'], cwd,
                            env: { PATH: fixturePath + ':' + process.env.PATH },
                        },
                    })
                    tab.customTitle = `Project ${i + 1}`
                    // New tabs are normally opened by separate user actions.
                    await new Promise(resolve => tab.frontendReady$.subscribe({ complete: resolve }))
                    if (i === 0) {
                        const original = tab.getRecoveryToken.bind(tab)
                        tab.getRecoveryToken = async options => ({
                            ...await original(options),
                            recoveryCommand: `codex --sandbox danger-full-access --ask-for-approval never resume ${sessionID}`,
                        })
                    }
                }
                root.config.store.recoverTabs = false // accepting the dialog must enable this
                await root.config.save()
            })
        }, { folders, fixturePath: path.join(__dirname, 'fixtures'), sessionID })
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.length === 2)
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.every(t => t.getAllTabs().every(c => c.session?.open && c.frontend)))
        const workingDirectories = await page.evaluate(async () => {
            const tabs = window.ng.getComponent(document.querySelector('app-root')).app.tabs.flatMap(t => t.getAllTabs())
            return Promise.all(tabs.map(t => t.session.getWorkingDirectory()))
        })
        assert.deepEqual(workingDirectories, folders)
        // Exercise real PTY -> IPC -> xterm flow control with more than its 600 KB window.
        await page.evaluate(() => {
            const tab = window.ng.getComponent(document.querySelector('app-root')).app.tabs[1].getAllTabs()[0]
            tab.session.write(Buffer.from("\x15awk 'BEGIN { for (i=0; i<15000; i++) print \"012345678901234567890123456789012345678901234567890123456789\"; print \"OUTPUT_DRAIN_COMPLETE\" }'\r"))
        })
        await page.waitForFunction(() => {
            const terminal = window.ng.getComponent(document.querySelector('app-root')).app.tabs[1].getAllTabs()[0].frontend.xterm
            const buffer = terminal.buffer.active
            return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).some(line => line === 'OUTPUT_DRAIN_COMPLETE')
        }, { timeout: 30000 })
        await page.screenshot({ path: path.join(profile, 'before-close.png') })

        // Native window close cancellation leaves every session alive.
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
        await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-root')).app.closingWindow)
        let dialogs = await electron.evaluate(() => global.__testDialogs)
        assert.equal(dialogs.length, 1)
        assert.equal(dialogs[0].message, 'Close all tabs and save this workspace?')
        assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.length), 2)

        await electron.evaluate(() => { global.__testDialogResponse = 0 })
        const closed = page.waitForEvent('close')
        await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
        await closed
        dialogs = await electron.evaluate(() => global.__testDialogs)
        assert.equal(dialogs.length, 2, 'one prompt per window close, never per tab')
        await electron.evaluate(async ({ session }) => {
            session.defaultSession.flushStorageData()
        })
        await stop(electron)

        // A fresh process must restore both folders and execute the exact safe test fixture.
        ;({ electron, page } = await launch())
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.length === 2)
        await page.waitForFunction(() => {
            const tab = window.ng.getComponent(document.querySelector('app-root')).app.tabs[0].getAllTabs()[0]
            return tab.session?.initialDataBuffer.toString().includes('TEST_CODEX_RESUMED')
        }, { timeout: 30000 })
        await page.locator('tab-header').first().click()
        await page.waitForFunction(() => {
            const terminal = window.ng.getComponent(document.querySelector('app-root')).app.tabs[0].getAllTabs()[0].frontend?.xterm
            if (!terminal) { return false }
            const buffer = terminal.buffer.active
            return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString()).some(line => line.includes('TEST_CODEX_RESUMED'))
        }, { timeout: 30000 })
        const restored = await page.evaluate(async () => {
            const root = window.ng.getComponent(document.querySelector('app-root'))
            const tabs = root.app.tabs.flatMap(t => t.getAllTabs())
            return { enabled: root.config.store.recoverTabs, tabs: await Promise.all(tabs.map(async tab => ({
                cwd: await tab.session.getWorkingDirectory(), title: tab.customTitle,
                text: Array.from({ length: tab.frontend.xterm.buffer.active.length }, (_, i) => tab.frontend.xterm.buffer.active.getLine(i).translateToString()).join('\n'),
            }))) }
        })
        assert.equal(restored.enabled, true)
        assert.deepEqual(restored.tabs.map(t => t.cwd), folders)
        assert.deepEqual(restored.tabs.map(t => t.title), ['Project 1', 'Project 2'])
        assert.match(restored.tabs[0].text, new RegExp(sessionID))
        assert.match(restored.tabs[0].text, /--sandbox danger-full-access --ask-for-approval never resume/)
        assert.equal(restored.tabs[0].text.match(/TEST_CODEX_RESUMED/g).length, 1, 'resume must run exactly once')
        await page.screenshot({ path: path.join(profile, 'restored.png') })
        // macOS Quit follows the same one-dialog workflow, including cancellation.
        await electron.evaluate(({ app }) => app.quit())
        await page.waitForFunction(() => !window.ng.getComponent(document.querySelector('app-root')).app.closingWindow)
        assert.equal((await electron.evaluate(() => global.__testDialogs)).length, 1)
        assert.equal(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.length), 2)
        await electron.evaluate(() => { global.__testDialogResponse = 0 })
        const exited = new Promise(resolve => electron.process().once('exit', resolve))
        await electron.evaluate(({ app }) => app.quit())
        await exited
        assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'test-dialogs.json'))).length, 2)
        ;({ electron, page } = await launch())
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.length === 2)
        assert.deepEqual(await page.evaluate(() => window.ng.getComponent(document.querySelector('app-root')).app.tabs.flatMap(t => t.getAllTabs()).map(t => t.profile.options.cwd)), folders)
        console.log(JSON.stringify({ result: 'PASS', profile, checks: ['ARM64 desktop boot', 'PTY backpressure', 'cancel close', 'one close-all prompt', 'workspace reopen', 'background session start', 'exact Codex resume arguments', 'no duplicate resume', 'macOS Quit and reopen'] }))
    } catch (error) {
        console.log('Failure state:', await page.evaluate(() => ({ text: document.body.innerText, tabs: window.ng.getComponent(document.querySelector('app-root')).app.tabs.map(t => ({ name: t.constructor.name, children: t.getAllTabs?.().map(c => ({ name: c.constructor.name, open: c.session?.open, frontend: !!c.frontend })) })) })).catch(() => ({})))
        await page.screenshot({ path: path.join(profile, 'failed.png') }).catch(() => {})
        throw error
    } finally {
        await stop(electron)
    }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
