import net from "net";

interface Peer {
    id: string;
    host: string;
    port: number;
}

const SEED_HOST = "127.0.0.1";
const SEED_PORT = 8080;

class P2PNode {
    private node: Peer;
    private peerList: Map<string, Peer> = new Map();
    private suspiciousNodes: Set<string> = new Set();
    private server!: net.Server;
    private seedSocket!: net.Socket;
    private sockets: Map<string, net.Socket> = new Map();
    private seedConnected = false;

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

    private startServer() {
        this.server = net.createServer((socket) => {
            this.handleIncomingConnection(socket);
        });

        this.server.listen(this.node.port, this.node.host, () => {
            console.log(`Node ${this.node.id} listening on ${this.node.host}:${this.node.port}`);
        });
    }

    private handleIncomingConnection(socket: net.Socket) {
        socket.on("data", (data) => {
            // Basic PING/PONG or message handling
            const msg = data.toString().trim();
            if (msg.includes("PING")) {
                socket.write(JSON.stringify({ type: "PONG" }) + "\n");
		console.log("Ping recieved by the socket")
            }
        });
        socket.on("error", () => socket.destroy());
    }

    private async connectSeed(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.seedSocket = net.createConnection(SEED_PORT, SEED_HOST, () => {
                this.seedConnected = true;
                this.seedSocket.write(JSON.stringify({
                    type: "REGISTER",
                    node: this.node
                }) + "\n");
                resolve();
            });

            this.seedSocket.on("error", reject);
        });
    }

    private async fetchUpdatedPeerList(): Promise<Peer[]> {
        return new Promise((resolve, reject) => {
            const onData = (data: Buffer) => {
                try {
                    const peers: Peer[] = JSON.parse(data.toString());
                    console.log(peers);
		    this.seedSocket.removeListener("data", onData);

                    resolve(peers);
                } catch (err) {
                    reject(err);
                }
            };
            this.seedSocket.on("data", onData);
            this.seedSocket.write(JSON.stringify({ type: "GET_PEERS" }) + "\n");
        });
    }

    private async bootstrap() {
        const peers = await this.fetchUpdatedPeerList();
        for (const peer of peers) {
            if (peer.id !== this.node.id) {
                this.peerList.set(peer.id, peer);
                this.connectToPeer(peer).catch(() => {
                    this.suspiciousNodes.add(peer.id);
                });
            }
        }
    }

    private async connectToPeer(peer: Peer): Promise<void> {
        if (this.sockets.has(peer.id)) return;

        return new Promise((resolve, reject) => {
            const socket = net.createConnection(peer.port, peer.host, () => {
                this.sockets.set(peer.id, socket);
                resolve();
            });
            socket.on("error", (err) => {
                this.sockets.delete(peer.id);
                socket.destroy();
                reject(err);
            });
        });
    }

    private  async startBackgroundTasks() {
        setInterval(() => this.pingPeers(), 30000);
        setInterval(() => this.checkNeighbours(), 90000);
    }

    private pingPeers() {
        for (const [id, socket] of this.sockets) {
            socket.write(JSON.stringify({ type: "PING", from: this.node.id }) + "\n");
        }
    }

    private async checkNeighbours() {
        if (this.suspiciousNodes.size === 0) return;

        for (const errNodeId of this.suspiciousNodes) {
            let aliveCount = 0;
            const total = this.peerList.size;

            // Simple consensus: ask the seed or try direct reconnects
            // Here we check if we can reach others to see if WE are the ones disconnected
            if (aliveCount > total / 2) {
                console.log(`Majority agrees ${errNodeId} is alive`);
            } else {
                console.log(`Node ${errNodeId} confirmed dead. Reporting to Seed.`);
                if (this.seedConnected) {
                    this.seedSocket.write(JSON.stringify({ type: "DEAD_NODE", node: errNodeId }) + "\n");
                }
                this.suspiciousNodes.delete(errNodeId);
                this.peerList.delete(errNodeId);
            }
        }
    }
}

const id = process.argv[2];
const host = process.argv[3];
const port = Number(process.argv[4]);

if (!id || !host || isNaN(port)) {
    console.error("Usage: node node.js <id> <host> <port>");
    process.exit(1);
}

const nodeInstance = new P2PNode(id, host, port);
nodeInstance.start();
