const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(req.url === '/ping' ? "I am awake!" : "Hubby & Wiifu Pro Server Running");
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

// --- LEGALITY ENGINE ---

function isMoveLegal(from, to, board, playerColor, state, skipKingCheck = false) {
    const piece = board[from];
    if (!piece || piece[0] !== playerColor) return false;
    const target = board[to];
    if (target && target[0] === playerColor) return false;

    const fromRow = Math.floor(from / 8), fromCol = from % 8;
    const toRow = Math.floor(to / 8), toCol = to % 8;
    const rowDiff = Math.abs(toRow - fromRow), colDiff = Math.abs(toCol - fromCol);

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
    return legal; // Suicide moves allowed
}

function isKingInCheck(board, color, state) {
    const kingPos = board.indexOf(color + 'K');
    if (kingPos === -1) return false;
    const enemyColor = color === 'w' ? 'b' : 'w';
    for (let i = 0; i < 64; i++) {
        if (board[i] && board[i][0] === enemyColor) {
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

    if (!rooms.has(roomId)) {
        const hubbyIsWhite = Math.random() < 0.5;
        rooms.set(roomId, {
            board: [...initialChessBoard],
            clients: new Map(),
            turn: 'w', movedPieces: new Set(), enPassantTarget: -1,
            winner: null, isDraw: false,
            roles: { Hubby: hubbyIsWhite ? 'w' : 'b', Wiifu: hubbyIsWhite ? 'b' : 'w' }
        });
    }

    const room = rooms.get(roomId);
    let myRole = room.clients.size === 0 ? "Hubby" : (room.clients.size === 1 ? "Wiifu" : "Observer");
    room.clients.set(ws, myRole);
    const myColor = room.roles[myRole] || 'observer';

    ws.send(JSON.stringify({ type: 'ASSIGN_ROLE', role: myRole, color: myColor }));
    ws.send(JSON.stringify({ type: 'STATE', board: room.board, turn: room.turn, winner: room.winner, isDraw: room.isDraw }));

    // ... (keep your simulateMove, isPathClear, isMoveLegal, etc. exactly as they are)

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'RESET') {
                room.board = [...initialChessBoard];
                room.turn = 'w'; room.movedPieces.clear(); room.enPassantTarget = -1;
                room.winner = null; room.isDraw = false;
            }

            if (msg.type === 'MOVE') {
                if (room.winner || room.isDraw) return;
                if (room.turn !== myColor) return;

                if (isMoveLegal(msg.from, msg.to, room.board, myColor, room)) {
                    let tempBoard = simulateMove(room.board, msg.from, msg.to);
                    const piece = room.board[msg.from];

                    // 1. Special Moves Execution
                    if (piece[1] === 'P' && msg.to === room.enPassantTarget) {
                        tempBoard[msg.to + (myColor === 'w' ? 8 : -8)] = null;
                    }
                    if (piece[1] === 'K' && Math.abs(msg.to - msg.from) === 2) {
                        const isKingside = msg.to > msg.from;
                        const rFrom = isKingside ? msg.from + 3 : msg.from - 4;
                        const rTo = isKingside ? msg.from + 1 : msg.from - 1;
                        tempBoard[rTo] = tempBoard[rFrom]; tempBoard[rFrom] = null;
                        room.movedPieces.add(rFrom);
                    }
                    if (piece[1] === 'P' && (Math.floor(msg.to / 8) === 0 || Math.floor(msg.to / 8) === 7)) {
                        tempBoard[msg.to] = myColor + 'Q';
                    }

                    room.board = tempBoard;
                    room.movedPieces.add(msg.from);
                    room.enPassantTarget = (piece[1] === 'P' && Math.abs(msg.to - msg.from) === 16) ? (msg.from + msg.to) / 2 : -1;

                    // 2. SWAP TURN BEFORE CALCULATION
                    // 2. SWAP TURN BEFORE CALCULATION
                    // 1. SWAP TURN BEFORE CALCULATION
                    room.turn = room.turn === 'w' ? 'b' : 'w';

                    // 2. FORCE CHECKMATE DETECTION
                    const whiteInCheck = isKingInCheck(room.board, 'w', room);
                    const blackInCheck = isKingInCheck(room.board, 'b', room);

                    // Identify if the person whose turn it IS NOW can escape
                    const canOpponentEscape = hasLegalEscapes(room.board, room.turn, room);

                    if (!canOpponentEscape) {
                        const currentKingInCheck = (room.turn === 'w' ? whiteInCheck : blackInCheck);
                        if (currentKingInCheck) {
                            // The person who just moved (myRole) is the winner because the opponent is trapped!
                            room.winner = myRole;
                        } else {
                            room.isDraw = true;
                        }
                    }

                    // 3. BROADCAST TO BOTH APPS
                    const stateUpdate = JSON.stringify({
                        type: 'STATE',
                        board: room.board,
                        turn: room.turn,
                        whiteKingCheck: whiteInCheck,
                        blackKingCheck: blackInCheck,
                        checkedKingIndex: room.board.indexOf((whiteInCheck ? 'w' : (blackInCheck ? 'b' : '')) + 'K'),
                        winner: room.winner,
                        isDraw: room.isDraw,
                        hubbyColor: room.roles.Hubby,
                        wiifuColor: room.roles.Wiifu
                    });

                    room.clients.forEach((r, client) => { if (client.readyState === 1) client.send(stateUpdate); });
                    return; // VERY IMPORTANT: Prevent the second broadcast below
                }
            }

            // Broadcast for RESET or EMOTES
            const fallbackRes = JSON.stringify({
                type: 'STATE', board: room.board, turn: room.turn,
                winner: room.winner, isDraw: room.isDraw,
                hubbyColor: room.roles.Hubby, wiifuColor: room.roles.Wiifu
            });
            room.clients.forEach((r, c) => { if (c.readyState === 1) c.send(fallbackRes); });

        } catch (e) { console.log(e); }
    });

    ws.on('close', () => {
        room.clients.delete(ws);
        if (room.clients.size === 0) rooms.delete(roomId);
    });
});

server.listen(port, () => console.log(`Server on ${port}`));
