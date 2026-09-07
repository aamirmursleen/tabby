/** Coalesces PTY acknowledgements without acknowledging unconsumed output. */
export class OutputAcknowledgements {
    private pendingBytes = 0
    private draining = false
    private closed = false

    constructor (
        private acknowledge: (bytes: number) => void,
        private waitForDrain: () => Promise<void>,
        private onError: (error: unknown) => void,
    ) { }

    push (bytes: number): void {
        if (this.closed || bytes <= 0) {
            return
        }
        this.pendingBytes += bytes
        if (!this.draining) {
            this.drain()
        }
    }

    close (): void {
        this.closed = true
        this.pendingBytes = 0
    }

    private async drain (): Promise<void> {
        this.draining = true
        try {
            while (this.pendingBytes && !this.closed) {
                const bytes = this.pendingBytes
                this.pendingBytes = 0
                await this.waitForDrain()
                // close() can run while the consumer is draining.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (!this.closed) {
                    this.acknowledge(bytes)
                }
            }
        } catch (error) {
            this.close()
            this.onError(error)
        } finally {
            this.draining = false
        }
    }
}
