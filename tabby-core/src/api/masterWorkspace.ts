export abstract class MasterWorkspaceSyncProvider {
    abstract loadSnapshot (force?: boolean): Promise<unknown|null>
    loadWorkItems? (workspaceSlug: string, force?: boolean): Promise<unknown|null>
}
