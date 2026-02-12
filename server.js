const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;

// Basic HTTP server for health checks
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url === '/ping' ? "I am awake!" : "Hubby & Wiifu Hybrid Server Running");
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// Initial Chess Board Setup
const initialChessBoard = [
    "bR", "bN", "bB", "bQ", "bK", "bB", "bN", "bR",
    "bP", "bP", "bP", "bP", "bP", "bP", "bP", "bP",
    ...Array(32).fill(null),
    "wP", "wP", "wP", "wP", "wP", "wP", "wP", "wP",
    "wR", "wN", "wB", "wQ", "wK", "wB", "wN", "wR"
];

// --- CORE UTILS ---

function simulateMove(board, from, to) {
    const newBoard = [...board];
    newBoard[to] = newBoard[from];
    newBoard[from] = null;
    return newBoard;
}

function isPathClear(from, to, board) {
    const fromRow = Math.floor(from / 8), fromCol = from % 8;
    const toRow = Math.floor(to / 8), toCol = to % 8;
    const rStep = toRow === fromRow ? 0 : (toRow > fromRow ? 1 : -1);
    const cStep = toCol === fromCol ? 0 : (toCol > fromCol ? 1 : -1);
    let r = fromRow + rStep, c = fromCol + cStep;
    while (r !== toRow || c !== toCol) {
        if (board[r * 8 + c]) return false;
        r += rStep; c += cStep;
    }
    return true;
}

// --- LEGALITY & CHECK ENGINE ---

function isMoveLegal(from, to, board, playerColor, state, skipKingCheck = false) {
    const piece = board[from];
    if (!piece || piece[0] !== playerColor) return false;
    const target = board[to];
    if (target && target[0] === playerColor) return false;
    
    const fromRow = Math.floor(from / 8), fromCol = from % 8;
    const toRow = Math.floor(to / 8), toCol = to % 8;
    const rowDiff = Math.abs(toRow - fromRow);
    const colDiff = Math.abs(toCol - fromCol);

    let legal = false;
    switch (piece[1]) {
        case 'P':
            const dir = playerColor === 'w' ? -1 : 1;
            if (fromCol === toCol && !target) {
                if (toRow === fromRow + dir) legal = true;
                else if (fromRow === (playerColor === 'w' ? 6 : 1) && toRow === fromRow + 2 * dir && !board[from + 8 * dir]) legal = true;
            } else if (colDiff === 1 && toRow === fromRow + dir) {
                if (target || state.enPassantTarget === to) legal = true;
            }
            break;
        case 'R': legal = (fromRow === toRow || fromCol === toCol) && isPathClear(from, to, board); break;
        case 'B': legal = (rowDiff === colDiff) && isPathClear(from, to, board); break;
        case 'Q': legal = (rowDiff === colDiff || fromRow === toRow || fromCol === toCol) && isPathClear(from, to, board); break;
        case 'N': legal = (rowDiff === 2 && colDiff === 1) || (rowDiff === 1 && colDiff === 2); break;
        case 'K': if (rowDiff <= 1 && colDiff <= 1) legal = true; break;
    }

    // THE "SUICIDE" LOGIC: We return 'legal' regardless of whether our King becomes exposed.
    return legal;
}

function isKingInCheck(board, color, state) {
    const kingPos = board.indexOf(color + 'K');
    if (kingPos === -1) return false;
    const enemyColor = color === 'w' ? 'b' : 'w';
    
    for (let i = 0; i < 64; i++) {
        if (board[i] && board[i][0] === enemyColor) {
            // Can any enemy piece legally reach the King?
            if (isMoveLegal(i, kingPos, board, enemyColor, state, true)) return true;
        }
    }
    return false;
}

function hasLegalEscapes(board, color, state) {
    for (let i = 0; i < 64; i++) {
        if (board[i] && board[i][0] === color) {
            for (let j = 0; j < 64; j++) {
                if (isMoveLegal(i, j, board, color, state, true)) {
                    const nextBoard = simulateMove(board, i, j);
                    // A move is an "escape" ONLY if the King is no longer in check after it
                    if (!isKingInCheck(nextBoard, color, state)) return true;
                }
            }
        }
    }
    return false;
}

// --- WS HANDLER ---

wss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    const roomId = parts[2] || 'default';
    const size = parseInt(parts[3]) || 8;

    if (!rooms.has(roomId)) {
        const hubbyIsWhite = Math.random() < 0.5;
        rooms.set(roomId, {
            board: [...initialChessBoard],
            clients: new Map(),
            turn: 'w', movedPieces: new Set(), enPassantTarget: -1,
            roles: { Hubby: hubbyIsWhite ? 'w' : 'b', Wiifu: hubbyIsWhite ? 'b' : 'w' }
        });
    }

    const room = rooms.get(roomId);
    let myRole = room.clients.size === 0 ? "Hubby" : (room.clients.size === 1 ? "Wiifu" : "Observer");
    room.clients.set(ws, myRole);
    const myColor = room.roles[myRole] || 'observer';

    // Welcome message
    ws.send(JSON.stringify({ type: 'ASSIGN_ROLE', role: myRole, color: myColor }));
    ws.send(JSON.stringify({ type: 'STATE', board: room.board, turn: room.turn, hubbyColor: room.roles.Hubby, wiifuColor: room.roles.Wiifu }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'EMOTE') {
                const emote = JSON.stringify({ type: 'EMOTE', emoji: msg.emoji, sender: myRole });
                room.clients.forEach((r, client) => { if (client.readyState === 1) client.send(emote); });
                return;
            }

            if (msg.type === 'MOVE') {
                if (room.turn !== myColor) return;

                if (isMoveLegal(msg.from, msg.to, room.board, myColor, room)) {
                    let tempBoard = simulateMove(room.board, msg.from, msg.to);
                    const piece = room.board[msg.from];
                    
                    // 1. En Passant Capture logic
                    if (piece[1] === 'P' && msg.to === room.enPassantTarget) {
                        tempBoard[msg.to + (myColor === 'w' ? 8 : -8)] = null;
                    }

                    // 2. Promotion (Auto-Queen)
                    const targetRow = Math.floor(msg.to / 8);
                    if (piece[1] === 'P' && (targetRow === 0 || targetRow === 7)) {
                        tempBoard[msg.to] = myColor + 'Q';
                    }

                    // 3. Update Room
                    room.board = tempBoard;
                    room.movedPieces.add(msg.from);
                    room.enPassantTarget = (piece[1] === 'P' && Math.abs(msg.to - msg.from) === 16) ? (msg.from + msg.to) / 2 : -1;

                    // 4. CHECKMATE SCAN (Post-Move)
                    const nextTurn = room.turn === 'w' ? 'b' : 'w';
                    const enemyInCheck = isKingInCheck(room.board, nextTurn, room);
                    const canOpponentEscape = hasLegalEscapes(room.board, nextTurn, room);

                    let winner = null;
                    let isDraw = false;

                    if (!canOpponentEscape) {
                        if (enemyInCheck) winner = myRole; // Checkmate detected
                        else isDraw = true;               // Stalemate detected
                    }

                    room.turn = nextTurn;

                    // 5. Broadcast final state
                    const stateUpdate = JSON.stringify({
                        type: 'STATE', board: room.board, turn: room.turn,
                        inCheck: enemyInCheck, winner: winner, isDraw: isDraw,
                        hubbyColor: room.roles.Hubby, wiifuColor: room.roles.Wiifu
                    });

                    room.clients.forEach((r, client) => { if (client.readyState === 1) client.send(stateUpdate); });
                }
            }
        } catch (e) { console.log("Error:", e); }
    });

    ws.on('close', () => {
        const role = room.clients.get(ws);
        room.clients.delete(ws);
        if (room.clients.size > 0) {
            room.clients.forEach((r, c) => c.send(JSON.stringify({ type: 'KICK', message: `${role} left. Game over!` })));
        } else rooms.delete(roomId);
    });
});

server.listen(port, () => console.log(`Hubby & Wiifu Server running on port ${port}`));
