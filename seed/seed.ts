import net from "net";
import fs from "fs";

// Internal representation to build the graph
interface InternalPeer {
    id: string;
    host: string;
    port: number;
    degree: number;
    neighbors: string[];
}

// Data sent to nodes: basic info
interface BasicPeer {
    id: string;
    host: string;
    port: number;
}

// Data sent to nodes: peer + that peer's specific neighbors
interface PeerData extends BasicPeer {
    neighbors: BasicPeer[];
}

const SEED_PORT = 8080;
const LOG_FILE = "seed_output.txt";

let peerList: InternalPeer[] = [];

function log(message: string) {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${message}`;
    console.log(formatted);
    fs.appendFileSync(LOG_FILE, formatted + "\n");
}

// Probabilistic preferential attachment: sample k nodes weighted by degree
function weightedSample(candidates: InternalPeer[], k: number): InternalPeer[] {
    const selected: InternalPeer[] = [];
    const pool = [...candidates];

    for (let i = 0; i < k && pool.length > 0; i++) {
        // Nodes with degree 0 still get a baseline weight of 1 so they're never locked out
        const totalWeight = pool.reduce((sum, p) => sum + (p.degree || 1), 0);
        let rand = Math.random() * totalWeight;

        const idx = pool.findIndex(p => {
            rand -= (p.degree || 1);
            return rand <= 0;
        });

        const chosen = pool.splice(idx === -1 ? pool.length - 1 : idx, 1)[0];
        selected.push(chosen);
    }

    return selected;
}

// Helper: Generates a 2-degree local topology for a specific node
function getLocalTopology(targetId: string): PeerData[] {
    const targetNode = peerList.find(p => p.id === targetId);
    if (!targetNode) return [];

    return targetNode.neighbors.map(neighborId => {
        const neighbor = peerList.find(p => p.id === neighborId);
        if (!neighbor) return null;

        // Resolve the peers-of-peers into BasicPeer objects
        const peersOfPeer = neighbor.neighbors
            .filter(popId => popId !== targetId) // Exclude the asking node itself
            .map(popId => {
                const pop = peerList.find(p => p.id === popId);
                return pop ? { id: pop.id, host: pop.host, port: pop.port } : null;
            })
            .filter(Boolean) as BasicPeer[];

        return {
            id: neighbor.id,
            host: neighbor.host,
            port: neighbor.port,
            neighbors: peersOfPeer
        };
    }).filter(Boolean) as PeerData[];
}

const server = net.createServer((socket) => {
    let buffer = "";
    const remoteIP = socket.remoteAddress || "127.0.0.1";

    socket.on("data", (data: Buffer) => {
        buffer += data.toString();
        let boundary;

        while ((boundary = buffer.indexOf("\n")) >= 0) {
            const rawMessage = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);
            if (!rawMessage) continue;

            try {
                const parsed = JSON.parse(rawMessage);

                if (parsed.type === "REGISTER") {
                    const incomingId = parsed.node.id;

                    // FIX: Remove stale entry if a node re-registers with the same ID
                    const existing = peerList.findIndex(p => p.id === incomingId);
                    if (existing !== -1) {
                        log(`Re-registration from ${incomingId}. Removing stale entry.`);
                        const staleNeighbors = peerList[existing].neighbors;
                        peerList.splice(existing, 1);
                        // Decrement degree and remove links from former neighbors
                        peerList.forEach(p => {
                            if (staleNeighbors.includes(p.id)) {
                                p.degree = Math.max(0, p.degree - 1);
                            }
                            p.neighbors = p.neighbors.filter(nId => nId !== incomingId);
                        });
                    }

                    const newPeer: InternalPeer = {
                        id: incomingId,
                        host: parsed.node.host || remoteIP,
                        port: parsed.node.port,
                        degree: 0,
                        neighbors: []
                    };

                    log(`JOIN request from ${newPeer.id}`);

                    // Preferential attachment: probabilistic weighted sample by degree
                    const hubs = weightedSample(peerList, 2);

                    peerList.push(newPeer);

                    // Create bi-directional graph links
                    hubs.forEach(hub => {
                        const match = peerList.find(p => p.id === hub.id);
                        if (match) {
                            match.degree++;
                            match.neighbors.push(newPeer.id);
                            newPeer.degree++;           // FIX: increment new peer's degree too
                            newPeer.neighbors.push(hub.id);
                        }
                    });

                    log(`Admitted ${newPeer.id}. Global Size: ${peerList.length}`);

                    // FIX: Do NOT send topology on REGISTER — node will call GET_PEERS separately.
                    // Just send an ACK so the node knows registration succeeded.
                    socket.write(JSON.stringify({ type: "REGISTER_ACK" }) + "\n");
                }
                else if (parsed.type === "GET_PEERS") {
                    const targetId = parsed.nodeId;
                    const response = getLocalTopology(targetId);
                    socket.write(JSON.stringify({ type: "PEER_LIST", peers: response }) + "\n");
                }
                else if (parsed.type === "DEAD_NODE") {
                    const deadId = parsed.node;
                    const deadPeer = peerList.find(p => p.id === deadId);

                    if (deadPeer) {
                        // FIX: Decrement degree on all neighbors before removal
                        deadPeer.neighbors.forEach(nId => {
                            const neighbor = peerList.find(p => p.id === nId);
                            if (neighbor) {
                                neighbor.degree = Math.max(0, neighbor.degree - 1);
                                neighbor.neighbors = neighbor.neighbors.filter(id => id !== deadId);
                            }
                        });
                        peerList = peerList.filter(p => p.id !== deadId);
                        log(`Removed ${deadId} and updated global topology.`);
                    } else {
                        log(`DEAD_NODE for unknown id ${deadId} — ignoring.`);
                    }
                }
            } catch (err) {
                log("Invalid JSON message received.");
            }
        }
    });
    socket.on("error", () => socket.destroy());
});

server.listen(SEED_PORT, "0.0.0.0", () => {
    log(`Seed Node initialized on port ${SEED_PORT}`);
});
