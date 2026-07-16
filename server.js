const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/phone', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'phone.html'));
});

app.get('/phone.html', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'phone.html'));
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const QUESTION_BANK = [
    'Если бы я мог изменить одно правило в мире, это было бы',
    'Самая странная вещь, которую я ел, это',
    'Моя суперсила в офисе это',
    'Если бы я был животным, я был бы',
    'Что я делаю, когда никто не видит',
    'Мой самый неловкий момент в школе',
    'Идеальный подарок для меня это',
    'Если бы я выиграл в лотерею, я бы сначала',
    'Моё любимое оправдание это',
    'Я знаю, что это плохая идея, но я всё равно',
    'Лучший способ начать утро это',
    'Если бы у меня была машина времени, я бы отправился в',
    'Самый важный урок, который я усвоил',
    'Меня бесит, когда люди',
    'В следующей жизни я хочу быть',
    'Мой секретный талант',
    'Если бы я был президентом, первым делом я бы',
    'Что мне нужно, чтобы быть счастливым',
    'Самая переоценённая вещь в мире это',
    'Я никогда не признаюсь, но',
    'О чём я думаю перед сном',
    'Кого я позвал бы на ужин, если бы мог',
    'Моя самая большая глупость в детстве',
    'Что я всегда беру с собой в путешествие',
    'Мой идеальный выходной выглядит так',
    'Если бы я был книгой, я назывался бы',
    'Самое странное изобретение это',
    'Я бы хотел научиться',
    'Мой девиз по жизни',
    'Когда я злюсь, я обычно'
];

let gameState = {
    players: [],
    phase: 'lobby',
    currentRound: 1,
    pairs: [],
    currentPairIndex: 0,
    timer: 0,
    timerInterval: null,
    gameStarted: false,
    resultsPhase: false,
    answeredPlayers: new Set(),
};

let hostId = null;
const activeSockets = new Set();

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function getRandomId() {
    return Math.random().toString(36).substr(2, 8);
}

function getCurrentPair() {
    if (gameState.currentPairIndex < gameState.pairs.length) {
        return gameState.pairs[gameState.currentPairIndex];
    }
    return null;
}

function broadcastState() {
    const currentPair = getCurrentPair();
    const publicState = {
        phase: gameState.phase,
        players: gameState.players.map(p => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost,
            score: p.score
        })),
        currentRound: gameState.currentRound,
        pairs: gameState.pairs.map(p => ({
            pairId: p.pairId,
            player1Id: p.player1Id,
            player2Id: p.player2Id,
            question: p.question,
            answers: p.answers || []
        })),
        currentPairIndex: gameState.currentPairIndex,
        currentPair: currentPair ? {
            pairId: currentPair.pairId,
            question: currentPair.question,
            answers: currentPair.answers || []
        } : null,
        timer: gameState.timer,
        totalPlayers: gameState.players.length,
        gameStarted: gameState.gameStarted,
        resultsPhase: gameState.resultsPhase,
        answeredCount: gameState.answeredPlayers.size,
        totalPairs: gameState.pairs.length,
        hostId: hostId,
    };
    io.emit('stateUpdate', publicState);
}

function startTimer(seconds, onEnd) {
    if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
    }
    gameState.timer = seconds;
    broadcastState();

    gameState.timerInterval = setInterval(() => {
        gameState.timer -= 0.5;
        if (gameState.timer <= 0) {
            gameState.timer = 0;
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            broadcastState();
            if (onEnd) onEnd();
        } else {
            broadcastState();
        }
    }, 500);
}

function createPairs() {
    const players = shuffle([...gameState.players]);
    const pairs = [];

    const numPairs = Math.floor(players.length / 2);
    const totalPairs = Math.max(1, numPairs);

    const questions = [];
    const startIdx = (gameState.currentRound - 1) * 10;
    for (let i = 0; i < Math.min(totalPairs, 10); i++) {
        const idx = startIdx + i;
        if (gameState.questions[idx]) {
            questions.push(gameState.questions[idx]);
        } else {
            questions.push(QUESTION_BANK[i % QUESTION_BANK.length]);
        }
    }

    for (let i = 0; i < totalPairs; i++) {
        const p1Idx = i * 2;
        const p2Idx = i * 2 + 1;

        if (p2Idx < players.length) {
            pairs.push({
                pairId: 'pair-' + getRandomId(),
                player1Id: players[p1Idx].id,
                player2Id: players[p2Idx].id,
                question: questions[i % questions.length] || 'Вопрос',
                answers: [],
                voted: false,
                winnerId: null,
            });
        } else {
            pairs.push({
                pairId: 'pair-' + getRandomId(),
                player1Id: players[p1Idx].id,
                player2Id: 'bot-' + getRandomId(),
                question: questions[i % questions.length] || 'Вопрос',
                answers: [],
                voted: false,
                winnerId: null,
            });
        }
    }

    if (pairs.length === 0) {
        pairs.push({
            pairId: 'pair-' + getRandomId(),
            player1Id: 'bot-test1',
            player2Id: 'bot-test2',
            question: QUESTION_BANK[0],
            answers: [],
            voted: false,
            winnerId: null,
        });
    }

    return pairs;
}

function startAnswering() {
    gameState.phase = 'answering';
    gameState.resultsPhase = false;
    gameState.answeredPlayers = new Set();
    gameState.pairs = createPairs();
    gameState.currentPairIndex = 0;
    gameState.players.forEach(p => p.voted = false);
    broadcastState();

    startTimer(90, () => {
        gameState.phase = 'pair_voting';
        gameState.currentPairIndex = 0;
        broadcastState();
        startPairVoting();
    });
}

function startPairVoting() {
    const pair = getCurrentPair();
    if (!pair) {
        finishRound();
        return;
    }

    if (!pair.answers || pair.answers.length < 2) {
        while (pair.answers.length < 2) {
            pair.answers.push({
                playerId: 'bot-' + getRandomId(),
                playerName: 'Участник ' + (pair.answers.length + 1),
                answer: 'Ответ не получен',
                votes: 0,
            });
        }
    }

    gameState.phase = 'pair_voting';
    gameState.resultsPhase = false;
    gameState.players.forEach(p => p.voted = false);
    broadcastState();

    startTimer(30, () => {
        finishPairVoting();
    });
}

function finishPairVoting() {
    const pair = getCurrentPair();
    if (!pair) {
        finishRound();
        return;
    }

    gameState.phase = 'pair_results';
    gameState.resultsPhase = true;

    let maxVotes = -1;
    let winner = null;
    pair.answers.forEach(ans => {
        if (ans.votes > maxVotes) {
            maxVotes = ans.votes;
            winner = ans;
        }
    });

    if (winner && maxVotes > 0 && !winner.playerId.startsWith('bot-')) {
        const player = gameState.players.find(p => p.id === winner.playerId);
        if (player) {
            player.score = (player.score || 0) + 1;
        }
        pair.winnerId = winner.playerId;
    }

    broadcastState();

    setTimeout(() => {
        gameState.resultsPhase = false;
        gameState.currentPairIndex++;

        if (gameState.currentPairIndex >= gameState.pairs.length) {
            finishRound();
        } else {
            startPairVoting();
        }
    }, 3000);
}

function finishRound() {
    gameState.currentRound++;
    gameState.currentPairIndex = 0;

    if (gameState.currentRound > 3) {
        gameState.phase = 'leader';
        broadcastState();
        return;
    }

    setTimeout(() => {
        startAnswering();
    }, 3000);
}

function startGame() {
    if (gameState.gameStarted) return;
    if (gameState.players.length < 4) return;

    gameState.gameStarted = true;
    gameState.questions = shuffle([...QUESTION_BANK]);
    gameState.currentRound = 1;
    gameState.players.forEach(p => {
        p.score = 0;
        p.voted = false;
    });

    startAnswering();
}

function cleanupDeadPlayers() {
    const alivePlayers = gameState.players.filter(p => {
        if (p.id.startsWith('bot-')) return true;
        return activeSockets.has(p.id);
    });

    if (alivePlayers.length !== gameState.players.length) {
        gameState.players = alivePlayers;
        if (hostId && !gameState.players.some(p => p.id === hostId)) {
            hostId = gameState.players.length > 0 ? gameState.players[0].id : null;
            if (hostId) {
                const newHost = gameState.players.find(p => p.id === hostId);
                if (newHost) newHost.isHost = true;
            }
        }
        broadcastState();
    }
}

setInterval(cleanupDeadPlayers, 5000);

// --- Socket.io ---
io.on('connection', (socket) => {
    console.log('Пользователь подключен:', socket.id);
    activeSockets.add(socket.id);

    socket.on('reconnectPlayer', ({ playerId, name }) => {
        console.log(`Попытка переподключения игрока ${name} (${playerId})`);

        const existingPlayer = gameState.players.find(p => p.id === playerId);
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            activeSockets.add(socket.id);

            const currentPair = getCurrentPair();
            const publicState = {
                phase: gameState.phase,
                players: gameState.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    isHost: p.isHost,
                    score: p.score
                })),
                currentRound: gameState.currentRound,
                pairs: gameState.pairs.map(p => ({
                    pairId: p.pairId,
                    player1Id: p.player1Id,
                    player2Id: p.player2Id,
                    question: p.question,
                    answers: p.answers || []
                })),
                currentPairIndex: gameState.currentPairIndex,
                currentPair: currentPair ? {
                    pairId: currentPair.pairId,
                    question: currentPair.question,
                    answers: currentPair.answers || []
                } : null,
                timer: gameState.timer,
                myId: socket.id,
                isHost: existingPlayer.isHost,
                totalPlayers: gameState.players.length,
                gameStarted: gameState.gameStarted,
                resultsPhase: gameState.resultsPhase,
                answeredCount: gameState.answeredPlayers.size,
                totalPairs: gameState.pairs.length,
                hostId: hostId,
            };
            socket.emit('initState', publicState);
            broadcastState();

            console.log(`Игрок ${existingPlayer.name} переподключён`);
            return;
        }

        socket.emit('error', 'Игрок не найден, создайте нового');
    });

    socket.on('joinGame', ({ name }) => {
        const existing = gameState.players.find(p => p.name === name && p.id !== socket.id);
        if (existing) {
            socket.emit('error', 'Имя уже занято');
            return;
        }

        const reconnecting = gameState.players.find(p => p.id === socket.id);
        if (reconnecting) {
            reconnecting.name = name;
            const currentPair = getCurrentPair();
            const publicState = {
                phase: gameState.phase,
                players: gameState.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    isHost: p.isHost,
                    score: p.score
                })),
                currentRound: gameState.currentRound,
                pairs: gameState.pairs.map(p => ({
                    pairId: p.pairId,
                    player1Id: p.player1Id,
                    player2Id: p.player2Id,
                    question: p.question,
                    answers: p.answers || []
                })),
                currentPairIndex: gameState.currentPairIndex,
                currentPair: currentPair ? {
                    pairId: currentPair.pairId,
                    question: currentPair.question,
                    answers: currentPair.answers || []
                } : null,
                timer: gameState.timer,
                myId: socket.id,
                isHost: reconnecting.isHost,
                totalPlayers: gameState.players.length,
                gameStarted: gameState.gameStarted,
                resultsPhase: gameState.resultsPhase,
                answeredCount: gameState.answeredPlayers.size,
                totalPairs: gameState.pairs.length,
                hostId: hostId,
            };
            socket.emit('initState', publicState);
            broadcastState();
            return;
        }

        if (!hostId) {
            hostId = socket.id;
        }

        const player = {
            id: socket.id,
            name: name || 'Игрок ' + getRandomId().substr(0, 4),
            isHost: socket.id === hostId,
            score: 0,
            voted: false,
        };

        if (hostId && hostId !== socket.id) {
            player.isHost = false;
        }

        gameState.players.push(player);
        socket.join('game');

        const currentPair = getCurrentPair();
        const publicState = {
            phase: gameState.phase,
            players: gameState.players.map(p => ({
                id: p.id,
                name: p.name,
                isHost: p.isHost,
                score: p.score
            })),
            currentRound: gameState.currentRound,
            pairs: gameState.pairs.map(p => ({
                pairId: p.pairId,
                player1Id: p.player1Id,
                player2Id: p.player2Id,
                question: p.question,
                answers: p.answers || []
            })),
            currentPairIndex: gameState.currentPairIndex,
            currentPair: currentPair ? {
                pairId: currentPair.pairId,
                question: currentPair.question,
                answers: currentPair.answers || []
            } : null,
            timer: gameState.timer,
            myId: socket.id,
            isHost: player.isHost,
            totalPlayers: gameState.players.length,
            gameStarted: gameState.gameStarted,
            resultsPhase: gameState.resultsPhase,
            answeredCount: gameState.answeredPlayers.size,
            totalPairs: gameState.pairs.length,
            hostId: hostId,
        };
        socket.emit('initState', publicState);
        broadcastState();

        console.log(`Игрок ${player.name} присоединился. Всего: ${gameState.players.length}`);
    });

    socket.on('startGame', () => {
        const player = gameState.players.find(p => p.id === socket.id);
        if (!player || !player.isHost) {
            socket.emit('error', 'Только хост может начать игру');
            return;
        }

        if (gameState.gameStarted) {
            socket.emit('error', 'Игра уже начата');
            return;
        }

        if (gameState.players.length < 4) {
            socket.emit('error', 'Нужно минимум 4 игрока');
            return;
        }

        startGame();
    });

    socket.on('submitAnswer', ({ answer }) => {
        if (gameState.phase !== 'answering') {
            socket.emit('error', 'Сейчас нельзя отвечать');
            return;
        }

        const player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        if (gameState.answeredPlayers.has(socket.id)) {
            socket.emit('error', 'Вы уже ответили в этом раунде');
            return;
        }

        const pair = gameState.pairs.find(p =>
            p.player1Id === socket.id || p.player2Id === socket.id
        );

        if (!pair) {
            socket.emit('error', 'Вы не в паре');
            return;
        }

        pair.answers.push({
            playerId: socket.id,
            playerName: player.name,
            answer: answer,
            votes: 0,
        });

        gameState.answeredPlayers.add(socket.id);

        broadcastState();
        socket.emit('answerReceived', { success: true });
    });

    socket.on('vote', ({ answerIndex }) => {
        if (gameState.phase !== 'pair_voting') {
            socket.emit('error', 'Сейчас нельзя голосовать');
            return;
        }

        const player = gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        if (player.voted) {
            socket.emit('error', 'Вы уже проголосовали');
            return;
        }

        const pair = getCurrentPair();
        if (!pair) {
            socket.emit('error', 'Нет активной пары');
            return;
        }

        const answer = pair.answers[answerIndex];
        if (!answer) {
            socket.emit('error', 'Ответ не найден');
            return;
        }

        if (answer.playerId === socket.id) {
            socket.emit('error', 'Нельзя голосовать за свой ответ');
            return;
        }

        answer.votes = (answer.votes || 0) + 1;
        player.voted = true;
        broadcastState();
        socket.emit('voteReceived', { success: true });
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключен:', socket.id);
        activeSockets.delete(socket.id);

        setTimeout(() => {
            cleanupDeadPlayers();
        }, 3000);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});