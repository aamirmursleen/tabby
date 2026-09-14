'use strict'
// Real Angular pane headers/split engine and xterm keyboard/resize handling.
// Synthetic terminals only: no Electron app, shell, SSH or user profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const ts = require('typescript')
const sass = require('sass')
const webpack = require('webpack')
const { chromium } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const root = path.resolve(__dirname, '../..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aamir-pane-maximize-test-'))
const components = 'tabby-core/src/components/'

function declarations (file, names) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const selected = source.statements.filter(node => names.includes(node.name?.text))
    assert.equal(selected.length, names.length)
    return ts.transpileModule(selected.map(node => node.getText(source)).join('\n').replace(/@Component\(\{[\s\S]*?\}\)/, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
}
function metadata (file) {
    const source = fs.readFileSync(path.join(root, components + file + '.ts'), 'utf8')
    const template = source.match(/template: `([\s\S]*?)`,/)[1]
    const styles = [sass.compile(path.join(root, components + file + '.scss')).css]
    return { template, styles }
}
const iconsCSS = require.resolve('@fortawesome/fontawesome-free/css/all.min.css')
const iconsFonts = path.resolve(path.dirname(iconsCSS), '../webfonts')
const fontFiles = new Set(fs.readdirSync(iconsFonts))
const entry = `
import 'zone.js';
import '@angular/compiler';
import { ApplicationRef, Component, NgModule, Input, ViewChild, ViewContainerRef, Injector, ElementRef, Injectable, ComponentFactoryResolver, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { Subject, BehaviorSubject, distinctUntilChanged, filter, debounceTime, fromEvent, takeWhile } from 'rxjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
const exports = {};
class ConfigService {} class AppService {} class HotkeysService {} class TabRecoveryService {}
const getOpenTabLabel = tab => tab.customTitle || tab.title;
${declarations(components + 'base.component.ts', ['SubscriptionContainer', 'BaseComponent'])}
${declarations(components + 'baseTab.component.ts', ['BaseTabComponent'])}
${declarations('tabby-core/src/services/tabs.service.ts', ['TabsService'])}
${declarations(components + 'splitTab.component.ts', ['SplitContainer', 'SplitTabComponent'])}
${declarations(components + 'terminalPaneHeader.component.ts', ['TerminalPaneHeaderComponent'])}
SplitTabComponent.ctorParameters = () => [{type: HotkeysService}, {type: TabsService}, {type: TabRecoveryService}, {type: Injector}];
Component({selector: 'split-tab', ...${JSON.stringify(metadata('splitTab.component'))}})(SplitTabComponent);
TerminalPaneHeaderComponent.ctorParameters = () => [{type: AppService}];
Component({selector: 'terminal-pane-header', ...${JSON.stringify(metadata('terminalPaneHeader.component'))}})(TerminalPaneHeaderComponent);
class TestPane extends BaseTabComponent {
    constructor(injector, element) { super(injector); this.element = element.nativeElement; this.input = []; this.searchOpen = false; }
    ngAfterViewInit() {
        this.terminal = new Terminal({fontFamily: 'monospace', fontSize: 14, cursorBlink: false, theme: {background:'#15171c', foreground:'#e1e6ed'}});
        const fit = new FitAddon(); this.terminal.loadAddon(fit);
        this.terminal.open(this.element.querySelector('.terminal'));
        this.terminal.onData(data => this.input.push(data));
        this.observer = new ResizeObserver(() => fit.fit()); this.observer.observe(this.element.querySelector('.terminal'));
        this.subscribeUntilDestroyed(this.focused$, () => this.terminal.focus());
        this.terminal.write(this.title + ' terminal — saved output\\r\\nSame session, same layout.\\r\\nReady > ');
        if(this.hasFocus) this.terminal.focus();
    }
    ngOnDestroy() { this.observer?.disconnect(); this.terminal?.dispose(); super.ngOnDestroy(); }
}
TestPane.ctorParameters = () => [{type: Injector}, {type: ElementRef}];
Component({selector: 'test-pane', template: '<terminal-pane-header [tab]="this"></terminal-pane-header><input *ngIf="searchOpen" aria-label="Find in terminal" (keydown.escape)="searchOpen = false; $event.stopPropagation()"><div class="terminal"></div>',
    styles: [':host{display:flex;flex-direction:column;min-width:0;min-height:0;background:#15171c;border:1px solid #363c46;overflow:hidden}.terminal{flex:1;min-height:0;overflow:hidden;padding:12px}']})(TestPane);
class HarnessApp {
    constructor(tabs) { this.tabs = tabs; }
    ngAfterViewInit() { setTimeout(() => {
        const panes = ['API', 'Logs', 'Local', 'Database'].map(title => this.tabs.create({type: TestPane, inputs:{title, parent:this.split}}));
        const row = (children, ratios) => Object.assign(new SplitContainer(), {children, ratios});
        this.split.root = Object.assign(new SplitContainer(), {orientation:'v', ratios:[.4,.6], children:[row(panes.slice(0,2),[.3,.7]),row(panes.slice(2),[.55,.45])]});
        for(const pane of panes) this.split.attachTabView(pane);
        this.split.focus(panes[0]); this.split.hasFocus = true;
        window.harness = {panes, split:this.split, app:this};
    }); }
}
HarnessApp.ctorParameters = () => [{type: TabsService}];
ViewChild(SplitTabComponent)(HarnessApp.prototype, 'split');
Component({selector:'test-app', template:'<aside><span>Aamir Terminal · pane preview</span><input aria-label="Snippet search" placeholder="Search snippets"></aside><split-tab></split-tab>',
    styles:[':host{height:100vh;display:flex;flex-direction:column}aside{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;background:#0e1014;color:#8f9bab;font-size:12px}aside input{background:#202630;color:#eee;border:1px solid #394355;border-radius:4px;padding:4px}split-tab{min-height:0}']})(HarnessApp);
class HarnessModule {}
NgModule({imports:[BrowserModule,FormsModule],declarations:[HarnessApp,TestPane,SplitTabComponent,TerminalPaneHeaderComponent],schemas:[CUSTOM_ELEMENTS_SCHEMA],
    providers:[{provide:ConfigService,useValue:{store:{terminal:{focusFollowsMouse:false}}}}, {provide:AppService,useValue:{emitTabsChanged(){}}},
        {provide:HotkeysService,useValue:{hotkey$:new Subject()}}, {provide:TabRecoveryService,useValue:{}},
        {provide:TabsService,useFactory:(resolver,injector,recovery)=>new TabsService(resolver,injector,recovery),deps:[ComponentFactoryResolver,Injector,TabRecoveryService]}],bootstrap:[HarnessApp]})(HarnessModule);
platformBrowserDynamic().bootstrapModule(HarnessModule).catch(error => { window.bootError = String(error); });
`
fs.writeFileSync(path.join(output, 'entry.js'), entry)

async function main () {
    await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false, context: root, entry: path.join(output, 'entry.js'),
        resolve: { modules: ['node_modules', path.join(root, 'node_modules'), path.join(root, 'tabby-core/node_modules'), path.join(root, 'tabby-terminal/node_modules')] },
        output: { path: output, filename: 'bundle.js' },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
    const server = http.createServer((request, response) => {
        const fontName = request.url.startsWith('/webfonts/') ? request.url.slice('/webfonts/'.length) : ''
        if (fontFiles.has(fontName)) response.end(fs.readFileSync(path.join(iconsFonts, fontName)))
        else if (request.url === '/icons.css') { response.setHeader('Content-Type', 'text/css'); response.end(fs.readFileSync(iconsCSS)) }
        else if (request.url === '/xterm.css') { response.setHeader('Content-Type', 'text/css'); response.end(fs.readFileSync(path.join(root, 'tabby-terminal/node_modules/@xterm/xterm/css/xterm.css'))) }
        else if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(output, 'bundle.js'))) }
        else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/icons.css"><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;background:#111;color:#dce2ea;font-family:Arial,sans-serif;--theme-bg-more-2:#1b1e25;--theme-bg-more:#252c37;--theme-primary:#6ab5ed}*{box-sizing:border-box}</style></head><body><test-app></test-app><script src="/bundle.js"></script></body></html>')
        }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        page.on('console', msg => { if(msg.type() === 'error') errors.push(msg.text()) })
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.waitForFunction(() => window.harness?.panes.every(pane => pane.terminal?.cols > 0) || window.bootError)
        assert.equal(await page.evaluate(() => window.bootError), undefined)
        assert.deepEqual(errors, [])
        const panes = page.locator('test-pane')
        await page.getByRole('button', { name: 'Expand pane', exact: true }).first().waitFor()
        const geometry = () => panes.evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height].map(Math.round)
        }))
        const settled = () => page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'))
        await settled()
        const before = await geometry()
        const input = () => page.evaluate(() => window.harness.panes.map(pane => pane.input.join('')))
        const rows = await page.evaluate(() => window.harness.panes.map(pane => [pane.terminal.cols,pane.terminal.rows]))
        await page.screenshot({ path: path.join(output, 'before.png') })
        for (let index = 0; index < 4; index++) {
            await panes.nth(index).getByRole('button', { name: 'Expand pane', exact: true }).click()
            await settled()
            const full = await page.locator('split-tab').boundingBox()
            const rect = await panes.nth(index).boundingBox()
            assert.deepEqual(rect, full, 'expanded pane fills the whole terminal area')
            assert.equal(await page.locator('test-pane:visible').count(), 1)
            assert.equal(await panes.nth(index).getByRole('button', { name: 'Restore split layout', exact: true }).getAttribute('aria-pressed'), 'true')
            assert.equal(await panes.nth(index).locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement), true)
            if (index === 2) await page.screenshot({ path: path.join(output, 'expanded.png') })
            await page.keyboard.down('Escape')
            await page.keyboard.down('Escape')
            await page.keyboard.up('Escape')
            await settled()
            assert.deepEqual(await geometry(), before)
            assert.deepEqual(await input(), ['', '', '', ''], 'restoring Escape never reaches a terminal, including repeat and keyup')
        }
        await page.waitForFunction(expected => window.harness.panes.every((pane,i) => pane.terminal.cols === expected[i][0] && pane.terminal.rows === expected[i][1]), rows)
        await page.keyboard.press('Escape')
        assert.deepEqual(await input(), ['', '', '', '\u001b'], 'normal Escape is available after restoring')
        await page.screenshot({ path: path.join(output, 'restored.png') })

        await panes.nth(1).getByRole('button', { name: 'Expand pane', exact: true }).click()
        await panes.nth(1).getByRole('button', { name: 'Rename pane', exact: true }).click()
        await page.getByLabel('Pane name', { exact: true }).fill('Cancelled rename')
        await page.getByLabel('Pane name', { exact: true }).press('Escape')
        assert.equal(await page.getByLabel('Pane name', { exact: true }).count(), 0)
        assert.equal(await page.evaluate(() => window.harness.panes[1].customTitle || window.harness.panes[1].title), 'Logs')
        assert.equal(await page.locator('test-pane:visible').count(), 1, 'rename Escape does not restore the layout')
        await page.getByLabel('Snippet search').press('Escape')
        assert.equal(await page.locator('test-pane:visible').count(), 1, 'sidebar Escape does not affect terminal panes')
        await panes.nth(1).getByRole('button', { name: 'Restore split layout', exact: true }).click()
        await settled()
        assert.deepEqual(await geometry(), before)

        await panes.nth(0).getByRole('button', { name: 'Expand pane', exact: true }).click()
        await page.setViewportSize({ width: 1024, height: 720 })
        await page.keyboard.press('Escape')
        await settled()
        const relative = await panes.evaluateAll(elements => {
            const container = document.querySelector('split-tab').getBoundingClientRect()
            return elements.map(element => { const rect = element.getBoundingClientRect(); return [(rect.x-container.x)/container.width,(rect.y-container.y)/container.height,rect.width/container.width,rect.height/container.height].map(value => Math.round(value*100)) })
        })
        assert.deepEqual(relative, [[0,0,30,40],[30,0,70,40],[0,40,55,60],[55,40,45,60]], 'window resize keeps the original split proportions')
        assert.equal(await page.evaluate(() => window.harness.panes.every(pane => pane.terminal.buffer.active.getLine(0).translateToString().startsWith(pane.title))), true, 'terminal output remains in the same sessions')
        assert.deepEqual(errors, [])
        console.log('PASS: real Angular buttons, four unequal panes, Escape capture/repeat, xterm resize/input, rename isolation and restore after window resize.')
        console.log('Artifacts: ' + output)
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); console.error('Artifacts: ' + output); process.exitCode = 1 })
