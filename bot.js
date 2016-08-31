var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var History = require('./history');

var TelegramBot = require('node-telegram-bot-api');
var botan = require('botanio')(process.env.TELEGRAM_BOT_ANALYTICS_TOKEN);
var _ = require('lodash');
var moment = require('moment');
var debug = require('debug')('bot');

var Promise = require('bluebird');

const useWebhook = Boolean(process.env.USE_WEBHOOK);
const routeQuestion = 'В Москву или Петербург?';
const helpText = 'Напишите «в Питер на выходные» или «в Москву рано утром» или «в Москву за 3000» или просто «в Москву». Напишите «ещё» чтобы посмотреть другие варианты.';
const noTicketsText = 'Что-то пошло не так: не могу найти билет.';
const greetingText = 'Привет';

const minPriceLimit = 1000;

const toMoscowPattern = /^москва|^мск|.москва|в москву|москву|мовску|моску|мсокву|в мск|из питера|из петербурга|из санкт|из спб/i;
const toSpbPattern = /^питер|^петербург|^петебург|^петепбург|^петер|^петрбург|^санкт|^спб|из москвы|из мск|в питер|в петербург|в санкт|в спб/i;
const earlyMorningPattern = /рано утром/i;
const morningPattern = /утром/i;
const dayPattern = /днём|днем/i;
const anyDayOfWeekPattern = /не только (на |в )?выходн|любой день недели/i;
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
const helpPattern = /^\/(help|about)$/i;
const purchasePattern = /беру/i;
const linkPattern = /ссылк/i;
const greetingPattern = /привет/i;
// Sometimes first message text is "/start Start" instead of just "/start": test with regexp
const startPattern = /^\/start/i;

const states = {
    helpCommand: 'helpCommand',
    purchase: 'purchase',
    link: 'link',
    greeting: 'greeting',
    roundtrip: 'roundtrip',
    start: 'start',
    unclear: 'unclear'
};

// Webhook for remote, polling for local
const options = useWebhook ? {
    webHook: {
        port: process.env.PORT || 5000
    }
} : {polling: true};

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, options);

const defaultFilter = {
    // Set morning originating hours by default
    originatingHours: Kiosk.hourAliases.morning,
    // Any day of the week by default
    weekday: Kiosk.weekdays.any
};

/**
 * Extracts search options from user message
 * @param {String} text
 * @returns {Promise}
 */
var extractOptions = function(text) {
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
        filter.originatingHours = Kiosk.hourAliases.earlyMorning;
        // Morning
    } else if (morningPattern.test(text)) {
        filter.originatingHours = Kiosk.hourAliases.morning;
        // Day
    } else if (dayPattern.test(text)) {
        filter.originatingHours = Kiosk.hourAliases.day;
    }

    // Any day of the week
    if (anyDayOfWeekPattern.test(text)) {
        filter.weekday = Kiosk.weekdays.any;
        // Weekend
    } else if (weekendPattern.test(text)) {
        filter.weekday = Kiosk.weekdays.weekend;
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

    return {
        filter: filter,
        more: more,
        nothingExtracted: _.isEmpty(filter) && !more
    };
};

/**
 * @param {String} text
 * @param {Number} [chatId]
 * @returns {*|Promise}
 */
var getOptions = function(text, chatId) {
    var extractedOptions = extractOptions(text);
    var filter = _.extend(defaultFilter, extractedOptions.filter);
    var more = extractedOptions.more;

    return History.get(chatId)
        .then(function(previousData) {
            var previousFilter = previousData.filter || {};
            var segment = previousData.segment;

            // Make sure month or date from current filter do not conflict with previous filter month or date
            if (filter.month && previousFilter.originatingTicket && previousFilter.originatingTicket.date) {
                delete previousFilter.originatingTicket.date;
            }
            if (filter.originatingTicket && filter.originatingTicket.date) {
                delete previousFilter.month;
            }

            // If route is set, reset segment parameter
            if (filter.route) {
                segment = 0;
            // If there are some parameters in the new filter (except for the route parameter, which resets the filter),
            // add the previous filter parameters.
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
                segment: segment,
                roundtrips: previousData.roundtrips,
                previousState: previousData.state,
                nothingExtracted: extractedOptions.nothingExtracted
            };
        })
        .catch(function() {
            return extractedOptions;
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
var getLink = function(previousRoundtrip) {
    var response;
    if (previousRoundtrip) {
        response = Kiosk.rzdDateRouteUrl(previousRoundtrip)
            .then(function(url) {
                return `Вот <a href="${url}">ссылка на день и направление</a> — билеты придётся выбирать самому. РЖД не позволяет дать прямую ссылку на билеты.`;
            });
    }
    return response;
};

var sendMessage = function(chatId, userName, botMessage, previousOptions) {
    // Save history
    var options = _.clone(previousOptions);
    options.state = botMessage.state;
    var roundtrips = botMessage.roundtrips;
    // Delete previous roundtrips and add new roundtrips, if any
    delete options.roundtrips;
    if (roundtrips) {
        options.roundtrips = !_.isArray(roundtrips) ? [roundtrips] : roundtrips;
    }

    // Store options extracted from user message and roundtrips, if any.
    return Promise.all([botMessage, options, History.save(options, chatId)])
        // Sending the message
        .then(function(result) {
            var botMessage = result[0];
            var rountripOptions = result[1];
            var botMessageText = botMessage.message ? botMessage.message : botMessage;
            var options = _.extend(botMessage.options, {
                reply_markup: getReplyMarkup(botMessage.roundtrips, rountripOptions),
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });

            return bot.sendMessage(chatId, botMessageText, options);
        })
        // Logging
        .then(function(botMessage) {
            var botMessageTextLog = botMessage.text.replace(/\n/g, ' ');
            debug(`Chat ${chatId} ${userName}, message: ${botMessageTextLog}.`);
        })
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

        getOptions(userMessage.text, userMessage.chat.id)
            // Formatting a message
            .then(function(options) {
                var previousRoundtrip = options.roundtrips && options.roundtrips.length ? options.roundtrips[0] : null;

                debug(`Chat ${chatId} ${userName}, message: ${userMessageText}`);
                var result;

                if (helpPattern.test(userMessage.text)) {
                    analytics(userMessage, '/help');
                    result = {message: helpText, state: states.helpCommand};
                } else if (purchasePattern.test(userMessage.text)) {
                    analytics(userMessage, 'purchase');
                    result = getLink(previousRoundtrip)
                        .then(function(text) {
                            return {message: text, state: states.purchase};
                        });
                } else if (linkPattern.test(userMessage.text)) {
                    analytics(userMessage, 'link');
                    result = getLink(previousRoundtrip)
                        .then(function(text) {
                            return {message: text, state: states.link};
                        });
                } else if (greetingPattern.test(userMessage.text)) {
                    analytics(userMessage, 'greeting');
                    result = {message: greetingText, state: states.greeting};
                // Start
                } else if (startPattern.test(userMessageText)) {
                    analytics(userMessage, 'start');
                    result = {message: routeQuestion, state: states.start};
                // If nothing is extracted from this user message or route is not clear
                } else if (options.nothingExtracted || !options.filter.route) {
                    analytics(userMessage, 'unclear');
                    result = {
                        // If user message is unclear two times in a row, show help
                        message: options.previousState === states.unclear ? helpText : routeQuestion,
                        state: states.unclear
                    };
                // If the route is clear, search for tickets
                } else {
                    analytics(userMessage, 'route');
                    debug(`Chat: ${chatId} ${userName}, extracted options: ${JSON.stringify(options)}`);
                    result = getRoundtrips(options)
                        .then(function(result) {
                            return _.extend(result, {state: states.roundtrip});
                        });
                }

                return Promise.all([result, options]);
            })
            // Send message
            .then(function(result) {
                var botMessage = result[0];
                var options = result[1];
                return sendMessage(chatId, userName, botMessage, options);
            })
            .catch(function(error) {
                console.log(error && error.stack);
            });
    });

    bot.on('callback_query', function(callbackQuery) {
        var callbackQueryId = callbackQuery.id;
        var message = callbackQuery.message;
        var chatId = message.chat.id;
        var text = callbackQuery.data;
        var userName = getChatUserName(message);

        // Send an empty callback query answer to prevent button throbber from spinning endlessly.
        bot.answerCallbackQuery(callbackQueryId);

        getOptions(text, chatId)
            .then(function(options) {
                return Promise.all([getRoundtrips(options), options]);
            })
            .then(function(result) {
                var botMessage = result[0];
                var options = result[1];
                botMessage = _.extend(botMessage, {state: states.roundtrip});
                return sendMessage(chatId, userName, botMessage, options);
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

        getOptions(queryText)
            // Getting the tickets
            .then(function(options) {
                var promise;

                debug(`Inline query ${queryId} ${userName}, extracted options: ${JSON.stringify(options)}`);

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
                    analytics(inlineQuery, 'inline query: empty');
                    promise = Promise.all([Analyzer.analyze(toSpbData), Analyzer.analyze(toMoscowData)]);
                // Non-empty query: fetch a cheapest ticket plus extra 5 tickets
                } else {
                    if (!options.filter.route) {
                        // If route is unclear, use default route
                        options.filter.route = Kiosk.defaultRoute;
                    }
                    // First ticket
                    var firstTicketData = _.extend(_.clone(options), {more: false});
                    // Next five tickets (first ticket is excluded)
                    var nextTicketsData = _.extend(_.clone(options), {
                        more: true,
                        segment: 0
                    });
                    analytics(inlineQuery, 'inline query: route');
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

                var promises = [];

                _.forEach(roundtrips, function(roundtrip) {
                    promises.push(generateInlineQueryResult(roundtrip));
                });
                return Promise.all(promises);
            })
            .then(function(queryResults) {
                return bot.answerInlineQuery(queryId, queryResults, {cache_time: process.env.INLINE_RESULT_CACHE_TIME});
            })
            .catch(function(error) {
                console.log(error && error.stack);
            });
    });
};

var getReplyMarkup = function(roundtrips, options) {
    return JSON.stringify({
        inline_keyboard: getInlineButtons(roundtrips, options)
        // With two keyboards specified, inline keyboard does not show
        /*keyboard: getReplyButtons(),
        resize_keyboard: true,
        one_time_keyboard: true*/
    });
};

/**
 * Determines the set of buttons depending on context
 * @param {Array} roundtrips
 * @param {Object} options
 * @returns {Array.<Array.<String>>} Array of arrays of button captions
 */
var getInlineButtons = function(roundtrips, options) {
    var firstRoundtrip = roundtrips && roundtrips.length && roundtrips[0];
    var keys = [];
    var filter = options.filter;
    if (firstRoundtrip) {
        // More tickets and tickets in reverse direction
        //keys.push(['ещё билеты', firstRoundtrip.route.isToSpb() ? 'в Москву' : 'в Петербург']);
        keys.push([{text: 'ещё билеты', callback_data: 'ещё билеты'}]);

        var when = [];
        var isAnyDayOfWeek = filter.weekday && filter.weekday !== Kiosk.weekdays.weekend;
        when.push(isAnyDayOfWeek ? {text: 'выходные', callback_data: 'выходные'} : {text: 'любой день', callback_data: 'любой день недели'});
        // Available months, excluding previously mentioned month, if any
        var months = _.map(Kiosk.getMonthsWithinTimespan(filter.month), function(month) {
            var monthName = moment(month + 1, 'M').format('MMMM').toLowerCase();
            return {text: monthName, callback_data: monthName};
        });
        when = when.concat(months);
        keys.push(when);
    } else {
        keys = [[{text: 'в Москву', callback_data: 'в Москву'}, {text: 'в Петербург', callback_data: 'в Петербург'}]];
    }
    return keys;
};

var getReplyButtons = function() {
    return [['в Москву', 'в Петербург']];
};

var getRoundtrips = function(options) {
    return Analyzer.analyze(options)
        .then(function(result) {
            var promise = result.roundtrips && result.roundtrips.length ? Kiosk.formatRoundtrip(result.roundtrips, true) : '';
            return Promise.all([result, promise]);
        })
        .then(function(data) {
            var result = data[0];
            var roundtripsFormatted = data[1];
            var message = '';

            if (result.message) {
                message += `${result.message}\n\n`;
            }
            message += roundtripsFormatted;
            // Make sure bot message text is not empty.
            if (!message) {
                message = noTicketsText;
            }
            message = _.trim(message);

            return {
                message: message,
                roundtrips: result.roundtrips
            };
        });
};

/**
 * Generates an object of type InlineQueryResult used by answerInlineQuery() Telegram API method
 * @param roundtrip
 * @returns {Promise}
 */
var generateInlineQueryResult = function(roundtrip) {
    var toAlias = roundtrip.route.to.alias;
    return Kiosk.formatRoundtrip(roundtrip, true)
        .then(function(text) {
            return {
                type: 'article',
                id: _.random(0, 999999999).toString(),
                title: Kiosk.formatRoundtripTitle(roundtrip),
                input_message_content: {
                    message_text: text,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                },
                thumb_url: `https://s3.amazonaws.com/swivel-sew-booth/${toAlias}-logo.png`,
                thumb_width: 50,
                thumb_height: 50
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
