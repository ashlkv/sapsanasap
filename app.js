require('dotenv').config();

const useWebhook = Boolean(process.env.USE_WEBHOOK);

var Bot = require('./bot');

if (useWebhook) {
    Bot.setWebhook();
} else {
    Bot.unsetWebhook();
}

Bot.listen();
