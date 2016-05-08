var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var TelegramBot = require('node-telegram-bot-api');

var botan = require('botanio')(process.env.TELEGRAM_BOT_ANALYTICS_TOKEN);
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
 * Figures out search options by parsing user message
 * @param userMessage
 * @returns {Promise}
 */
var extractData = function(userMessage) {
    var text = userMessage.text;
    var chatId = userMessage.chat.id;
    var toMoscowPattern = /^москва|^мск|в москву|москву|в мск|из питера|из петербурга|из санкт|из спб/i;
    var toSpbPattern = /^питер|^петербург|^санкт|^спб|из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
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
    var morePattern = /^ещё|^еще|^ ещё|^ еще/i;

    var filter = {};

    // To Moscow
    if (toMoscowPattern.test(text)) {
        filter.route = Kiosk.Route.toMoscow();
    }
    // To Spb
    if (toSpbPattern.test(text)) {
        filter.route = Kiosk.Route.toSpb()
    }
    // Early morning
    if (earlyMorningPattern.test(text)) {
        filter.earlyMorning = true;
    }
    // Weekend
    if (weekendPattern.test(text)) {
        filter.weekend = true;
    }
    // Price limit
    var priceLimit = text.match(pricePattern);
    if (priceLimit && priceLimit.length) {
        priceLimit = parseInt(priceLimit[0].replace(/ \./g, ''));
        filter.totalCost = !_.isNaN(priceLimit) && priceLimit >= minPriceLimit ? priceLimit : null;
    }
    // Month
    var month = text.match(monthPattern);
    if (month && month.length) {
        month = month[0].replace(/ /g, '');
        var monthKey = _.find(_.keys(monthMap), function(key) {
            var pattern = new RegExp(`^${key}`, 'gi');
            return pattern.test(month);
        });
        filter.month = monthMap[monthKey];
    }

    // More
    var more = morePattern.test(text);

    return Kiosk
        .getChatData(chatId)
        .then(function(previousData) {
            var previousFilter = previousData.filter || {};
            var segment = previousData.segment;

            // If route is set, reset segment parameter
            if (filter.route) {
                segment = 0;
            // If there are some parameters in the new filter (except for the route parameter, which resets the filter), add the previous filter parameters.
            } else {
                filter = !_.isEmpty(filter) || more ? _.extend(previousFilter, filter) : {};
            }
            // If asked for "more tickets" multiple times, increase segment
            if (previousData.more && more) {
                segment = !_.isUndefined(segment) ? segment + 1 : 0;
            }
            return {
                filter: filter,
                more: more,
                segment: segment
            };
        })
        .fail(function() {
            return {filter: filter};
        });
};

var getUserName = function(userMessage) {
    return `${userMessage.chat.first_name || ''} ${userMessage.chat.last_name || ''}`;
};

var analytics = function(userMessage, event) {
    botan.track(userMessage, event);
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
        extractData(userMessage)
            .then(function(data) {
                debug(`Chat ${chatId} ${userName}, message: ${userMessageText}`);
                // If it is a help command
                if (userMessageText === '/help' || userMessageText === '/about') {
                    analytics(userMessage, '/help');

                    bot.sendMessage(chatId, helpText);
                // If the route is clear, search for tickets
                } else if (data.filter.route) {
                    analytics(userMessage, 'route');
                    debug(`Chat: ${chatId} ${userName}, extracted options: ${JSON.stringify(data)}`);
                    Analyzer.analyze(data)
                        .then(function(result) {
                            var botMessageText = '';
                            if (result.message) {
                                botMessageText += `${result.message}\n\n`;
                            }
                            botMessageText += result.roundtrips ? Kiosk.formatRoundtrip(result.roundtrips) : noTicketsText;

                            // Save filter and total roundtrip cost now that we have it.
                            // TODO Do not save totalCost
                            //data.filter.totalCost = result.roundtrips && result.roundtrips.length ? result.roundtrips[0].totalCost : null;
                            //Kiosk.saveChatData(data, chatId);

                            return bot.sendMessage(chatId, botMessageText);
                        })
                        .then(function(botMessage) {
                            var botMessageTextLog = botMessage.text.replace(/\n/g, ' ');
                            debug(`Chat ${chatId} ${userName}, tickets: ${botMessageTextLog}.`);
                        })
                        .catch(function(error) {
                            console.log(error && error.stack);
                        });
                // If route is not clear, ask for a route
                } else {
                    // When writing analytics, there is a difference between starting the conversation and asking an unexpected question.
                    // Sometimes first message text is "/start Start" instead of just "/start": test with regexp
                    analytics(userMessage, /^\/start/i.test(userMessageText) ? '/start' : 'unclear');

                    bot.sendMessage(chatId, routeQuestion)
                        .then(function() {
                            debug(`Chat ${chatId} ${userName}, asked for a route.`);
                        });
                }

                // Store options extracted from user message so that they could be extended next time.
                if (data.filter) {
                    Kiosk.saveChatData(data, chatId);
                }
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
