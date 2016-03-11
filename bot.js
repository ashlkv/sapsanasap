var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var TelegramBot = require('node-telegram-bot-api');
var q = require('q');
var debug = require('debug')('bot');

const useWebhook = Boolean(process.env.USE_WEBHOOK);

// Webhook for remote, polling for local
var options = useWebhook ? {
    webHook: {
        port: process.env.PORT || 5000
    }
} : {polling: true};

var bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, options);

var ask = function(userMessage) {
    var chatId = userMessage.chat.id;
    var text = userMessage.text;
    var toMoscowPattern = /в москву|в мск|из питера|из петербурга|из санкт|из спб/i;
    var toSpbPattern = /из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
    var deferred = q.defer();

    // To Moscow
    if (toMoscowPattern.test(text)) {
        deferred.resolve({
            route: Kiosk.toMoscow()
        });
    // To Spb
    } else if (toSpbPattern.test(text)) {
        deferred.resolve({
            route: Kiosk.toSpb()
        });
    } else {
        // If the route is not clear, ask for a route
        bot.sendMessage(chatId, 'В Москву или Петербург?');
    }

    return deferred.promise;
};

var listen = function() {
    // Listen for user messages
    bot.on('message', function(userMessage) {
        var chatId = userMessage.chat.id;
        debug(`Chat: ${chatId}, message: ${userMessage.text}`);
        ask(userMessage)
            .then(function(options) {
                return Analyzer.analyze(options);
            })
            .then(function(text) {
                return bot.sendMessage(chatId, text);
            })
            .then(function() {
                debug(`Sent tickets to ${chatId}.`);
            });
    });
};

var setWebhook = function() {
    bot.setWebHook(`https://${process.env.APP_NAME}/?token=${process.env.TELEGRAM_BOT_TOKEN}`);
};

var unsetWebhook = function() {
    bot.setWebHook('');
};

module.exports = {
    listen: listen,
    setWebhook: setWebhook,
    unsetWebhook: unsetWebhook
};
