var Storage = require('./storage');
var Kiosk = require('./kiosk');
var _ = require('lodash');
var q = require('q');

/**
 * @param {Route} route
 * @param {Object} [options]
 * @returns {Promise}
 */
var getCheapest = function(route, options) {
    return Storage
        .find(Storage.collectionNames.tickets)
        .then(function(tickets) {
            var filteredTickets = Kiosk.filterTickets(tickets, _.extend({fromCity: route.from}, options));

            return _.minBy(filteredTickets, function(ticket) {
                return parseInt(ticket.cars[0].tariff);
            });
        })
};

/**
 * @param {Object} options
 * @returns {Promise}
 */
var getCheapestPair = function(options) {
    options = _.extend({
        route: Kiosk.defaultRoute
    }, options);

    return q.all([getRoutePair(options.route), getRoutePair(Kiosk.Route.getReversed(options.route), true)])
        .then(function(pairs) {
            return _.minBy(pairs, 'totalCost');
        });
};

/**
 * @param {Route} route
 * @param {Boolean} reverse
 * @returns {Promise}
 */
var getRoutePair = function(route, reverse) {
    var pair = {
        tickets: [],
        totalCost: null
    };
    var morningHours = [7, 9];
    var eveningHours = [17, 20];

    // First pair of tickets based on cheapest tickets to Moscow
    return getCheapest(route, {hourRange: reverse ? eveningHours : morningHours})
        .then(function(ticket) {
            pair.tickets.push(ticket);
            var departureDate = reverse ? Kiosk.getDayBeforeTicket(ticket) : Kiosk.getDayAfterTicket(ticket);
            return getCheapest(Kiosk.Route.getReversed(route), {
                date: departureDate,
                hourRange: reverse ? morningHours : eveningHours
            });
        })
        .then(function(ticket) {
            pair.tickets.push(ticket);
            if (reverse) {
                pair.tickets.reverse();
            }
            pair.totalCost = parseInt(pair.tickets[0].cars[0].tariff) + parseInt(pair.tickets[1].cars[0].tariff);
            return pair;
        });
};

/**
 * @param {Object} [options]
 * @returns {Promise}
 */
var analyze = function(options) {
    return getCheapestPair(options)
        .then(function(pair) {
            var responseLines = [];
            pair.tickets.forEach(function(ticket) {
                responseLines.push(Kiosk.formatTicket(ticket));
            });
            return responseLines.join("\n\n");
        });
};

module.exports = {
    analyze: analyze
};
