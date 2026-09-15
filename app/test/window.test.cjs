'use strict'
// Exercise the real window lifecycle with native APIs replaced by event emitters.
// No installed app, user profile, shell or credentials are opened.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const test = require('node:test')
const { Subject, Observable, debounceTime } = require('rxjs')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

function setup () {
    const ipcMain = new EventEmitter()
    const autoUpdater = new EventEmitter()
    const windows = []
    const actions = []
    class BrowserWindow extends EventEmitter {
        constructor () {
            super()
            this.id = windows.length
            this.destroyed = false
            this.focused = false
            this.contentFocused = false
            this.devToolsFocused = false
            this.enabled = true
            this.fullScreenable = true
            this.webContents = Object.assign(new EventEmitter(), {
                send: (event, ...args) => actions.push([this.id, event, ...args]),
                session: { setPermissionCheckHandler () {}, setDevicePermissionHandler () {}, setSpellCheckerEnabled () {} },
                setVisualZoomLevelLimits () {}, setZoomFactor () {}, setWindowOpenHandler () {},
                isDestroyed: () => this.destroyed,
                isFocused: () => this.contentFocused,
                isDevToolsFocused: () => this.devToolsFocused,
                focus: () => { this.contentFocused = true; actions.push([this.id, 'content-focus']) },
            })
            windows.push(this)
        }
        static getFocusedWindow () { return windows.find(window => window.focused) }
        loadFile () {}
        setTouchBar () {}
        setVibrancy () {}
        show () { actions.push([this.id, 'show']) }
        moveTop () { actions.push([this.id, 'move-top']) }
        focus () { this.focused = true; actions.push([this.id, 'focus']); this.emit('focus') }
        isFocused () { return this.focused }
        isDestroyed () { return this.destroyed }
        isEnabled () { return this.enabled }
        isAlwaysOnTop () { return false }
        isVisibleOnAllWorkspaces () { return false }
        setWindowButtonPosition (position) { actions.push([this.id, 'buttons', position.x, position.y]) }
        setOpacity (value) { actions.push([this.id, 'opacity', value]) }
        destroy () { this.destroyed = true; this.emit('closed') }
    }
    class TouchBar { static TouchBarSegmentedControl = class {} }
    const { Window } = loadDeclarations('app/lib/window.ts', ['Window'], {
        Subject, Observable, debounceTime, BrowserWindow, TouchBar, ipcMain, autoUpdater, path,
        process: { platform: 'darwin' }, __dirname: '/test', macOSVibrancyType: 'fullscreen-ui',
        ElectronConfig: class { get () {} set () {} }, nativeTheme: {}, enableRemote () {},
        app: { getAppPath: () => '/test', getPath: () => '/test/executable' },
    })
    const instances = []
    const application = { focus: () => { for (const window of instances) window.present() } }
    const create = options => {
        const instance = new Window(application, { hacks: { disableVibrancyWhileDragging: true } }, options)
        instances.push(instance)
        return { instance, native: windows.at(-1) }
    }
    return { ipcMain, autoUpdater, actions, create }
}

test('a second window changes only its own opacity, controls and drag settings', () => {
    const { create, ipcMain, actions } = setup()
    const first = create()
    const second = create()
    ipcMain.emit('window-set-opacity', { sender: second.native.webContents }, 0.8)
    ipcMain.emit('window-set-traffic-light-position', { sender: second.native.webContents }, 12, 16)
    ipcMain.emit('window-set-disable-vibrancy-while-dragging', { sender: second.native.webContents }, true)
    assert.deepEqual(actions, [[1, 'opacity', 0.8], [1, 'buttons', 12, 16]])
    assert.equal(first.instance.disableVibrancyWhileDragging, false)
    assert.equal(second.instance.disableVibrancyWhileDragging, true)
})

test('closing a window removes its IPC and updater listeners, even before app readiness', () => {
    const { create, ipcMain, autoUpdater, actions } = setup()
    const first = create()
    const second = create()
    first.native.destroy()
    assert.doesNotThrow(() => {
        ipcMain.emit('app:ready', { sender: second.native.webContents })
        ipcMain.emit('window-set-opacity', { sender: second.native.webContents }, 1)
        ipcMain.emit('window-set-traffic-light-position', { sender: second.native.webContents }, 4, 8)
    })
    assert.deepEqual(actions, [[1, 'opacity', 1], [1, 'buttons', 4, 8]])
    for (const name of ipcMain.eventNames()) assert.equal(ipcMain.listenerCount(name), 1, name)
    for (const name of autoUpdater.eventNames()) assert.equal(autoUpdater.listenerCount(name), 1, name)
    second.native.destroy()
    assert.equal(ipcMain.eventNames().length, 0)
    assert.equal(autoUpdater.eventNames().length, 0)
})

test('loading a new window does not refocus or raise existing windows', async () => {
    const { create, actions } = setup()
    create()
    const second = create()
    second.native.webContents.emit('did-finish-load')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(actions.some(([id, action]) => id === 1 && action === 'focus'))
    assert.equal(actions.some(([id]) => id === 0), false)
})

test('native activation restores page keyboard focus before notifying the renderer', () => {
    const { create, actions } = setup()
    const { native } = create()
    native.focus()
    assert.deepEqual(actions, [[0, 'focus'], [0, 'content-focus'], [0, 'host:window-focused']])
})

test('activation preserves DevTools focus and does not focus a disabled modal parent', () => {
    const { create, actions } = setup()
    const { native } = create()
    native.devToolsFocused = true
    native.focus()
    native.devToolsFocused = false
    native.enabled = false
    native.focus()
    assert.equal(actions.some(([, action]) => action === 'content-focus'), false)
})
