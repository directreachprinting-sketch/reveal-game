const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

// roomCode -> { players: Map(socketId -> {name}), currentQuestion, currentLevel, answers: Map(socketId -> text) }
const rooms = new Map();

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
  }));
  io.to(code).emit('room_state', {
    code,
    players: playerList,
  });
}

io.on('connection', (socket) => {
  let joinedCode = null;

  socket.on('create_room', (payload, ack) => {
    try {
      const name = (payload && payload.name) || 'Player 1';
      const code = generateRoomCode();
      rooms.set(code, {
        players: new Map([[socket.id, { name }]]),
        currentQuestion: null,
        currentLevel: null,
        answers: new Map(),
      });
      socket.join(code);
      joinedCode = code;
      ack && ack({ ok: true, code });
      broadcastRoomState(code);
    } catch (err) {
      ack && ack({ ok: false, error: err.message });
    }
  });

  socket.on('join_room', (payload, ack) => {
    const code = (payload && payload.code || '').toUpperCase().trim();
    const name = (payload && payload.name) || 'Player 2';
    const room = rooms.get(code);
    if (!room) {
      return ack && ack({ ok: false, error: 'Room not found' });
    }
    if (room.players.size >= 2) {
      return ack && ack({ ok: false, error: 'Room is full' });
    }
    room.players.set(socket.id, { name });
    socket.join(code);
    joinedCode = code;
    ack && ack({ ok: true, code });
    broadcastRoomState(code);

    // If a question is already active, send it to the joiner too
    if (room.currentQuestion) {
      socket.emit('question', {
        level: room.currentLevel,
        question: room.currentQuestion,
      });
    }
  });

  socket.on('pick_level', (payload) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    if (room.players.size < 2) return; // need both players
    const level = Number(payload && payload.level);
    if (!Number.isInteger(level) || level < 1 || level > 10) return;
    const q = pickRandomQuestion(level);
    if (!q) return;
    room.currentLevel = level;
    room.currentQuestion = q;
    room.answers = new Map();
    io.to(joinedCode).emit('question', { level, question: q });
  });

  socket.on('submit_answer', (payload) => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room || !room.currentQuestion) return;
    const text = String((payload && payload.text) || '').slice(0, 2000);
    room.answers.set(socket.id, text);

    // Notify the other player that this one has submitted
    const submittedIds = Array.from(room.answers.keys());
    io.to(joinedCode).emit('answer_status', {
      submitted: submittedIds,
      total: room.players.size,
    });

    if (room.answers.size === room.players.size && room.players.size === 2) {
      const reveal = Array.from(room.players.entries()).map(([id, p]) => ({
        id,
        name: p.name,
        answer: room.answers.get(id) || '',
      }));
      io.to(joinedCode).emit('reveal', {
        question: room.currentQuestion,
        level: room.currentLevel,
        answers: reveal,
      });
    }
  });

  socket.on('next_question', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.currentQuestion = null;
    room.currentLevel = null;
    room.answers = new Map();
    io.to(joinedCode).emit('next_round');
  });

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    room.players.delete(socket.id);
    room.answers.delete(socket.id);
    if (room.players.size === 0) {
      rooms.delete(joinedCode);
    } else {
      io.to(joinedCode).emit('player_left');
      broadcastRoomState(joinedCode);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Reveal running on http://localhost:${PORT}`);
});
