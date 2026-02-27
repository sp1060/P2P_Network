import net from "net";

interface BasicPeer {
    id: string;
    host: string;
    port: number;
}

interface PeerData extends BasicPeer {
    neighbors: BasicPeer[]; // The host/port info of the peers-of-peers
}

const SEED_HOST = "127.0.0.1";
const SEED_PORT = 8080;

// How many CHECK_RES votes to collect before making a death decision
const CONSENSUS_TIMEOUT_MS = 5000;

class P2PNode {
    public node: BasicPeer;
    public peerList: Map<string, PeerData> = new Map();
    private suspiciousNodes: Set<string> = new Set();
    private server!: net.Server;
    private seedSocket!: net.Socket;
    // FIX: Separate maps for inbound vs outbound sockets
    private sockets: Map<string, net.Socket> = new Map();
    private seedConnected = false;

    // FIX: Proper seed socket message demux — queue of pending one-shot listeners
    private seedResponseQueue: Array<(msg: unknown) => void> = [];
    private seedBuffer = "";

    constructor(id: string, host: string, port: number) {
        this.node = { id, host, port };
    }

    async start() {
        this.startServer();
        try {
            await this.connectSeed();
            await this.bootstrap();
            this.startBackgroundTasks();
        } catch (err) {
            console.error("Failed to start node:", err);
        }
    }

    // ─── Server (inbound connections from other peers) ───────────────────────

    private startServer() {
        this.server = net.createServer((socket) => {
            let buffer = "";
            socket.on("data", (data) => {
                buffer += data.toString();
                let boundary;
                while ((boundary = buffer.indexOf("\n")) >= 0) {
                    const raw = buffer.slice(0, boundary).trim();
                    buffer = buffer.slice(boundary + 1);
                    if (!raw) continue;
                    try {
                        const msg = JSON.parse(raw);
                        this.handlePeerMessage(msg, socket);
                    } catch {
                        console.error("Error parsing incoming message");
                    }
                }
            });
            socket.on("error", () => socket.destroy());
        });

        this.server.listen(this.node.port, this.node.host, () => {
            console.log(`Node ${this.node.id} listening on ${this.node.host}:${this.node.port}`);
        });
    }

    // FIX: Unified peer message handler used by BOTH inbound and outbound sockets
    private handlePeerMessage(msg: Record<string, unknown>, socket: net.Socket) {
        if (msg.type === "PING") {
            console.log(`[PING] Received heartbeat from ${msg.from}. Sending PONG...`);
            socket.write(JSON.stringify({ type: "PONG", from: this.node.id }) + "\n");
        }
        else if (msg.type === "PONG") {
            console.log(`[PONG] Received reply from ${msg.from}. Node is healthy.`);
            this.suspiciousNodes.delete(msg.from as string);
        }
        else if (msg.type === "CHECK") {
            const targetId = msg.node as string;   // FIX: lowercase "node" key (was "Node")
            console.log(`[CHECK] Neighbor asking about: ${targetId}`);
            const targetSocket = this.sockets.get(targetId);
            const status = (targetSocket && !targetSocket.destroyed) ? "1" : "0";
            socket.write(JSON.stringify({
                type: "CHECK_RES",
                status,
                node: targetId,
                from: this.node.id
            }) + "\n");
        }
        else if (msg.type === "CHECK_RES") {
            // FIX: votes are handled in checkNeighbours via the voteMap closure; log here only
            console.log(`[CONSENSUS] ${msg.from} says ${msg.node} is ${msg.status === "1" ? "ALIVE" : "DEAD"}`);
        }
    }

    // ─── Seed connection ──────────────────────────────────────────────────────

    private async connectSeed(): Promise<void> {
        return new Promise((resolve, reject) => {
            // FIX: Add a connection timeout
            const timer = setTimeout(() => reject(new Error("Seed connection timed out")), 10000);

            this.seedSocket = net.createConnection(SEED_PORT, SEED_HOST, () => {
                clearTimeout(timer);
                this.seedConnected = true;

                // FIX: Framed read loop on seed socket — feeds seedResponseQueue
                this.seedSocket.on("data", (data) => {
                    this.seedBuffer += data.toString();
                    let boundary;
                    while ((boundary = this.seedBuffer.indexOf("\n")) >= 0) {
                        const raw = this.seedBuffer.slice(0, boundary).trim();
                        this.seedBuffer = this.seedBuffer.slice(boundary + 1);
                        if (!raw) continue;
                        try {
                            const msg = JSON.parse(raw);
                            const handler = this.seedResponseQueue.shift();
                            if (handler) handler(msg);
                        } catch {
                            console.error("Error parsing seed message");
                        }
                    }
                });

                this.seedSocket.on("error", (err) => {
                    console.error("[SEED] Socket error:", err.message);
                    this.seedConnected = false;
                });

                this.seedSocket.on("close", () => {
                    console.warn("[SEED] Connection closed.");
                    this.seedConnected = false;
                });

                // FIX: Send REGISTER and wait for ACK before resolving
                const ackPromise = this.awaitSeedResponse<{ type: string }>();
                this.seedSocket.write(JSON.stringify({ type: "REGISTER", node: this.node }) + "\n");
                ackPromise.then((msg) => {
                    if (msg.type === "REGISTER_ACK") {
                        resolve();
                    } else {
                        reject(new Error(`Unexpected REGISTER response: ${msg.type}`));
                    }
                }).catch(reject);
            });

            this.seedSocket.on("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    // FIX: Generic promise wrapper that resolves with the next seed message
    private awaitSeedResponse<T>(): Promise<T> {
        return new Promise((resolve) => {
            this.seedResponseQueue.push((msg) => resolve(msg as T));
        });
    }

    private async fetchUpdatedPeerList(): Promise<PeerData[]> {
        // FIX: Uses the framed response queue instead of a raw one-shot onData listener
        const responsePromise = this.awaitSeedResponse<{ type: string; peers: PeerData[] }>();
        this.seedSocket.write(JSON.stringify({ type: "GET_PEERS", nodeId: this.node.id }) + "\n");
        const msg = await responsePromise;
        return msg.peers;
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────

    private async bootstrap() {
        const peers = await this.fetchUpdatedPeerList();
        for (const peer of peers) {
            this.peerList.set(peer.id, peer);
            this.connectToPeer(peer).catch(() => this.suspiciousNodes.add(peer.id));
        }
    }

    // ─── Peer connections (outbound) ──────────────────────────────────────────

    private async connectToPeer(peer: BasicPeer): Promise<void> {
        if (this.sockets.has(peer.id)) return;
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(peer.port, peer.host, () => {
                this.sockets.set(peer.id, socket);

                // FIX: Attach a data handler on outbound sockets so PONG/CHECK_RES are received
                let buffer = "";
                socket.on("data", (data) => {
                    buffer += data.toString();
                    let boundary;
                    while ((boundary = buffer.indexOf("\n")) >= 0) {
                        const raw = buffer.slice(0, boundary).trim();
                        buffer = buffer.slice(boundary + 1);
                        if (!raw) continue;
                        try {
                            const msg = JSON.parse(raw);
                            this.handlePeerMessage(msg, socket);
                        } catch {
                            console.error("Error parsing peer message");
                        }
                    }
                });

                // FIX: Surface TCP errors as suspicious-node marks instead of silent drops
                socket.on("error", (err) => {
                    console.log(`[ERROR] Socket error for ${peer.id}: ${err.message}. Marking suspicious.`);
                    this.suspiciousNodes.add(peer.id);
                    this.sockets.delete(peer.id);
                    socket.destroy();
                });

                resolve();
            });

            socket.on("error", (err) => {
                this.sockets.delete(peer.id);
                socket.destroy();
                reject(err);
            });
        });
    }

    // ─── Background tasks ─────────────────────────────────────────────────────

    private startBackgroundTasks() {
        // FIX: Stagger the first ping slightly to let bootstrap finish
        setTimeout(() => {
            setInterval(() => this.pingPeers(), 15000);
            setInterval(() => this.checkNeighbours(), 30000);
        }, 2000);
    }

    private pingPeers() {
        for (const [id, socket] of this.sockets) {
            if (socket.destroyed) {
                this.suspiciousNodes.add(id);
                continue;
            }
            // FIX: TCP writes rarely throw; errors surface via the 'error' event (wired above).
            // We just check destroyed state and write.
            console.log(`[PING] Sending heartbeat to ${id}...`);
            socket.write(JSON.stringify({ type: "PING", from: this.node.id }) + "\n");
        }
    }

    private async checkNeighbours() {
        if (this.suspiciousNodes.size === 0) return;

        // Fetch fresh LOCAL topology from seed
        const currentLocalNetwork = await this.fetchUpdatedPeerList();
        this.peerList.clear();
        currentLocalNetwork.forEach(p => this.peerList.set(p.id, p));

        for (const errNodeId of [...this.suspiciousNodes]) {
            const suspiciousNodeData = this.peerList.get(errNodeId);
            if (!suspiciousNodeData) continue;

            console.log(`[CONSENSUS] Node ${errNodeId} unresponsive. Asking its specific peers...`);

            const targetsToAsk = suspiciousNodeData.neighbors;

            if (targetsToAsk.length === 0) {
                console.log(`[DEATH] No peers-of-peers available. Reporting dead.`);
                this.reportDeath(errNodeId);
                continue;
            }

            // FIX: Collect votes and tally them before deciding
            const votes: Map<string, "1" | "0"> = new Map();

            const votePromises = targetsToAsk.map(pop =>
                this.connectToPeer(pop).then(() => {
                    return new Promise<void>((resolve) => {
                        const socket = this.sockets.get(pop.id);
                        if (!socket) { resolve(); return; }

                        // Temporarily intercept CHECK_RES for this target
                        const originalHandler = socket.listeners("data");
                        const voteListener = (data: Buffer) => {
                            try {
                                for (const line of data.toString().split("\n")) {
                                    if (!line.trim()) continue;
                                    const msg = JSON.parse(line.trim());
                                    if (msg.type === "CHECK_RES" && msg.node === errNodeId) {
                                        votes.set(pop.id, msg.status);
                                        socket.removeListener("data", voteListener);
                                        resolve();
                                    }
                                }
                            } catch { /* ignore parse errors in vote listener */ }
                        };
                        socket.on("data", voteListener);

                        // FIX: lowercase "node" key to match server handler
                        socket.write(JSON.stringify({ type: "CHECK", node: errNodeId }) + "\n");

                        // Resolve after timeout even if no vote received
                        setTimeout(() => {
                            socket.removeListener("data", voteListener);
                            resolve();
                        }, CONSENSUS_TIMEOUT_MS);
                    });
                }).catch(() => {
                    console.log(`[WARNING] Could not reach peer-of-peer ${pop.id}.`);
                })
            );

            await Promise.all(votePromises);

            // FIX: Tally votes — majority rules; if no votes received, fall back to reportDeath
            if (!this.suspiciousNodes.has(errNodeId)) continue; // already resolved

            const aliveVotes = [...votes.values()].filter(v => v === "1").length;
            const deadVotes  = [...votes.values()].filter(v => v === "0").length;

            console.log(`[CONSENSUS] ${errNodeId}: alive=${aliveVotes}, dead=${deadVotes}, no-reply=${targetsToAsk.length - votes.size}`);

            if (aliveVotes > deadVotes) {
                console.log(`[CONSENSUS] ${errNodeId} considered ALIVE by majority. Clearing suspicion.`);
                this.suspiciousNodes.delete(errNodeId);
            } else {
                console.log(`[FAILURE] ${errNodeId} confirmed dead by consensus.`);
                this.reportDeath(errNodeId);
            }
        }
    }

    // ─── Death reporting ──────────────────────────────────────────────────────

    private reportDeath(nodeId: string) {
        // FIX: Guard against double-reporting
        if (!this.suspiciousNodes.has(nodeId) && !this.peerList.has(nodeId)) return;

        if (this.seedConnected) {
            this.seedSocket.write(JSON.stringify({ type: "DEAD_NODE", node: nodeId }) + "\n");
        }
        this.suspiciousNodes.delete(nodeId);
        this.peerList.delete(nodeId);
        this.sockets.get(nodeId)?.destroy();
        this.sockets.delete(nodeId);
    }
}

const id   = process.argv[2];
const host = process.argv[3];
const port = Number(process.argv[4]);

if (id && host && !isNaN(port)) {
    new P2PNode(id, host, port).start();
} else {
    console.log("Usage: node node.ts <id> <host> <port>");
}
