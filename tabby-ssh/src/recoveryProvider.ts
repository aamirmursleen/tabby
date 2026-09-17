import { Injectable, Injector } from '@angular/core'
import { ConfigService, TabRecoveryProvider, NewTabParameters, RecoveryToken, ProfilesService } from 'tabby-core'

import { SSHTabComponent } from './components/sshTab.component'

/** @hidden */
@Injectable()
export class RecoveryProvider extends TabRecoveryProvider<SSHTabComponent> {
    constructor (private injector: Injector, private config: ConfigService) { super() }

    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:ssh-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<SSHTabComponent>> {
        const savedProfile = recoveryToken.profile
        const currentProfile = this.config.store.profiles?.find(profile => profile.id === savedProfile.id && profile.type === savedProfile.type)
        return {
            type: SSHTabComponent,
            inputs: {
                profile: this.injector.get(ProfilesService).getConfigProxyForProfile(currentProfile ?? savedProfile),
                savedState: recoveryToken.savedState,
            },
        }
    }
}
