import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'

export interface HubTermConfig {
    enabled: boolean
    centerUrl: string
    nodeName: string
    domain: string
    token: string
    reportInterval: number
}

/** @hidden */
@Injectable()
export class HubTermConfigProvider extends ConfigProvider {
    defaults: any = {
        hubterm: {
            enabled: false,
            centerUrl: 'ws://localhost:8080/api/ws/agent',
            nodeName: '',
            domain: '',
            token: '',
            reportInterval: 3,
        },
    }

    platformDefaults: any = {}
}
