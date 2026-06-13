import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

/** @hidden */
@Component({
    template: require('./settingsTab.component.pug'),
})
export class HubTermSettingsTabComponent {
    constructor (
        public config: ConfigService,
    ) { }
}
