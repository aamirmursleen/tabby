import { readKeychainCredential } from './keychainCredential'

const PLANE_ORIGIN = 'https://portal.whitelabel.com.pk'
const PLANE_KEYCHAIN_SERVICE = 'com.aamirmursleen.terminal.plane-api'
const PLANE_KEYCHAIN_ACCOUNT = 'portal-whitelabel'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 5 * 60_000
const MAX_PROJECTS = 30
const MAX_WORK_ITEMS = 250
const WORK_ITEMS_PER_PAGE = 100
const MAX_PAGES_PER_PROJECT = Math.ceil(MAX_WORK_ITEMS / WORK_ITEMS_PER_PAGE)
const REQUEST_CONCURRENCY = 5

export interface PlaneWorkspaceWorkItem {
    id: string
    title: string
    state: 'backlog'|'todo'|'in_progress'|'done'|'cancelled'|'blocked'
    priority: 'urgent'|'high'|'medium'|'low'|'none'
    assignee?: string
    module?: string
    dueDate?: string
    createdAt?: string
    updatedAt?: string
}

const cachedWorkItems = new Map<string, { expiresAt: number, value: PlaneWorkspaceWorkItem[] }>()
const activeRequests = new Map<string, Promise<PlaneWorkspaceWorkItem[]>>()

function record (value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function records (value: unknown): Record<string, any>[] {
    const response = record(value)
    const rows = Array.isArray(value) ? value : response.results ?? response.data
    return Array.isArray(rows)
        ? rows.filter(item => item && typeof item === 'object' && !Array.isArray(item))
        : []
}

function text (value: unknown, max = 200): string {
    return typeof value === 'string' ? value.trim().replace(/[\0\r\n]/g, ' ').slice(0, max) : ''
}

function normalizeState (value: unknown): PlaneWorkspaceWorkItem['state'] {
    const state = record(value)
    const group = text(state.group, 40).toLocaleLowerCase()
    const name = text(state.name, 80).toLocaleLowerCase()
    if (name.includes('block')) { return 'blocked' }
    if (group === 'completed') { return 'done' }
    if (group === 'cancelled' || name.includes('cancel')) { return 'cancelled' }
    if (group === 'started') { return 'in_progress' }
    if (group === 'backlog') { return 'backlog' }
    return 'todo'
}

function normalizePriority (value: unknown): PlaneWorkspaceWorkItem['priority'] {
    return ['urgent', 'high', 'medium', 'low'].includes(value as string)
        ? value as PlaneWorkspaceWorkItem['priority']
        : 'none'
}

function assigneeName (value: unknown): string {
    const assignee = record(value)
    const fullName = [text(assignee.first_name, 80), text(assignee.last_name, 80)].filter(Boolean).join(' ')
    return fullName || text(assignee.display_name, 120)
}

export function sanitizePlaneWorkItems (
    projectValue: unknown,
    itemsValue: unknown,
): PlaneWorkspaceWorkItem[] {
    const project = record(projectValue)
    const projectName = text(project.name, 120)
    const identifier = text(project.identifier, 40).replace(/[^A-Za-z0-9_-]/g, '')
    return records(itemsValue).slice(0, MAX_WORK_ITEMS).flatMap(item => {
        const title = text(item.name, 500)
        const sequence = Number.isFinite(Number(item.sequence_id)) ? Math.max(0, Math.floor(Number(item.sequence_id))) : 0
        const fallbackID = text(item.id, 80)
        const id = identifier && sequence ? `${identifier}-${sequence}` : fallbackID
        if (!id || !title) { return [] }
        const normalized: PlaneWorkspaceWorkItem = {
            id,
            title,
            state: normalizeState(item.state),
            priority: normalizePriority(item.priority),
        }
        const assignees = Array.isArray(item.assignees)
            ? item.assignees.map(assigneeName).filter(Boolean).slice(0, 3)
            : []
        if (assignees.length) { normalized.assignee = assignees.join(', ') }
        if (projectName) { normalized.module = projectName }
        const dueDate = text(item.target_date, 32)
        if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) { normalized.dueDate = dueDate }
        const createdAt = text(item.created_at, 64)
        const updatedAt = text(item.updated_at, 64)
        if (createdAt && Number.isFinite(Date.parse(createdAt))) { normalized.createdAt = createdAt }
        if (updatedAt && Number.isFinite(Date.parse(updatedAt))) { normalized.updatedAt = updatedAt }
        return [normalized]
    })
}

async function loadPlaneCredential (): Promise<string> {
    let credential: string|null = null
    try {
        credential = await readKeychainCredential(PLANE_KEYCHAIN_SERVICE, PLANE_KEYCHAIN_ACCOUNT)
    } catch {
        throw new Error('Aamir Terminal could not read its Plane API key from macOS Keychain.')
    }
    if (!credential || !/^plane_api_[A-Za-z0-9_-]{16,512}$/.test(credential)) {
        throw new Error('The Plane API key is not installed in macOS Keychain.')
    }
    return credential
}

async function readPlaneJSON (path: string, credential: string): Promise<unknown> {
    if (!/^\/api\/v1\/workspaces\/[a-z0-9][a-z0-9-]{0,119}\/projects\/(?:\?[^#]*|[0-9a-f-]{36}\/work-items\/\?[^#]*)$/.test(path)) {
        throw new Error('Blocked an unexpected Plane API path.')
    }
    const url = new URL(path, PLANE_ORIGIN)
    if (url.origin !== PLANE_ORIGIN || !url.pathname.startsWith('/api/v1/workspaces/')) {
        throw new Error('Blocked an unexpected Plane API URL.')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const response = await fetch(url.toString(), {
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: { Accept: 'application/json', 'X-API-Key': credential },
        })
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('Plane rejected the saved API key.')
            }
            if (response.status === 429) {
                const retryAfter = Math.min(300, Math.max(1, Number(response.headers.get('retry-after')) || 30))
                throw new Error(`Plane is temporarily rate limited. Try syncing again in ${retryAfter} seconds.`)
            }
            if (response.status === 404) { throw new Error('Plane could not find this workspace or project.') }
            throw new Error(`Plane API returned HTTP ${response.status}.`)
        }
        if (new URL(response.url).origin !== PLANE_ORIGIN) {
            throw new Error('Blocked a Plane API response from an unexpected origin.')
        }
        const declaredLength = Number(response.headers.get('content-length'))
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
            throw new Error('Plane API response exceeded the safe size limit.')
        }
        const body = await response.arrayBuffer()
        if (body.byteLength > MAX_RESPONSE_BYTES) {
            throw new Error('Plane API response exceeded the safe size limit.')
        }
        try {
            return JSON.parse(Buffer.from(body).toString('utf8'))
        } catch {
            throw new Error('Plane API returned invalid JSON.')
        }
    } catch (error) {
        if (controller.signal.aborted) { throw new Error('Plane API request timed out.') }
        throw error
    } finally {
        clearTimeout(timeout)
    }
}

async function fetchPlaneWorkspaceWorkItems (workspaceSlug: string, projectId = ''): Promise<PlaneWorkspaceWorkItem[]> {
    const credential = await loadPlaneCredential()
    const workspaceProjects = records(await readPlaneJSON(
        `/api/v1/workspaces/${workspaceSlug}/projects/?per_page=100`,
        credential,
    ))
    const projects = projectId
        ? workspaceProjects.filter(project => text(project.id, 80).toLocaleLowerCase() === projectId).slice(0, 1)
        : workspaceProjects.slice(0, MAX_PROJECTS)
    if (projectId && !projects.length) { throw new Error('Plane could not find the project from this link.') }
    const items: PlaneWorkspaceWorkItem[] = []
    for (let index = 0; index < projects.length && items.length < MAX_WORK_ITEMS; index += REQUEST_CONCURRENCY) {
        const batch = projects.slice(index, index + REQUEST_CONCURRENCY)
        const responses = await Promise.all(batch.map(async project => {
            const projectID = text(project.id, 80).toLocaleLowerCase()
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectID)) { return [] }
            const projectItems: PlaneWorkspaceWorkItem[] = []
            let cursor = ''
            const seenCursors = new Set<string>()
            for (let page = 0; page < MAX_PAGES_PER_PROJECT && projectItems.length < MAX_WORK_ITEMS; page++) {
                const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
                const response = await readPlaneJSON(
                    `/api/v1/workspaces/${workspaceSlug}/projects/${projectID}/work-items/?per_page=${WORK_ITEMS_PER_PAGE}&expand=state%2Cassignees&order_by=-updated_at${cursorQuery}`,
                    credential,
                )
                const pageItems = sanitizePlaneWorkItems(project, response)
                projectItems.push(...pageItems)
                const nextCursor = text(record(response).next_cursor, 512)
                if (pageItems.length < WORK_ITEMS_PER_PAGE || !nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
                    break
                }
                seenCursors.add(nextCursor)
                cursor = nextCursor
            }
            return projectItems.slice(0, MAX_WORK_ITEMS)
        }))
        for (const responseItems of responses) { items.push(...responseItems) }
    }
    const stateRank: Record<PlaneWorkspaceWorkItem['state'], number> = {
        blocked: 0, in_progress: 1, todo: 2, backlog: 3, done: 4, cancelled: 5,
    }
    return items.slice(0, MAX_WORK_ITEMS).sort((a, b) => stateRank[a.state] - stateRank[b.state])
}

export async function loadPlaneWorkspaceWorkItems (
    workspaceSlugValue: unknown,
    force = false,
    projectIdValue: unknown = '',
): Promise<PlaneWorkspaceWorkItem[]> {
    const workspaceSlug = text(workspaceSlugValue, 120).toLocaleLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(workspaceSlug)) {
        throw new Error('Blocked an invalid Plane workspace identifier.')
    }
    const projectId = text(projectIdValue, 80).toLocaleLowerCase()
    if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
        throw new Error('Blocked an invalid Plane project identifier.')
    }
    const cacheKey = `${workspaceSlug}\0${projectId}`
    const cached = cachedWorkItems.get(cacheKey)
    if (!force && cached && cached.expiresAt > Date.now()) { return cached.value }
    const active = activeRequests.get(cacheKey)
    if (active) { return active }
    const operation = fetchPlaneWorkspaceWorkItems(workspaceSlug, projectId)
    activeRequests.set(cacheKey, operation)
    try {
        const value = await operation
        cachedWorkItems.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
        return value
    } finally {
        activeRequests.delete(cacheKey)
    }
}
