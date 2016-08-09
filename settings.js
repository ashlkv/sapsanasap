var _ = require('lodash');

var Storage = require('./storage');

const collectionName = 'settings';

/**
 * Get settings value
 * @param {String} key
 * @returns {Promise}
 */
var getValue = function(key) {
    return Storage
        // Get previous collector launch time
        .find(collectionName)
        .then(function(result) {
            var settings = result && result.length ? result[0] : {};
            return settings[key];
        });
};

/**
 * Set settings value
 * @param {String} key
 * @param {*} value
 * @returns {Promise}
 */
var setValue = function(key, value) {
    return Storage
        // Get previous collector launch time
        .find(collectionName)
        .then(function(result) {
            var settings = result && result.length ? result[0] : {};
            if (_.isObject(key)) {
                settings = _.extend(settings, key);
            } else {
                settings[key] = value;
            }
            return Storage
                .drop(collectionName)
                .then(function() {
                    Storage.insert(collectionName, [settings]);
                });
        });
};

module.exports = {
    getValue: getValue,
    setValue: setValue
};
