const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// This object acts as our temporary "in-memory" database
const activeRooms = {};

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // 1. JOIN/CREATE ROOM
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        
        // If room doesn't exist, create it
        if (!activeRooms[roomId]) {
            activeRooms[roomId] = {
                players: [],
                selectedColors: [] // Tracks which colors (Red/Yellow/etc) are taken
            };
            console.log(`Room ${roomId} created.`);
        }

        // Add player to the room tracking
        if (!activeRooms[roomId].players.includes(socket.id)) {
            activeRooms[roomId].players.push(socket.id);
        }

        io.to(roomId).emit('updateStatus', {
            message: `Joined room: ${roomId}`,
            playerCount: activeRooms[roomId].players.length
        });
    });

    // 2. MANUAL COLOR SELECTION
    socket.on('selectColor', (data) => {
        // data: { roomId: "xyz", color: "red_piece" }
        const { roomId, color } = data;

        if (activeRooms[roomId]) {
            // Check if color is already taken
            if (activeRooms[roomId].selectedColors.includes(color)) {
                socket.emit('error', "Color already taken by your partner!");
            } else {
                activeRooms[roomId].selectedColors.push(color);
                // Tell the other player which color is now unavailable
                socket.to(roomId).emit('colorLocked', color);
                socket.emit('colorConfirmed', color);
            }
        }
    });

    // 3. GAMEPLAY SYNC
    socket.on('rollDice', (data) => {
        io.to(data.roomId).emit('diceRolled', { value: data.value, sender: socket.id });
    });

    socket.on('movePawn', (data) => {
        // Broadcast movement to the other player
        socket.to(data.roomId).emit('pawnMoved', data);
    });

    // 4. AUTO-DELETE ROOM ON LEAVE
    socket.on('disconnecting', () => {
        // Check all rooms the socket was in
        for (const roomId of socket.rooms) {
            if (activeRooms[roomId]) {
                // Remove player from our tracking
                activeRooms[roomId].players = activeRooms[roomId].players.filter(id => id !== socket.id);
                
                // If room is empty, delete it from memory
                if (activeRooms[roomId].players.length === 0) {
                    delete activeRooms[roomId];
                    console.log(`Room ${roomId} deleted because everyone left.`);
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ludo Server active on port ${PORT}`));
