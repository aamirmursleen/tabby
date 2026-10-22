import * as keytar from 'keytar'
import { execFile } from 'mz/child_process'

const KEYCHAIN_READ_TIMEOUT_MS = 5_000
const MAX_KEYCHAIN_OUTPUT_BYTES = 4 * 1024

export async function readKeychainCredential (service: string, account: string): Promise<string|null> {
    if (process.platform !== 'darwin') {
        return keytar.getPassword(service, account)
    }

    try {
        const [stdout] = await execFile('/usr/bin/security', [
            'find-generic-password', '-w', '-a', account, '-s', service,
        ], {
            timeout: KEYCHAIN_READ_TIMEOUT_MS,
            maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES,
            encoding: 'utf8',
        })
        return stdout.toString().trim() || null
    } catch (error) {
        if ((error as { code?: unknown })?.code === 44) { return null }
        throw error
    }
}
