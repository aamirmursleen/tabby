import { Component, HostBinding } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { X11Socket } from '../session/x11'
import { ConfigService, HostAppService, NotificationsService, Platform, PlatformService, PromptModalComponent } from 'tabby-core'
import { SSHGeneratedKeyType, SSHKeyStorageService, SSHStoredKey } from '../services/sshKeys.service'

/** @hidden */
@Component({
    templateUrl: './sshSettingsTab.component.pug',
})
export class SSHSettingsTabComponent {
    Platform = Platform
    defaultX11Display: string
    keys: SSHStoredKey[] = []
    keySearch = ''
    newKeyName = ''
    newPrivateKey = ''
    generatedKeyType: SSHGeneratedKeyType = 'ed25519'
    keyBusy = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        private sshKeys: SSHKeyStorageService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private ngbModal: NgbModal,
    ) {
        const spec = X11Socket.resolveDisplaySpec()
        if ('path' in spec) {
            this.defaultX11Display = spec.path
        } else {
            this.defaultX11Display = `${spec.host}:${spec.port}`
        }
    }

    ngOnInit (): void {
        this.reloadKeys()
    }

    get filteredKeys (): SSHStoredKey[] {
        const query = this.keySearch.trim().toLocaleLowerCase()
        if (!query) {
            return this.keys
        }
        return this.keys.filter(key => [
            key.label,
            key.type,
            key.fingerprint,
            key.publicKey,
        ].some(value => value.toLocaleLowerCase().includes(query)))
    }

    async savePastedKey (): Promise<void> {
        await this.runKeyAction(async () => {
            await this.sshKeys.savePrivateKey(this.newKeyName, this.newPrivateKey)
            this.newKeyName = ''
            this.newPrivateKey = ''
        }, 'SSH key saved')
    }

    async generateKey (): Promise<void> {
        await this.runKeyAction(async () => {
            await this.sshKeys.generateKey(this.newKeyName, this.generatedKeyType)
            this.newKeyName = ''
        }, 'SSH key generated')
    }

    async importKey (): Promise<void> {
        await this.runKeyAction(async () => {
            await this.sshKeys.importPrivateKeyFromUpload(this.newKeyName || undefined)
            this.newKeyName = ''
        }, 'SSH key imported')
    }

    async renameKey (key: SSHStoredKey): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = 'Key name'
        modal.componentInstance.value = key.label
        const result = await modal.result.catch(() => null)
        if (!result?.value) {
            return
        }
        await this.runKeyAction(() => this.sshKeys.renameKey(key.id, result.value), 'SSH key renamed')
    }

    async deleteKey (key: SSHStoredKey): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: `Delete SSH key "${key.label}"?`,
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })
        if (result.response !== 0) {
            return
        }
        await this.runKeyAction(() => this.sshKeys.deleteKey(key.id), 'SSH key deleted')
    }

    copyPublicKey (key: SSHStoredKey): void {
        try {
            this.sshKeys.copyPublicKey(key.id)
            this.notifications.notice('Public key copied')
        } catch (error) {
            this.notifications.error('Could not copy public key', String(error))
        }
    }

    trackKey (_index: number, key: SSHStoredKey): string {
        return key.id
    }

    private reloadKeys (): void {
        this.keys = this.sshKeys.keys
    }

    private async runKeyAction (action: () => Promise<unknown>, success: string): Promise<void> {
        if (this.keyBusy) {
            return
        }
        this.keyBusy = true
        try {
            await action()
            this.reloadKeys()
            this.notifications.notice(success)
        } catch (error) {
            this.notifications.error('SSH key operation failed', String(error))
        } finally {
            this.keyBusy = false
        }
    }
}
