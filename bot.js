var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var TelegramBot = require('node-telegram-bot-api');
var q = require('q');
var _ = require('lodash');
var debug = require('debug')('bot');

const useWebhook = Boolean(process.env.USE_WEBHOOK);
const routeQuestion = 'В Москву или Петербург?';
const helpText = 'Напишите «в Питер на выходные» или «в Москву, можно рано утром» или «в Москву за 3000» или просто «в Москву»';
const noTicketsText = 'Что-то пошло не так: не могу найти билет.';

const minPriceLimit = 1000;

// Webhook for remote, polling for local
var options = useWebhook ? {
    webHook: {
        port: process.env.PORT || 5000
    }
} : {polling: true};

var bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, options);
/**
 * Indicates if route question was just asked
 * @type {boolean}
 */
var routeQuestionAsked = false;

/**
 * Figures out search options by parsing user message
 * @param userMessage
 * @returns {Object}
 */
var extractOptions = function(userMessage) {
    var text = userMessage.text;
    var toMoscowPattern = /в москву|в мск|из питера|из петербурга|из санкт|из спб/i;
    var toSpbPattern = /из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
    var earlyMorningPattern = /рано утром/i;
    var weekendPattern = /выходн/i;
    var pricePattern = /\d+([ \.]{1}\d+)?/g;
    var monthPattern = / (январ|феврал|март|апрел|май|мая|мае|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*/gi;
    var monthMap = {
        'янв': 0,
        'фев': 1,
        'мар': 2,
        'апр': 3,
        'май': 4,
        'мая': 4,
        'мае': 4,
        'июн': 5,
        'июл': 6,
        'авг': 7,
        'сен': 8,
        'окт': 9,
        'ноя': 10,
        'дек': 11
    };

    var options = {};

    // To Moscow
    if (toMoscowPattern.test(text)) {
        options.route = Kiosk.Route.toMoscow();
    }
    // To Spb
    if (toSpbPattern.test(text)) {
        options.route = Kiosk.Route.toSpb()
    }
    // Do not include early morning originating tickets unless explicitly asked
    if (!earlyMorningPattern.test(text)) {
        options.earlyMorning = false;
    }
    // Weekend
    if (weekendPattern.test(text)) {
        options.weekend = true;
    }
    // Price limit
    var priceLimit = text.match(pricePattern);
    if (priceLimit && priceLimit.length) {
        priceLimit = parseInt(priceLimit[0].replace(/ \./g, ''));
        options.totalCost = !_.isNaN(priceLimit) && priceLimit >= minPriceLimit ? priceLimit : null;
    }
    // Month
    var month = text.match(monthPattern);
    if (month && month.length) {
        month = month[0].replace(/ /g, '');
        var monthKey = _.find(_.keys(monthMap), function(key) {
            var pattern = new RegExp(`^${key}`, 'gi');
            return pattern.test(month);
        });
        options.month = monthMap[monthKey];
    }

    return options;
};

var getUserName = function(userMessage) {
    return `${userMessage.chat.first_name || ''} ${userMessage.chat.last_name || ''}`;
};

var main = function() {
    if (useWebhook) {
        setWebhook();
    } else {
        unsetWebhook();
    }

    // Listen for user messages
    bot.on('message', function(userMessage) {
        var chatId = userMessage.chat.id;
        var userName = getUserName(userMessage);
        var userMessageText = userMessage.text;
        var options = extractOptions(userMessage);
        debug(`Chat ${chatId} ${userName}, message: ${userMessageText}`);
        // If it is a help command
        if (userMessageText === '/help' || userMessageText === '/about') {
            routeQuestionAsked = false;
            bot.sendMessage(chatId, helpText);
        // If the route is clear, search for tickets
        } else if (options.route) {
            debug(`Chat: ${chatId} ${userName}, extracted options: ${JSON.stringify(options)}`);
            routeQuestionAsked = false;
            Analyzer.analyze(options)
                .then(function(result) {
                    var botMessageText = '';
                    if (result.message) {
                        botMessageText += `${result.message}\n\n`;
                    }
                    botMessageText += result.roundtrip ? Kiosk.formatRoundtrip(result.roundtrip) : noTicketsText;
                    return bot.sendMessage(chatId, botMessageText);
                })
                .then(function(botMessage) {
                    var botMessageTextLog = botMessage.text.replace(/\n/g, ' ');
                    debug(`Chat ${chatId} ${userName}, tickets: ${botMessageTextLog}.`);
                })
                .catch(function(error) {
                    console.log(error && error.stack);
                });
        // If route is not clear and route question was not asked previously, ask for a route
        } else if (!routeQuestionAsked) {
            routeQuestionAsked = true;
            bot.sendMessage(chatId, routeQuestion)
                .then(function() {
                    debug(`Chat ${chatId} ${userName}, asked for a route.`);
                });
        // If route question was just asked, and route is still unclear, show help
        } else {
            routeQuestionAsked = false;
            bot.sendMessage(chatId, helpText);
        }
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
