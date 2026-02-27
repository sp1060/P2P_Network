import net from "net";
import fs from "fs";

interface InternalPeer {
    id: string;
    host: string;
    port: number;
    degree: number;
}

interface Peer {
    id: string;
    host: string;
    port: number;
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

const server = net.createServer((socket) => {
    let buffer = "";
    const remoteIP = socket.remoteAddress || "unknown";

    socket.on("data", (data: Buffer) => {
        buffer += data.toString();
        let boundary;

        while ((boundary = buffer.indexOf("\n")) >= 0) {
            const rawMessage = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 1);

            if (!rawMessage) continue;

            try {
                const parsed = JSON.parse(rawMessage);
                
                // ---------- JOIN ----------
                if (parsed.type === "REGISTER" && parsed.node) {
                    const newPeer: InternalPeer = {
                        id: parsed.node.id,
                        host: parsed.node.host || remoteIP,
                        port: parsed.node.port,
                        degree: 0
                    };

                    log(`JOIN request from ${newPeer.id} (${newPeer.host}:${newPeer.port})`);

                    // Preferential attachment
                    const neighbors = [...peerList]
                        .sort((a, b) => b.degree - a.degree)
                        .slice(0, 2);

                    neighbors.forEach(n => {
                        const match = peerList.find(p => p.id === n.id);
                        if (match) match.degree++;
                    });

                    peerList.push(newPeer);
                    log(`Admitted ${newPeer.id}. Network size: ${peerList.length}`);

                    const response: Peer[] = neighbors.map(({ degree, ...rest }) => rest);
                    socket.write(JSON.stringify(response) + "\n");
                }

                // ---------- GET PEERS ----------
                else if (parsed.type === "GET_PEERS") {
                    const response: Peer[] = peerList.map(({ degree, ...rest }) => rest);
                    socket.write(JSON.stringify(response) + "\n");
                }

                // ---------- DEAD NODE ----------
                else if (parsed.type === "DEAD_NODE") {
                    const deadId = parsed.node;
                    log(`Death report received for ${deadId}`);
                    peerList = peerList.filter(p => p.id !== deadId);
                    log(`Removed ${deadId}. Network size: ${peerList.length}`);
                }
            } catch (err) {
                log(`Error processing message: ${err}`);
            }
        }
    });

    socket.on("error", (err) => {
        log(`Socket error: ${err.message}`);
        socket.destroy();
    });
});

server.listen(SEED_PORT, "0.0.0.0", () => {
    log(`Seed Node initialized on port ${SEED_PORT}`);
});
