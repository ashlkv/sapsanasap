var Storage = require('./storage');

var request = require('request');
var moment = require('moment');
var q = require('q');
var _ = require('lodash');

moment.locale('ru');

const cityAliases = {
    mow: 'mow',
    spb: 'spb'
};

const cities = {
    [cityAliases.mow]: {
        alias: cityAliases.mow,
        name: 'МОСКВА',
        code: 2000000
    },
    [cityAliases.spb]: {
        alias: cityAliases.spb,
        name: 'САНКТ-ПЕТЕРБУРГ',
        code: 2004000
    }
};

const afterCredentialsDelay = 10000;

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
var toMoscow = function() {
    return new Route(cityAliases.mow);
};

/**
 * @returns {Route}
 */
var toSpb = function() {
    return new Route(cityAliases.spb);
};

const defaultRoute = toMoscow();

/**
 * Returns request url and parameters
 * @param {Object} cityFrom
 * @param {Object} cityTo
 * @param {Moment} date1
 * @param {Moment} [date2]
 * @param {String} [rid]
 * @returns {Object}
 */
var getRequestOptions = function(cityFrom, cityTo, date1, date2, rid) {
    date2 = date2 || date1.clone();

    var dateFormat = 'DD.MM.YYYY';

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
    var deferred = q.defer();

    request.get({
            method: 'GET',
            url: requestOptions.url,
            qs: requestOptions.parameters
        },
        function(error, response, body) {
            if (!error && response.statusCode == 200) {
                deferred.resolve(extractCredentials(response, body));
            } else {
                deferred.reject(error);
            }
        });

    return deferred.promise;
};

/**
 * @param {Object} response
 * @param {String} body
 * @returns {{rid: (*|String), sessionCookie}}
 */
var extractCredentials = function(response, body) {
    var sessionCookie = getSessionCookie(response);
    var json = JSON.parse(body);
    return {
        rid: json.rid,
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
    var deferred = q.defer();
    var momentDate = moment(date);
    var credentialsOptions = getRequestOptions(route.from, route.to, momentDate);
    var maxAttempts = 5;
    var attemptsCount = 0;

    var getTicketsWithCredentials = function(credentials) {
        console.log('credentials', credentials);
        setTimeout(function() {
            // Add rid query parameter
            var ticketOptions = _.clone(credentialsOptions);
            ticketOptions.parameters.rid = credentials.rid;

            // Add session cookie
            var cookie = `${credentials.sessionCookie.name}=${credentials.sessionCookie.value};`;

            request.get({
                method: 'GET',
                url: ticketOptions.url,
                qs: ticketOptions.parameters,
                // Setting cookie via jar does not work.
                headers: {
                    Cookie: cookie
                }
            // TODO Find out if it is possible to use a promise instead of callback
            }, function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    var json = JSON.parse(body);
                    var allTickets = [];
                    if (json.tp) {
                        allTickets = allTickets.concat(json.tp[0].list);
                        allTickets = allTickets.concat(json.tp[1] ? json.tp[1].list : []);
                    }
                    console.log('allTickets.length', allTickets.length);
                    attemptsCount ++;
                    // Occasionally a new rid is returned instead of tickets.
                    // If so, make another attempt to fetch tickets.
                    if (!allTickets.length && attemptsCount <= maxAttempts) {
                        console.log('unexpected response: ', json);
                        console.log('attemptsCount', attemptsCount);
                        if (attemptsCount <= maxAttempts) {

                            getCredentials(credentialsOptions)
                                    .then(getTicketsWithCredentials);
                        } else {
                            deferred.reject('Maximum attempts reached, no tickets in response.');
                        }
                    } else {
                        var relevantTickets = filterTickets(allTickets, {
                            highSpeed: true
                        });
                        if (!relevantTickets.length && allTickets.length) {
                            console.log('All tickets filtered out');
                        }
                        deferred.resolve(relevantTickets);
                    }
                } else {
                    deferred.reject(error);
                }
            });
        }, afterCredentialsDelay);
    };

    getCredentials(credentialsOptions)
        .then(getTicketsWithCredentials);

    return deferred.promise;
};

/**
 * Filters only relevant tickets
 * @param {Array} allTickets
 * @param {Object} options
 * @returns {Array}
 */
var filterTickets = function(allTickets, options) {
    var brand = options.highSpeed ? 'САПСАН' : null;
    var station0 = options.fromCity ? options.fromCity.name : null;
    var station1 = options.toCity ? options.toCity.name : null;
    var date = options.date;
    var hourRange = options.hourRange;

    return _.filter(allTickets, function(ticket) {
        var hit = true;
        var departureMoment = moment(getTicketDepartureDate(ticket));

        if (brand && ticket.brand !== brand) {
            hit = false;
        }
        if (station0 && ticket.station0 !== station0) {
            hit = false;
        }
        if (station1 && ticket.station0 !== station1) {
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

/**
 * @param {Object} json
 * @returns {String}
 */
var formatTicket = function(json) {
    // TODO Move to a separate module
    var formatCity = function(name) {
        return _.map(name.toLowerCase().split('-'), function(part) {
                return _.upperFirst(part);
            })
            .join('-');
    };

    var cityFrom = formatCity(json.station0);
    var cityTo = formatCity(json.station1);
    var date = moment(getTicketDepartureDate(json));
    var dayFormatted = date.format('D MMMM').toLowerCase();
    var timeFormatted = date.format('H:mm');

    //Санкт-Петербург → Москва,
    //16 марта, отправление в 5:30
    //1290 ₽
    return `${cityFrom} → ${cityTo} \n${dayFormatted}, отправление в ${timeFormatted} \n${json.cars[0].tariff} ₽`;
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
 * @returns {Array}
 */
var getAllDates = function() {
    return Storage
        .find(Storage.collectionNames.tickets)
        .then(function(tickets) {
            var datesInStorage = _.map(_.uniqBy(tickets, 'date0'), function(json) {
                return moment(json.date0, 'DD.MM.YYYY').toDate();
            });
            return _.sortBy(datesInStorage);
        });
};

module.exports = {
    cityAliases: cityAliases,
    Route: Route,
    toMoscow: toMoscow,
    toSpb: toSpb,
    defaultRoute: defaultRoute,
    getTicketsForDate: getTicketsForDate,
    formatTicket: formatTicket,
    filterTickets: filterTickets,
    getTicketDepartureDate: getTicketDepartureDate,
    getDayAfterTicket: getDayAfterTicket,
    getDayBeforeTicket: getDayBeforeTicket,
    getSummary: getSummary,
    getAllDates: getAllDates
};