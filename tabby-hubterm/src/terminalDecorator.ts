import { Injectable, Injector } from '@angular/core'
import { TerminalDecorator } from 'tabby-terminal'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { Subscription } from 'rxjs'
import { HubTermService } from './hubterm.service'

/** @hidden */
@Injectable()
export class HubTermDecorator extends TerminalDecorator {
    private hubterm: HubTermService
    private subscriptions = new Map<BaseTerminalTabComponent<any>, Subscription[]>()

    constructor (
        private injector: Injector,
    ) {
        super()
        this.hubterm = this.injector.get(HubTermService)
        console.log('[HubTerm] decorator created')
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        console.log('[HubTerm] decorator attaching to tab')
        this.hubterm.attachTab(tab)

        const subscriptions: Subscription[] = []
        if (tab.output$) {
            subscriptions.push(tab.output$.subscribe((data: any) => {
                this.hubterm.sendTerminalData(tab, data, 'output')
            }))
        }
        if (tab.input$) {
            subscriptions.push(tab.input$.subscribe((data: any) => {
                this.hubterm.sendTerminalData(tab, data, 'input')
            }))
        }
        this.subscriptions.set(tab, subscriptions)

        // Start HubTerm service when first tab attaches
        this.hubterm.start()
    }

    detach (tab: BaseTerminalTabComponent<any>): void {
        console.log('[HubTerm] decorator detaching from tab')
        this.subscriptions.get(tab)?.forEach(subscription => subscription.unsubscribe())
        this.subscriptions.delete(tab)
        this.hubterm.detachTab(tab)
    }
}
