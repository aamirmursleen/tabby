'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const rx = require('rxjs')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

const Component = () => value => value
const propertyDecorator = () => () => {}
class ConfigService {}
class ElementRef {}
const { BaseComponent } = loadDeclarations('tabby-core/src/components/base.component.ts', ['SubscriptionContainer', 'BaseComponent'], rx)
const { BaseTabComponent } = loadDeclarations('tabby-core/src/components/baseTab.component.ts', ['BaseTabComponent'], { ...rx, BaseComponent, ConfigService })
const windowEvents = new EventTarget()
const { SplitContainer, SplitTabComponent } = loadDeclarations('tabby-core/src/components/splitTab.component.ts', ['SplitContainer', 'SplitTabComponent'], {
    ...rx, BaseTabComponent, Component, ViewChild: propertyDecorator, ViewContainerRef: class {}, ElementRef, window: windowEvents,
})
const { TerminalPaneHeaderComponent } = loadDeclarations('tabby-core/src/components/terminalPaneHeader.component.ts', ['TerminalPaneHeaderComponent'], {
    Component, Input: propertyDecorator, ViewChild: propertyDecorator, SplitTabComponent,
    getOpenTabLabel: tab => tab.customTitle || tab.title,
})

function element () {
    return Object.assign(new EventTarget(), {
        style: {}, classes: new Set(), closest: () => null,
        classList: { toggle (name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name) } },
        contains: () => false,
    })
}

function setup () {
    const host = element()
    const config = { store: { terminal: { focusFollowsMouse: false } } }
    const injector = { get: token => token === ElementRef ? { nativeElement: host } : config }
    const hotkeys = { hotkey$: new rx.Subject() }
    const split = new SplitTabComponent(hotkeys, {}, {}, injector)
    const panes = ['API', 'Logs', 'Local', 'Database'].map(title => {
        const pane = new BaseTabComponent(injector)
        pane.title = title
        pane.parent = split
        const view = element()
        view.classList.owner = view
        split.viewRefs.set(pane, { rootNodes: [view] })
        return pane
    })
    const row = (children, ratios) => Object.assign(new SplitContainer(), { children, ratios })
    split.root = Object.assign(new SplitContainer(), { orientation: 'v', ratios: [.4, .6], children: [row(panes.slice(0, 2), [.3, .7]), row(panes.slice(2), [.55, .45])] })
    split.focus(panes[0])
    const headers = panes.map(tab => Object.assign(new TerminalPaneHeaderComponent({ emitTabsChanged () {} }), { tab }))
    const bounds = pane => ({ ...split.viewRefs.get(pane).rootNodes[0].style })
    return { host, split, panes, headers, bounds, hotkeys }
}

function key (host, type = 'keydown', options = {}) {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { key: 'Escape', ...options })
    host.dispatchEvent(event)
    return event
}

test('each pane expands to the whole area and restores all unequal split positions', () => {
    const { split, panes, headers, bounds } = setup()
    const before = panes.map(bounds)
    const tree = split.root
    for (let i = 0; i < panes.length; i++) {
        headers[i].toggleMaximize()
        assert.equal(split.getFocusedTab(), panes[i])
        assert.equal(headers[i].maximized, true)
        assert.deepEqual(bounds(panes[i]), { left: '0%', top: '0%', width: '100%', height: '100%' })
        for (const pane of panes.filter(pane => pane !== panes[i])) assert.equal(split.viewRefs.get(pane).rootNodes[0].classes.has('minimized'), true)
        headers[i].toggleMaximize()
        assert.equal(headers[i].maximized, false)
        assert.deepEqual(panes.map(bounds), before)
        assert.equal(split.root, tree, 'expansion never replaces the live layout')
        assert.deepEqual([...split.getAllTabs()], panes, 'the same live sessions remain attached')
    }
    split.ngOnDestroy()
})

test('Escape restores the layout before terminal input; its repeat and keyup are consumed', () => {
    const { host, split, panes, headers, bounds } = setup()
    const before = panes.map(bounds)
    headers[2].toggleMaximize()
    assert.equal(key(host).defaultPrevented, true)
    assert.equal(split.getMaximizedTab(), null)
    assert.equal(split.getFocusedTab(), panes[2])
    assert.deepEqual(panes.map(bounds), before)
    assert.equal(key(host, 'keydown', { repeat: true }).defaultPrevented, true)
    assert.equal(key(host, 'keyup').defaultPrevented, true)
    assert.equal(key(host).defaultPrevented, false, 'ordinary Escape still reaches the terminal')
    assert.equal(key(host, 'keyup').defaultPrevented, false)
    split.ngOnDestroy()
})

test('rename, search, modified keys and composition keep their normal Escape behavior', () => {
    const { host, split, panes, headers } = setup()
    headers[1].toggleMaximize()
    host.closest = () => ({ tagName: 'INPUT' })
    assert.equal(key(host).defaultPrevented, false)
    host.closest = () => null
    for (const option of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing']) {
        assert.equal(key(host, 'keydown', { [option]: true }).defaultPrevented, false)
    }
    assert.equal(key(host, 'keydown', { key: 'Enter' }).defaultPrevented, false)
    assert.equal(split.getMaximizedTab(), panes[1])
    split.ngOnDestroy()
})

test('a standalone terminal has no expansion action and rename still cancels independently', () => {
    const { split, panes, headers } = setup()
    const header = headers[0]
    split.root.children = [panes[0]]
    split.root.ratios = [1]
    assert.equal(header.canMaximize, false)
    header.toggleMaximize()
    assert.equal(split.getMaximizedTab(), null)
    header.tab.parent = null
    assert.equal(header.canMaximize, false)
    header.toggleMaximize()
    header.startRename()
    header.draft = 'Discard this'
    header.cancel()
    header.save()
    assert.equal(header.label, 'API')
    split.ngOnDestroy()
})

test('the existing pane shortcut and navigating to another pane use the same full-area view', () => {
    const { split, panes, bounds, hotkeys } = setup()
    split.hasFocus = true
    hotkeys.hotkey$.next('pane-maximize')
    assert.deepEqual(bounds(panes[0]), { left: '0%', top: '0%', width: '100%', height: '100%' })
    split.focus(panes[1])
    assert.equal(split.getMaximizedTab(), null)
    assert.equal(bounds(panes[0]).width, '30%')
    split.ngOnDestroy()
})

test('closing the expanded last pane in a nested row reveals and focuses a remaining session', () => {
    const { split, panes, headers } = setup()
    split.removeTab(panes[2])
    headers[3].toggleMaximize()
    split.removeTab(panes[3])
    assert.equal(split.getMaximizedTab(), null)
    assert.ok(split.getAllTabs().includes(split.getFocusedTab()))
    for (const pane of split.getAllTabs()) assert.equal(split.viewRefs.get(pane).rootNodes[0].classes.has('minimized'), false)
    split.ngOnDestroy()
})

test('leaving the window clears held-Escape state and destroying a tab removes key listeners', () => {
    const { host, split, headers } = setup()
    headers[0].toggleMaximize()
    key(host)
    windowEvents.dispatchEvent(new Event('blur'))
    assert.equal(key(host).defaultPrevented, false)
    headers[0].toggleMaximize()
    split.ngOnDestroy()
    assert.equal(key(host).defaultPrevented, false)
})
