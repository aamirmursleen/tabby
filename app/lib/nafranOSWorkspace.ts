import * as keytar from 'keytar'

const NAFRAN_OS_ORIGIN = 'https://os.nafran.com'
const KEYCHAIN_SERVICE = 'com.aamirmursleen.terminal.nafran-os-api'
const KEYCHAIN_ACCOUNT = 'cloudflare-access-service-token'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 45_000
const ALLOWED_PATHS = new Set([
    '/api/agent-control/snapshot',
    '/api/agent-control/shopify',
    '/data/operator-profile.json',
])

interface AccessCredential {
    clientId: string
    clientSecret: string
}

export interface NafranOSWorkspaceFeeds {
    snapshot: unknown
    shopify: unknown
    profile: unknown
}

let cachedFeeds: { expiresAt: number, value: NafranOSWorkspaceFeeds }|null = null
let activeRequest: Promise<NafranOSWorkspaceFeeds>|null = null

async function loadNafranCredential (): Promise<AccessCredential> {
    let stored: string|null = null
    try {
        stored = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    } catch {
        throw new Error('Aamir Terminal could not read its Nafran OS API credential from macOS Keychain.')
    }
    if (!stored) {
        throw new Error('The Nafran OS API credential is not installed in macOS Keychain.')
    }
    try {
        const value = JSON.parse(stored) as Partial<AccessCredential>
        if (typeof value.clientId !== 'string' || value.clientId.length < 16 || value.clientId.length > 512
            || typeof value.clientSecret !== 'string' || value.clientSecret.length < 16 || value.clientSecret.length > 512) {
            throw new Error('invalid credential')
        }
        return { clientId: value.clientId, clientSecret: value.clientSecret }
    } catch {
        throw new Error('The Nafran OS API credential in macOS Keychain is invalid.')
    }
}

async function readNafranJSON (path: string, credential: AccessCredential): Promise<unknown> {
    if (!ALLOWED_PATHS.has(path)) { throw new Error('Blocked an unexpected Nafran OS API path.') }
    const url = new URL(path, NAFRAN_OS_ORIGIN)
    if (url.origin !== NAFRAN_OS_ORIGIN || url.pathname !== path) {
        throw new Error('Blocked an unexpected Nafran OS API URL.')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'CF-Access-Client-Id': credential.clientId,
                'CF-Access-Client-Secret': credential.clientSecret,
            },
        })
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('Nafran OS rejected the saved API credential.')
            }
            throw new Error(`Nafran OS API returned HTTP ${response.status}.`)
        }
        if (new URL(response.url).origin !== NAFRAN_OS_ORIGIN) {
            throw new Error('Blocked a Nafran OS API response from an unexpected origin.')
        }
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            throw new Error('Nafran OS API response exceeded the safe size limit.')
        }
        const body = await response.arrayBuffer()
        if (body.byteLength > MAX_RESPONSE_BYTES) {
            throw new Error('Nafran OS API response exceeded the safe size limit.')
        }
        try {
            return JSON.parse(Buffer.from(body).toString('utf8'))
        } catch {
            throw new Error('Nafran OS API returned invalid JSON.')
        }
    } catch (error) {
        if (controller.signal.aborted) { throw new Error('Nafran OS API request timed out.') }
        throw error
    } finally {
        clearTimeout(timeout)
    }
}

async function fetchNafranOSWorkspaceFeeds (): Promise<NafranOSWorkspaceFeeds> {
    const credential = await loadNafranCredential()
    const [snapshot, shopify, profile] = await Promise.all([
        readNafranJSON('/api/agent-control/snapshot', credential),
        readNafranJSON('/api/agent-control/shopify', credential),
        readNafranJSON('/data/operator-profile.json', credential),
    ])
    return { snapshot, shopify, profile }
}

export async function loadNafranOSWorkspaceFeeds (force = false): Promise<NafranOSWorkspaceFeeds> {
    if (!force && cachedFeeds && cachedFeeds.expiresAt > Date.now()) { return cachedFeeds.value }
    if (activeRequest) { return activeRequest }
    activeRequest = fetchNafranOSWorkspaceFeeds()
    try {
        const value = await activeRequest
        cachedFeeds = { expiresAt: Date.now() + CACHE_TTL_MS, value }
        return value
    } finally {
        activeRequest = null
    }
}
