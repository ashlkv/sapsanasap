var Analyzer = require('./analyzer');
var Kiosk = require('./kiosk');
var History = require('./history');

var TelegramBot = require('node-telegram-bot-api');
var botan = require('botanio')(process.env.TELEGRAM_BOT_ANALYTICS_TOKEN);
var _ = require('lodash');
var moment = require('moment');
var debug = require('debug')('bot');

const polyglot = require('./polyglot')();

var Promise = require('bluebird');

const useWebhook = Boolean(process.env.USE_WEBHOOK);

const minPriceLimit = 1000;

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
    originatingHours: Kiosk.hourAliases.morning
};

/**
 * Extracts search options from user message
 * @param {String} text
 * @returns {Promise}
 */
var extractOptions = function(text) {
    var filter = {};

    // To Moscow
    if (polyglot.t('toMoscowPattern').test(text)) {
        filter.route = Kiosk.Route.toMoscow();
    }
    // To Spb
    if (polyglot.t('toSpbPattern').test(text)) {
        filter.route = Kiosk.Route.toSpb()
    }
    // If asking for "туда и обратно", assuming destination is Moscow, since the question is "В Москву или Петербург?"
    if (polyglot.t('thereAndBackPattern').test(text)) {
        filter.route = Kiosk.Route.toMoscow();
    }

    // Early morning
    if (polyglot.t('earlyMorningPattern').test(text)) {
        filter.originatingHours = Kiosk.hourAliases.earlyMorning;
        // Morning
    } else if (polyglot.t('morningPattern').test(text)) {
        filter.originatingHours = Kiosk.hourAliases.morning;
        // Day
    } else if (polyglot.t('afternoonPattern').test(text)) {
        filter.originatingHours = Kiosk.hourAliases.day;
    }

    // Any day of the week
    if (polyglot.t('anyDayOfWeekPattern').test(text)) {
        filter.weekday = Kiosk.weekdays.any;
        // Weekend
    } else if (polyglot.t('weekendPattern').test(text)) {
        filter.weekday = Kiosk.weekdays.weekend;
    }

    // Price limit
    var priceLimit = text && text.match(polyglot.t('pricePattern'));
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
    var specificDate1 = text && text.match(polyglot.t('specificDatePattern1'));
    if (specificDate1 && !_.isUndefined(month)) {
        var year = (new Date()).getFullYear();
        var dateMatch = specificDate1[0] && specificDate1[0].match(/\d+/g);
        var day = dateMatch && dateMatch.length && parseInt(dateMatch[0]);
        // If it was a secific date request, remove month from filter.
        delete filter.month;
        var specificDate1moment = moment([year, month, day]);
        // If the date is in the past (days difference is positive) as it happens in the last months of the year, try next year
        if (moment().diff(specificDate1moment, 'days') > 0) {
            specificDate1moment = moment([year + 1, month, day]);
        }
        filter.originatingTicket = {
            date: specificDate1moment.toDate()
        };
    }
    var specificDate2 = text && text.match(polyglot.t('specificDatePattern2'));
    if (specificDate2) {
        filter.originatingTicket = {
            date: moment(specificDate2[0], polyglot.t('dateFormat2')).toDate()
        };
    }
    var specificDate3 = text && text.match(polyglot.t('specificDatePattern3'));
    if (specificDate3) {
        filter.originatingTicket = {
            date: moment(specificDate3[0], polyglot.t('dateFormat3')).toDate()
        };
    }
    var tomorrow = text && text.match(polyglot.t('tomorrowPattern'));
    if (tomorrow) {
        filter.originatingTicket = {
            date: moment().add(1, 'day').startOf('day').toDate()
        };
    }
    if (polyglot.t('cancelSpecificDatePattern').test(text)) {
        filter.originatingTicket = {
            date: null
        };
    }

    // If asked for specific date, set to any weekday
    if (filter.originatingTicket && filter.originatingTicket.date) {
        filter.weekday = Kiosk.weekdays.any;
    }

    // More
    var more = polyglot.t('morePattern').test(text);

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
    var filter = _.extend(_.clone(defaultFilter), extractedOptions.filter);
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
            // If weekdays is not defined, set to any
            if (!filter.weekday) {
                filter.weekday = Kiosk.weekdays.any;
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
    var month = text && text.match(polyglot.t('monthPattern'));
    var monthNumber;
    if (month && month.length) {
        month = month[0].replace(/ /g, '');
        var monthKey = _.find(_.keys(polyglot.t('monthMap')), function(key) {
            var pattern = new RegExp(`^${key}`, 'gi');
            return pattern.test(month);
        });
        monthNumber = polyglot.t('monthMap')[monthKey];
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
                return polyglot.t('ticketUrlMessage', {url: url});
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

                if (polyglot.t('helpPattern').test(userMessage.text)) {
                    analytics(userMessage, '/help');
                    result = {message: polyglot.t('helpText'), state: states.helpCommand};
                } else if (polyglot.t('purchasePattern').test(userMessage.text)) {
                    analytics(userMessage, 'purchase');
                    result = getLink(previousRoundtrip)
                        .then(function(text) {
                            return {message: text, state: states.purchase};
                        });
                } else if (polyglot.t('linkPattern').test(userMessage.text)) {
                    analytics(userMessage, 'link');
                    result = getLink(previousRoundtrip)
                        .then(function(text) {
                            return {message: text, state: states.link};
                        });
                } else if (polyglot.t('greetingPattern').test(userMessage.text)) {
                    analytics(userMessage, 'greeting');
                    result = {message: polyglot.t('greetingText'), state: states.greeting};
                // Start
                } else if (polyglot.t('startPattern').test(userMessageText)) {
                    analytics(userMessage, 'start');
                    result = {message: polyglot.t('routeQuestion'), state: states.start};
                // If nothing is extracted from this user message or route is not clear
                } else if (options.nothingExtracted || !options.filter.route) {
                    analytics(userMessage, 'unclear');
                    result = {
                        // If user message is unclear two times in a row, show help
                        message: options.previousState === states.unclear ? polyglot.t('helpText') : polyglot.t('routeQuestion'),
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
    var markup = {};
    switch (options.state) {
        case states.roundtrip:
        case states.unclear:
            markup = {inline_keyboard: getInlineButtons(roundtrips, options)};
            break;
        default:
            // With two keyboards specified, inline keyboard does not show. It's either reply keyboard or inline keyboard.
            markup = {
                keyboard: getReplyButtons(),
                resize_keyboard: true,
                one_time_keyboard: true
            };
            break;
    }
    return JSON.stringify(markup);
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
        // More tickets
        var specificDate = filter.originatingTicket && filter.originatingTicket.date;
        var firstRow = [{text: polyglot.t('moreTicketsButton'), callback_data: specificDate ? polyglot.t('moreTicketsForAnyDateCallback') : polyglot.t('moreTicketsCallback')}];
        keys.push(firstRow);

        var when = [];
        if (!specificDate) {
            var isAnyDayOfWeek = filter.weekday && filter.weekday !== Kiosk.weekdays.weekend;
            when.push(isAnyDayOfWeek ? {text: polyglot.t('weekendsButton'), callback_data: polyglot.t('weekendsCallback')} : {text: polyglot.t('anyDayOfWeekButton'), callback_data: polyglot.t('anyDayOfWeekCallback')});
        }
        // Available months, excluding previously mentioned month, if any
        var months = _.map(Kiosk.getMonthsWithinTimespan(filter.month), function(month) {
            var monthName = moment(month + 1, 'M').format('MMMM').toLowerCase();
            return {text: monthName, callback_data: monthName};
        });
        when = when.concat(months);
        keys.push(when);
    } else {
        keys = [[{text: polyglot.t('toMoscowButton'), callback_data: polyglot.t('toMoscowCallback')}, {text: polyglot.t('toPetersburgButton'), callback_data: polyglot.t('toPetersburgCallback')}]];
    }
    return keys;
};

var getReplyButtons = function() {
    return [[polyglot.t('toMoscowButton'), polyglot.t('toPetersburgButton')]];
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
                message = polyglot.t('noTicketsText');
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
    var toAlias = roundtrip.route.to;
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
