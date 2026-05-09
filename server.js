const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

// roomCode -> {
//   players: Map(playerId -> { socketId, name, disconnectedAt }),
//   currentQuestion, currentLevel,
//   answers: Map(playerId -> text)
// }
const rooms = new Map();

// Rooms stay alive when players disconnect — they can rejoin anytime with the same code
// from the same device. After 24h of total inactivity (no one connected), the room is swept.
const ROOM_INACTIVE_TTL_MS = 24 * 60 * 60 * 1000;

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let attempts = 0;
  while (attempts < 100) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += letters[Math.floor(Math.random() * letters.length)];
    }
    if (!rooms.has(code)) return code;
    attempts++;
  }
  throw new Error('Could not generate unique room code');
}

function pickRandomQuestion(level) {
  const pool = questions[String(level)];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function broadcastRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;
  const playerList = Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    connected: !p.disconnectedAt,
  }));
  io.to(code).emit('room_state', {
    code,
    players: playerList,
  });
}

function tryFinalizeReveal(code) {
  const room = rooms.get(code);
  if (!room || !room.currentQuestion) return;
  if (room.players.size !== 2) return;
  const allSubmitted = Array.from(room.players.keys()).every((pid) =>
    room.answers.has(pid)
  );
  if (!allSubmitted) return;
  const reveal = Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    answer: room.answers.get(id) || '',
  }));
  io.to(code).emit('reveal', {
    question: room.currentQuestion,
    level: room.currentLevel,
    answers: reveal,
  });
}

io.on('connection', (socket) => {
  let myRoomCode = null;
  let myPlayerId = null;

  socket.on('create_room', (payload, ack) => {
    try {
      const name = (payload && payload.name) || 'Player 1';
      const playerId =
        (payload && payload.playerId) || crypto.randomBytes(8).toString('hex');
      const code = generateRoomCode();
      rooms.set(code, {
        players: new Map([
          [playerId, { socketId: socket.id, name, disconnectedAt: null }],
        ]),
        currentQuestion: null,
        currentLevel: null,
        answers: new Map(),
      });
      socket.join(code);
      myRoomCode = code;
      myPlayerId = playerId;
      ack && ack({ ok: true, code, playerId });
      broadcastRoomState(code);
    } catch (err) {
      ack && ack({ ok: false, error: err.message });
    }
  });

  socket.on('join_room', (payload, ack) => {
    const code = ((payload && payload.code) || '').toUpperCase().trim();
    const name = (payload && payload.name) || 'Player';
    const playerId =
      (payload && payload.playerId) || crypto.randomBytes(8).toString('hex');
    const room = rooms.get(code);
    if (!room) {
      return ack && ack({ ok: false, error: 'Room not found' });
    }

    // Reconnect: same playerId already in room
    if (room.players.has(playerId)) {
      const p = room.players.get(playerId);
      p.socketId = socket.id;
      p.disconnectedAt = null;
      if (name) p.name = name;
      socket.join(code);
      myRoomCode = code;
      myPlayerId = playerId;
      ack && ack({ ok: true, code, playerId, reconnected: true });
      // Notify others the player is back
      io.to(code).emit('player_reconnected', { playerId, name: p.name });
      broadcastRoomState(code);
      // Resend current question + answer status, OR tell client to reset to level picker
      if (room.currentQuestion) {
        socket.emit('question', {
          level: room.currentLevel,
          question: room.currentQuestion,
        });
        socket.emit('answer_status', {
          submitted: Array.from(room.answers.keys()),
          total: room.players.size,
        });
        if (
          room.answers.size === room.players.size &&
          room.players.size === 2
        ) {
          const reveal = Array.from(room.players.entries()).map(([id, p2]) => ({
            id,
            name: p2.name,
            answer: room.answers.get(id) || '',
          }));
          socket.emit('reveal', {
            question: room.currentQuestion,
            level: room.currentLevel,
            answers: reveal,
          });
        }
      } else {
        // No active question — partner may have hit Next Question while we were away
        socket.emit('next_round');
      }
      return;
    }

    // New joiner
    if (room.players.size >= 2) {
      return ack && ack({ ok: false, error: 'Room is full' });
    }
    room.players.set(playerId, {
      socketId: socket.id,
      name,
      disconnectedAt: null,
    });
    socket.join(code);
    myRoomCode = code;
    myPlayerId = playerId;
    ack && ack({ ok: true, code, playerId });
    broadcastRoomState(code);
    if (room.currentQuestion) {
      socket.emit('question', {
        level: room.currentLevel,
        question: room.currentQuestion,
      });
    }
  });

  socket.on('pick_level', (payload) => {
    if (!myRoomCode) return;
    const room = rooms.get(myRoomCode);
    if (!room) return;
    if (room.players.size < 2) return;
    const level = Number(payload && payload.level);
    if (!Number.isInteger(level) || level < 1 || level > 10) return;
    const q = pickRandomQuestion(level);
    if (!q) return;
    room.currentLevel = level;
    room.currentQuestion = q;
    room.answers = new Map();
    io.to(myRoomCode).emit('question', { level, question: q });
  });

  socket.on('submit_answer', (payload) => {
    if (!myRoomCode || !myPlayerId) return;
    const room = rooms.get(myRoomCode);
    if (!room || !room.currentQuestion) return;
    const text = String((payload && payload.text) || '').slice(0, 2000);
    room.answers.set(myPlayerId, text);

    io.to(myRoomCode).emit('answer_status', {
      submitted: Array.from(room.answers.keys()),
      total: room.players.size,
    });

    tryFinalizeReveal(myRoomCode);
  });

  socket.on('next_question', () => {
    if (!myRoomCode) return;
    const room = rooms.get(myRoomCode);
    if (!room) return;
    room.currentQuestion = null;
    room.currentLevel = null;
    room.answers = new Map();
    io.to(myRoomCode).emit('next_round');
  });

  socket.on('leave_room', () => {
    if (!myRoomCode || !myPlayerId) return;
    const code = myRoomCode;
    const playerId = myPlayerId;
    const room = rooms.get(code);
    myRoomCode = null;
    myPlayerId = null;
    if (!room) return;
    room.players.delete(playerId);
    room.answers.delete(playerId);
    socket.leave(code);
    if (room.players.size === 0) {
      rooms.delete(code);
      return;
    }
    // If everyone else is also disconnected, no point keeping the room.
    const anyConnected = Array.from(room.players.values()).some(
      (p) => !p.disconnectedAt
    );
    if (!anyConnected) {
      rooms.delete(code);
      return;
    }
    io.to(code).emit('player_left', { playerId });
    broadcastRoomState(code);
  });

  socket.on('disconnect', () => {
    if (!myRoomCode || !myPlayerId) return;
    const code = myRoomCode;
    const playerId = myPlayerId;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(playerId);
    if (!p) return;
    p.socketId = null;
    p.disconnectedAt = Date.now();

    // Tell partner this player is away. Room stays alive — they can rejoin with the same code.
    io.to(code).emit('player_disconnecting', {
      playerId,
      name: p.name,
    });
  });
});

// Background sweep: drop rooms where every player has been disconnected for >24h.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const players = Array.from(room.players.values());
    if (players.length === 0) {
      rooms.delete(code);
      continue;
    }
    const allDisconnected = players.every((p) => p.disconnectedAt);
    if (!allDisconnected) continue;
    const lastSeen = Math.max(...players.map((p) => p.disconnectedAt));
    if (now - lastSeen > ROOM_INACTIVE_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 60 * 60 * 1000); // every hour

server.listen(PORT, () => {
  console.log(`Reveal running on http://localhost:${PORT}`);
});
