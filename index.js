require('dotenv').config();
const { startBot } = require('./bot');
const { startServer } = require('./server');

const discordClient = startBot();
startServer(discordClient);
