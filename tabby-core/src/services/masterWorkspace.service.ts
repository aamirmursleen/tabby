import deepClone from 'clone-deep'
import { BehaviorSubject } from 'rxjs'
import { Injectable, InjectFlags, Injector } from '@angular/core'

import { MasterWorkspaceSyncProvider } from '../api/masterWorkspace'
import { PartialProfile, Profile } from '../api/profileProvider'
import { PlatformService } from '../api/platform'
import { BaseTabComponent } from '../components/baseTab.component'
import { SplitTabComponent } from '../components/splitTab.component'
import { buildActiveSessionItems, ActiveSessionItem } from '../utils/openTabs'
import {
    applyFounderBriefingSchedule,
    buildFallbackFounderBriefing,
    buildFounderBriefingRequest,
    FounderBriefingSchedule,
    nextFounderBriefingRun,
    shouldRunFounderBriefing,
} from '../utils/founderBriefing'
import { buildTabbyAgentProfile, TABBY_AGENT_TITLE } from '../utils/tabbyAgent'
import {
    buildConnectionProjects,
    ConnectionProfileLike,
    ConnectionProjectItem,
    normalizeConnectionResumeContext,
} from '../utils/connectionProjects'
import {
    buildMasterWorkspaceProjects,
    MasterWorkspaceProject,
    MasterWorkspaceProjectMetadata,
    MasterWorkspaceRemoteSnapshot,
    MasterWorkspaceWorkItem,
    mergeMasterWorkspaceRemoteSnapshot,
    normalizeMasterWorkspaceMetadata,
    organizeFounderProjects,
} from '../utils/masterWorkspace'
import { AppService } from './app.service'
import { ConfigService } from './config.service'
import { ProfilesService } from './profiles.service'

export interface MasterWorkspaceSettings {
    relayUrl: string
    workspaceSlug: string
}

@Injectable({ providedIn: 'root' })
export class MasterWorkspaceService {
    projects: MasterWorkspaceProject<BaseTabComponent>[] = []
    loading = true
    error = ''
    syncLoading = false
    syncError = ''
    syncSource = 'Nafran OS API'
    lastSyncedAt = ''
    briefingLoading = false
    briefingError = ''
    readonly changed$ = new BehaviorSubject<void>(undefined)
    private refreshGeneration = 0
    private remoteSnapshot: MasterWorkspaceRemoteSnapshot|null = null
    private syncOperation: Promise<void>|null = null
    private readonly syncProviders: MasterWorkspaceSyncProvider[]
    private readonly projectWorkItems = new Map<string, MasterWorkspaceWorkItem[]>()
    private readonly workItemOperations = new Map<string, Promise<void>>()
    private readonly loadingWorkItemProjects = new Set<string>()
    private readonly workItemErrors = new Map<string, string>()
    private briefingOperation: Promise<'codex'|'local'>|null = null
    private briefingTimer: number|null = null

    constructor (
        private app: AppService,
        private config: ConfigService,
        private profiles: ProfilesService,
        private platform: PlatformService,
        injector: Injector,
    ) {
        const providers = injector.get(MasterWorkspaceSyncProvider, null, InjectFlags.Optional) as unknown as MasterWorkspaceSyncProvider[]|null
        this.syncProviders = providers ?? []
        this.app.activeTabChange$.subscribe(() => this.refresh())
        this.app.tabStateChanged$.subscribe(() => this.refresh())
        this.config.changed$.subscribe(() => {
            void this.refresh()
            this.scheduleFounderBriefing()
        })
        this.config.ready$.toPromise().then(async () => {
            await this.refresh()
            await this.syncRemoteData()
            this.scheduleFounderBriefing()
            window.setInterval(() => this.syncRemoteData(), 60_000)
        })
    }

    get settings (): MasterWorkspaceSettings {
        return {
            relayUrl: this.config.store?.masterWorkspace?.relay?.url ?? '',
            workspaceSlug: this.config.store?.masterWorkspace?.relay?.workspaceSlug ?? '',
        }
    }

    get briefingSchedule (): FounderBriefingSchedule {
        const value = this.config.store?.masterWorkspace?.briefing
        return {
            enabled: value?.enabled !== false,
            hour: Number.isFinite(value?.hour) ? Math.min(23, Math.max(0, Math.floor(value.hour))) : 9,
            minute: Number.isFinite(value?.minute) ? Math.min(59, Math.max(0, Math.floor(value.minute))) : 0,
            lastRunAt: typeof value?.lastRunAt === 'string' && Number.isFinite(Date.parse(value.lastRunAt))
                ? value.lastRunAt
                : undefined,
            lastRunDate: typeof value?.lastRunDate === 'string' ? value.lastRunDate : undefined,
        }
    }

    get nextBriefingAt (): Date|null {
        const schedule = this.briefingSchedule
        if (!schedule.enabled) { return null }
        const now = new Date()
        return shouldRunFounderBriefing(schedule, now)
            ? now
            : nextFounderBriefingRun(now, schedule.hour, schedule.minute, schedule.lastRunDate)
    }

    async refresh (): Promise<void> {
        if (!this.config.store) { return }
        const generation = ++this.refreshGeneration
        try {
            const liveItems = await buildActiveSessionItems(this.app.tabs, this.app.activeTab)
            if (generation !== this.refreshGeneration) { return }
            const connectionProjects = organizeFounderProjects(buildConnectionProjects(
                this.config.store.groups ?? [],
                (this.config.store.profiles ?? []) as ConnectionProfileLike[],
                liveItems,
                this.config.store.connectionResumeContexts ?? {},
            ))
            this.projects = buildMasterWorkspaceProjects(
                connectionProjects,
                this.remoteSnapshot
                    ? mergeMasterWorkspaceRemoteSnapshot(
                        connectionProjects,
                        this.config.store.masterWorkspace?.projects ?? {},
                        this.remoteSnapshot,
                    )
                    : this.config.store.masterWorkspace?.projects ?? {},
                Date.now(),
            )
            this.error = ''
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Could not load the Master Workspace.'
        } finally {
            if (generation === this.refreshGeneration) {
                this.loading = false
                this.changed$.next()
            }
        }
    }

    async syncRemoteData (force = false): Promise<void> {
        if (this.syncOperation) { return this.syncOperation }
        this.syncOperation = this.performRemoteSync(force)
        try {
            await this.syncOperation
        } finally {
            this.syncOperation = null
        }
    }

    hasLoadedWorkItems (projectID: string): boolean {
        return this.projectWorkItems.has(projectID)
    }

    isLoadingWorkItems (projectID: string): boolean {
        return this.loadingWorkItemProjects.has(projectID)
    }

    workItemsError (projectID: string): string {
        return this.workItemErrors.get(projectID) ?? ''
    }

    async syncProjectWorkItems (project: MasterWorkspaceProject<BaseTabComponent>, force = false): Promise<void> {
        if (!force && this.projectWorkItems.has(project.id)) { return }
        const active = this.workItemOperations.get(project.id)
        if (active) { return active }
        const operation = this.performWorkItemSync(project, force)
        this.workItemOperations.set(project.id, operation)
        try {
            await operation
        } finally {
            this.workItemOperations.delete(project.id)
        }
    }

    async launchTabbyAgent (): Promise<'opened'|'focused'> {
        const existing = this.app.tabs.find(tab => tab.customTitle === TABBY_AGENT_TITLE || tab.title === TABBY_AGENT_TITLE)
        if (existing) {
            this.app.selectTab(existing)
            return 'focused'
        }
        const opened = await this.profiles.openNewTabForProfile(buildTabbyAgentProfile())
        if (!opened) { throw new Error('Could not open the Tabby AI Agent terminal.') }
        return 'opened'
    }

    async runFounderBriefing (force = false): Promise<'codex'|'local'> {
        if (this.briefingOperation) { return this.briefingOperation }
        this.briefingOperation = this.performFounderBriefing(force)
        try {
            return await this.briefingOperation
        } finally {
            this.briefingOperation = null
            this.scheduleFounderBriefing()
        }
    }

    async activateConnection (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (item.liveItem) {
            this.selectLiveConnection(item.liveItem)
            return
        }
        if (!item.profile) { return }
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
    }

    async launchFreshConnection (item: ConnectionProjectItem<BaseTabComponent>): Promise<void> {
        if (!item.profile) {
            if (item.liveItem) { this.selectLiveConnection(item.liveItem) }
            return
        }
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
    }

    async saveProject (
        project: MasterWorkspaceProject<BaseTabComponent>,
        metadata: MasterWorkspaceProjectMetadata,
        priority: number,
    ): Promise<void> {
        const previousProjects = deepClone(this.config.store.masterWorkspace.projects ?? {})
        const projectName = project.name.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase()
        const group = this.config.store.groups.find(value => value.id === project.id
            || value.name.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase() === projectName)
        const previousPriority = group?.priority
        const nextPriority = Math.min(4, Math.max(1, Math.floor(Number(priority))))
        this.config.store.masterWorkspace.projects = {
            ...previousProjects,
            [project.id]: normalizeMasterWorkspaceMetadata({ ...metadata, priority: nextPriority }),
        }
        if (group) { group.priority = nextPriority }
        try {
            await this.config.save()
            await this.refresh()
        } catch (error) {
            this.config.store.masterWorkspace.projects = previousProjects
            if (group) { group.priority = previousPriority }
            throw error
        }
    }

    async saveSettings (value: MasterWorkspaceSettings): Promise<void> {
        const relayUrl = value.relayUrl.trim()
        if (relayUrl && !/^https:\/\/[^\s]+$/i.test(relayUrl)) {
            throw new Error('Relay URL must use HTTPS.')
        }
        const workspaceSlug = value.workspaceSlug.trim().slice(0, 120)
        const previous = deepClone(this.config.store.masterWorkspace.relay)
        this.config.store.masterWorkspace.relay = { url: relayUrl, workspaceSlug }
        try {
            await this.config.save()
        } catch (error) {
            this.config.store.masterWorkspace.relay = previous
            throw error
        }
    }

    async openLink (url: string): Promise<void> {
        if (!/^https?:\/\/[^\s]+$/i.test(url)) { return }
        await this.platform.openExternal(url)
    }

    private async performRemoteSync (force: boolean): Promise<void> {
        if (!this.syncProviders.length) { return }
        this.syncLoading = true
        this.syncError = ''
        this.changed$.next()
        try {
            let loaded: unknown|null = null
            for (const provider of this.syncProviders) {
                loaded = await provider.loadSnapshot(force)
                if (loaded) { break }
            }
            if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
                throw new Error('Nafran OS API did not return a workspace snapshot.')
            }
            const snapshotValue = loaded as Record<string, unknown>
            if (snapshotValue.schemaVersion !== 1 || typeof snapshotValue.generatedAt !== 'string'
                || !Number.isFinite(Date.parse(snapshotValue.generatedAt))) {
                throw new Error('Nafran OS API returned an unsupported workspace snapshot.')
            }
            const snapshot = snapshotValue as unknown as MasterWorkspaceRemoteSnapshot
            this.applyCachedWorkItems(snapshot)
            this.remoteSnapshot = snapshot
            this.syncSource = typeof snapshot.source === 'string' ? snapshot.source.slice(0, 120) : 'Nafran OS API'
            this.lastSyncedAt = snapshot.generatedAt
            await this.refresh()
        } catch (error) {
            this.syncError = error instanceof Error ? error.message : 'Could not sync the Nafran OS API.'
        } finally {
            this.syncLoading = false
            this.changed$.next()
        }
    }

    private async performWorkItemSync (project: MasterWorkspaceProject<BaseTabComponent>, force: boolean): Promise<void> {
        const workspaceSlug = project.metadata.plane.workspaceSlug
        if (!workspaceSlug) {
            this.workItemErrors.set(project.id, 'This project is not mapped to a connected Plane workspace.')
            this.changed$.next()
            return
        }
        const provider = this.syncProviders.find(candidate => typeof candidate.loadWorkItems === 'function')
        if (!provider?.loadWorkItems) {
            this.workItemErrors.set(project.id, 'Detailed Plane work-item sync is unavailable in this build.')
            this.changed$.next()
            return
        }

        this.loadingWorkItemProjects.add(project.id)
        this.workItemErrors.delete(project.id)
        this.changed$.next()
        try {
            const loaded = await provider.loadWorkItems(workspaceSlug, force, project.metadata.plane.projectId)
            const normalized = normalizeMasterWorkspaceMetadata({
                work: { ...project.metadata.work, items: Array.isArray(loaded) ? loaded : [] },
            }).work
            const items = normalized?.items ?? []
            this.projectWorkItems.set(project.id, items)
            if (this.remoteSnapshot) {
                this.applyCachedWorkItems(this.remoteSnapshot)
                await this.refresh()
            }
        } catch (error) {
            this.workItemErrors.set(
                project.id,
                error instanceof Error ? error.message : 'Could not sync detailed Plane work items.',
            )
        } finally {
            this.loadingWorkItemProjects.delete(project.id)
            this.changed$.next()
        }
    }

    private async performFounderBriefing (force: boolean): Promise<'codex'|'local'> {
        this.briefingLoading = true
        this.briefingError = ''
        this.changed$.next()
        const startedAt = new Date()
        let source: 'codex'|'local' = 'local'
        let responseProjects: any[] = []
        let projectsForBriefing: MasterWorkspaceProject<BaseTabComponent>[] = this.projects
        try {
            await this.syncRemoteData(force)
            await this.refreshProjectWorkItemsForBriefing(force)
            projectsForBriefing = this.projects.map(project => ({
                ...project,
                metadata: {
                    ...project.metadata,
                    work: {
                        ...project.metadata.work,
                        items: this.projectWorkItems.get(project.id) ?? project.metadata.work.items ?? [],
                    },
                },
            }))
            const request = buildFounderBriefingRequest(projectsForBriefing, startedAt)
            const provider = this.syncProviders.find(candidate => typeof candidate.runFounderBriefing === 'function')
            if (!provider?.runFounderBriefing) { throw new Error('This build does not include the Codex briefing provider.') }
            const loaded = await provider.runFounderBriefing(request)
            if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
                throw new Error('Codex returned an invalid founder briefing.')
            }
            const loadedProjects = (loaded as Record<string, unknown>).projects
            if (!Array.isArray(loadedProjects)) { throw new Error('Codex returned no project briefings.') }
            responseProjects = loadedProjects
            source = 'codex'
        } catch (error) {
            this.briefingError = error instanceof Error ? error.message : 'Codex could not create the daily briefing.'
        }

        const responseByID = new Map(responseProjects.flatMap(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string') { return [] }
            return [[value.id, value] as const]
        }))
        const previousProjects = deepClone(this.config.store.masterWorkspace.projects ?? {})
        const previousSchedule = deepClone(this.config.store.masterWorkspace.briefing)
        const generatedAt = new Date().toISOString()
        try {
            const nextProjects = { ...previousProjects }
            for (const project of projectsForBriefing) {
                const codexValue = responseByID.get(project.id)
                const briefing = codexValue
                    ? normalizeMasterWorkspaceMetadata({ briefing: codexValue }).briefing
                    : buildFallbackFounderBriefing(project, new Date(generatedAt))
                if (!briefing) { continue }
                const saved = normalizeMasterWorkspaceMetadata(previousProjects[project.id])
                nextProjects[project.id] = normalizeMasterWorkspaceMetadata({ ...saved, briefing })
            }
            const localDate = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, '0')}-${String(startedAt.getDate()).padStart(2, '0')}`
            this.config.store.masterWorkspace.projects = nextProjects
            applyFounderBriefingSchedule(this.config.store.masterWorkspace.briefing, {
                enabled: true,
                hour: this.briefingSchedule.hour,
                minute: this.briefingSchedule.minute,
                lastRunAt: generatedAt,
                lastRunDate: localDate,
            })
            await this.config.save()
            await this.refresh()
            return source
        } catch (error) {
            this.config.store.masterWorkspace.projects = previousProjects
            applyFounderBriefingSchedule(this.config.store.masterWorkspace.briefing, previousSchedule)
            throw error
        } finally {
            this.briefingLoading = false
            this.scheduleFounderBriefing()
            this.changed$.next()
        }
    }

    private async refreshProjectWorkItemsForBriefing (force: boolean): Promise<void> {
        const projects = this.projects.filter(project => !!project.metadata.plane.workspaceSlug)
        let index = 0
        const worker = async (): Promise<void> => {
            while (index < projects.length) {
                await this.syncProjectWorkItems(projects[index++], force)
            }
        }
        await Promise.all(Array.from({ length: Math.min(2, projects.length) }, () => worker()))
    }

    private scheduleFounderBriefing (): void {
        if (!this.config.store?.masterWorkspace) { return }
        if (this.briefingTimer !== null) {
            window.clearTimeout(this.briefingTimer)
            this.briefingTimer = null
        }
        const schedule = this.briefingSchedule
        if (!schedule.enabled || this.briefingLoading) { return }
        const now = new Date()
        const runIfDue = (): void => {
            this.briefingTimer = null
            if (shouldRunFounderBriefing(this.briefingSchedule, new Date())) {
                void this.runFounderBriefing(true)
            } else {
                this.scheduleFounderBriefing()
            }
        }
        if (shouldRunFounderBriefing(schedule, now)) {
            this.briefingTimer = window.setTimeout(runIfDue, 1_000)
            return
        }
        const next = nextFounderBriefingRun(now, schedule.hour, schedule.minute, schedule.lastRunDate)
        this.briefingTimer = window.setTimeout(runIfDue, Math.max(1_000, next.getTime() - now.getTime()))
    }

    private applyCachedWorkItems (snapshot: MasterWorkspaceRemoteSnapshot): void {
        const identity = (value: unknown): string => typeof value === 'string'
            ? value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 160)
            : ''
        for (const remote of snapshot.projects) {
            const identities = [remote.id, remote.name, ...remote.aliases ?? []].map(identity).filter(Boolean)
            const cached = [...this.projectWorkItems.entries()].find(([projectID]) => identities.includes(identity(projectID)))
            if (!cached) { continue }
            const work = remote.work ?? { total: cached[1].length, completed: 0, blocked: 0, overdue: 0 }
            remote.work = { ...work, items: cached[1] }
        }
    }

    private selectLiveConnection (item: ActiveSessionItem<BaseTabComponent>): void {
        if (!this.app.tabs.includes(item.topLevelTab)) {
            this.refresh()
            return
        }
        this.app.selectTab(item.topLevelTab)
        if (item.topLevelTab instanceof SplitTabComponent && item.topLevelTab.getAllTabs().includes(item.tab)) {
            item.topLevelTab.focus(item.tab)
        } else {
            item.tab.emitFocused()
        }
    }
}
