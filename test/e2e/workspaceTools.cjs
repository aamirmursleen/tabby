'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-workspace-tools-')))
const root = path.resolve(__dirname, '../..')
async function launch () {
    const electron = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'bootstrap.cjs')], cwd: root,
        env: { ...process.env, TABBY_E2E_PROFILE: profile, TABBY_DEV: '1', TABBY_PLUGINS: '' } })
    const page = await electron.firstWindow()
    try {
        await page.waitForFunction(() => typeof window.ng?.getComponent === 'function' && !!document.querySelector('app-root') && window.ng.getComponent(document.querySelector('app-root'))?.ready)
    } catch (error) { await stop(electron); throw error }
    return { electron, page }
}
async function stop (electron) {
    await electron.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await electron.close().catch(() => {})
}
async function panePositions (page) {
    return page.locator('terminal-pane-header').evaluateAll(headers => headers.map(h => {
        const pane = h.parentElement
        return { name: h.querySelector('span').textContent, x: pane.style.left, y: pane.style.top }
    }).sort((a, b) => a.name.localeCompare(b.name)))
}
function snippetCard (page, title) {
    return page.locator('workspace-tools article.snippet-card').filter({ has: page.getByRole('button', { name: `Run ${title}`, exact: true }) })
}
async function waitForTitles (page, titles) {
    await page.waitForFunction(expected => {
        const actual = [...document.querySelectorAll('workspace-tools article.snippet-card .snippet-title > span:last-child')].map(el => el.textContent.trim())
        return JSON.stringify(actual) === JSON.stringify(expected)
    }, titles)
}
async function createGroup (page, name) {
    await page.getByRole('button', { name: 'New group', exact: true }).click()
    await page.getByLabel('Group name', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Save group', exact: true }).click()
    await page.getByRole('button', { name: `Toggle group ${name}`, exact: true }).waitFor()
}
async function createSnippet (page, title, command, group) {
    await page.getByRole('button', { name: 'New snippet', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Command', { exact: true }).fill(command)
    await page.getByLabel('Group', { exact: true }).selectOption({ label: group })
    await page.getByRole('button', { name: 'Save snippet', exact: true }).click()
    await snippetCard(page, title).waitFor()
}
async function dropdownAction (page, buttonName, itemName) {
    await page.getByRole('button', { name: buttonName, exact: true }).click()
    await page.locator('.dropdown-menu.show').getByText(itemName, { exact: true }).click()
}
async function main () {
    let { electron, page } = await launch()
    try {
        await page.evaluate(async () => {
            const el = document.querySelector('app-root')
            const root = window.ng.getComponent(el)
            const injector = window.ng.getInjector(el)
            const terminal = injector.get(require('tabby-local').TerminalService)
            await injector.get(require('@angular/core').NgZone).run(async () => {
                await root.app.closeAllTabs(false)
                const first = await terminal.openTab({ type: 'local', name: 'Test server', options: { command: '/bin/zsh', args: ['-f'] } })
                await new Promise(resolve => first.frontendReady$.subscribe({ complete: resolve }))
                const split = root.app.activeTab
                const right = await split.splitTab(first, 'r')
                await split.splitTab(first, 'b')
                await split.splitTab(right, 'b')
            })
        })
        await page.waitForFunction(() => [...document.querySelectorAll('terminal-pane-header')].length === 4)
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.activeTab.getAllTabs().every(t => t.frontend && t.session?.open))
        const names = ['API server', 'Worker', 'Database', 'Logs']
        for (let i = 0; i < 4; i++) {
            await page.getByRole('button', { name: 'Rename pane', exact: true }).nth(i).click()
            await page.getByRole('textbox', { name: 'Pane name', exact: true }).fill(names[i])
            await page.getByRole('textbox', { name: 'Pane name', exact: true }).press('Enter')
        }
        assert.deepEqual(await page.locator('terminal-pane-header .pane-name span').allTextContents(), names)
        await page.getByRole('button', { name: 'Rename pane', exact: true }).first().click()
        await page.getByRole('textbox', { name: 'Pane name', exact: true }).fill('Discard me')
        await page.getByRole('textbox', { name: 'Pane name', exact: true }).press('Escape')
        assert.equal(await page.locator('terminal-pane-header .pane-name span').first().textContent(), 'API server')
        // Choose a pane through the actual terminal DOM.
        await page.locator('split-tab > .child').first().locator('.content').first().click({ position: { x: 30, y: 30 } })
        await page.getByRole('button', { name: 'Snippets', exact: true }).click()
        await createGroup(page, 'Deployment')
        await createGroup(page, 'Maintenance')
        await createSnippet(page, 'Print marker', 'printf before_edit', 'Deployment')
        await createSnippet(page, 'Alpha health', 'printf service_is_healthy', 'Deployment')
        await createSnippet(page, 'Zulu logs', 'printf "<b>Logs stay plain text</b>"', 'Deployment')
        const deployment = page.locator('workspace-tools section.snippet-group').filter({ has: page.getByRole('button', { name: 'Toggle group Deployment', exact: true }) })
        assert.equal(await deployment.locator('article.snippet-card').count(), 3)
        assert.equal(await snippetCard(page, 'Zulu logs').locator('pre').textContent(), 'printf "<b>Logs stay plain text</b>"')
        assert.equal(await snippetCard(page, 'Zulu logs').locator('pre b').count(), 0)

        // Sorting applies inside a group, and updated order changes after editing.
        await dropdownAction(page, 'Sort snippets', 'Name: A–Z')
        await waitForTitles(page, ['Alpha health', 'Print marker', 'Zulu logs'])
        await dropdownAction(page, 'Sort snippets', 'Name: Z–A')
        await waitForTitles(page, ['Zulu logs', 'Print marker', 'Alpha health'])
        await dropdownAction(page, 'Sort snippets', 'Newest first')
        await waitForTitles(page, ['Zulu logs', 'Alpha health', 'Print marker'])
        await dropdownAction(page, 'More actions for Print marker', 'Edit snippet')
        assert.equal(await page.getByLabel('Command', { exact: true }).inputValue(), 'printf before_edit')
        assert.equal(await page.getByLabel('Group', { exact: true }).locator('option:checked').textContent(), 'Deployment')
        // The complete marker appears only in output, so this proves Run submits the command.
        const runCommand = "printf '%s%s\\n' WORKSPACE_ RUN_OK"
        await page.getByLabel('Command', { exact: true }).fill(runCommand)
        await page.getByRole('button', { name: 'Save snippet', exact: true }).click()
        await snippetCard(page, 'Print marker').waitFor()
        await dropdownAction(page, 'Sort snippets', 'Recently updated')
        await waitForTitles(page, ['Print marker', 'Zulu logs', 'Alpha health'])

        const search = page.getByRole('textbox', { name: 'Search snippets', exact: true })
        await search.fill('Alpha health')
        await waitForTitles(page, ['Alpha health'])
        await search.fill('service_is_healthy')
        await waitForTitles(page, ['Alpha health'])
        await search.fill('Deployment')
        await waitForTitles(page, ['Print marker', 'Zulu logs', 'Alpha health'])
        await search.fill('no-matching-snippet-or-group')
        await waitForTitles(page, [])
        await search.fill('')
        await waitForTitles(page, ['Print marker', 'Zulu logs', 'Alpha health'])

        const toggleDeployment = page.getByRole('button', { name: 'Toggle group Deployment', exact: true })
        await toggleDeployment.click()
        assert.equal(await toggleDeployment.getAttribute('aria-expanded'), 'false')
        await snippetCard(page, 'Print marker').waitFor({ state: 'hidden' })
        await toggleDeployment.click()
        assert.equal(await toggleDeployment.getAttribute('aria-expanded'), 'true')
        await snippetCard(page, 'Print marker').waitFor()
        const targetName = await page.locator('workspace-tools .target strong').textContent()
        assert.equal(targetName, 'API server')
        await page.getByRole('button', { name: 'Run Print marker', exact: true }).click()
        await page.waitForFunction(() => window.ng.getComponent(document.querySelector('app-root')).app.activeTab.getAllTabs().some(t => t.frontend.saveState().includes('WORKSPACE_RUN_OK')))
        const received = await page.evaluate(() => window.ng.getComponent(document.querySelector('app-root')).app.activeTab.getAllTabs().filter(t => t.frontend.saveState().includes('WORKSPACE_RUN_OK')).map(t => t.customTitle))
        assert.deepEqual(received, [targetName])

        await dropdownAction(page, 'More actions for group Deployment', 'Rename group')
        await page.getByLabel('Group name', { exact: true }).fill('Release commands')
        await page.getByRole('button', { name: 'Save group', exact: true }).click()
        await page.getByRole('button', { name: 'Toggle group Release commands', exact: true }).waitFor()
        await search.fill('Release commands')
        await waitForTitles(page, ['Print marker', 'Zulu logs', 'Alpha health'])
        await search.fill('Deployment')
        await waitForTitles(page, [])
        await search.fill('')
        await dropdownAction(page, 'More actions for group Release commands', 'Delete group')
        await page.getByRole('button', { name: 'Delete group', exact: true }).click()
        await page.getByRole('button', { name: 'Toggle group Release commands', exact: true }).waitFor({ state: 'hidden' })
        await dropdownAction(page, 'Sort snippets', 'Name: A–Z')
        await waitForTitles(page, ['Alpha health', 'Print marker', 'Zulu logs'])
        await dropdownAction(page, 'More actions for Alpha health', 'Edit snippet')
        assert.equal(await page.getByLabel('Group', { exact: true }).inputValue(), '')
        // A second assignment must remain attached to its group after restart.
        await page.getByLabel('Group', { exact: true }).selectOption({ label: 'Maintenance' })
        await page.getByRole('button', { name: 'Save snippet', exact: true }).click()
        await snippetCard(page, 'Alpha health').waitFor()
        await page.screenshot({ path: path.join(profile, 'four-panes-snippets.png') })
        const geometry = await page.locator('split-tab > .child').evaluateAll(panes => panes.map(p => {
            const header = p.querySelector('terminal-pane-header').getBoundingClientRect()
            const terminal = p.querySelector('.content').getBoundingClientRect()
            return { headerBottom: header.bottom, terminalTop: terminal.top }
        }))
        assert(geometry.every(g => g.terminalTop >= g.headerBottom))
        const positions = await panePositions(page)
        await page.evaluate(async () => {
            const root = window.ng.getComponent(document.querySelector('app-root'))
            await root.app.tabRecovery.saveTabs(root.app.tabs)
        })
        await stop(electron)
        ;({ electron, page } = await launch())
        await page.waitForFunction(() => document.querySelectorAll('terminal-pane-header').length === 4)
        assert.deepEqual((await page.locator('terminal-pane-header .pane-name span').allTextContents()).sort(), [...names].sort())
        await page.getByRole('button', { name: 'Snippets', exact: true }).click()
        assert.deepEqual(await panePositions(page), positions)
        await page.getByRole('button', { name: 'Run Print marker', exact: true }).waitFor()
        assert.equal(await snippetCard(page, 'Print marker').locator('pre').textContent(), runCommand)
        assert.equal(await page.locator('workspace-tools article.snippet-card').count(), 3)
        assert.equal(await page.getByRole('button', { name: 'Toggle group Release commands', exact: true }).count(), 0)
        const maintenance = page.locator('workspace-tools section.snippet-group').filter({ has: page.getByRole('button', { name: 'Toggle group Maintenance', exact: true }) })
        await maintenance.waitFor()
        assert.equal(await maintenance.locator('article.snippet-card .snippet-title > span:last-child').textContent(), 'Alpha health')
        await dropdownAction(page, 'More actions for Alpha health', 'Edit snippet')
        assert.equal(await page.getByLabel('Group', { exact: true }).locator('option:checked').textContent(), 'Maintenance')
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await dropdownAction(page, 'More actions for Zulu logs', 'Delete snippet')
        await page.getByRole('button', { name: 'Delete permanently', exact: true }).click()
        await snippetCard(page, 'Zulu logs').waitFor({ state: 'hidden' })
        assert.equal(await page.locator('workspace-tools article.snippet-card').count(), 2)
        console.log('PASS: four pane names, rename/cancel, snippet CRUD, group search/assignment/rename/delete, collapse, four sort modes, one-pane command execution, restart persistence. Artifacts:', profile)
    } catch (error) {
        await page.screenshot({ path: path.join(profile, 'failure.png') }).catch(() => {})
        console.error('Artifacts:', profile)
        throw error
    } finally { await stop(electron) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
