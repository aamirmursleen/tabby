import { Component, EventEmitter, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core'

import { BaseTabComponent } from './baseTab.component'
import { BaseComponent } from './base.component'
import { ConnectionProjectItem } from '../utils/connectionProjects'
import {
    buildMasterWorkspaceSearchResults,
    MasterWorkspaceProject,
    MasterWorkspaceProjectMetadata,
    MasterWorkspaceSearchResult,
} from '../utils/masterWorkspace'
import { MasterWorkspaceService, MasterWorkspaceSettings } from '../services/masterWorkspace.service'

type WorkspaceView = 'overview'|'project'|'work'|'knowledge'|'connections'|'settings'

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
    projectQuery = ''
    commandQuery = ''
    commandPaletteOpen = false
    editorOpen = false
    saving = false
    busyConnectionKey: string|null = null
    error = ''
    status = ''
    draft: ProjectDraft = this.emptyDraft()
    settingsDraft: MasterWorkspaceSettings = { relayUrl: '', workspaceSlug: '' }

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
            const text = `${project.name} ${project.metadata.description} ${project.connections.map(connection => connection.label).join(' ')}`.toLocaleLowerCase()
            return terms.every(term => text.includes(term))
        })
    }

    get searchResults (): MasterWorkspaceSearchResult<BaseTabComponent>[] {
        return buildMasterWorkspaceSearchResults(this.projects, this.commandQuery)
    }

    get attentionProjects (): MasterWorkspaceProject<BaseTabComponent>[] {
        return this.projects.filter(project => project.attention.band === 'attention').slice(0, 5)
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
        this.commandPaletteOpen = false
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

    trackByProject (_index: number, project: MasterWorkspaceProject<BaseTabComponent>): string { return project.id }
    trackByConnection (_index: number, item: ConnectionProjectItem<BaseTabComponent>): string { return item.key }
    trackBySearchResult (_index: number, item: MasterWorkspaceSearchResult<BaseTabComponent>): string { return item.key }

    private updateProjects (): void {
        this.projects = this.workspace.projects
        if (this.selectedProject) {
            this.selectedProject = this.projects.find(project => project.id === this.selectedProject?.id) ?? null
            if (!this.selectedProject && this.view === 'project') { this.view = 'overview' }
        }
    }

    private emptyDraft (): ProjectDraft {
        return {
            priority: 3, description: '', notes: '', total: 0, completed: 0, blocked: 0, overdue: 0,
            health: 'unknown', knowledgePath: '/aamir', planeIdentifier: '',
        }
    }
}
