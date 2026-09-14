'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { loadDeclarations, deferred } = require('../../test/helpers/source.cjs')
const { WorkspaceToolsService } = loadDeclarations('tabby-core/src/services/workspaceTools.service.ts', ['WorkspaceToolsService'], { Error })

const snippet = (id, extra = {}) => ({ id, kind: 'snippet', title: `Command ${id}`, body: 'pwd', ...extra })
const values = value => JSON.parse(JSON.stringify(value))

function setup (store = {}) {
    const config = { store, save: async () => {} }
    return { config, service: new WorkspaceToolsService(config) }
}

function terminal (bracketed) {
    const writes = []
    const target = { session: { open: true }, sendInput: value => writes.push(value) }
    if (bracketed !== undefined) {
        target.frontend = { supportsBracketedPaste: () => bracketed }
    }
    return { writes, target }
}

test('legacy notes and ungrouped commands remain intact when adding groups', async () => {
    const note = { id: 'note', kind: 'note', title: 'Existing notes', body: '<b>Keep exactly</b>' }
    const legacyCommand = snippet('legacy')
    const { config, service } = setup({ workspaceNotes: [note, legacyCommand] })
    assert.equal(service.groups.length, 0)
    await service.saveGroup({ id: 'servers', name: ' Servers ' })
    assert.deepEqual(values(service.groups), [{ id: 'servers', name: 'Servers' }])
    assert.deepEqual(values(service.entries), [note, legacyCommand])
    const reloaded = new WorkspaceToolsService(config)
    assert.equal(reloaded.groups[0].name, 'Servers')
    assert.equal(reloaded.entries[0].body, note.body)
})

test('groups can be renamed, but names must be present and unique ignoring case', async () => {
    const { service } = setup()
    await service.saveGroup({ id: 'servers', name: 'Servers' })
    await service.saveGroup({ id: 'servers', name: ' Production ' })
    assert.equal(service.groups.length, 1)
    assert.equal(service.groups[0].name, 'Production')
    await assert.rejects(service.saveGroup({ id: 'another', name: ' production ' }), /already exists/i)
    await assert.rejects(service.saveGroup({ id: 'blank', name: ' ' }), /name/i)
    await assert.rejects(service.saveGroup({ id: '', name: 'Other' }), /name/i)
    assert.equal(service.groups.length, 1)
})

test('commands can move between groups and ungrouped while retaining creation time', async () => {
    const { service } = setup()
    await service.saveGroup({ id: 'servers', name: 'Servers' })
    await service.saveGroup({ id: 'local', name: 'Local' })
    await service.saveEntry(snippet('a', { groupId: 'servers' }))
    const saved = service.entries[0]
    assert.equal(typeof saved.createdAt, 'number')
    assert.equal(typeof saved.updatedAt, 'number')
    await service.saveEntry({ ...saved, groupId: 'local', body: 'whoami' })
    assert.equal(service.entries[0].groupId, 'local')
    assert.equal(service.entries[0].createdAt, saved.createdAt)
    assert.ok(service.entries[0].updatedAt >= saved.updatedAt)
    await service.saveEntry({ ...service.entries[0], groupId: undefined })
    assert.equal(service.entries[0].groupId, undefined)
    await assert.rejects(service.saveEntry(snippet('missing', { groupId: 'not-found' })), /group/i)
    assert.equal(service.entries.length, 1)
})

test('deleting a group preserves all commands and only removes matching assignments', async () => {
    const { service } = setup()
    await service.saveGroup({ id: 'servers', name: 'Servers' })
    await service.saveGroup({ id: 'local', name: 'Local' })
    await service.saveEntry(snippet('a', { groupId: 'servers' }))
    await service.saveEntry(snippet('b', { groupId: 'local' }))
    await service.saveEntry(snippet('c'))
    await service.deleteGroup('servers')
    assert.deepEqual(Array.from(service.groups, group => group.id), ['local'])
    assert.deepEqual(Array.from(service.entries, entry => entry.id), ['a', 'b', 'c'])
    assert.equal(service.entries[0].groupId, undefined)
    assert.equal(service.entries[0].body, 'pwd')
    assert.equal(service.entries[1].groupId, 'local')
})

test('failed group deletion rolls back groups and command assignments together', async () => {
    const { config, service } = setup()
    await service.saveGroup({ id: 'servers', name: 'Servers' })
    await service.saveEntry(snippet('a', { groupId: 'servers' }))
    const previousEntries = service.entries
    const previousGroups = service.groups
    config.save = async () => { throw Error('disk full') }
    await assert.rejects(service.deleteGroup('servers'), /disk full/)
    assert.equal(service.entries, previousEntries)
    assert.equal(service.groups, previousGroups)
    assert.equal(service.entries[0].groupId, 'servers')
    await assert.rejects(service.saveGroup({ id: 'servers', name: 'Changed' }), /disk full/)
    assert.equal(service.groups[0].name, 'Servers')
})

test('failed first save restores missing legacy configuration fields', async () => {
    const { config, service } = setup()
    config.save = async () => { throw Error('unavailable') }
    await assert.rejects(service.saveGroup({ id: 'servers', name: 'Servers' }), /unavailable/)
    assert.equal(config.store.workspaceNotes, undefined)
    assert.equal(config.store.workspaceSnippetGroups, undefined)
})

test('overlapping mutations are serialized so a failed save cannot erase a later command', async () => {
    const { config, service } = setup()
    const saving = deferred()
    const started = deferred()
    let saves = 0
    config.save = async () => {
        saves++
        if (saves === 1) {
            started.resolve()
            await saving.promise
        }
    }
    const failed = service.saveEntry(snippet('failed'))
    const failure = assert.rejects(failed, /disk full/)
    await started.promise
    const succeeding = service.saveEntry(snippet('saved'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(saves, 1)
    saving.reject(Error('disk full'))
    await failure
    await succeeding
    assert.deepEqual(Array.from(service.entries, entry => entry.id), ['saved'])
    assert.equal(saves, 2)
})

test('simultaneous group creation and command saves retain every successful operation', async () => {
    const { service } = setup()
    await Promise.all([
        service.saveGroup({ id: 'servers', name: 'Servers' }),
        service.saveEntry(snippet('a', { groupId: 'servers' })),
        service.saveEntry(snippet('b', { groupId: 'servers' })),
    ])
    assert.equal(service.groups.length, 1)
    assert.deepEqual(Array.from(service.entries, entry => entry.id), ['a', 'b'])
    const duplicates = await Promise.allSettled([
        service.saveGroup({ id: 'c', name: 'Local' }),
        service.saveGroup({ id: 'd', name: 'local' }),
    ])
    assert.equal(duplicates[0].status, 'fulfilled')
    assert.equal(duplicates[1].status, 'rejected')
    assert.equal(service.groups.length, 2)
})

test('a command queued after its group is deleted cannot restore a stale assignment', async () => {
    const { service } = setup()
    await service.saveGroup({ id: 'servers', name: 'Servers' })
    await service.saveEntry(snippet('a', { groupId: 'servers' }))
    const stale = { ...service.entries[0], body: 'whoami' }
    const removed = service.deleteGroup('servers')
    const saving = service.saveEntry(stale)
    await removed
    await assert.rejects(saving, /group/i)
    assert.equal(service.entries[0].groupId, undefined)
    assert.equal(service.entries[0].body, 'pwd')
})

test('paste inserts a single command without Enter and targets only the selected session', () => {
    const { service } = setup()
    for (const bracketed of [undefined, false]) {
        const { writes, target } = terminal(bracketed)
        service.paste(snippet('a', { body: 'echo\tready' }), target)
        assert.deepEqual(writes, ['echo\tready'])
    }
})

test('paste wraps commands in bracketed paste markers when the terminal supports them', () => {
    const { service } = setup()
    const { writes, target } = terminal(true)
    service.paste(snippet('a', { body: 'echo a\r\necho b\n' }), target)
    assert.deepEqual(writes, ['\x1b[200~echo a\necho b\n\x1b[201~'])
})

test('multiline paste requires bracketed paste and never sends an accidental Enter', () => {
    const { service } = setup()
    for (const bracketed of [undefined, false]) {
        const { writes, target } = terminal(bracketed)
        for (const body of ['echo a\necho b', 'pwd\n', 'echo a\r\necho b']) {
            assert.throws(() => service.paste(snippet('a', { body }), target), /multiline.*bracketed paste/i)
        }
        assert.equal(writes.length, 0)
    }
})

test('run and paste reject saved terminal control characters before sending any input', () => {
    const { service } = setup()
    const { writes, target } = terminal(true)
    for (const action of ['run', 'paste']) {
        for (const body of ['pwd\x00', 'pwd\x03', 'pwd\x08', 'pwd\x1b[201~', 'pwd\x7f', 'pwd\x9b', 'pwd\rwhoami']) {
            assert.throws(() => service[action](snippet('a', { body }), target), /control character/i)
        }
        assert.throws(() => service[action]({ kind: 'note', body: 'pwd' }, target), /saved command/i)
        assert.throws(() => service[action](snippet('a', { body: ' ' }), target), /saved command/i)
        assert.throws(() => service[action](snippet('a'), null), /connected terminal/i)
        assert.throws(() => service[action](snippet('a'), { ...target, session: { open: false } }), /connected terminal/i)
    }
    assert.equal(writes.length, 0)
})

test('run preserves multiline execution and adds exactly one final Enter', () => {
    const { service } = setup()
    const { writes, target } = terminal(true)
    service.run(snippet('a', { body: 'echo\ta\r\necho b\n\n' }), target)
    assert.deepEqual(writes, ['echo\ta\recho b\r'])
})

test('malformed imported collections cannot crash read getters and preserve raw data', () => {
    for (const raw of [null, 'invalid', 42, {}]) {
        const { config, service } = setup({ workspaceNotes: raw, workspaceSnippetGroups: raw })
        assert.deepEqual(values(service.entries), [])
        assert.deepEqual(values(service.groups), [])
        assert.match(service.validationError, /repair.*configuration/i)
        assert.equal(config.store.workspaceNotes, raw)
        assert.equal(config.store.workspaceSnippetGroups, raw)
    }
})

test('getters filter malformed records and optional metadata while keeping valid legacy records', () => {
    const note = { id: 'note', kind: 'note', title: 'Legacy', body: 'Keep my notes' }
    const command = snippet('valid', { groupId: 'local', createdAt: 1, updatedAt: 2 })
    const rawEntries = [
        note, command, null, false, [], 'command', {},
        snippet('kind', { kind: 'unknown' }), snippet('id', { id: 2 }),
        snippet('title', { title: null }), snippet('body', { body: ['pwd'] }),
        snippet('group', { groupId: {} }), snippet('date', { createdAt: 'yesterday' }),
        snippet('infinite', { updatedAt: Infinity }), snippet('nan', { createdAt: NaN }),
    ]
    const group = { id: 'local', name: 'Local' }
    const rawGroups = [group, null, false, [], 'group', {}, { id: 1, name: 'Wrong' }, { id: 'empty', name: null }]
    const { config, service } = setup({ workspaceNotes: rawEntries, workspaceSnippetGroups: rawGroups })
    assert.deepEqual(values(service.entries), [note, command])
    assert.deepEqual(values(service.groups), [group])
    assert.match(service.validationError, /workspaceNotes/)
    assert.match(service.validationError, /workspaceSnippetGroups/)
    assert.equal(config.store.workspaceNotes, rawEntries)
    assert.equal(config.store.workspaceSnippetGroups, rawGroups)
    assert.equal(rawEntries.length, 15)
    assert.equal(rawGroups.length, 8)
})

test('every mutation refuses malformed storage without saving or dropping any original record', async () => {
    for (const malformedKey of ['workspaceNotes', 'workspaceSnippetGroups']) {
        const original = {
            workspaceNotes: [snippet('saved', { groupId: 'local' })],
            workspaceSnippetGroups: [{ id: 'local', name: 'Local' }],
        }
        original[malformedKey].push(null)
        const { config, service } = setup({ ...original })
        let saves = 0
        config.save = async () => { saves++ }
        await assert.rejects(service.saveEntry(snippet('new')), /repair.*configuration/i)
        await assert.rejects(service.deleteEntry('saved'), /repair.*configuration/i)
        await assert.rejects(service.saveGroup({ id: 'other', name: 'Other' }), /repair.*configuration/i)
        await assert.rejects(service.deleteGroup('local'), /repair.*configuration/i)
        assert.equal(saves, 0)
        assert.equal(config.store.workspaceNotes, original.workspaceNotes)
        assert.equal(config.store.workspaceSnippetGroups, original.workspaceSnippetGroups)
    }
})

test('repairing malformed storage clears feedback and allows subsequent saves', async () => {
    const { config, service } = setup({ workspaceNotes: [null] })
    await assert.rejects(service.saveGroup({ id: 'local', name: 'Local' }), /configuration/i)
    config.store.workspaceNotes = [snippet('legacy')]
    assert.equal(service.validationError, '')
    await service.saveGroup({ id: 'local', name: 'Local' })
    assert.equal(service.groups[0].id, 'local')
    assert.equal(service.entries[0].id, 'legacy')
})

test('malformed entry or group drafts cannot introduce invalid storage', async () => {
    const { config, service } = setup()
    for (const entry of [null, {}, snippet('bad', { groupId: 1 }), snippet('date', { updatedAt: Infinity })]) {
        await assert.rejects(service.saveEntry(entry), /title|content|valid/i)
    }
    for (const group of [null, {}, { id: 'bad', name: 2 }]) {
        await assert.rejects(service.saveGroup(group), /group name/i)
    }
    assert.equal(service.validationError, '')
    assert.equal(config.store.workspaceNotes, undefined)
    assert.equal(config.store.workspaceSnippetGroups, undefined)
})
