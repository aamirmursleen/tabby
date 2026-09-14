'use strict'
// Standalone xterm rendering integration test: no Electron app, SSH connection,
// shell, user profile or installed terminal is opened or controlled.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')
const { chromium } = require(process.env.TABBY_PLAYWRIGHT_PATH || 'playwright')
const root = path.resolve(__dirname, '../..')
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'aamir-renderer-test-'))
const baseline = process.argv.includes('--baseline')

function declarations (file, names) {
    const content = baseline && file.endsWith('xtermFrontend.ts')
        ? execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })
        : fs.readFileSync(path.join(root, file), 'utf8')
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
    const selected = source.statements.filter(node => names.includes(node.name?.text)
        || node.declarationList?.declarations.some(declaration => names.includes(declaration.name.text)))
    assert.equal(selected.length, names.length)
    return ts.transpileModule(selected.map(node => node.getText(source)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS },
    }).outputText
}

const source = `(() => {
    const exports = {};
    const { Subject, AsyncSubject, ReplaySubject, BehaviorSubject, firstValueFrom, filter, fromEvent, takeUntil } = rxjs;
    const { FitAddon } = window.FitAddon;
    const { SearchAddon } = window.SearchAddon;
    const { SerializeAddon } = window.SerializeAddon;
    const { Unicode11Addon } = window.Unicode11Addon;
    const { WebglAddon } = window.WebglAddon;
    const { CanvasAddon } = window.CanvasAddon;
    const process = { platform: 'darwin' };
    const Platform = { Web: 'web', macOS: 'macos' };
    const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const getXtermBackgroundColor = (_config, _themes, scheme) => scheme.background;
    class ConfigService {} class HotkeysService {} class PlatformService {} class HostAppService {} class ThemesService {}
    ${declarations('tabby-terminal/src/frontends/frontend.ts', ['Frontend'])}
    ${declarations('tabby-terminal/src/frontends/xtermFrontend.ts', ['COLOR_NAMES', 'MAX_WEBGL_RECOVERY_ATTEMPTS', 'FlowControl', 'XTermFrontend'])}
    window.panes = [];
    window.openPane = async index => {
        const services = new Map([
            [ConfigService, { store: { terminal: { sixel: false } } }],
            [HotkeysService, { hotkey$: new Subject() }],
            [PlatformService, { displayMetricsChanged$: new Subject() }],
            [HostAppService, { platform: Platform.macOS }],
            [ThemesService, { _getActiveColorScheme: () => ({
                foreground: '#dddddd', background: '#111111', cursor: '#ffffff', cursorAccent: '#000000',
                colors: Array(16).fill('#777777'),
            }) }],
        ]);
        const frontend = new XTermFrontend({ get: token => services.get(token) });
        frontend.enableWebGL = true;
        frontend.xterm.options.fontSize = 14;
        frontend.xterm.options.fontFamily = 'monospace';
        frontend.xterm.options.cursorBlink = false;
        await frontend.attach(document.getElementById('pane-' + index), {});
        if (!frontend.webGLAddon) throw new Error('A real WebGL renderer is required for this test');
        await new Promise(resolve => frontend.xterm.write('Pane ' + index + ' saved output ABC 0123456789\\r\\nUnicode: ┌──┐ café 日本語\\r\\nReady\\r\\n', resolve));
        panes.push(frontend);
    };
    window.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.captureGlyphs = () => panes.map(frontend => {
        const renderer = frontend.xtermCore._renderService._renderer.value;
        renderer.renderRows(0, frontend.xterm.rows - 1);
        const gl = renderer._gl;
        const width = gl.drawingBufferWidth;
        const height = 36 * devicePixelRatio;
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, gl.drawingBufferHeight - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let hash = 2166136261;
        let textPixels = 0;
        for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 60) textPixels++;
        return { hash, textPixels, cols: frontend.xterm.cols, rows: frontend.xterm.rows };
    });
})();`

async function setup (context) {
    const page = await context.newPage()
    await page.setContent('<style>body{margin:0;background:#111}.grid{display:grid;grid-template-columns:1fr 1fr;height:600px}.pane{height:300px;min-width:0}</style><div class="grid">'
        + Array.from({ length: 4 }, (_, i) => `<div class="pane" id="pane-${i}"></div>`).join('') + '</div>')
    await page.addStyleTag({ path: path.join(root, 'tabby-terminal/node_modules/@xterm/xterm/css/xterm.css') })
    await page.addScriptTag({ path: path.join(root, 'node_modules/rxjs/dist/bundles/rxjs.umd.js') })
    for (const name of ['xterm', 'addon-fit', 'addon-search', 'addon-serialize', 'addon-unicode11', 'addon-webgl', 'addon-canvas']) {
        await page.addScriptTag({ path: path.join(root, `tabby-terminal/node_modules/@xterm/${name}/lib/${name}.js`) })
    }
    await page.addScriptTag({ content: source })
    for (let i = 0; i < 4; i++) await page.evaluate(index => window.openPane(index), i)
    await page.evaluate(() => window.settle())
    return page
}

async function main () {
    const browser = await chromium.launch({ headless: true })
    try {
        const context = await browser.newContext({ viewport: { width: 1000, height: 600 } })
        const original = await setup(context)
        const before = await original.evaluate(() => window.captureGlyphs())
        assert.ok(before.every(pane => pane.textPixels > 100), 'all four panes must contain visible glyph pixels')
        await original.screenshot({ path: path.join(artifacts, 'before.png') })

        const extra = await setup(context)
        await extra.bringToFront()
        // Headless tabs can remain focused according to Chromium. Simulate the
        // OS focus handoff explicitly, then lose a real WebGL context.
        await original.evaluate(() => {
            Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
            window.dispatchEvent(new Event('blur'))
            window.oldAddon = panes[0].webGLAddon
            panes[0].xtermCore._renderService._renderer.value._gl.getExtension('WEBGL_lose_context').loseContext()
        })
        await original.waitForFunction(() => panes[0].webGLAddon && panes[0].webGLAddon !== window.oldAddon, null, { timeout: 8000 })
        await original.evaluate(() => window.settle())
        assert.deepEqual(await original.evaluate(() => window.captureGlyphs()), before, 'a context loss must preserve every original pane while another window has focus')

        // Exercise xterm's own fast restore path, which does not emit the
        // addon's delayed onContextLoss event.
        await original.evaluate(async () => {
            const gl = panes[0].xtermCore._renderService._renderer.value._gl
            const extension = gl.getExtension('WEBGL_lose_context')
            await new Promise(resolve => {
                gl.canvas.addEventListener('webglcontextlost', resolve, { once: true })
                extension.loseContext()
            })
            await new Promise(resolve => setTimeout(resolve, 100))
            await new Promise(resolve => {
                gl.canvas.addEventListener('webglcontextrestored', resolve, { once: true })
                extension.restoreContext()
            })
            await window.settle()
        })
        assert.deepEqual(await original.evaluate(() => window.captureGlyphs()), before, 'fast native restoration must repaint all shared-atlas owners')

        // Model an atlas bitmap discarded without a WebGL context-loss event.
        await original.evaluate(async () => {
            const atlas = panes[0].webGLAddon.textureAtlas
            atlas.getContext('2d').clearRect(0, 0, atlas.width, atlas.height)
            Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
            window.dispatchEvent(new Event('focus'))
            await window.settle()
        })
        assert.deepEqual(await original.evaluate(() => window.captureGlyphs()), before, 'focus must repair silently discarded glyphs')
        await original.screenshot({ path: path.join(artifacts, 'after.png') })
        console.log('PASS: actual xterm/WebGL pixels match in all four panes after background recovery, fast context restoration and silent atlas loss.')
        console.log('Artifacts: ' + artifacts)
    } finally { await browser.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
