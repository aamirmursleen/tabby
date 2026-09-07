'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { Subject } = require('rxjs')
const { randomUUID } = require('node:crypto')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

function setup (options = {}) {
    const files = new Map([['/file', 'original']])
    const opened = []
    const removed = []
    const { SFTPSession, SFTPFileHandle } = loadDeclarations('tabby-ssh/src/session/sftp.ts', ['SFTPFileHandle', 'SFTPSession'], {
        Subject, randomUUID, posixPath: require('node:path').posix, LogService: Symbol('log'),
        russh: { OPEN_READ: 1, OPEN_WRITE: 2, OPEN_CREATE: 8, OPEN_TRUNCATE: 16, SFTPFileType: { Directory: 0 } },
    })
    const inner = {
        closed$: new Subject(),
        async stat (name) { if (!files.has(name)) { throw new Error('missing') }; return { type: 1, size: 0 } },
        async open (name, flags) {
            if (options.openFails) { throw new Error('open failed') }
            const record = { name, flags, closed: 0 }
            opened.push(record)
            if (flags & 8) { files.set(name, '') }
            return {
                async writeAll (chunk) {
                    if (options.writeFails) { throw new Error('write failed') }
                    files.set(name, files.get(name) + chunk.toString())
                },
                async read () { throw new Error('read failed') },
                async shutdown () { record.closed++ },
            }
        },
        async removeFile (name) { removed.push(name); files.delete(name) },
        async rename (from, to) {
            if (options.renameFails?.(from, to)) { throw new Error('rename failed') }
            if (!files.has(from) || files.has(to)) { throw new Error('rename rejected') }
            files.set(to, files.get(from))
            files.delete(from)
        },
    }
    const session = new SFTPSession(inner, { get: () => ({ create: () => ({ info () {}, debug () {}, warn () {} }) }) })
    return { session, files, opened, removed, SFTPFileHandle }
}

function upload (options = {}) {
    let read = false
    return {
        cancelled: false, finished: false,
        isCancelled () { return this.cancelled },
        async read () {
            if (options.cancelDuringRead) { this.cancelled = true }
            if (read) { return Buffer.alloc(0) }
            read = true
            return Buffer.from('replacement')
        },
        close () { this.finished = true },
        cancel () { this.cancelled = true },
    }
}

test('successful replacement uses a unique temporary file and leaves no backup', async () => {
    const { session, files, opened, removed } = setup()
    const transfer = upload()
    await session.upload('/file', transfer)
    assert.equal(files.get('/file'), 'replacement')
    assert.equal(files.size, 1)
    assert.notEqual(opened[0].name, '/file.tabby-upload')
    assert.ok(opened[0].flags & 16)
    assert.equal(opened[0].closed, 1)
    assert.equal(removed.includes('/file'), false)
    assert.equal(transfer.finished, true)
})

test('failed replacement restores the original destination', async () => {
    const { session, files } = setup({ renameFails: from => from.includes('tabby-upload') })
    await assert.rejects(session.upload('/file', upload()), /rename/)
    assert.equal(files.get('/file'), 'original')
})

test('failed rollback preserves the backup and reports its location', async () => {
    const { session, files } = setup({ renameFails: (from, to) => to === '/file' })
    await assert.rejects(session.upload('/file', upload()), /backup/i)
    assert.ok([...files.entries()].some(([name, content]) => name.includes('tabby-backup') && content === 'original'))
})

test('write failure closes the handle and never removes the destination', async () => {
    const { session, files, opened } = setup({ writeFails: true })
    await assert.rejects(session.upload('/file', upload()), /write failed/)
    assert.equal(files.get('/file'), 'original')
    assert.equal(opened[0].closed, 1)
})

test('open failure does not unlink a file this upload never created', async () => {
    const { session, removed } = setup({ openFails: true })
    await assert.rejects(session.upload('/file', upload()), /open failed/)
    assert.deepEqual(removed, [])
})

test('cancellation during reading cannot replace the destination with partial data', async () => {
    const { session, files } = setup()
    await assert.rejects(session.upload('/file', upload({ cancelDuringRead: true })), /cancel/i)
    assert.equal(files.get('/file'), 'original')
})

test('download failure closes the remote handle and cancels the transfer', async () => {
    const { session, opened } = setup()
    const transfer = upload()
    await assert.rejects(session.download('/file', transfer), /read failed/)
    assert.equal(opened[0].closed, 1)
    assert.equal(transfer.cancelled, true)
})
