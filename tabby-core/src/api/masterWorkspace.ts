export abstract class MasterWorkspaceSyncProvider {
    abstract loadSnapshot (force?: boolean): Promise<unknown|null>
    loadWorkItems? (workspaceSlug: string, force?: boolean, projectId?: string): Promise<unknown|null>
    runFounderBriefing? (request: unknown): Promise<unknown|null>
}
