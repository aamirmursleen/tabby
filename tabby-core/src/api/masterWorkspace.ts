export abstract class MasterWorkspaceSyncProvider {
    abstract loadSnapshot (force?: boolean): Promise<unknown|null>
}
