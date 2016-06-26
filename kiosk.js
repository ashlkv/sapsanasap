var Storage = require('./storage');
var Utilities = require('./utilities');

var Promise = require('bluebird');

var request = require('request-promise');

var moment = require('moment');
var _ = require('lodash');

var debug = require('debug')('kiosk');

const cityAliases = {
    mow: 'mow',
    spb: 'spb'
};

const cities = {
    [cityAliases.mow]: {
        alias: cityAliases.mow,
        name: 'МОСКВА',
        formattedName: 'Москва',
        code: 2000000
    },
    [cityAliases.spb]: {
        alias: cityAliases.spb,
        name: 'САНКТ-ПЕТЕРБУРГ',
        formattedName: 'Санкт-Петербург',
        code: 2004000
    }
};

const hours = {
    morning: [7, 10],
    earlyMorning: [5, 7],
    evening: [17, 20]
};

const afterCredentialsDelay = 15000;

/**
 * Timespan length in days. Rzd only allows searching for tickets within 60 days.
 * @type {number}
 */
const timespan = 60;

/**
 * Maximum number of attempts to fetch tickets from rzd site.
 * @type {number}
 */
const maxAttempts = 15;

/**
 * Tickets count is never expected to go beneath this threshold.
 * @type {number}
 */
const ticketsCountThreshold = 1200;

/**
 * @param {Object} to
 * @constructor
 */
var Route = function(to) {
    var cityCodes = Object.keys(cities);
    this.to = cityCodes.indexOf(to) === -1 ? cities.spb : cities[to];
    this.from = this.to.alias === cityAliases.spb ? cities.mow : cities.spb;
};

Route.prototype.getSummary = function() {
    return `${this.from.name} → ${this.to.name}`;
};

/**
 * Returns a new reversed route
 * @param {Route} route
 * @returns {Route}
 */
Route.getReversed = function(route) {
    return new Route(route.from.alias);
};

/**
 * @returns {Route}
 */
Route.toMoscow = function() {
    return new Route(cityAliases.mow);
};

/**
 * @returns {Route}
 */
Route.toSpb = function() {
    return new Route(cityAliases.spb);
};

const defaultRoute = Route.toMoscow();

/**
 * Returns request url and parameters
 * @param {Route} route
 * @param {Moment} date1
 * @param {Moment} [date2]
 * @param {String} [rid]
 * @returns {Object}
 */
var getRequestOptions = function(route, date1, date2, rid) {
    date2 = date2 || date1.clone();

    var dateFormat = 'DD.MM.YYYY';
    var cityFrom = route.from;
    var cityTo = route.to;

    var parameters = {
        STRUCTURE_ID: '735',
        layer_id: '5371',
        dir: '1',
        tfl: '3',
        checkSeats: '1',
        st0: cityFrom.name,
        code0: cityFrom.code,
        dt0: date1.format(dateFormat),
        st1: cityTo.name,
        code1: cityTo.code,
        dt1: date2.format(dateFormat)
    };

    if (rid) {
        parameters.rid = rid;
    }

    return {
        url: 'https://pass.rzd.ru/timetable/public/ru',
        parameters: parameters
    };
};

var getSessionCookie = function(response) {
    var cookieHeader = response.headers['set-cookie'];
    var cookie = {};
    /**
     * @example JSESSIONID=00004ADS7pUenJiasDpQq4maKIR:17obq8rib; Path=/
     */
    var sessionCookie = _.find(cookieHeader, function(item) {
        return item.indexOf('JSESSIONID') !== -1;
    });
    if (sessionCookie) {
        var pair = sessionCookie.split(';')[0].split('=');
        cookie = {
            name: pair[0],
            value: pair[1]
        };
    }
    return cookie;
};

/**
 * Fetches rid
 * @param {Object} requestOptions
 * @returns {Promise}
 */
var getCredentials = function(requestOptions) {
    return request({
            method: 'GET',
            url: requestOptions.url,
            qs: requestOptions.parameters,
            resolveWithFullResponse: true,
            json: true
        })
        .then(function(response) {
            return extractCredentials(response, response.body);
        })
        .catch(function() {
            throw new Error('Failed to get credentials.');
        });
};

/**
 * @param {Object} response
 * @param {String} body
 * @returns {{rid: (*|String), sessionCookie}}
 */
var extractCredentials = function(response, body) {
    var sessionCookie = getSessionCookie(response);
    return {
        rid: body.rid,
        sessionCookie: sessionCookie
    };
};

/**
 * Fetches tickets for a given date
 * @param {Date} date
 * @param {Route} route
 * @returns {Promise}
 */
var getTicketsForDate = function(date, route) {
    date = date || new Date();
    var momentDate = moment(date);
    var credentialsOptions = getRequestOptions(route, momentDate);
    var attemptsCount = 0;

    // Using promise constructor because of setTimeout
    var promise = new Promise(function(resolve, reject) {

        var getTicketsWithCredentials = function(credentials) {
            debug('credentials', credentials);
            setTimeout(function() {
                // Add rid query parameter
                var ticketOptions = _.clone(credentialsOptions);
                ticketOptions.parameters.rid = credentials.rid;

                // Add session cookie
                var cookie = `${credentials.sessionCookie.name}=${credentials.sessionCookie.value};`;

                request({
                    method: 'GET',
                    url: ticketOptions.url,
                    qs: ticketOptions.parameters,
                    resolveWithFullResponse: true,
                    json: true,
                    // Setting cookie via jar does not work.
                    headers: {
                        Cookie: cookie
                    }
                }).then(function(response) {
                    var body = response.body;
                    var allTickets = [];
                    if (body.tp) {
                        allTickets = allTickets.concat(body.tp[0].list);
                        allTickets = allTickets.concat(body.tp[1] ? body.tp[1].list : []);
                    }
                    debug('allTickets.length', allTickets.length);
                    attemptsCount++;
                    // Occasionally a new rid is returned instead of tickets.
                    // If so, make another attempt to fetch tickets.
                    if (!allTickets.length && attemptsCount <= maxAttempts) {
                        debug('unexpected response: ', body);
                        debug('attemptsCount', attemptsCount);
                        if (attemptsCount <= maxAttempts) {

                            getCredentials(credentialsOptions)
                                .then(getTicketsWithCredentials);
                        } else {
                            reject('Maximum attempts reached, no tickets in response.');
                        }
                    } else {
                        var relevantTickets = filterTickets(allTickets, {
                            highSpeed: true
                        });
                        if (!relevantTickets.length && allTickets.length) {
                            debug('All tickets filtered out');
                        }
                        resolve(relevantTickets);
                    }
                })
                    .catch(function(e) {
                        throw new Error('Unable to get tickets');
                    });
            }, afterCredentialsDelay);
        };

        getCredentials(credentialsOptions)
            .then(getTicketsWithCredentials);
    });



    return promise;
};

/**
 * Filters only relevant tickets
 * @param {Array} allTickets
 * @param {Object} options
 * @returns {Array}
 */
var filterTickets = function(allTickets, options) {
    var brand = options.highSpeed ? 'САПСАН' : null;
    var station0;
    if (options.route) {
        station0 = _.isObject(options.route) ? options.route.from.name : cities[options.route].name;
    }
    var date = options.date;
    var hours = options.hours;

    return _.filter(allTickets, function(ticket) {
        var hit = true;
        var departureMoment = moment(getTicketDepartureDate(ticket));

        if (brand && ticket.brand !== brand) {
            hit = false;
        }
        if (station0 && ticket.station0 !== station0) {
            hit = false;
        }
        if (date && !departureMoment.isSame(date, 'day')) {
            hit = false;
        }
        if (hours && !_.inRange(departureMoment.get('hours'), hours[0], hours[1])) {
            hit = false;
        }
        return hit;
    });
};

var formatCity = function(name) {
    return _.map(name.toLowerCase().split('-'), function(part) {
            return _.upperFirst(part);
        })
        .join('-');
};

/**
 * @param {Object} json
 * @returns {String}
 */
var formatTicket = function(json) {
    var cityFrom = formatCity(json.station0);
    var cityTo = formatCity(json.station1);
    var date = moment(getTicketDepartureDate(json));
    var dayFormatted = date.format('D MMMM, dddd').toLowerCase();
    var timeFormatted = date.format('H:mm');

    //Санкт-Петербург → Москва,
    //16 марта, среда, отправление в 5:30
    //1290 ₽
    return `${cityFrom} → ${cityTo} \n${dayFormatted}, отправление в ${timeFormatted} \n${json.cars[0].tariff} ₽`;
};

/**
 * Returns a link to rzd site with route and dates selected.
 * @param {Object} roundtrip
 * @returns {Promise}
 */
var rzdDateUrl = function(roundtrip) {
    var route = roundtrip.originatingTicket.route;
    var momentDate1 = moment(roundtrip.originatingTicket.datetime);
    var momentDate2 = moment(roundtrip.returnTicket.datetime);
    var toHash = function(obj) {
        return _.map(obj, function(v, k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(v);
        }).join('|');
    };

    var requestOptions = getRequestOptions(route, momentDate1, momentDate2);
    var structureId = requestOptions.parameters.STRUCTURE_ID;
    delete requestOptions.parameters.layer_id;
    delete requestOptions.parameters.STRUCTURE_ID;

    var parametersHash = toHash(requestOptions.parameters);
    var url = `${requestOptions.url}?STRUCTURE_ID=${structureId}#${parametersHash}`;

    // Using url shortener because when a link in Telegram gets clicked, the '|' characters in rzd url are url-encoded into %7C, which breaks the url.
    // There is no way to avoid the '|' character usage.
    return Utilities.shortenUrl(url);
};

/**
 * @param {Array} roundtrips
 * @returns {String}
 */
var formatRoundtrip = function(roundtrips) {
    var formatNestedTicket = function(ticket) {
        var datetimeMoment = moment(ticket.datetime);
        var dayFormatted = datetimeMoment.format('D MMMM, dddd').toLowerCase();
        var timeFormatted = datetimeMoment.format('H:mm');
        //Санкт-Петербург → Москва,
        //16 марта, среда, отправление в 5:30
        //1290 ₽
        return `${ticket.route.from.formattedName} → ${ticket.route.to.formattedName} \n${dayFormatted}, отправление в ${timeFormatted} \n${ticket.price} ₽`;
    };

    var fullFormat = function(roundtrip) {
        var originatingTicketText = formatNestedTicket(roundtrip.originatingTicket);
        var returnTicketText = formatNestedTicket(roundtrip.returnTicket);
        return `${originatingTicketText}\n\n${returnTicketText}\n----------\n${roundtrip.totalCost} ₽`;
    };

    var formatWeekday = function(dateMoment) {
        var localeData = moment.localeData();
        var formatted;
        if (localeData._weekdays.format) {
            formatted = localeData._weekdays.format[dateMoment.day()];
            formatted = (formatted.substring(0, 2) === 'вт' ? 'во ' : 'в ') + formatted;
        } else {
            formatted = dateMoment.format('dddd');
        }
        return formatted;
    };

    var shortFormat = function(roundtrip) {
        var originatingTicket = roundtrip.originatingTicket;
        var originatingMoment = moment(originatingTicket.datetime);
        var originatingWeekday = formatWeekday(originatingMoment);
        var originatingTicketDateFormatted = originatingMoment.format(`${originatingWeekday} D MMMM в H:mm`).toLowerCase();

        var returnTicket = roundtrip.returnTicket;
        var returnMoment = moment(returnTicket.datetime);
        var returnWeekday = formatWeekday(returnMoment);
        var returnTicketDateFormatted = returnMoment.format(`${returnWeekday} D MMMM в H:mm`).toLowerCase();

        // Санкт-Петербург → Москва и обратно за 3447 ₽
        // Туда в среду 18 мая в 7:00, обратно в четверг 19 мая в 18:00
        return `${originatingTicket.route.from.formattedName} → ${originatingTicket.route.to.formattedName} и обратно за ${roundtrip.totalCost} ₽ \nтуда ${originatingTicketDateFormatted}, обратно ${returnTicketDateFormatted}`;
    };

    var text = [];
    roundtrips = _.isArray(roundtrips) ? roundtrips : [roundtrips];
    var isShortFormat = roundtrips.length > 1;
    roundtrips.forEach(function(roundtrip) {
        text.push(isShortFormat ? shortFormat(roundtrip) : fullFormat(roundtrip));
    });
    return text.join("\n\n");
};

/**
 * @param {Object} json Ticket json
 * @returns {Date}
 */
var getTicketDepartureDate = function(json) {
    return moment(`${json.date0} ${json.time0}`, 'DD.MM.YYYY HH:mm').toDate();
};

/**
 * @param {Object} json Ticket json
 * @returns {Date}
 */
var getDayAfterTicket = function(json) {
    var ticketDepartureDate = getTicketDepartureDate(json);
    return moment(ticketDepartureDate).add(1, 'days').startOf('day').toDate();
};
/**
 * @param {Object} json Ticket json
 * @returns {Date}
 */
var getDayBeforeTicket = function(json) {
    var ticketDepartureDate = getTicketDepartureDate(json);
    return moment(ticketDepartureDate).subtract(1, 'days').startOf('day').toDate();
};

/**
 * Makes up ticket summary
 * @param {Object} json Ticket json
 * @returns {String}
 */
var getSummary = function(json) {
    return `${json.date0} ${json.station0} ${json.station1} ${json.cars ? json.cars[0].tariff : ''}`;
};

/**
 * Returns an array of dates of all stored tickets
 * @param {Array} tickets
 * @returns {Array}
 */
var extractDates = function(tickets) {
    var datesInStorage = _.map(_.uniqBy(tickets, 'date0'), function(json) {
        return moment(json.date0, 'DD.MM.YYYY').toDate();
    });
    return _.sortBy(datesInStorage);
};

/**
 * Generates a roundtrip for each departure date, route and other options
 * @returns {Promise}
 */
var generateIndex = function() {
    return Storage
        .find(Storage.collectionName.tickets)
        .then(function(allTickets) {
            var cheapestTickets = findAllCheapestTicketsWithOptions(allTickets);
            var roundtrips = extractRoundtrips(cheapestTickets);

            // If no roundtrips found, do not overwrite existing roundtrips.
            if (!roundtrips.length) {
                throw new Error('No roundtrips found.');
            }
            return Promise.all([roundtrips, Storage.drop(Storage.collectionName.roundtrips)]);
        })
        .then(function(result) {
            var roundtrips = result[0];
            // Converting dates to string and routes to string alias before persisting
            return Storage.insert(Storage.collectionName.roundtrips, roundtrips);
        });
};

/**
 * Finds the cheapest ticket for every day, route and hours combination
 * @param {Array} allTickets
 * @returns {Array}
 */
var findAllCheapestTicketsWithOptions = function(allTickets) {
    var allDates = extractDates(allTickets);
    var entries = [];
    var toMoscow = Route.toMoscow();
    var toSpb = Route.toSpb();

    var minCallback = function(ticket) {
        return parseInt(ticket.cars[0].tariff);
    };

    _.forEach(allDates, function(date) {
        var optionSet = [
            {date: date, route: toMoscow, hours: hours.earlyMorning},
            {date: date, route: toMoscow, hours: hours.morning},
            {date: date, route: toMoscow, hours: hours.evening},

            {date: date, route: toSpb, hours: hours.earlyMorning},
            {date: date, route: toSpb, hours: hours.morning},
            {date: date, route: toSpb, hours: hours.evening}
        ];

        _.forEach(optionSet, function(options) {
            var filteredTickets = filterTickets(allTickets, options);
            var cheapestTicket = _.minBy(filteredTickets, minCallback);
            if (cheapestTicket) {
                var time = cheapestTicket.time0.split(':');
                entries.push(_.extend({
                    ticket: cheapestTicket.id,
                    datetime: moment(date).hours(parseInt(time[0])).minutes(parseInt(time[1])).toDate(),
                    price: parseInt(cheapestTicket.cars[0].tariff)
                }, options));
            }
        });
    });

    return entries;
};

/**
 * Finds the cheapest roundtrips for every day, route and hours combination
 * @param {Array} cheapestTickets
 * @returns {Array}
 */
var extractRoundtrips = function(cheapestTickets) {
    var roundtrips = [];
    // Morning and early morning tickets are assumed to be originating (outbound).
    var originatingTickets = _.filter(cheapestTickets, function(ticket) {
        return ticket.hours === hours.earlyMorning || ticket.hours === hours.morning;
    });
    var lastAvailableDay = getLastAvailableDay();
    // Find a return ticket for every originating ticket.
    _.forEach(originatingTickets, function(originatingTicket, i) {
        // Do not make a roundtrip if it is the last of available days (otherwise return ticket will not be available)
        if (originatingTicket.date < lastAvailableDay) {
            var originatingTicketMoment = moment(originatingTicket.date);
            var roundtrip = {
                originatingTicket: originatingTicket,
                returnTicket: null,
                totalCost: null,
                route: originatingTicket.route,
                // If originating ticket date is Saturday, mark roundtrip as weekend.
                weekend: originatingTicketMoment.isoWeekday() === 6,
                // Indicates if originating departure time is early in the morning.
                earlyMorning: originatingTicket.hours === hours.earlyMorning,
                // Storing month to simplify filtering
                month: originatingTicketMoment.month()
            };

            var returnOptions = {
                date: moment(originatingTicket.date).add(1, 'days').toDate(),
                hours: hours.evening,
                route: Route.getReversed(originatingTicket.route)
            };
            var returnTicket = _.find(cheapestTickets, returnOptions);

            // Only store the roundtrip if return ticket is found
            if (returnTicket) {
                roundtrip.returnTicket = returnTicket;
                roundtrip.totalCost = originatingTicket.price + returnTicket.price;
                roundtrips.push(roundtrip);
            } else {
                debug('No ticket found with options', returnOptions);
            }
        }
    });

    return roundtrips;
};

/**
 * Returns the last of available days
 * @see timespan
 * @returns {Date}
 */
var getLastAvailableDay = function() {
    return moment().add(timespan - 1, 'days').startOf('day').toDate();
};

/**
 * Determines if the mon
 * @param {Number} month Month number, starting from 0
 * @returns {Boolean}
 */
var isMonthWithinTimespan = function(month) {
    var diffInDays = moment(month + 1, 'M').diff(moment(), 'days');
    return moment().month() === month || (diffInDays <= timespan && diffInDays > 0);
};

/**
 * Stores last chat options for each chat
 * @param {Object} data
 * @param {Number} chatId
 * @returns {Promise}
 */
var saveHistory = function(data, chatId) {
    return Storage
        .remove(Storage.collectionName.history, {chatId: chatId})
        .then(function() {
            return Storage.insert(Storage.collectionName.history, {
                data: data,
                date: moment().toDate(),
                chatId: chatId
            });
        });
};

var getHistory = function(chatId) {
    return Storage
        .find(Storage.collectionName.history, {chatId: chatId})
        .then(function(entries) {
            return entries.length ? entries[0].data : {};
        });
};

var saveRoundtripsHistory = function(roundtrips, chatId) {
    return Storage
        .remove(Storage.collectionName.roundtripsHistory, {chatId: chatId})
        .then(function() {
            roundtrips = roundtrips && !_.isArray(roundtrips) ? [roundtrips] : roundtrips;
            return Storage.insert(Storage.collectionName.roundtripsHistory, {
                roundtrips: roundtrips,
                date: moment().toDate(),
                chatId: chatId
            });
        });
};

var getPreviousRoundtrip = function(chatId) {
    return Storage
        .find(Storage.collectionName.roundtripsHistory, {chatId: chatId})
        .then(function(entries) {
            var roundtrips = entries.length && entries[0].roundtrips ? entries[0].roundtrips : [];
            return roundtrips.length ? roundtrips[0] : null;
        });
};

module.exports = {
    cityAliases: cityAliases,
    hours: hours,
    timespan: timespan,
    ticketsCountThreshold: ticketsCountThreshold,
    defaultRoute: defaultRoute,
    Route: Route,
    getRequestOptions: getRequestOptions,
    getTicketsForDate: getTicketsForDate,
    formatTicket: formatTicket,
    rzdDateUrl: rzdDateUrl,
    formatRoundtrip: formatRoundtrip,
    filterTickets: filterTickets,
    getTicketDepartureDate: getTicketDepartureDate,
    getDayAfterTicket: getDayAfterTicket,
    getDayBeforeTicket: getDayBeforeTicket,
    getSummary: getSummary,
    extractDates: extractDates,
    generateIndex: generateIndex,
    getLastAvailableDay: getLastAvailableDay,
    isMonthWithinTimespan: isMonthWithinTimespan,
    saveHistory: saveHistory,
    getHistory: getHistory,
    saveRoundtripsHistory: saveRoundtripsHistory,
    getPreviousRoundtrip: getPreviousRoundtrip
};