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
    readonly changed$ = new BehaviorSubject<void>(undefined)
    private refreshGeneration = 0
    private remoteSnapshot: MasterWorkspaceRemoteSnapshot|null = null
    private syncOperation: Promise<void>|null = null
    private readonly syncProviders: MasterWorkspaceSyncProvider[]
    private readonly projectWorkItems = new Map<string, MasterWorkspaceWorkItem[]>()
    private readonly workItemOperations = new Map<string, Promise<void>>()
    private readonly loadingWorkItemProjects = new Set<string>()
    private readonly workItemErrors = new Map<string, string>()

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
        this.config.changed$.subscribe(() => this.refresh())
        this.config.ready$.toPromise().then(async () => {
            await this.refresh()
            await this.syncRemoteData()
            window.setInterval(() => this.syncRemoteData(), 60_000)
        })
    }

    get settings (): MasterWorkspaceSettings {
        return {
            relayUrl: this.config.store?.masterWorkspace?.relay?.url ?? '',
            workspaceSlug: this.config.store?.masterWorkspace?.relay?.workspaceSlug ?? '',
        }
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
