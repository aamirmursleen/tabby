'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadDeclarations } = require('../../test/helpers/source.cjs')

class FileDownload {
    setTotalSize (size) { this.totalSize = size }
    increaseProgress (size) { this.completedBytes = (this.completedBytes ?? 0) + size }
    getCompletedBytes () { return this.completedBytes ?? 0 }
    setCompleted (value) { this.completed = value }
}

test('desktop downloads enforce the requested mode when replacing an existing file', async () => {
    const { ElectronFileDownload } = loadDeclarations('tabby-electron/src/services/platform.service.ts', [
        'ElectronFileDownload',
    ], { fs, path, FileDownload })
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aamir-download-mode-'))
    try {
        const filename = path.join(directory, 'id_ed25519')
        await fs.writeFile(filename, 'old', { mode: 0o644 })
        await fs.chmod(filename, 0o644)
        const electron = {
            powerSaveBlocker: {
                start: () => 1,
                stop: () => {},
            },
        }
        const download = new ElectronFileDownload(filename, 0o600, 3, electron)

        await download.open()
        await download.write(Buffer.from('new'))
        download.close()

        assert.equal((await fs.stat(filename)).mode & 0o777, 0o600)
    } finally {
        await fs.rm(directory, { recursive: true, force: true })
    }
})
