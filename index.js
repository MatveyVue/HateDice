const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN || '7778325533:AAGMVEgAx74ILn-ypLsUSeh1UqcvfpGJkzY';
const MIN_STAKE = 0.1;
const MAX_STAKE = 5;
const MIN_DEPOSIT = 0.1;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '@whsxt';
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://hate-dice.vercel.app`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');

// TON конфигурация
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET || 'UQBjN5HcGkymGoZLs8Hl4_ELLu0cUvmrckqrAeRa8hXuiIrc';
const API_URL = process.env.API_URL || 'https://toncenter.com/api/v2/jsonRPC';
const API_KEY = process.env.API_KEY || '62baa2e429900335d7e5367e89c7e75c7752c7c83d5fd8a0b3bcb568bd48d1ee';

// Пути к файлам данных
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
    users: path.join(DATA_DIR, 'users.json'),
    balances: path.join(DATA_DIR, 'balances.json'),
    coupons: path.join(DATA_DIR, 'coupons.json'),
    deposits: path.join(DATA_DIR, 'deposits.json')
};

// Создаем директорию для данных, если её нет
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Инициализация бота
const bot = new Telegraf(BOT_TOKEN);

// Инициализация Express для вебхуков
const app = express();
app.use(express.json());

// Загрузка данных
function loadData(fileKey, defaultValue = {}) {
    const filename = FILES[fileKey];
    try {
        if (fs.existsSync(filename)) {
            const data = fs.readFileSync(filename, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error loading ${fileKey}:`, error);
    }
    return defaultValue;
}

// Сохранение данных
function saveData(fileKey, data) {
    const filename = FILES[fileKey];
    try {
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error saving ${fileKey}:`, error);
    }
}

// Инициализация данных
let usersDb = loadData('users');
let userBalances = loadData('balances');
let coupons = loadData('coupons');
let processedDeposits = loadData('deposits');

// Сохранение данных при выходе
process.on('SIGINT', () => {
    console.log('Saving data before shutdown...');
    saveData('users', usersDb);
    saveData('balances', userBalances);
    saveData('coupons', coupons);
    saveData('deposits', processedDeposits);
    process.exit(0);
});

// Функции для работы с пользователями
function addUser(user) {
    const username = user.username;
    const userId = user.id;

    if (username && !usersDb[username]) {
        usersDb[username] = userId;
        saveData('users', usersDb);
        console.log(`Added user @${username} with ID ${userId}`);
    }
}

function getBalance(userId) {
    try {
        return parseFloat(userBalances[userId] || 0);
    } catch (error) {
        console.error(`Error getting balance for user ${userId}:`, error);
        return 0;
    }
}

function updateBalance(userId, amount) {
    try {
        const current = getBalance(userId);
        const newBalance = Math.max(0, current + parseFloat(amount));
        userBalances[userId] = newBalance;
        saveData('balances', userBalances);
        return newBalance;
    } catch (error) {
        console.error(`Error updating balance for user ${userId}:`, error);
        return 0;
    }
}

function isAdmin(user) {
    const adminUsernames = (process.env.ADMIN_USERNAMES || 'bunxor,whsxg,haterusers').split(',');
    return adminUsernames.includes(user.username);
}

// Класс для мониторинга депозитов
class TonDepositMonitor {
    constructor(bot) {
        this.bot = bot;
        this.isRunning = false;
        this.checkInterval = null;
    }

    decodeComment(msgData) {
        if (!msgData) return null;

        try {
            if (typeof msgData === 'object') {
                if (msgData['@type'] === 'msg.dataText') {
                    let textB64 = msgData.text || '';
                    if (textB64.startsWith('base64:')) {
                        textB64 = textB64.substring(7);
                    }
                    if (textB64) {
                        try {
                            const decoded = Buffer.from(textB64, 'base64').toString('utf-8');
                            return decoded;
                        } catch {
                            return textB64;
                        }
                    }
                } else if (msgData.text) {
                    return msgData.text;
                } else if (msgData.body) {
                    try {
                        const decoded = Buffer.from(msgData.body, 'base64').toString('utf-8');
                        return decoded;
                    } catch {
                        return msgData.body;
                    }
                }
            }
        } catch (error) {
            console.error('Error decoding comment:', error);
        }
        return null;
    }

    async getRecentTransactions(limit = 20) {
        const headers = {
            'Content-Type': 'application/json',
            ...(API_KEY && { 'X-API-Key': API_KEY })
        };

        const payload = {
            id: 1,
            jsonrpc: "2.0",
            method: "getTransactions",
            params: {
                address: DEPOSIT_WALLET,
                limit: limit
            }
        };

        console.log(`Requesting transactions for wallet: ${DEPOSIT_WALLET}`);

        try {
            const response = await axios.post(API_URL, payload, { 
                headers, 
                timeout: 15000 
            });

            if (response.status === 200) {
                const data = response.data;
                
                if (data.error) {
                    console.error('API Error:', data.error);
                    return [];
                }

                const result = data.result || [];
                console.log(`✅ Received ${result.length} transactions`);
                return result;
            } else {
                console.error(`❌ API returned status ${response.status}`);
                return [];
            }
        } catch (error) {
            console.error('Error fetching transactions:', error.message);
            return [];
        }
    }

    async checkDeposits() {
        try {
            const transactions = await this.getRecentTransactions(20);
            let newProcessed = 0;

            for (const tx of transactions) {
                try {
                    let txHash = tx.hash || '';
                    let lt = tx.lt || 0;

                    if (!txHash || !lt) {
                        txHash = tx.transaction_id?.hash || '';
                        lt = tx.transaction_id?.lt || 0;
                    }

                    if (!txHash || !lt) {
                        console.debug('Skipping transaction without hash or lt');
                        continue;
                    }

                    const txId = `${txHash}:${lt}`;

                    if (processedDeposits[txId]) {
                        continue;
                    }

                    const inMsg = tx.in_msg || {};

                    if (inMsg && typeof inMsg === 'object') {
                        const valueNano = parseInt(inMsg.value || 0);
                        const amountTon = valueNano / 1000000000;

                        if (amountTon >= MIN_DEPOSIT) {
                            const msgData = inMsg.msg_data || inMsg.data || {};
                            const comment = this.decodeComment(msgData);

                            if (comment) {
                                const cleanComment = comment.trim();
                                console.log(`💰 Found transaction: '${cleanComment}', amount: ${amountTon.toFixed(2)} TON`);

                                let username = null;
                                const parts = cleanComment.split(/\s+/);

                                for (const part of parts) {
                                    if (part.startsWith('@')) {
                                        username = part.substring(1);
                                        break;
                                    } else if (/^[a-zA-Z0-9_]+$/.test(part) && part.length > 2) {
                                        if (usersDb[part]) {
                                            username = part;
                                            break;
                                        }
                                    }
                                }

                                if (!username && parts.length > 0) {
                                    const possibleUsername = parts[0];
                                    if (usersDb[possibleUsername]) {
                                        username = possibleUsername;
                                    }
                                }

                                if (username && usersDb[username]) {
                                    const userId = usersDb[username];
                                    const newBalance = updateBalance(userId, amountTon);

                                    processedDeposits[txId] = {
                                        username,
                                        amount: amountTon,
                                        timestamp: new Date().toISOString(),
                                        tx_hash: txHash,
                                        comment: cleanComment
                                    };
                                    saveData('deposits', processedDeposits);

                                    try {
                                        await this.bot.telegram.sendMessage(
                                            userId,
                                            `✅ Deposit successful!\n\n💰 Amount: ${amountTon.toFixed(2)} TON\n💎 New balance: ${newBalance.toFixed(2)} TON\n\nThank you for your deposit!`
                                        );
                                        console.log(`✅ Deposit processed for @${username}: ${amountTon.toFixed(2)} TON`);
                                        newProcessed++;
                                    } catch (error) {
                                        console.error(`Failed to notify user @${username}:`, error);
                                    }
                                } else {
                                    console.warn(`User @${username} not found in database for transaction ${txId}`);
                                }
                            }
                        }
                    }

                    if (!processedDeposits[txId]) {
                        processedDeposits[txId] = {
                            processed: true,
                            timestamp: new Date().toISOString()
                        };
                    }

                } catch (error) {
                    console.error('Error processing transaction:', error.message);
                }
            }

            if (newProcessed > 0) {
                console.log(`✅ Processed ${newProcessed} new deposits`);
                saveData('deposits', processedDeposits);
            }

        } catch (error) {
            console.error('Error checking deposits:', error);
        }
    }

    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('🚀 TON deposit monitoring started (30 second intervals)');
        
        this.checkDeposits(); // Первая проверка сразу
        
        this.checkInterval = setInterval(() => {
            this.checkDeposits();
        }, 30000); // Проверка каждые 30 секунд
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.isRunning = false;
        console.log('⏹️ Deposit monitoring stopped');
    }
}

// Инициализация монитора
const depositMonitor = new TonDepositMonitor(bot);

// Обработчики команд
bot.start(async (ctx) => {
    const user = ctx.from;
    addUser(user);
    const balance = getBalance(user.id);

    const keyboard = [
        [Markup.button.callback('🎲 Make a bet', 'make_bet')],
        [Markup.button.callback('📥 Deposit', 'deposit')],
        [Markup.button.callback('📤 Withdrawal', 'withdrawal')],
        [Markup.button.callback('🎁 Use coupon', 'redeem_coupon')]
    ];

    if (isAdmin(user)) {
        keyboard.push([Markup.button.callback('🛠 Admin Panel', 'admin_panel')]);
    }

    const welcome = `👋 Hello, ${user.first_name}!\nWelcome to Hate Dice!\n\n💎 Balance: ${balance.toFixed(2)} TON\n\n🎰 Try your luck in dice game!\n💰 Deposit TON to start playing`;

    return ctx.reply(welcome, Markup.inlineKeyboard(keyboard));
});

// Команда баланса
bot.command('balance', (ctx) => {
    const user = ctx.from;
    const balance = getBalance(user.id);
    
    const text = `💎 Your Balance: ${balance.toFixed(4)} TON\n\n📊 Balance information:\n• Available for betting: ${balance.toFixed(2)} TON\n• Minimum bet: ${MIN_STAKE} TON\n• Minimum withdrawal: 0.5 TON\n\nUse /deposit to add funds or /withdrawal to withdraw.`;
    
    return ctx.reply(text);
});

// Команда депозита
bot.command('deposit', (ctx) => {
    const user = ctx.from;
    const comment = user.username ? `@${user.username}` : user.id.toString();
    
    const text = `📥 Deposit TON\n\n📍 Address: ${DEPOSIT_WALLET}\n\n🔑 Comment/Memo: ${comment}\n\n⚠️ Minimum: ${MIN_DEPOSIT} TON\n⏱ Processing: Automatic within 10-30 seconds\n\n💎 Your balance: ${getBalance(user.id).toFixed(2)} TON`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to Menu', 'back')]
    ]);
    
    return ctx.reply(text, keyboard);
});

// Команда вывода
bot.command('withdrawal', (ctx) => {
    const user = ctx.from;
    const balance = getBalance(user.id);
    const adminUsername = ADMIN_USERNAME.replace('@', '');
    
    const text = `📤 Withdrawal Information\n\n💎 Available balance: ${balance.toFixed(2)} TON\n\n📝 To withdraw your funds:\n1. Contact admin ${ADMIN_USERNAME}\n2. Provide your TON wallet address\n3. Specify withdrawal amount\n\n⚠️ Requirements:\n• Minimum withdrawal: 0.5 TON\n• Processing time: 1-24 hours\n• Only TON withdrawals\n\n💬 Click the button below to contact admin:`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url(`💬 Write to ${ADMIN_USERNAME}`, `https://t.me/${adminUsername}`)],
        [Markup.button.callback('⬅️ Back to Menu', 'back')]
    ]);
    
    return ctx.reply(text, keyboard);
});

// Игра в кости
async function playDiceGame(ctx, betAmount) {
    const user = ctx.from;
    const balance = getBalance(user.id);

    if (betAmount > balance) {
        return ctx.reply(`🚫 Not enough funds. Balance: ${balance.toFixed(2)} TON`);
    }
    if (betAmount < MIN_STAKE) {
        return ctx.reply(`🚫 Minimum bet is ${MIN_STAKE} TON.`);
    }
    if (betAmount > MAX_STAKE) {
        return ctx.reply(`🚫 Maximum bet is ${MAX_STAKE} TON.`);
    }

    updateBalance(user.id, -betAmount);
    
    const dice = await ctx.replyWithDice();
    
    setTimeout(async () => {
        const diceValue = dice.dice.value;
        
        if (diceValue >= 4) {
            const win = parseFloat((betAmount * 2).toFixed(4));
            updateBalance(user.id, win);
            const newBalance = getBalance(user.id);

            const result = `🎉 VICTORY!\n\n🎲 Dice: ${diceValue}\n💰 Bet: ${betAmount.toFixed(2)} TON\n🎯 Win: ${win.toFixed(2)} TON (2x)\n💎 New balance: ${newBalance.toFixed(2)} TON\n\n✨ Congratulations!`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🎲 Play Again', 'make_bet')],
                [Markup.button.callback('⬅️ Menu', 'back')]
            ]);
            
            await ctx.reply(result, keyboard);
        } else {
            const newBalance = getBalance(user.id);
            const result = `😞 DEFEAT\n\n🎲 Dice: ${diceValue}\n💰 Bet: ${betAmount.toFixed(2)} TON\n💎 New balance: ${newBalance.toFixed(2)} TON\n\n💪 Try again!`;
            
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🎲 Play Again', 'make_bet')],
                [Markup.button.callback('⬅️ Menu', 'back')]
            ]);
            
            await ctx.reply(result, keyboard);
        }
    }, 2000);
}

// Обработка inline-кнопок
bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery();
    const data = ctx.callbackQuery.data;
    const user = ctx.from;

    switch (data) {
        case 'back':
            const balance = getBalance(user.id);
            const keyboard = [
                [Markup.button.callback('🎲 Make a bet', 'make_bet')],
                [Markup.button.callback('📥 Deposit', 'deposit')],
                [Markup.button.callback('📤 Withdrawal', 'withdrawal')],
                [Markup.button.callback('🎁 Use coupon', 'redeem_coupon')]
            ];

            if (isAdmin(user)) {
                keyboard.push([Markup.button.callback('🛠 Admin Panel', 'admin_panel')]);
            }

            const welcome = `👋 Hello, ${user.first_name}!\nWelcome to Hate Dice!\n\n💎 Balance: ${balance.toFixed(2)} TON\n\n🎰 Try your luck in dice game!\n💰 Deposit TON to start playing`;

            return ctx.editMessageText(welcome, Markup.inlineKeyboard(keyboard));

        case 'make_bet':
            return ctx.editMessageText(`🎲 Enter bet amount (${MIN_STAKE}-${MAX_STAKE} TON):`);

        case 'deposit':
            return depositCommand(ctx);
            
        case 'withdrawal':
            return withdrawalCommand(ctx);
            
        case 'redeem_coupon':
            return ctx.editMessageText('🔑 Enter coupon code:');
            
        case 'admin_panel':
            const adminKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📊 All balances', 'admin_balances')],
                [Markup.button.callback('➕ Add TON', 'admin_add')],
                [Markup.button.callback('➖ Remove TON', 'admin_remove')],
                [Markup.button.callback('📝 Create coupon', 'admin_createcoupon')],
                [Markup.button.callback('🌐 Network Info', 'admin_network')],
                [Markup.button.callback('🔄 Check deposits', 'admin_check_deposits')],
                [Markup.button.callback('📋 Debug info', 'admin_debug')],
                [Markup.button.callback('⬅️ Back', 'back')]
            ]);
            return ctx.editMessageText('🛠 Admin Panel:', adminKeyboard);
            
        case 'admin_balances':
            try {
                let text = "📊 User balances:\n\n";
                let total = 0;
                let count = 0;

                const validUsers = [];
                for (const [username, userId] of Object.entries(usersDb)) {
                    try {
                        const bal = getBalance(userId);
                        if (typeof bal === 'number') {
                            total += bal;
                            validUsers.push([username, userId, bal]);
                            count++;
                        }
                    } catch (error) {
                        console.error(`Error getting balance for @${username}:`, error);
                    }
                }

                validUsers.sort((a, b) => b[2] - a[2]);

                const displayLimit = 50;
                for (const [username, userId, bal] of validUsers.slice(0, displayLimit)) {
                    text += `@${username}: ${bal.toFixed(2)} TON\n`;
                }

                if (count > displayLimit) {
                    text += `\n... and ${count - displayLimit} more users\n`;
                }

                let totalBalanceSum = 0;
                for (const [userId, balance] of Object.entries(userBalances)) {
                    if (typeof balance === 'number') {
                        totalBalanceSum += balance;
                    }
                }

                text += `\nTotal balance (sum): ${totalBalanceSum.toFixed(2)} TON`;
                text += `\nUsers shown: ${Math.min(count, displayLimit)}`;
                text += `\nTotal users in DB: ${Object.keys(usersDb).length}`;

                const backKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Back', 'admin_panel')]
                ]);
                
                return ctx.editMessageText(text, backKeyboard);
            } catch (error) {
                console.error('Error displaying admin balances:', error);
                const errorText = `❌ Error displaying balances:\n${error.message.substring(0, 200)}`;
                const backKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Back', 'admin_panel')]
                ]);
                return ctx.editMessageText(errorText, backKeyboard);
            }

        case 'admin_check_deposits':
            try {
                await ctx.editMessageText('🔄 Checking deposits...');
                await depositMonitor.checkDeposits();
                return ctx.editMessageText('✅ Manual deposit check completed!', 
                    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin_panel')]])
                );
            } catch (error) {
                return ctx.editMessageText(`❌ Error checking deposits: ${error.message.substring(0, 100)}`,
                    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin_panel')]])
                );
            }
            
        case 'admin_debug':
            try {
                await ctx.editMessageText('🔧 Testing API connection...');
                const transactions = await depositMonitor.getRecentTransactions(5);
                
                let text;
                if (transactions.length > 0) {
                    text = `✅ API Connection Successful\n\nStatus: Connected to TON Center\nTransactions found: ${transactions.length}\nLast transaction preview:`;
                    
                    if (transactions.length > 0) {
                        const tx = transactions[0];
                        const txHash = tx.hash ? `${tx.hash.substring(0, 20)}...` : 'N/A';
                        const lt = tx.lt || 'N/A';
                        text += `\n• Hash: ${txHash}\n• LT: ${lt}`;
                    }
                } else {
                    text = `❌ API Connection Issue\n\nStatus: No transactions received\nPossible issues:\n1. API Key incorrect\n2. Wallet has no transactions\n3. Network issue\n4. API endpoint changed\n\nDetails:\n• Wallet: ${DEPOSIT_WALLET}\n• API: ${API_URL}\n• API Key: ${API_KEY ? '✅ Set' : '❌ Missing'}`;
                }
                
                const backKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Back', 'admin_panel')]
                ]);
                
                return ctx.editMessageText(text, backKeyboard);
            } catch (error) {
                return ctx.editMessageText(`❌ API Test Failed: ${error.message.substring(0, 200)}`,
                    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin_panel')]])
                );
            }
            
        case 'admin_network':
            try {
                let totalBalanceSum = 0;
                for (const [userId, balance] of Object.entries(userBalances)) {
                    if (typeof balance === 'number') {
                        totalBalanceSum += balance;
                    }
                }

                const text = `🌐 Network Information\n\nNetwork: TON Mainnet\nDeposit wallet: ${DEPOSIT_WALLET}\nAPI: ${API_URL}\nCheck interval: 30 seconds\nMin deposit: ${MIN_DEPOSIT} TON\n\nStatistics:\n• Processed deposits: ${Object.keys(processedDeposits).length}\n• Total users: ${Object.keys(usersDb).length}\n• Total balance: ${totalBalanceSum.toFixed(2)} TON\n\nMonitoring: ${depositMonitor.isRunning ? '✅ ACTIVE' : '❌ INACTIVE'}`;
                
                const backKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Back', 'admin_panel')]
                ]);
                
                return ctx.editMessageText(text, backKeyboard);
            } catch (error) {
                console.error('Error displaying network info:', error);
                const errorText = `❌ Error displaying network info:\n${error.message.substring(0, 200)}`;
                const backKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ Back', 'admin_panel')]
                ]);
                return ctx.editMessageText(errorText, backKeyboard);
            }
            
        default:
            return ctx.editMessageText('Unknown command');
    }
});

// Обработка сообщений
bot.on('text', async (ctx) => {
    const user = ctx.from;
    const text = ctx.message.text.trim();
    
    addUser(user);
    
    // Проверка на число (ставка)
    const betAmount = parseFloat(text);
    if (!isNaN(betAmount) && text === betAmount.toString()) {
        return playDiceGame(ctx, betAmount);
    }
    
    // Проверка на купон
    if (coupons[text]) {
        const amount = coupons[text];
        updateBalance(user.id, amount);
        delete coupons[text];
        saveData('coupons', coupons);
        return ctx.reply(`✅ Coupon activated! +${amount.toFixed(4)} TON`);
    }
    
    // Админ команды
    if (isAdmin(user)) {
        // Добавление TON
        if (text.includes('@') && text.includes(' ')) {
            const parts = text.split(/\s+/);
            const username = parts[0].startsWith('@') ? parts[0].substring(1) : parts[0];
            const amount = parseFloat(parts[1]);
            
            if (!isNaN(amount) && usersDb[username]) {
                const newBalance = updateBalance(usersDb[username], amount);
                return ctx.reply(`✅ ${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount).toFixed(2)} TON to @${username}\n💰 New balance: ${newBalance.toFixed(2)} TON`);
            }
        }
        
        // Создание купона
        if (text.includes(' ') && text.split(' ').length === 2) {
            const [code, amountStr] = text.split(' ');
            const amount = parseFloat(amountStr);
            
            if (!isNaN(amount)) {
                coupons[code] = amount;
                saveData('coupons', coupons);
                return ctx.reply(`✅ Coupon '${code}' created for ${amount.toFixed(4)} TON`);
            }
        }
    }
    
    // Если не распознано, показываем стартовое меню
    return bot.start(ctx);
});

// Функция для команд депозита и вывода (используется в callback)
function depositCommand(ctx) {
    const user = ctx.from || ctx.callbackQuery.from;
    const comment = user.username ? `@${user.username}` : user.id.toString();
    
    const text = `📥 Deposit TON\n\n📍 Address: ${DEPOSIT_WALLET}\n\n🔑 Comment/Memo: ${comment}\n\n⚠️ Minimum: ${MIN_DEPOSIT} TON\n⏱ Processing: Automatic within 10-30 seconds\n\n💎 Your balance: ${getBalance(user.id).toFixed(2)} TON`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ Back to Menu', 'back')]
    ]);
    
    return ctx.editMessageText(text, keyboard);
}

function withdrawalCommand(ctx) {
    const user = ctx.from || ctx.callbackQuery.from;
    const balance = getBalance(user.id);
    const adminUsername = ADMIN_USERNAME.replace('@', '');
    
    const text = `📤 Withdrawal Information\n\n💎 Available balance: ${balance.toFixed(2)} TON\n\n📝 To withdraw your funds:\n1. Contact admin ${ADMIN_USERNAME}\n2. Provide your TON wallet address\n3. Specify withdrawal amount\n\n⚠️ Requirements:\n• Minimum withdrawal: 0.5 TON\n• Processing time: 1-24 hours\n• Only TON withdrawals\n\n💬 Click the button below to contact admin:`;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.url(`💬 Write to ${ADMIN_USERNAME}`, `https://t.me/${adminUsername}`)],
        [Markup.button.callback('⬅️ Back to Menu', 'back')]
    ]);
    
    return ctx.editMessageText(text, keyboard);
}

// Middleware для сессий
bot.use(session());

// Запуск бота с вебхуками
async function startBot() {
    try {
        // Установка вебхука
        await bot.telegram.setWebhook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
        
        // Настройка обработчика вебхуков
        app.post(`/bot${BOT_TOKEN}`, (req, res) => {
            bot.handleUpdate(req.body, res);
        });
        
        // Маршрут для проверки здоровья
        app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                bot: 'running',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });
        
        // Запуск Express сервера
        app.listen(PORT, () => {
            console.log('='.repeat(60));
            console.log('🎰 TON Casino Bot - JavaScript Version');
            console.log('='.repeat(60));
            console.log(`💰 Min bet: ${MIN_STAKE} TON`);
            console.log(`💰 Max bet: ${MAX_STAKE} TON`);
            console.log(`📥 Min deposit: ${MIN_DEPOSIT} TON`);
            console.log(`📤 Withdraw admin: ${ADMIN_USERNAME}`);
            console.log('🎲 Dice game is active!');
            console.log('='.repeat(60));
            console.log('🌐 **WEBHOOK MODE ACTIVATED**');
            console.log(`📡 Webhook URL: ${WEBHOOK_URL}/bot${BOT_TOKEN}`);
            console.log(`🌐 Network: TON Mainnet`);
            console.log(`📍 Deposit wallet: ${DEPOSIT_WALLET}`);
            console.log(`🔗 API: ${API_URL}`);
            console.log(`🔑 API Key: ${API_KEY ? '✅ Set' : '❌ Missing'}`);
            console.log(`⏱ Check interval: 30 seconds`);
            console.log('='.repeat(60));
            console.log('✅ Bot is ready! Deposits will be processed automatically.');
            console.log('✅ Users MUST include @username in transaction COMMENT/MEMO field.');
            console.log('✅ Running on port:', PORT);
            console.log('='.repeat(60));
            
            // Запуск мониторинга депозитов
            depositMonitor.start();
        });
        
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

// Обработка ошибок
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
});

// Запуск приложения
startBot();
