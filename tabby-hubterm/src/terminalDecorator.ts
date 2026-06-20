import { Injectable, Injector } from '@angular/core'
import { TerminalDecorator, BaseTerminalTabComponent } from 'tabby-terminal'
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
        subscriptions.push(tab.output$.subscribe((data: any) => {
            this.hubterm.sendTerminalData(tab, data, 'output')
        }))
        subscriptions.push(tab.input$.subscribe((data: any) => {
            this.hubterm.sendTerminalData(tab, data, 'input')
        }))
        this.subscriptions.set(tab, subscriptions)

        this.hubterm.start()
    }

    detach (tab: BaseTerminalTabComponent<any>): void {
        console.log('[HubTerm] decorator detaching from tab')
        this.subscriptions.get(tab)?.forEach(subscription => subscription.unsubscribe())
        this.subscriptions.delete(tab)
        this.hubterm.detachTab(tab)
    }
}
