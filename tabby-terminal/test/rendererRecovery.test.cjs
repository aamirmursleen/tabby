'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { Subject, AsyncSubject, fromEvent, takeUntil, filter } = require('rxjs')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

// Model xterm's shared glyph atlas and per-pane vertex cache. Clearing the atlas
// alone leaves siblings pointing at old glyphs (xterm.js #6014). No shell or GPU
// is needed to verify the recovery ordering or that terminal state is preserved.
function harness () {
    const window = new EventTarget()
    const metrics = new Subject()
    const frames = []
    const instances = []
    const warnings = []
    let focused = true
    let failWebGL = false
    let nextAtlas
    class WebglAddon {
        constructor () { this.textureAtlas = nextAtlas; this.disposed = false }
        onContextLoss (callback) { this.loseContext = callback }
        dispose () { this.disposed = true }
        clearTextureAtlas () {
            assert.equal(this.disposed, false)
            this.textureAtlas.generation++
            this.textureAtlas.clears++
            this.pane.invalidated = true
        }
    }
    const { XTermFrontend } = loadDeclarations('tabby-terminal/src/frontends/xtermFrontend.ts', [
        'MAX_WEBGL_RECOVERY_ATTEMPTS', 'XTermFrontend',
    ], {
        Frontend: class { destroy () { this.destroyed.next(); this.destroyed.complete() } },
        WebglAddon, CanvasAddon: WebglAddon, Platform: { Web: 'web' },
        window, document: { hasFocus: () => focused }, fromEvent, takeUntil, filter,
        requestAnimationFrame: callback => { frames.push(callback); return frames.length },
        console: { warn: (...args) => warnings.push(args) },
    })
    window.ResizeObserver = class { observe () {} disconnect () {} }
    const flush = () => {
        for (let limit = 0; frames.length; limit++) {
            assert.ok(limit < 20, 'recovery must not create an animation loop')
            for (const callback of frames.splice(0)) callback()
        }
    }
    const atlas = () => ({ generation: 0, clears: 0 })
    async function pane (sharedAtlas = atlas(), webgl = true) {
        const host = new EventTarget()
        host.offsetParent = {}
        const state = {
            text: `Pane ${instances.length}: saved output ┌─┐`, rendered: '',
            cachedGeneration: sharedAtlas.generation, invalidated: false, refreshes: 0,
        }
        const buffer = { viewportY: 7, baseY: 40, type: 'normal' }
        let frontend
        let xterm
        const renderService = {
            _isPaused: false,
            _needsFullRefresh: false,
            _pausedResizeTask: {
                flush () { renderService._needsFullRefresh = false },
            },
            clear: () => { state.invalidated = true },
            handleResize: () => xterm.refresh(),
            refreshRows: () => {
                if (renderService._isPaused) {
                    renderService._needsFullRefresh = true
                    return
                }
                xterm.refresh()
            },
        }
        xterm = {
            rows: 24, cols: 80, buffer: { active: buffer },
            options: { cursorBlink: true },
            open () {}, dispose () {},
            loadAddon (addon) {
                if (addon instanceof WebglAddon) {
                    if (failWebGL && webgl) throw new Error('WebGL2 context unavailable')
                    addon.pane = state
                }
            },
            refresh () {
                state.refreshes++
                frames.push(() => {
                    if (frontend.disposed) return
                    if (state.invalidated) {
                        state.cachedGeneration = sharedAtlas.generation
                        state.invalidated = false
                    }
                    state.rendered = state.cachedGeneration === sharedAtlas.generation ? state.text : 'garbled glyphs'
                })
            },
            write () { assert.fail('render recovery must not write input or reset terminal contents') },
            getSelection: () => 'saved selection',
        }
        frontend = Object.assign(Object.create(XTermFrontend.prototype), {
            xterm, xtermCore: { _renderService: renderService },
            enableWebGL: webgl, opened: false, disposed: false,
            pendingRendererRecovery: false, rendererRecoveryAttempts: 0,
            pendingFlushes: new Set(), flowControl: {
                write (data) {
                    state.text += data
                    renderService.refreshRows()
                    return Promise.resolve()
                },
                dispose () {},
            },
            destroyed: new Subject(), ready: new AsyncSubject(),
            configService: { store: { terminal: { cursorBlink: true } } },
            hostApp: { platform: 'macos' }, platformService: { displayMetricsChanged$: metrics },
            hotkeysService: { hotkey$: new Subject() },
            search: { onDidChangeResults () {} },
            configureColors () {}, resizeHandler () {},
        })
        frontend.destroyed$ = frontend.destroyed
        nextAtlas = sharedAtlas
        await frontend.attach(host, {})
        flush()
        xterm.refresh()
        flush()
        const result = { frontend, host, state, buffer, atlas: sharedAtlas }
        instances.push(result)
        return result
    }
    return {
        pane, atlas, flush, metrics, warnings, instances,
        focus (value) { focused = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')) },
        failWebGL () { failWebGL = true },
        useAtlas (value) { nextAtlas = value },
        close () { for (const { frontend, host } of instances) { frontend.detach(host); frontend.destroy() }; flush() },
    }
}

test('visible panes recover even while another window has keyboard focus', async () => {
    const h = harness()
    try {
        const panes = []
        for (let i = 0; i < 4; i++) panes.push(await h.pane())
        h.focus(false)
        for (const pane of panes) {
            const old = pane.frontend.webGLAddon
            h.useAtlas(pane.atlas)
            old.loseContext()
            assert.notEqual(pane.frontend.webGLAddon, old)
            assert.ok(pane.frontend.webGLAddon, 'an unfocused window must recover its visible panes')
        }
        h.flush()
        for (const pane of panes) assert.equal(pane.state.rendered, pane.state.text)
    } finally { h.close() }
})

test('recovering one pane rebuilds every sibling sharing its glyph atlas', async () => {
    const h = harness()
    try {
        const atlas = h.atlas()
        const panes = []
        for (let i = 0; i < 4; i++) panes.push(await h.pane(atlas))
        h.useAtlas(atlas)
        panes[0].frontend.webGLAddon.loseContext()
        h.flush()
        for (const pane of panes) {
            pane.frontend.xterm.refresh()
            h.flush()
            assert.equal(pane.state.rendered, pane.state.text)
            assert.equal(pane.buffer.viewportY, 7)
            assert.equal(pane.frontend.getSelection(), 'saved selection')
        }
    } finally { h.close() }
})

test('returning to a window refreshes silently lost glyphs without needing a context-loss callback', async () => {
    const h = harness()
    try {
        const pane = await h.pane()
        h.focus(false)
        h.flush()
        pane.atlas.generation++
        pane.state.rendered = ''
        h.focus(true)
        h.flush()
        assert.equal(pane.state.rendered, pane.state.text)
    } finally { h.close() }
})

test('automatic WebGL context restoration refreshes the shared atlas even without addon recovery', async () => {
    const h = harness()
    try {
        const atlas = h.atlas()
        const first = await h.pane(atlas)
        const second = await h.pane(atlas)
        atlas.generation++
        first.state.rendered = second.state.rendered = ''
        first.host.dispatchEvent(new Event('webglcontextrestored'))
        h.flush()
        assert.equal(first.state.rendered, first.state.text)
        assert.equal(second.state.rendered, second.state.text)
    } finally { h.close() }
})

test('display events clear a shared atlas once and refresh all panes after clearing', async () => {
    const h = harness()
    try {
        const atlas = h.atlas()
        const panes = [await h.pane(atlas), await h.pane(atlas)]
        const clears = atlas.clears
        h.metrics.next()
        h.metrics.next()
        h.flush()
        assert.equal(atlas.clears - clears, 1)
        for (const pane of panes) assert.equal(pane.state.rendered, pane.state.text)
    } finally { h.close() }
})

test('queued refreshes do not access destroyed panes', async () => {
    const h = harness()
    const pane = await h.pane()
    h.focus(true)
    const clears = pane.atlas.clears
    h.close()
    assert.equal(pane.atlas.clears, clears)
    h.focus(true)
    h.metrics.next()
    h.flush()
    assert.equal(pane.atlas.clears, clears)
})

test('WebGL allocation failure during new pane startup leaves a usable fallback renderer', async () => {
    const h = harness()
    try {
        h.failWebGL()
        const pane = await h.pane()
        assert.equal(pane.frontend.webGLAddon, undefined)
        assert.equal(pane.state.rendered, pane.state.text)
        assert.equal(h.warnings.length, 1)
    } finally { h.close() }
})

test('a failed WebGL recovery does not throw or exceed its retry budget', async () => {
    const h = harness()
    try {
        const pane = await h.pane()
        h.failWebGL()
        assert.doesNotThrow(() => pane.frontend.webGLAddon.loseContext())
        for (let i = 0; i < 8; i++) h.focus(true)
        h.flush()
        assert.ok(pane.frontend.rendererRecoveryAttempts <= 3)
        assert.equal(pane.state.rendered, pane.state.text)
    } finally { h.close() }
})

test('a hidden pane pauses cursor animation and is excluded from compositor refreshes', async () => {
    const h = harness()
    try {
        const pane = await h.pane()
        const oldWebGLAddon = pane.frontend.webGLAddon
        pane.frontend.deactivate()

        assert.equal(pane.frontend.xterm.options.cursorBlink, false)
        assert.equal(pane.frontend.xtermCore._renderService._isPaused, true)
        assert.equal(pane.frontend.webGLAddon, undefined)
        assert.equal(oldWebGLAddon.disposed, true)
        await pane.frontend.write(' + hidden output')
        const refreshes = pane.state.refreshes
        h.metrics.next()
        h.flush()

        assert.equal(pane.state.refreshes, refreshes)
        assert.equal(pane.state.text, 'Pane 0: saved output ┌─┐ + hidden output')
        assert.equal(pane.frontend.getSelection(), 'saved selection')
    } finally { h.close() }
})

test('reactivating a hidden pane restores its cursor and redraws preserved output once', async () => {
    const h = harness()
    try {
        const pane = await h.pane()
        pane.frontend.deactivate()
        const refreshes = pane.state.refreshes

        pane.frontend.reactivate()
        h.flush()

        assert.equal(pane.frontend.xterm.options.cursorBlink, true)
        assert.equal(pane.frontend.xtermCore._renderService._isPaused, false)
        assert.ok(pane.frontend.webGLAddon)
        assert.ok(pane.state.refreshes > refreshes)
        assert.equal(pane.state.rendered, pane.state.text)
    } finally { h.close() }
})
