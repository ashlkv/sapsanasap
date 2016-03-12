var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var TelegramBot = require('node-telegram-bot-api');
var q = require('q');
var _ = require('lodash');
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
    var earlyMorningPattern = /рано утром/i;
    var weekendPattern = /выходн/i;
    var yesPattern = /^да[\.!)]*$/i;
    var deferred = q.defer();
    var options = {};

    // To Moscow
    if (toMoscowPattern.test(text)) {
        options.route = Kiosk.Route.toMoscow();
    }
    // To Spb
    if (toSpbPattern.test(text)) {
        options.route = Kiosk.Route.toSpb()
    }
    // Do not include early morning originating tickets unless explicitly asked for
    if (!earlyMorningPattern.test(text)) {
        options.earlyMorning = false;
    }
    // Weekend
    if (weekendPattern.test(text)) {
        options.weekend = true;
    }

    if (!_.isEmpty(options.route)) {
        deferred.resolve(options);
    } else {
        // If the route is not clear, ask for a route
        bot.sendMessage(chatId, 'В Москву или Петербург?');
    }

    return deferred.promise;
};

var main = function() {
    var earlyMorningQuestion = 'Придётся вставать в адскую рань. Найти билет на нормальное время?';

    if (useWebhook) {
        setWebhook();
    } else {
        unsetWebhook();
    }

    // Listen for user messages
    bot.on('message', function(userMessage) {
        var chatId = userMessage.chat.id;
        debug(`Chat: ${chatId}, message: ${userMessage.text}`);
        ask(userMessage)
            .then(function(options) {
                return Analyzer.analyze(options);
            })
            .then(function(roundtrip) {
                var text = Kiosk.formatRoundtrip(roundtrip);
                //if (roundtrip.earlyMorning) {
                //    text += `\n\n${earlyMorningQuestion}`;
                //}
                return bot.sendMessage(chatId, text);
            })
            .then(function(botMessage) {
                //bot.onReplyToMessage(chatId, botMessage.message_id, function(userMessage) {
                //    debug('reply to', botMessage.message_id);
                //});
                debug(`Sent tickets to ${chatId}.`);
            })
            .catch(function(error) {
                console.log(error);
            });
    });
};

var setWebhook = function() {
    bot.setWebHook(`https://${process.env.APP_NAME}/?token=${process.env.TELEGRAM_BOT_TOKEN}`);
};

var unsetWebhook = function() {
    bot.setWebHook();
};

module.exports = {
    main: main,
    setWebhook: setWebhook,
    unsetWebhook: unsetWebhook
};
