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
        await this.connectSeed();
        await this.bootstrap();
        this.startBackgroundTasks();
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
        console.log("Incoming connection");

        socket.on("data", (data) => {
            console.log("Received:", data.toString());
        });

        socket.on("error", () => {
            socket.destroy();
        });
    }

    private async connectSeed(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.seedSocket = net.createConnection(
                SEED_PORT,
                SEED_HOST,
                () => {
                    this.seedConnected = true;
                    console.log("Connected to seed");
                    resolve();
                }
            );

            this.seedSocket.on("error", (err) => {
                this.seedConnected = false;
                reject(err);
            });
        });
    }

    private async fetchUpdatedPeerList(): Promise<Peer[]> {
        return new Promise((resolve, reject) => {
            this.seedSocket.write(JSON.stringify({ type: "GET_PEERS" }) + "\n");

            this.seedSocket.once("data", (data) => {
                try {
                    const peers: Peer[] = JSON.parse(data.toString());
                    resolve(peers);
                } catch (err) {
                    reject(err);
                }
            });

            this.seedSocket.once("error", reject);
        });
    }

    private async bootstrap() {
        const peers = await this.fetchUpdatedPeerList();

        for (const peer of peers) {
            if (peer.id !== this.node.id) {
                this.peerList.set(peer.id, peer);
            }
        }

        for (const [, peer] of this.peerList) {
            try {
                await this.connectToPeer(peer);
            } catch {
                this.suspiciousNodes.add(peer.id);
            }
        }
    }

    private async connectToPeer(peer: Peer): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(peer.port, peer.host, () => {
                this.sockets.set(peer.id, socket);
                resolve();
            });

            socket.on("error", (err) => {
                socket.destroy();
                reject(err);
            });
        });
    }

    private startBackgroundTasks() {
        setInterval(() => this.pingPeers(), 30000);
        setInterval(() => this.checkNeighbours(), 90000);
    }

    private pingPeers() {
        for (const [, socket] of this.sockets) {
            socket.write(JSON.stringify({ type: "PING" }) + "\n");
        }
    }

    private async checkNeighbours() {
        for (const errNodeId of this.suspiciousNodes) {
            let count = 0;
            const total = this.peerList.size;

            for (const [, peer] of this.peerList) {
                if (peer.id === errNodeId) continue;

                try {
                    await this.connectToPeer(peer);
                    count++;
                    this.sockets.get(peer.id)?.end();
                } catch {
                    console.log(`Failed to connect to neighbour ${peer.id}`);
                }
            }

            if (count > total / 2) {
                console.log(`Majority agrees ${errNodeId} is alive`);
            } else {
                console.log(`Majority agrees ${errNodeId} is dead`);
                if (this.seedConnected) {
                    this.seedSocket.write(
                        JSON.stringify({ type: "DEAD_NODE", node: errNodeId }) + "\n"
                    );
                }
            }
        }
    }
}

/* ---------- CLI ENTRY POINT ---------- */

const id = process.argv[2];
const host = process.argv[3];
const port = Number(process.argv[4]);

if (!id || !host || isNaN(port)) {
    console.error("Usage: node singular_node.js <id> <host> <port>");
    process.exit(1);
}

const nodeInstance = new P2PNode(id, host, port);
nodeInstance.start();
