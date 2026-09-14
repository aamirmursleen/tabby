'use strict'
// Real Angular form/list integration with isolated profile storage and recovery
// test doubles. No installed app, shell, SSH session or user config is accessed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const pug = require('pug')
const sass = require('sass')
const webpack = require('webpack')
const { chromium } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const root = path.resolve(__dirname, '../..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aamir-layouts-test-'))

function declarations (file, names) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const selected = source.statements.filter(node => names.includes(node.name?.text))
    assert.equal(selected.length, names.length)
    return ts.transpileModule(selected.map(node => node.getText(source)).join('\n').replace(/@Component\(\{[\s\S]*?\}\)/, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
}
const components = path.join(root, 'tabby-core/src/components')
const template = pug.renderFile(path.join(components, 'savedLayouts.component.pug'), { doctype: 'html', pretty: true })
const styles = ['workspaceTools.component.scss', 'savedLayouts.component.scss'].map(file => sass.compile(path.join(components, file)).css)
const iconsCSS = require.resolve('@fortawesome/fontawesome-free/css/all.min.css')
const iconsFonts = path.resolve(path.dirname(iconsCSS), '../webfonts')
const fontFiles = new Set(fs.readdirSync(iconsFonts))
const entry = `
import 'zone.js';
import '@angular/compiler';
import { ApplicationRef, Component, NgModule, Injectable, Output, EventEmitter, HostListener } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import deepmerge from 'deepmerge';
const exports = {};
const configMerge = (a, b) => deepmerge(a, b, { arrayMerge: (_destination, source) => source });
const _ = value => value;
const slugify = value => value;
let nextID = 0;
const uuidv4 = () => String(++nextID);
class ProfileProvider {} class AppService {}
${declarations('tabby-core/src/profiles.ts', ['SplitLayoutProfilesService'])}
${declarations('tabby-core/src/components/savedLayouts.component.ts', ['SavedLayoutsComponent'])}
const pane = name => ({ type: 'app:ssh-tab', tabCustomTitle: name, profile: { id: name, type: 'ssh', name, options: { host: 'test.invalid' } } });
window.layout = { type: 'app:split-tab', orientation: 'v', ratios: [.4, .6], focusedTabIndex: 2, tabCustomTitle: 'Work',
    children: [
        { type: 'app:split-tab', orientation: 'h', ratios: [.3, .7], children: [pane('API'), pane('Logs')] },
        { type: 'app:split-tab', orientation: 'h', ratios: [.55, .45], children: [pane('Local'), pane('Database')] },
    ] };
const tab = { customTitle: 'Work', emitFocused() {} };
const app = { activeTab: tab, tabs: [tab], opened: [], openNewTab(params) { this.opened.push(params); } };
const config = { store: { profiles: JSON.parse(localStorage.getItem('test-layout-profiles') || '[]') }, failSave: false,
    async save() { if (this.failSave) throw new Error('Test disk full'); localStorage.setItem('test-layout-profiles', JSON.stringify(this.store.profiles)); } };
const recovery = { async getFullRecoveryToken() { return window.layout; },
    async recoverTab(token) { return { type: 'test-terminal', inputs: { _recoveredState: token, customTitle: token.tabCustomTitle } }; } };
const service = new SplitLayoutProfilesService(config, recovery);
SavedLayoutsComponent.ctorParameters = () => [{ type: SplitLayoutProfilesService }, { type: AppService }];
Component({ selector: 'saved-layouts', template: ${JSON.stringify(template)}, styles: ${JSON.stringify(styles)} })(SavedLayoutsComponent);
class HarnessModule {}
NgModule({ imports: [BrowserModule, FormsModule], declarations: [SavedLayoutsComponent],
    providers: [{ provide: SplitLayoutProfilesService, useValue: service }, { provide: AppService, useValue: app }],
    bootstrap: [SavedLayoutsComponent] })(HarnessModule);
window.harness = { app, config, service };
platformBrowserDynamic().bootstrapModule(HarnessModule).then(module => {
    window.harness.component = module.injector.get(ApplicationRef).components[0].instance;
    window.harness.ready = true;
}).catch(error => { window.harness.error = String(error); });
`
fs.writeFileSync(path.join(output, 'entry.js'), entry)

async function main () {
    await new Promise((resolve, reject) => {
        webpack({ mode: 'development', devtool: false, context: root, entry: path.join(output, 'entry.js'),
            resolve: { modules: [path.join(root, 'node_modules'), path.join(root, 'tabby-core/node_modules'), path.join(root, 'app/node_modules'), 'node_modules'] },
            output: { path: output, filename: 'bundle.js' },
        }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())
    })
    const server = http.createServer((request, response) => {
        const fontName = request.url.startsWith('/webfonts/') ? request.url.slice('/webfonts/'.length) : ''
        if (fontFiles.has(fontName)) {
            response.setHeader('Content-Type', 'application/octet-stream')
            response.end(fs.readFileSync(path.join(iconsFonts, fontName)))
        } else if (request.url === '/icons.css') {
            response.setHeader('Content-Type', 'text/css')
            response.end(fs.readFileSync(iconsCSS))
        } else if (request.url === '/bundle.js') {
            response.setHeader('Content-Type', 'text/javascript')
            response.end(fs.readFileSync(path.join(output, 'bundle.js')))
        } else {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/icons.css"><style>body{margin:0;display:flex;justify-content:flex-end;height:100vh;background:#111722;font-family:Arial,sans-serif}*{box-sizing:border-box}</style></head><body><saved-layouts></saved-layouts><script src="/bundle.js"></script></body></html>')
        }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
        page.setDefaultTimeout(15000)
        page.on('pageerror', error => console.error('Browser error:', error.message))
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.waitForFunction(() => window.harness?.ready || window.harness?.error)
        assert.equal(await page.evaluate(() => window.harness.error), undefined)

        await page.getByRole('button', { name: 'Save current tab', exact: true }).click()
        await page.getByLabel('Layout name', { exact: true }).fill('Daily work')
        await page.getByRole('button', { name: 'Save layout', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('.layout-card') || document.querySelector('[role=alert]'))
        assert.equal(await page.locator('[role=alert]').count(), 0, await page.locator('saved-layouts').innerText())
        await page.getByRole('button', { name: 'Open layout Daily work', exact: true }).waitFor()
        assert.equal(await page.locator('.preview-pane').count(), 4)
        const positions = await page.locator('.preview-pane').evaluateAll(panes => panes.map(pane => ['left', 'top', 'width', 'height'].map(key => Math.round(parseFloat(pane.style[key])))))
        assert.deepEqual(positions, [[0, 0, 30, 40], [30, 0, 70, 40], [0, 40, 55, 60], [55, 40, 45, 60]])
        await page.locator('saved-layouts').screenshot({ path: path.join(output, 'saved-layouts.png') })

        await page.getByLabel('Search saved layouts').fill('database')
        assert.equal(await page.locator('.layout-card').count(), 1)
        await page.getByLabel('Search saved layouts').fill('no match')
        assert.equal(await page.locator('.layout-card').count(), 0)
        await page.getByLabel('Search saved layouts').fill('')
        await page.getByRole('button', { name: 'Open layout Daily work', exact: true }).click()
        await page.waitForFunction(() => window.harness.app.opened.length === 1 || document.querySelector('[role=alert]'))
        assert.equal(await page.locator('[role=alert]').count(), 0, await page.locator('saved-layouts').innerText())
        assert.equal(await page.evaluate(() => window.harness.app.opened.length), 1)
        assert.equal(await page.evaluate(() => window.harness.app.tabs.length), 1, 'opening leaves the existing tab intact')
        assert.deepEqual(await page.evaluate(() => window.harness.app.opened[0].inputs._recoveredState.ratios), [.4, .6])

        await page.getByRole('button', { name: 'Rename layout Daily work', exact: true }).click()
        await page.getByLabel('Layout name', { exact: true }).fill('Servers')
        await page.getByRole('button', { name: 'Save layout', exact: true }).click()
        await page.getByRole('button', { name: 'Open layout Servers', exact: true }).waitFor()
        await page.reload()
        await page.getByRole('button', { name: 'Open layout Servers', exact: true }).waitFor()
        assert.equal(await page.locator('.preview-pane').count(), 4, 'layout survives a fresh component and storage load')

        await page.evaluate(() => { window.layout = { ...window.layout, orientation: 'h', ratios: [.65, .35], children: window.layout.children[0].children } })
        await page.getByRole('button', { name: 'Replace layout Servers with current tab', exact: true }).click()
        await page.getByText('This will replace the layout saved under this name.', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Save layout', exact: true }).click()
        await page.waitForFunction(() => document.querySelectorAll('.preview-pane').length === 2)
        assert.equal(await page.locator('.layout-card').count(), 1)

        await page.evaluate(() => { window.harness.keydowns = 0; window.addEventListener('keydown', () => window.harness.keydowns++) })
        await page.getByLabel('Search saved layouts').press('Home')
        assert.equal(await page.evaluate(() => window.harness.keydowns), 0, 'editor shortcuts must not reach terminal shortcut listeners')

        await page.getByRole('button', { name: 'Save current tab', exact: true }).click()
        await page.getByLabel('Layout name', { exact: true }).fill('Unsaved')
        await page.evaluate(() => { window.harness.config.failSave = true })
        await page.getByRole('button', { name: 'Save layout', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Test disk full' }).waitFor()
        assert.equal(await page.getByLabel('Layout name', { exact: true }).inputValue(), 'Unsaved')
        assert.equal(await page.evaluate(() => window.harness.service.savedLayouts.length), 1)
        await page.evaluate(() => { window.harness.config.failSave = false })
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()

        await page.getByRole('button', { name: 'Delete layout Servers', exact: true }).click()
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        assert.equal(await page.locator('.layout-card').count(), 1)
        await page.getByRole('button', { name: 'Delete layout Servers', exact: true }).click()
        await page.getByRole('button', { name: 'Delete layout', exact: true }).click()
        await page.locator('.layout-card').waitFor({ state: 'detached' })
        console.log('PASS: real Angular save/open/rename/search/reload/delete UI, split previews and failed-save preservation.')
        console.log('Artifacts: ' + output)
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); console.error('Artifacts: ' + output); process.exitCode = 1 })
