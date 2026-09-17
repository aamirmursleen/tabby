import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { ConfigService, FileProvider, PlatformService } from 'tabby-core'
import * as russh from 'russh'

export const SSH_KEY_REF_PREFIX = 'ssh-key://'

export type SSHGeneratedKeyType = 'ed25519'|'rsa'

export interface SSHStoredKey {
    id: string
    label: string
    type: string
    fingerprint: string
    publicKey: string
    createdAt: number
    updatedAt: number
}

export interface SSHSavedKey {
    key: SSHStoredKey
    ref: string
}

@Injectable({ providedIn: 'root' })
export class SSHKeyStorageService {
    private static encryptedPrivateKeyErrors = new Set([
        'Error: Keys(KeyIsEncrypted)',
        'Error: Keys(SshKey(Ppk(Encrypted)))',
        'Error: Keys(SshKey(Ppk(IncorrectMac)))',
        'Error: Keys(SshKey(Crypto))',
        'Error: Keys(Pkcs8(EncryptedPrivateKey(DecryptFailed)))',
    ])

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
    ) { }

    get keys (): SSHStoredKey[] {
        this.ensureConfig()
        return [...this.config.store.ssh.keys]
            .filter((key: Partial<SSHStoredKey>) => this.isValidMetadata(key))
            .sort((a: SSHStoredKey, b: SSHStoredKey) => a.label.localeCompare(b.label))
    }

    getByID (id: string): SSHStoredKey|null {
        this.ensureConfig()
        return this.config.store.ssh.keys.find((key: SSHStoredKey) => key.id === id) ?? null
    }

    getByRef (ref: string): SSHStoredKey|null {
        const parsed = this.parseRef(ref)
        return parsed ? this.getByID(parsed.id) : null
    }

    makeRef (id: string): string {
        return `${SSH_KEY_REF_PREFIX}${id}`
    }

    isKeyRef (ref: string): boolean {
        return !!this.parseRef(ref)
    }

    getLabel (ref: string): string {
        const key = this.getByRef(ref)
        if (!key) {
            return ref
        }
        return key.type ? `${key.label} (${key.type})` : key.label
    }

    async savePrivateKey (label: string, privateKey: string): Promise<SSHSavedKey> {
        const normalizedLabel = this.validateLabel(label)
        this.validateUniqueLabel(normalizedLabel)
        const normalizedKey = this.normalizePrivateKey(privateKey)
        const metadata = await this.inspectPrivateKey(normalizedKey, normalizedLabel)
        const id = crypto.randomUUID()
        const now = Date.now()
        const key: SSHStoredKey = {
            id,
            label: normalizedLabel,
            type: metadata.type,
            fingerprint: metadata.fingerprint,
            publicKey: metadata.publicKey,
            createdAt: now,
            updatedAt: now,
        }

        await this.writePrivateKey(id, normalizedKey)
        try {
            await this.replaceKeys([...this.config.store.ssh.keys, key])
        } catch (error) {
            await fs.unlink(this.getKeyPath(id)).catch(unlinkError => {
                if (unlinkError?.code !== 'ENOENT') {
                    throw unlinkError
                }
            })
            throw error
        }
        return { key, ref: this.makeRef(id) }
    }

    async generateKey (label: string, type: SSHGeneratedKeyType = 'ed25519'): Promise<SSHSavedKey> {
        const privateKey = type === 'rsa'
            ? crypto.generateKeyPairSync('rsa', {
                modulusLength: 4096,
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' },
            }).privateKey
            : crypto.generateKeyPairSync('ed25519', {
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                publicKeyEncoding: { type: 'spki', format: 'pem' },
            }).privateKey
        return this.savePrivateKey(label, privateKey)
    }

    async importPrivateKeyFromUpload (label?: string): Promise<SSHSavedKey|null> {
        const uploads = await this.platform.startUpload({ multiple: false })
        if (!uploads.length) {
            return null
        }
        const upload = uploads[0]
        const contents = Buffer.from(await upload.readAll()).toString('utf-8')
        return this.savePrivateKey(label ?? upload.getName(), contents)
    }

    async renameKey (id: string, label: string): Promise<void> {
        const normalizedLabel = this.validateLabel(label)
        this.validateUniqueLabel(normalizedLabel, id)
        const key = this.getByID(id)
        if (!key) {
            throw new Error('SSH key not found')
        }
        await this.replaceKeys(this.config.store.ssh.keys.map((entry: SSHStoredKey) => entry.id === id ? {
            ...entry,
            label: normalizedLabel,
            updatedAt: Date.now(),
        } : entry))
    }

    async deleteKey (id: string): Promise<void> {
        const key = this.getByID(id)
        if (!key) {
            return
        }
        await this.replaceKeys(this.config.store.ssh.keys.filter((entry: SSHStoredKey) => entry.id !== id))
        await fs.unlink(this.getKeyPath(id)).catch(error => {
            if (error?.code !== 'ENOENT') {
                throw error
            }
        })
    }

    async retrievePrivateKey (ref: string): Promise<Buffer> {
        const parsed = this.parseRef(ref)
        if (!parsed) {
            throw new Error('Incorrect type')
        }
        const key = this.getByID(parsed.id)
        if (!key) {
            throw new Error('SSH key not found')
        }
        if (parsed.publicKey) {
            if (!key.publicKey) {
                throw new Error('Public key is not available')
            }
            return Buffer.from(`${key.publicKey}\n`)
        }
        return fs.readFile(this.getKeyPath(parsed.id), { encoding: null })
    }

    copyPublicKey (id: string): void {
        const key = this.getByID(id)
        if (!key?.publicKey) {
            throw new Error('Public key is not available')
        }
        this.platform.setClipboard({ text: key.publicKey })
    }

    getPrivateKeyPath (id: string): string {
        return this.getKeyPath(id)
    }

    getKeyPathForTest (id: string): string {
        return this.getPrivateKeyPath(id)
    }

    private async replaceKeys (keys: SSHStoredKey[]): Promise<void> {
        this.ensureConfig()
        const previous = this.config.store.ssh.keys
        this.config.store.ssh.keys = keys
        try {
            await this.config.save()
        } catch (error) {
            this.config.store.ssh.keys = previous
            throw error
        }
    }

    private async writePrivateKey (id: string, contents: string): Promise<void> {
        const directory = this.getKeyDirectory()
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        await fs.chmod(directory, 0o700).catch(() => null)
        const target = this.getKeyPath(id)
        const temp = path.join(directory, `.${id}.${crypto.randomBytes(8).toString('hex')}.tmp`)
        await fs.writeFile(temp, contents, { mode: 0o600 })
        await fs.chmod(temp, 0o600).catch(() => null)
        await fs.rename(temp, target)
        await fs.chmod(target, 0o600).catch(() => null)
    }

    private getKeyPath (id: string): string {
        if (!/^[a-f0-9-]{36}$/.test(id)) {
            throw new Error('Invalid SSH key id')
        }
        return path.join(this.getKeyDirectory(), id)
    }

    private getKeyDirectory (): string {
        const configPath = this.platform.getConfigPath()
        if (!configPath) {
            throw new Error('SSH key storage is not available on this platform')
        }
        return path.join(path.dirname(configPath), 'ssh-keys')
    }

    private parseRef (ref: string): { id: string, publicKey: boolean }|null {
        if (!ref.startsWith(SSH_KEY_REF_PREFIX)) {
            return null
        }
        let id = ref.substring(SSH_KEY_REF_PREFIX.length)
        let publicKey = false
        if (id.endsWith('.pub')) {
            id = id.substring(0, id.length - '.pub'.length)
            publicKey = true
        }
        if (!/^[a-f0-9-]{36}$/.test(id)) {
            return null
        }
        return { id, publicKey }
    }

    private normalizePrivateKey (privateKey: string): string {
        const normalized = privateKey.replace(/\r\n/g, '\n').trim()
        if (!normalized) {
            throw new Error('Paste a private key')
        }
        return `${normalized}\n`
    }

    private async inspectPrivateKey (privateKey: string, label: string): Promise<{ type: string, fingerprint: string, publicKey: string }> {
        try {
            russh.parsePublicKey(privateKey)
            throw new Error('Paste a private key, not a public key')
        } catch (error) {
            if (String(error).includes('not a public key')) {
                throw error
            }
        }

        try {
            const keyPair = await russh.KeyPair.parse(privateKey, privateKey.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') ? '' : undefined)
            const publicKey = keyPair['inner'].publicKey()
            const comment = label.replace(/\s+/g, '-')
            return {
                type: publicKey.algorithm(),
                fingerprint: publicKey.fingerprint(),
                publicKey: `${publicKey.algorithm()} ${publicKey.base64()} ${comment}`,
            }
        } catch (error) {
            if (SSHKeyStorageService.encryptedPrivateKeyErrors.has(String(error)) && /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(privateKey)) {
                return {
                    type: 'encrypted',
                    fingerprint: '',
                    publicKey: '',
                }
            }
            throw new Error(`Could not read the private key: ${error}`)
        }
    }

    private validateLabel (label: string): string {
        const normalized = label.trim()
        if (!normalized || normalized.length > 100) {
            throw new Error('Enter a key name of 1-100 characters.')
        }
        return normalized
    }

    private validateUniqueLabel (label: string, id?: string): void {
        this.ensureConfig()
        if (this.config.store.ssh.keys.some((key: SSHStoredKey) => key.id !== id && key.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
            throw new Error('An SSH key with this name already exists.')
        }
    }

    private ensureConfig (): void {
        this.config.store.ssh ??= {}
        this.config.store.ssh.keys ??= []
    }

    private isValidMetadata (key: Partial<SSHStoredKey>): key is SSHStoredKey {
        return typeof key.id === 'string' && typeof key.label === 'string'
            && typeof key.type === 'string' && typeof key.createdAt === 'number'
            && typeof key.updatedAt === 'number'
    }
}

@Injectable()
export class SSHKeyFileProvider extends FileProvider {
    name = 'SSH key library'

    constructor (
        private keys: SSHKeyStorageService,
    ) {
        super()
    }

    async isAvailable (): Promise<boolean> {
        return false
    }

    async selectAndStoreFile (): Promise<string> {
        throw new Error('Select saved SSH keys from the SSH profile settings')
    }

    async retrieveFile (key: string): Promise<Buffer> {
        if (!this.keys.isKeyRef(key)) {
            throw new Error('Incorrect type')
        }
        return this.keys.retrievePrivateKey(key)
    }
}
