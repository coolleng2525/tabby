import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { TerminalDecorator } from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'

import { HubTermConfigProvider } from './configProvider'
import { HubTermDecorator } from './terminalDecorator'
import { HubTermService } from './hubterm.service'
import { HubTermSettingsTabProvider } from './settingsTabProvider'
import { HubTermSettingsTabComponent } from './settingsTab.component'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        HubTermService,
        { provide: ConfigProvider, useClass: HubTermConfigProvider, multi: true },
        { provide: TerminalDecorator, useClass: HubTermDecorator, multi: true },
        { provide: SettingsTabProvider, useClass: HubTermSettingsTabProvider, multi: true },
    ],
    declarations: [
        HubTermSettingsTabComponent,
    ],
})
export default class HubTermModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class
