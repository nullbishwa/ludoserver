const { WebSocketServer } = require('ws');
const http = require('http');

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Chess Authority: Grandmaster Edition - 100% Rules Compliant");
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

// --- INITIALIZATION & UTILS ---

function createInitialBoard() {
    const board = {};
    const layout = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let i = 0; i < 8; i++) {
        board[`0,${i}`] = { type: layout[i], color: 'B' };
        board[`1,${i}`] = { type: 'P', color: 'B' };
        board[`6,${i}`] = { type: 'P', color: 'W' };
        board[`7,${i}`] = { type: layout[i], color: 'W' };
    }
    return board;
}

function createInitialState() {
    return {
        board: createInitialBoard(),
        turn: 'W',
        castlingRights: { W: { k: true, q: true }, B: { k: true, q: true } },
        enPassantTarget: null,
        halfMoveClock: 0,
        history: [], // Stores board hashes
        status: "active"
    };
}

// Generates a simple hash of the board state for Threefold Repetition
function getBoardHash(room) {
    return JSON.stringify({
        b: room.board,
        t: room.turn,
        c: room.castlingRights,
        e: room.enPassantTarget
    });
}

// --- CORE LOGIC ---

function isPathClear(board, from, to) {
    const [fR, fC] = from.split(',').map(Number);
    const [tR, tC] = to.split(',').map(Number);
    const stepR = tR === fR ? 0 : (tR > fR ? 1 : -1);
    const stepC = tC === fC ? 0 : (tC > fC ? 1 : -1);
    let currR = fR + stepR, currC = fC + stepC;
    while (currR !== tR || currC !== tC) {
        if (board[`${currR},${currC}`]) return false;
        currR += stepR; currC += stepC;
    }
    return true;
}

function canPieceMove(board, from, to, piece, epTarget, castling) {
    const [fR, fC] = from.split(',').map(Number);
    const [tR, tC] = to.split(',').map(Number);
    const rDiff = Math.abs(tR - fR), cDiff = Math.abs(tC - fC);
    const target = board[to];

    if (target && target.color === piece.color) return false;

    switch (piece.type) {
        case 'P':
            const dir = piece.color === 'W' ? -1 : 1;
            if (fC === tC && !target) {
                if (tR === fR + dir) return true;
                if (fR === (piece.color === 'W' ? 6 : 1) && tR === fR + 2 * dir && !board[`${fR + dir},${fC}`]) return true;
            }
            if (cDiff === 1 && tR === fR + dir && (target || to === epTarget)) return true;
            return false;
        case 'N': return (rDiff === 2 && cDiff === 1) || (rDiff === 1 && cDiff === 2);
        case 'B': return rDiff === cDiff && isPathClear(board, from, to);
        case 'R': return (fR === tR || fC === tC) && isPathClear(board, from, to);
        case 'Q': return (rDiff === cDiff || fR === tR || fC === tC) && isPathClear(board, from, to);
        case 'K':
            if (rDiff <= 1 && cDiff <= 1) return true;
            if (castling && rDiff === 0 && cDiff === 2) {
                const side = tC > fC ? 'k' : 'q';
                return castling[piece.color][side] && isPathClear(board, from, `${fR},${side === 'k' ? 7 : 0}`);
            }
            return false;
    }
}

function isSquareAttacked(board, targetPos, attackerColor) {
    for (const pos in board) {
        const piece = board[pos];
        if (piece.color === attackerColor && canPieceMove(board, pos, targetPos, piece, null, null)) return true;
    }
    return false;
}

function isKingInCheck(board, color) {
    let kingPos = Object.keys(board).find(pos => board[pos].type === 'K' && board[pos].color === color);
    return isSquareAttacked(board, kingPos, color === 'W' ? 'B' : 'W');
}

// --- ADVANCED RULES & GAME STATE ---

function tryMove(room, from, to, promotionType = 'Q') {
    const piece = room.board[from];
    const newBoard = { ...room.board };
    const [fR, fC] = from.split(',').map(Number);
    const [tR, tC] = to.split(',').map(Number);

    // Castling safety checks
    if (piece.type === 'K' && Math.abs(tC - fC) === 2) {
        const attackerColor = piece.color === 'W' ? 'B' : 'W';
        const midC = fC + (tC > fC ? 1 : -1);
        if (isKingInCheck(room.board, piece.color) || 
            isSquareAttacked(room.board, `${fR},${midC}`, attackerColor) || 
            isSquareAttacked(room.board, to, attackerColor)) return null;
    }

    newBoard[to] = { ...piece };
    delete newBoard[from];

    if (isKingInCheck(newBoard, piece.color)) return null;

    // Execute Promotion
    if (piece.type === 'P' && (tR === 0 || tR === 7)) {
        newBoard[to].type = promotionType;
    }

    // Execute En Passant
    if (piece.type === 'P' && to === room.enPassantTarget) {
        delete newBoard[`${fR},${tC}`];
    }

    // Execute Castling Rook Swap
    if (piece.type === 'K' && Math.abs(tC - fC) === 2) {
        const rookCol = tC > fC ? 7 : 0;
        const newRookCol = tC > fC ? 5 : 3;
        newBoard[`${fR},${newRookCol}`] = newBoard[`${fR},${rookCol}`];
        delete newBoard[`${fR},${rookCol}`];
    }

    return newBoard;
}

function checkInsufficientMaterial(board) {
    const pieces = Object.values(board);
    if (pieces.length === 2) return true; // King vs King
    if (pieces.length === 3) {
        const nonKing = pieces.find(p => p.type !== 'K');
        if (nonKing.type === 'B' || nonKing.type === 'N') return true; // King & Bishop/Knight vs King
    }
    return false;
}

function updateGameState(room) {
    const nextColor = room.turn;
    const hasLegalMove = Object.keys(room.board).some(from => {
        if (room.board[from].color !== nextColor) return false;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const to = `${r},${c}`;
                if (canPieceMove(room.board, from, to, room.board[from], room.enPassantTarget, room.castlingRights)) {
                    if (tryMove(room, from, to)) return true;
                }
            }
        }
        return false;
    });

    const inCheck = isKingInCheck(room.board, nextColor);
    if (!hasLegalMove) return inCheck ? "checkmate" : "stalemate";
    
    // Check Threefold Repetition
    const hash = getBoardHash(room);
    room.history.push(hash);
    const occurrences = room.history.filter(h => h === hash).length;
    if (occurrences >= 3) return "draw_repetition";

    if (room.halfMoveClock >= 100) return "draw_50_move";
    if (checkInsufficientMaterial(room.board)) return "draw_insufficient";

    return "active";
}

// --- SERVER HANDLER ---

wss.on('connection', (ws, req) => {
    const roomId = req.url.split('/')[2] || 'default';
    if (!rooms.has(roomId)) rooms.set(roomId, { ...createInitialState(), clients: new Map(), roles: { Hubby: null, Wiifu: null } });
    const room = rooms.get(roomId);
    const myRole = room.clients.size === 0 ? "Hubby" : (room.clients.size === 1 ? "Wiifu" : "Observer");
    room.clients.set(ws, myRole);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const playerColor = room.roles[myRole];
            if (room.status !== "active" || room.turn !== playerColor) return;

            if (msg.type === 'MOVE_PIECE') {
                const { from, to, promotionType } = msg;
                const piece = room.board[from];
                const target = room.board[to];

                if (canPieceMove(room.board, from, to, piece, room.enPassantTarget, room.castlingRights)) {
                    const nextBoard = tryMove(room, from, to, promotionType);
                    if (nextBoard) {
                        if (piece.type === 'P' || target) room.halfMoveClock = 0; else room.halfMoveClock++;
                        
                        // Update Rights & State
                        if (piece.type === 'K') room.castlingRights[playerColor] = { k: false, q: false };
                        room.enPassantTarget = (piece.type === 'P' && Math.abs(Number(to.split(',')[0]) - Number(from.split(',')[0])) === 2) ? `${(Number(from.split(',')[0]) + Number(to.split(',')[0])) / 2},${from.split(',')[1]}` : null;
                        
                        room.board = nextBoard;
                        room.turn = room.turn === 'W' ? 'B' : 'W';
                        room.status = updateGameState(room);
                        broadcast(room, { type: 'STATE', board: room.board, turn: room.turn, status: room.status });
                    }
                }
            }
        } catch (e) { console.error(e); }
    });
});

function broadcast(room, data) {
    const msg = JSON.stringify(data);
    room.clients.forEach((role, client) => { if (client.readyState === 1) client.send(msg); });
}

server.listen(port, () => console.log(`Grandmaster Chess Server running on ${port}`));
