const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url === '/ping' ? "I am awake!" : "Ludo Authority: Hubby & Wiifu Pro Edition");
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// --- LUDO CONSTANTS ---
const BOARD_SIZE = 52; 
const SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47]; // Traditional safe/star spots
const COLOR_OFFSETS = { "RED": 0, "BLUE": 13, "YELLOW": 26, "GREEN": 39 };

function createInitialState() {
    return {
        // -1 = Base, 0-51 = Common Path, 52-56 = Home Stretch, 57 = Goal
        board: { "RED": [-1, -1, -1, -1], "BLUE": [-1, -1, -1, -1], "YELLOW": [-1, -1, -1, -1], "GREEN": [-1, -1, -1, -1] },
        turn: "RED",
        lastDice: 0,
        diceRolled: false,
        sixCount: 0,
        winners: []
    };
}

wss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    const roomId = parts[2] || 'default';
    
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            ...createInitialState(),
            clients: new Map(), 
            roles: { Hubby: null, Wiifu: null }
        });
    }

    const room = rooms.get(roomId);
    let myRole = room.clients.size === 0 ? "Hubby" : (room.clients.size === 1 ? "Wiifu" : "Observer");
    room.clients.set(ws, myRole);

    ws.send(JSON.stringify({ type: 'ASSIGN_ROLE', role: myRole, state: room }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const playerColor = room.roles[myRole];

            // 1. SELECT COLOR
            if (msg.type === 'SELECT_COLOR' && !playerColor) {
                if (!Object.values(room.roles).includes(msg.color)) {
                    room.roles[myRole] = msg.color;
                    broadcast(room, { type: 'ROLE_UPDATE', roles: room.roles });
                }
                return;
            }

            // 2. DICE ROLL (Includes Three 6s Rule)
            if (msg.type === 'ROLL_DICE') {
                if (room.turn !== playerColor || room.diceRolled) return;

                const roll = Math.floor(Math.random() * 6) + 1;
                room.lastDice = roll;
                room.diceRolled = true;

                if (roll === 6) {
                    room.sixCount++;
                    if (room.sixCount === 3) {
                        broadcast(room, { type: 'THREE_SIXES', message: "Three 6s! Turn forfeited." });
                        room.sixCount = 0;
                        setTimeout(() => switchTurn(room), 1000);
                        return;
                    }
                } else {
                    room.sixCount = 0;
                }

                const movablePawns = getMovablePawns(room, playerColor, room.lastDice);
                if (movablePawns.length === 0) {
                    setTimeout(() => switchTurn(room), 1500);
                }

                broadcast(room, { type: 'DICE_RESULT', value: room.lastDice, movablePawns });
                return;
            }

            // 3. MOVE PAWN (With Blockade & Exact Roll Logic)
            if (msg.type === 'MOVE_PAWN') {
                if (room.turn !== playerColor || !room.diceRolled) return;
                
                const pawnIdx = msg.pawnIndex;
                const dice = room.lastDice;
                let currentPos = room.board[playerColor][pawnIdx];
                let grantExtraTurn = false;

                if (currentPos === -1 && dice === 6) {
                    room.board[playerColor][pawnIdx] = 0;
                    grantExtraTurn = true; 
                } else {
                    const newPos = currentPos + dice;
                    // Rule: Exact roll to enter Home Triangle (57)
                    if (newPos <= 57) {
                        room.board[playerColor][pawnIdx] = newPos;
                        if (newPos === 57) grantExtraTurn = true;
                    }
                }

                // Rule: Extra turn on Capture
                const captured = handleCapture(room, playerColor, pawnIdx);
                if (captured) grantExtraTurn = true;

                // Check for Victory
                if (room.board[playerColor].every(p => p === 57)) {
                    if (!room.winners.includes(myRole)) room.winners.push(myRole);
                }

                if (dice === 6 || grantExtraTurn) {
                    room.diceRolled = false; 
                } else {
                    switchTurn(room);
                }

                broadcast(room, { type: 'STATE', board: room.board, turn: room.turn, winners: room.winners });
            }

        } catch (e) { console.error("Ludo Error", e); }
    });

    ws.on('close', () => {
        room.clients.delete(ws);
        if (room.clients.size === 0) rooms.delete(roomId);
    });
});

// --- CORE RULES ENGINE ---

function getMovablePawns(room, color, dice) {
    return room.board[color].map((pos, idx) => {
        // Base Exit
        if (pos === -1 && dice === 6) return idx;
        
        if (pos >= 0) {
            const newPos = pos + dice;
            // Rule: Exact roll for Goal
            if (newPos > 57) return null;

            // Rule: Blockade Check (Cannot move past or land on an opponent's Jota)
            if (isPathBlocked(room, color, pos, dice)) return null;

            return idx;
        }
        return null;
    }).filter(v => v !== null);
}

function isPathBlocked(room, myColor, currentPos, dice) {
    // Check every square the pawn will step on
    for (let i = 1; i <= dice; i++) {
        const stepPos = currentPos + i;
        if (stepPos > 51) continue; // Blockades don't exist in Home Stretch

        const globalPos = (stepPos + COLOR_OFFSETS[myColor]) % BOARD_SIZE;
        
        // Check all other colors for a blockade at this globalPos
        for (const otherColor of Object.keys(room.board)) {
            if (otherColor === myColor) continue;
            
            const pawnsAtPos = room.board[otherColor].filter(p => {
                if (p === -1 || p > 51) return false;
                return (p + COLOR_OFFSETS[otherColor]) % BOARD_SIZE === globalPos;
            });

            if (pawnsAtPos.length >= 2) return true; // Blockade found!
        }
    }
    return false;
}

function handleCapture(room, attackerColor, pawnIdx) {
    const attackerPos = room.board[attackerColor][pawnIdx];
    if (attackerPos > 51 || attackerPos === -1) return false; 

    const attackerGlobalPos = (attackerPos + COLOR_OFFSETS[attackerColor]) % BOARD_SIZE;
    if (SAFE_SQUARES.includes(attackerGlobalPos)) return false; 

    let captured = false;
    Object.keys(room.board).forEach(targetColor => {
        if (targetColor === attackerColor) return;
        room.board[targetColor].forEach((pos, idx) => {
            if (pos === -1 || pos > 51) return;
            const targetGlobalPos = (pos + COLOR_OFFSETS[targetColor]) % BOARD_SIZE;
            
            // Rule: You can only capture if there is exactly 1 pawn (Blockades are immune)
            if (attackerGlobalPos === targetGlobalPos) {
                room.board[targetColor][idx] = -1;
                captured = true;
            }
        });
    });
    return captured;
}

function switchTurn(room) {
    const colors = ["RED", "BLUE", "YELLOW", "GREEN"];
    let nextIdx = (colors.indexOf(room.turn) + 1) % 4;
    room.turn = colors[nextIdx];
    room.diceRolled = false;
    room.lastDice = 0;
    room.sixCount = 0;
}

function broadcast(room, data) {
    const msg = JSON.stringify(data);
    room.clients.forEach((role, client) => { if (client.readyState === 1) client.send(msg); });
}

server.listen(port, () => console.log(`Authoritative Ludo Server on ${port}`));
