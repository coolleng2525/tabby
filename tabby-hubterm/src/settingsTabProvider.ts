import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { HubTermSettingsTabComponent } from './settingsTab.component'

/** @hidden */
@Injectable()
export class HubTermSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        this.weight = 200
    }

    getTitle (): string { return 'HubTerm' }
    getComponent (): typeof HubTermSettingsTabComponent { return HubTermSettingsTabComponent }
}
