'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')
const { WorkspaceToolsService } = loadDeclarations('tabby-core/src/services/workspaceTools.service.ts', ['WorkspaceToolsService'], { Error })
const { TerminalPaneHeaderComponent } = loadDeclarations('tabby-core/src/components/terminalPaneHeader.component.ts', ['TerminalPaneHeaderComponent'], {
    Component: () => x => x, Input: () => () => {}, ViewChild: () => () => {},
    getOpenTabLabel: tab => tab.customTitle || tab.profile.name,
})
function setup () {
    const config = { store: { workspaceNotes: [] }, save: async () => {} }
    return { config, service: new WorkspaceToolsService(config) }
}
test('saves notes and snippets, edits by ID, deletes, and reloads', async () => {
    const { config, service } = setup()
    await service.saveEntry({ id: 'a', kind: 'note', title: ' Notes ', body: '<b>plain text</b>' })
    await service.saveEntry({ id: 'b', kind: 'snippet', title: 'Run', body: 'pwd' })
    await service.saveEntry({ id: 'a', kind: 'note', title: 'Updated', body: 'content' })
    assert.equal(service.entries.length, 2)
    assert.equal(new WorkspaceToolsService(config).entries[0].title, 'Updated')
    await service.deleteEntry('a')
    assert.equal(service.entries[0].id, 'b')
})
test('failed saves and deletes preserve existing saved entries', async () => {
    const { config, service } = setup()
    await service.saveEntry({ id: 'a', kind: 'note', title: 'Saved', body: 'content' })
    config.save = async () => { throw Error('disk full') }
    await assert.rejects(service.saveEntry({ id: 'a', kind: 'note', title: 'New', body: 'new' }))
    assert.equal(service.entries[0].title, 'Saved')
    await assert.rejects(service.deleteEntry('a'))
    assert.equal(service.entries.length, 1)
})
test('rejects empty entries and invalid kinds', async () => {
    const { service } = setup()
    for (const entry of [
        { id: 'a', kind: 'note', title: ' ', body: 'x' },
        { id: 'a', kind: 'snippet', title: 'x', body: ' ' },
        { id: 'a', kind: 'bad', title: 'x', body: 'x' },
    ]) { await assert.rejects(service.saveEntry(entry)) }
})
test('run targets one connected pane and normalizes multiline commands', () => {
    const { service } = setup()
    const writes = []
    const target = { session: { open: true }, sendInput: value => writes.push(value) }
    service.run({ kind: 'snippet', body: 'echo a\r\necho b\n' }, target)
    assert.deepEqual(writes, ['echo a\recho b\r'])
    assert.throws(() => service.run({ kind: 'note', body: 'pwd' }, target))
    assert.throws(() => service.run({ kind: 'snippet', body: ' ' }, target))
    assert.throws(() => service.run({ kind: 'snippet', body: 'pwd' }, null))
    assert.throws(() => service.run({ kind: 'snippet', body: 'pwd' }, { ...target, session: { open: false } }))
    assert.equal(writes.length, 1)
})
test('pane names are editable without replacing their live titles; Escape cancels', () => {
    let changed = 0
    const header = new TerminalPaneHeaderComponent({ emitTabsChanged: () => changed++ })
    header.tab = { title: 'live', profile: { name: 'Server' }, customTitle: '' }
    header.startRename()
    assert.equal(header.draft, 'Server')
    header.draft = ' API '
    header.save()
    assert.equal(header.tab.customTitle, 'API')
    assert.equal(header.tab.title, 'live')
    assert.equal(changed, 1)
    header.startRename()
    header.draft = 'discard'
    header.cancel()
    header.save()
    assert.equal(header.tab.customTitle, 'API')
    header.startRename()
    header.draft = ' '
    header.save()
    assert.equal(header.label, 'Server')
})

const SplitTabComponent = class { constructor (tab) { this.tab = tab } getFocusedTab () { return this.tab } }
const { WorkspaceToolsComponent } = loadDeclarations('tabby-core/src/components/workspaceTools.component.ts', ['WorkspaceToolsComponent'], {
    Error, Component: () => x => x, Output: () => () => {}, HostListener: () => () => {}, EventEmitter: class { emit () {} }, SplitTabComponent, uuid: () => 'generated-id',
    getOpenTabLabel: tab => tab.customTitle,
})
test('sidebar filters by type and content, saves drafts and resolves focused pane', async () => {
    const { service } = setup()
    const tab = { customTitle: 'API', emitFocused () {}, sendInput () {}, session: { open: true } }
    const app = { activeTab: new SplitTabComponent(tab) }
    const component = new WorkspaceToolsComponent(service, app)
    assert.equal(component.target, tab)
    assert.equal(component.targetName, 'API')
    component.edit()
    component.draft.title = 'Health'
    component.draft.body = 'curl localhost'
    await component.save()
    assert.equal(component.draft, null)
    component.query = 'LOCALHOST'
    assert.equal(component.entries.length, 1)
    component.query = 'not present'
    assert.equal(component.entries.length, 0)
    component.query = ''
    component.edit(service.entries[0])
    component.draft.body = 'draft only'
    assert.equal(service.entries[0].body, 'curl localhost')
    component.run(service.entries[0])
    assert.equal(component.status, 'Sent to API')
    component.deleting = 'generated-id'
    await component.remove(service.entries[0])
    assert.equal(component.deleting, null)
    assert.equal(service.entries.length, 0)
    app.activeTab = null
    assert.equal(component.targetName, 'Select a terminal')
    app.activeTab = tab
    assert.equal(component.target, tab)
    app.activeTab = {}
    assert.equal(component.target, null)
})
test('sidebar preserves failed drafts, reports save/delete/run errors and guards busy actions', async () => {
    const { config, service } = setup()
    const component = new WorkspaceToolsComponent(service, { activeTab: null })
    await component.save()
    component.edit()
    component.draft.title = 'Note'
    component.draft.body = 'Content'
    config.save = async () => { throw Error('unavailable') }
    await component.save()
    assert.equal(component.draft.title, 'Note')
    assert.ok(component.error)
    assert.equal(component.busy, false)
    await component.remove({ id: 'x' })
    assert.ok(component.error)
    component.run({ kind: 'snippet', body: 'pwd' })
    assert.match(component.error, /connected terminal/)
    component.busy = true
    component.error = 'unchanged'
    await component.save()
    await component.remove({ id: 'x' })
    assert.equal(component.error, 'unchanged')
})


test('snippet search includes group names and sorting leaves saved order unchanged', () => {
    const { config, service } = setup()
    config.store.workspaceSnippetGroups = [{ id: 'g', name: 'Production' }]
    config.store.workspaceNotes = [
        { id: 'z', kind: 'snippet', title: 'Zulu', body: 'pwd', groupId: 'g', createdAt: 1, updatedAt: 3 },
        { id: 'a', kind: 'snippet', title: 'Alpha', body: 'ls', createdAt: 2, updatedAt: 2 },
        { id: 'n', kind: 'note', title: 'Private note', body: 'do not execute' },
    ]
    const c = new WorkspaceToolsComponent(service, { activeTab: null })
    assert.equal(c.entries.map(x => x.id).join(','), 'a,z')
    c.sort = 'name-desc'
    assert.equal(c.entries.map(x => x.id).join(','), 'z,a')
    c.sort = 'updated'
    assert.equal(c.entries[0].id, 'z')
    c.sort = 'newest'
    assert.equal(c.entries[0].id, 'a')
    c.query = 'prod pwd'
    assert.equal(c.entries.map(x => x.id).join(','), 'z')
    assert.equal(c.sections.length, 1)
    assert.equal(c.sections[0].name, 'Production')
    assert.equal(config.store.workspaceNotes[0].id, 'z')
})

test('groups collapse, searches reveal matches, and new snippets inherit the chosen group', () => {
    const { config, service } = setup()
    config.store.workspaceSnippetGroups = [{ id: 'g', name: 'Servers' }]
    const c = new WorkspaceToolsComponent(service, { activeTab: null })
    c.toggleGroup('g')
    assert.equal(c.isExpanded('g'), false)
    c.query = 'find'
    assert.equal(c.isExpanded('g'), true)
    c.query = ''
    c.toggleGroup('g')
    assert.equal(c.isExpanded('g'), true)
    c.edit(undefined, 'g')
    assert.equal(c.draft.groupId, 'g')
    assert.equal(c.draft.kind, 'snippet')
})


test('sidebar editor shortcuts stop before terminal handlers without blocking native editing', () => {
    const { service } = setup()
    const c = new WorkspaceToolsComponent(service, { activeTab: null })
    for (const key of ['v', 'c', 'Enter']) {
        let stopped = false
        let prevented = false
        c.protectEditorKeys({ key, stopPropagation () { stopped = true }, preventDefault () { prevented = true } })
        assert.equal(stopped, true)
        assert.equal(prevented, false)
    }
})

test('paste focuses the receiving terminal only after successful insertion', () => {
    const { service } = setup()
    let focused = 0
    const writes = []
    const target = { customTitle: 'API', session: { open: true }, sendInput: x => writes.push(x), emitFocused: () => focused++ }
    const c = new WorkspaceToolsComponent(service, { activeTab: target })
    c.paste({ kind: 'snippet', body: 'pwd' })
    assert.equal(writes[0], 'pwd')
    assert.equal(focused, 1)
    target.session.open = false
    c.paste({ kind: 'snippet', body: 'pwd' })
    assert.equal(focused, 1)
    assert.ok(c.error)
})

test('group editor saves, renames and removes groups while keeping snippets', async () => {
    const { service } = setup()
    const c = new WorkspaceToolsComponent(service, { activeTab: null })
    c.editGroup()
    c.groupDraft.name = 'Servers'
    await c.saveGroup()
    assert.equal(c.groupDraft, null)
    const group = service.groups[0]
    c.edit(undefined, group.id)
    c.draft.title = 'Health'
    c.draft.body = 'pwd'
    await c.save()
    c.editGroup(group)
    c.groupDraft.name = 'Production'
    assert.equal(service.groups[0].name, 'Servers')
    await c.saveGroup()
    assert.equal(c.sections[0].name, 'Production')
    c.deletingGroup = group.id
    await c.removeGroup(group.id)
    assert.equal(c.deletingGroup, null)
    assert.equal(c.sections[0].name, 'Ungrouped')
    assert.equal(service.entries.length, 1)
})

test('group editor preserves failed drafts and blocks conflicting or busy actions', async () => {
    const { config, service } = setup()
    const c = new WorkspaceToolsComponent(service, { activeTab: null })
    await c.saveGroup()
    c.edit()
    c.editGroup()
    assert.equal(c.groupDraft, null)
    c.draft = null
    c.editGroup()
    c.groupDraft.name = 'Keep this draft'
    c.edit()
    assert.equal(c.draft, null)
    config.save = async () => { throw Error('disk full') }
    await c.saveGroup()
    assert.equal(c.groupDraft.name, 'Keep this draft')
    assert.ok(c.error)
    assert.equal(c.busy, false)
    await c.removeGroup('missing')
    assert.match(c.error, /Could not delete group/)
    c.busy = true
    c.error = 'unchanged'
    await c.saveGroup()
    await c.removeGroup('missing')
    assert.equal(c.error, 'unchanged')
})
