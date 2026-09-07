import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const MAX_OSC_BYTES = 1024 * 1024

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private copyRequested = new Subject<string>()
    private chunks: Buffer[] = []
    private bufferedBytes = 0
    private inOSC = false
    private pendingEscape = false
    private oscEscape = false

    feedFromSession (data: Buffer): void {
        if (!data.length) {
            return
        }
        // Keep ordinary terminal output on the zero-copy fast path.
        if (!this.inOSC && !this.pendingEscape && data.indexOf(OSCPrefix) === -1 && data[data.length - 1] !== 0x1b) {
            super.feedFromSession(data)
            return
        }

        const output: Buffer[] = []
        let start = 0
        for (let i = 0; i < data.length; i++) {
            const byte = data[i]
            if (this.inOSC) {
                this.bufferedBytes++
                if (byte === 0x07 || this.oscEscape && byte === 0x5c) {
                    this.chunks.push(data.subarray(start, i + 1))
                    const sequence = Buffer.concat(this.chunks)
                    this.processOSC(sequence, byte === 0x07 ? 1 : 2, output)
                    this.resetOSC()
                    start = i + 1
                } else if (this.bufferedBytes > MAX_OSC_BYTES) {
                    // Discard malformed oversized OSC, including clipboard side
                    // effects, so subsequent terminal output can be displayed.
                    this.resetOSC()
                    start = i + 1
                } else {
                    this.oscEscape = byte === 0x1b
                }
                continue
            }

            if (this.pendingEscape) {
                this.pendingEscape = false
                if (byte === 0x5d) {
                    this.chunks = [Buffer.from([0x1b])]
                    this.inOSC = true
                    this.bufferedBytes = 2
                    start = i
                    continue
                }
                output.push(Buffer.from([0x1b]))
            }

            if (byte === 0x1b) {
                if (i === data.length - 1) {
                    output.push(data.subarray(start, i))
                    this.pendingEscape = true
                    start = data.length
                } else if (data[i + 1] === 0x5d) {
                    output.push(data.subarray(start, i))
                    this.inOSC = true
                    this.bufferedBytes = 2
                    start = i
                    i++
                }
            }
        }
        if (this.inOSC) {
            // Retain only the fragment, not a view pinning its entire input buffer.
            // Concatenate once on completion, not on every incoming chunk.
            this.chunks.push(Buffer.from(data.subarray(start)))
        } else if (start < data.length) {
            output.push(data.subarray(start))
        }
        if (output.length) {
            super.feedFromSession(Buffer.concat(output))
        }
    }

    private processOSC (sequence: Buffer, suffixLength: number, output: Buffer[]): void {
        const [code, ...params] = sequence.subarray(2, -suffixLength).toString().split(';')
        if (code === '1337') {
            const param = params.join(';')
            if (param.startsWith('CurrentDir=')) {
                const cwd = param.substring('CurrentDir='.length)
                this.cwdReported.next(cwd.startsWith('~') ? os.homedir() + cwd.substring(1) : cwd)
            }
        } else if (code === '52') {
            if ((params[0] === 'c' || params[0] === '') && params.length > 1 && params[1] !== '?') {
                this.copyRequested.next(Buffer.from(params[1], 'base64').toString())
            }
        } else {
            output.push(sequence)
        }
    }

    private resetOSC (): void {
        this.chunks = []
        this.bufferedBytes = 0
        this.inOSC = false
        this.oscEscape = false
    }

    close (): void {
        this.resetOSC()
        this.pendingEscape = false
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }
}
