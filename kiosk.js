var Storage = require('./storage');
var Url = require('./url');
var Collector = require('./collector');

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

const hourAliases = {
    earlyMorning: 'earlyMorning',
    morning: 'morning',
    day: 'day',
    evening: 'evening'
};

const hourNames = {
    [hourAliases.earlyMorning]: 'рано утром',
    [hourAliases.morning]: 'утром',
    [hourAliases.day]: 'днём',
    [hourAliases.evening]: 'вечером'
};

/**
 * The hours that are passed to _.inRange function (which means a value should be between the start hour and up to, but not including, the end hour)
 * @type {Object}
 */
const hours = {
    [hourAliases.earlyMorning]: [5, 7],
    [hourAliases.morning]: [7, 10],
    [hourAliases.day]: [10, 17],
    [hourAliases.evening]: [17, 20]
};

const weekdays = {
    any: 'any',
    weekend: 'weekend',
    weekday: 'weekday'
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

const collectionName = 'roundtrips';

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

Route.prototype.isToSpb = function() {
    return this.to.alias === cityAliases.spb;
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
    var hourAlias = options.hours;
    var hourRange = hours[hourAlias];

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
        if (hourRange && !_.inRange(departureMoment.get('hours'), hourRange[0], hourRange[1])) {
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
var rzdDateRouteUrl = function(roundtrip) {
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
    requestOptions.parameters.st0 = route.from.formattedName;
    requestOptions.parameters.st1 = route.to.formattedName;

    var parametersHash = toHash(requestOptions.parameters);
    var url = `${requestOptions.url}?STRUCTURE_ID=${structureId}#${parametersHash}`;

    // Using url shortener because when a link in Telegram gets clicked, the '|' characters in rzd url are url-encoded into %7C, which breaks the url.
    // There is no way to avoid the '|' character usage.
    return Url.shorten(url);
};


// TODO Move to date utility
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

var formatNestedTicket = function(ticket) {
   var datetimeMoment = moment(ticket.datetime);
   var dayFormatted = datetimeMoment.format('D MMMM, dddd').toLowerCase();
   var timeFormatted = datetimeMoment.format('H:mm');
   //Санкт-Петербург → Москва,
   //16 марта, среда, отправление в 5:30
   //1290 ₽
   return `${ticket.route.from.formattedName} → ${ticket.route.to.formattedName} \n${dayFormatted}, отправление в ${timeFormatted} \n${ticket.price} ₽`;
};

/**
* @param {Object} roundtrip
* @param {Boolean} [includeLink]
* @returns {Promise}
*/
var fullFormat = function(roundtrip, includeLink) {
   var originatingTicketText = formatNestedTicket(roundtrip.originatingTicket);
   var returnTicketText = formatNestedTicket(roundtrip.returnTicket);
   var promise;
   var text = `${originatingTicketText}\n\n${returnTicketText}\n----------\n${roundtrip.totalCost} ₽`;
   if (includeLink) {
       promise = rzdDateRouteUrl(roundtrip)
           .then(function(url) {
               return `${text}\n\n${url}`;
           });
   } else {
       promise = Promise.resolve(text);
   }
   return promise;
};

/**
* @param {Object} roundtrip
* @param {Boolean} [includeLink]
* @returns {Promise}
*/
var shortFormat = function(roundtrip, includeLink) {
   var originatingTicket = roundtrip.originatingTicket;
   var originatingMoment = moment(originatingTicket.datetime);
   var originatingWeekday = formatWeekday(originatingMoment);
   var originatingTicketDateFormatted = originatingMoment.format(`${originatingWeekday} D MMMM в H:mm`).toLowerCase();

   var returnTicket = roundtrip.returnTicket;
   var returnMoment = moment(returnTicket.datetime);
   var returnWeekday = formatWeekday(returnMoment);
   var returnTicketDateFormatted = returnMoment.format(`${returnWeekday} D MMMM в H:mm`).toLowerCase();
   var promise;

   // Санкт-Петербург → Москва и обратно за 3447 ₽
   // Туда в среду 18 мая в 7:00, обратно в четверг 19 мая в 18:00
   var routeText = `${originatingTicket.route.from.formattedName} → ${originatingTicket.route.to.formattedName} и обратно`;
   var text = `за ${roundtrip.totalCost} ₽ \nтуда ${originatingTicketDateFormatted}, обратно ${returnTicketDateFormatted}`;
   if (includeLink) {
       promise = rzdDateRouteUrl(roundtrip)
           .then(function(url) {
               var link = `<a href="${url}">${routeText}</a>`;
               return `${link} ${text}`;
           });
   } else {
       promise = Promise.resolve(`${routeText} ${text}`);
   }
   return promise;
};

/**
 * @param {Array} roundtrips
 * @param {Boolean} [includeLink]
 * @returns {String}
 */
var formatRoundtrip = function(roundtrips, includeLink) {
    var promises = [];
    roundtrips = roundtrips && !_.isArray(roundtrips) ? [roundtrips] : roundtrips;
    var isShortFormat = roundtrips.length > 1;
    _.forEach(roundtrips, function(roundtrip) {
        promises.push(isShortFormat ? shortFormat(roundtrip, includeLink) : fullFormat(roundtrip, includeLink));
    });
    return Promise.all(promises)
        .then(function(texts) {
            return texts.join("\n\n");
        });
};

var formatRoundtripTitle = function(roundtrip) {
    var originatingTicket = roundtrip.originatingTicket;
    var originatingMoment = moment(originatingTicket.datetime);
    var originatingTicketDateFormatted = originatingMoment.format(`dddd D MMMM H:mm`).toLowerCase();
    return `${originatingTicket.route.from.formattedName} ⇄ ${originatingTicket.route.to.formattedName}, ${roundtrip.totalCost} ₽, ${originatingTicketDateFormatted}`;
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
 * @param {Array} allTickets
 * @returns {Promise}
 */
var generateIndex = function(allTickets) {
    var cheapestTickets = findAllCheapestTicketsWithOptions(allTickets);
    var roundtrips = extractRoundtrips(cheapestTickets);

    // If no roundtrips found, do not overwrite existing roundtrips.
    if (!roundtrips.length) {
        throw new Error('No roundtrips found.');
    }

    return Promise.all([roundtrips, Storage.drop(collectionName)])
        .then(function(result) {
            var roundtrips = result[0];
            // Converting dates to string and routes to string alias before persisting
            return Storage.insert(collectionName, roundtrips);
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
            {date: date, route: toMoscow, hours: hourAliases.earlyMorning},
            {date: date, route: toMoscow, hours: hourAliases.morning},
            {date: date, route: toMoscow, hours: hourAliases.day},
            {date: date, route: toMoscow, hours: hourAliases.evening},

            {date: date, route: toSpb, hours: hourAliases.earlyMorning},
            {date: date, route: toSpb, hours: hourAliases.morning},
            {date: date, route: toSpb, hours: hourAliases.day},
            {date: date, route: toSpb, hours: hourAliases.evening}
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
    // Morning and early morning and day tickets are assumed to be originating (outbound).
    var originatingTickets = _.filter(cheapestTickets, function(ticket) {
        return ticket.hours === hourAliases.earlyMorning || ticket.hours === hourAliases.morning || ticket.hours === hourAliases.day;
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
                weekday: originatingTicketMoment.isoWeekday() === 6 ? weekdays.weekend : weekdays.weekday,
                // Indicates if originating departure time is early in the morning.
                originatingHours: originatingTicket.hours,
                // Storing month to simplify filtering
                month: originatingTicketMoment.month()
            };

            var returnOptions = {
                date: moment(originatingTicket.date).add(1, 'days').toDate(),
                hours: hourAliases.evening,
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

var getAll = function() {
    return Storage.find(collectionName)
        .then(function(roundtrips) {
            _.forEach(roundtrips, function(rountrip) {
                rountrip.route = new Route(rountrip.route.to.alias);
            });
            return roundtrips;
        });
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
 * Determines if the month is in timespan
 * @param {Number} month Month number, starting from 0
 * @returns {Boolean}
 */
var isMonthWithinTimespan = function(month) {
    var now = moment();
    // Current month, zero-based
    var currentMonth = now.month();
    var currentYear = now.year();
    var nextYear = currentYear + 1;
    // month + 1 because month is zero-based, but parsing requires regular-numbered months
    var diffInDays = moment(month + 1, 'M').diff(now, 'days');
    // See if timespan extends to the next year, add the number of days in current year to day difference (e.g., -362 + 366 = 4)
    if (moment(nextYear, 'YYYY').diff(moment(), 'days') < timespan) {
        diffInDays += moment(nextYear, 'YYYY').diff(moment(currentYear, 'YYYY'), 'days');
    }
    return month === currentMonth || (diffInDays <= timespan && diffInDays > 0);
};

/**
 * Returns a list of months
 * @param {Number} [excludeMonth]
 * @returns {Number[]}
 */
var getMonthsWithinTimespan = function(excludeMonth) {
    var currentMonth = moment().month();
    // Making so that range would always start from the current month
    var months = _.range(currentMonth, 12).concat(_.range(0, currentMonth));
    return _.filter(months, function(month) {
        var isExcluded = !_.isUndefined(excludeMonth) && excludeMonth === month;
        return isMonthWithinTimespan(month) && !isExcluded;
    });
};

/**
 * @param {String|String[]} [excludeHours]
 * @return {String[]} Hour names
 */
var getHourNames = function(excludeHours) {
    excludeHours = excludeHours && !_.isArray(excludeHours) ? [excludeHours] : excludeHours;
    var keys = _.difference(_.keys(hours), excludeHours);
    return _.values(_.pick(hourNames, keys)) || [];
};

var remove = function() {
    return Storage.remove(collectionName);
};

module.exports = {
    cityAliases: cityAliases,
    hourAliases: hourAliases,
    hours: hours,
    weekdays: weekdays,
    timespan: timespan,
    ticketsCountThreshold: ticketsCountThreshold,
    defaultRoute: defaultRoute,
    Route: Route,
    getRequestOptions: getRequestOptions,
    getTicketsForDate: getTicketsForDate,
    formatTicket: formatTicket,
    rzdDateRouteUrl: rzdDateRouteUrl,
    formatRoundtrip: formatRoundtrip,
    formatRoundtripTitle: formatRoundtripTitle,
    filterTickets: filterTickets,
    getTicketDepartureDate: getTicketDepartureDate,
    getDayAfterTicket: getDayAfterTicket,
    getDayBeforeTicket: getDayBeforeTicket,
    getSummary: getSummary,
    extractDates: extractDates,
    generateIndex: generateIndex,
    getAll: getAll,
    getLastAvailableDay: getLastAvailableDay,
    isMonthWithinTimespan: isMonthWithinTimespan,
    getMonthsWithinTimespan: getMonthsWithinTimespan,
    getHourNames: getHourNames,
    remove: remove
};