import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core'

import { BaseTabComponent } from './baseTab.component'
import { BaseComponent } from './base.component'
import { ConnectionProjectItem } from '../utils/connectionProjects'
import {
    buildMasterWorkspaceKanban,
    buildMasterWorkspaceSearchResults,
    filterMasterWorkspaceWorkItems,
    MasterWorkspaceKanbanColumn,
    MasterWorkspaceProject,
    MasterWorkspaceProjectMetadata,
    MasterWorkspaceSearchResult,
    MasterWorkspaceWorkFilters,
    MasterWorkspaceWorkItem,
    parsePlanePortalURL,
} from '../utils/masterWorkspace'
import { MasterWorkspaceService, MasterWorkspaceSettings } from '../services/masterWorkspace.service'

type WorkspaceView = 'overview'|'project'|'work'|'knowledge'|'connections'|'settings'
type ProjectSection = 'summary'|'work'|'knowledge'|'connections'|'commands'|'activity'
type RevenuePeriod = 'current'|'previous'
type KnowledgeEditorMode = 'note'|'link'|null
type WorkView = 'kanban'|'list'

interface ProjectDraft {
    priority: number
    description: string
    notes: string
    total: number
    completed: number
    blocked: number
    overdue: number
    health: 'healthy'|'degraded'|'down'|'unknown'
    knowledgePath: string
    planeIdentifier: string
    revenueCurrency: string
    revenueCurrent: number
    revenueSource: string
    revenueHistory: string
}

interface KnowledgeLinkDraft {
    label: string
    url: string
}

@Component({
    selector: 'master-workspace',
    templateUrl: './masterWorkspace.component.pug',
    styleUrls: ['./masterWorkspace.component.scss'],
})
export class MasterWorkspaceComponent extends BaseComponent implements OnInit, OnDestroy {
    @Input() active = false
    @Output() terminalSelected = new EventEmitter<void>()
    @Output() connectionsRequested = new EventEmitter<void>()
    @Output() snippetsRequested = new EventEmitter<void>()

    view: WorkspaceView = 'overview'
    projects: MasterWorkspaceProject<BaseTabComponent>[] = []
    selectedProject: MasterWorkspaceProject<BaseTabComponent>|null = null
    projectSection: ProjectSection = 'summary'
    terminalDrawerOpen = false
    projectQuery = ''
    commandQuery = ''
    commandPaletteOpen = false
    editorOpen = false
    revenuePeriod: RevenuePeriod = 'current'
    workView: WorkView = 'kanban'
    workFilters: MasterWorkspaceWorkFilters = this.emptyWorkFilters()
    saving = false
    busyConnectionKey: string|null = null
    error = ''
    status = ''
    knowledgeEditorMode: KnowledgeEditorMode = null
    knowledgeNoteDraft = ''
    knowledgeLinkDraft: KnowledgeLinkDraft = { label: '', url: '' }
    knowledgeEditingLinkIndex: number|null = null
    knowledgeError = ''
    planeLinkEditorOpen = false
    planeLinkDraft = ''
    planeLinkError = ''
    draft: ProjectDraft = this.emptyDraft()
    settingsDraft: MasterWorkspaceSettings = { relayUrl: '', workspaceSlug: '' }
    private readonly moneyFormatters = new Map<string, Intl.NumberFormat>()
    private readonly revenueMonthLabels = new Map<string, string>()
    private readonly workDateLabels = new Map<string, string>()
    private readonly workViewCache = new WeakMap<MasterWorkspaceProject<BaseTabComponent>, {
        key: string
        items: MasterWorkspaceWorkItem[]
        columns: MasterWorkspaceKanbanColumn[]
    }>()

    private readonly revenueShareRateCache = new WeakMap<MasterWorkspaceProject<BaseTabComponent>, number|null>()
    private readonly revenueBarCache = new WeakMap<MasterWorkspaceProject<BaseTabComponent>, { month: string, amount: number, height: number }[]>()
    private readonly projectTagCache = new WeakMap<MasterWorkspaceProject<BaseTabComponent>, string[]>()
    private readonly projectTagCatalog: Partial<Record<string, string[]>> = {
        mamasign: ['SuperAdmin', 'Reseller Admin', 'Whitelabel Customer', 'API'],
        calendarjet: ['Scheduling', 'Bookings', 'Calendar'],
        wittyform: ['Forms', 'Payments', 'Automation'],
        hiringcat: ['Hiring', 'Candidates', 'ATS'],
        huntcat: ['Sourcing', 'Enrichment', 'Leads'],
        wasecret: ['WhatsApp', 'Automation'],
    }

    constructor (public workspace: MasterWorkspaceService) {
        super()
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.workspace.changed$, () => this.updateProjects())
        this.updateProjects()
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
    }

    @HostListener('document:keydown', ['$event'])
    onDocumentKeyDown (event: KeyboardEvent): void {
        if (!this.active) { return }
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
            event.preventDefault()
            event.stopPropagation()
            this.openCommandPalette()
            return
        }
        if (event.key === 'Escape') {
            if (this.commandPaletteOpen) {
                this.commandPaletteOpen = false
                event.preventDefault()
            } else if (this.editorOpen) {
                this.editorOpen = false
                event.preventDefault()
            } else if (this.planeLinkEditorOpen) {
                this.cancelPlaneLinkEditor()
                event.preventDefault()
            } else if (this.knowledgeEditorMode) {
                this.cancelKnowledgeEditor()
                event.preventDefault()
            } else if (this.view === 'project') {
                this.showView('overview')
                event.preventDefault()
            }
        }
    }

    get projectCount (): number { return this.projects.length }
    get attentionCount (): number { return this.projects.filter(project => project.attention.band === 'attention').length }
    get liveConnectionCount (): number { return this.projects.reduce((total, project) => total + project.liveCount, 0) }
    get totalCompleted (): number { return this.projects.reduce((total, project) => total + project.metadata.work.completed, 0) }
    get totalOpen (): number { return this.projects.reduce((total, project) => total + project.openWork, 0) }
    get mappedProjectCount (): number { return this.projects.filter(project => project.metadata.plane.status !== 'unmapped').length }

    get visibleProjects (): MasterWorkspaceProject<BaseTabComponent>[] {
        const terms = this.projectQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
        if (!terms.length) { return this.projects }
        return this.projects.filter(project => {
            const text = [
                project.name,
                project.metadata.description,
                project.metadata.notes,
                project.metadata.knowledge.path,
                ...project.metadata.links.flatMap(link => [link.label, link.url]),
                ...project.connections.map(connection => connection.label),
            ].join(' ').toLocaleLowerCase()
            return terms.every(term => text.includes(term))
        })
    }

    get searchResults (): MasterWorkspaceSearchResult<BaseTabComponent>[] {
        return buildMasterWorkspaceSearchResults(this.projects, this.commandQuery)
    }

    get attentionProjects (): MasterWorkspaceProject<BaseTabComponent>[] {
        return this.visibleProjects.filter(project => project.attention.band === 'attention')
    }

    get watchProjects (): MasterWorkspaceProject<BaseTabComponent>[] {
        return this.visibleProjects.filter(project => project.attention.band === 'watch')
    }

    get steadyProjects (): MasterWorkspaceProject<BaseTabComponent>[] {
        return this.visibleProjects.filter(project => project.attention.band === 'steady')
    }

    showView (view: WorkspaceView): void {
        this.view = view
        if (view !== 'project') { this.selectedProject = null }
        if (view === 'settings') { this.settingsDraft = { ...this.workspace.settings } }
        this.commandPaletteOpen = false
    }

    openProject (project: MasterWorkspaceProject<BaseTabComponent>): void {
        this.selectedProject = project
        this.view = 'project'
        this.projectSection = 'summary'
        this.revenuePeriod = 'current'
        this.clearWorkFilters()
        this.cancelKnowledgeEditor()
        this.cancelPlaneLinkEditor()
        this.commandPaletteOpen = false
    }

    showProjectSection (section: ProjectSection): void {
        this.projectSection = section
        if (section === 'work' && this.selectedProject) {
            if (this.selectedProject.metadata.plane.workspaceSlug) {
                void this.workspace.syncProjectWorkItems(this.selectedProject)
            } else {
                this.openPlaneLinkEditor()
            }
        }
    }

    openRegistry (): void {
        if (!this.projects.length) { return }
        const project = this.selectedProject
            ?? this.projects.find(item => item.id === 'mamasign')
            ?? this.projects.find(item => item.name.toLocaleLowerCase() === 'mamasign')
            ?? this.projects[0]
        this.openEditor(project)
    }

    scanProject (project: MasterWorkspaceProject<BaseTabComponent>): void {
        this.openProject(project)
        this.projectSection = 'knowledge'
        this.status = this.workspace.settings.relayUrl
            ? 'Project data refreshed from the local snapshot. Server scan support is waiting for the configured relay.'
            : 'Configure Sync & relay before scanning a server. Existing local project data is still available.'
    }

    async openConnection (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (this.busyConnectionKey) { return }
        this.busyConnectionKey = item.key
        this.error = ''
        try {
            await this.workspace.activateConnection(item)
            this.terminalSelected.emit()
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not open this terminal.'
        } finally {
            this.busyConnectionKey = null
        }
    }

    async openFirstConnection (project: MasterWorkspaceProject<BaseTabComponent>): Promise<void> {
        if (!project.connections.length) { return }
        const connection = project.connections.find(item => item.active)
            ?? project.connections.find(item => item.status.state === 'running')
            ?? project.connections[0]
        await this.openConnection(connection)
    }

    async openFeatureConnection (project: MasterWorkspaceProject<BaseTabComponent>): Promise<void> {
        if (!project.connections.length || this.busyConnectionKey) { return }
        const connection = project.connections.find(item => item.profile) ?? project.connections[0]
        this.busyConnectionKey = connection.key
        this.error = ''
        try {
            await this.workspace.launchFreshConnection(connection)
            this.terminalSelected.emit()
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not open a feature terminal.'
        } finally {
            this.busyConnectionKey = null
        }
    }

    openEditor (project: MasterWorkspaceProject<BaseTabComponent>): void {
        this.selectedProject = project
        this.draft = {
            priority: project.priority,
            description: project.metadata.description,
            notes: project.metadata.notes,
            total: project.metadata.work.total,
            completed: project.metadata.work.completed,
            blocked: project.metadata.work.blocked,
            overdue: project.metadata.work.overdue,
            health: project.metadata.health,
            knowledgePath: project.metadata.knowledge.path,
            planeIdentifier: project.metadata.plane.identifier ?? '',
            revenueCurrency: project.metadata.revenue.currency,
            revenueCurrent: project.metadata.revenue.currentMonthly,
            revenueSource: project.metadata.revenue.source ?? '',
            revenueHistory: project.metadata.revenue.history.map(entry => entry.amount).join(', '),
        }
        this.error = ''
        this.editorOpen = true
    }

    async saveProject (): Promise<void> {
        if (!this.selectedProject || this.saving) { return }
        this.saving = true
        this.error = ''
        const previousID = this.selectedProject.id
        const metadata: MasterWorkspaceProjectMetadata = {
            ...this.selectedProject.metadata,
            description: this.draft.description,
            notes: this.draft.notes,
            health: this.draft.health,
            work: {
                total: Number(this.draft.total), completed: Number(this.draft.completed),
                blocked: Number(this.draft.blocked), overdue: Number(this.draft.overdue),
                items: this.selectedProject.metadata.work.items,
            },
            knowledge: {
                ...this.selectedProject.metadata.knowledge,
                path: this.draft.knowledgePath,
            },
            plane: {
                ...this.selectedProject.metadata.plane,
                identifier: this.draft.planeIdentifier,
                status: this.draft.planeIdentifier ? this.selectedProject.metadata.plane.status : 'unmapped',
            },
            revenue: {
                ...this.selectedProject.metadata.revenue,
                currency: this.draft.revenueCurrency,
                currentMonthly: Number(this.draft.revenueCurrent),
                source: this.draft.revenueSource,
                status: this.draft.revenueSource ? 'manual' : 'unmapped',
                history: this.revenueHistoryFromDraft(this.draft.revenueHistory),
                updatedAt: new Date().toISOString(),
            },
            lastActivityAt: new Date().toISOString(),
        }
        try {
            await this.workspace.saveProject(this.selectedProject, metadata, this.draft.priority)
            this.selectedProject = this.projects.find(project => project.id === previousID) ?? null
            this.editorOpen = false
            this.status = 'Project saved'
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not save this project.'
        } finally {
            this.saving = false
        }
    }

    openKnowledgeNoteEditor (): void {
        if (!this.selectedProject) { return }
        this.knowledgeNoteDraft = this.selectedProject.metadata.notes
        this.knowledgeEditorMode = 'note'
        this.knowledgeEditingLinkIndex = null
        this.knowledgeError = ''
    }

    openKnowledgeLinkEditor (index: number|null = null): void {
        if (!this.selectedProject) { return }
        const link = index === null ? null : this.selectedProject.metadata.links[index]
        this.knowledgeLinkDraft = link ? { ...link } : { label: '', url: '' }
        this.knowledgeEditorMode = 'link'
        this.knowledgeEditingLinkIndex = link ? index : null
        this.knowledgeError = ''
    }

    cancelKnowledgeEditor (): void {
        this.knowledgeEditorMode = null
        this.knowledgeEditingLinkIndex = null
        this.knowledgeError = ''
    }

    async saveKnowledgeNote (): Promise<void> {
        const project = this.selectedProject
        if (!project || this.saving) { return }
        const metadata: MasterWorkspaceProjectMetadata = {
            ...project.metadata,
            notes: this.knowledgeNoteDraft,
            lastActivityAt: new Date().toISOString(),
        }
        await this.saveKnowledgeMetadata(project, metadata, 'Project note saved')
    }

    async saveKnowledgeLink (): Promise<void> {
        const project = this.selectedProject
        if (!project || this.saving) { return }
        const label = this.knowledgeLinkDraft.label.trim()
        const url = this.knowledgeLinkDraft.url.trim()
        if (!label) {
            this.knowledgeError = 'Give this link a name.'
            return
        }
        if (!/^https?:\/\/[^\s]+$/i.test(url)) {
            this.knowledgeError = 'Enter a complete http:// or https:// link.'
            return
        }
        if (this.knowledgeEditingLinkIndex === null && project.metadata.links.length >= 24) {
            this.knowledgeError = 'A project can have up to 24 saved links.'
            return
        }
        const duplicateIndex = project.metadata.links.findIndex(link => link.url === url)
        if (duplicateIndex >= 0 && duplicateIndex !== this.knowledgeEditingLinkIndex) {
            this.knowledgeError = 'This link is already saved for the project.'
            return
        }
        const links = project.metadata.links.map(link => ({ ...link }))
        const nextLink = { label: label.slice(0, 80), url: url.slice(0, 2048) }
        if (this.knowledgeEditingLinkIndex === null) {
            links.push(nextLink)
        } else {
            links[this.knowledgeEditingLinkIndex] = nextLink
        }
        const metadata: MasterWorkspaceProjectMetadata = {
            ...project.metadata,
            links,
            lastActivityAt: new Date().toISOString(),
        }
        await this.saveKnowledgeMetadata(project, metadata, 'Project link saved')
    }

    async removeKnowledgeLink (index: number): Promise<void> {
        const project = this.selectedProject
        if (!project || this.saving || !project.metadata.links[index]) { return }
        const metadata: MasterWorkspaceProjectMetadata = {
            ...project.metadata,
            links: project.metadata.links.filter((_link, linkIndex) => linkIndex !== index),
            lastActivityAt: new Date().toISOString(),
        }
        await this.saveKnowledgeMetadata(project, metadata, 'Project link removed')
    }

    async saveSettings (): Promise<void> {
        if (this.saving) { return }
        this.saving = true
        this.error = ''
        try {
            await this.workspace.saveSettings(this.settingsDraft)
            this.status = 'Workspace settings saved'
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not save workspace settings.'
        } finally {
            this.saving = false
        }
    }

    async syncRemoteData (): Promise<void> {
        this.error = ''
        this.status = ''
        await this.workspace.syncRemoteData(true)
        if (this.selectedProject && this.projectSection === 'work') {
            await this.workspace.syncProjectWorkItems(this.selectedProject, true)
        }
        if (!this.workspace.syncError) { this.status = 'Project work and revenue synced from Nafran OS' }
    }

    async syncWorkItems (force = true): Promise<void> {
        if (!this.selectedProject) { return }
        await this.workspace.syncProjectWorkItems(this.selectedProject, force)
    }

    openPlaneLinkEditor (): void {
        const project = this.selectedProject
        if (!project) { return }
        const workspaceURL = this.planeWorkspaceURL(project)
        const projectID = project.metadata.plane.projectId
        this.planeLinkDraft = workspaceURL && projectID
            ? `${workspaceURL}projects/${encodeURIComponent(projectID)}/`
            : workspaceURL
        this.planeLinkError = ''
        this.planeLinkEditorOpen = true
    }

    cancelPlaneLinkEditor (): void {
        this.planeLinkEditorOpen = false
        this.planeLinkError = ''
    }

    async savePlanePortalLink (): Promise<void> {
        const project = this.selectedProject
        if (!project || this.saving) { return }
        const mapping = parsePlanePortalURL(this.planeLinkDraft)
        if (!mapping) {
            this.planeLinkError = 'Paste a complete https://portal.whitelabel.com.pk project or task link.'
            return
        }
        this.saving = true
        this.planeLinkError = ''
        this.error = ''
        this.status = ''
        const sameWorkspace = project.metadata.plane.workspaceSlug === mapping.workspaceSlug
        const metadata: MasterWorkspaceProjectMetadata = {
            ...project.metadata,
            plane: {
                ...project.metadata.plane,
                status: 'live',
                workspaceSlug: mapping.workspaceSlug,
                projectId: mapping.projectId,
                identifier: mapping.identifier ?? (sameWorkspace ? project.metadata.plane.identifier : undefined),
                updatedAt: new Date().toISOString(),
            },
            lastActivityAt: new Date().toISOString(),
        }
        try {
            await this.workspace.saveProject(project, metadata, project.priority)
            const savedProject = this.projects.find(item => item.id === project.id)
            if (!savedProject) { throw new Error('The project was saved but could not be reloaded.') }
            this.selectedProject = savedProject
            this.planeLinkEditorOpen = false
            await this.workspace.syncProjectWorkItems(savedProject, true)
            const syncError = this.workspace.workItemsError(savedProject.id)
            this.status = syncError
                ? 'Plane link saved. Use Retry after resolving the sync error below.'
                : 'Plane project connected and work items synced'
        } catch (error) {
            this.planeLinkError = error instanceof Error ? error.message : 'Could not save this Plane project link.'
        } finally {
            this.saving = false
        }
    }

    filteredWorkItems (project: MasterWorkspaceProject<BaseTabComponent>): MasterWorkspaceWorkItem[] {
        return this.workViewData(project).items
    }

    workKanbanColumns (project: MasterWorkspaceProject<BaseTabComponent>): MasterWorkspaceKanbanColumn[] {
        return this.workViewData(project).columns
    }

    clearWorkFilters (): void {
        this.workFilters = this.emptyWorkFilters()
    }

    hasActiveWorkFilters (): boolean {
        const filters = this.workFilters
        return !!filters.query || filters.status !== 'all' || filters.priority !== 'all'
            || filters.created !== 'all' || filters.due !== 'all'
    }

    planeWorkspaceURL (project: MasterWorkspaceProject<BaseTabComponent>): string {
        const slug = project.metadata.plane.workspaceSlug ?? ''
        return /^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)
            ? `https://portal.whitelabel.com.pk/${encodeURIComponent(slug)}/`
            : ''
    }

    planeWorkItemURL (
        project: MasterWorkspaceProject<BaseTabComponent>,
        item: MasterWorkspaceWorkItem,
    ): string {
        const workspaceURL = this.planeWorkspaceURL(project)
        return workspaceURL && /^[A-Za-z0-9_-]{1,80}$/.test(item.id)
            ? `${workspaceURL}browse/${encodeURIComponent(item.id)}`
            : workspaceURL
    }

    formatWorkDate (value: string|undefined): string {
        if (!value) { return 'No date' }
        const cached = this.workDateLabels.get(value)
        if (cached) { return cached }
        const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)
        const label = Number.isFinite(date.getTime())
            ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
            : value
        this.workDateLabels.set(value, label)
        return label
    }

    isWorkItemOverdue (item: MasterWorkspaceWorkItem): boolean {
        if (!item.dueDate || item.state === 'done' || item.state === 'cancelled') { return false }
        const now = new Date()
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        return item.dueDate < today
    }

    workPriorityLabel (priority: MasterWorkspaceWorkItem['priority']): string {
        return priority === 'none' ? 'No priority' : priority[0].toLocaleUpperCase() + priority.slice(1)
    }

    openCommandPalette (): void {
        this.commandQuery = ''
        this.commandPaletteOpen = true
        window.setTimeout(() => document.querySelector<HTMLInputElement>('.master-command-input')?.focus())
    }

    async chooseSearchResult (result: MasterWorkspaceSearchResult<BaseTabComponent>): Promise<void> {
        if (result.action) { this.showView(result.action); return }
        if (result.connection) { await this.openConnection(result.connection); this.commandPaletteOpen = false; return }
        if (result.project) { this.openProject(result.project) }
    }

    relativeTime (value?: string): string {
        if (!value) { return 'No activity yet' }
        const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60000))
        if (minutes < 1) { return 'Just now' }
        if (minutes < 60) { return `${minutes}m ago` }
        const hours = Math.round(minutes / 60)
        if (hours < 24) { return `${hours}h ago` }
        return `${Math.round(hours / 24)}d ago`
    }

    statusLabel (item: ConnectionProjectItem<BaseTabComponent>): string {
        if (this.busyConnectionKey === item.key) { return 'Opening…' }
        switch (item.status.state) {
            case 'running': return 'Running'
            case 'starting': return 'Starting'
            case 'stopped': return item.status.tmuxSession ? 'Ready to resume' : 'Offline'
            default: return 'Unknown'
        }
    }

    projectTags (project: MasterWorkspaceProject<BaseTabComponent>): string[] {
        const cached = this.projectTagCache.get(project)
        if (cached) { return cached }
        const tags = this.projectTagCatalog[project.id] ?? project.connections.slice(0, 4).map(item => item.label)
        this.projectTagCache.set(project, tags)
        return tags
    }

    revenueBars (project: MasterWorkspaceProject<BaseTabComponent>): { month: string, amount: number, height: number }[] {
        const cached = this.revenueBarCache.get(project)
        if (cached) { return cached }
        const history = project.metadata.revenue.history
        const maximum = Math.max(1, ...history.map(entry => entry.amount))
        const bars = history.map(entry => ({ ...entry, height: Math.max(4, Math.round(entry.amount / maximum * 74)) }))
        this.revenueBarCache.set(project, bars)
        return bars
    }

    revenueTotal (project: MasterWorkspaceProject<BaseTabComponent>): number {
        return project.metadata.revenue.history.reduce((total, entry) => total + entry.amount, 0)
    }

    selectRevenuePeriod (period: RevenuePeriod): void {
        this.revenuePeriod = period
    }

    revenueAmount (project: MasterWorkspaceProject<BaseTabComponent>, period = this.revenuePeriod): number {
        return this.revenueEntry(project, period)?.entry.amount ?? 0
    }

    revenueMonth (project: MasterWorkspaceProject<BaseTabComponent>, period = this.revenuePeriod): string {
        return this.revenueEntry(project, period)?.entry.month ?? ''
    }

    revenueMonthLabel (project: MasterWorkspaceProject<BaseTabComponent>, period = this.revenuePeriod): string {
        const month = this.revenueMonth(project, period)
        if (!month) { return period === 'current' ? 'This month' : 'Last month' }
        const cached = this.revenueMonthLabels.get(month)
        if (cached) { return cached }
        const date = new Date(`${month}-01T00:00:00`)
        const label = Number.isFinite(date.getTime())
            ? date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
            : month
        this.revenueMonthLabels.set(month, label)
        return label
    }

    revenueDelta (project: MasterWorkspaceProject<BaseTabComponent>, period = this.revenuePeriod): number|null {
        const selected = this.revenueEntry(project, period)
        if (!selected || selected.index < 1) { return null }
        const previous = project.metadata.revenue.history[selected.index - 1].amount
        if (previous === 0) { return null }
        return Math.round((selected.entry.amount - previous) / previous * 100)
    }

    formatRevenueDelta (value: number|null): string {
        if (value === null) { return '—' }
        return `${value > 0 ? '+' : ''}${value}%`
    }

    revenueShareRate (project: MasterWorkspaceProject<BaseTabComponent>): number|null {
        const cached = this.revenueShareRateCache.get(project)
        if (cached !== undefined) { return cached }
        const match = project.metadata.revenue.source?.match(/owner share \(([0-9]+(?:\.[0-9]+)?)%\)/i)
        if (!match) {
            this.revenueShareRateCache.set(project, null)
            return null
        }
        const value = Number(match[1])
        const rate = Number.isFinite(value) ? value : null
        this.revenueShareRateCache.set(project, rate)
        return rate
    }

    hasRevenueRate (project: MasterWorkspaceProject<BaseTabComponent>): boolean {
        return this.revenueShareRate(project) !== null || this.revenueDelta(project) !== null
    }

    isSelectedRevenueMonth (project: MasterWorkspaceProject<BaseTabComponent>, month: string): boolean {
        return this.revenueMonth(project) === month
    }

    formatMoney (value: number, currency: string): string {
        try {
            let formatter = this.moneyFormatters.get(currency)
            if (!formatter) {
                formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 })
                this.moneyFormatters.set(currency, formatter)
            }
            return formatter.format(value)
        } catch {
            return `${currency} ${Math.round(value).toLocaleString()}`
        }
    }

    workStateLabel (state: string): string {
        const labels: Partial<Record<string, string>> = {
            in_progress: 'In progress', todo: 'Todo', backlog: 'Backlog',
            done: 'Done', blocked: 'Blocked', cancelled: 'Cancelled',
        }
        return labels[state] ?? state
    }

    trackByProject (_index: number, project: MasterWorkspaceProject<BaseTabComponent>): string { return project.id }
    trackByConnection (_index: number, item: ConnectionProjectItem<BaseTabComponent>): string { return item.key }
    trackBySearchResult (_index: number, item: MasterWorkspaceSearchResult<BaseTabComponent>): string { return item.key }
    trackByWorkItem (_index: number, item: MasterWorkspaceWorkItem): string { return item.id }
    trackByKanbanColumn (_index: number, column: MasterWorkspaceKanbanColumn): string { return column.key }

    private updateProjects (): void {
        this.projects = this.workspace.projects
        if (this.selectedProject) {
            this.selectedProject = this.projects.find(project => project.id === this.selectedProject?.id) ?? null
            if (!this.selectedProject && this.view === 'project') { this.view = 'overview' }
        } else if (this.projects.length && this.view === 'overview') {
            this.selectedProject = this.projects.find(project => project.id === 'mamasign')
                ?? this.projects.find(project => project.name.toLocaleLowerCase() === 'mamasign')
                ?? this.projects[0]
            this.view = 'project'
        }
    }

    private revenueEntry (
        project: MasterWorkspaceProject<BaseTabComponent>,
        period: RevenuePeriod,
    ): { entry: { month: string, amount: number }, index: number }|null {
        const history = project.metadata.revenue.history
        if (!history.length) { return null }
        const date = new Date()
        date.setDate(1)
        if (period === 'previous') { date.setMonth(date.getMonth() - 1) }
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        let index = history.findIndex(entry => entry.month === key)
        if (index < 0) { index = history.length - (period === 'current' ? 1 : 2) }
        if (index < 0) { return null }
        return { entry: history[index], index }
    }

    private workViewData (project: MasterWorkspaceProject<BaseTabComponent>): {
        key: string
        items: MasterWorkspaceWorkItem[]
        columns: MasterWorkspaceKanbanColumn[]
    } {
        const now = new Date()
        const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
        const filters = this.workFilters
        const key = [filters.query, filters.status, filters.priority, filters.created, filters.due, today].join('\0')
        const cached = this.workViewCache.get(project)
        if (cached?.key === key) { return cached }
        const items = filterMasterWorkspaceWorkItems(project.metadata.work.items ?? [], filters, now)
        const value = { key, items, columns: buildMasterWorkspaceKanban(items) }
        this.workViewCache.set(project, value)
        return value
    }

    private revenueHistoryFromDraft (value: string): { month: string, amount: number }[] {
        const amounts = value.split(',').map(item => Number(item.trim())).filter(Number.isFinite).slice(-12)
        const now = new Date()
        return amounts.map((amount, index) => {
            const date = new Date(now.getFullYear(), now.getMonth() - amounts.length + index + 1, 1)
            return { month: date.toISOString().slice(0, 7), amount: Math.max(0, amount) }
        })
    }

    private async saveKnowledgeMetadata (
        project: MasterWorkspaceProject<BaseTabComponent>,
        metadata: MasterWorkspaceProjectMetadata,
        successMessage: string,
    ): Promise<void> {
        this.saving = true
        this.error = ''
        this.knowledgeError = ''
        try {
            await this.workspace.saveProject(project, metadata, project.priority)
            this.selectedProject = this.projects.find(item => item.id === project.id) ?? null
            this.cancelKnowledgeEditor()
            this.status = successMessage
        } catch (error) {
            this.knowledgeError = error instanceof Error ? error.message : 'Could not save project knowledge.'
        } finally {
            this.saving = false
        }
    }

    private emptyDraft (): ProjectDraft {
        return {
            priority: 3, description: '', notes: '', total: 0, completed: 0, blocked: 0, overdue: 0,
            health: 'unknown', knowledgePath: '/aamir', planeIdentifier: '',
            revenueCurrency: 'USD', revenueCurrent: 0, revenueSource: '', revenueHistory: '',
        }
    }

    private emptyWorkFilters (): MasterWorkspaceWorkFilters {
        return { query: '', status: 'all', priority: 'all', created: 'all', due: 'all' }
    }
}
