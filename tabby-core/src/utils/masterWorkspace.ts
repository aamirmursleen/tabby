import type { ConnectionProject, ConnectionProjectItem, ConnectionPriority } from './connectionProjects'

export type MasterWorkspaceKnowledgeStatus = 'fresh'|'aging'|'stale'|'conflict'|'missing'|'unknown'
export type MasterWorkspacePlaneStatus = 'live'|'offline'|'failing'|'unmapped'
export type MasterWorkspaceWorkItemState = 'backlog'|'todo'|'in_progress'|'done'|'cancelled'|'blocked'
export type MasterWorkspaceWorkItemPriority = 'urgent'|'high'|'medium'|'low'|'none'

export interface MasterWorkspaceWorkItem {
    id: string
    title: string
    state: MasterWorkspaceWorkItemState
    priority: MasterWorkspaceWorkItemPriority
    assignee?: string
    module?: string
    dueDate?: string
    blockedBy?: string
}

export interface MasterWorkspaceWorkSummary {
    total: number
    completed: number
    blocked: number
    overdue: number
    items?: MasterWorkspaceWorkItem[]
}

export interface MasterWorkspaceRevenueSummary {
    currency: string
    currentMonthly: number
    history: { month: string, amount: number }[]
    status: 'live'|'manual'|'stale'|'unmapped'
    source?: string
    updatedAt?: string
}

export interface MasterWorkspaceProjectMetadata {
    priority?: ConnectionPriority
    description?: string
    notes?: string
    work?: MasterWorkspaceWorkSummary
    revenue?: MasterWorkspaceRevenueSummary
    knowledge?: {
        path: string
        status: MasterWorkspaceKnowledgeStatus
        updatedAt?: string
    }
    plane?: {
        status: MasterWorkspacePlaneStatus
        identifier?: string
        projectId?: string
        updatedAt?: string
    }
    links?: { label: string, url: string }[]
    health?: 'healthy'|'degraded'|'down'|'unknown'
    lastActivityAt?: string
}

export interface MasterWorkspaceAttentionReason {
    kind: 'health'|'plane'|'blocked'|'overdue'|'tmux'|'priority'
    label: string
    score: number
}

export interface MasterWorkspaceProject<T = any> extends ConnectionProject<T> {
    metadata: Required<Pick<MasterWorkspaceProjectMetadata, 'description'|'notes'|'work'|'revenue'|'knowledge'|'plane'|'links'|'health'>> & Pick<MasterWorkspaceProjectMetadata, 'lastActivityAt'>
    progress: number
    openWork: number
    attention: {
        score: number
        band: 'attention'|'watch'|'steady'
        reasons: MasterWorkspaceAttentionReason[]
    }
}

export interface MasterWorkspaceSearchResult<T = any> {
    key: string
    kind: 'action'|'project'|'connection'
    label: string
    detail: string
    icon: string
    project?: MasterWorkspaceProject<T>
    connection?: ConnectionProjectItem<T>
    action?: 'overview'|'work'|'knowledge'|'connections'|'settings'
}

export interface MasterWorkspaceRemoteSnapshot {
    schemaVersion: 1
    generatedAt: string
    source?: string
    projects: (MasterWorkspaceProjectMetadata & {
        id?: string
        name?: string
        aliases?: string[]
    })[]
}

/**
 * Converts the sanitized Nafran OS dashboard feeds into the small project-only
 * payload consumed by Master Workspace. Transaction records and account data
 * never leave the provider.
 */
export function buildNafranOSWorkspaceSnapshot (
    snapshotValue: unknown,
    shopifyValue: unknown,
    profileValue: unknown,
    now = new Date(),
): MasterWorkspaceRemoteSnapshot {
    const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : {}
    const list = (value: unknown): Record<string, any>[] => Array.isArray(value)
        ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 250)
        : []
    const identity = (value: unknown): string => typeof value === 'string'
        ? value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 160)
        : ''
    const text = (value: unknown, fallback = ''): string => typeof value === 'string'
        ? value.trim().slice(0, 200)
        : fallback
    const count = (value: unknown): number => Number.isFinite(Number(value))
        ? Math.max(0, Math.floor(Number(value)))
        : 0
    const validDate = (value: unknown): string|undefined => typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? value
        : undefined

    const snapshot = object(snapshotValue)
    const shopify = object(shopifyValue)
    const profile = object(profileValue)
    const aliases = object(profile.project_aliases)
    const aliasesByIdentity = new Map<string, string>()
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (typeof canonical === 'string') { aliasesByIdentity.set(identity(alias), canonical) }
    }
    const canonicalName = (value: unknown): string => {
        const name = text(value, 'Unknown project')
        const configured = aliasesByIdentity.get(identity(name))
        if (configured) { return configured }
        if (/^mamasign(?:dev|marketing)$/i.test(identity(name))) { return 'MamaSign' }
        return name
    }

    const businessByIdentity = new Map<string, Record<string, any>>()
    for (const item of list(profile.business_scope)) {
        const key = identity(item.project)
        if (key) { businessByIdentity.set(key, item) }
    }
    const signals = list(snapshot.project_signals)
    const signalFor = (workspace: Record<string, any>): Record<string, any> => signals.find(signal =>
        identity(signal.slug) === identity(workspace.slug)
        || identity(signal.workspace) === identity(workspace.label),
    ) ?? {}
    const projectsByIdentity = new Map<string, MasterWorkspaceRemoteSnapshot['projects'][number]>()
    const ensureProject = (nameValue: unknown, idValue?: unknown): MasterWorkspaceRemoteSnapshot['projects'][number] => {
        const name = canonicalName(nameValue)
        const id = identity(idValue) || identity(name)
        const key = identity(name) || id
        let project = projectsByIdentity.get(key)
        if (!project) {
            project = { id, name, aliases: [] }
            projectsByIdentity.set(key, project)
        }
        const alias = text(nameValue)
        if (alias && alias !== name && !project.aliases?.includes(alias)) { project.aliases?.push(alias) }
        return project
    }

    for (const workspace of list(object(snapshot.plane).workspaces)) {
        const project = ensureProject(workspace.label, workspace.slug)
        const signal = signalFor(workspace)
        const total = count(signal.work_items_total ?? workspace.work_items_total)
        const open = Math.min(total, count(signal.work_items_open ?? workspace.work_items_open))
        const sampledProjects = list(workspace.projects)
        const hasCompleteStateCounts = sampledProjects.length > 0 && sampledProjects.every(item =>
            object(item.by_state_group).completed !== undefined
            && count(item.work_items_sampled) === count(item.work_items_total),
        )
        const completed = Math.min(total, hasCompleteStateCounts
            ? sampledProjects.reduce((sum, item) => sum + count(object(item.by_state_group).completed), 0)
            : count(signal.work_items_completed_or_cancelled ?? workspace.work_items_completed_or_cancelled ?? total - open))
        project.work = { total, completed, blocked: 0, overdue: 0 }

        const connected = workspace.state === 'connected'
        const updatedAt = validDate(signal.latest_work_update) ?? validDate(workspace.latest_update)
        project.plane = {
            status: connected ? 'live' : 'failing',
            identifier: text(workspace.slug || workspace.label).toLocaleUpperCase().slice(0, 32),
        }
        if (updatedAt) { project.plane.updatedAt = updatedAt }
        const checks = list(signal.public_checks)
        const checkStates = checks.map(check => text(check.status).toLocaleLowerCase())
        const deploymentWarnings = count(signal.deployment_warnings)
        project.health = !connected
            ? 'degraded'
            : checkStates.some(state => ['critical', 'down', 'failed', 'error'].includes(state))
                ? 'down'
                : deploymentWarnings > 0 || checkStates.some(state => state && !['ok', 'not_connected'].includes(state))
                    ? 'degraded'
                    : 'healthy'
        if (updatedAt) { project.lastActivityAt = updatedAt }
    }

    const currentMonth = now.toISOString().slice(0, 7)
    for (const store of list(shopify.stores)) {
        const name = canonicalName(store.project || store.store)
        const project = ensureProject(name, store.store)
        const business = businessByIdentity.get(identity(name)) ?? businessByIdentity.get(identity(store.project))
        const ownership = Number(business?.equity_pct)
        if (!Number.isFinite(ownership) || ownership < 0 || ownership > 100) { continue }
        const currency = /^[A-Z]{3}$/.test(text(store.currency).toUpperCase()) ? text(store.currency).toUpperCase() : 'USD'
        const history = list(store.monthly).slice(-12).flatMap(month => {
            const monthKey = text(month.month)
            if (!/^\d{4}-\d{2}$/.test(monthKey)) { return [] }
            const currencyAmounts = object(object(month.amounts_by_currency)[currency])
            const gross = Number(currencyAmounts.received_less_refunds)
            if (!Number.isFinite(gross)) { return [{ month: monthKey, amount: 0 }] }
            return [{ month: monthKey, amount: Math.max(0, Math.round(gross * ownership) / 100) }]
        })
        const currentAmount = history.find(item => item.month === currentMonth)?.amount ?? history.at(-1)?.amount ?? 0
        const updatedAt = validDate(store.generated_at) ?? validDate(shopify.generated_at)
        project.revenue = {
            currency,
            currentMonthly: currentAmount,
            history,
            status: store.ok === true && store.state === 'connected' ? 'live' : 'stale',
            source: `Nafran OS API · Shopify owner share (${ownership}%)`,
        }
        if (updatedAt) { project.revenue.updatedAt = updatedAt }
        if (updatedAt && (!project.lastActivityAt || Date.parse(updatedAt) > Date.parse(project.lastActivityAt))) {
            project.lastActivityAt = updatedAt
        }
    }

    const generatedAt = [snapshot.generated_at, shopify.generated_at]
        .map(validDate)
        .filter((value): value is string => !!value)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? now.toISOString()
    return {
        schemaVersion: 1,
        generatedAt,
        source: 'Nafran OS API',
        projects: [...projectsByIdentity.values()],
    }
}

export function organizeFounderProjects<T> (projects: readonly ConnectionProject<T>[]): ConnectionProject<T>[] {
    const catalog: { id: string, name: string, priority: ConnectionPriority, aliases: string[] }[] = [
        { id: 'mamasign', name: 'MamaSign', priority: 1, aliases: ['mamasign', 'mama sign'] },
        { id: 'calendarjet', name: 'CalendarJet', priority: 1, aliases: ['calendarjet', 'calendar jet', 'cj'] },
        { id: 'wittyform', name: 'Wittyform', priority: 1, aliases: ['wittyform', 'witty form'] },
        { id: 'hiringcat', name: 'HiringCat', priority: 2, aliases: ['hiringcat', 'hiring cat'] },
        { id: 'huntcat', name: 'HuntCat', priority: 2, aliases: ['huntcat', 'hunt cat'] },
        { id: 'authoritycat', name: 'AuthorityCat / Meuo', priority: 2, aliases: ['authoritycat', 'authority cat', 'meuo'] },
        { id: 'wasecret', name: 'WASecret', priority: 2, aliases: ['wasecret', 'wa secret'] },
        { id: 'clarino', name: 'Clarino', priority: 3, aliases: ['clarino'] },
        { id: 'mamalead', name: 'MamaLead', priority: 2, aliases: ['mamalead', 'mama lead'] },
        { id: 'buzpo', name: 'Buzpo / NotifyStock', priority: 3, aliases: ['buzpo', 'notifystock', 'notify stock'] },
        { id: 'moonpush', name: 'MoonPush', priority: 3, aliases: ['moonpush', 'moon push'] },
        { id: 'lawtelligent', name: 'Lawtelligent', priority: 2, aliases: ['lawtelligent', 'law intelligent', 'law project'] },
        { id: 'prisma', name: 'Prisma', priority: 3, aliases: ['prisma'] },
        { id: 'customracesuit', name: 'CustomRaceSuit', priority: 3, aliases: ['customracesuit', 'custom race suit'] },
        { id: 'takmeel', name: 'Takmeel', priority: 4, aliases: ['takmeel', 'taqmeel'] },
        { id: 'niswa', name: 'Niswa', priority: 4, aliases: ['niswa'] },
        { id: 'xoobo', name: 'Xoobo', priority: 4, aliases: ['xoobo'] },
    ]
    const words = (value: string): string[] => value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const compact = (value: string): string => words(value).join('')
    const matches = (value: string, aliases: readonly string[]): boolean => {
        const valueWords = words(value)
        const valueCompact = valueWords.join('')
        return aliases.some(alias => {
            const aliasCompact = compact(alias)
            return aliasCompact.length <= 3 ? valueWords.includes(aliasCompact) : valueCompact.includes(aliasCompact)
        })
    }
    const claimed = new Set<string>()
    const organized: ConnectionProject<T>[] = catalog.map(spec => {
        const exactSources = projects.filter(project => matches(project.name, spec.aliases))
        const exactSourceIDs = new Set(exactSources.map(project => project.id))
        const connections: ConnectionProjectItem<T>[] = []
        for (const project of projects) {
            for (const connection of project.connections) {
                if (claimed.has(connection.key)) { continue }
                const text = `${connection.label} ${connection.profile?.name ?? ''}`
                if (exactSourceIDs.has(project.id) || matches(text, spec.aliases)) {
                    claimed.add(connection.key)
                    connections.push(connection)
                }
            }
        }
        const exact = projects.find(project => matches(project.name, spec.aliases))
        return {
            id: spec.id,
            name: spec.name,
            priority: exact ? Math.min(spec.priority, exact.priority) as ConnectionPriority : spec.priority,
            color: exact?.color ?? null,
            icon: exact?.icon ?? null,
            liveCount: connections.filter(connection => connection.kind === 'live').length,
            connections,
        }
    })
    const catalogSourceIDs = new Set(projects
        .filter(project => catalog.some(spec => matches(project.name, spec.aliases)))
        .map(project => project.id))
    const hiddenContainers = new Set(['fleetaccounts'])
    for (const project of projects) {
        const connections = project.connections.filter(connection => !claimed.has(connection.key))
        const preserveEmpty = project.id !== 'ungrouped'
            && !catalogSourceIDs.has(project.id)
            && !hiddenContainers.has(compact(project.name))
        if (connections.length || preserveEmpty) {
            organized.push({
                ...project,
                liveCount: connections.filter(connection => connection.kind === 'live').length,
                connections,
            })
        }
    }
    return organized
}

export function normalizeMasterWorkspaceMetadata (value: unknown): MasterWorkspaceProjectMetadata {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
    const result: MasterWorkspaceProjectMetadata = {}
    const cleanText = (text: unknown, max: number): string|undefined => {
        if (typeof text !== 'string' || /[\0\r\n]/.test(text) && max < 1000) { return undefined }
        const cleaned = text.trim().slice(0, max)
        return cleaned || undefined
    }
    const count = (number: unknown): number => Number.isFinite(number) ? Math.max(0, Math.floor(Number(number))) : 0

    const description = cleanText(input.description, 2000)
    const notes = cleanText(input.notes, 20000)
    if (description) { result.description = description }
    if (notes) { result.notes = notes }
    if (Number.isFinite(input.priority)) {
        result.priority = Math.min(4, Math.max(1, Math.floor(Number(input.priority)))) as ConnectionPriority
    }

    if (input.work && typeof input.work === 'object') {
        const total = count(input.work.total)
        const states = new Set<MasterWorkspaceWorkItemState>(['backlog', 'todo', 'in_progress', 'done', 'cancelled', 'blocked'])
        const priorities = new Set<MasterWorkspaceWorkItemPriority>(['urgent', 'high', 'medium', 'low', 'none'])
        const items: MasterWorkspaceWorkItem[] = Array.isArray(input.work.items)
            ? input.work.items.slice(0, 250).flatMap(item => {
                const id = cleanText(item?.id, 80)
                const title = cleanText(item?.title, 500)
                if (!id || !title) { return [] }
                const normalized: MasterWorkspaceWorkItem = {
                    id,
                    title,
                    state: states.has(item.state) ? item.state : 'todo',
                    priority: priorities.has(item.priority) ? item.priority : 'none',
                }
                const assignee = cleanText(item.assignee, 120)
                const module = cleanText(item.module, 120)
                const blockedBy = cleanText(item.blockedBy, 120)
                const dueDate = cleanText(item.dueDate, 64)
                if (assignee) { normalized.assignee = assignee }
                if (module) { normalized.module = module }
                if (blockedBy) { normalized.blockedBy = blockedBy }
                if (dueDate && Number.isFinite(Date.parse(dueDate))) { normalized.dueDate = dueDate }
                return [normalized]
            })
            : []
        result.work = {
            total,
            completed: Math.min(count(input.work.completed), total),
            blocked: Math.min(count(input.work.blocked), total),
            overdue: Math.min(count(input.work.overdue), total),
        }
        if (items.length) { result.work.items = items }
    }

    if (input.revenue && typeof input.revenue === 'object') {
        const amount = (inputAmount: unknown): number => Number.isFinite(inputAmount)
            ? Math.min(1_000_000_000_000, Math.max(0, Number(inputAmount)))
            : 0
        const currencyInput = typeof input.revenue.currency === 'string'
            ? input.revenue.currency.trim().toUpperCase()
            : ''
        const currency = /^[A-Z]{3}$/.test(currencyInput) ? currencyInput : 'USD'
        const statuses = new Set<MasterWorkspaceRevenueSummary['status']>(['live', 'manual', 'stale', 'unmapped'])
        const revenue: MasterWorkspaceRevenueSummary = {
            currency,
            currentMonthly: amount(input.revenue.currentMonthly),
            history: Array.isArray(input.revenue.history)
                ? input.revenue.history.slice(-12).flatMap(entry => {
                    const month = cleanText(entry?.month, 24)
                    return month ? [{ month, amount: amount(entry?.amount) }] : []
                })
                : [],
            status: statuses.has(input.revenue.status) ? input.revenue.status : 'unmapped',
        }
        const source = cleanText(input.revenue.source, 120)
        const updatedAt = cleanText(input.revenue.updatedAt, 64)
        if (source) { revenue.source = source }
        if (updatedAt && Number.isFinite(Date.parse(updatedAt))) { revenue.updatedAt = updatedAt }
        result.revenue = revenue
    }

    if (input.knowledge && typeof input.knowledge === 'object') {
        const allowed = new Set<MasterWorkspaceKnowledgeStatus>(['fresh', 'aging', 'stale', 'conflict', 'missing', 'unknown'])
        const rawPath = typeof input.knowledge.path === 'string' && !/[\0\r\n]/.test(input.knowledge.path)
            ? input.knowledge.path.trim().slice(0, 4096)
            : undefined
        const path = rawPath?.startsWith('/') ? rawPath : '/aamir'
        const status = allowed.has(input.knowledge.status) ? input.knowledge.status : 'unknown'
        result.knowledge = { path, status }
        const updatedAt = cleanText(input.knowledge.updatedAt, 64)
        if (updatedAt && Number.isFinite(Date.parse(updatedAt))) { result.knowledge.updatedAt = updatedAt }
    }

    if (input.plane && typeof input.plane === 'object') {
        const allowed = new Set<MasterWorkspacePlaneStatus>(['live', 'offline', 'failing', 'unmapped'])
        result.plane = { status: allowed.has(input.plane.status) ? input.plane.status : 'unmapped' }
        const identifier = cleanText(input.plane.identifier, 32)
        const projectId = cleanText(input.plane.projectId, 200)
        const updatedAt = cleanText(input.plane.updatedAt, 64)
        if (identifier) { result.plane.identifier = identifier }
        if (projectId) { result.plane.projectId = projectId }
        if (updatedAt && Number.isFinite(Date.parse(updatedAt))) { result.plane.updatedAt = updatedAt }
    }

    if (Array.isArray(input.links)) {
        result.links = input.links.slice(0, 24).flatMap(link => {
            const label = cleanText(link?.label, 80)
            const url = cleanText(link?.url, 2048)
            if (!label || !url) { return [] }
            return /^https?:\/\/[^\s]+$/i.test(url) ? [{ label, url }] : []
        })
    }

    if (['healthy', 'degraded', 'down', 'unknown'].includes(input.health)) {
        result.health = input.health
    }
    const lastActivityAt = cleanText(input.lastActivityAt, 64)
    if (lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))) { result.lastActivityAt = lastActivityAt }
    return result
}

/**
 * Applies only operational fields from the sanitized remote snapshot. Founder
 * descriptions, notes, priorities and knowledge paths always remain local.
 */
export function mergeMasterWorkspaceRemoteSnapshot<T> (
    projects: readonly ConnectionProject<T>[],
    metadataByID: Readonly<Record<string, unknown>>,
    snapshotValue: unknown,
): Record<string, MasterWorkspaceProjectMetadata> {
    const output: Record<string, MasterWorkspaceProjectMetadata> = Object.fromEntries(
        Object.entries(metadataByID).map(([id, value]) => [id, normalizeMasterWorkspaceMetadata(value)]),
    )
    if (!snapshotValue || typeof snapshotValue !== 'object' || Array.isArray(snapshotValue)) { return output }
    const snapshot = snapshotValue as Record<string, any>
    if (snapshot.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.generatedAt))) { return output }
    if (!Array.isArray(snapshot.projects) || snapshot.projects.length > 200) { return output }

    const identity = (value: unknown): string => typeof value === 'string'
        ? value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 160)
        : ''
    const projectByIdentity = new Map<string, ConnectionProject<T>>()
    for (const project of projects) {
        projectByIdentity.set(identity(project.id), project)
        projectByIdentity.set(identity(project.name), project)
    }

    for (const remoteValue of snapshot.projects) {
        if (!remoteValue || typeof remoteValue !== 'object' || Array.isArray(remoteValue)) { continue }
        const remote = remoteValue as Record<string, any>
        const remoteAliases = Array.isArray(remote.aliases) ? remote.aliases.slice(0, 20) : []
        const identities = [remote.id, remote.name, ...remoteAliases]
            .map(identity)
            .filter(Boolean)
        const project = identities.map(value => projectByIdentity.get(value)).find(Boolean)
        if (!project) { continue }

        const saved = normalizeMasterWorkspaceMetadata(metadataByID[project.id])
        const live = normalizeMasterWorkspaceMetadata(remote)
        const merged: MasterWorkspaceProjectMetadata = { ...saved }
        if (live.work) { merged.work = live.work }
        if (live.revenue) { merged.revenue = live.revenue }
        if (live.plane) { merged.plane = live.plane }
        if (live.health) { merged.health = live.health }
        if (live.lastActivityAt) { merged.lastActivityAt = live.lastActivityAt }
        if (live.links?.length) {
            const savedLinks = saved.links ?? []
            const links = [...savedLinks, ...live.links]
            merged.links = links.filter((link, index) => links.findIndex(candidate => candidate.url === link.url) === index).slice(0, 24)
        }
        output[project.id] = merged
    }
    return output
}

export function buildMasterWorkspaceProjects<T> (
    projects: readonly ConnectionProject<T>[],
    metadataByID: Readonly<Record<string, unknown>>,
    _now: number,
): MasterWorkspaceProject<T>[] {
    const priorityScores: Record<ConnectionPriority, number> = { '1': 20, '2': 10, '3': 4, '4': 0 }
    const descriptions: Partial<Record<string, string>> = {
        mamasign: 'E-signature platform for SuperAdmin, Reseller Admin and Whitelabel Customer teams.',
        calendarjet: 'Scheduling and booking links with shared team calendars.',
        wittyform: 'Form builder with conditional logic and payments.',
        hiringcat: 'Applicant tracking for small hiring teams.',
        huntcat: 'Lead sourcing and enrichment.',
        authoritycat: 'SEO authority tracking under the AuthorityCat and Meuo brands.',
        wasecret: 'WhatsApp workflow and automation project.',
        clarino: 'Client portal and document requests.',
        mamalead: 'Lead capture and CRM tools for MamaSign customers.',
        buzpo: 'Buzpo and NotifyStock back-in-stock alerts.',
        moonpush: 'Web push notification service.',
        lawtelligent: 'Legal research and drafting assistant.',
        prisma: 'Analytics dashboards and data tools.',
        customracesuit: 'Custom racing suit configurator and store.',
        takmeel: 'Project delivery and construction workflows.',
        niswa: 'Community project for women entrepreneurs.',
        xoobo: 'Xoobo application, CLI and automation tools.',
    }
    return projects.map(project => {
        const saved = normalizeMasterWorkspaceMetadata(metadataByID[project.id])
        const priority = saved.priority ?? project.priority
        const work = saved.work ?? { total: 0, completed: 0, blocked: 0, overdue: 0 }
        const revenue = saved.revenue ?? {
            currency: 'USD', currentMonthly: 0, history: [], status: 'unmapped' as const,
        }
        const knowledge = saved.knowledge ?? { path: '/aamir', status: 'unknown' as MasterWorkspaceKnowledgeStatus }
        const plane = saved.plane ?? { status: 'unmapped' as MasterWorkspacePlaneStatus }
        const health = saved.health ?? 'unknown'
        const reasons: MasterWorkspaceAttentionReason[] = []
        if (health === 'down') { reasons.push({ kind: 'health', label: 'Production down', score: 50 }) }
        if (health === 'degraded') { reasons.push({ kind: 'health', label: 'Production degraded', score: 30 }) }
        if (plane.status === 'failing') { reasons.push({ kind: 'plane', label: 'Plane sync failing', score: 15 }) }
        if (work.blocked) { reasons.push({ kind: 'blocked', label: `${work.blocked} blocked`, score: Math.min(work.blocked * 6, 24) }) }
        if (work.overdue) { reasons.push({ kind: 'overdue', label: `${work.overdue} overdue`, score: Math.min(work.overdue * 4, 24) }) }
        const stoppedTmux = project.connections.filter(connection => connection.status.state === 'stopped' && !!connection.status.tmuxSession).length
        if (stoppedTmux) { reasons.push({ kind: 'tmux', label: `${stoppedTmux} tmux ready to resume`, score: stoppedTmux * 5 }) }
        const priorityScore = priorityScores[priority]
        if (priorityScore) { reasons.push({ kind: 'priority', label: `P${priority} priority`, score: priorityScore }) }
        const score = reasons.reduce((sum, reason) => sum + reason.score, 0)
        const progress = work.total ? Math.round(work.completed / work.total * 100) : 0
        const metadata = {
            description: saved.description ?? descriptions[project.id] ?? '',
            notes: saved.notes ?? '',
            work,
            revenue,
            knowledge,
            plane,
            links: saved.links ?? [],
            health,
            lastActivityAt: saved.lastActivityAt,
        }
        return {
            ...project,
            priority,
            metadata,
            progress,
            openWork: Math.max(0, work.total - work.completed),
            attention: { score, band: score >= 40 ? 'attention' : score >= 15 ? 'watch' : 'steady', reasons },
            _activitySort: metadata.lastActivityAt ? Date.parse(metadata.lastActivityAt) : 0,
        } as MasterWorkspaceProject<T> & { _activitySort: number }
    }).sort((a, b) => b.attention.score - a.attention.score
        || a.priority - b.priority
        || (b as any)._activitySort - (a as any)._activitySort
        || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map(project => {
            delete (project as any)._activitySort
            return project
        })
}

export function buildMasterWorkspaceSearchResults<T> (
    projects: readonly MasterWorkspaceProject<T>[],
    query: string,
): MasterWorkspaceSearchResult<T>[] {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const matches = (value: string): boolean => terms.every(term => value.toLocaleLowerCase().includes(term))
    const actions: MasterWorkspaceSearchResult<T>[] = [
        { key: 'action:overview', kind: 'action', label: 'Open founder overview', detail: 'All projects and attention ranking', icon: 'fa-grid-2', action: 'overview' },
        { key: 'action:work', kind: 'action', label: 'Review project work', detail: 'Completed, blocked and overdue work', icon: 'fa-list-check', action: 'work' },
        { key: 'action:knowledge', kind: 'action', label: 'Search project knowledge', detail: '/aamir status and project notes', icon: 'fa-book-open', action: 'knowledge' },
        { key: 'action:connections', kind: 'action', label: 'Open saved connections', detail: 'Running and offline terminal sessions', icon: 'fa-server', action: 'connections' },
        { key: 'action:settings', kind: 'action', label: 'Open workspace settings', detail: 'Plane relay and dashboard behavior', icon: 'fa-sliders', action: 'settings' },
    ]
    const results: MasterWorkspaceSearchResult<T>[] = actions.filter(action => !terms.length || matches(`${action.label} ${action.detail}`))
    for (const project of projects) {
        const projectText = `${project.name} ${project.metadata.description} ${project.metadata.plane.identifier ?? ''}`
        if (!terms.length || matches(projectText)) {
            results.push({
                key: `project:${project.id}`, kind: 'project', label: project.name,
                detail: `P${project.priority} · ${project.connections.length} connections · ${project.openWork} open`,
                icon: 'fa-folder', project,
            })
        }
        for (const connection of project.connections) {
            const text = `${connection.label} ${connection.status.detail} ${connection.status.tmuxSession ?? ''} ${connection.status.workingDirectory ?? ''} ${project.name}`
            if (!terms.length || matches(text)) {
                results.push({
                    key: `connection:${connection.key}`, kind: 'connection', label: connection.label,
                    detail: `${project.name} · ${connection.status.state}${connection.status.workingDirectory ? ` · ${connection.status.workingDirectory}` : ''}`,
                    icon: 'fa-terminal', project, connection,
                })
            }
        }
    }
    return results.slice(0, 60)
}
