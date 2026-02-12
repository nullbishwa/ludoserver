const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url === '/ping' ? "I am awake!" : "Hubby & Wiifu Hybrid Server Running");
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

const initialChessBoard = [
    "bR", "bN", "bB", "bQ", "bK", "bB", "bN", "bR",
    "bP", "bP", "bP", "bP", "bP", "bP", "bP", "bP",
    ...Array(32).fill(null),
    "wP", "wP", "wP", "wP", "wP", "wP", "wP", "wP",
    "wR", "wN", "wB", "wQ", "wK", "wB", "wN", "wR"
];

// --- CORE GAME ENGINE ---

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
        case 'K':
            if (rowDiff <= 1 && colDiff <= 1) legal = true;
            else if (rowDiff === 0 && colDiff === 2 && !state.movedPieces.has(from)) {
                const isKingside = toCol > fromCol;
                const rookIdx = isKingside ? from + 3 : from - 4;
                if (board[rookIdx] && !state.movedPieces.has(rookIdx) && isPathClear(from, rookIdx, board)) {
                    if (!isKingInCheck(board, playerColor, state)) legal = true;
                }
            }
            break;
    }
    if (!legal) return false;
    if (skipKingCheck) return true;
    return !isKingInCheck(simulateMove(board, from, to), playerColor, state);
}

function isKingInCheck(board, color, state) {
    const kingPos = board.indexOf(color + 'K');
    if (kingPos === -1) return false;
    const enemy = color === 'w' ? 'b' : 'w';
    for (let i = 0; i < 64; i++) {
        if (board[i] && board[i][0] === enemy) {
            if (isMoveLegal(i, kingPos, board, enemy, { ...state, enPassantTarget: -1 }, true)) return true;
        }
    }
    return false;
}

function hasLegalMoves(board, color, state) {
    for (let i = 0; i < 64; i++) {
        if (board[i] && board[i][0] === color) {
            for (let j = 0; j < 64; j++) {
                if (isMoveLegal(i, j, board, color, state, false)) return true;
            }
        }
    }
    return false;
}

// --- WEBSOCKET LOGIC ---

wss.on('connection', (ws, req) => {
    const parts = req.url.split('/');
    const roomId = parts[2] || 'default';
    const size = parseInt(parts[3]) || 3;

    if (!rooms.has(roomId)) {
        const hubbyIsWhite = Math.random() < 0.5;
        rooms.set(roomId, {
            board: size === 8 ? [...initialChessBoard] : Array(size * size).fill(null),
            clients: new Map(),
            size, turn: 'w',
            movedPieces: new Set(),
            enPassantTarget: -1,
            roles: { Hubby: hubbyIsWhite ? 'w' : 'b', Wiifu: hubbyIsWhite ? 'b' : 'w' }
        });
    }

    const room = rooms.get(roomId);
    let myRole = room.clients.size === 0 ? "Hubby" : (room.clients.size === 1 ? "Wiifu" : "Observer");
    room.clients.set(ws, myRole);
    const myColor = room.roles[myRole] || 'observer';

    ws.send(JSON.stringify({ type: 'ASSIGN_ROLE', role: myRole, color: myColor }));
    ws.send(JSON.stringify({ type: 'STATE', board: room.board, turn: room.turn, hubbyColor: room.roles.Hubby, wiifuColor: room.roles.Wiifu }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'EMOTE') {
                const res = JSON.stringify({ type: 'EMOTE', emoji: msg.emoji, sender: myRole });
                room.clients.forEach((r, client) => { if (client.readyState === 1) client.send(res); });
                return;
            }

            if (msg.type === 'RESET') {
                room.board = size === 8 ? [...initialChessBoard] : Array(size * size).fill(null);
                room.turn = 'w'; room.movedPieces.clear(); room.enPassantTarget = -1;
            } else if (msg.type === 'MOVE') {
                if (size === 8) {
                    if (room.turn !== myColor) return;
                    if (isMoveLegal(msg.from, msg.to, room.board, myColor, room)) {
                        let tempBoard = simulateMove(room.board, msg.from, msg.to);
                        // Pawn Promotion & Special moves logic
                        room.board = tempBoard;
                        room.movedPieces.add(msg.from);
                        room.turn = room.turn === 'w' ? 'b' : 'w';
                    }
                } else {
                    room.board[msg.index] = myColor === 'w' ? 'X' : 'O';
                }
            }

            const inCheck = size === 8 ? isKingInCheck(room.board, room.turn, room) : false;
            const noMoves = size === 8 ? !hasLegalMoves(room.board, room.turn, room) : false;

            const stateRes = JSON.stringify({
                type: 'STATE', board: room.board, turn: room.turn,
                inCheck, winner: (noMoves && inCheck) ? (myRole) : null,
                isDraw: (noMoves && !inCheck), hubbyColor: room.roles.Hubby, wiifuColor: room.roles.Wiifu
            });

            room.clients.forEach((r, client) => { if (client.readyState === 1) client.send(stateRes); });
        } catch (e) { console.log(e); }
    });

    ws.on('close', () => {
        const role = room.clients.get(ws);
        room.clients.delete(ws);
        if (room.clients.size > 0) {
            room.clients.forEach((r, c) => c.send(JSON.stringify({ type: 'KICK', message: `${role} left.` })));
        } else rooms.delete(roomId);
    });
});

server.listen(port, () => console.log(`Hybrid Server on ${port}`));
