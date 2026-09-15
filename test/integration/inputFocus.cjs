'use strict'
// Real xterm input, AppService activation and ng-bootstrap password modal.
// Isolated synthetic sessions only; no Electron app, SSH, shell or user profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')
const pug = require('pug')
const webpack = require('webpack')
const { chromium } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const root = path.resolve(__dirname, '../..')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'aamir-input-focus-test-'))
const baseline = process.argv.includes('--baseline')

function declarations (file, names) {
    const content = baseline && file.endsWith('xtermFrontend.ts')
        ? execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })
        : fs.readFileSync(path.join(root, file), 'utf8')
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const selected = source.statements.filter(node => names.includes(node.name?.text)
        || node.declarationList?.declarations.some(declaration => names.includes(declaration.name.text)))
    assert.equal(selected.length, names.length)
    return ts.transpileModule(selected.map(node => node.getText(source)).join('\n').replace(/@Component\(\{[\s\S]*?\}\)/, ''), {
        compilerOptions: { target: ts.ScriptTarget.ES2016, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
    }).outputText
}

const entry = `
import 'zone.js';
import '@angular/compiler';
import { Component, NgModule, NgZone, Injectable, Inject, Input, ViewChild, ElementRef, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { NgbModal, NgbActiveModal, NgbModalModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, AsyncSubject, ReplaySubject, BehaviorSubject, Observable, firstValueFrom, filter, fromEvent, takeUntil, debounceTime } from 'rxjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
const exports = {};
const process = {platform:'darwin'};
const Platform = {Web:'web',macOS:'macos'};
const BOOTSTRAP_DATA = Symbol('bootstrap');
const Buffer = {from: data => new TextEncoder().encode(data)};
const deepEqual = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const getXtermBackgroundColor = (_config,_themes,scheme) => scheme.background;
class ConfigService {} class HotkeysService {} class PlatformService {} class HostAppService {} class ThemesService {}
${declarations('tabby-terminal/src/frontends/frontend.ts', ['Frontend'])}
${declarations('tabby-terminal/src/frontends/xtermFrontend.ts', ['COLOR_NAMES', 'MAX_WEBGL_RECOVERY_ATTEMPTS', 'FlowControl', 'XTermFrontend'])}
${declarations('tabby-core/src/services/app.service.ts', ['AppService'])}
${declarations('tabby-core/src/components/promptModal.component.ts', ['PromptModalComponent'])}
PromptModalComponent.ctorParameters = () => [{type:NgbActiveModal}];
Component({template:${JSON.stringify(pug.renderFile(path.join(root, 'tabby-core/src/components/promptModal.component.pug'), { doctype: 'html' }))}})(PromptModalComponent);
class HarnessApp {
    constructor(modal,zone) { this.modal = modal; this.zone = zone; this.panes = []; this.received = ['', '', '', '']; this.active = 0; }
    ngAfterViewInit() { setTimeout(async () => {
        const config = {ready$:new Subject(),store:{terminal:{sixel:false},appearance:{}}};
        const services = new Map([
            [ConfigService,config],
            [HotkeysService,{hotkey$:new Subject(),pushKeyEvent(){},matchActiveHotkey(){return null}}],
            [PlatformService,{displayMetricsChanged$:new Subject()}],
            [HostAppService,{platform:Platform.macOS}],
            [ThemesService,{_getActiveColorScheme:()=>({foreground:'#dddddd',background:'#15171c',cursor:'#ffffff',cursorAccent:'#000000',colors:Array(16).fill('#777777')})}],
        ]);
        for(let i=0;i<4;i++) {
            const pane = new XTermFrontend({get:token=>services.get(token)});
            pane.xterm.options.fontFamily = 'monospace'; pane.xterm.options.fontSize = 14;
            await pane.attach(document.getElementById('pane-'+i),{});
            pane.input$.subscribe(data => this.received[i] += new TextDecoder().decode(data));
            await pane.write('Pane '+(i+1)+' — synthetic session\\r\\nReady > ');
            this.panes.push(pane);
        }
        this.focused = new Subject();
        this.app = new AppService(config,{}, {windowFocused$:this.focused}, {saveTabs:async()=>{}}, {}, {}, this.modal, {}, {}, {});
        this.app._activeTab = {emitFocused:()=>this.select(this.active)};
        this.select(0);
        window.harness = this;
    }); }
    select(index) { this.active=index; this.panes.forEach((pane,i)=>pane.enableResizing=i===index); this.panes[index].focus(); }
    openPrompt() {
        this.zone.run(()=>{
            this.prompt = this.modal.open(PromptModalComponent,{animation:false});
            Object.assign(this.prompt.componentInstance,{password:true,prompt:'Private key passphrase',value:'',showRememberCheckbox:false});
            this.prompt.result.then(result=>this.promptResult=result);
        });
    }
}
HarnessApp.ctorParameters = () => [{type:NgbModal},{type:NgZone}];
Component({selector:'test-app',template:'<aside><span>Aamir Terminal · input regression</span><input aria-label="Snippet search" placeholder="Search snippets"></aside><main><section *ngFor="let index of [0,1,2,3]"><button (click)="select(index)">Select pane {{index+1}}</button><div class="terminal" id="pane-{{index}}"></div></section></main>',
    styles:[':host{height:100vh;display:flex;flex-direction:column}aside{display:flex;align-items:center;justify-content:space-between;padding:16px}main{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}section{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #3c444e}.terminal{flex:1;min-height:0;padding:10px}']})(HarnessApp);
class HarnessModule {}
NgModule({imports:[BrowserModule,FormsModule,NgbModalModule],declarations:[HarnessApp,PromptModalComponent],schemas:[CUSTOM_ELEMENTS_SCHEMA],bootstrap:[HarnessApp]})(HarnessModule);
platformBrowserDynamic().bootstrapModule(HarnessModule).catch(error=>window.bootError=String(error));
`
fs.writeFileSync(path.join(output, 'entry.js'), entry)

async function main () {
    await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false, context: root, entry: path.join(output, 'entry.js'),
        resolve: { modules: ['node_modules', path.join(root, 'node_modules'), path.join(root, 'tabby-core/node_modules'), path.join(root, 'tabby-terminal/node_modules')] },
        output: { path: output, filename: 'bundle.js' },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
    const server = http.createServer((request, response) => {
        if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(output, 'bundle.js'))) }
        else if (request.url === '/xterm.css') { response.setHeader('Content-Type', 'text/css'); response.end(fs.readFileSync(path.join(root, 'tabby-terminal/node_modules/@xterm/xterm/css/xterm.css'))) }
        else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;background:#15171c;color:#eee;font-family:Arial}*{box-sizing:border-box}input,button{padding:8px;background:#272e38;color:#eee;border:1px solid #515b69}.modal{display:block;position:fixed;inset:0;z-index:10;background:#0008}.modal-dialog{margin:120px auto;width:360px}.modal-content{padding:20px;background:#252d39}.modal-body{display:flex;gap:12px}</style></head><body><test-app></test-app><script src="/bundle.js"></script></body></html>')
        }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = await chromium.launch({ headless: true })
    try {
        const context = await browser.newContext({ viewport: { width: 1100, height: 740 } })
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(String(error)))
        await page.goto(`http://127.0.0.1:${server.address().port}`)
        await page.waitForFunction(() => window.harness || window.bootError)
        assert.equal(await page.evaluate(() => window.bootError), undefined)
        const settle = () => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
        const received = () => page.evaluate(() => window.harness.received)

        await page.getByRole('button', { name: 'Select pane 2', exact: true }).click()
        await settle()
        await page.keyboard.type('before')
        assert.deepEqual(await received(), ['', 'before', '', ''])
        const extra = await context.newPage()
        await extra.setContent('<input autofocus aria-label="Other window">')
        await extra.bringToFront()
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        await page.bringToFront()
        await page.evaluate(() => window.harness.focused.next())
        await settle()
        await page.keyboard.type('after')
        assert.deepEqual(await received(), ['', 'beforeafter', '', ''])

        const search = page.getByRole('textbox', { name: 'Snippet search' })
        await search.fill('saved')
        await page.evaluate(() => window.harness.focused.next())
        await settle()
        await page.keyboard.type('-search')
        assert.equal(await search.inputValue(), 'saved-search', 'window activation must preserve the editor')
        assert.deepEqual(await received(), ['', 'beforeafter', '', ''])

        await page.getByRole('button', { name: 'Select pane 2', exact: true }).click()
        await settle()
        await page.evaluate(() => window.harness.openPrompt())
        const password = page.getByPlaceholder('Private key passphrase', { exact: true })
        await password.waitFor()
        await password.fill('synthetic-')
        await page.evaluate(() => window.harness.focused.next())
        await settle()
        assert.equal(await password.evaluate(element => element === document.activeElement), true)
        await page.keyboard.type('passphrase')
        assert.equal(await password.inputValue(), 'synthetic-passphrase')
        assert.deepEqual(await received(), ['', 'beforeafter', '', ''], 'password keystrokes must never reach any terminal')
        await page.screenshot({ path: path.join(output, 'password-focus.png') })
        await page.getByRole('button', { name: 'OK', exact: true }).click()
        await page.waitForFunction(() => !document.querySelector('ngb-modal-window'))
        await page.evaluate(() => window.harness.focused.next())
        await settle()
        await page.keyboard.type('-resumed')
        assert.deepEqual(await received(), ['', 'beforeafter-resumed', '', ''])

        // A queued focus request must be discarded when the pane loses focus.
        await page.evaluate(() => { window.harness.panes[1].focus(); window.harness.select(3) })
        await settle()
        await page.keyboard.type('fourth')
        assert.deepEqual(await received(), ['', 'beforeafter-resumed', '', 'fourth'])
        assert.deepEqual(errors, [])
        await page.screenshot({ path: path.join(output, 'restored-input.png') })
        console.log('PASS: real xterm input survives window handoff; editors and password dialogs keep focus; input resumes in the selected pane.')
        console.log('Artifacts: ' + output)
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
