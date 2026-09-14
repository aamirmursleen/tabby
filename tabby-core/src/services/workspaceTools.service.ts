import { Injectable } from '@angular/core'
import { ConfigService } from './config.service'

export interface WorkspaceEntry {
    id: string
    kind: 'note'|'snippet'
    title: string
    body: string
    groupId?: string
    createdAt?: number
    updatedAt?: number
}

export interface WorkspaceSnippetGroup {
    id: string
    name: string
}

export interface WorkspaceTerminal {
    session: { open: boolean }|null
    sendInput: (data: string) => void
    frontend?: { supportsBracketedPaste: () => boolean }|null
}

@Injectable({ providedIn: 'root' })
export class WorkspaceToolsService {
    private mutationQueue: Promise<void> = Promise.resolve()

    constructor (private config: ConfigService) { }

    get entries (): WorkspaceEntry[] {
        return this.readRecords(this.config.store.workspaceNotes, (value): value is WorkspaceEntry => this.isEntry(value))
    }

    get groups (): WorkspaceSnippetGroup[] {
        return this.readRecords(this.config.store.workspaceSnippetGroups, (value): value is WorkspaceSnippetGroup => this.isGroup(value))
    }

    get validationError (): string {
        const entries: unknown = this.config.store.workspaceNotes
        const groups: unknown = this.config.store.workspaceSnippetGroups
        const invalid: string[] = []
        if (entries !== undefined && (!Array.isArray(entries) || entries.some(value => !this.isEntry(value)))) {
            invalid.push('workspaceNotes')
        }
        if (groups !== undefined && (!Array.isArray(groups) || groups.some(value => !this.isGroup(value)))) {
            invalid.push('workspaceSnippetGroups')
        }
        return invalid.length
            ? `Saved snippets or groups contain invalid data. Repair ${invalid.join(' and ')} in your configuration before making changes. Your saved data is preserved.`
            : ''
    }

    async saveEntry (entry: WorkspaceEntry): Promise<void> {
        const draft = { ...entry }
        await this.enqueue(async () => {
            if (!this.isEntry(draft) || !draft.title.trim() || !draft.body.trim()) {
                throw new Error('Add a title and content before saving.')
            }
            if (draft.kind === 'snippet' && draft.groupId && !this.groups.some(group => group.id === draft.groupId)) {
                throw new Error('This group no longer exists. Choose another group or Ungrouped.')
            }
            const entries = [...this.entries]
            const index = entries.findIndex(x => x.id === draft.id)
            const now = Date.now()
            const saved = {
                ...draft,
                title: draft.title.trim(),
                createdAt: entries[index]?.createdAt ?? draft.createdAt ?? now,
                updatedAt: now,
            }
            if (index < 0) {
                entries.push(saved)
            } else {
                entries[index] = saved
            }
            await this.persist(entries, this.groups)
        })
    }

    async deleteEntry (id: string): Promise<void> {
        await this.enqueue(() => this.persist(this.entries.filter(x => x.id !== id), this.groups))
    }

    async saveGroup (group: WorkspaceSnippetGroup): Promise<void> {
        const draft = { ...group }
        await this.enqueue(async () => {
            if (!this.isGroup(draft)) {
                throw new Error('Add a group name before saving.')
            }
            const name = draft.name.trim()
            if (this.groups.some(x => x.id !== draft.id && x.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
                throw new Error('A group with this name already exists.')
            }
            const groups = [...this.groups]
            const index = groups.findIndex(x => x.id === draft.id)
            const saved = { id: draft.id, name }
            if (index < 0) {
                groups.push(saved)
            } else {
                groups[index] = saved
            }
            await this.persist(this.entries, groups)
        })
    }

    async deleteGroup (id: string): Promise<void> {
        await this.enqueue(async () => {
            const now = Date.now()
            const entries = this.entries.map(entry => {
                if (entry.groupId !== id) {
                    return entry
                }
                const ungrouped = { ...entry, updatedAt: now }
                delete ungrouped.groupId
                return ungrouped
            })
            await this.persist(entries, this.groups.filter(group => group.id !== id))
        })
    }

    run (entry: WorkspaceEntry, target: WorkspaceTerminal|null): void {
        const command = this.commandInput(entry, target)
        // Feed only this session, bypassing frontend broadcast subscriptions.
        target!.sendInput(command.replace(/\n/g, '\r').replace(/\r+$/, '') + '\r')
    }

    paste (entry: WorkspaceEntry, target: WorkspaceTerminal|null): void {
        const command = this.commandInput(entry, target)
        const bracketed = target!.frontend?.supportsBracketedPaste() ?? false
        if (!bracketed && command.includes('\n')) {
            throw new Error('Multiline paste requires bracketed paste support. Use Run to execute this command.')
        }
        target!.sendInput(bracketed ? `\x1b[200~${command}\x1b[201~` : command)
    }

    private commandInput (entry: WorkspaceEntry|null, target: WorkspaceTerminal|null): string {
        if (!entry || entry.kind !== 'snippet' || typeof entry.body !== 'string' || !entry.body.trim()) {
            throw new Error('Choose a saved command to run.')
        }
        if (!target?.session?.open) {
            throw new Error('Select a connected terminal pane first.')
        }
        const command = entry.body.replace(/\r\n/g, '\n')
        // Tabs and line feeds are valid command text. Other terminal controls,
        // especially escape sequences, must never come from saved content.
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(command)) {
            throw new Error('This command contains unsupported terminal control characters.')
        }
        return command
    }

    private isEntry (value: unknown): value is WorkspaceEntry {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false
        }
        const entry = value as Record<string, unknown>
        return typeof entry.id === 'string' && Boolean(entry.id.trim())
            && (entry.kind === 'note' || entry.kind === 'snippet')
            && typeof entry.title === 'string' && typeof entry.body === 'string'
            && (entry.groupId === undefined || typeof entry.groupId === 'string')
            && (entry.createdAt === undefined || typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt))
            && (entry.updatedAt === undefined || typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt))
    }

    private isGroup (value: unknown): value is WorkspaceSnippetGroup {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false
        }
        const group = value as Record<string, unknown>
        return typeof group.id === 'string' && Boolean(group.id.trim())
            && typeof group.name === 'string' && Boolean(group.name.trim())
    }

    private readRecords<T> (value: unknown, validate: (record: unknown) => record is T): T[] {
        if (!Array.isArray(value)) {
            return []
        }
        const valid = value.filter(validate)
        // Keep valid collections stable, and never change malformed raw storage.
        return valid.length === value.length ? value : valid
    }

    private enqueue (operation: () => Promise<void>): Promise<void> {
        const result = this.mutationQueue.then(async () => {
            const error = this.validationError
            if (error) {
                throw new Error(error)
            }
            await operation()
        })
        // A failed write must finish rolling back before another one can start.
        this.mutationQueue = result.catch(() => undefined)
        return result
    }

    private async persist (entries: WorkspaceEntry[], groups: WorkspaceSnippetGroup[]): Promise<void> {
        const previousEntries = this.config.store.workspaceNotes
        const previousGroups = this.config.store.workspaceSnippetGroups
        this.config.store.workspaceNotes = entries
        this.config.store.workspaceSnippetGroups = groups
        try {
            await this.config.save()
        } catch (error) {
            this.config.store.workspaceNotes = previousEntries
            this.config.store.workspaceSnippetGroups = previousGroups
            throw error
        }
    }
}
