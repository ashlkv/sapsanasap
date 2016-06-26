var Kiosk = require('./kiosk');
var Storage = require('./storage');

var assert = require('assert');
var moment = require('moment');
var _ = require('lodash');
var debug = require('debug')('collector');

var Promise = require('bluebird');

/**
 * Maximum requests to rzd site at a time
 * @type {number}
 */
const maximumRequests = 30;

/**
 * @param {Number} limit Days limit
 * @param {Number} [offset] Days offset
 * @returns {Promise} promise containing all tickets for the timespan
 */
var getTimespanTickets = function(limit, offset) {
    var promises = [];
    var route = Kiosk.defaultRoute;

    // If start date offset is not specified, collect all tickets starting today
    var startDate = moment().add(offset || 0, 'days');

    // Collect tickets for each day in timespan
    for (var i = 0; i < limit; i++) {
        var date = startDate.clone().add(i, 'days').toDate();
        promises.push(Kiosk.getTicketsForDate(date, route));
    }

    return Promise.all(promises).then(function(result) {
        return _.flatten(result);
    });
};

/**
 * Returns request portions, max maximumRequests per portion, timespan requests total
 * @returns {Array}
 */
var getPortions = function() {
    var dayPortions = [];

    for (var i = 0; i < Math.floor(Kiosk.timespan / maximumRequests); i++) {
        dayPortions.push(maximumRequests);
    }

    // Remainder
    if (Kiosk.timespan % maximumRequests) {
        dayPortions.push(Kiosk.timespan % maximumRequests);
    }

    return dayPortions;
};

/**
 * Collects tickets for timespan days, breaking into portions of maximumRequests if necessary.
 * Waits for the previous request portion to finish / resolve, before sending a next portion of requests.
 * @returns {Promise}
 */
var getAllTickets = function() {
    var portions = getPortions();
    var allTickets = [];

    var getTicketsPortion = function(i) {
        i = i || 0;

        return getTimespanTickets(portions[i], i > 0 ? maximumRequests * i : null)
            .then(function(tickets) {
                allTickets = allTickets.concat(tickets);
                i ++;
                if (i < portions.length) {
                    return getTicketsPortion(i);
                } else {
                    return allTickets;
                }
            });
    };

    return getTicketsPortion();
};

/**
 * Returns a range of timespan dates
 * @returns {Array}
 */
var getTimespanDates = function() {
    var dates = [];
    var startDate = moment().startOf('day');
    for (var i = 0; i < Kiosk.timespan; i++) {
        dates.push(startDate.clone().add(i, 'days').toDate());
    }
    return dates;
};

/**
 * Checks that tickets for all timespan dates were fetched
 */
var testIntegrity = function() {
    return Storage
        .find(Storage.collectionName.tickets)
        .then(function(allTickets) {
            var datesInStorage = Kiosk.extractDates(allTickets);
            assert.deepEqual(datesInStorage, getTimespanDates());
        })
        .then(function() {
            debug('Fetched tickets for all available dates.');
        })
        .catch(function(error) {
            console.log(error && error.stack);
        });
};


var fetch = function() {
    var now = moment().valueOf();

    return getAllTickets()
        .then(function(tickets) {
            // If no tickets fetched, do not overwrite existing tickets
            if (!tickets.length) {
                throw new Error('No tickets fetched.');
            // If tickets fetched, but count too low, do not overwrite existing tickets
            } else if (tickets.length < Kiosk.ticketsCountThreshold) {
                throw new Error(`Tickets fetched, but count too low: ${tickets.length}`);
            }
            var id = 1;
            _.each(tickets, function(ticket) {
                ticket.collectedAt = now;
                ticket.id = id;
                id ++;
            });

            return Promise.all([tickets, Storage.drop(Storage.collectionName.tickets)]);
        })
        .then(function(result) {
            var tickets = result[0];
            debug(`Collected tickets length: ${tickets && tickets.length}`);
            return Storage.insert(Storage.collectionName.tickets, tickets);
        })
        .then(function() {
            debug('Successfully collected tickets.');
        });
};

var main = function() {
    fetch()
        .then(function() {
            return Kiosk.generateIndex();
        })
        .then(function() {
            debug('Successfully generated index.');
            debug('Collector finished.');
        })
        .catch(function(error) {
            console.log(error && error.stack);
        });
};

module.exports = {
    main: main,
    testIntegrity: testIntegrity
};
