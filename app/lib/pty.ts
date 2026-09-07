import * as nodePTY from 'node-pty'
import { v4 as uuidv4 } from 'uuid'
import { ipcMain } from 'electron'
import { Application } from './app'
import { UTF8Splitter } from './utfSplitter'
import { Subject, Subscription, debounceTime } from 'rxjs'

class PTYDataQueue {
    private buffers: Buffer[] = []
    private delta = 0
    private maxChunk = 1024 * 100
    private maxDelta = this.maxChunk * 5
    private flowPaused = false
    private decoder = new UTF8Splitter()
    private output$ = new Subject<Buffer>()
    private outputSubscription: Subscription
    private disposed = false
    private ended = false
    private onDrained: (() => void)|null = null
    private scheduledEmit: ReturnType<typeof setImmediate>|null = null

    constructor (private pty: nodePTY.IPty, private onData: (data: Buffer) => void) {
        this.outputSubscription = this.output$.pipe(debounceTime(500)).subscribe(() => {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
        })
    }

    push (data: Buffer) {
        if (this.disposed || this.ended) {
            return
        }
        this.buffers.push(data)
        this.maybeEmit()
    }

    ack (length: number) {
        if (this.disposed || !Number.isSafeInteger(length) || length <= 0) {
            return
        }
        this.delta = Math.max(0, this.delta - length)
        this.maybeEmit()
    }

    finish (onDrained: () => void): void {
        if (this.disposed) {
            onDrained()
            return
        }
        this.ended = true
        this.onDrained = onDrained
        this.maybeEmit()
    }

    dispose (): void {
        this.disposed = true
        this.buffers = []
        this.decoder.flush()
        this.outputSubscription.unsubscribe()
        this.output$.complete()
        if (this.flowPaused && !this.ended) {
            this.pty.resume()
            this.flowPaused = false
        }
        if (this.scheduledEmit) {
            clearImmediate(this.scheduledEmit)
            this.scheduledEmit = null
        }
        const onDrained = this.onDrained
        this.onDrained = null
        onDrained?.()
    }

    private maybeEmit () {
        if (this.disposed) {
            return
        }
        if (this.delta <= this.maxDelta && this.flowPaused) {
            this.resume()
            return
        }
        if (this.buffers.length > 0) {
            if (this.delta > this.maxDelta) {
                if (!this.flowPaused) {
                    this.pause()
                }
                return
            }

            const buffersToSend = []
            let totalLength = 0
            while (totalLength < this.maxChunk && this.buffers.length) {
                totalLength += this.buffers[0].length
                buffersToSend.push(this.buffers.shift())
            }

            if (buffersToSend.length === 0) {
                return
            }

            let toSend = Buffer.concat(buffersToSend)
            if (toSend.length > this.maxChunk) {
                this.buffers.unshift(toSend.slice(this.maxChunk))
                toSend = toSend.slice(0, this.maxChunk)
            }
            this.emitData(toSend)
            this.delta += toSend.length

            if (this.buffers.length) {
                this.scheduledEmit ??= setImmediate(() => {
                    this.scheduledEmit = null
                    this.maybeEmit()
                })
            }
        }
        if (this.ended && !this.buffers.length) {
            const remainder = this.decoder.flush()
            if (remainder.length) {
                this.onData(remainder)
            }
            if (this.delta === 0) {
                this.dispose()
            }
        }
    }

    private emitData (data: Buffer) {
        const validChunk = this.decoder.write(data)
        this.onData(validChunk)
        this.output$.next(validChunk)
    }

    private pause () {
        if (!this.ended) {
            this.pty.pause()
        }
        this.flowPaused = true
    }

    private resume () {
        if (!this.ended) {
            this.pty.resume()
        }
        this.flowPaused = false
        this.maybeEmit()
    }
}

export class PTY {
    private pty: nodePTY.IPty
    private outputQueue: PTYDataQueue
    private subscriptions: nodePTY.IDisposable[] = []
    exited = false

    constructor (private id: string, private app: Application, onDisposed: () => void, ...args: any[]) {
        this.pty = (nodePTY as any).spawn(...args)

        this.outputQueue = new PTYDataQueue(this.pty, data => {
            setImmediate(() => this.emit('data', data))
        })

        this.subscriptions.push(this.pty.onData(data => this.outputQueue.push(Buffer.from(data))))
        this.subscriptions.push(this.pty.onExit(event => {
            this.exited = true
            this.outputQueue.finish(() => {
                this.emit('exit', event.exitCode, event.signal)
                this.emit('close')
                for (const subscription of this.subscriptions) {
                    subscription.dispose()
                }
                this.subscriptions = []
                onDisposed()
            })
        }))
    }

    release (): void {
        // No renderer remains to consume or acknowledge this session's output.
        this.outputQueue.dispose()
    }

    getPID (): number {
        return this.pty.pid
    }

    resize (columns: number, rows: number): void {
        if ((this.pty as any)._writable) {
            this.pty.resize(columns, rows)
        }
    }

    write (buffer: Buffer): void {
        if ((this.pty as any)._writable) {
            this.pty.write(buffer as any)
        }
    }

    ackData (length: number): void {
        this.outputQueue.ack(length)
    }

    kill (signal?: string): void {
        this.pty.kill(signal)
    }

    private emit (event: string, ...args: any[]) {
        this.app.broadcast(`pty:${this.id}:${event}`, ...args)
    }
}

export class PTYManager {
    private ptys = new Map<string, PTY>()

    init (app: Application): void {
        ipcMain.on('pty:spawn', (event, ...options) => {
            const id = uuidv4().toString()
            event.returnValue = id
            this.ptys.set(id, new PTY(id, app, () => { this.ptys.delete(id) }, ...options))
        })

        ipcMain.on('pty:exists', (event, id) => {
            event.returnValue = this.ptys.has(id) && !this.ptys.get(id)!.exited
        })

        ipcMain.on('pty:get-pid', (event, id) => {
            event.returnValue = this.ptys.get(id)?.getPID()
        })

        ipcMain.on('pty:resize', (_event, id, columns, rows) => {
            this.ptys.get(id)?.resize(columns, rows)
        })

        ipcMain.on('pty:write', (_event, id, data) => {
            this.ptys.get(id)?.write(Buffer.from(data))
        })

        ipcMain.on('pty:kill', (_event, id, signal) => {
            this.ptys.get(id)?.kill(signal)
        })

        ipcMain.on('pty:ack-data', (_event, id, length) => {
            this.ptys.get(id)?.ackData(length)
        })

        ipcMain.on('pty:release', (_event, id) => {
            this.ptys.get(id)?.release()
        })
    }
}
