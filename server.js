const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(__dirname));

let rooms = {};
let roomCounter = 0;

function getPublicRoomList() {
    return Object.keys(rooms).map(roomId => {
        const r = rooms[roomId];
        return {
            id: roomId,
            name: r.name,
            hasPassword: !!r.password,
            playerCount: r.players.length,
            maxPlayers: r.maxPlayers,
            mode: r.mode,
            rule: r.rule,
            status: r.status
        };
    });
}

function broadcastRoomList() {
    io.emit('roomListUpdate', getPublicRoomList());
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('requestRoomList', () => {
        socket.emit('roomListUpdate', getPublicRoomList());
    });

    socket.on('createRoom', (data) => {
        const roomId = 'room_' + roomCounter++;
        const mode = data.mode === 'battle' ? 'battle' : '1v1';
        const maxPlayers = mode === 'battle' ? 4 : 2;
        const room = {
            id: roomId,
            name: data.roomName || 'Unnamed Room',
            password: data.password || '',
            hostId: socket.id,
            players: [{ id: socket.id, nickname: data.nickname || 'Player 1', isHost: true, isReady: false }],
            spectators: [],
            status: 'waiting',
            mode: mode,
            rule: data.rule || 'normal',
            maxPlayers: maxPlayers,
            alivePlayers: new Set()
        };
        rooms[roomId] = room;

        socket.join(roomId);
        socket.roomId = roomId;

        socket.emit('roomJoined', {
            room: serializeRoom(room),
            isHost: true,
            isSpectator: false
        });

        broadcastRoomList();
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomId];

        if (!room) return socket.emit('roomError', 'Room does not exist.');
        if (room.status !== 'waiting') return socket.emit('roomError', 'Room is already in a game.');
        if (room.players.length >= room.maxPlayers) return socket.emit('roomError', 'Room is full.');
        if (room.password && room.password !== data.password) return socket.emit('roomError', 'Incorrect password.');

        const newPlayer = { id: socket.id, nickname: data.nickname || 'Player', isHost: false, isReady: false };
        room.players.push(newPlayer);

        socket.join(room.id);
        socket.roomId = room.id;

        socket.emit('roomJoined', {
            room: serializeRoom(room),
            isHost: false,
            isSpectator: false
        });

        socket.to(room.id).emit('playerJoinedRoom', newPlayer);
        broadcastRoomList();
    });

    socket.on('spectateRoom', (data) => {
        const room = rooms[data.roomId];

        if (!room) return socket.emit('roomError', 'Room does not exist.');
        if (room.password && room.password !== data.password) return socket.emit('roomError', 'Incorrect password.');

        const newSpectator = { id: socket.id, nickname: data.nickname || 'Spectator' };
        room.spectators.push(newSpectator);

        socket.join(room.id);
        socket.roomId = room.id;
        socket.isSpectator = true;

        socket.emit('roomJoined', {
            room: serializeRoom(room),
            isHost: false,
            isSpectator: true
        });

        socket.to(room.id).emit('spectatorJoined', newSpectator);

        if (room.status === 'playing') {
            if (room.mode === 'battle') {
                socket.emit('spectateGameStart', {
                    mode: 'battle',
                    players: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
                    alivePlayers: [...room.alivePlayers]
                });
            } else {
                const p1 = room.players.find(p => p.isHost);
                const p2 = room.players.find(p => !p.isHost);
                socket.emit('spectateGameStart', {
                    mode: '1v1',
                    p1Nickname: p1 ? p1.nickname : 'Player 1',
                    p2Nickname: p2 ? p2.nickname : 'Player 2'
                });
            }
        }
    });

    socket.on('startGame', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.id) return;

        const nonHostPlayers = room.players.filter(p => !p.isHost);
        const readyCount = nonHostPlayers.filter(p => p.isReady).length;

        if (room.players.length < 2) return;
        if (readyCount < nonHostPlayers.length) return;

        room.status = 'playing';
        room.players.forEach(p => p.isReady = false);
        room.alivePlayers = new Set(room.players.map(p => p.id));
        broadcastRoomList();

        const seed = Math.floor(Math.random() * 1000000);

        if (room.rule === 'suddendeath') {
            if (room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
            room.suddenDeathTimer = setInterval(() => {
                if (room.status !== 'playing' || !rooms[roomId]) {
                    clearInterval(room.suddenDeathTimer);
                    return;
                }
                if (room.mode === 'battle') {
                    room.alivePlayers.forEach(id => {
                        io.to(id).emit('receiveGarbage', 1);
                    });
                } else {
                    room.players.forEach(p => {
                        io.to(p.id).emit('receiveGarbage', 1);
                    });
                }
            }, 20000);
        } else {
            if (room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
        }

        if (room.mode === '1v1') {
            const p1 = room.players.find(p => p.isHost);
            const p2 = room.players.find(p => !p.isHost);
            io.to(roomId).emit('gameStart', {
                seed, mode: '1v1', rule: room.rule,
                p1Nickname: p1.nickname,
                p2Nickname: p2.nickname
            });
        } else {
            // Battle: send personalized gameStart to each player
            room.players.forEach(player => {
                const sock = io.sockets.sockets.get(player.id);
                if (sock) {
                    sock.emit('gameStart', {
                        seed, mode: 'battle', rule: room.rule,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
                        myId: player.id
                    });
                }
            });
            // Spectators get myId: null
            room.spectators.forEach(spec => {
                const sock = io.sockets.sockets.get(spec.id);
                if (sock) {
                    sock.emit('gameStart', {
                        seed, mode: 'battle', rule: room.rule,
                        players: room.players.map(p => ({ id: p.id, nickname: p.nickname })),
                        myId: null
                    });
                }
            });
        }
    });

    socket.on('boardUpdate', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];
        if (room.mode === 'battle') {
            data.senderId = socket.id;
        } else {
            data.isHost = (room.hostId === socket.id);
        }
        socket.to(socket.roomId).emit('boardUpdate', data);
    });

    socket.on('sendGarbage', (lines) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];

        if (room.mode === 'battle') {
            const aliveExcludingSelf = [...room.alivePlayers].filter(id => id !== socket.id);
            if (aliveExcludingSelf.length === 0) return;
            // 각 라인별로 대상을 다시 뽑아서 무작위성 극대화
            for (let i = 0; i < lines; i++) {
                const targetId = aliveExcludingSelf[Math.floor(Math.random() * aliveExcludingSelf.length)];
                const targetSock = io.sockets.sockets.get(targetId);
                if (targetSock) targetSock.emit('receiveGarbage', 1);
            }
        } else {
            socket.to(socket.roomId).emit('receiveGarbage', lines);
        }
    });

    socket.on('gameOver', () => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];

        if (room.mode === 'battle') {
            const eliminated = room.players.find(p => p.id === socket.id);
            room.alivePlayers.delete(socket.id);

            io.to(socket.roomId).emit('playerEliminated', {
                id: socket.id,
                nickname: eliminated ? eliminated.nickname : 'Player'
            });

            if (room.alivePlayers.size === 1) {
                const winnerId = [...room.alivePlayers][0];
                const winner = room.players.find(p => p.id === winnerId);
                io.to(socket.roomId).emit('gameEndBattle', {
                    winnerId,
                    winnerNickname: winner ? winner.nickname : 'Player'
                });
                room.status = 'waiting';
                room.players.forEach(p => p.isReady = false);
                broadcastRoomList();
            } else if (room.alivePlayers.size === 0) {
                room.status = 'waiting';
                room.players.forEach(p => p.isReady = false);
                broadcastRoomList();
            }
        } else {
            socket.to(socket.roomId).emit('opponentGameOver', { isHost: (room.hostId === socket.id) });
        }
    });

    socket.on('leaveRoom', () => {
        handlePlayerLeave(socket);
    });

    socket.on('chatMessage', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        // 닉네임과 역할(참여자/관전자) 판별
        const player = room.players.find(p => p.id === socket.id);
        const spectator = room.spectators.find(s => s.id === socket.id);
        const nickname = player ? player.nickname : (spectator ? spectator.nickname : 'Unknown');
        const role = spectator ? 'spectator' : 'player';

        const msg = String(data.message || '').trim().slice(0, 200);
        if (!msg) return;

        io.to(roomId).emit('chatMessage', { nickname, role, message: msg });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        handlePlayerLeave(socket);
    });

    socket.on('toggleReady', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room || room.status !== 'waiting') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player && !player.isHost) {
            player.isReady = !player.isReady;
            io.to(roomId).emit('readyStateChanged', room.players);
        }
    });

    socket.on('returnToRoom', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReady = false;

        if (room.status === 'playing') {
            room.status = 'waiting';
            room.players.forEach(p => p.isReady = false);
            broadcastRoomList();
        }

        io.to(roomId).emit('readyStateChanged', room.players);
        socket.emit('goToWaitingRoom');
    });

    function handlePlayerLeave(sock) {
        const roomId = sock.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        sock.leave(roomId);
        sock.roomId = null;

        if (sock.isSpectator) {
            room.spectators = room.spectators.filter(s => s.id !== sock.id);
            sock.to(roomId).emit('spectatorLeft', sock.id);
            sock.isSpectator = false;
            return;
        }

        const isHost = room.hostId === sock.id;
        const leavingPlayer = room.players.find(p => p.id === sock.id);
        room.players = room.players.filter(p => p.id !== sock.id);

        if (room.players.length === 0) {
            delete rooms[roomId];
            broadcastRoomList();
            return;
        }

        if (isHost) {
            const newHost = room.players[0];
            newHost.isHost = true;
            newHost.isReady = false;
            room.hostId = newHost.id;
            sock.to(roomId).emit('hostMigrated', newHost);
        }

        if (room.status === 'playing') {
            if (room.mode === 'battle') {
                room.alivePlayers.delete(sock.id);
                sock.to(roomId).emit('playerEliminated', {
                    id: sock.id,
                    nickname: leavingPlayer ? leavingPlayer.nickname : 'Player'
                });

                if (room.alivePlayers.size === 1) {
                    const winnerId = [...room.alivePlayers][0];
                    const winner = room.players.find(p => p.id === winnerId);
                    io.to(roomId).emit('gameEndBattle', {
                        winnerId,
                        winnerNickname: winner ? winner.nickname : 'Player'
                    });
                    room.status = 'waiting';
                    room.players.forEach(p => p.isReady = false);
                } else if (room.alivePlayers.size === 0) {
                    room.status = 'waiting';
                    room.players.forEach(p => p.isReady = false);
                }
            } else { // 1v1 mode
                sock.to(roomId).emit('opponentDisconnected');
                delete rooms[roomId];
                broadcastRoomList();
                return;
            }
        } else {
            sock.to(roomId).emit('playerLeftRoom');
        }

        sock.to(roomId).emit('readyStateChanged', room.players);
        broadcastRoomList();
    }
});

function serializeRoom(room) {
    return {
        id: room.id,
        name: room.name,
        password: room.password,
        hostId: room.hostId,
        players: room.players,
        spectators: room.spectators,
        status: room.status,
        mode: room.mode,
        rule: room.rule,
        maxPlayers: room.maxPlayers
    };
}

const PORT = 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
