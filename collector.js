var Kiosk = require('./kiosk');
var Storage = require('./storage');

var assert = require('assert');
var moment = require('moment');
var q = require('q');
var _ = require('lodash');

/**
 * Timespan length in days. Rzd only allows searching for tickets within 60 days.
 * @type {number}
 */
const timespan = 60;

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

    var getTicketsForDate = function(date) {
        var deferred = q.defer();

        // Way there tickets
        Kiosk.getTicketsForDate(date, route)
            .then(function(tickets) {
                console.log('getTicketsForDate tickets.length', tickets.length);
                console.log(moment(date).format('DD.MM.YYYY'), 'tickets.length', tickets.length);
                deferred.resolve(tickets);
            })
            .fail(function() {
                deferred.reject();
            });

        return deferred.promise;
    };

    // Collect tickets for each day in timespan
    for (var i = 0; i < limit; i++) {
        var date = startDate.clone().add(i, 'days').toDate();
        promises.push(getTicketsForDate(date));
    }

    return q.all(promises).then(function(result) {
        console.log('result.length', result.length);
        return _.flatten(result);
    });
};

/**
 * Returns request portions, max maximumRequests per portion, timespan requests total
 * @returns {Array}
 */
var getPortions = function() {
    var dayPortions = [];

    for (var i = 0; i < Math.floor(timespan / maximumRequests); i++) {
        dayPortions.push(maximumRequests);
    }

    // Remainder
    if (timespan % maximumRequests) {
        dayPortions.push(timespan % maximumRequests);
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
    var deferred = q.defer();
    var allTickets = [];

    var getTicketsPortion = function(i) {
        i = i || 0;

        getTimespanTickets(portions[i], i > 0 ? maximumRequests * i : null)
            .then(function(tickets) {
                allTickets = allTickets.concat(tickets);
                i ++;
                if (i < portions.length) {
                    getTicketsPortion(i);
                } else {
                    deferred.resolve(allTickets);
                }
            })
            .fail(function() {
                deferred.reject();
            });
    };

    getTicketsPortion();

    return deferred.promise;
};

/**
 * Returns a range of timespan dates
 * @returns {Array}
 */
var getTimespanDates = function() {
    var dates = [];
    var startDate = moment().startOf('day');
    for (var i = 0; i < timespan; i++) {
        dates.push(startDate.clone().add(i, 'days').toDate());
    }
    return dates;
};

/**
 * Checks that tickets for all timespan dates were fetched
 */
var testIntegrity = function() {
    return Kiosk.getAllDates()
        .then(function(datesInStorage) {
            assert.deepEqual(datesInStorage, getTimespanDates());
        })
        .then(function() {
            console.log('Tickets for all available dates fetched.');
        })
        .catch(function(e) {
            console.log(e);
        });
};


var fetch = function() {
    var now = moment().unix();

    getAllTickets()
        .then(function(tickets) {
            if (!tickets.length) {
                throw ({error: 'Error: no tickets fetched.'});
            }
            console.log('getAllTickets tickets.length', tickets.length);
            _.each(tickets, function(ticket) {
                ticket.collectedAt = now;
                console.log('ticket summary', Kiosk.getSummary(ticket));
            });
            return tickets;
        })
        .then(function(tickets) {
            var deferred = q.defer();
            Storage.drop(Storage.collectionNames.tickets)
                .then(function() {
                    deferred.resolve(tickets);
                })
                .fail(function() {
                    deferred.reject();
                });
            return deferred.promise;
        })
        .then(function(tickets) {
            return Storage.insert(tickets, Storage.collectionNames.tickets);
        })
        .then(function() {
            console.log('Successfully collected tickets.');
        })
        .catch(function(error) {
            console.log('Error while collecting tickets.', error);
        });
};

module.exports = {
    fetch: fetch,
    testIntegrity: testIntegrity
};
