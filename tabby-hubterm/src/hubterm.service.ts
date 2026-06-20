import { Injectable, Injector, NgZone } from '@angular/core'
import { ConfigService, HostAppService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

interface NodeReport {
    node_id: string
    source: 'tabby'
    name: string
    hostname: string
    os: string
    os_version: string
    arch: string
    sessions: SessionInfo[]
}

interface SessionInfo {
    session_id: string
    port_name: string
    user: string
    type: 'master' | 'watcher'
    client_ip: string
    connected_at: number
}

interface CenterCommand {
    type: string
    data?: { payload?: any, [key: string]: any }
}

/** @hidden */
@Injectable()
export class HubTermService {
    private ws: WebSocket | null = null
    private reportTimer: any = null
    private reconnectTimer: any = null
    private reconnectDelay = 1000
    private nodeId = ''
    private attachedTabs: Map<BaseTerminalTabComponent<any>, SessionInfo> = new Map()
    private stopping = false
    private startPromise: Promise<void> | null = null

    private get config () { return this.injector.get(ConfigService) }
    private get hostApp () { return this.injector.get(HostAppService) }

    constructor (
        private injector: Injector,
        private zone: NgZone,
    ) {
        this.loadNodeId()
        console.log('[HubTerm] service created, nodeId:', this.nodeId)
    }

    private loadNodeId (): void {
        try {
            const saved = localStorage.getItem('hubterm_node_id')
            if (saved) {
                this.nodeId = saved
                console.log('[HubTerm] loaded existing nodeId:', this.nodeId)
            } else {
                this.nodeId = this.generateId()
                localStorage.setItem('hubterm_node_id', this.nodeId)
                console.log('[HubTerm] generated new nodeId:', this.nodeId)
            }
        } catch {
            this.nodeId = this.generateId()
            console.log('[HubTerm] generated nodeId (localStorage unavailable):', this.nodeId)
        }
    }

    private generateId (): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0
            return (c === 'x' ? r : r & 0x3 | 0x8).toString(16)
        })
    }


    start (): void {
        const cfg = this.config.store.hubterm
        if (!cfg?.enabled || !cfg.centerUrl) {
            console.log('[HubTerm] not starting: disabled or no centerUrl')
            return
        }
        if (this.ws ?? this.startPromise) { return }

        this.stopping = false
        this.startPromise = this.registerAndConnect(cfg.centerUrl).finally(() => {
            this.startPromise = null
        })
    }

    private async registerAndConnect (url: string): Promise<void> {
        try {
            const cfg = this.config.store.hubterm
            if (!cfg.token) {
                console.log('[HubTerm] no token configured, registering node')
                cfg.token = await this.registerNode(url)
                await this.config.save()
                console.log('[HubTerm] node registered and token saved')
            }
            if (!this.stopping) {
                console.log('[HubTerm] starting, connecting to:', url)
                this.connect(url)
            }
        } catch (error) {
            console.error('[HubTerm] registration failed:', error)
            if (!this.stopping) {
                setTimeout(() => this.start(), this.reconnectDelay)
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
            }
        }
    }

    private async registerNode (configuredUrl: string): Promise<string> {
        let response = await this.postRegistration(configuredUrl)
        if (response.status === 401) {
            // The node ID can outlive a cleared Tabby config. Generate a fresh
            // identity once so first-run registration remains automatic.
            this.nodeId = this.generateId()
            localStorage.setItem('hubterm_node_id', this.nodeId)
            response = await this.postRegistration(configuredUrl)
        }
        if (!response.ok) {
            throw new Error(`Center registration returned ${response.status}: ${await response.text()}`)
        }
        const result = await response.json()
        if (!result.token) { throw new Error('Center registration did not return a token') }
        return result.token
    }

    private postRegistration (configuredUrl: string): Promise<Response> {
        const url = new URL(configuredUrl)
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
        url.pathname = '/api/nodes/report'
        url.search = ''
        url.hash = ''
        return fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(this.nodeReport()),
        })
    }

    stop (): void {
        console.log('[HubTerm] stopping')
        this.stopping = true
        if (this.reportTimer) {
            clearInterval(this.reportTimer)
            this.reportTimer = null
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        if (this.ws) {
            this.ws.onclose = null
            this.ws.close()
            this.ws = null
        }
        console.log('[HubTerm] stopped')
    }

    attachTab (tab: BaseTerminalTabComponent<any>): void {
        const existingId = (tab as any).sessionId
        const sessionId = existingId && existingId !== 'unknown' ? existingId : this.generateId()
        this.attachedTabs.set(tab, {
            session_id: sessionId,
            port_name: (tab as any).sessionName || (tab as any).profile?.name || 'terminal',
            user: '',
            type: 'master',
            client_ip: '',
            connected_at: Math.floor(Date.now() / 1000),
        })
        console.log('[HubTerm] tab attached, total tabs:', this.attachedTabs.size)
    }

    detachTab (tab: BaseTerminalTabComponent<any>): void {
        this.attachedTabs.delete(tab)
        this.sendReport()
        console.log('[HubTerm] tab detached, total tabs:', this.attachedTabs.size)
    }

    sendTerminalData (tab: BaseTerminalTabComponent<any>, value: unknown, direction: 'input' | 'output'): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return }
        const sessionId = this.attachedTabs.get(tab)?.session_id
        if (!sessionId) { return }
        this.ws.send(JSON.stringify({
            type: 'terminal_data',
            data: { session_id: sessionId, direction, data: this.bytesToBase64(value) },
        }))
    }

    writeToTab (tab: BaseTerminalTabComponent<any>, data: string): void {
        (tab as any).write?.(new TextDecoder().decode(this.base64ToBytes(data)))
    }

    private connect (url: string) {
        if (this.ws) {
            console.log('[HubTerm] already connected, skipping')
            return
        }

        console.log('[HubTerm] connecting to:', url)
        try {
            const cfg = this.config.store.hubterm
            const protocols = cfg.token ? ['hubterm', `hubterm.node.${cfg.token}`] : ['hubterm']
            this.ws = new WebSocket(this.agentUrl(url), protocols)

            this.ws.onopen = () => {
                console.log('[HubTerm] connected to center')
                this.reconnectDelay = 1000
                this.startReporting()
            }

            this.ws.onclose = (event) => {
                console.log('[HubTerm] disconnected, code:', event.code, 'reason:', event.reason)
                this.ws = null
                if (this.reportTimer) {
                    clearInterval(this.reportTimer)
                    this.reportTimer = null
                }
                if (!this.stopping) { this.scheduleReconnect(url) }
            }

            this.ws.onerror = (_event) => {
                console.log('[HubTerm] websocket error')
            }

            this.ws.onmessage = (event) => {
                this.zone.run(() => this.handleCommand(event.data))
            }
        } catch (e) {
            console.error('[HubTerm] connection failed:', e)
            if (!this.stopping) { this.scheduleReconnect(url) }
        }
    }

    private agentUrl (configuredUrl: string): string {
        const url = new URL(configuredUrl)
        if (['/', '/ws', '/api/ws'].includes(url.pathname)) { url.pathname = '/api/ws/agent' }
        url.searchParams.set('node_id', this.nodeId)
        return url.toString()
    }

    private bytesToBase64 (value: unknown): string {
        let bytes: Uint8Array = new Uint8Array(0)
        if (typeof value === 'string') {
            bytes = new TextEncoder().encode(value)
        } else if (value instanceof Uint8Array) {
            bytes = value
        } else if (value instanceof ArrayBuffer) {
            bytes = new Uint8Array(value)
        } else {
            bytes = new TextEncoder().encode(String(value))
        }

        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        return btoa(binary)
    }

    private base64ToBytes (value: string): Uint8Array {
        return Uint8Array.from(atob(value), char => char.charCodeAt(0))
    }


    private scheduleReconnect (url: string): void {
        if (this.reconnectTimer) { return }
        console.log('[HubTerm] scheduling reconnect in', this.reconnectDelay, 'ms')
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            this.connect(url)
        }, this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
    }

    private startReporting (): void {
        if (this.reportTimer) { clearInterval(this.reportTimer) }
        const interval = (this.config.store.hubterm.reportInterval || 3) * 1000
        console.log('[HubTerm] starting reporting every', interval, 'ms')
        this.reportTimer = setInterval(() => this.sendReport(), interval)
        this.sendReport()
    }

    private sendReport (): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { return }
        this.ws.send(JSON.stringify({
            type: 'report',
            data: this.nodeReport(),
        }))
    }

    private nodeReport (): NodeReport {
        return {
            node_id: this.nodeId,
            source: 'tabby',
            name: this.config.store.hubterm.nodeName || 'Tabby',
            hostname: window.location.hostname || this.config.store.hubterm.nodeName || 'tabby',
            os: this.hostApp.platform,
            os_version: navigator.userAgent || '',
            arch: '',
            sessions: this.collectSessions(),
        }
    }

    private collectSessions (): SessionInfo[] {
        return Array.from(this.attachedTabs.values())
    }

    private tabForSession (sessionId: string): BaseTerminalTabComponent<any> | null {
        for (const [tab, session] of this.attachedTabs) {
            if (session.session_id === sessionId) { return tab }
        }
        return null
    }

    private handleCommand (raw: string): void {
        try {
            const cmd: CenterCommand = JSON.parse(raw)
            const payload = cmd.data?.payload || cmd.data || {}
            console.log('[HubTerm] received command:', cmd.type, JSON.stringify(payload))

            switch (cmd.type) {
                case 'ping':
                    this.ws?.send(JSON.stringify({ type: 'pong', data: {} }))
                    break

                case 'write':
                    if (payload.session_id && payload.data) {
                        const tab = this.tabForSession(payload.session_id)
                        if (tab) { this.writeToTab(tab, payload.data) }
                    }
                    break

                case 'disconnect':
                case 'kick_session':
                    if (payload.session_id) {
                        const tab = this.tabForSession(payload.session_id)
                        if (tab) { (tab as any).close() }
                    }
                    break

                case 'assign_master':
                    console.log('[HubTerm] session promoted:', payload.session_id)
                    break

                case 'set_permission':
                    console.log('[HubTerm] permission update:', payload)
                    break

                case 'update_config':
                    console.log('[HubTerm] updating config:', payload)
                    Object.assign(this.config.store.hubterm, payload)
                    this.config.save()
                    break

                case 'restart':
                    console.log('[HubTerm] restarting agent')
                    this.stop()
                    setTimeout(() => this.start(), 1000)
                    break

                default:
                    console.log('[HubTerm] unknown command type:', cmd.type)
            }
        } catch (e) {
            console.error('[HubTerm] failed to handle command:', e)
        }
    }
}
