import deepClone from 'clone-deep'
import { Component, EventEmitter, HostListener, OnDestroy, OnInit, Output } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import { PartialProfile, PartialProfileGroup, Profile, ProfileGroup } from '../api/profileProvider'
import { AppService } from '../services/app.service'
import { ConfigService } from '../services/config.service'
import { ProfilesService } from '../services/profiles.service'
import { SelectorService } from '../services/selector.service'
import { ActiveSessionItem, buildActiveSessionItems } from '../utils/openTabs'
import {
    buildConnectionProjects,
    ConnectionPriority,
    ConnectionProfileLike,
    ConnectionProject,
    ConnectionProjectItem,
    filterConnectionProjects,
    getConnectionPriorityLabel,
    normalizeConnectionPriority,
    normalizeConnectionResumeContext,
} from '../utils/connectionProjects'
import { BaseComponent } from './base.component'
import { BaseTabComponent, BaseTabSessionState } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'

interface PriorityBucket {
    priority: ConnectionPriority
    label: string
    projects: ConnectionProject<BaseTabComponent>[]
}

/** @hidden */
@Component({
    selector: 'active-sessions',
    templateUrl: './activeSessions.component.pug',
    styleUrls: ['./activeSessions.component.scss'],
})
export class ActiveSessionsComponent extends BaseComponent implements OnInit, OnDestroy {
    @Output() closed = new EventEmitter<void>()
    items: ActiveSessionItem<BaseTabComponent>[] = []
    projects: ConnectionProject<BaseTabComponent>[] = []
    query = ''
    busyKey: string|null = null
    error = ''
    private refreshTimer: number|null = null
    private refreshGeneration = 0
    private collapsedProjects = new Set<string>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private profiles: ProfilesService,
        private selector: SelectorService,
        private ngbModal: NgbModal,
    ) {
        super()
        this.subscribeUntilDestroyed(this.app.tabsChanged$, () => this.refreshItems())
        this.subscribeUntilDestroyed(this.app.activeTabChange$, () => this.refreshItems())
        this.subscribeUntilDestroyed(this.config.changed$, () => this.refreshItems())
        try {
            const saved = JSON.parse(window.localStorage.connectionProjectCollapsed ?? '[]')
            this.collapsedProjects = new Set(Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : [])
        } catch { }
    }

    @HostListener('keydown', ['$event'])
    @HostListener('keyup', ['$event'])
    protectEditorKeys (event: KeyboardEvent): void {
        // Keep search and project controls from forwarding their keystrokes to the active terminal.
        event.stopPropagation()
    }

    async ngOnInit (): Promise<void> {
        try {
            await this.seedRequestedProjects()
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not initialize connection projects.'
        }
        await this.refreshItems()
        this.refreshTimer = window.setInterval(() => this.refreshItems(), 2500)
    }

    ngOnDestroy (): void {
        if (this.refreshTimer !== null) {
            window.clearInterval(this.refreshTimer)
        }
        this.refreshGeneration++
        super.ngOnDestroy()
    }

    get connectionCount (): number {
        return this.projects.reduce((total, project) => total + project.connections.length, 0)
    }

    get liveConnectionCount (): number {
        return this.projects.reduce((total, project) => total + project.liveCount, 0)
    }

    get priorityBuckets (): PriorityBucket[] {
        const projects = filterConnectionProjects(this.projects, this.query)
        return ([1, 2, 3, 4] as ConnectionPriority[]).map(priority => ({
            priority,
            label: getConnectionPriorityLabel(priority),
            projects: projects.filter(project => project.priority === priority),
        })).filter(bucket => bucket.projects.length > 0)
    }

    async activate (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (item.liveItem) {
            this.select(item.liveItem)
            return
        }
        if (!item.profile || this.busyKey) { return }
        this.busyKey = item.key
        this.error = ''
        try {
            const profile = deepClone(item.profile) as PartialProfile<Profile>
            const savedContext = profile.id
                ? normalizeConnectionResumeContext(this.config.store.connectionResumeContexts?.[profile.id])
                : null
            if (savedContext) {
                profile.options ??= {}
                profile.options['aamirResumeContext'] = savedContext
                if (profile.type === 'local' && savedContext.workingDirectory) {
                    profile.options['cwd'] = savedContext.workingDirectory
                }
            }
            await this.profiles.launchProfile(profile)
            await this.refreshItems()
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not open this connection.'
        } finally {
            this.busyKey = null
        }
    }

    select (item: ActiveSessionItem<BaseTabComponent>): void {
        if (!this.app.tabs.includes(item.topLevelTab)) {
            this.refreshItems()
            return
        }
        this.app.selectTab(item.topLevelTab)
        if (item.topLevelTab instanceof SplitTabComponent && item.topLevelTab.getAllTabs().includes(item.tab)) {
            item.topLevelTab.focus(item.tab)
        } else {
            item.tab.emitFocused()
        }
        this.refreshItems()
    }

    toggleProject (project: ConnectionProject<BaseTabComponent>): void {
        if (this.collapsedProjects.has(project.id)) {
            this.collapsedProjects.delete(project.id)
        } else {
            this.collapsedProjects.add(project.id)
        }
        window.localStorage.connectionProjectCollapsed = JSON.stringify([...this.collapsedProjects])
    }

    isProjectCollapsed (project: ConnectionProject<BaseTabComponent>): boolean {
        return this.collapsedProjects.has(project.id) && !this.query.trim()
    }

    async setProjectPriority (project: ConnectionProject<BaseTabComponent>, value: number|string): Promise<void> {
        const group = this.config.store.groups.find(x => x.id === project.id)
        if (!group) { return }
        const next = normalizeConnectionPriority(Number(value), group.name)
        if (normalizeConnectionPriority(group.priority, group.name) === next) { return }
        const previous = group.priority
        group.priority = next
        project.priority = group.priority
        try {
            await this.config.save()
        } catch (error) {
            group.priority = previous
            project.priority = normalizeConnectionPriority(previous, group.name)
            this.error = error instanceof Error ? error.message : 'Could not save project priority.'
        }
    }

    async addProject (): Promise<void> {
        if (this.busyKey) { return }
        const { EditProfileGroupModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(EditProfileGroupModalComponent, { size: 'lg' })
        modal.componentInstance.group = { id: 'new', name: '', icon: 'far fa-folder', priority: 3 }
        modal.componentInstance.providers = this.profiles.getProviders()
        const result = await modal.result.catch(() => null)
        if (!result?.group) { return }
        result.group.priority = normalizeConnectionPriority(result.group.priority, result.group.name)
        await this.profiles.writeProfileGroup(result.group)
        await this.config.save()
        await this.refreshItems()
    }

    async editProject (project: ConnectionProject<BaseTabComponent>, event: MouseEvent): Promise<void> {
        event.stopPropagation()
        const group = this.config.store.groups.find(x => x.id === project.id)
        if (!group || this.busyKey) { return }
        const { EditProfileGroupModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(EditProfileGroupModalComponent, { size: 'lg' })
        modal.componentInstance.group = deepClone(group)
        modal.componentInstance.providers = this.profiles.getProviders()
        const result = await modal.result.catch(() => null)
        if (!result?.group) { return }
        result.group.priority = normalizeConnectionPriority(result.group.priority, result.group.name)
        await this.profiles.writeProfileGroup(result.group)
        await this.config.save()
        await this.refreshItems()
    }

    async addConnection (project: ConnectionProject<BaseTabComponent>, event?: MouseEvent): Promise<void> {
        event?.stopPropagation()
        if (this.busyKey !== null || project.id === 'ungrouped') { return }
        const candidates = (await this.profiles.getProfiles())
            .filter(profile => profile.type !== 'split-layout' && !!this.profiles.providerForProfile(profile))
        const base = await this.selector.show(
            `Add connection to ${project.name}`,
            candidates.map(profile => ({
                name: profile.name,
                group: profile.isTemplate ? 'New connection' : 'Duplicate a saved connection',
                description: this.profiles.getDescription(profile) ?? undefined,
                icon: profile.icon ?? undefined,
                result: profile,
                weight: profile.isTemplate ? 0 : 1,
            })),
        ).catch(() => null)
        if (base == null) { return }

        const draft: PartialProfile<Profile> = deepClone(base)
        delete draft.id
        draft.group = project.id
        draft.isBuiltin = false
        draft.isTemplate = false
        draft.name = base.isTemplate ? '' : `${base.name} copy`
        const result = await this.showProfileEditor(draft)
        if (!result) { return }
        result.group = project.id
        if (!result.name) {
            const fullProfile = this.profiles.getConfigProxyForProfile(result)
            result.name = this.profiles.providerForProfile(result)?.getSuggestedName(fullProfile) ?? `${base.name} copy`
        }
        await this.profiles.newProfile(result)
        await this.config.save()
        this.collapsedProjects.delete(project.id)
        await this.refreshItems()
    }

    async editConnection (item: ConnectionProjectItem<BaseTabComponent>, event: MouseEvent): Promise<void> {
        event.stopPropagation()
        const profile = item.profile?.id ? this.config.store.profiles.find(x => x.id === item.profile!.id) : null
        if (!profile || this.busyKey) { return }
        const result = await this.showProfileEditor(profile)
        if (!result) { return }
        await this.profiles.writeProfile(result)
        await this.config.save()
        await this.refreshItems()
    }

    trackByProject (_index: number, project: ConnectionProject<BaseTabComponent>): string { return project.id }
    trackByConnection (_index: number, item: ConnectionProjectItem<BaseTabComponent>): string { return item.key }

    statusLabel (state: BaseTabSessionState): string {
        switch (state) {
            case 'running': return 'Running'
            case 'starting': return 'Starting'
            case 'stopped': return 'Offline'
            default: return 'Unknown'
        }
    }

    collapse (): void {
        this.closed.emit()
    }

    itemAriaLabel (item: ConnectionProjectItem<BaseTabComponent>): string {
        return `${item.label}, ${this.statusLabel(item.status.state)}`
    }

    private async showProfileEditor (profile: PartialProfile<Profile>): Promise<PartialProfile<Profile>|null> {
        const provider = this.profiles.providerForProfile(profile)
        if (!provider) { return null }
        const { EditProfileModalComponent } = window['nodeRequire']('tabby-settings')
        const modal = this.ngbModal.open(EditProfileModalComponent, { size: 'lg' })
        modal.componentInstance.partialProfile = deepClone(profile)
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (result) { result.type = provider.id }
        return result
    }

    private async seedRequestedProjects (): Promise<void> {
        if (this.config.store.connectionProjectsSeeded) { return }
        const importantNames = new Set(['calendarjet', 'mamasign', 'wittyform'])
        const key = (name: string): string => name.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase()
        const groups: PartialProfileGroup<ProfileGroup>[] = this.config.store.groups
        for (const group of groups) {
            if (importantNames.has(key(group.name))) { group.priority = 1 }
        }
        if (!groups.some(group => key(group.name) === 'wittyform')) {
            await this.profiles.newProfileGroup({ id: 'new', name: 'Wittyform', icon: 'far fa-folder', priority: 1 })
        }
        this.config.store.connectionProjectsSeeded = true
        await this.config.save()
    }

    private async refreshItems (): Promise<void> {
        const generation = ++this.refreshGeneration
        const items = await buildActiveSessionItems(this.app.tabs, this.app.activeTab)
        if (generation !== this.refreshGeneration) { return }
        this.items = items
        this.projects = buildConnectionProjects(
            this.config.store.groups ?? [],
            (this.config.store.profiles ?? []) as ConnectionProfileLike[],
            items,
            this.config.store.connectionResumeContexts ?? {},
        )
        const previousContexts = deepClone(this.config.store.connectionResumeContexts ?? {})
        if (this.captureResumeContexts(items)) {
            try {
                await this.config.save()
            } catch (error) {
                this.config.store.connectionResumeContexts = previousContexts
                this.error = error instanceof Error ? error.message : 'Could not save the latest connection directory.'
            }
        }
    }

    private captureResumeContexts (items: ActiveSessionItem<BaseTabComponent>[]): boolean {
        const savedProfileIDs = new Set(this.config.store.profiles.map(profile => profile.id).filter(Boolean))
        const contexts = this.config.store.connectionResumeContexts ??= {}
        let changed = false
        for (const item of items) {
            const profileID = (item.tab as BaseTabComponent & { profile?: ConnectionProfileLike }).profile?.id
            const context = normalizeConnectionResumeContext(item.status.resumeContext)
            if (!profileID || !savedProfileIDs.has(profileID) || !context) { continue }
            const previous = normalizeConnectionResumeContext(contexts[profileID])
            if (previous?.tmuxSession === context.tmuxSession && previous?.workingDirectory === context.workingDirectory) { continue }
            contexts[profileID] = context
            changed = true
        }
        return changed
    }
}
