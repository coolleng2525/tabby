import { Injectable, Injector, NgZone } from '@angular/core'
import { ConfigService, HostAppService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import * as childProcess from 'child_process'
import * as os from 'os'

interface NodeReport {
    node_id: string
    source: 'tabby'
    name: string
    hostname: string
    os: string
    os_version: string
    arch: string
    cpu_percent: number
    memory_total: number
    memory_used: number
    memory_percent: number
    disk_total: number
    disk_used: number
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
    private lastCpuSample: { idle: number, total: number } | null = null

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
        if (crypto.randomUUID) {
            return crypto.randomUUID()
        }
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
        const tabState = tab as any
        if (!tabState.hubtermSessionId) {
            tabState.hubtermSessionId = this.generateId()
        }
        const sessionId = tabState.hubtermSessionId
        this.attachedTabs.set(tab, {
            session_id: sessionId,
            port_name: tabState.sessionName || tabState.profile?.name || 'terminal',
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
        const decoded = new TextDecoder().decode(this.base64ToBytes(data))
        const terminal = tab as any
        if (terminal.sendInput) {
            terminal.sendInput(decoded)
        } else {
            terminal.write?.(decoded)
        }
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
        const metrics = this.collectSystemMetrics()
        return {
            node_id: this.nodeId,
            source: 'tabby',
            name: this.config.store.hubterm.nodeName || 'Tabby',
            hostname: this.hostname(),
            os: this.hostApp.platform,
            os_version: navigator.userAgent || '',
            arch: os.arch?.() || '',
            ...metrics,
            sessions: this.collectSessions(),
        }
    }

    private collectSessions (): SessionInfo[] {
        return Array.from(this.attachedTabs.values())
    }

    private hostname (): string {
        return os.hostname?.() || window.location.hostname || this.config.store.hubterm.nodeName || 'tabby'
    }

    private collectSystemMetrics (): Pick<NodeReport, 'cpu_percent' | 'memory_total' | 'memory_used' | 'memory_percent' | 'disk_total' | 'disk_used'> {
        const memory = this.collectMemoryMetrics()
        const disk = this.collectDiskMetrics()

        return {
            cpu_percent: this.collectCpuPercent(),
            memory_total: memory.total,
            memory_used: memory.used,
            memory_percent: memory.percent,
            disk_total: disk.total,
            disk_used: disk.used,
        }
    }

    private collectMemoryMetrics (): { total: number, used: number, percent: number } {
        const systemMemory = (process as any).getSystemMemoryInfo?.()
        let memoryTotal = os.totalmem?.() || 0
        let memoryFree = os.freemem?.() || 0

        if ((!memoryTotal || !memoryFree) && systemMemory) {
            memoryTotal = Number(systemMemory.total || 0) * 1024
            memoryFree = Number(systemMemory.free || 0) * 1024
        }

        const memoryUsed = Math.max(memoryTotal - memoryFree, 0)

        return {
            total: memoryTotal,
            used: memoryUsed,
            percent: memoryTotal > 0 ? memoryUsed / memoryTotal * 100 : 0,
        }
    }

    private collectCpuPercent (): number {
        const cpus = os.cpus?.() || []
        if (!cpus.length) {
            return (process as any).getCPUUsage?.().percentCPUUsage || 0
        }

        const sample = cpus.reduce((acc, cpu) => {
            const times = cpu.times
            const total = times.user + times.nice + times.sys + times.irq + times.idle
            return {
                idle: acc.idle + times.idle,
                total: acc.total + total,
            }
        }, { idle: 0, total: 0 })

        if (!this.lastCpuSample) {
            this.lastCpuSample = sample
            return 0
        }

        const idleDelta = sample.idle - this.lastCpuSample.idle
        const totalDelta = sample.total - this.lastCpuSample.total
        this.lastCpuSample = sample

        if (totalDelta <= 0) { return 0 }
        return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    }

    private collectDiskMetrics (): { total: number, used: number } {
        try {
            if (![os.platform?.(), process.platform, this.hostApp.platform].some(platform => ['darwin', 'linux', 'macOS', 'Linux'].includes(platform))) {
                return { total: 0, used: 0 }
            }
            const output = childProcess.execFileSync('/bin/df', ['-Pk', '/'], { encoding: 'utf8', timeout: 2000 })
            const line = output.trim().split('\n')[1]
            if (!line) { return { total: 0, used: 0 } }

            const columns = line.trim().split(/\s+/)
            const totalKb = Number(columns[1])
            const usedKb = Number(columns[2])
            if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb)) {
                return { total: 0, used: 0 }
            }

            return {
                total: totalKb * 1024,
                used: usedKb * 1024,
            }
        } catch (error) {
            console.log('[HubTerm] failed to collect disk metrics:', error)
            return { total: 0, used: 0 }
        }
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
