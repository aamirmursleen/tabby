'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

class TestEventEmitter {
    constructor () {
        this.listeners = []
    }

    subscribe (listener) {
        this.listeners.push(listener)
    }

    emit () {
        for (const listener of this.listeners) {
            listener()
        }
    }
}

class TestBaseComponent {
    subscribeUntilDestroyed () {}
}

const { ActiveSessionsComponent } = loadDeclarations(
    'tabby-core/src/components/activeSessions.component.ts',
    ['ActiveSessionsComponent'],
    {
        Component: () => target => target,
        Output: () => () => {},
        EventEmitter: TestEventEmitter,
        BaseComponent: TestBaseComponent,
    },
)

test('the sessions panel exposes its own collapse action', () => {
    const component = new ActiveSessionsComponent({ tabsChanged$: null, activeTabChange$: null })
    let collapsed = false
    component.closed.subscribe(() => { collapsed = true })

    component.collapse()

    assert.equal(collapsed, true)
})
