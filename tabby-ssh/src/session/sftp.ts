/* eslint-disable @typescript-eslint/no-unused-vars */
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { randomUUID } from 'crypto'
import { Injector } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService } from 'tabby-core'
import * as russh from 'russh'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private inner: russh.SFTPFile|null,
    ) { }

    async read (): Promise<Uint8Array> {
        if (!this.inner) {
            return Promise.resolve(new Uint8Array(0))
        }
        return this.inner.read(256 * 1024)
    }

    async write (chunk: Uint8Array): Promise<void> {
        if (!this.inner) {
            throw new Error('File handle is closed')
        }
        await this.inner.writeAll(chunk)
    }

    async close (): Promise<void> {
        await this.inner?.shutdown()
        this.inner = null
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private logger: Logger
    private uploadCommits = new Map<string, Promise<void>>()

    constructor (private sftp: russh.SFTP, injector: Injector) {
        this.logger = injector.get(LogService).create('sftp')
        sftp.closed$.subscribe(() => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries = await this.sftp.readDirectory(p)
        return entries.map(entry => this._makeFile(
            posixPath.join(p, entry.name), entry,
        ))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return this.sftp.readlink(p)
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await this.sftp.stat(p)
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.type === russh.SFTPFileType.Directory,
            isSymlink: stats.type === russh.SFTPFileType.Symlink,
            mode: stats.permissions ?? 0,
            size: stats.size,
            modified: new Date((stats.mtime ?? 0) * 1000),
        }
    }

    async open (p: string, mode: number): Promise<SFTPFileHandle> {
        this.logger.debug('open', p, mode)
        const handle = await this.sftp.open(p, mode)
        return new SFTPFileHandle(handle)
    }

    async rmdir (p: string): Promise<void> {
        await this.sftp.removeDirectory(p)
    }

    async mkdir (p: string): Promise<void> {
        await this.sftp.createDirectory(p)
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await this.sftp.rename(oldPath, newPath)
    }

    async unlink (p: string): Promise<void> {
        await this.sftp.removeFile(p)
    }

    async chmod (p: string, mode: string|number): Promise<void> {
        this.logger.debug('chmod', p, mode)
        await this.sftp.chmod(p, mode)
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        const tempPath = `${path}.tabby-upload-${randomUUID()}`
        let handle: SFTPFileHandle|null = null
        let tempCreated = false
        try {
            this.checkTransferCancelled(transfer)
            handle = await this.open(tempPath, russh.OPEN_WRITE | russh.OPEN_CREATE | russh.OPEN_TRUNCATE)
            tempCreated = true
            while (true) {
                this.checkTransferCancelled(transfer)
                const chunk = await transfer.read()
                this.checkTransferCancelled(transfer)
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            await handle.close()
            handle = null
            // Serialize commits to the same destination on servers that need
            // the backup/rollback fallback instead of atomic replacement.
            const previous = this.uploadCommits.get(path) ?? Promise.resolve()
            const commit = previous.catch(() => null).then(async () => {
                this.checkTransferCancelled(transfer)
                await this.replaceUploadedFile(tempPath, path)
            })
            this.uploadCommits.set(path, commit)
            try {
                await commit
            } finally {
                if (this.uploadCommits.get(path) === commit) {
                    this.uploadCommits.delete(path)
                }
            }
            tempCreated = false
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        } finally {
            await handle?.close().catch(error => this.logger.warn('Could not close upload handle:', error))
            if (tempCreated) {
                await this.unlink(tempPath).catch(error => this.logger.warn('Could not remove upload temporary file:', error))
            }
        }
    }

    private async replaceUploadedFile (tempPath: string, path: string): Promise<void> {
        try {
            // Never unlink the destination before its replacement is committed.
            await this.rename(tempPath, path)
            return
        } catch (error) {
            const destination = await this.stat(path).catch(() => null)
            if (!destination || destination.isDirectory) {
                throw error
            }
        }

        const backupPath = `${path}.tabby-backup-${randomUUID()}`
        await this.rename(path, backupPath)
        try {
            await this.rename(tempPath, path)
        } catch (error) {
            try {
                await this.rename(backupPath, path)
            } catch {
                // Never clean up the only surviving copy of the original.
                throw new Error(`Upload failed; the original file is preserved in backup: ${backupPath}`)
            }
            throw error
        }
        await this.unlink(backupPath).catch(error => {
            this.logger.warn('Upload succeeded but its backup could not be removed:', backupPath, error)
        })
    }

    private checkTransferCancelled (transfer: FileUpload|FileDownload): void {
        if (transfer.isCancelled()) {
            throw new Error('Transfer cancelled')
        }
    }

    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        let handle: SFTPFileHandle|null = null
        try {
            this.checkTransferCancelled(transfer)
            handle = await this.open(path, russh.OPEN_READ)
            while (true) {
                this.checkTransferCancelled(transfer)
                const chunk = await handle.read()
                this.checkTransferCancelled(transfer)
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            await handle.close()
            handle = null
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        } finally {
            await handle?.close().catch(error => this.logger.warn('Could not close download handle:', error))
        }
    }

    private _makeFile (p: string, entry: russh.SFTPDirectoryEntry): SFTPFile {
        return {
            fullPath: p,
            name: posixPath.basename(p),
            isDirectory: entry.metadata.type === russh.SFTPFileType.Directory,
            isSymlink: entry.metadata.type === russh.SFTPFileType.Symlink,
            mode: entry.metadata.permissions ?? 0,
            size: entry.metadata.size,
            modified: new Date((entry.metadata.mtime ?? 0) * 1000),
        }
    }
}
