import { Injectable, Injector } from '@angular/core'
import { TerminalDecorator } from 'tabby-terminal'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { HubTermService } from './hubterm.service'

/** @hidden */
@Injectable()
export class HubTermDecorator extends TerminalDecorator {
    private hubterm: HubTermService

    constructor (
        private injector: Injector,
    ) {
        super()
        this.hubterm = this.injector.get(HubTermService)
        console.log('[HubTerm] decorator created')
    }

    attach (tab: BaseTerminalTabComponent): void {
        console.log('[HubTerm] decorator attaching to tab')
        this.hubterm.attachTab(tab)

        if (tab.output$) {
            tab.output$.subscribe((data: any) => {
                const str = typeof data === 'string' ? data : String(data)
                this.hubterm.sendTerminalData(tab, str)
            })
        }

        if (tab.input$) {
            tab.input$.subscribe((data: any) => {
                const str = typeof data === 'string' ? data : String(data)
                this.hubterm.sendTerminalData(tab, str)
            })
        }

        // Start HubTerm service when first tab attaches
        this.hubterm.start()
    }

    detach (tab: BaseTerminalTabComponent): void {
        console.log('[HubTerm] decorator detaching from tab')
        this.hubterm.detachTab(tab)
    }
}
