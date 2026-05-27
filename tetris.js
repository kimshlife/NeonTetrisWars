const
    ROWS = 20,
    COLS = 10,
    BLOCK_SIZE = 30;

const BLOCK_COLORS = {
    standard: [
        null,
        '#9900FF', // T: Purple
        '#00FFFF', // I: Cyan
        '#0000FF', // J: Blue
        '#FFA500', // L: Orange
        '#FFFF00', // O: Yellow
        '#00FF00', // S: Green
        '#FF0000', // Z: Red
        '#555555'  // 8: Garbage
    ],
    dark: [
        null, '#9900FF', '#00FFFF', '#0000FF', '#FFA500', '#FFFF00', '#00FF00', '#FF0000', '#555555'
    ],
    light: [
        null,
        '#5e2a84', // T: Deep Purple
        '#007a7a', // I: Deep Teal
        '#00008b', // J: Dark Blue
        '#cc5500', // L: Burnt Orange
        '#aaaa00', // O: Dark Yellow
        '#006400', // S: Dark Green
        '#8b0000', // Z: Dark Red
        '#888888'  // Garbage
    ],
    pastel: [
        null,
        '#cbaacb', // T: Pastel Purple
        '#abdee6', // I: Pastel Cyan
        '#97c1a9', // J: Pastel Blue/Green
        '#f3b0c3', // L: Pastel Pink
        '#ffffb5', // O: Pastel Yellow
        '#cce2cb', // S: Pastel Green
        '#ff968a', // Z: Pastel Red
        '#d0d0d0'  // Garbage
    ]
};

function getColors() {
    let style = document.getElementById('sel-blockStyle').value;
    if (style === 'standard') return BLOCK_COLORS.standard;
    let theme = document.getElementById('sel-theme').value;
    return BLOCK_COLORS[theme] || BLOCK_COLORS.standard;
}

let sharedPieceSequence = [];
let currentMode = 'single';
let socket = null;
let networkSeed = 1;
let isSpectator = false;
let isJoinForSpectate = false;
let roomMode = '1v1';       // '1v1' | 'battle'
let roomRule = 'normal';    // 'normal' | 'suddendeath' | 'gravity'
let mySocketId = null;
let opponentRenderers = {}; // { socketId: MiniBoardRenderer }

const workerCode = `
    let intervalIds = {};
    self.onmessage = function(e) {
        let msg = e.data;
        if (msg.cmd === 'start') {
            if (intervalIds[msg.id]) clearInterval(intervalIds[msg.id]);
            intervalIds[msg.id] = setInterval(() => { self.postMessage({ id: msg.id, type: 'tick' }); }, 16);
        } else if (msg.cmd === 'stop') {
            if (intervalIds[msg.id]) {
                clearInterval(intervalIds[msg.id]);
                delete intervalIds[msg.id];
            }
        }
    };
`;
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);

function seededRandom() {
    let t = networkSeed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

function getSharedPieceType(index) {
    while (sharedPieceSequence.length <= index) {
        let bag = ['T', 'I', 'J', 'L', 'O', 'S', 'Z'];
        for (let i = bag.length - 1; i > 0; i--) {
            const randomFunc = (currentMode === 'network') ? seededRandom : Math.random;
            const j = Math.floor(randomFunc() * (i + 1));
            [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        sharedPieceSequence.push(...bag);
    }
    return sharedPieceSequence[index];
}

class TetrisGame {
    constructor(element) {
        this.element = element;
        this.canvas = element.querySelector('.tetris');
        this.context = this.canvas.getContext('2d');
        this.nextCanvas = element.querySelector('.next-piece');
        this.nextContext = this.nextCanvas.getContext('2d');
        this.holdCanvas = element.querySelector('.hold-piece');
        this.holdContext = this.holdCanvas.getContext('2d');

        this.scoreElement = element.querySelector('.score');
        this.levelElement = element.querySelector('.level');
        this.garbageMeterElement = element.querySelector('.garbage-meter');
        this.gameOverScreen = element.querySelector('.game-over');
        this.actionPopup = element.querySelector('.action-text');
        this.comboPopup = element.querySelector('.combo-text');
        this.tetrisPopup = element.querySelector('.tetris-text');

        this.context.scale(BLOCK_SIZE, BLOCK_SIZE);
        this.nextContext.scale(BLOCK_SIZE, BLOCK_SIZE);
        this.holdContext.scale(BLOCK_SIZE, BLOCK_SIZE);

        this.arena = this.createMatrix(COLS, ROWS);
        this.player = {
            pos: { x: 0, y: 0 },
            matrix: null,
            next: null,
            hold: null,
            hasHeld: false,
            score: 0,
            level: 1,
            lines: 0
        };

        this.b2bActive = false;
        this.gameId = 'game_' + Math.random().toString(36).substr(2, 9);
        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (e) => {
            if (e.data.id === this.gameId && e.data.type === 'tick') {
                this._loop();
            }
        };

        this.dropCounter = 0;
        this.dropInterval = 1000;
        this.lastTime = performance.now();
        this.isGameOver = false;
        this.isPlaying = false;
        this.paused = false;

        this.lockDelayTimer = 0;
        this.lockDelay = 800;
        this.lockResets = 0;

        this.keys = { left: false, right: false, down: false };
        this.keyTimer = { left: 0, right: 0, down: 0 };
        this.dasDelay = 130;
        this.arrDelay = 20;

        this.combo = 0;
        this.pendingGarbage = 0;
        this.lastActionWasRotate = false;

        this.bag = [];
        this.pieceIndex = 0;

        this.opponent = null;
        this.onGameOver = null;
    }

    createMatrix(w, h) {
        const matrix = [];
        while (h--) matrix.push(new Array(w).fill(0));
        return matrix;
    }

    createPiece(type) {
        if (type === 'T') return [[0, 1, 0], [1, 1, 1], [0, 0, 0]];
        if (type === 'I') return [[0, 0, 0, 0], [2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0]];
        if (type === 'J') return [[3, 0, 0], [3, 3, 3], [0, 0, 0]];
        if (type === 'L') return [[0, 0, 4], [4, 4, 4], [0, 0, 0]];
        if (type === 'O') return [[5, 5], [5, 5]];
        if (type === 'S') return [[0, 6, 6], [6, 6, 0], [0, 0, 0]];
        if (type === 'Z') return [[7, 7, 0], [0, 7, 7], [0, 0, 0]];
    }

    getNextPieceType() {
        if (currentMode === 'versus' || currentMode === 'network') {
            return getSharedPieceType(this.pieceIndex++);
        }
        if (this.bag.length === 0) {
            this.bag = ['T', 'I', 'J', 'L', 'O', 'S', 'Z'];
            for (let i = this.bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
            }
        }
        return this.bag.pop();
    }

    drawBlock(ctx, x, y, value, isGhost = false, lockProgress = 0) {
        let colors = getColors();
        let targetColor = colors[value];

        if (isGhost) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.fillRect(x, y, 1, 1);
            ctx.strokeStyle = targetColor;
            ctx.lineWidth = 0.05;
            ctx.strokeRect(x, y, 1, 1);
            return;
        }

        ctx.fillStyle = targetColor;
        ctx.fillRect(x, y, 1, 1);

        if (lockProgress > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, 0.5)`;
            ctx.fillRect(x, y + (1 - lockProgress), 1, lockProgress);
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fillRect(x, y, 1, 0.2);
        ctx.fillRect(x, y, 0.2, 1);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(x + 0.8, y, 0.2, 1);
        ctx.fillRect(x, y + 0.8, 1, 0.2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 0.05;
        ctx.strokeRect(x, y, 1, 1);
    }

    drawMatrix(matrix, offset, ctx = this.context, isGhost = false, lockProgress = 0) {
        matrix.forEach((row, y) => {
            row.forEach((value, x) => {
                if (value !== 0) {
                    this.drawBlock(ctx, x + offset.x, y + offset.y, value, isGhost, lockProgress);
                }
            });
        });
    }

    drawGhost() {
        if (!this.player.matrix) return;
        const ghost = { matrix: this.player.matrix, pos: { x: this.player.pos.x, y: this.player.pos.y } };
        while (!this.collide(ghost)) { ghost.pos.y++; }
        ghost.pos.y--;
        if (ghost.pos.y > this.player.pos.y) {
            this.drawMatrix(ghost.matrix, ghost.pos, this.context, true);
        }
    }

    draw() {
        // Clear canvas manually to allow CSS background
        this.context.clearRect(0, 0, this.canvas.width / BLOCK_SIZE, this.canvas.height / BLOCK_SIZE);

        let gridColor = getComputedStyle(document.documentElement).getPropertyValue('--grid-border').trim();
        if (!gridColor) gridColor = 'rgba(255, 255, 255, 0.1)';

        this.context.strokeStyle = gridColor;
        this.context.lineWidth = 0.05;
        for (let i = 0; i <= COLS; i++) { this.context.beginPath(); this.context.moveTo(i, 0); this.context.lineTo(i, ROWS); this.context.stroke(); }
        for (let i = 0; i <= ROWS; i++) { this.context.beginPath(); this.context.moveTo(0, i); this.context.lineTo(COLS, i); this.context.stroke(); }

        this.drawMatrix(this.arena, { x: 0, y: 0 });

        if (this.player.matrix) {
            this.drawGhost();

            let progress = 0;
            if (this.lockDelayTimer > 0) {
                progress = Math.min(1, this.lockDelayTimer / this.lockDelay);
            }

            this.drawMatrix(this.player.matrix, this.player.pos, this.context, false, progress);
        }

        this.drawNextPiece();
        this.drawHoldPiece();
    }

    drawNextPiece() {
        this.nextContext.clearRect(0, 0, this.nextCanvas.width / BLOCK_SIZE, this.nextCanvas.height / BLOCK_SIZE);
        if (this.player.nextPieces) {
            this.player.nextPieces.forEach((piece, index) => {
                let offset;
                if (piece.length === 4) offset = { x: 0, y: 0.5 + index * 4 };
                else if (piece.length === 2) offset = { x: 1, y: 1 + index * 4 };
                else offset = { x: 0.5, y: 0.5 + index * 4 };
                this.drawMatrix(piece, offset, this.nextContext);
            });
        }
    }

    drawHoldPiece() {
        this.holdContext.clearRect(0, 0, this.holdCanvas.width / BLOCK_SIZE, this.holdCanvas.height / BLOCK_SIZE);
        if (this.player.hold) {
            let offset;
            const m = this.player.hold;
            if (m.length === 4) offset = { x: 0, y: 0.5 };
            else if (m.length === 2) offset = { x: 1, y: 1 };
            else offset = { x: 0.5, y: 0.5 };

            if (this.player.hasHeld) {
                this.holdContext.globalAlpha = 0.5;
            }
            this.drawMatrix(this.player.hold, offset, this.holdContext);
            this.holdContext.globalAlpha = 1.0;
        }
    }

    collide(player) {
        const m = player.matrix;
        const o = player.pos;
        for (let y = 0; y < m.length; ++y) {
            for (let x = 0; x < m[y].length; ++x) {
                if (m[y][x] !== 0) {
                    const boardY = y + o.y;
                    const boardX = x + o.x;
                    if (boardX < 0 || boardX >= COLS) return true;
                    if (boardY >= ROWS) return true;
                    if (boardY >= 0 && this.arena[boardY][boardX] !== 0) return true;
                }
            }
        }
        return false;
    }

    merge(player) {
        player.matrix.forEach((row, y) => {
            row.forEach((value, x) => {
                if (value !== 0) {
                    const boardY = y + player.pos.y;
                    if (boardY >= 0 && boardY < ROWS) {
                        this.arena[boardY][x + player.pos.x] = value;
                    }
                }
            });
        });
    }

    checkTSpin() {
        if (this.player.pieceType !== 'T' || !this.lastActionWasRotate) return { isTSpin: false };

        let blocks = 0;
        const allCorners = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
        const frontCornerIndices = [[0, 1], [1, 2], [2, 3], [3, 0]][this.player.rotState || 0];
        let frontBlocks = 0;

        allCorners.forEach((c, index) => {
            let cx = this.player.pos.x + c.x;
            let cy = this.player.pos.y + c.y;
            if (cx < 0 || cx >= COLS || cy >= ROWS || (cy >= 0 && this.arena[cy][cx] !== 0)) {
                blocks++;
                if (frontCornerIndices.includes(index)) frontBlocks++;
            }
        });

        if (blocks >= 3) {
            if (frontBlocks === 2 || this.lastKickIndex === 4) return { isTSpin: true, isMini: false };
            else return { isTSpin: true, isMini: true };
        }
        return { isTSpin: false };
    }

    showPopup(element, text, color = null) {
        element.innerText = text;
        if (color) {
            element.style.color = color;
            element.style.textShadow = `0 0 10px ${color}, 0 0 20px ${color}`;
        } else {
            element.style.color = '';
            element.style.textShadow = '';
        }
        element.classList.remove('hidden', 'active');
        void element.offsetWidth; // trigger reflow
        element.classList.add('active');
    }

    applyGarbage() {
        if (this.pendingGarbage > 0) {
            for (let i = 0; i < this.pendingGarbage; i++) {
                this.arena.shift();
                let hole = Math.floor(Math.random() * COLS);
                let row = new Array(COLS).fill(8);
                row[hole] = 0;
                this.arena.push(row);
            }
            this.pendingGarbage = 0;
            if (this.garbageMeterElement) this.garbageMeterElement.innerText = "0";
        }
    }

    lockPiece() {
        let tSpinInfo = this.checkTSpin();
        let tSpin = tSpinInfo.isTSpin;
        let miniTSpin = tSpinInfo.isMini;
        this.merge(this.player);

        let rowCount = 1;
        let linesCleared = 0;

        outer: for (let y = this.arena.length - 1; y > 0; --y) {
            for (let x = 0; x < this.arena[y].length; ++x) {
                if (this.arena[y][x] === 0) continue outer;
            }
            const row = this.arena.splice(y, 1)[0].fill(0);
            this.arena.unshift(row);
            ++y;
            linesCleared++;
            this.player.score += rowCount * 100;
            rowCount *= 2;
        }

        let sentLines = 0;
        let actionMsg = "";
        let actionColor = "";

        let isPerfectClear = false;
        if (linesCleared > 0) {
            let blocksLeft = 0;
            for (let y = 0; y < ROWS; y++) {
                for (let x = 0; x < COLS; x++) {
                    if (this.arena[y][x] !== 0) blocksLeft++;
                }
            }
            if (blocksLeft === 0) isPerfectClear = true;
        }

        let isB2BClear = false;
        if (linesCleared > 0 || tSpin) {
            if (tSpin) {
                isB2BClear = true;
                if (miniTSpin) {
                    if (linesCleared === 0) { actionMsg = "MINI T-SPIN"; actionColor = "#9900FF"; }
                    else if (linesCleared === 1) { actionMsg = "MINI T-SPIN SINGLE"; actionColor = "#9900FF"; sentLines += 1; }
                    else if (linesCleared === 2) { actionMsg = "MINI T-SPIN DOUBLE"; actionColor = "#9900FF"; sentLines += 2; }
                } else {
                    if (linesCleared === 0) { actionMsg = "T-SPIN"; actionColor = "#9900FF"; }
                    else if (linesCleared === 1) { actionMsg = "T-SPIN SINGLE"; actionColor = "#9900FF"; sentLines += 2; }
                    else if (linesCleared === 2) { actionMsg = "T-SPIN DOUBLE"; actionColor = "#9900FF"; sentLines += 4; }
                    else if (linesCleared === 3) { actionMsg = "T-SPIN TRIPLE"; actionColor = "#9900FF"; sentLines += 6; }
                }
            } else {
                if (linesCleared === 4) isB2BClear = true;
                if (linesCleared === 1) { actionMsg = "SINGLE"; actionColor = "#aaaaaa"; }
                else if (linesCleared === 2) { actionMsg = "DOUBLE"; actionColor = "#0DFF72"; sentLines += 1; }
                else if (linesCleared === 3) { actionMsg = "TRIPLE"; actionColor = "#FFA500"; sentLines += 2; }
                else if (linesCleared === 4) { actionMsg = "TETRIS!"; actionColor = "#0DC2FF"; sentLines += 4; }
            }

            if (isB2BClear && linesCleared > 0) {
                if (this.b2bActive) {
                    sentLines += 1;
                    actionMsg = "B2B " + actionMsg;
                }
                this.b2bActive = true;
            } else if (linesCleared > 0) {
                this.b2bActive = false;
            }

            if (actionMsg) {
                if (linesCleared === 4 && !tSpin) {
                    this.showPopup(this.tetrisPopup, actionMsg, actionColor);
                } else {
                    this.showPopup(this.actionPopup, actionMsg, actionColor);
                }
            }
        }

        if (linesCleared > 0) {
            this.combo++;
            this.player.lines += linesCleared;
            this.player.level = Math.floor(this.player.lines / 10) + 1;
            
            if (!(currentMode === 'network' && roomRule === 'gravity')) {
                this.dropInterval = Math.max(100, 1000 - (this.player.level - 1) * 80);
            }

            if (isPerfectClear) {
                sentLines = 10;
                this.showPopup(this.tetrisPopup, "PERFECT CLEAR!", "#FFE138");
                this.player.score += 2000;
            }

            if (this.combo > 1) {
                this.showPopup(this.comboPopup, `${this.combo} COMBO`);
                sentLines += Math.floor(this.combo / 2);
            }

            if (sentLines > 0 && this.pendingGarbage > 0) {
                let cancel = Math.min(sentLines, this.pendingGarbage);
                sentLines -= cancel;
                this.pendingGarbage -= cancel;
                if (this.garbageMeterElement) this.garbageMeterElement.innerText = this.pendingGarbage.toString();
            }

            if (sentLines > 0) {
                if (currentMode === 'network' && this === game1) {
                    if (socket) socket.emit('sendGarbage', sentLines);
                    // 1v1 모드에서만 상대 미터 표시 (배틀은 서버가 타겟 선정)
                    if (roomMode === '1v1' && this.opponent) {
                        this.opponent.receiveGarbage(sentLines);
                    }
                } else if (this.opponent) {
                    this.opponent.receiveGarbage(sentLines);
                }
            }
        } else {
            this.combo = 0;
        }

        this.updateScore();
        this.applyGarbage();

        this.lockDelayTimer = 0;
        this.lockResets = 0;
        this.dropCounter = 0;
        this.lastActionWasRotate = false;

        this.playerReset();
    }

    receiveGarbage(lines) {
        this.pendingGarbage += lines;
        if (this.garbageMeterElement) this.garbageMeterElement.innerText = this.pendingGarbage.toString();
    }

    playerPopNext() {
        if (!this.player.nextTypes) {
            this.player.nextTypes = [this.getNextPieceType(), this.getNextPieceType(), this.getNextPieceType()];
            this.player.nextPieces = this.player.nextTypes.map(t => this.createPiece(t));
        }
        this.player.matrix = this.player.nextPieces.shift();
        this.player.pieceType = this.player.nextTypes.shift();
        
        let newType = this.getNextPieceType();
        this.player.nextTypes.push(newType);
        this.player.nextPieces.push(this.createPiece(newType));

        this.player.rotState = 0;
        let emptyRows = 0;
        for (let r = 0; r < this.player.matrix.length; r++) {
            let isEmpty = true;
            for (let c = 0; c < this.player.matrix[r].length; c++) {
                if (this.player.matrix[r][c] !== 0) {
                    isEmpty = false;
                    break;
                }
            }
            if (isEmpty) emptyRows++;
            else break;
        }
        this.player.pos.y = -emptyRows;
        this.player.pos.x = (Math.floor(COLS / 2)) - (Math.floor(this.player.matrix[0].length / 2));
    }

    playerReset() {
        this.playerPopNext();
        this.lockDelayTimer = 0;
        this.lockResets = 0;
        this.player.hasHeld = false;

        if (this.collide(this.player)) {
            this.gameOver();
        }
    }

    playerHold() {
        if (this.player.hasHeld) return;

        const currentType = this.player.pieceType;

        if (this.player.holdType) {
            this.player.matrix = this.createPiece(this.player.holdType);
            this.player.pieceType = this.player.holdType;
            this.player.hold = this.createPiece(currentType);
            this.player.holdType = currentType;
            let emptyRows = 0;
            for (let r = 0; r < this.player.matrix.length; r++) {
                let isEmpty = true;
                for (let c = 0; c < this.player.matrix[r].length; c++) {
                    if (this.player.matrix[r][c] !== 0) {
                        isEmpty = false;
                        break;
                    }
                }
                if (isEmpty) emptyRows++;
                else break;
            }
            this.player.pos.y = -emptyRows;
            this.player.pos.x = (Math.floor(COLS / 2)) - (Math.floor(this.player.matrix[0].length / 2));
        } else {
            this.player.hold = this.createPiece(currentType);
            this.player.holdType = currentType;
            this.playerPopNext();
        }

        this.player.rotState = 0;
        this.player.hasHeld = true;
        this.lockDelayTimer = 0;
        this.lockResets = 0;
        this.lastActionWasRotate = false;
        this.dropCounter = 0;

        if (this.collide(this.player)) {
            this.gameOver();
        }
    }

    playerDrop() {
        this.player.pos.y++;
        if (this.collide(this.player)) {
            this.player.pos.y--;
        } else {
            this.lockDelayTimer = 0;
            this.lockResets = 0;
            this.lastActionWasRotate = false;
        }
    }

    playerHardDrop() {
        let startY = this.player.pos.y;
        while (!this.collide(this.player)) {
            this.player.pos.y++;
        }
        this.player.pos.y--;
        if (this.player.pos.y > startY) {
            this.lastActionWasRotate = false;
        }
        this.lockPiece();
    }

    handleLockReset() {
        if (this.lockDelayTimer > 0) {
            if (this.lockResets < 15) {
                this.lockDelayTimer = 0;
                this.lockResets++;
            }
        } else {
            this.lockDelayTimer = 0;
        }
    }

    playerMove(offset) {
        this.player.pos.x += offset;
        if (this.collide(this.player)) {
            this.player.pos.x -= offset;
        } else {
            this.handleLockReset();
            this.lastActionWasRotate = false;
        }
    }

    getWallkicks(type, fromState, toState) {
        if (type === 'O') return [{ x: 0, y: 0 }];
        if (type === 'I') {
            const key = `${fromState}->${toState}`;
            const map = {
                '0->1': [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
                '1->0': [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
                '1->2': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }],
                '2->1': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
                '2->3': [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: -1, y: 0 }, { x: 2, y: -1 }, { x: -1, y: 2 }],
                '3->2': [{ x: 0, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 1 }, { x: 1, y: -2 }],
                '3->0': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: -2, y: 0 }, { x: 1, y: 2 }, { x: -2, y: -1 }],
                '0->3': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 2, y: 0 }, { x: -1, y: -2 }, { x: 2, y: 1 }]
            };
            return map[key] || [{ x: 0, y: 0 }];
        }
        const key = `${fromState}->${toState}`;
        const map = {
            '0->1': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
            '1->0': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
            '1->2': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: -2 }, { x: 1, y: -2 }],
            '2->1': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: 2 }, { x: -1, y: 2 }],
            '2->3': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
            '3->2': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
            '3->0': [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }, { x: -1, y: -2 }],
            '0->3': [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }, { x: 1, y: 2 }]
        };
        return map[key] || [{ x: 0, y: 0 }];
    }

    playerRotate(dir) {
        if (!this.player.matrix) return;
        const pos = { x: this.player.pos.x, y: this.player.pos.y };
        const fromState = this.player.rotState || 0;
        const toState = (fromState + dir + 4) % 4;

        this.rotate(this.player.matrix, dir);

        const kicks = this.getWallkicks(this.player.pieceType, fromState, toState);
        let kickSuccess = false;
        let kickIndex = 0;

        for (let i = 0; i < kicks.length; i++) {
            this.player.pos.x = pos.x + kicks[i].x;
            this.player.pos.y = pos.y + kicks[i].y;
            if (!this.collide(this.player)) {
                kickSuccess = true;
                kickIndex = i;
                break;
            }
        }

        if (!kickSuccess) {
            this.rotate(this.player.matrix, -dir);
            this.player.pos.x = pos.x;
            this.player.pos.y = pos.y;
            return;
        }

        this.player.rotState = toState;
        this.lastKickIndex = kickIndex;
        this.handleLockReset();
        this.lastActionWasRotate = true;
    }

    rotate(matrix, dir) {
        for (let y = 0; y < matrix.length; ++y) {
            for (let x = 0; x < y; ++x) {
                [matrix[x][y], matrix[y][x]] = [matrix[y][x], matrix[x][y]];
            }
        }
        if (dir > 0) matrix.forEach(row => row.reverse());
        else matrix.reverse();
    }

    handleInput(deltaTime) {
        if (this.keys.left && !this.keys.right) {
            if (this.keyTimer.left === 0) this.playerMove(-1);
            this.keyTimer.left += deltaTime;
            if (this.keyTimer.left > this.dasDelay) {
                let repeats = Math.floor((this.keyTimer.left - this.dasDelay) / this.arrDelay);
                while (repeats > 0) { this.playerMove(-1); this.keyTimer.left -= this.arrDelay; repeats--; }
            }
        } else this.keyTimer.left = 0;

        if (this.keys.right && !this.keys.left) {
            if (this.keyTimer.right === 0) this.playerMove(1);
            this.keyTimer.right += deltaTime;
            if (this.keyTimer.right > this.dasDelay) {
                let repeats = Math.floor((this.keyTimer.right - this.dasDelay) / this.arrDelay);
                while (repeats > 0) { this.playerMove(1); this.keyTimer.right -= this.arrDelay; repeats--; }
            }
        } else this.keyTimer.right = 0;

        if (this.keys.down) {
            if (this.keyTimer.down === 0) this.playerDrop();
            this.keyTimer.down += deltaTime;
            if (this.keyTimer.down > this.arrDelay) {
                let repeats = Math.floor(this.keyTimer.down / this.arrDelay);
                while (repeats > 0) { this.playerDrop(); this.keyTimer.down -= this.arrDelay; repeats--; }
            }
        } else this.keyTimer.down = 0;
    }

    update() {
        if (this.isGameOver || !this.isPlaying || this.paused) return;

        const now = performance.now();
        // 탭 최소화/백그라운드 복귀 시 deltaTime 폭주 방지
        const deltaTime = Math.min(now - this.lastTime, 500);
        this.lastTime = now;

        if (currentMode === 'network' && roomRule === 'gravity') {
            this.dropInterval = Math.max(50, this.dropInterval - deltaTime * 0.005);
        }

        this.dropCounter += deltaTime;
        if (this.dropCounter > this.dropInterval) {
            this.player.pos.y++;
            if (this.collide(this.player)) {
                this.player.pos.y--;
            } else {
                this.lockDelayTimer = 0;
                this.lockResets = 0;
                this.lastActionWasRotate = false;
            }
            this.dropCounter = 0;
        }

        this.handleInput(deltaTime);

        this.player.pos.y++;
        const isTouching = this.collide(this.player);
        this.player.pos.y--;

        if (isTouching) {
            this.lockDelayTimer += deltaTime;
            if (this.lockDelayTimer >= this.lockDelay) this.lockPiece();
        } else {
            this.lockDelayTimer = 0;
        }

        this.draw();
        
        if (currentMode === 'network' && this === game1 && socket) {
            socket.emit('boardUpdate', {
                arena: this.arena,
                player: {
                    pos: this.player.pos,
                    matrix: this.player.matrix,
                    next: this.player.nextPieces,
                    hold: this.player.hold,
                    hasHeld: this.player.hasHeld,
                    score: this.player.score,
                    level: this.player.level,
                    lines: this.player.lines
                },
                pendingGarbage: this.pendingGarbage
            });
        }
    }

    pause() {
        this.paused = true;
        this.worker.postMessage({ cmd: 'stop', id: this.gameId });
    }

    resume() {
        if (this.isGameOver || !this.isPlaying || !this.paused) return;
        this.paused = false;
        this.lastTime = performance.now();
        this._startLoop();
    }

    updateScore() {
        this.scoreElement.innerText = this.player.score;
        this.levelElement.innerText = this.player.level;
    }

    gameOver() {
        this.isGameOver = true;
        this.isPlaying = false;
        this.worker.postMessage({ cmd: 'stop', id: this.gameId });
        this.draw();
        this.gameOverScreen.classList.remove('hidden');
        if (this.onGameOver) this.onGameOver(this);
        if (currentMode === 'network' && this === game1 && socket) {
            socket.emit('gameOver');
        }
    }

    startGame() {
        this.bag = [];
        this.pieceIndex = 0;
        this.arena.forEach(row => row.fill(0));
        this.player.score = 0;
        this.player.level = 1;
        this.player.lines = 0;
        this.player.hold = null;
        this.player.holdType = null;
        this.player.hasHeld = false;
        this.dropInterval = 1000;
        this.combo = 0;
        this.pendingGarbage = 0;
        this.lastActionWasRotate = false;
        this.updateScore();
        if (this.garbageMeterElement) this.garbageMeterElement.innerText = "0";
        if (this.actionPopup) this.actionPopup.classList.remove('active');
        if (this.comboPopup) this.comboPopup.classList.remove('active');
        if (this.tetrisPopup) this.tetrisPopup.classList.remove('active');

        this.isGameOver = false;
        this.isPlaying = true;
        this.paused = false;
        this.gameOverScreen.classList.add('hidden');

        this.keys = { left: false, right: false, down: false };
        this.keyTimer = { left: 0, right: 0, down: 0 };
        this.lockDelayTimer = 0;
        this.lockResets = 0;

        this.player.nextTypes = null;
        this.player.nextPieces = null;
        this.playerReset();
        this.lastTime = performance.now();
        this._startLoop();
    }

    _startLoop() {
        this.worker.postMessage({ cmd: 'start', id: this.gameId });
    }

    _loop() {
        this.update();
    }

    resetBoard() {
        this.bag = [];
        this.pieceIndex = 0;
        this.arena.forEach(row => row.fill(0));
        this.player.score = 0;
        this.player.level = 1;
        this.player.lines = 0;
        this.player.hold = null;
        this.player.holdType = null;
        this.player.hasHeld = false;
        this.dropInterval = 1000;
        this.combo = 0;
        this.pendingGarbage = 0;
        this.lastActionWasRotate = false;
        this.updateScore();
        if (this.garbageMeterElement) this.garbageMeterElement.innerText = "0";
        if (this.actionPopup) this.actionPopup.classList.remove('active');
        if (this.comboPopup) this.comboPopup.classList.remove('active');
        if (this.tetrisPopup) this.tetrisPopup.classList.remove('active');
        this.isGameOver = false;
        this.isPlaying = false;
        this.paused = false;
        this.gameOverScreen.classList.add('hidden');
        this.player.matrix = null;
        this.player.nextTypes = null;
        this.player.nextPieces = null;
        this.draw();
        this.nextContext.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
        this.holdContext.clearRect(0, 0, this.holdCanvas.width, this.holdCanvas.height);
    }

    stop() {
        this.isPlaying = false;
        this.worker.postMessage({ cmd: 'stop', id: this.gameId });
    }
}

// ======================
// MiniBoardRenderer: 배틀 모드 상대방 미니 보드 (렌더링 전용)
// ======================
class MiniBoardRenderer {
    constructor(socketId, nickname, blockSize = 15) {
        this.socketId = socketId;
        this.nickname = nickname;
        this.isEliminated = false;
        this.pendingGarbage = 0;
        this.blockSize = blockSize;

        // 래퍼 div 생성
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'mini-board-wrapper';
        this.wrapper.dataset.socketId = socketId;

        // 닉네임
        const nameEl = document.createElement('div');
        nameEl.className = 'mini-board-nickname';
        nameEl.innerText = nickname;
        this.wrapper.appendChild(nameEl);

        // 캔버스
        this.canvas = document.createElement('canvas');
        this.canvas.width = blockSize * 10;
        this.canvas.height = blockSize * 20;
        this.canvas.className = 'mini-board-canvas';
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(blockSize, blockSize);
        this.wrapper.appendChild(this.canvas);

        // INCOMING 표시
        this.incomingEl = document.createElement('div');
        this.incomingEl.className = 'mini-incoming';
        this.incomingEl.innerText = 'INCOMING: 0';
        this.wrapper.appendChild(this.incomingEl);

        // 탈락 오버레이
        this.elimOverlay = document.createElement('div');
        this.elimOverlay.className = 'mini-eliminated-overlay hidden';
        this.elimOverlay.innerText = 'ELIMINATED';
        this.wrapper.appendChild(this.elimOverlay);

        // 상태
        const B = MiniBoardRenderer.MINI_BLOCK;
        this.arena = Array.from({ length: 20 }, () => new Array(10).fill(0));
        this.playerMatrix = null;
        this.playerPos = { x: 0, y: 0 };

        this.draw();
    }

    drawBlock(ctx, x, y, value) {
        const colors = getColors();
        ctx.fillStyle = colors[value] || '#555';
        ctx.fillRect(x, y, 1, 1);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(x, y, 1, 0.15);
        ctx.fillRect(x, y, 0.15, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + 0.85, y, 0.15, 1);
        ctx.fillRect(x, y + 0.85, 1, 0.15);
    }

    draw() {
        const ctx = this.ctx;
        const B = this.blockSize;
        ctx.clearRect(0, 0, this.canvas.width / B, this.canvas.height / B);

        // 그리드
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 0.05;
        for (let i = 0; i <= 10; i++) {
            ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 20); ctx.stroke();
        }
        for (let i = 0; i <= 20; i++) {
            ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(10, i); ctx.stroke();
        }

        // arena
        this.arena.forEach((row, y) => {
            row.forEach((val, x) => {
                if (val) this.drawBlock(ctx, x, y, val);
            });
        });

        // 활성 피스
        if (this.playerMatrix) {
            this.playerMatrix.forEach((row, dy) => {
                row.forEach((val, dx) => {
                    if (val) this.drawBlock(ctx, dx + this.playerPos.x, dy + this.playerPos.y, val);
                });
            });
        }
    }

    updateFromData(data) {
        this.arena = data.arena;
        this.playerMatrix = data.player.matrix;
        this.playerPos = data.player.pos;
        this.pendingGarbage = data.pendingGarbage || 0;
        this.incomingEl.innerText = `INCOMING: ${this.pendingGarbage}`;
        this.draw();
    }

    eliminate() {
        this.isEliminated = true;
        this.wrapper.classList.add('eliminated');
        this.elimOverlay.classList.remove('hidden');
    }

    appendTo(container) {
        container.appendChild(this.wrapper);
    }

    remove() {
        if (this.wrapper.parentNode) this.wrapper.parentNode.removeChild(this.wrapper);
    }
}

// System Controller
let singleControls = { left: 'arrowleft', right: 'arrowright', down: 'arrowdown', drop: ' ', rotateCW: 'arrowup', rotateCCW: 'z', hold: 'shift' };
let p1Controls = { left: 'a', right: 'd', down: 's', drop: ' ', rotateCW: 'e', rotateCCW: 'q', hold: 'shift' };
let p2Controls = { left: 'arrowleft', right: 'arrowright', down: 'arrowdown', drop: 'enter', rotateCW: 'arrowup', rotateCCW: 'z', hold: 'control' };
let isMappingKeys = false;

const game1 = new TetrisGame(document.getElementById('player1'));
const game2 = new TetrisGame(document.getElementById('player2'));

// Theme integration
function applySystemSettings() {
    let savedTheme = localStorage.getItem('tetrisTheme') || 'dark';
    let savedStyle = localStorage.getItem('tetrisBlockStyle') || 'standard';

    document.getElementById('sel-theme').value = savedTheme;
    document.getElementById('sel-blockStyle').value = savedStyle;

    document.documentElement.dataset.theme = savedTheme;
    game1.draw();
    game2.draw();
}

document.getElementById('sel-theme').addEventListener('change', (e) => {
    localStorage.setItem('tetrisTheme', e.target.value);
    applySystemSettings();
});

document.getElementById('sel-blockStyle').addEventListener('change', (e) => {
    localStorage.setItem('tetrisBlockStyle', e.target.value);
    applySystemSettings();
});

applySystemSettings();

// UI Input config setup
['left', 'right', 'down', 'drop', 'rotateCW', 'rotateCCW', 'hold'].forEach(action => {
    const solEl = document.getElementById(`sol-${action}`);
    const p1El = document.getElementById(`p1-${action}`);
    const p2El = document.getElementById(`p2-${action}`);

    solEl.addEventListener('click', () => startKeyConfig(solEl, 'single', action));
    p1El.addEventListener('click', () => startKeyConfig(p1El, 'p1', action));
    p2El.addEventListener('click', () => startKeyConfig(p2El, 'p2', action));
});

function startKeyConfig(element, configObj, action) {
    isMappingKeys = true;
    element.value = "Press key...";
    const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = e.key.toLowerCase() === ' ' ? ' ' : e.key.toLowerCase();

        if (configObj === 'single') singleControls[action] = key;
        else if (configObj === 'p1') p1Controls[action] = key;
        else p2Controls[action] = key;

        let displayKey = key === ' ' ? 'Space' : key;
        displayKey = displayKey.charAt(0).toUpperCase() + displayKey.slice(1);
        element.value = displayKey;

        document.removeEventListener('keydown', handler, true);
        setTimeout(() => isMappingKeys = false, 100);
    };
    document.addEventListener('keydown', handler, true);
}

// Save Score to localStorage
function saveScore(score) {
    if (score <= 0) return false;
    let scores = JSON.parse(localStorage.getItem('tetrisTopScores') || '[]');
    let isNewRecord = scores.length === 0 || score > scores[0];
    scores.push(score);
    scores.sort((a, b) => b - a);
    scores = scores.slice(0, 10);
    localStorage.setItem('tetrisTopScores', JSON.stringify(scores));
    return isNewRecord;
}

function updateLeaderboardUI() {
    let scores = JSON.parse(localStorage.getItem('tetrisTopScores') || '[]');
    let listEl = document.getElementById('leaderboard-list');
    listEl.innerHTML = '';
    if (scores.length === 0) {
        listEl.innerHTML = '<p style="text-align:center;color:#aaa;">No records yet.</p>';
    }
    scores.forEach((s, idx) => {
        listEl.innerHTML += `<div class="lb-entry ${idx === 0 ? 'top-1' : ''}"><span>#${idx + 1}</span><span>${s}</span></div>`;
    });
}

function toggleGameOverButtons() {
    const spBtns = document.querySelectorAll('.btn-sp-mode');
    const mpBtns = document.querySelectorAll('.btn-mp-mode');
    if (currentMode === 'network') {
        spBtns.forEach(btn => btn.classList.add('hidden'));
        mpBtns.forEach(btn => btn.classList.remove('hidden'));
    } else {
        spBtns.forEach(btn => btn.classList.remove('hidden'));
        mpBtns.forEach(btn => btn.classList.add('hidden'));
    }
}

// Game Over linkages
game1.onGameOver = () => {
    document.getElementById('record-notice').classList.add('hidden');
    let matchScoreText = document.getElementById('match-score');
    
    toggleGameOverButtons();

    if (currentMode === 'versus') {
        game2.stop();
        document.getElementById('match-result').innerText = "PLAYER 2 WINS!";
        matchScoreText.classList.add('hidden');
    } else if (currentMode === 'network') {
        document.getElementById('match-result').innerText = "YOU LOSE";
        matchScoreText.classList.add('hidden');
    } else {
        document.getElementById('match-result').innerText = "GAME OVER";
        matchScoreText.innerText = "SCORE: " + game1.player.score;
        matchScoreText.classList.remove('hidden');

        if (saveScore(game1.player.score)) {
            document.getElementById('record-notice').classList.remove('hidden');
        }
    }

    document.getElementById('match-over').classList.remove('hidden');
    syncActiveNav('match-over');
};

game2.onGameOver = () => {
    if (currentMode === 'versus') {
        game1.stop();
        toggleGameOverButtons();
        document.getElementById('match-result').innerText = "PLAYER 1 WINS!";
        document.getElementById('match-score').classList.add('hidden');
        document.getElementById('record-notice').classList.add('hidden');
        document.getElementById('match-over').classList.remove('hidden');
        syncActiveNav('match-over');
    }
};

function syncActiveNav(overlayId) {
    const parent = document.getElementById(overlayId);
    if (!parent) return;
    const btns = Array.from(parent.querySelectorAll('.menu-btn:not(.hidden)'));
    btns.forEach(b => b.classList.remove('active-nav'));
    if (btns.length > 0) btns[0].classList.add('active-nav');
}

// Global Keyboard Handler
document.addEventListener('keydown', event => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        return;
    }
    if (isMappingKeys) return;
    const key = event.key.toLowerCase() === ' ' ? ' ' : event.key.toLowerCase();

    // UI Navigation Logic
    const activeOverlays = Array.from(document.querySelectorAll('.overlay:not(.hidden)'));
    if (activeOverlays.length > 0) {
        let overlay = activeOverlays[0];
        let maxZ = parseInt(window.getComputedStyle(overlay).zIndex) || 0;
        for (let i = 1; i < activeOverlays.length; i++) {
            let z = parseInt(window.getComputedStyle(activeOverlays[i]).zIndex) || 0;
            if (z >= maxZ) {
                maxZ = z;
                overlay = activeOverlays[i];
            }
        }

        if (['arrowup', 'arrowdown', 'enter'].includes(key)) {
            const btns = Array.from(overlay.querySelectorAll('.menu-btn:not(.hidden)'));
            if (btns.length > 0) {
                let activeIdx = btns.findIndex(b => b.classList.contains('active-nav'));
                if (activeIdx === -1) activeIdx = 0;

                if (key === 'arrowdown') {
                    btns[activeIdx].classList.remove('active-nav');
                    activeIdx = (activeIdx + 1) % btns.length;
                    btns[activeIdx].classList.add('active-nav');
                    event.preventDefault();
                } else if (key === 'arrowup') {
                    btns[activeIdx].classList.remove('active-nav');
                    activeIdx = (activeIdx - 1 + btns.length) % btns.length;
                    btns[activeIdx].classList.add('active-nav');
                    event.preventDefault();
                } else if (key === 'enter') {
                    btns[activeIdx].click();
                    event.preventDefault();
                }
            }
            return;
        }
    }

    if ([' ', 'arrowleft', 'arrowup', 'arrowright', 'arrowdown', 'enter', 'shift', 'control'].includes(key)) {
        if (document.getElementById('main-menu').classList.contains('hidden') &&
            document.getElementById('settings-menu').classList.contains('hidden')) {
            event.preventDefault();
        }
    }

    if (key === 'escape') {
        if (!document.getElementById('settings-menu').classList.contains('hidden')) {
            document.getElementById('settings-menu').classList.add('hidden');
            return;
        }
        if (!document.getElementById('update-log-menu').classList.contains('hidden')) {
            document.getElementById('update-log-menu').classList.add('hidden');
            return;
        }

        if (!document.getElementById('game-wrapper').classList.contains('hidden') &&
            document.getElementById('match-over').classList.contains('hidden')) {

            // 관전자는 ESC 무시 (LEAVE 버튼으로만 나갈 수 있음)
            if (isSpectator) return;

            const pauseMenu = document.getElementById('pause-menu');
            if (pauseMenu.classList.contains('hidden')) {
                // 네트워크 모드에서는 전용 버튼만 표시
                const spBtns = pauseMenu.querySelectorAll('.btn-pause-sp');
                const netBtns = pauseMenu.querySelectorAll('.btn-pause-net');
                if (currentMode === 'network') {
                    spBtns.forEach(b => b.classList.add('hidden'));
                    netBtns.forEach(b => b.classList.remove('hidden'));
                } else {
                    spBtns.forEach(b => b.classList.remove('hidden'));
                    netBtns.forEach(b => b.classList.add('hidden'));
                }
                pauseMenu.classList.remove('hidden');
                syncActiveNav('pause-menu');
                // 네트워크 모드에서는 게임을 멈추지 않음 (악용 방지)
                if (currentMode !== 'network') {
                    game1.pause();
                    if (currentMode === 'versus') game2.pause();
                }
            } else {
                pauseMenu.classList.add('hidden');
                // 네트워크 모드에서는 멈추지 않았으므로 resume도 불필요
                if (currentMode !== 'network') {
                    game1.resume();
                    if (currentMode === 'versus') game2.resume();
                }
            }
        }
    }

    if (currentMode === 'single' || currentMode === 'network') {
        if (!isSpectator && game1.isPlaying && !game1.isGameOver && !game1.paused) {
            if (key === singleControls.left) { if (!game1.keys.left) game1.keyTimer.left = 0; game1.keys.left = true; }
            else if (key === singleControls.right) { if (!game1.keys.right) game1.keyTimer.right = 0; game1.keys.right = true; }
            else if (key === singleControls.down) { if (!game1.keys.down) game1.keyTimer.down = 0; game1.keys.down = true; }
            else if (key === singleControls.rotateCW) { game1.playerRotate(1); game1.draw(); }
            else if (key === singleControls.rotateCCW) { game1.playerRotate(-1); game1.draw(); }
            else if (key === singleControls.drop) { game1.playerHardDrop(); game1.draw(); }
            else if (key === singleControls.hold) { game1.playerHold(); game1.draw(); }
        }
    } else if (currentMode === 'versus') {
        if (game1.isPlaying && !game1.isGameOver && !game1.paused) {
            if (key === p1Controls.left) { if (!game1.keys.left) game1.keyTimer.left = 0; game1.keys.left = true; }
            else if (key === p1Controls.right) { if (!game1.keys.right) game1.keyTimer.right = 0; game1.keys.right = true; }
            else if (key === p1Controls.down) { if (!game1.keys.down) game1.keyTimer.down = 0; game1.keys.down = true; }
            else if (key === p1Controls.rotateCW) { game1.playerRotate(1); game1.draw(); }
            else if (key === p1Controls.rotateCCW) { game1.playerRotate(-1); game1.draw(); }
            else if (key === p1Controls.drop) { game1.playerHardDrop(); game1.draw(); }
            else if (key === p1Controls.hold) { game1.playerHold(); game1.draw(); }
        }
        if (game2.isPlaying && !game2.isGameOver && !game2.paused) {
            if (key === p2Controls.left) { if (!game2.keys.left) game2.keyTimer.left = 0; game2.keys.left = true; }
            else if (key === p2Controls.right) { if (!game2.keys.right) game2.keyTimer.right = 0; game2.keys.right = true; }
            else if (key === p2Controls.down) { if (!game2.keys.down) game2.keyTimer.down = 0; game2.keys.down = true; }
            else if (key === p2Controls.rotateCW) { game2.playerRotate(1); game2.draw(); }
            else if (key === p2Controls.rotateCCW) { game2.playerRotate(-1); game2.draw(); }
            else if (key === p2Controls.drop) { game2.playerHardDrop(); game2.draw(); }
            else if (key === p2Controls.hold) { game2.playerHold(); game2.draw(); }
        }
    }
});

document.addEventListener('keyup', event => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        return;
    }
    if (isMappingKeys) return;
    const key = event.key.toLowerCase() === ' ' ? ' ' : event.key.toLowerCase();

    if (currentMode === 'single' || currentMode === 'network') {
        if (!isSpectator) {
            if (key === singleControls.left) game1.keys.left = false;
            else if (key === singleControls.right) game1.keys.right = false;
            else if (key === singleControls.down) game1.keys.down = false;
        }
    } else if (currentMode === 'versus') {
        if (key === p1Controls.left) game1.keys.left = false;
        else if (key === p1Controls.right) game1.keys.right = false;
        else if (key === p1Controls.down) game1.keys.down = false;

        if (key === p2Controls.left) game2.keys.left = false;
        else if (key === p2Controls.right) game2.keys.right = false;
        else if (key === p2Controls.down) game2.keys.down = false;
    }
});

// UI Event Binding
function bindMenuButtons() {
    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            const parent = btn.closest('.overlay');
            if (parent) {
                parent.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('active-nav'));
                btn.classList.add('active-nav');
            }
        });
    });
}
bindMenuButtons();

function startCountdown(callback) {
    const overlay = document.getElementById('countdown-overlay');
    const text = document.getElementById('countdown-text');
    overlay.classList.remove('hidden');
    let count = 3;
    
    function tick() {
        if (count > 0) {
            text.innerText = count;
            text.style.transform = 'scale(1.5)';
            text.style.opacity = '0';
            void text.offsetWidth; // Trigger reflow
            text.style.transform = 'scale(1)';
            text.style.opacity = '1';
            
            setTimeout(() => {
                count--;
                tick();
            }, 1000);
        } else {
            text.innerText = 'GO!';
            text.style.color = '#FF0055';
            text.style.textShadow = '0 0 30px #FF0055';
            text.style.transform = 'scale(1.5)';
            
            setTimeout(() => {
                overlay.classList.add('hidden');
                text.style.color = '#fff';
                text.style.textShadow = '0 0 30px #0DFF72';
                text.style.transform = 'scale(1)';
                if (callback) callback();
            }, 1000);
        }
    }
    
    tick();
}

document.getElementById('btn-single').addEventListener('click', () => {
    currentMode = 'single';
    isSpectator = false;
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('game-wrapper').classList.remove('hidden', 'battle-mode', 'spectator-mode');
    document.getElementById('player1').classList.remove('hidden');
    document.getElementById('player2').classList.add('hidden');
    document.getElementById('battle-opponents-panel').classList.add('hidden');
    document.getElementById('spectator-leave-btn').classList.add('hidden');
    Object.values(opponentRenderers).forEach(r => r.wrapper && r.wrapper.remove());
    opponentRenderers = {};
    document.getElementById('p1-title').innerText = 'SINGLE PLAYER';
    document.getElementById('p1-board-name').innerText = 'SINGLE PLAYER';
    game1.opponent = null;
    game1.resetBoard();
    
    startCountdown(() => {
        game1.startGame();
    });
});

document.getElementById('btn-versus').addEventListener('click', () => {
    currentMode = 'versus';
    isSpectator = false;
    sharedPieceSequence = [];
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('game-wrapper').classList.remove('hidden', 'battle-mode', 'spectator-mode');
    document.getElementById('player1').classList.remove('hidden');
    document.getElementById('player2').classList.remove('hidden');
    document.getElementById('battle-opponents-panel').classList.add('hidden');
    document.getElementById('spectator-leave-btn').classList.add('hidden');
    Object.values(opponentRenderers).forEach(r => r.wrapper && r.wrapper.remove());
    opponentRenderers = {};
    document.getElementById('p1-title').innerText = 'PLAYER 1';
    document.getElementById('p1-board-name').innerText = 'PLAYER 1';
    document.querySelector('#player2 .player-title').innerText = 'PLAYER 2';
    document.getElementById('p2-board-name').innerText = 'PLAYER 2';
    game1.opponent = game2;
    game2.opponent = game1;
    game1.resetBoard();
    game2.resetBoard();
    
    startCountdown(() => {
        game1.startGame();
        game2.startGame();
    });
});

// Network multiplayer setup
let myNickname = 'Player 1';
let currentRoomId = null;
let isRoomHost = false;
let selectedRoomIdToJoin = null;

if (typeof io !== 'undefined') {
    socket = io();

    socket.on('roomListUpdate', (list) => {
        const listEl = document.getElementById('room-list');
        listEl.innerHTML = '';
        if (list.length === 0) {
            listEl.innerHTML = '<p style="text-align:center;color:#aaa;">No active rooms.</p>';
        } else {
            list.forEach(r => {
                const entry = document.createElement('div');
                entry.className = 'room-entry';
                const maxP = r.maxPlayers || 2;
                let statusText = r.status === 'playing' ? 'In Game' : `${r.playerCount}/${maxP}`;
                let lockIcon = r.hasPassword ? ' 🔒' : '';
                const modeBadge = r.mode === 'battle'
                    ? '<span class="room-mode-badge mode-battle">BATTLE</span>'
                    : '<span class="room-mode-badge mode-1v1">1v1</span>';
                const ruleBadge = r.rule === 'suddendeath' ? '<span style="color:#FF0055;font-size:0.8rem;margin-left:5px;">[SD]</span>' : (r.rule === 'gravity' ? '<span style="color:#00FFFF;font-size:0.8rem;margin-left:5px;">[GV]</span>' : '');
                const canJoin = r.playerCount < maxP && r.status === 'waiting';
                entry.innerHTML = `
                    <div style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:10px;">
                        <span class="room-name" style="flex:1; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left;">${modeBadge}${ruleBadge} ${r.name}${lockIcon}</span>
                        <span class="room-status" style="white-space:nowrap; flex-shrink:0;">${statusText}</span>
                    </div>
                    <div style="display:flex; gap:8px; justify-content:flex-end; width:100%;">
                        ${canJoin ? '<button class="btn-join menu-btn" style="padding:5px 10px;font-size:0.8rem;min-width:auto;">JOIN</button>' : ''}
                        <button class="btn-spectate menu-btn" style="padding:5px 10px;font-size:0.8rem;min-width:auto;">SPECTATE</button>
                    </div>
                `;
                const btnJoin = entry.querySelector('.btn-join');
                const btnSpectate = entry.querySelector('.btn-spectate');
                if (btnJoin) {
                    btnJoin.addEventListener('click', (e) => {
                        e.stopPropagation();
                        selectedRoomIdToJoin = r.id;
                        isJoinForSpectate = false;
                        if (r.hasPassword) {
                            document.getElementById('input-join-password').value = '';
                            document.getElementById('lobby-menu').classList.add('hidden');
                            document.getElementById('join-room-menu').classList.remove('hidden');
                            syncActiveNav('join-room-menu');
                        } else {
                            myNickname = document.getElementById('input-nickname').value || 'Player';
                            socket.emit('joinRoom', { roomId: r.id, password: '', nickname: myNickname });
                        }
                    });
                }
                if (btnSpectate) {
                    btnSpectate.addEventListener('click', (e) => {
                        e.stopPropagation();
                        selectedRoomIdToJoin = r.id;
                        isJoinForSpectate = true;
                        if (r.hasPassword) {
                            document.getElementById('input-join-password').value = '';
                            document.getElementById('lobby-menu').classList.add('hidden');
                            document.getElementById('join-room-menu').classList.remove('hidden');
                            syncActiveNav('join-room-menu');
                        } else {
                            myNickname = document.getElementById('input-nickname').value || 'Spectator';
                            socket.emit('spectateRoom', { roomId: r.id, password: '', nickname: myNickname });
                        }
                    });
                }
                listEl.appendChild(entry);
            });
        }
    });

    socket.on('roomJoined', (data) => {
        const room = data.room;
        isRoomHost = data.isHost;
        currentRoomId = room.id;
        isSpectator = data.isSpectator || false;
        roomMode = room.mode || '1v1';

        document.getElementById('lobby-menu').classList.add('hidden');
        document.getElementById('create-room-menu').classList.add('hidden');
        document.getElementById('join-room-menu').classList.add('hidden');
        document.getElementById('room-waiting-menu').classList.remove('hidden');
        syncActiveNav('room-waiting-menu');

        // 채팅창 비우기 (새로 들어온 플레이어만)
        document.getElementById('waiting-chat-messages').innerHTML = '';

        let titleText = room.name + (roomMode === 'battle' ? ' [BATTLE]' : ' [1v1]');
        if (isSpectator) titleText += ' (Spectating)';
        document.getElementById('waiting-room-name').innerText = titleText;

        const badgesEl = document.getElementById('waiting-room-badges');
        badgesEl.innerHTML = '';
        
        const ruleDescEl = document.getElementById('waiting-rule-desc');
        const tooltipContainer = document.getElementById('waiting-rule-tooltip');
        if (room.rule === 'suddendeath') {
            badgesEl.innerHTML = '<span style="color:#FF0055;font-size:1.5rem;font-weight:bold;text-shadow:0 0 10px #FF0055;font-family:\'Orbitron\', sans-serif;">[SD]</span>';
            ruleDescEl.innerHTML = "<strong>Sudden Death:</strong> 20초마다 모든 플레이어에게 쓰레기 블록 1줄씩 추가";
            tooltipContainer.style.display = "inline-flex";
        } else if (room.rule === 'gravity') {
            badgesEl.innerHTML = '<span style="color:#00FFFF;font-size:1.5rem;font-weight:bold;text-shadow:0 0 10px #00FFFF;font-family:\'Orbitron\', sans-serif;">[GV]</span>';
            ruleDescEl.innerHTML = "<strong>Gravity:</strong> 시간이 지날수록 블록 낙하 속도 지속 증가";
            tooltipContainer.style.display = "inline-flex";
        } else {
            ruleDescEl.innerHTML = "<strong>Normal:</strong> 기본 룰 (추가 효과 없음)";
            tooltipContainer.style.display = "inline-flex";
        }

        updateRoomWaitingUI(room.players);
    });

    function updateRoomWaitingUI(players) {
        const listEl = document.getElementById('waiting-player-list');
        listEl.innerHTML = '';

        const maxSlots = roomMode === 'battle' ? 4 : 2;
        const colors = ['#0DFF72', '#FF0055', '#FFDD00', '#00BFFF'];

        // 현재 참가된 플레이어 렌더링
        players.forEach((p, i) => {
            const el = document.createElement('div');
            el.className = `waiting-player-entry ${p.isHost ? 'host-entry' : 'guest-entry'}`;
            el.style.color = colors[i] || '#fff';
            let statusStr = p.isHost ? '(HOST)' : (p.isReady ? '✔ READY' : 'Not Ready');
            el.innerHTML = `<span class="wpe-name">${p.nickname}</span><span class="wpe-status">${statusStr}</span>`;
            listEl.appendChild(el);
        });

        // 빈 슬롯
        for (let i = players.length; i < maxSlots; i++) {
            const el = document.createElement('div');
            el.className = 'waiting-slot';
            el.innerText = `Waiting for player ${i + 1}...`;
            listEl.appendChild(el);
        }

        const startBtn = document.getElementById('btn-start-game');
        const readyBtn = document.getElementById('btn-ready');

        if (isSpectator) {
            startBtn.style.display = 'none';
            readyBtn.style.display = 'none';
        } else if (isRoomHost) {
            startBtn.style.display = 'block';
            readyBtn.style.display = 'none';
            const nonHosts = players.filter(p => !p.isHost);
            const nonHostReady = nonHosts.filter(p => p.isReady).length;
            const canStart = players.length >= 2 && nonHosts.length === nonHostReady;
            startBtn.disabled = !canStart;
            startBtn.style.opacity = canStart ? '1' : '0.5';
        } else {
            startBtn.style.display = 'none';
            readyBtn.style.display = 'block';
            const me = players.find(p => p.id === mySocketId) || players.find(p => !p.isHost);
            readyBtn.innerText = (me && me.isReady) ? 'UNREADY' : 'READY';
        }
    }

    socket.on('playerJoinedRoom', (newPlayer) => {
        // readyStateChanged가 곧 올 예정이지만 임시 렌더링
        const listEl = document.getElementById('waiting-player-list');
        const slot = listEl.querySelector('.waiting-slot');
        if (slot) slot.remove();
        updateRoomWaitingUI([
            ...Array.from(listEl.querySelectorAll('.waiting-player-entry')).map(el => ({
                nickname: el.querySelector('.wpe-name').innerText,
                isHost: el.classList.contains('host-entry'),
                isReady: false
            })),
            newPlayer
        ]);
    });

    socket.on('playerLeftRoom', () => {
        socket.emit('requestRoomList'); // 서버에서 최신 목록 받아 갱신
    });

    socket.on('readyStateChanged', (players) => {
        updateRoomWaitingUI(players);
    });

    socket.on('hostMigrated', (newHost) => {
        isRoomHost = (newHost.id === mySocketId);
    });

    socket.on('roomError', (msg) => {
        alert(msg);
        document.getElementById('create-room-menu').classList.add('hidden');
        document.getElementById('join-room-menu').classList.add('hidden');
        document.getElementById('room-waiting-menu').classList.add('hidden');
        document.getElementById('lobby-menu').classList.remove('hidden');
        syncActiveNav('lobby-menu');
        currentRoomId = null;
        isRoomHost = false;
    });

    socket.on('connect', () => {
        mySocketId = socket.id;
    });

    socket.on('gameStart', (data) => {
        networkSeed = data.seed;
        sharedPieceSequence = [];
        roomMode = data.mode || '1v1';
        roomRule = data.rule || 'normal';
        mySocketId = data.myId || socket.id;

        document.getElementById('match-over').classList.add('hidden');
        document.getElementById('room-waiting-menu').classList.add('hidden');
        document.getElementById('game-wrapper').classList.remove('hidden');
        // 인게임 채팅 패널 표시
        document.getElementById('ingame-chat-panel').style.display = 'flex';
        document.getElementById('ingame-chat-messages').innerHTML = '';

        // 관전자 LEAVE 버튼 표시/숨김
        const specBtn = document.getElementById('spectator-leave-btn');
        specBtn.classList.toggle('hidden', !isSpectator);

        if (roomMode === 'battle') {
            // === 배틀 모드 ===
            document.getElementById('player2').classList.add('hidden');
            document.getElementById('game-wrapper').classList.add('battle-mode');

            if (isSpectator) {
                document.getElementById('player1').classList.add('hidden');
                document.getElementById('game-wrapper').classList.add('spectator-mode');
            } else {
                document.getElementById('player1').classList.remove('hidden');
                document.getElementById('game-wrapper').classList.remove('spectator-mode');
            }

            const panel = document.getElementById('battle-opponents-panel');
            panel.innerHTML = '';
            panel.classList.remove('hidden');
            opponentRenderers = {};

            const myNickLocal = data.players.find(p => p.id === mySocketId)?.nickname || 'You';
            document.getElementById('p1-title').innerText = myNickLocal;
            document.getElementById('p1-board-name').innerText = myNickLocal;

            data.players.forEach(p => {
                if (p.id === mySocketId && !isSpectator) return; // 자신은 스킵
                // 관전자면 보드를 약간 더 크게(20), 아니면 기본(15)
                const renderer = new MiniBoardRenderer(p.id, p.nickname, isSpectator ? 20 : 15);
                opponentRenderers[p.id] = renderer;
                renderer.appendTo(panel);
            });

            game1.opponent = null;
            game1.resetBoard();
            
            startCountdown(() => {
                if (!isSpectator) {
                    game1.startGame();
                    game1.draw();
                } else {
                    game1.isPlaying = false;
                }
            });
        } else {
            // === 1v1 모드 ===
            document.getElementById('player1').classList.remove('hidden');
            document.getElementById('player2').classList.remove('hidden');
            document.getElementById('game-wrapper').classList.remove('battle-mode');
            document.getElementById('game-wrapper').classList.remove('spectator-mode');
            document.getElementById('battle-opponents-panel').classList.add('hidden');

            if (isSpectator || data.myId === null) {
                document.getElementById('p1-title').innerText = data.p1Nickname;
                document.querySelector('#player2 .player-title').innerText = data.p2Nickname;
                document.getElementById('p1-board-name').innerText = data.p1Nickname;
                document.getElementById('p2-board-name').innerText = data.p2Nickname;
            } else if (isRoomHost) {
                document.getElementById('p1-title').innerText = data.p1Nickname;
                document.querySelector('#player2 .player-title').innerText = data.p2Nickname;
                document.getElementById('p1-board-name').innerText = data.p1Nickname;
                document.getElementById('p2-board-name').innerText = data.p2Nickname;
            } else {
                document.getElementById('p1-title').innerText = data.p2Nickname;
                document.querySelector('#player2 .player-title').innerText = data.p1Nickname;
                document.getElementById('p1-board-name').innerText = data.p2Nickname;
                document.getElementById('p2-board-name').innerText = data.p1Nickname;
            }

            game1.opponent = game2;
            game2.opponent = game1;
            game1.resetBoard();
            game2.resetBoard();

            startCountdown(() => {
                game1.startGame();
                game2.startGame();
                if (isSpectator) {
                    game1.isPlaying = false;
                    game2.isPlaying = false;
                } else {
                    game2.isPlaying = false;
                }
                game1.draw();
                game2.draw();
            });
        }
    });

    socket.on('spectateGameStart', (data) => {
        roomMode = data.mode || '1v1';
        networkSeed = data.seed || 1;
        sharedPieceSequence = [];

        document.getElementById('match-over').classList.add('hidden');
        document.getElementById('lobby-menu').classList.add('hidden');
        document.getElementById('join-room-menu').classList.add('hidden');
        document.getElementById('room-waiting-menu').classList.add('hidden');
        document.getElementById('game-wrapper').classList.remove('hidden');
        document.getElementById('spectator-leave-btn').classList.remove('hidden');
        // 인게임 채팅 패널 표시
        document.getElementById('ingame-chat-panel').style.display = 'flex';
        document.getElementById('ingame-chat-messages').innerHTML = '';
        document.getElementById('waiting-chat-messages').innerHTML = '';

        if (roomMode === 'battle') {
            document.getElementById('player1').classList.add('hidden');
            document.getElementById('player2').classList.add('hidden');
            document.getElementById('game-wrapper').classList.add('battle-mode');
            document.getElementById('game-wrapper').classList.add('spectator-mode');
            const panel = document.getElementById('battle-opponents-panel');
            panel.innerHTML = '';
            panel.classList.remove('hidden');
            opponentRenderers = {};

            data.players.forEach(p => {
                const renderer = new MiniBoardRenderer(p.id, p.nickname, 20); // 관전자는 크게
                opponentRenderers[p.id] = renderer;
                renderer.appendTo(panel);
                if (!data.alivePlayers.includes(p.id)) renderer.eliminate();
            });
            game1.isPlaying = false; 
        } else {
            document.getElementById('player1').classList.remove('hidden');
            document.getElementById('player2').classList.remove('hidden');
            document.getElementById('game-wrapper').classList.remove('battle-mode');
            document.getElementById('game-wrapper').classList.remove('spectator-mode');
            document.getElementById('battle-opponents-panel').classList.add('hidden');
            document.getElementById('p1-title').innerText = data.p1Nickname;
            document.querySelector('#player2 .player-title').innerText = data.p2Nickname;
            document.getElementById('p1-board-name').innerText = data.p1Nickname;
            document.getElementById('p2-board-name').innerText = data.p2Nickname;
            game1.opponent = game2; game2.opponent = game1;
            game1.startGame(); game2.startGame();
            game1.isPlaying = false; game2.isPlaying = false;
            game1.draw(); game2.draw();
        }
    });

    socket.on('boardUpdate', (data) => {
        if (currentMode === 'network') {
            if (roomMode === 'battle') {
                // 배틀 모드: senderId로 미니 보드 업데이트
                if (data.senderId === mySocketId && !isSpectator) return; // 자신 업데이트 스킵
                const renderer = opponentRenderers[data.senderId];
                if (renderer) renderer.updateFromData(data);
            } else {
                // 1v1 모드
                let targetGame = game2;
                if (isSpectator) {
                    targetGame = data.isHost ? game1 : game2;
                } else if (data.isHost === isRoomHost) {
                    return;
                }
                targetGame.arena = data.arena;
                targetGame.player.pos = data.player.pos;
                targetGame.player.matrix = data.player.matrix;
                targetGame.player.nextPieces = data.player.next;
                targetGame.player.hold = data.player.hold;
                targetGame.player.hasHeld = data.player.hasHeld;
                targetGame.player.score = data.player.score;
                targetGame.player.level = data.player.level;
                targetGame.player.lines = data.player.lines;
                if (data.pendingGarbage !== undefined) {
                    targetGame.pendingGarbage = data.pendingGarbage;
                    if (targetGame.garbageMeterElement) {
                        targetGame.garbageMeterElement.innerText = targetGame.pendingGarbage.toString();
                    }
                }
                targetGame.updateScore();
                targetGame.drawNextPiece();
                targetGame.drawHoldPiece();
                targetGame.draw();
            }
        }
    });

    socket.on('playerEliminated', (data) => {
        if (roomMode === 'battle') {
            const renderer = opponentRenderers[data.id];
            if (renderer) renderer.eliminate();
            // 자신이 탈락한 경우— game1 이미 gameOver()로 화면 처리
        }
    });

    socket.on('gameEndBattle', (data) => {
        game1.stop();
        // 모든 미니 보드 정지
        Object.values(opponentRenderers).forEach(r => r.eliminate());
        toggleGameOverButtons();
        document.getElementById('match-result').innerText = data.winnerNickname + ' WIN!';
        document.getElementById('match-score').classList.add('hidden');
        document.getElementById('record-notice').classList.add('hidden');
        document.getElementById('match-over').classList.remove('hidden');
        syncActiveNav('match-over');
    });

    socket.on('receiveGarbage', (lines) => {
        if (currentMode === 'network') {
            game1.receiveGarbage(lines);
        }
    });

    socket.on('opponentGameOver', (data) => {
        if (currentMode === 'network') {
            game1.stop();
            game2.stop();
            toggleGameOverButtons();
            
            if (isSpectator) {
                // data.isHost: 게임오버를 보낸 쪽이 방장인지 여부
                // 방장이 게임오버 → 승자는 게스트(p2-board-name)
                // 게스트가 게임오버 → 승자는 방장(p1-board-name)
                const winnerNickname = data.isHost
                    ? document.getElementById('p2-board-name').innerText
                    : document.getElementById('p1-board-name').innerText;
                document.getElementById('match-result').innerText = winnerNickname + " WIN!";
            } else {
                document.getElementById('match-result').innerText = "YOU WIN!";
            }
            
            document.getElementById('match-score').classList.add('hidden');
            document.getElementById('record-notice').classList.add('hidden');
            document.getElementById('match-over').classList.remove('hidden');
            syncActiveNav('match-over');
        }
    });

    socket.on('opponentDisconnected', () => {
        if (currentMode === 'network') {
            game1.stop();
            toggleGameOverButtons();
            document.getElementById('match-result').innerText = "OPPONENT DISCONNECTED";
            document.getElementById('match-score').classList.add('hidden');
            document.getElementById('record-notice').classList.add('hidden');
            document.getElementById('match-over').classList.remove('hidden');
            syncActiveNav('match-over');
        }
    });

    socket.on('goToWaitingRoom', () => {
        if (currentMode === 'network') {
            document.getElementById('match-over').classList.add('hidden');
            document.getElementById('game-wrapper').classList.add('hidden');
            document.getElementById('ingame-chat-panel').style.display = 'none';
            document.getElementById('room-waiting-menu').classList.remove('hidden');
            syncActiveNav('room-waiting-menu');
            game1.stop();
            game2.stop();
        }
    });

    // 채팅 메시지 수신
    socket.on('chatMessage', (data) => {
        appendChatMessage(data, 'ingame');
        appendChatMessage(data, 'waiting');
    });
}

// 채팅 메시지 DOM에 추가
function appendChatMessage(data, panel) {
    const messagesEl = document.getElementById(panel + '-chat-messages');
    if (!messagesEl) return;

    const roleLabel = data.role === 'spectator' ? '관전' : '참여';
    const roleClass = data.role === 'spectator' ? 'role-spectator' : 'role-player';
    const badgeClass = data.role === 'spectator' ? 'role-badge-spectator' : 'role-badge-player';

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg';
    const nickEl = document.createElement('span');
    nickEl.className = 'chat-nick ' + roleClass;
    nickEl.textContent = data.nickname;

    const badgeEl = document.createElement('span');
    badgeEl.className = 'chat-role-badge ' + badgeClass;
    badgeEl.textContent = roleLabel;

    const textEl = document.createElement('span');
    textEl.className = 'chat-text';
    textEl.textContent = ': ' + data.message;

    msgEl.appendChild(nickEl);
    msgEl.appendChild(badgeEl);
    msgEl.appendChild(textEl);
    messagesEl.appendChild(msgEl);

    // 자동 스크롤
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 채팅 전송 공통 함수
function sendChatMessage(inputId) {
    if (!socket) return;
    const input = document.getElementById(inputId);
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    socket.emit('chatMessage', { message: msg });
    input.value = '';
}

// 채팅 전송 이벤트 바인딩 (대기실)
document.getElementById('waiting-chat-send').addEventListener('click', () => {
    sendChatMessage('waiting-chat-input');
});
document.getElementById('waiting-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); sendChatMessage('waiting-chat-input'); }
});

// 채팅 전송 이벤트 바인딩 (인게임)
document.getElementById('ingame-chat-send').addEventListener('click', () => {
    sendChatMessage('ingame-chat-input');
});
document.getElementById('ingame-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); sendChatMessage('ingame-chat-input'); }
});

// 백그라운드 전환 시 게임 일시 정지 제거 - 백그라운드에서도 게임 계속 진행
// document.addEventListener('visibilitychange', () => {
//     if (document.hidden) {
//         // 페이지가 숨겨질 때 게임 일시 정지
//         if (game1 && game1.isPlaying && !game1.isGameOver) game1.pause();
//         if (game2 && game2.isPlaying && !game2.isGameOver) game2.pause();
//     } else {
//         // 페이지가 다시 보일 때 게임 재개
//         if (game1 && game1.paused) game1.resume();
//         if (game2 && game2.paused) game2.resume();
//     }
// });

// Button Interactions
document.getElementById('btn-network').addEventListener('click', () => {
    currentMode = 'network';
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    if (socket) {
        socket.emit('requestRoomList');
    }
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    document.getElementById('lobby-menu').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
    syncActiveNav('main-menu');
});

document.getElementById('btn-create-room-open').addEventListener('click', () => {
    document.getElementById('lobby-menu').classList.add('hidden');
    document.getElementById('create-room-menu').classList.remove('hidden');
    document.getElementById('input-room-name').value = '';
    document.getElementById('input-room-password').value = '';
    syncActiveNav('create-room-menu');
});

document.getElementById('btn-create-room-cancel').addEventListener('click', () => {
    document.getElementById('create-room-menu').classList.add('hidden');
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
});

document.getElementById('btn-create-room-confirm').addEventListener('click', () => {
    const roomName = document.getElementById('input-room-name').value.trim();
    const password = document.getElementById('input-room-password').value;
    const mode = document.getElementById('input-room-mode').value;
    const rule = document.getElementById('input-room-rule').value;
    myNickname = document.getElementById('input-nickname').value || 'Player 1';
    socket.emit('createRoom', { roomName, password, mode, rule, nickname: myNickname });
});

document.getElementById('btn-join-room-cancel').addEventListener('click', () => {
    document.getElementById('join-room-menu').classList.add('hidden');
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    selectedRoomIdToJoin = null;
});

document.getElementById('btn-join-room-confirm').addEventListener('click', () => {
    const password = document.getElementById('input-join-password').value.trim();
    
    if (socket && selectedRoomIdToJoin) {
        if (isJoinForSpectate) {
            myNickname = document.getElementById('input-nickname').value.trim() || 'Spectator';
            socket.emit('spectateRoom', { roomId: selectedRoomIdToJoin, password, nickname: myNickname });
        } else {
            myNickname = document.getElementById('input-nickname').value.trim() || 'Player 2';
            socket.emit('joinRoom', { roomId: selectedRoomIdToJoin, password, nickname: myNickname });
        }
    }
});

document.getElementById('btn-leave-room').addEventListener('click', () => {
    if (socket) {
        socket.emit('leaveRoom');
    }
    document.getElementById('room-waiting-menu').classList.add('hidden');
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    currentRoomId = null;
    isRoomHost = false;
});

document.getElementById('btn-match-return-room').addEventListener('click', () => {
    if (socket) {
        socket.emit('returnToRoom');
    }
});

if (typeof io !== 'undefined') {
    socket.on('goToWaitingRoom', () => {
        document.getElementById('match-over').classList.add('hidden');
        document.getElementById('game-wrapper').classList.add('hidden');
        document.getElementById('room-waiting-menu').classList.remove('hidden');
        document.getElementById('ingame-chat-panel').style.display = 'none';
        document.getElementById('waiting-chat-messages').innerHTML = '';
        syncActiveNav('room-waiting-menu');
    });
}

document.getElementById('btn-match-leave-lobby').addEventListener('click', () => {
    if (socket) {
        socket.emit('leaveRoom');
    }
    document.getElementById('match-over').classList.add('hidden');
    document.getElementById('game-wrapper').classList.add('hidden');
    document.getElementById('ingame-chat-panel').style.display = 'none';
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    game1.stop();
    game2.stop();
    currentRoomId = null;
    isRoomHost = false;
});

document.getElementById('btn-start-game').addEventListener('click', () => {
    if (isRoomHost && socket) {
        socket.emit('startGame');
    }
});

document.getElementById('btn-ready').addEventListener('click', () => {
    if (!isRoomHost && socket) {
        socket.emit('toggleReady');
    }
});

document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-menu').classList.remove('hidden');
    syncActiveNav('settings-menu');
});
document.getElementById('btn-pause-settings').addEventListener('click', () => {
    document.getElementById('settings-menu').classList.remove('hidden');
    syncActiveNav('settings-menu');
});
document.getElementById('btn-lobby-settings').addEventListener('click', () => {
    document.getElementById('settings-menu').classList.remove('hidden');
    syncActiveNav('settings-menu');
});
document.getElementById('btn-save-settings').addEventListener('click', () => {
    document.getElementById('settings-menu').classList.add('hidden');
});

// Update Log
document.getElementById('btn-update-log-open').addEventListener('click', () => {
    document.getElementById('update-log-menu').classList.remove('hidden');
    syncActiveNav('update-log-menu');
});
document.getElementById('btn-close-update-log').addEventListener('click', () => {
    document.getElementById('update-log-menu').classList.add('hidden');
});

// Match Over Flow
document.getElementById('btn-match-restart').addEventListener('click', () => {
    document.getElementById('match-over').classList.add('hidden');
    if (currentMode === 'versus') sharedPieceSequence = [];
    
    game1.resetBoard();
    if (currentMode === 'versus') game2.resetBoard();
    
    startCountdown(() => {
        game1.startGame();
        if (currentMode === 'versus') {
            game2.startGame();
        }
    });
});

document.getElementById('btn-match-menu').addEventListener('click', () => {
    document.getElementById('match-over').classList.add('hidden');
    document.getElementById('game-wrapper').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
    syncActiveNav('main-menu');
    game1.stop();
    game2.stop();
});

// Pause Flow
document.getElementById('btn-pause-resume').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
    game1.resume();
    if (currentMode === 'versus') game2.resume();
});

document.getElementById('btn-pause-restart').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
    if (currentMode === 'versus') sharedPieceSequence = [];
    
    game1.resetBoard();
    if (currentMode === 'versus') game2.resetBoard();
    
    startCountdown(() => {
        game1.startGame();
        if (currentMode === 'versus') game2.startGame();
    });
});

document.getElementById('btn-pause-menu').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
    document.getElementById('game-wrapper').classList.add('hidden');
    document.getElementById('main-menu').classList.remove('hidden');
    syncActiveNav('main-menu');
    game1.stop();
    game2.stop();
});

// Network Pause Flow
document.getElementById('btn-pause-resume-net').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
});

document.getElementById('btn-pause-lobby').addEventListener('click', () => {
    document.getElementById('pause-menu').classList.add('hidden');
    if (socket) {
        socket.emit('leaveRoom');
    }
    document.getElementById('game-wrapper').classList.add('hidden');
    document.getElementById('ingame-chat-panel').style.display = 'none';
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    game1.stop();
    game2.stop();
    currentRoomId = null;
    isRoomHost = false;
});

// 관전자 LEAVE 버튼
function spectatorLeaveToLobby() {
    if (socket) socket.emit('leaveRoom');
    document.getElementById('game-wrapper').classList.add('hidden');
    document.getElementById('game-wrapper').classList.remove('battle-mode');
    document.getElementById('game-wrapper').classList.remove('spectator-mode');
    document.getElementById('player1').classList.remove('hidden');
    document.getElementById('player2').classList.remove('hidden');
    document.getElementById('battle-opponents-panel').classList.add('hidden');
    document.getElementById('match-over').classList.add('hidden');
    document.getElementById('spectator-leave-btn').classList.add('hidden');
    document.getElementById('ingame-chat-panel').style.display = 'none';
    document.getElementById('lobby-menu').classList.remove('hidden');
    syncActiveNav('lobby-menu');
    game1.stop(); game2.stop();
    Object.values(opponentRenderers).forEach(r => r.remove());
    opponentRenderers = {};
    currentRoomId = null; isRoomHost = false; isSpectator = false;
    roomMode = '1v1';
}

document.getElementById('spectator-leave-btn').addEventListener('click', spectatorLeaveToLobby);

// =============================================
// 인게임 채팅창 드래그 이동 기능
// =============================================
(function () {
    const chatPanel = document.getElementById('ingame-chat-panel');
    const chatHeader = chatPanel.querySelector('.chat-header');

    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // bottom/right 기준 CSS를 top/left 기준으로 전환 (드래그 계산을 위해 필요)
    function switchToTopLeft() {
        const rect = chatPanel.getBoundingClientRect();
        chatPanel.style.top = rect.top + 'px';
        chatPanel.style.left = rect.left + 'px';
        chatPanel.style.bottom = 'auto';
        chatPanel.style.right = 'auto';
    }

    chatHeader.addEventListener('mousedown', (e) => {
        // 채팅 입력창/버튼 클릭은 드래그 제외
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;

        // 아직 top/left로 전환되지 않은 경우 전환
        if (!chatPanel.style.top || chatPanel.style.top === 'auto') {
            switchToTopLeft();
        }

        isDragging = true;
        const rect = chatPanel.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        chatHeader.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        let newLeft = e.clientX - dragOffsetX;
        let newTop  = e.clientY - dragOffsetY;

        // 화면 밖으로 벗어나지 않도록 클램핑
        newLeft = Math.max(0, Math.min(window.innerWidth  - chatPanel.offsetWidth,  newLeft));
        newTop  = Math.max(0, Math.min(window.innerHeight - chatPanel.offsetHeight, newTop));

        chatPanel.style.left = newLeft + 'px';
        chatPanel.style.top  = newTop  + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            chatHeader.style.cursor = 'grab';
        }
    });
})();
