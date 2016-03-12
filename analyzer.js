var Storage = require('./storage');
var Kiosk = require('./kiosk');
var _ = require('lodash');
var debug = require('debug')('analyzer');

/**
 * @param {Object} options
 * @returns {Promise}
 */
var selectCheapestRoundtrip = function(options) {
    options = _.extend({
        route: Kiosk.defaultRoute
    }, options);

    debug('Selecting the cheapest roundtrip with options', options);

    return Storage
        .find(Storage.collectionName.roundtrips)
        .then(function(roundtrips) {
            var filteredRoundtrips = _.filter(roundtrips, options);
            return _.minBy(filteredRoundtrips, 'totalCost');
        });
};

/**
 * @param {Object} [options]
 * @param {Route} [options.route]
 * @param {Route} [options.earlyMorning]
 * @param {Route} [options.weekend]
 * @returns {Promise}
 */
var analyze = function(options) {
    return selectCheapestRoundtrip(options)
        .catch(function(error) {
            console.log(error);
        });
};

module.exports = {
    analyze: analyze
};
