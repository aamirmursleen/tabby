export interface FounderBriefingSchedule {
    enabled: boolean
    hour: number
    minute: number
    lastRunAt?: string
    lastRunDate?: string
}

export function applyFounderBriefingSchedule (
    target: FounderBriefingSchedule,
    value: FounderBriefingSchedule,
): void {
    target.enabled = value.enabled
    target.hour = value.hour
    target.minute = value.minute
    target.lastRunAt = value.lastRunAt
    target.lastRunDate = value.lastRunDate
}

export interface FounderBriefingResult {
    generatedAt: string
    source: 'codex'|'local'
    headline: string
    progress: string[]
    pending: string[]
    risks: string[]
    growth: string[]
    message: {
        recipient: string
        channel: string
        text: string
    }
    evidence: {
        planeTaskCount: number
        gitCommitCount: number
        repository?: string
        latestCommitAt?: string
    }
}

export interface FounderBriefingRequest {
    schemaVersion: 1
    generatedAt: string
    projects: {
        id: string
        name: string
        priority: number
        description: string
        notes: string
        owner: { name: string, channel: string }
        repository: { localPath: string, githubURL: string }
        plane: { status: string, workspaceSlug: string, identifier: string, updatedAt: string }
        revenue: { currency: string, currentMonthly: number, previousMonthly: number, status: string }
        workItems: {
            id: string
            title: string
            state: string
            priority: string
            assignee: string
            dueDate: string
            updatedAt: string
        }[]
    }[]
}

export function nextFounderBriefingRun (from: Date, hour = 9, minute = 0, lastRunDate?: string): Date {
    const next = new Date(from.getTime())
    next.setHours(Math.min(23, Math.max(0, Math.floor(hour))), Math.min(59, Math.max(0, Math.floor(minute))), 0, 0)
    const today = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
    if (next.getTime() <= from.getTime() || lastRunDate === today) { next.setDate(next.getDate() + 1) }
    return next
}

export function shouldRunFounderBriefing (schedule: FounderBriefingSchedule, now = new Date()): boolean {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (!schedule.enabled || schedule.lastRunDate === today) { return false }
    const due = new Date(now.getTime())
    due.setHours(
        Math.min(23, Math.max(0, Math.floor(schedule.hour))),
        Math.min(59, Math.max(0, Math.floor(schedule.minute))),
        0,
        0,
    )
    return now.getTime() >= due.getTime()
}

export function buildFounderBriefingRequest (projects: readonly unknown[], now = new Date()): FounderBriefingRequest {
    const clean = (value: unknown, max: number): string => typeof value === 'string'
        ? value.replace(/[\0\r]/g, '').trim().slice(0, max)
        : ''
    const amount = (value: unknown): number => Number.isFinite(Number(value))
        ? Math.max(0, Math.min(1_000_000_000_000, Number(value)))
        : 0
    const openStates = new Set(['backlog', 'todo', 'in_progress', 'blocked'])

    return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        projects: projects.slice(0, 50).map(projectValue => {
            const project = projectValue && typeof projectValue === 'object' && !Array.isArray(projectValue)
                ? projectValue as Record<string, any>
                : {}
            const metadata = project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
                ? project.metadata
                : {}
            const inferredLocalPath = (Array.isArray(project.connections) ? project.connections : [])
                .map(connection => connection?.status?.workingDirectory)
                .find(value => typeof value === 'string' && value.startsWith('/Users/')) ?? ''
            const inferredGithubURL = (Array.isArray(metadata.links) ? metadata.links : [])
                .map(link => link?.url)
                .find(value => typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(value)) ?? ''
            const revenueHistory = Array.isArray(metadata.revenue?.history) ? metadata.revenue.history : []
            const previousMonthly = revenueHistory.length > 1
                ? amount(revenueHistory[revenueHistory.length - 2]?.amount)
                : 0
            const workItems = (Array.isArray(metadata.work?.items) ? metadata.work.items : [])
                .filter(item => openStates.has(item?.state))
                .slice(0, 24)
                .map(item => ({
                    id: clean(item.id, 80),
                    title: clean(item.title, 300),
                    state: clean(item.state, 32),
                    priority: clean(item.priority, 32),
                    assignee: clean(item.assignee, 120),
                    dueDate: clean(item.dueDate, 64),
                    updatedAt: clean(item.updatedAt, 64),
                }))
                .filter(item => item.id && item.title)
            return {
                id: clean(project.id, 160),
                name: clean(project.name, 160),
                priority: Math.min(4, Math.max(1, Math.floor(Number(project.priority) || 3))),
                description: clean(metadata.description, 1200),
                notes: clean(metadata.notes, 4000),
                owner: {
                    name: clean(metadata.owner?.name, 120),
                    channel: clean(metadata.owner?.channel, 40),
                },
                repository: {
                    localPath: clean(metadata.repository?.localPath || inferredLocalPath, 4096),
                    githubURL: clean(metadata.repository?.githubURL || inferredGithubURL, 2048),
                },
                plane: {
                    status: clean(metadata.plane?.status, 32),
                    workspaceSlug: clean(metadata.plane?.workspaceSlug, 120),
                    identifier: clean(metadata.plane?.identifier, 32),
                    updatedAt: clean(metadata.plane?.updatedAt, 64),
                },
                revenue: {
                    currency: clean(metadata.revenue?.currency, 3) || 'USD',
                    currentMonthly: amount(metadata.revenue?.currentMonthly),
                    previousMonthly,
                    status: clean(metadata.revenue?.status, 32),
                },
                workItems,
            }
        }).filter(project => project.id && project.name),
    }
}

export function buildFallbackFounderBriefing (projectValue: unknown, now = new Date()): FounderBriefingResult {
    const project = projectValue && typeof projectValue === 'object' && !Array.isArray(projectValue)
        ? projectValue as Record<string, any>
        : {}
    const metadata = project.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
        ? project.metadata
        : {}
    const openStates = new Set(['backlog', 'todo', 'in_progress', 'blocked'])
    const priorityWeight: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 }
    const weight = (value: unknown): number => typeof value === 'string' && Object.prototype.hasOwnProperty.call(priorityWeight, value)
        ? priorityWeight[value]
        : 0
    const items = (Array.isArray(metadata.work?.items) ? metadata.work.items : [])
        .filter(item => openStates.has(item?.state))
        .sort((a, b) => Number(b?.state === 'blocked') - Number(a?.state === 'blocked')
            || weight(b?.priority) - weight(a?.priority))
    const pending = items.slice(0, 6).map(item => `${item.id}: ${item.title}`)
    if (!pending.length && Number(metadata.work?.total) > Number(metadata.work?.completed)) {
        pending.push(`${Math.max(0, Number(metadata.work.total) - Number(metadata.work.completed))} Plane tasks are still open.`)
    }
    if (!pending.length) { pending.push('No open Plane task was available in the latest sync.') }

    const risks: string[] = []
    if (Number(metadata.work?.blocked) > 0) { risks.push(`${metadata.work.blocked} task${metadata.work.blocked === 1 ? ' is' : 's are'} blocked.`) }
    if (Number(metadata.work?.overdue) > 0) { risks.push(`${metadata.work.overdue} task${metadata.work.overdue === 1 ? ' is' : 's are'} overdue.`) }
    if (metadata.plane?.status !== 'live') { risks.push('Plane data is not live, so this briefing may be incomplete.') }
    if (!risks.length) { risks.push('No urgent delivery risk was found in the available evidence.') }

    const currentRevenue = Number(metadata.revenue?.currentMonthly) || 0
    const history = Array.isArray(metadata.revenue?.history) ? metadata.revenue.history : []
    const previousRevenue = Number(history.at(-2)?.amount) || 0
    const growth = currentRevenue <= 0
        ? ['Define one paid offer and ask five target customers for a buying call this week.']
        : currentRevenue < previousRevenue
            ? ['Talk to three recent customers, learn why revenue fell, and fix the most common reason this week.']
            : ['Ask three active customers for an upgrade, referral, or annual plan this week.']
    const owner = typeof metadata.owner?.name === 'string' && metadata.owner.name.trim()
        ? metadata.owner.name.trim()
        : 'Project owner'
    const channel = typeof metadata.owner?.channel === 'string' && metadata.owner.channel.trim()
        ? metadata.owner.channel.trim()
        : 'Message'
    const focus = items[0]?.title ?? pending[0]
    const firstName = owner === 'Project owner' ? 'there' : owner.split(/\s+/)[0]
    const message = `Hi ${firstName}, quick update on ${project.name}. Please focus on ${focus}. Can you share the next step and delivery date today?`

    return {
        generatedAt: now.toISOString(),
        source: 'local',
        headline: `${Math.max(0, Number(metadata.work?.total) - Number(metadata.work?.completed))} open · ${Number(metadata.work?.blocked) || 0} blocked`,
        progress: [`${Number(metadata.work?.completed) || 0} of ${Number(metadata.work?.total) || 0} Plane tasks completed.`],
        pending,
        risks,
        growth,
        message: { recipient: owner, channel, text: message.slice(0, 1200) },
        evidence: {
            planeTaskCount: items.length,
            gitCommitCount: 0,
            repository: metadata.repository?.githubURL || metadata.repository?.localPath || undefined,
        },
    }
}
