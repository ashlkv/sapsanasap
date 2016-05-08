var Storage = require('./storage');
var Kiosk = require('./kiosk');

var _ = require('lodash');
var moment = require('moment');
var debug = require('debug')('analyzer');

const totalCostAllowance = 500;
const moreTicketsLimit = 5;

/**
 * @param {Object} data
 * @param {Boolean} [data.filter] Request for more results (means multiple entries, approximate cost)
 * @param {Boolean} [data.more] Request for more results (means multiple entries, approximate cost)
 * @returns {Promise}
 */
var analyze = function(data) {
    var filter = data.filter;
    var more = data.more;

    filter = _.extend({
        route: Kiosk.defaultRoute
    }, filter);

    debug('Selecting the cheapest roundtrip with options', filter);

    return Storage
        .find(Storage.collectionName.roundtrips)
        .then(function(roundtrips) {
            var totalCost = filter.totalCost;
            // Remove total cost from filter, since filter only test values for equalty.
            delete filter.totalCost;

            // If early morning tickets are not explicitly asked for, exclude them.
            if (!filter.earlyMorning) {
                filter.earlyMorning = false;
            } else {
                delete filter.earlyMorning;
            }

            var filteredRoundtrips = _.filter(roundtrips, filter);
            var result;
            var message;

            // If multiple results required, oder by cost and time and return the first five
            if (more) {
                result = _.sortBy(filteredRoundtrips, ['totalCost', 'originatingTicket.datetime']);
                result = excludeMin(result);
                var offset = data.segment * moreTicketsLimit;
                result = result.slice(offset, offset + moreTicketsLimit);
                if (result.length > 1) {
                    message = `Ещё билеты, в порядке возрастания цены:`;
                } else if (result.length === 1) {
                    message = `Вот последняя пара билетов:`;
                } else {
                    message = `Всё, нет больше билетов.`;
                }
            }
            // If price limit is specified, find tickets below price limit, and return nearest ticket by date.
            else if (totalCost) {
                var cheapEnoughRoundtrips = _.filter(filteredRoundtrips, function(roundtrip) {
                    return roundtrip.totalCost <= totalCost;
                });
                // If cheap enough roundtrips are found, select nearest by date
                if (cheapEnoughRoundtrips.length) {
                    result = _.minBy(cheapEnoughRoundtrips, 'originatingTicket.datetime');
                    // If cheap enough roundtrips are not found, simply select the cheapest roundtrip
                } else {
                    message = `Я не нашёл билетов за ${totalCost} ₽ и меньше. Вот самый дешёвый:`;
                    result = _.minBy(filteredRoundtrips, 'totalCost');
                }
            // If month is set but no tickets found, remove month from filter and find the otherwise cheapest roundtrip.
            } else if (!_.isUndefined(filter.month) && !filteredRoundtrips.length) {
                var monthName = moment(filter.month + 1, 'M').format('MMMM').toLowerCase();
                delete filter.month;
                filteredRoundtrips = _.filter(roundtrips, filter);
                message = `Я не нашёл билетов на ${monthName}. Как насчёт вот этих?`;
                result = _.minBy(filteredRoundtrips, 'totalCost');
            // If no special condition is specified, simply find the cheapest roundtrip.
            } else {
                result = _.minBy(filteredRoundtrips, 'totalCost');
            }

            result = _.isArray(result) ? result : [result];
            return {roundtrips: result, message: message};
        });
};

/**
 * Finds tickets with the same price or with price that is just slightly higher.
 */
var excludeMin = function(roundtrips) {
    var excludedRoundtrip = _.minBy(roundtrips, ['totalCost', 'originatingTicket.datetime']);
    _.remove(roundtrips, {_id: excludedRoundtrip._id});
    return roundtrips;
};

module.exports = {
    analyze: analyze
};
