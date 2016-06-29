var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var TelegramBot = require('node-telegram-bot-api');

var botan = require('botanio')(process.env.TELEGRAM_BOT_ANALYTICS_TOKEN);
var _ = require('lodash');
var moment = require('moment');
var debug = require('debug')('bot');

var Promise = require('bluebird');

const useWebhook = Boolean(process.env.USE_WEBHOOK);
const routeQuestion = 'В Москву или Петербург?';
const helpText = 'Напишите «в Питер на выходные» или «в Москву, можно рано утром» или «в Москву за 3000» или просто «в Москву». Напишите «ещё» чтобы посмотреть другие варианты.';
const noTicketsText = 'Что-то пошло не так: не могу найти билет.';

const minPriceLimit = 1000;

const toMoscowPattern = /^москва|^мск|.москва|в москву|москву|мовску|моску|мсокву|в мск|из питера|из петербурга|из санкт|из спб/i;
const toSpbPattern = /^питер|^петербург|^петебург|^петепбург|^петер|^петрбург|^санкт|^спб|из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
const earlyMorningPattern = /рано утром/i;
const weekendPattern = /выходн/i;
const pricePattern = /\d+([ \.]{1}\d+)?/g;
const monthPattern = /(январ|феврал|март|апрел|май|мая|мае|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*/gi;
const monthMap = {
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
const morePattern = /^ещё|^еще|^ ещё|^ еще/i;
const specificDatePattern1 = /\d+ (январ|феврал|март|апрел|май|мая|мае|июн|июл|август|сентябр|октябр|ноябр|декабр)/gi;
const specificDatePattern2 = /\d+\.\d+\.\d{4}/;
const specificDatePattern3 = /\d+\.\d+/;
const tomorrowPattern = /завтра/gi;
const thereAndBackPattern = /туда и обратно/gi;

const commonRequests = {
    // Help request
    '^\/(help|about)$': function(text, match, userMessage) {
        analytics(userMessage, '/help');
        return helpText;
    },
    'беру': function(text, match, userMessage, previousRoundtrip) {
        analytics(userMessage, 'purchase');
        return sendLink(previousRoundtrip);
    },
    'ссылк': function(text, match, userMessage, previousRoundtrip) {
        analytics(userMessage, 'link');
        return sendLink(previousRoundtrip);
    },
    'привет': function(text, match, userMessage) {
        analytics(userMessage, 'greeting');
        return 'Привет';
    }
};

// Webhook for remote, polling for local
var options = useWebhook ? {
    webHook: {
        port: process.env.PORT || 5000
    }
} : {polling: true};

var bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, options);

/**
 * Figures out search options by parsing user message
 * @param {String} text
 * @param {Number} [chatId]
 * @returns {Promise}
 */
var extractData = function(text, chatId) {
    var filter = {};

    // To Moscow
    if (toMoscowPattern.test(text)) {
        filter.route = Kiosk.Route.toMoscow();
    }
    // To Spb
    if (toSpbPattern.test(text)) {
        filter.route = Kiosk.Route.toSpb()
    }
    // If asking for "туда и обратно", assuming destination is Moscow, since the question is "В Москву или Петербург?"
    if (thereAndBackPattern.test(text)) {
        filter.route = Kiosk.Route.toMoscow();
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
    var month = extractMonth(text);
    if (!_.isUndefined(month)) {
        filter.month = month;
    }
    // Specific date in various formats
    var specificDate1 = text.match(specificDatePattern1);
    if (specificDate1 && !_.isUndefined(month)) {
        var year = (new Date()).getFullYear();
        var day = parseInt(specificDate1[0]);
        // If it was a secific date request, remove month from filter.
        delete filter.month;
        filter.originatingTicket = {
            date: moment([year, month, day]).toDate()
        };
    }
    var specificDate2 = text.match(specificDatePattern2);
    if (specificDate2) {
        filter.originatingTicket = {
            date: moment(specificDate2[0], 'DD.MM.YYYY').toDate()
        };
    }
    var specificDate3 = text.match(specificDatePattern3);
    if (specificDate3) {
        filter.originatingTicket = {
            date: moment(specificDate3[0], 'DD.MM').toDate()
        };
    }
    var tomorrow = text.match(tomorrowPattern);
    if (tomorrow) {
        filter.originatingTicket = {
            date: moment().add(1, 'day').startOf('day').toDate()
        };
    }
    // More
    var more = morePattern.test(text);

    return Kiosk
        .getHistory(chatId)
        .then(function(previousData) {
            var previousFilter = previousData.filter || {};
            var segment = previousData.segment;

            // Make sure month or date from current filter do not conflict with previous filter month or date
            if (filter.month && previousFilter.originatingTicket && previousFilter.originatingTicket.date) {
                delete previousFilter.originatingTicket.date
            }
            if (filter.originatingTicket && filter.originatingTicket.date) {
                delete previousFilter.month;
            }

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
        .catch(function() {
            return {filter: filter};
        });
};

/**
 * Extracts month from text
 * @param {String} text
 * @returns {Number} Integer from 0 to 11
 */
var extractMonth = function(text) {
    var month = text.match(monthPattern);
    var monthNumber;
    if (month && month.length) {
        month = month[0].replace(/ /g, '');
        var monthKey = _.find(_.keys(monthMap), function(key) {
            var pattern = new RegExp(`^${key}`, 'gi');
            return pattern.test(month);
        });
        monthNumber = monthMap[monthKey];
    }
    return monthNumber;
};

/**
 * Attempts to match text against popular requests.
 * @param {Object} userMessage
 * @param {Array} previousRoundtrip
 * @returns {Promise}
 */
var checkCommonRequests = function(userMessage, previousRoundtrip) {
    var text = userMessage.text;
    var keys = _.keys(commonRequests);
    var response = null;
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var pattern = new RegExp(key, 'gi');
        var match = text.match(pattern);
        if (match) {
            response = commonRequests[key];
            // If response is a callback, run.
            if (_.isFunction(response)) {
                response = response(text, match, userMessage, previousRoundtrip);
            }
            break;
        }
    }

    // At this point response could be a string or a promise. Wrap it in Promise.resolve() to always return a promise
    return response ? Promise.resolve(response) : response;
};

var getChatUserName = function(userMessage) {
    var userName = [userMessage.chat.first_name, userMessage.chat.last_name];
    return _.compact(userName).join(' ');
};

var getInlineQueryUserName = function(inlineQuery) {
    var userName = [inlineQuery.from.first_name, inlineQuery.from.last_name];
    return _.compact(userName).join(' ');
};

/**
 * @param {Object} previousRoundtrip
 */
var sendLink = function(previousRoundtrip) {
    var response;
    if (previousRoundtrip) {
        response = Kiosk
            .rzdDateUrl(previousRoundtrip)
            .then(function(url) {
                return `Вот <a href="${url}">ссылка на день и направление</a> — билеты придётся выбирать самому. РЖД не позволяет дать прямую ссылку на билеты.`;
            });
    }
    return response;
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
        var userName = getChatUserName(userMessage);
        var userMessageText = userMessage.text;
        var promises = [];

        promises.push(extractData(userMessage.text, userMessage.chat.id));
        promises.push(Kiosk.getPreviousRoundtrip(chatId));

        Promise.all(promises)
            .then(function(result) {
                var data = result[0];
                var previousRoundtrip = result[1];

                debug(`Chat ${chatId} ${userName}, message: ${userMessageText}`);
                var commonResponse = checkCommonRequests(userMessage, previousRoundtrip);
                // Check against some popular requests
                if (commonResponse) {
                    commonResponse.then(function(text) {
                        bot.sendMessage(chatId, text, {parse_mode: 'HTML'});
                    });
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
                            botMessageText += result.roundtrips && result.roundtrips.length ? Kiosk.formatRoundtrip(result.roundtrips) : '';
                            // Make sure bot message text is not empty.
                            if (!botMessageText) {
                                botMessageText = noTicketsText;
                            }
                            botMessageText = _.trim(botMessageText);

                            // Store most recently suggested roundtrips
                            Kiosk.saveRoundtripsHistory(result.roundtrips, chatId);

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
                Kiosk.saveHistory(data, chatId);
            })
            .catch(function(error) {
                console.log(error && error.stack);
            });
    });

    bot.on('inline_query', function(inlineQuery) {
        var queryId = inlineQuery.id;
        var queryText = inlineQuery.query;
        var userName = getInlineQueryUserName(inlineQuery);

        debug(`Inline query ${queryId} ${userName}, message: ${queryText}`);

        extractData(queryText)
            // Getting the tickets
            .then(function(data) {
                var promise;

                debug(`Inline query ${queryId} ${userName}, extracted options: ${JSON.stringify(data)}`);

                // Empty query (default suggest): show a cheapest roundtrip to Spb and a roundtrip to Moscow
                if (!queryText) {
                    var toSpbData = {
                        filter: {
                            route: Kiosk.Route.toSpb()
                        }
                    };
                    var toMoscowData = {
                        filter: {
                            route: Kiosk.Route.toMoscow()
                        }
                    };
                    analytics(queryText, 'inline query: empty');
                    promise = Promise.all([Analyzer.analyze(toSpbData), Analyzer.analyze(toMoscowData)]);
                // Non-empty query: fetch a cheapest ticket plus extra 5 tickets
                } else {
                    if (!data.filter.route) {
                        // If route is unclear, use default route
                        data.filter.route = Kiosk.defaultRoute;
                    }
                    // First ticket
                    var firstTicketData = _.extend(_.clone(data), {more: false});
                    // Next five tickets (first ticket is excluded)
                    var nextTicketsData = _.extend(_.clone(data), {
                        more: true,
                        segment: 0
                    });
                    analytics(queryText, 'inline query: route');
                    promise = Promise.all([Analyzer.analyze(firstTicketData), Analyzer.analyze(nextTicketsData)]);
                }
                return promise;
            })
            // Formatting
            .then(function(analyzerResults) {
                var roundtrips = [];
                _.each(analyzerResults, function(analyzerResult) {
                    if (analyzerResult && analyzerResult.roundtrips) {
                        roundtrips.push(analyzerResult.roundtrips);
                    }
                });
                roundtrips = _.compact(_.flatten(roundtrips));

                var queryResults = [];
                var index = 0;
                _.forEach(roundtrips, function(roundtrip) {
                    index++;
                    queryResults.push({
                        type: 'article',
                        id: index.toString(),
                        title: Kiosk.formatRoundtripTitle(roundtrip),
                        input_message_content: {
                            message_text: Kiosk.formatRoundtrip(roundtrip)
                        }
                    });
                });
                return queryResults;
            })
            .then(function(queryResults) {
                return bot.answerInlineQuery(queryId, queryResults, {cache_time: process.env.INLINE_RESULT_CACHE_TIME});
            })
            .then(function(botMessage) {
                var botMessageTextLog = botMessage.text.replace(/\n/g, ' ');
                debug(`Inline query ${queryId} ${userName}, tickets: ${botMessageTextLog}.`);
            })
            .catch(function(error) {
                console.log(error && error.stack);
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
    unsetWebhook: unsetWebhook,
    extractData: extractData
};
